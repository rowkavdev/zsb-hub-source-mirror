/**
 * ENGINE — the clicker
 *
 * One 500 ms tick drives every running account on its own timers:
 *   click   every clickIntervalMs (500 clicks; /api/click for money, /api/caseClick for cases)
 *   vault   when it's half full: capacity ÷ $/min ÷ 2 (from /api/me), fallback until the first report
 *   report  every reportMs: /api/me for the panel's numbers and the vault timing
 *
 * An account set to Off (type 'off') runs without clicking or collecting its vault: it stays signed in and reports, and
 * plugins can use it, but no batch or vault collect goes out and it doesn't take one of its exit IP's clicking places (maxPerIp).
 *
 * A 401 first tries a silent re-login (the login window's saved session); only if that fails is
 * the account stopped as logged out (CC-AUTH-01). It resumes by itself once the user logs in again.
 *
 * Events (plugins listen through the plugin host):
 *   'change'                      something the panel shows changed
 *   'started' / 'stopped'  (id)
 *   'click'   (id, clicks)        a batch landed
 *   'report'  (id, me)            fresh /api/me
 *   'loggedOut' (id)
 */

const EventEmitter = require('events');
const { routeKey } = require('./site');

// $ per clicked case before an account has measured its own. Measured 2026-11-02 on 87 hub accounts, all
// with a $25 max case price: median $6.60 per case, every account between $6.32 and $6.86 = 26.4% of the
// max price. Scaling by max price for other caps is an assumption until accounts at other caps measure.
const CASE_VALUE_SHARE = 0.264;
const DEFAULT_CASE_VALUE = 6.60;
const CASE_SAMPLES_KEPT = 15, CASE_SAMPLES_NEEDED = 5;

// Cases per click from the case click %. The site gives a case every whole number of clicks, rounded
// up: 30% is one in 4 (25%), 99% one in 2, only 100% every click.
const casesPerClick = (pct) => (pct > 0 ? 1 / Math.ceil(100 / Math.min(pct, 100) - 1e-9) : 0);

const BEHIND_WINDOW = 20;           // falling behind = 3+ of the last 20 due batches missed
const BEHIND_CHECK_MS = 30 * 1000;   // how often the falling-behind check runs
const MAINT_PROBE_MS = 30 * 1000;    // during site maintenance: how often one account checks whether it is back
const ROUTE_PROBE_MS = 60 * 1000;    // a proxy that's down: how often one of its accounts checks whether it works again
// Safety margin on top of the click interval. The site times its cooldown by when a batch ARRIVES, so a
// batch sent exactly one interval after the last one is refused whenever this trip is quicker than the
// last one was. Each refusal adds MARGIN_STEP for that account; every MARGIN_EASE_AFTER clean batches it
// eases back by MARGIN_EASE. Kept per account (acct.clickMarginMs) across restarts.
const RA_PAD_MS = 500, RA_MIN_MS = 1000;   // after a refusal with Retry-After: a little past it, never a tight loop
const MARGIN_START = 400, MARGIN_STEP = 500, MARGIN_MAX = 5000, MARGIN_MIN = 150, MARGIN_EASE = 50, MARGIN_EASE_AFTER = 30;
// Above MARGIN_HIGH it eases faster (MARGIN_EASE_HIGH every MARGIN_EASE_HIGH_AFTER): margins that high came from IP-wide
// refusals before 1.1.2 counted those apart, and a margin that high costs every batch ~8% of its time.
const MARGIN_HIGH = 1400, MARGIN_EASE_HIGH = 250, MARGIN_EASE_HIGH_AFTER = 10;
// Refusals on one exit IP this close together are the IP's limit, not one account's cooldown.
const IP_BURST_MS = 10000;
// A due batch isn't sent within BUNCH_MS of another account's on the same IP (slots are seconds apart; only a stall
// of the app, e.g. while starting many accounts, puts two that close).
const BUNCH_MS = 150;

class Engine extends EventEmitter {
    // auth.refresh(account) -> new token or null (silent re-login)
    constructor({ store, site, errors, log, auth }) {
        super();
        this.store = store; this.site = site; this.errors = errors; this.log = log; this.auth = auth;
        this.run = new Map();     // id -> runtime state
        this.lastMe = new Map();  // id -> last /api/me numbers, kept after a stop so the card still shows them
        this.timer = null;
    }

    get settings() { return this.store.settings; }

    running() { return [...this.run.keys()]; }
    isRunning(id) { return this.run.has(id); }
    // The account's last numbers from /api/me (while clicking, or the last ones seen), or null.
    meOf(id) { return (this.run.get(id) || {}).me || this.lastMe.get(id) || null; }

    // Plugins only act on accounts that are clicking normally (not logged out, not behind a check).
    isHealthy(id) {
        const r = this.run.get(id);
        return !!r && !r.refreshing && !r.held && !this.errors.has(routeKey(r.route), 'CC-CF-01') && !this.errors.has(null, 'CC-SITE-02') && !this.routeDown(r.route);
    }

