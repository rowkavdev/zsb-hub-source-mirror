/**
 * TRANSPORT (Electron)
 *
 * Requests go out from the main process with net.request on a shared session per network route,
 * authenticated only by the account's Bearer token. Route 'direct' is this PC's own connection; a
 * plugin (Proxy manager) can add proxy routes, each with its own session (setProxy) — so its own
 * cookies and Cloudflare clearance, since those belong to the exit IP.
 *
 * Each route's session belongs to a hidden "check" window: when Cloudflare challenges, that window
 * loads the site, the user ticks the box once, and the cf_clearance it gets is reused by every
 * request on that route. If Cloudflare still blocks the background request (it can tell the
 * fingerprint apart on flagged IPs), the request is sent from inside the window instead.
 */

const { app, net, session, BrowserWindow } = require('electron');
const { ORIGIN, HIDE_WINDOWS } = require('./dev');
const { t } = require('../core/text');

const { HEADER, clientId } = require('../core/client');

const PARTITION = 'persist:cc';

// X-CC-Client (the site's rules for scripts): on every request to the site from any of the app's sessions — API calls,
// the check window, login windows, in-page fetches and socket handshakes. The core says what it is (with the main
// account once set); before the core is up, the app's name and version.
let currentClient = () => clientId(app.getVersion());
const setClient = (fn) => { currentClient = fn; };
const clientHeaders = (h) => (h && h[HEADER] ? h : { ...(h || {}), [HEADER]: currentClient() });
const SITE_HOST = new URL(ORIGIN).hostname.replace(/^www\./, '');
const isSite = (url) => { try { const h = new URL(url).hostname; return h === SITE_HOST || h.endsWith('.' + SITE_HOST); } catch (_) { return false; } };
const tagged = new WeakSet();
function tagSession(ses) {
    if (!ses || tagged.has(ses)) return;
    tagged.add(ses);
    ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (d, cb) => {
        if (!isSite(d.url)) return cb({});
        const h = d.requestHeaders;
        if (!Object.keys(h).some(k => k.toLowerCase() === HEADER.toLowerCase())) h[HEADER] = currentClient();
        cb({ requestHeaders: h });
    });
}
// Where the route windows wait: a plain-text page on the site's origin (its cookies, Cloudflare clearance, and the right
// Origin for sockets), for in-page fetches and sockets. Not /404: that is the site's whole app (53 scripts, ~160 MB per window).
const PARK_URL = ORIGIN + '/robots.txt';

// Loading the site leaves ~400 MB per session (measured 2026-11-02): an offline copy in its service
// worker plus the page cache. None of it is needed — logins and Cloudflare clearance live in cookies
// (and local storage, which is small) — so drop the rest after every page visit.
async function trimSession(partition) {
    const ses = session.fromPartition(partition);
    await ses.clearStorageData({ storages: ['serviceworkers', 'cachestorage', 'shadercache'] }).catch(() => {});
    await ses.clearCache().catch(() => {});
    if (ses.clearCodeCaches) await ses.clearCodeCaches({}).catch(() => {});
}

// "http://host:port" / "socks5://host:port" for Chromium's proxy rules (no credentials in it: those go through the
// login events below; Chromium can't do SOCKS5 with a password).
const rulesOf = (p) => `${p.scheme === 'socks5' ? 'socks5' : 'http'}://${p.host}:${p.port}`;
// Hosts that skip the proxy. The end-to-end test's fake site is on 127.0.0.1, which Chromium never proxies unless told
// to (<-loopback>); the real site is never local, so the app keeps the usual rule.
const BYPASS = process.env.CLICKER_E2E ? '<-loopback>' : '<local>';
const routePartition = (id) => (id === 'direct' ? PARTITION : 'persist:cc-route-' + id);

