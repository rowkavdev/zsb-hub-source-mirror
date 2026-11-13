/**
 * SITE
 *
 * Every request to case-clicker.com goes through here. It retries short hiccups, falls back to the
 * Cloudflare window when Cloudflare blocks the background request, and turns whatever went wrong
 * into an error code on the account — so the clicker and plugins only ever look at `r.kind`.
 *
 * The transport is injected (Electron's net + the Cloudflare window in the app, a fake site in tests):
 *   request({ method, path, token, body, timeoutMs, route, headers }) -> { status, json, body, error, retryAfter? }
 *   viaWindow({ method, path, token, body, route, headers })          -> same, or { status: 0, notReady: true }
 * headers: X-CC-Client on every request (the site's rules for scripts). retryAfter: the Retry-After of a 429 or 503.
 *   challenge(route)                                          -> show that route's Cloudflare window for the user (debounced)
 * route: 'direct' (this PC's connection) or a proxy route a plugin added. Cloudflare checks and proxy failures belong
 * to the route (errors on 'route:<id>', or app-wide for direct), not to the account.
 */

// Cloudflare challenges come back as 403, 429 or 503 — told apart from the site's own answers by the body.
const CF_BODY = /just a moment|__cf_chl|challenges\.cloudflare|cf-mitigated|cf_chl_opt/i;
const isCF = (r) => (r.status === 403 || r.status === 429 || r.status === 503) && CF_BODY.test(r.body || '');
// The site's own maintenance page ("Case Clicker Online is currently under maintenance", seen 2026-11-06: ~30 min of 503s).
const MAINT_BODY = /under maintenance/i;

// A proxy that's down or unreachable (Chromium's net errors), and one that refused its username/password.
const PROXY_ERR = /ERR_PROXY|ERR_TUNNEL|ERR_SOCKS|ERR_PROXY_AUTH|ERR_MANDATORY_PROXY/i;

function kindOf(r) {
    if (r.status >= 200 && r.status < 300) return 'ok';
    if (r.status === 407 || /ERR_PROXY_AUTH/i.test(r.error || '')) return 'proxyauth';
    if (r.status === 0 && PROXY_ERR.test(r.error || '')) return 'proxy';
    if (isCF(r)) return 'cf';
    if (r.status >= 500 && MAINT_BODY.test(r.body || '')) return 'maintenance';
    if (r.status === 401) return 'auth';
    if (r.status === 429) return 'rate';
    if (r.status >= 500) return 'site';
    if (r.status === 0) return r.error === 'timeout' ? 'timeout' : 'net';
    return 'api';
}

// The error code each failure becomes (cf and auth are handled separately).
const CODE_OF = { rate: 'CC-RATE-02', site: 'CC-SITE-01', net: 'CC-NET-01', timeout: 'CC-NET-02', api: 'CC-API-01' };
const RETRY = new Set(['rate', 'site', 'net', 'timeout']);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const { clientId, HEADER } = require('./client');
const RA_PAD_MS = 250, RA_WAIT_MAX_MS = 60000;   // a little past the site's Retry-After; longer than a minute isn't waited out in one request
// Where a route's problems are kept: app-wide (null) for this PC's connection, 'route:<id>' for a proxy.
const routeKey = (route) => (!route || route === 'direct' ? null : 'route:' + route);
const PROXY_CODE = { proxy: 'CC-PROXY-01', proxyauth: 'CC-PROXY-02' };

class Site {
    constructor({ transport, errors, log, retryDelayMs = 2000, client = () => clientId() }) {
        this.t = transport;
        this.errors = errors;
        this.log = log;
        this.retryDelayMs = retryDelayMs;
        this.clientId = client;   // the X-CC-Client value (src/core/client.js): every request names the hub
    }

    headers() { return { [HEADER]: this.clientId() }; }

    // How long before another try: what the site asked (Retry-After on a 429 or a busy 503), else a wait that grows
    // with each refusal. null = the site asked for longer than is worth waiting inside one request.
    retryWait(r, i) {
        if (Number.isFinite(r.retryAfter) && r.retryAfter >= 0) {
            const ms = r.retryAfter * 1000 + RA_PAD_MS;
            return ms > RA_WAIT_MAX_MS ? null : Math.max(ms, this.retryDelayMs);
        }
        const base = this.retryDelayMs * 2 ** i;
        return base + Math.floor(Math.random() * base * 1.25);
    }