    // A busy test (Troubleshoot) holds one account: no clicks, vault or reports from the hub, and plugins can't use it
    // (isHealthy is false). release() picks up with a batch straight away; the pause doesn't count as falling behind.
    hold(id, info) {
        const r = this.run.get(id);
        if (!r || r.held) return false;
        clearTimeout(r.clickTimer); r.clickTimer = null;
        r.held = { ...info };
        this.emit('change');
        return r.held;
    }
    release(id, held) {
        const r = this.run.get(id);
        if (!r || !r.held || (held && r.held !== held)) return;
        const t = Date.now();
        r.held = null;
        r.firstDueAt = t + this.period(r); r.okTimes = [];
        r.lastClick = Math.min(r.lastClick, t - this.period(r));
        this.emit('change');
    }

    // ---- network routes ----
    // 'direct' is this PC's own connection; a plugin (Proxy manager) can add proxy routes:
    // [{ id, label, proxy: { scheme, host, port, user, pass }, ip }]. The site allows maxPerIp clickers per exit IP, so
    // routes that share an exit IP share that cap. An account keeps its route (its login was made through it) unless
    // it's pinned elsewhere, the route is gone, or the route has no room left when it starts.
    setRoutes(list) {
        this.routes = new Map((list || []).filter(x => x && x.id && x.id !== 'direct').map(x => [x.id, { id: x.id, label: x.label || x.id, ip: x.ip || null }]));
        if (this.site.t && this.site.t.setRoutes) this.site.t.setRoutes(list || []);
        this.site.routeLabel = (id) => (this.routes.get(id) || {}).label || id;
        // Accounts clicking through a route that's gone move to another one (or wait with CC-RATE-01 when all are full).
        // (All stopped first: a stop clears every 'no room' error, which would hide the ones the restarts raise.)
        // Also accounts pinned to a route that's here now (the app may have started them before the plugin added it).
        const waiting = new Set(this.store.accounts.filter(a => !this.run.has(a.id) && this.errors.has(a.id, 'CC-RATE-01')).map(a => a.id));
        const moving = [...this.run.values()].filter(r => (r.route !== 'direct' && !this.routes.has(r.route)) || this.pinnedElsewhere(r)).map(r => r.id);
        for (const id of moving) { this.log.add(id, this.pinnedElsewhere(this.run.get(id)) ? 'Moving it to the proxy it is pinned to' : 'Its proxy was removed — moving it', this.pinnedElsewhere(this.run.get(id)) ? 'info' : 'warn'); this.stop(id, { keepResume: true, quiet: true }); }
        for (const id of moving) this.start(id);
        // Accounts that started elsewhere because their proxy wasn't here yet (at launch the app resumes accounts before
        // the Proxy manager's tunnels are up) go back to it, while it has room.
        for (const r of [...this.run.values()]) {
            const a = this.store.get(r.id);
            if (!a || !a.awayFrom || a.routePin || r.route === a.awayFrom || !this.routes.has(a.awayFrom) || this.routeDown(a.awayFrom) || !this.hasRoom(a.awayFrom, r.id)) continue;
            this.log.add(r.id, 'Its proxy is up — moving it back', 'info');
            this.stop(r.id, { keepResume: true, quiet: true }); this.start(r.id);
        }
        // Accounts waiting for room (CC-RATE-01) start now that there may be some. (Read before the moves above: any
        // stop clears that error for everyone.)
        for (const a of this.store.accounts) if (a.token && !this.run.has(a.id) && (waiting.has(a.id) || this.errors.has(a.id, 'CC-RATE-01'))) this.start(a.id);
        this.emit('change');
    }
    hasRoute(id) { return id === 'direct' || !!(this.routes && this.routes.has(id)); }
    pinnedElsewhere(r) { const a = this.store.get(r.id); return !!(a && a.routePin && a.routePin !== r.route && this.hasRoute(a.routePin)); }
    routeDown(id) { const k = routeKey(id); return !!k && (this.errors.has(k, 'CC-PROXY-01') || this.errors.has(k, 'CC-PROXY-02')); }
    // Routes with the same exit IP count as one for the per-IP cap.
    groupOf(id) { const x = id !== 'direct' && this.routes && this.routes.get(id); return x && x.ip ? 'ip:' + x.ip : 'route:' + id; }
    usedIn(group, except) { let n = 0; for (const r of this.run.values()) if (r.id !== except && this.groupOf(r.route) === group && !this.noClicks(r.id)) n++; return n; }
    // Off: runs without clicking (see the top).
    noClicks(id) { const a = this.store.get(id); return !!a && a.type === 'off'; }
    // Room to click on the account's exit IP (for turning Off back to a click type while it runs).
    canClick(id) { const r = this.run.get(id); return !r || this.hasRoom(r.route, id); }
    // How many accounts can click at once: the per-IP limit for each working exit IP (this PC's and each proxy's;
    // proxies that share an exit IP share its 20).
    capacity() {
        const groups = new Set(['direct', ...(this.routes ? this.routes.keys() : [])].filter(id => !this.routeDown(id)).map(id => this.groupOf(id)));
        return Math.max(1, groups.size) * this.settings.maxPerIp;
    }
    hasRoom(id, except) { return this.usedIn(this.groupOf(id), except) < this.settings.maxPerIp; }
    // The least used working route with room (this PC's connection first on a tie); null when every one is full.
    pickRoute(except) {
        const ids = ['direct', ...(this.routes ? this.routes.keys() : [])].filter(id => !this.routeDown(id) && this.hasRoom(id, except));
        ids.sort((a, b) => this.usedIn(this.groupOf(a), except) - this.usedIn(this.groupOf(b), except));
        return ids[0] || null;
    }
    // Where an account goes: its pin, else the route it has (if it still exists), else a new pick.
    routeFor(acct) {
        if (acct.routePin && this.hasRoute(acct.routePin)) return acct.routePin;
        if (acct.awayFrom && this.hasRoute(acct.awayFrom) && !this.routeDown(acct.awayFrom) && this.hasRoom(acct.awayFrom, acct.id)) return acct.awayFrom;
        if (acct.route && this.hasRoute(acct.route)) return acct.route;
        return this.pickRoute(acct.id) || 'direct';
    }
    // The exit IP a route shows the site (Cloudflare's trace on the site's own domain), and how long it took.
    async probeRoute(id) {
        const t0 = Date.now();
        const r = await this.site.t.request({ path: '/cdn-cgi/trace', route: id, timeoutMs: 15000, headers: this.site.headers() });
        const ip = r.status === 200 && /(?:^|\n)ip=([^\n]+)/.exec(r.body || '');
        return ip ? { ok: true, ip: ip[1].trim(), ms: Date.now() - t0 } : { ok: false, error: r.error || 'HTTP ' + r.status };
    }