function createTransport({ log, onShow, onHide }) {
    const routes = new Map();   // id -> { id, partition, ses, proxy, w: { win, cleared, clearedAt, solving, loaded, shown } }
    const add = (id, proxy = null) => {
        const r = { id, partition: routePartition(id), proxy, w: { win: null, cleared: false, clearedAt: 0, solving: false } };
        r.ses = session.fromPartition(r.partition);
        routes.set(id, r);
        return r;
    };
    add('direct');
    const get = (id) => routes.get(id || 'direct') || routes.get('direct');
    let quitting = false;

    // A proxy asking for its username and password (check windows, login windows and in-page fetches): answered
    // from the route with that host and port.
    const proxyLogin = (authInfo) => {
        if (!authInfo || !authInfo.isProxy) return null;
        for (const r of routes.values()) if (r.proxy && r.proxy.host === authInfo.host && Number(r.proxy.port) === Number(authInfo.port) && r.proxy.user) return r.proxy;
        return null;
    };
    app.on('login', (event, _wc, _details, authInfo, callback) => {
        const p = proxyLogin(authInfo);
        if (p) { event.preventDefault(); callback(p.user, p.pass || ''); }
    });

    // The proxy routes a plugin wants: [{ id, proxy: { scheme, host, port, user, pass } }]. Gone ones are closed.
    async function setRoutes(list) {
        const want = new Map((list || []).filter(x => x && x.id && x.id !== 'direct' && x.proxy).map(x => [x.id, x]));
        for (const [id, r] of routes) {
            if (id === 'direct' || want.has(id)) continue;
            if (r.w.win && !r.w.win.isDestroyed()) { r.w.quitting = true; r.w.win.destroy(); }
            routes.delete(id);
        }
        for (const [id, x] of want) {
            const cur = routes.get(id);
            if (cur && JSON.stringify(cur.proxy) === JSON.stringify(x.proxy)) continue;
            const r = cur || add(id, x.proxy);
            r.proxy = x.proxy;
            r.w.cleared = false;
            await r.ses.setProxy({ proxyRules: rulesOf(x.proxy), proxyBypassRules: BYPASS }).catch((e) => log.add(null, `Proxy ${id}: ${e.message}`, 'warn'));
            await r.ses.closeAllConnections().catch(() => {});
        }
    }

    // For logins: the same proxy on an account's own login session.
    async function applyRoute(partition, routeId) {
        const r = routes.get(routeId);
        const ses = session.fromPartition(partition);
        await ses.setProxy(r && r.proxy ? { proxyRules: rulesOf(r.proxy), proxyBypassRules: BYPASS } : { mode: 'direct' }).catch(() => {});
    }

    function request({ method = 'GET', path, token, body, timeoutMs = 45000, route, url, headers }) {
        const r = get(route);
        return new Promise((resolve) => {
            let req;
            try { req = net.request({ method, url: url || ORIGIN + path, session: r.ses, useSessionCookies: true }); }
            catch (e) { return resolve({ status: 0, error: e.message }); }
            req.setHeader('accept', '*/*');
            req.setHeader('content-type', 'application/json');
            if (token) req.setHeader('Authorization', 'Bearer ' + token);
            for (const [k, v] of Object.entries(clientHeaders(headers))) req.setHeader(k, v);
            let data = '', done = false;
            const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
            const timer = setTimeout(() => { try { req.abort(); } catch (_) {} finish({ status: 0, error: 'timeout' }); }, timeoutMs);
            // A proxy that wants a password: answered once; asked again means it refused it (407).
            let asked = false;
            req.on('login', (authInfo, cb) => { const p = proxyLogin(authInfo); if (p && !asked) { asked = true; cb(p.user, p.pass || ''); } else cb(); });
            req.on('response', (res) => {
                res.on('data', (c) => { data += c; });
                res.on('error', (e) => finish({ status: 0, error: (e && e.message) || 'stream error' }));
                // A 429's or 503's Retry-After (seconds until the next request is allowed) goes along as retryAfter.
                const ra = (res.statusCode === 429 || res.statusCode === 503) && res.headers ? [].concat(res.headers['retry-after'] || res.headers['Retry-After'] || [])[0] : null;
                res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch (_) {} finish({ status: res.statusCode, json, body: data, ...(ra != null && ra !== '' && Number.isFinite(Number(ra)) ? { retryAfter: Number(ra) } : {}) }); });
            });
            // net errors look like "net::ERR_NAME_NOT_RESOLVED" (or "net::ERR_PROXY_CONNECTION_FAILED") — kept as the detail in the report.
            req.on('error', (e) => finish({ status: 0, error: e.message }));
            if (body != null) req.write(JSON.stringify(body));
            req.end();
        });
    }

    function ensureWindow(r) {
        const w = r.w;
        if (w.win && !w.win.isDestroyed()) return w.win;
        w.win = new BrowserWindow({
            show: false, width: 520, height: 640, title: t('window.check.title') + (r.id === 'direct' ? '' : ` (${r.proxy ? r.proxy.host : r.id})`),
            autoHideMenuBar: true, backgroundColor: '#0b0b0f',
            webPreferences: { partition: r.partition, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
        });
        w.win.on('close', (e) => { if (!quitting && !w.quitting) { e.preventDefault(); w.win.hide(); } });   // keep the session's page; just hide it
        w.win.on('hide', () => onHide && onHide());
        w.cleared = false; w.loaded = false;
        return w.win;
    }

    function show(r = get()) {
        const win = ensureWindow(r);
        if (HIDE_WINDOWS) { r.w.shown = true; return; }
        if (!win.isVisible()) { win.show(); win.focus(); onShow && onShow(); }
    }

    function hide() { for (const r of routes.values()) { r.w.shown = false; if (r.w.win && !r.w.win.isDestroyed() && r.w.win.isVisible()) r.w.win.hide(); } }

    // In-page fetch from the route's check window: it has cf_clearance and a real browser's fingerprint.
    async function viaWindow({ method = 'GET', path, token, body, route, headers }) {
        const w = get(route).w;
        if (!w.win || w.win.isDestroyed() || !w.cleared) return { status: 0, notReady: true };
        const init = { method, credentials: 'include', headers: { accept: '*/*', 'content-type': 'application/json', ...clientHeaders(headers), ...(token ? { Authorization: 'Bearer ' + token } : {}) } };
        if (body != null) init.body = JSON.stringify(body);
        try {
            const out = await w.win.webContents.executeJavaScript(
                `(async()=>{try{const r=await fetch(${JSON.stringify(path)},${JSON.stringify(init)});let t='';try{t=await r.text()}catch(e){}return{status:r.status,body:t,ra:r.headers.get('retry-after')}}catch(e){return{status:0}}})()`);
            let json = null; try { json = JSON.parse(out.body); } catch (_) {}
            const ra = (out.status === 429 || out.status === 503) && out.ra != null && out.ra !== '' && Number.isFinite(Number(out.ra)) ? { retryAfter: Number(out.ra) } : {};
            return { status: out.status, json, body: out.body, ...ra };
        } catch (_) { return { status: 0 }; }
    }

    // Run a script in the route's check window page (the site socket's fallback, and the only way for proxied
    // routes). { notReady: true } until it passed Cloudflare.
    async function evalInWindow(js, route) {
        const w = get(route).w;
        if (!w.win || w.win.isDestroyed() || !w.cleared) return { notReady: true };
        return w.win.webContents.executeJavaScript(js);
    }

    // Load the site in the window and wait until Cloudflare lets it through. Shown to the user only
    // if the check doesn't pass by itself within a few seconds.
    async function solve(r) {
        const w = r.w, win = ensureWindow(r);
        // Don't reload a window the user can see once it has a page: they may be mid-check.
        if (!(win.isVisible() || w.shown) || !w.loaded) {
            let loaded = false;
            for (let i = 0; i < 4 && !loaded; i++) {
                try { await win.loadURL(PARK_URL); loaded = true; } catch (_) { await new Promise(res => setTimeout(res, 2500)); }
                if (win.isDestroyed()) return false;
            }
            if (!loaded) return false;
            w.loaded = true;
        }
        const deadline = Date.now() + 10 * 60 * 1000;
        let seen = 0, onApiPage = false;
        while (Date.now() < deadline && !win.isDestroyed()) {
            let st = 'error';
            try {
                st = await win.webContents.executeJavaScript(`(async()=>{try{if(/Just a moment/i.test(document.title))return 'challenge';const r=await fetch('/api/me',{credentials:'include'});if([403,429,503].includes(r.status)){const t=await r.text();if(/Just a moment|__cf_chl/i.test(t))return 'challenge';}return 'clear';}catch(e){return 'error';}})()`);
            } catch (_) {}
            if (st === 'clear') {
                if (onApiPage) { try { await win.loadURL(PARK_URL); } catch (_) {} }
                return true;
            }
            if (st === 'challenge') {
                seen++;
                // Cloudflare sometimes challenges only the API paths, which a fetch can't show — so
                // open one as a page and the real check renders in the window.
                if (!onApiPage) { onApiPage = true; try { await win.loadURL(ORIGIN + '/api/me'); } catch (_) {} continue; }
                if (seen >= 3) show(r);
            }
            await new Promise(res => setTimeout(res, 2500));
        }
        return false;
    }

    function challenge(route) {
        const r = get(route), w = r.w;
        // Already on it, or it was cleared a moment ago and the next request will tell.
        if (w.solving || (w.cleared && Date.now() - w.clearedAt < 60000)) return;
        w.solving = true; w.cleared = false;
        const name = r.id === 'direct' ? 'Cloudflare window' : `Cloudflare window for proxy ${r.proxy ? r.proxy.host : r.id}`;
        solve(r).then((ok) => {
            w.cleared = ok;
            if (ok) {
                w.clearedAt = Date.now(); log.add(null, name + ' is clear'); trimSession(r.partition);
                // The check is done: put the window away (it stays loaded, hidden, for in-page requests).
                w.shown = false;
                if (w.win && !w.win.isDestroyed() && w.win.isVisible()) w.win.hide();
            }
            else log.add(null, name + ': the check wasn\'t solved in 10 minutes', 'warn');
        }).catch(() => {}).finally(() => { w.solving = false; });
    }

    // "Open check" in the panel: show the window (the given route's, or the first one waiting on a check).
    function openCheck(route) {
        const r = route ? get(route) : [...routes.values()].find(x => x.w.solving || (x.w.win && !x.w.cleared)) || get();
        show(r); challenge(r.id);
    }

    // Get a route's check window through Cloudflare (hidden unless a real check needs the user), within ms.
    async function ready(ms = 30000, route) {
        const w = get(route).w;
        if (w.cleared && w.win && !w.win.isDestroyed()) return true;
        challenge(route);
        const until = Date.now() + ms;
        while (Date.now() < until) { if (w.cleared) return true; await new Promise(res => setTimeout(res, 500)); }
        return w.cleared;
    }

    function close() { quitting = true; for (const r of routes.values()) if (r.w.win && !r.w.win.isDestroyed()) r.w.win.destroy(); }

    const winState = (w) => ({ cleared: w.cleared, solving: w.solving, visible: !!(w.win && !w.win.isDestroyed() && (w.win.isVisible() || w.shown)) });
    return { request, viaWindow, evalInWindow, ready, challenge, openCheck, hide, close, setRoutes, applyRoute,
        state: () => ({ ...winState(get().w), routes: Object.fromEntries([...routes].map(([id, r]) => [id, winState(r.w)])) }) };
}

module.exports = { createTransport, trimSession, ORIGIN, PARTITION, routePartition, tagSession, setClient, clientHeaders, currentClient: () => currentClient() };