    // acct: { id, token }. opts: { method, body, tries, okStatus: [400, ...] (answers that aren't problems),
    //   retryOn: the kinds worth another try (default: rate, site, net, timeout),
//   caller: the plugin sending it — a 4xx the site gives a plugin (a refused bet, a limit, not enough money) is that
//   plugin's answer to handle, not a sign the app is out of date, so it is only logged, not put on the account }
    async request(acct, path, { method = 'GET', body = null, tries = 1, okStatus = [], timeoutMs = 45000, retryOn = RETRY, route = 'direct', caller = null } = {}) {
        const again = retryOn instanceof Set ? retryOn : new Set(retryOn);
        const rk = routeKey(route);
        const name = rk ? (this.routeLabel ? this.routeLabel(route) : route) : '';   // the proxy's name in log lines
        let r, kind, attempts = 0;
        for (let i = 0; i < tries; i++) {
            attempts++;
            r = await this.t.request({ method, path, token: acct.token, body, timeoutMs, route, headers: this.headers() });
            kind = okStatus.includes(r.status) ? 'ok' : kindOf(r);
            if (!again.has(kind) || i === tries - 1) break;
            const wait = this.retryWait(r, i);
            if (wait == null) break;   // the caller handles a long wait (r.retryAfter goes along)
            await sleep(wait);
        }

        if (kind === 'cf') {
            // The window already passed Cloudflare and has the matching browser fingerprint: send it from there.
            const w = await this.t.viaWindow({ method, path, token: acct.token, body, route, headers: this.headers() });
            if (w.status && !isCF(w)) { r = w; kind = okStatus.includes(r.status) ? 'ok' : kindOf(r); }
            else {
                // One IP, one check: it's the route's problem (app-wide for this PC's connection), not this account's.
                if (!this.errors.has(rk, 'CC-CF-01')) this.log.add(null, 'Cloudflare is asking for a check' + (rk ? ` on ${name}` : '') + ' — open it and tick the box', 'warn');
                this.errors.raise(rk, 'CC-CF-01', rk ? name : undefined);
                this.t.challenge(route);
                return { ...r, kind };
            }
        }

        if (PROXY_CODE[kind]) {
            // The proxy, not the site or the account: its accounts wait (the engine checks it again now and then).
            if (!this.errors.has(rk, PROXY_CODE[kind])) this.log.add(null, `${name} ${kind === 'proxyauth' ? 'refused its username or password' : 'isn\'t answering'} — its accounts wait`, 'warn');
            this.errors.raise(rk, PROXY_CODE[kind], `${name}: ${r.error || 'HTTP ' + r.status}`);
            return { ...r, kind };
        }

        if (kind === 'maintenance') {
            // The whole site is down for maintenance: an app-wide notice (clicks and plugins wait), not each account's problem.
            if (!this.errors.has(null, 'CC-SITE-02')) this.log.add(null, 'case-clicker.com is under maintenance — clicking and plugins wait until it\'s back', 'warn');
            this.errors.raise(null, 'CC-SITE-02', `HTTP ${r.status} on ${method} ${path.split('?')[0]}`);
            return { ...r, kind };
        }

        if (kind === 'ok') {
            this.errors.clearGroup(acct.id, 'net');
            if (rk) for (const c of ['CC-PROXY-01', 'CC-PROXY-02']) if (this.errors.has(rk, c)) { this.errors.clear(rk, c); this.log.add(null, `${name} is working again`, 'ok'); }
            if (this.errors.has(null, 'CC-SITE-02')) { this.errors.clear(null, 'CC-SITE-02'); this.log.add(null, 'case-clicker.com is back from maintenance', 'ok'); }
            if (this.errors.has(rk, 'CC-CF-01')) { this.errors.clear(rk, 'CC-CF-01'); this.log.add(null, 'Cloudflare check passed' + (rk ? ` on ${name}` : ''), 'ok'); }
        } else if (kind === 'api' && caller) {
            const k = acct.id + ' ' + r.status + ' ' + path.split('?')[0], now = Date.now();
            this.apiNoted = this.apiNoted || new Map();
            if (now - (this.apiNoted.get(k) || 0) > 10 * 60000) { this.apiNoted.set(k, now); this.log.add(acct.id, `[${caller}] the site answered HTTP ${r.status} on ${method} ${path.split('?')[0]}${r.json && r.json.message ? ': ' + String(r.json.message).slice(0, 120) : ''}`, 'info'); }
        } else if (CODE_OF[kind]) {
            this.errors.raise(acct.id, CODE_OF[kind], `HTTP ${r.status || '-'}${r.error ? ' ' + r.error : ''} on ${method} ${path.split('?')[0]}`);
        }
        return { ...r, kind, attempts };
    }
}

module.exports = { Site, isCF, kindOf, routeKey };