    start(id) {
        const acct = this.store.get(id);
        if (!acct) return { ok: false, error: 'No such account' };
        // Another entry is the same site account: both would click it and get each other's batches refused.
        if (this.errors.has(id, 'CC-AUTH-08')) return { ok: false, code: 'CC-AUTH-08', error: 'Same site account as another entry' };
        if (this.run.has(id)) return { ok: true };
        // No main account set yet: nothing clicks until it is (it's sent with every request). The account is marked to
        // start as soon as it's set.
        if (!this.settings.main || !this.settings.main.userId) {
            if (!acct.wasRunning) { acct.wasRunning = true; this.store.saveAccounts(); }
            if (!this.errors.has(null, 'CC-MAIN-01')) this.log.add(null, 'Set your main account (Settings) to start clicking', 'warn');
            this.errors.raise(null, 'CC-MAIN-01');
            return { ok: false, code: 'CC-MAIN-01', error: 'Set your main account first' };
        }
        if (!acct.token) { this.errors.raise(id, 'CC-AUTH-01'); return { ok: false, code: 'CC-AUTH-01' }; }
        let route = this.routeFor(acct);
        const off = acct.type === 'off';   // no clicks: takes no clicking place on the IP
        if (!off && !this.hasRoom(route, id) && !(acct.routePin && acct.routePin === route)) route = this.pickRoute(id) || route;
        if (!off && !this.hasRoom(route, id)) {
            const n = this.usedIn(this.groupOf(route), id);
            this.errors.raise(id, 'CC-RATE-01', `${n}/${this.settings.maxPerIp} already running${route === 'direct' ? '' : ' on proxy ' + route}`);
            return { ok: false, code: 'CC-RATE-01' };
        }
        this.errors.clear(id, 'CC-RATE-01');
        if (acct.route !== route) {
            if (acct.route) this.log.add(id, `Moved to ${route === 'direct' ? 'this PC\'s connection' : 'proxy ' + route}`, 'info');
            // Its proxy isn't here (yet): remember it, to go back when it is (see setRoutes).
            if (acct.route && acct.route !== 'direct' && !this.hasRoute(acct.route) && !acct.awayFrom) acct.awayFrom = acct.route;
            acct.route = route;
        }
        if (acct.awayFrom && route === acct.awayFrom) delete acct.awayFrom;
        const s = this.settings, now = Date.now();
        // Respect the click cooldown from the last run — counted from the last batch SENT, even one that never
        // got an answer before the app closed (the site may have counted it). A time in the future (clock changed)
        // counts as now.
        const last = Math.min(now, Math.max(acct.lastClickAt || 0, acct.lastClickSentAt || 0));
        const waiting = now - last < s.clickIntervalMs;
        const margin = Math.min(MARGIN_MAX, Math.max(MARGIN_MIN, acct.clickMarginMs ?? MARGIN_START));
        // The first batch goes into the quietest moment of the minute among the accounts on the same exit IP (a batch
        // goes out at lastClick + interval + margin, so the slot is turned back into a lastClick that way).
        const lastClick = this.freeSlot(route, waiting ? last + s.clickIntervalMs + margin : now, id) - s.clickIntervalMs - margin;
        this.run.set(id, {
            id, startedAt: now, clicks: 0, lastClickOkAt: 0, firstDueAt: lastClick + s.clickIntervalMs, failedBatches: 0, vaults: 0, rateLimited: 0,
            margin, clean: 0,
            lastClick, lastVault: now - Math.floor(Math.random() * s.vaultFallbackMs), lastReport: now - s.reportMs + 2500 + Math.floor(Math.random() * Math.min(5000, s.reportMs / 48)),   // spread Start all's first reports
            vaultEveryMs: null, me: null, busy: {}, refreshing: false, route,
        });
        acct.wasRunning = true; this.store.saveAccounts();
        this.log.add(id, off ? 'Started without clicking or vault (Off): for plugins only' : 'Started clicking (' + (acct.type === 'auto' ? 'auto' : acct.type) + ')'
            + (waiting ? ` — last batch was ${Math.round((now - last) / 1000)} s ago, next in ${Math.ceil((last + s.clickIntervalMs - now) / 1000)} s` : ''), 'ok');
        if (!this.timer) this.timer = setInterval(() => this.tick(), 500);
        this.emit('started', id); this.emit('change');
        return { ok: true };
    }

    // keepResume: leave wasRunning set (app closing, logged out) so it starts again later.
    stop(id, { keepResume = false, quiet = false } = {}) {
        const run = this.run.get(id);
        if (!run) return { ok: false, error: 'Not running' };
        if (run.me) this.lastMe.set(id, run.me);
        clearTimeout(run.clickTimer);
        this.errors.clear(id, 'CC-SLOW-01');
        this.run.delete(id);
        const acct = this.store.get(id);
        if (acct && !keepResume) { acct.wasRunning = false; this.store.saveAccounts(); }
        // A slot just freed up: "too many on this IP" is no longer true for anyone.
        for (const a of this.store.accounts) this.errors.clear(a.id, 'CC-RATE-01');
        if (!quiet) this.log.add(id, 'Stopped');
        if (!this.run.size && this.timer) { clearInterval(this.timer); this.timer = null; }
        this.emit('stopped', id); this.emit('change');
        return { ok: true };
    }

    startAll() {
        const out = {};
        for (const a of this.store.accounts) if (!this.run.has(a.id) && a.token) out[a.id] = this.start(a.id);
        return out;
    }

    stopAll(opts) { for (const id of this.running()) this.stop(id, opts); }

    resume() {
        if (!this.settings.resumeOnLaunch) return;
        for (const a of this.store.accounts) if (a.wasRunning && a.token) this.start(a.id);
    }

    // Batches due in the recent window (the last 20 intervals, each given one interval to land) against the ones that did.
    behind(r, now = Date.now()) {
        const per = this.period(r), span = BEHIND_WINDOW * per;
        const from = Math.max(r.firstDueAt, now - span), until = now - per;
        const ok = r.okTimes || [];
        while (ok.length && ok[0] < now - span - per) ok.shift();
        const due = until >= from ? Math.floor((until - from) / per) + 1 : 0;
        return { due, missed: Math.max(0, due - ok.filter(x => x >= from).length) };
    }

    // CC-SLOW-01 while an account misses 3+ of its recent batches; gone once it's down to 1. Not during a Cloudflare
    // check on its route (that's CC-CF-01's notice; the window starts again once it passes).
    checkBehind() {
        for (const r of this.run.values()) {
            if (r.refreshing || r.held || this.errors.has(routeKey(r.route), 'CC-CF-01')) continue;
            if (this.noClicks(r.id)) { if (this.errors.has(r.id, 'CC-SLOW-01')) this.errors.clear(r.id, 'CC-SLOW-01'); continue; }
            const { due, missed } = this.behind(r);
            const on = this.errors.has(r.id, 'CC-SLOW-01');
            if (missed >= 3) {
                if (!on) this.log.add(r.id, `Falling behind: ${missed} of the last ${due} batches didn't land`, 'warn');
                this.errors.raise(r.id, 'CC-SLOW-01', `${missed} of the last ${due} batches missed`);
            } else if (on && missed <= 1) { this.errors.clear(r.id, 'CC-SLOW-01'); this.log.add(r.id, 'Caught up', 'ok'); }
        }
    }

    tick() {
        const t = Date.now(), s = this.settings;
        // Site under maintenance: no clicks or vault (they'd only be refused and count as missed batches); one
        // account asks /api/me every MAINT_PROBE_MS, and the first good answer ends it. The missed-batch window then
        // starts again, so the downtime doesn't read as falling behind.
        if (this.errors.has(null, 'CC-SITE-02')) {
            this.maint = true;
            const r = [...this.run.values()].find(x => !x.refreshing);
            if (r && t - (this.maintProbeAt || 0) >= MAINT_PROBE_MS) { this.maintProbeAt = t; this.once_(r, 'report', () => this.report(r)); }
            return;
        }
        if (this.maint) {
            this.maint = false;
            for (const r of this.run.values()) { r.firstDueAt = t + this.period(r); r.okTimes = []; r.lastClick = Math.min(r.lastClick, t - this.period(r)); }
        }
        if (t - (this.behindAt || 0) >= BEHIND_CHECK_MS) { this.behindAt = t; this.checkBehind(); }
        const probed = new Set();
        for (const r of this.run.values()) {
            if (r.refreshing || r.held) continue;
            if (this.routeDown(r.route)) {
                this.routeProbeAt = this.routeProbeAt || {};
                if (!probed.has(r.route) && t - (this.routeProbeAt[r.route] || 0) >= ROUTE_PROBE_MS) { this.routeProbeAt[r.route] = t; this.once_(r, 'report', () => this.report(r)); }
                probed.add(r.route);
                r.firstDueAt = t + this.period(r); r.okTimes = [];   // the wait isn't "falling behind"
                continue;
            }
            // A Cloudflare check on its route: batches keep going out (the first one through clears it), but the ones
            // the check stops aren't "falling behind" — that read as CC-SLOW-01 and pointed at a busy test.
            if (this.errors.has(routeKey(r.route), 'CC-CF-01')) { r.firstDueAt = t + this.period(r); r.okTimes = []; }
            // Off: no batches and no vault (the time off isn't "falling behind" once it clicks again); reports go on.
            const off = this.noClicks(r.id);
            if (off) { r.firstDueAt = t + this.period(r); r.okTimes = []; if (r.clickTimer) { clearTimeout(r.clickTimer); r.clickTimer = null; } }
            // A batch due before the next tick gets its own timer: firing on the 500 ms tick lost ~0.25 s per
            // batch, one whole batch every ~4 hours. The gap between sends is still never under the interval.
            const clickIn = r.lastClick + this.period(r) - t;
            if (off) { /* no clicks */ }
            else if (clickIn <= 0) this.sendDue(r);
            else if (clickIn < 500 && !r.clickTimer) r.clickTimer = setTimeout(() => { r.clickTimer = null; if (this.run.get(r.id) === r && !r.refreshing && !r.held && !this.routeDown(r.route) && !this.maint && !this.noClicks(r.id)) this.sendDue(r); }, clickIn);
            if (!off && t - r.lastVault >= (r.vaultEveryMs || s.vaultFallbackMs)) { r.lastVault = t;  this.once_(r, 'vault', () => this.vault(r)); }
            if (t - r.lastReport >= s.reportMs)                           { r.lastReport = t; this.once_(r, 'report', () => this.report(r)); }
        }
    }

    // A due batch. If another account on the same IP has just sent (the app was busy, e.g. starting many accounts),
    // sending now would bunch them for good (each send sets the next), so it goes to a quieter moment instead.
    sendDue(r) {
        const t = Date.now(), last = (this.groupSentAt && this.groupSentAt.get(this.groupOf(r.route))) || 0;
        if (t - last < BUNCH_MS) { r.lastClick = this.freeSlot(r.route, t + BUNCH_MS, r.id) - this.period(r); return; }
        this.sendClick(r);
    }

    sendClick(r) {
        r.lastClick = Date.now();
        (this.groupSentAt || (this.groupSentAt = new Map())).set(this.groupOf(r.route), r.lastClick);
        this.once_(r, 'click', () => this.click(r));
    }

    // A send time from `earliest` to one interval later, as far as it can be from the next batches of the other accounts
    // on the same exit IP. The site also limits each IP's bursts (2026-11-09: 7 accounts on one IP refused within 6 s,
    // while each one's own cooldown was fine), so the accounts on one IP take turns across the minute instead of bunching.
    freeSlot(route, earliest, except) {
        const P = this.settings.clickIntervalMs, g = this.groupOf(route), ph = [];
        for (const x of this.run.values()) if (x.id !== except && this.groupOf(x.route) === g) ph.push((((x.lastClick + this.period(x)) % P) + P) % P);
        if (!ph.length) return earliest;
        ph.sort((a, b) => a - b);
        let gap = -1, mid = 0;
        for (let i = 0; i < ph.length; i++) {
            const a = ph[i], b = i + 1 < ph.length ? ph[i + 1] : ph[0] + P;
            if (b - a > gap) { gap = b - a; mid = (a + gap / 2) % P; }
        }
        const e = ((earliest % P) + P) % P;
        return earliest + Math.round((mid - e + P) % P);
    }

    // Time between batches for this run: the interval plus its safety margin.
    period(r) { return this.settings.clickIntervalMs + (r.margin ?? MARGIN_START); }

    // A hung request (up to 45 s × retries) must not stack a second copy of the same action.
    once_(r, what, fn) {
        if (r.busy[what]) return;
        r.busy[what] = true;
        Promise.resolve().then(fn).catch(e => this.log.add(r.id, what + ' failed: ' + e.message, 'error')).finally(() => { r.busy[what] = false; });
    }

    async call(r, path, opts) {
        const acct = this.store.get(r.id);
        if (!acct || !this.run.has(r.id)) return { kind: 'gone' };
        const res = await this.site.request(acct, path, { ...opts, route: this.run.get(r.id) ? this.run.get(r.id).route : 'direct' });
        if (res.kind === 'auth') await this.loggedOut(r, acct);
        return res;
    }

    async click(r) {
        const acct = this.store.get(r.id);
        if (!acct) return;
        const n = this.settings.clicksPerBatch;
        const type = this.clickType(acct);
        if (type !== 'cases') r.caseOnly = false;   // this stretch isn't clean for measuring case value
        // Saved right away, not batched: if the app is killed mid-request, the next start still waits out the cooldown.
        acct.lastClickSentAt = Date.now();
        try { this.store.saveAccounts(); } catch (_) {}
        // A refused batch ("too fast") isn't retried: another try within seconds is refused too (the
        // refusal seems to restart the site's cooldown). Network hiccups are still retried.
        const res = await this.call(r, type === 'cases' ? '/api/caseClick' : '/api/click', { method: 'POST', body: { clicks: n }, tries: 4, retryOn: ['site', 'net', 'timeout'] });
        if (res.kind === 'rate') {
            r.rateLimited++; r.clean = 0;
            const now = Date.now(), g = this.groupOf(r.route);
            // Another account on the same exit IP refused moments ago: it's the IP's limit, not this account's cooldown,
            // so a bigger margin wouldn't help (it only slows every batch down). Just move it to a quieter moment.
            this.ipRefused = this.ipRefused || new Map();
            const ipBurst = now - (this.ipRefused.get(g) || 0) < IP_BURST_MS;
            this.ipRefused.set(g, now);
            // Kept for an hour for Troubleshoot > Clicks: when, and whether it was the IP's limit.
            (r.refusals || (r.refusals = [])).push({ t: now, ip: ipBurst });
            while (r.refusals.length && r.refusals[0].t < now - 3600000) r.refusals.shift();
            if (!ipBurst) this.emit('refused', r.id);
            const was = r.margin;
            if (!ipBurst) r.margin = acct.clickMarginMs = Math.min(MARGIN_MAX, r.margin + MARGIN_STEP);
            // A full interval (plus margin) after the refused try, at the quietest moment of the minute on this IP —
            // not "now + a minute", which kept the accounts refused together bunched together.
            // The site says when the next batch is allowed (Retry-After, seconds; documented for /api/click since 2026-11):
            // the next try goes then — sooner when the wait is short, later when something else used the account's
            // budget, instead of a refused try every minute. Without it, a full interval later as before.
            const ra = Number.isFinite(res.retryAfter) && res.retryAfter >= 0 && res.retryAfter <= 900 ? res.retryAfter : null;
            const wait = ra != null ? Math.max(RA_MIN_MS, ra * 1000 + RA_PAD_MS) : this.period(r);
            r.lastClick = (ra != null && !ipBurst ? now + wait : this.freeSlot(r.route, now + wait, r.id)) - this.period(r);
            if (ra != null) r.retryAfter = ra;
            this.store.saveAccountsSoon();
            if (r.margin > was) this.log.add(r.id, `The site said too fast — waiting ${(r.margin / 1000).toFixed(2)} s extra between batches from now on${ra != null ? ` (next try in ${Math.round(wait / 1000)} s, as the site asked)` : ''}`, 'warn');
            else if (ipBurst && now - (r.ipNotedAt || 0) > 10 * 60000) { r.ipNotedAt = now; this.log.add(r.id, 'The site said too fast for this IP (other accounts on it too) — its batches move to a quieter moment in the minute', 'warn'); }
            else if (ra != null && now - (r.raNotedAt || 0) > 10 * 60000) { r.raNotedAt = now; this.log.add(r.id, `The site refused a batch — next try in ${Math.round(wait / 1000)} s, as the site asked`, 'warn'); }
        }
        // landed: what this run's batches added to the account's lifetime counters (money clicks; cases from case clicks),
        // for Troubleshoot's extra-clicks check. unsure counts batches that may have landed without the hub knowing
        // (a failed or retried send); the check starts over after one of those.
        const landed = r.landed || (r.landed = { money: 0, cases: 0, unsure: 0 });
        if (res.kind !== 'ok') { if (res.kind !== 'gone') r.failedBatches++; if (res.kind !== 'rate' && res.kind !== 'gone') landed.unsure++; return; }
        if (res.attempts > 1) landed.unsure++;
        if (type === 'cases') landed.cases += Number(res.json && res.json.amount) || 0; else landed.money += n;
        const high = r.margin > MARGIN_HIGH;
        if (++r.clean >= (high ? MARGIN_EASE_HIGH_AFTER : MARGIN_EASE_AFTER) && r.margin > MARGIN_MIN) {
            r.clean = 0;
            r.margin = acct.clickMarginMs = high ? Math.max(MARGIN_HIGH, r.margin - MARGIN_EASE_HIGH) : Math.max(MARGIN_MIN, r.margin - MARGIN_EASE);
        }
        r.clicks += n; r.lastClickOkAt = Date.now();
        (r.okTimes || (r.okTimes = [])).push(r.lastClickOkAt);
        acct.lastClickAt = r.lastClickOkAt; this.store.saveAccountsSoon();
        this.emit('click', r.id, n); this.emit('change');
    }

    async vault(r) {
        // The site answers 400 when there's nothing to collect — that's fine.
        const res = await this.call(r, '/api/vault', { method: 'POST', okStatus: [400] });
        if (res.kind === 'ok' && res.status === 200) { r.lastVaultOkAt = Date.now(); r.vaults++; this.log.add(r.id, 'Vault collected'); this.emit('change'); }
    }

    // Until an account's first report lands its card has no numbers, so a failed one is tried again soon (reportRetryMs,
    // doubling up to reportMs) instead of a whole reportMs later. Start all sends every first report at once and the site
    // limits each IP's bursts, so some got refused: those cards sat empty for 4 minutes until a restart (tester, 2026-11-15).
    reportFailed(r, why) {
        const s = this.settings;
        r.reportFails = (r.reportFails || 0) + 1;
        if (r.me || this.run.get(r.id) !== r) return;
        const wait = Math.min(s.reportMs, (s.reportRetryMs || 10000) * 2 ** (r.reportFails - 1));
        r.lastReport = Date.now() - s.reportMs + wait;
        if (r.reportFails === 1 || wait >= s.reportMs) this.log.add(r.id, `Couldn't get the account's numbers yet (${why}) — trying again in ${Math.round(wait / 1000)} s`, 'warn');
    }

    async report(r) {
        // The account's profile picture: an https address, or a path on the site; anything else is left out.
        const imageOf = (u) => (typeof u !== 'string' || u.length > 500 ? null : /^https:\/\//.test(u) ? u : /^\/[^/]/.test(u) ? 'https://case-clicker.com' + u : null);
        const res = await this.call(r, '/api/me', { tries: 3 });
        if (res.kind !== 'ok') { if (res.kind !== 'gone' && res.kind !== 'auth') this.reportFailed(r, res.kind); return; }
        if (!res.json || typeof res.json !== 'object') { this.errors.raise(r.id, 'CC-API-01', '/api/me gave no data'); this.reportFailed(r, 'no data'); return; }
        const me = res.json;
        r.reportFails = 0;
        const acct = this.store.get(r.id);
        const before = acct && this.clickType(acct);
        r.me = {
            money: me.money ?? null, tokens: me.tokens ?? null, networth: me.networth ?? null,
            vaultPerMin: me.vaultMoneyPerMinute ?? null, vaultCap: me.vaultCapacity ?? null,
            moneyPerClick: me.moneyPerClick ?? null, casesPerClick: me.casesPerClick ?? null, casesPerClickMaxPrice: me.casesPerClickMaxPrice ?? null,
            membership: me.membership || null, vaultLastCollected: Date.parse(me.vaultLastCollected) || null,
            rank: me.rank && me.rank.id != null ? { id: me.rank.id, name: me.rank.name || null, xpNeededForRankup: me.rank.xpNeededForRankup ?? null } : null,
            xp: me.xp ?? null, skillPoints: me.skillPoints ?? null, premier: Number.isFinite(me.premierRating) ? me.premierRating : null, image: imageOf(me.image),
            openCount: me.caseOpenCount ?? null, openMult: me.maxCaseOpenMultiplier ?? null, at: Date.now(),
        };
        if (acct && acct.type === 'auto') {
            const now = this.clickType(acct);
            if (now !== before) this.log.add(r.id, `Auto: clicking ${now} (case click ${me.casesPerClick}% ${now === 'cases' ? '>' : '≤'} ${this.settings.autoCasePct}%)`);
        }
        this.measureCaseValue(r, r.me);
        // Collect at half full: nothing is lost before the vault is full, and half leaves slack for a missed collect.
        if (me.vaultMoneyPerMinute > 0 && me.vaultCapacity > 0)
            r.vaultEveryMs = Math.max(30000, me.vaultCapacity / me.vaultMoneyPerMinute * 60000 / 2);
        this.emit('report', r.id, me); this.emit('change');
    }

    async loggedOut(r, acct) {
        if (r.refreshing) return;
        r.refreshing = true; this.emit('change');
        this.log.add(r.id, 'Session expired — trying to log back in by itself', 'warn');
        let token = null;
        try { token = await this.auth.refresh(acct); } catch (_) {}
        // Imported accounts: no live session left, but the sign-in is kept — sign in again with it.
        if (!token && acct.login && this.auth.signIn) {
            this.log.add(r.id, 'Signing in again with its saved login', 'info');
            try { const res = await this.auth.signIn({ ...acct.login, partition: acct.partition, route: r.route }); if (res && res.ok) token = res.token; } catch (_) {}
        }
        if (token) {
            acct.token = token; this.store.saveAccounts();
            this.errors.clearGroup(r.id, 'auth');
            this.log.add(r.id, 'Logged back in', 'ok');
            r.refreshing = false; this.emit('change');
            return;
        }
        acct.token = null; this.store.saveAccounts();
        this.errors.raise(r.id, 'CC-AUTH-01');
        this.log.add(r.id, 'Logged out — log in again to resume', 'error');
        this.stop(r.id, { keepResume: true, quiet: true });
        this.emit('loggedOut', r.id);
    }

    // A fresh login for an account: clears the logout and resumes it if it was clicking before.
    loggedIn(id) {
        this.errors.clearGroup(id, 'auth');
        this.errors.clear(id, 'CC-AUTH-02');
        const a = this.store.get(id);
        if (a && a.wasRunning && !this.run.has(id)) this.start(id);
        this.emit('change');
    }

    // What an account actually clicks. 'auto' picks cases when the account's case click % (casesPerClick,
    // from /api/me) is above the threshold, money otherwise — money until the first report says.
    clickType(acct, me = null) {
        if (acct.type === 'off') return 'off';
        if (acct.type !== 'auto') return acct.type === 'cases' ? 'cases' : 'money';
        me = me || (this.run.get(acct.id) || {}).me || this.lastMe.get(acct.id);
        return me && me.casesPerClick > this.settings.autoCasePct ? 'cases' : 'money';
    }

    // $ per clicked case for one account: the median of its own recent samples once it has enough,
    // otherwise an estimate from its max case price. { value, measured, samples }
    caseValue(acct, me = null) {
        me = me || (this.run.get(acct.id) || {}).me || this.lastMe.get(acct.id);
        const cv = acct.caseValue;
        if (cv && cv.samples.length >= CASE_SAMPLES_NEEDED) {
            const s = [...cv.samples].sort((a, b) => a - b), m = s.length >> 1;
            return { value: s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2, measured: true, samples: s.length };
        }
        const max = me && me.casesPerClickMaxPrice;
        return { value: max > 0 ? max * CASE_VALUE_SHARE : DEFAULT_CASE_VALUE, measured: false, samples: cv ? cv.samples.length : 0 };
    }

    // Between two reports of an account that clicked only cases: its inventory value (net worth minus
    // money) grew by about cases × value per case. Rewards, trades or sales land in between sometimes —
    // that's why the value is a median of the last samples, and clearly-off samples are dropped here.
    measureCaseValue(r, me) {
        const acct = this.store.get(r.id);
        const inv = me.networth != null && me.money != null ? me.networth - me.money : null;
        const prev = r.snap;
        r.snap = { clicks: r.clicks, inv, cpc: me.casesPerClick, max: me.casesPerClickMaxPrice, cases: r.caseOnly };
        r.caseOnly = true;
        if (!acct || !prev || !prev.cases || inv == null || prev.inv == null || !(prev.cpc > 0)) return;
        // A different max price is a different case pool: start over.
        if (acct.caseValue && acct.caseValue.max !== me.casesPerClickMaxPrice) acct.caseValue = null;
        const cases = (r.clicks - prev.clicks) * casesPerClick(prev.cpc), grew = inv - prev.inv;
        if (cases < 100 || grew <= 0) return;
        const per = grew / cases;
        if (per < 0.1 || per > 100) return;
        const cv = acct.caseValue || (acct.caseValue = { max: me.casesPerClickMaxPrice ?? null, samples: [] });
        cv.samples.push(Math.round(per * 1000) / 1000);
        if (cv.samples.length > CASE_SAMPLES_KEPT) cv.samples.shift();
        this.store.saveAccountsSoon();
    }

    // For "Copy report": how steadily an account has been clicking this run.
    // expected = batches that were due since the first one (one per interval + margin) × batch size.
    stability(acct) {
        const r = this.run.get(acct.id), s = this.settings, now = Date.now();
        if (!r) return { running: false, lastClickAt: acct.lastClickAt || 0 };
        const due = now >= r.firstDueAt ? Math.floor((now - r.firstDueAt) / this.period(r)) + 1 : 0;
        const expected = due * s.clicksPerBatch;
        return {
            running: true, upMs: now - r.startedAt, clicks: r.clicks, expected,
            pct: expected ? Math.round(r.clicks / expected * 1000) / 10 : null,
            failedBatches: r.failedBatches, rateLimited: r.rateLimited, marginMs: r.margin, vaults: r.vaults, lastClickAt: r.lastClickOkAt,
        };
    }

    // For Troubleshoot > Clicks: the last hour's refused batches (the account's own vs the IP's limit) and missed ones.
    clickHealth(acct) {
        const r = this.run.get(acct.id), now = Date.now();
        if (!r) return { running: false };
        const hour = (r.refusals || []).filter(x => x.t >= now - 3600000);
        const { due, missed } = this.behind(r);
        return { running: true, refused: hour.filter(x => !x.ip).length, ipRefused: hour.filter(x => x.ip).length, missed, due, retryAfter: r.retryAfter ?? null,
            marginMs: r.margin, pct: this.stability(acct).pct, upMs: now - r.startedAt };
    }

    // What the panel shows per account.
    view(acct) {
        const r = this.run.get(acct.id);
        const issues = this.errors.list(acct.id);
        const s = this.settings;
        const perHour = s.clicksPerBatch * 3600000 / s.clickIntervalMs;
        let status;
        if (!r) status = !acct.token || issues.some(i => i.code === 'CC-AUTH-01') ? 'logged-out' : 'stopped';
        else if (r.refreshing) status = 'reconnecting';
        else if (r.held) status = 'testing';
        else if (this.errors.has(routeKey(r.route), 'CC-CF-01')) status = 'needs-you';
        else if (this.errors.has(null, 'CC-SITE-02')) status = 'waiting';
        else if (this.routeDown(r.route)) status = 'proxy-down';
        else if (issues.some(i => (this.errors.codes[i.code] || {}).group !== 'notice')) status = 'problem';
        else status = acct.type === 'off' ? 'no-clicks' : 'clicking';
        const me = (r && r.me) || this.lastMe.get(acct.id) || null;
        const clicks = this.clickType(acct, me), cv = this.caseValue(acct, me), caseValue = cv.value;
        const cases = clicks === 'cases' && me && me.casesPerClick ? casesPerClick(me.casesPerClick) * perHour : 0;
        return {
            id: acct.id, name: acct.name, type: acct.type, clickType: clicks, status, hasToken: !!acct.token, route: r ? r.route : (acct.route || 'direct'),
            test: r && r.held ? { startedAt: r.held.startedAt, ends: r.held.ends } : null,
            startedAt: r ? r.startedAt : null, clicks: r ? r.clicks : 0, lastClickOkAt: r ? r.lastClickOkAt : (acct.lastClickAt || 0),
            vaultEveryMin: r && r.vaultEveryMs ? Math.round(r.vaultEveryMs / 6000) / 10 : null,
            // For the panel's live bars: when the next batch goes out, and how full the vault is
            // (last collect, from the site or our own collect if that's newer, plus its rate and size).
            nextClickAt: r && clicks !== 'off' ? r.lastClick + this.period(r) : null, clickIntervalMs: s.clickIntervalMs,
            vault: r && clicks !== 'off' && me && me.vaultCap > 0 && me.vaultPerMin > 0 ? { cap: me.vaultCap, perMin: me.vaultPerMin, lastAt: Math.max(me.vaultLastCollected || 0, r.lastVaultOkAt || 0) || null } : null,
            me: me || null,
            // Rough, from the account's own rates: clicks run at a fixed pace; the vault fills at $/min;
            // cases count at their measured value. total is the account's income in $.
            perHour: r && me ? (() => {
                const vault = me.vaultPerMin && clicks !== 'off' ? me.vaultPerMin * 60 : 0;
                const clickMoney = clicks === 'money' && me.moneyPerClick ? me.moneyPerClick * perHour : 0;
                return { vault, clickMoney, cases, caseMoney: cases * caseValue, caseValue, caseValueMeasured: cv.measured, total: vault + clickMoney + cases * caseValue };
            })() : null,
            issues,
        };
    }
}

module.exports = { Engine, DEFAULT_CASE_VALUE, CASE_VALUE_SHARE };
