/**
 * LOGIN (Electron)
 *
 * "Add account" opens the real case-clicker login page in its own window and session. The user
 * signs in there themselves — the app never sees or stores a password. Once the page leaves
 * /auth, the session's cookies are searched for the API token, and a candidate is only kept if it
 * works on its own (Bearer header, no cookies), the same way every click uses it.
 *
 * Each account keeps its login session (partition). When a token expires, refresh() opens that
 * session hidden: if the site still recognises it, a new token comes out without asking the user.
 */

const { BrowserWindow, session, net } = require('electron');
const crypto = require('crypto');
const { ORIGIN, HIDE_WINDOWS } = require('./dev');
const { trimSession } = require('./transport');
const { t } = require('../core/text');

const LOGIN_URL = ORIGIN + '/auth/login';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A token is good if /api/me answers 200 to it alone, from a session with no cookies (one per route, so the check goes
// out the same way the account's clicks will). Resolves true, false, or 'cf' when Cloudflare stopped the check itself
// (a clean session has no Cloudflare pass, and proxy IPs get challenged far more often than a home connection).
const CF_BODY = /Just a moment|__cf_chl|challenge-platform/i;
function tokenWorks(token, route = 'direct') {
    return new Promise((resolve) => {
        try {
            const req = net.request({ url: ORIGIN + '/api/me', session: session.fromPartition(route === 'direct' ? 'verify-clean' : 'verify-clean-' + route) });
            req.setHeader('Authorization', 'Bearer ' + token);
            const to = setTimeout(() => { try { req.abort(); } catch (_) {} resolve(false); }, 20000);
            req.on('response', (r) => {
                let body = '';
                r.on('data', (d) => { if (body.length < 20000) body += d; });
                r.on('error', () => { clearTimeout(to); resolve(false); });
                r.on('end', () => { clearTimeout(to); resolve(r.statusCode === 200 ? true : [403, 429, 503].includes(r.statusCode) && CF_BODY.test(body) ? 'cf' : false); });
            });
            req.on('error', () => { clearTimeout(to); resolve(false); });
            req.end();
        } catch (_) { resolve(false); }
    });
}

// Token candidates from a login session: auth-looking cookies first, then any long cookie, then
// localStorage — longest first. UUIDs are ids, not tokens.
async function candidates(partition, win) {
    const out = [];
    const cookies = await session.fromPartition(partition).cookies.get({}).catch(() => []);
    for (const c of cookies) if (/token|jwt|session|auth/i.test(c.name) && c.value && c.value.length > 50) out.push(c.value);
    for (const c of cookies) if (c.value && c.value.length > 100 && !out.includes(c.value)) out.push(c.value);
    if (win && !win.isDestroyed()) {
        const ls = await win.webContents.executeJavaScript(`localStorage.getItem('token') || sessionStorage.getItem('token') || ''`).catch(() => '');
        if (ls && ls.length > 50 && !UUID.test(ls) && !out.includes(ls)) out.push(ls);
    }
    return out.sort((a, b) => b.length - a.length);
}

// The first candidate that works. When Cloudflare stops the clean check, the token is checked again through the route's
// own session (the one its clicks use, which holds that route's Cloudflare pass), after getting that pass if needed.
// On a proxy, any failed clean check goes through the route's session too: that request also answers a proxy that
// wants a password (a clean check can't, and gets 407). diag.status keeps the last answer for the timeout reason.
async function findToken(partition, win, route, transport, diag = {}) {
    for (const c of await candidates(partition, win)) {
        const ok = await tokenWorks(c, route);
        if (ok === true) return c;
        if ((ok === 'cf' || (route && route !== 'direct')) && transport && transport.request) {
            if (ok === 'cf' && transport.ready) await transport.ready(30000, route);
            const r = await transport.request({ path: '/api/me', token: c, route, timeoutMs: 20000 });
            if (r.status === 200) return c;
            diag.status = r.status || r.error || 'no answer';
        } else diag.status = ok === 'cf' ? 'Cloudflare' : 'refused';
    }
    return null;
}

// Who the token belongs to: the site's user id (to spot the same account added twice) and its name.
// /api/auth/get-session -> { session: { userId, expiresAt, … }, user: { id, name, … } } answers both;
// its user.id is the same id /api/user/profile gives, which stays as the fallback for the id.
async function whoIs(transport, token, route) {
    const g = await transport.request({ path: '/api/auth/get-session', token, timeoutMs: 15000, route });
    const user = (g.status === 200 && g.json && g.json.user) || {};
    let userId = user.id || (g.json && g.json.session && g.json.session.userId) || null;
    if (!userId) {
        const r = await transport.request({ path: '/api/user/profile', token, timeoutMs: 15000, route });
        userId = (r.status === 200 && r.json && r.json.userId) || null;
    }
    // No name is fine: the account gets "Account N" and can be renamed.
    const name = typeof user.name === 'string' && user.name.trim() ? user.name.trim().slice(0, 40) : null;
    return { userId, name };
}

function createAuth({ transport, log }) {
    let open = null;   // only one login window at a time
    // Imports sign in several at once: only one of their windows is on screen at a time (they kept jumping over each
    // other, the user, 2026-11-12). The others go on hidden and show, one by one, if they still need the person.
    let onScreen = null;

    function newWindow(partition, show) {
        return new BrowserWindow({
            show: show && !HIDE_WINDOWS, width: 980, height: 900, title: t('window.login.title'), autoHideMenuBar: true, backgroundColor: '#0b0b0f',
            webPreferences: { partition, contextIsolation: true, nodeIntegration: false },
        });
    }

    // The login session (and the token check) use the account's route: a proxy, or this PC's connection.
    async function useRoute(partition, route = 'direct') {
        if (!transport.applyRoute) return;
        await transport.applyRoute(partition, route);
        await transport.applyRoute(route === 'direct' ? 'verify-clean' : 'verify-clean-' + route, route);
    }

    // Opens the login window. Resolves { ok, token, partition, userId, name } or { ok: false, code }.
    async function login({ partition, route = 'direct' } = {}) {
        if (open && !open.isDestroyed()) { open.show(); open.focus(); return { ok: false, error: 'A login window is already open' }; }
        partition = partition || 'persist:login-' + crypto.randomBytes(4).toString('hex');
        await useRoute(partition, route);
        const win = open = newWindow(partition, true);
        return new Promise((resolve) => {
            let done = false, checking = false;
            const finish = (v) => {
                if (done) return; done = true;
                clearInterval(poll); clearTimeout(timeout);
                if (!win.isDestroyed()) win.destroy();
                open = null;
                // Keep the login (cookies), drop the site's cache.
                trimSession(partition).finally(() => resolve(v));
            };
            const attempt = async () => {
                if (done || checking || win.isDestroyed()) return;
                if (/\/auth(\/|$)/.test(win.webContents.getURL())) return;   // still on the login pages
                checking = true;
                try {
                    await sleep(1500);   // let the site finish setting its session
                    const token = await findToken(partition, win, route, transport);
                    if (token) { const who = await whoIs(transport, token, route); finish({ ok: true, token, partition, ...who }); }
                } finally { checking = false; }
            };
            const poll = setInterval(attempt, 2000);
            const timeout = setTimeout(() => finish({ ok: false, code: 'CC-AUTH-02', error: 'timed out' }), 10 * 60 * 1000);
            // Closed by the user: the login may still have gone through.
            win.on('close', () => {
                if (done) return;
                findToken(partition, null, route, transport).then(async (token) => {
                    if (token) finish({ ok: true, token, partition, ...(await whoIs(transport, token, route)) });
                    else finish({ ok: false, code: 'CC-AUTH-02', error: 'window closed' });
                }).catch(() => finish({ ok: false, code: 'CC-AUTH-02', error: 'window closed' }));
            });
            win.loadURL(LOGIN_URL).catch(() => {});
        });
    }

    // Signs in with an email and password (imported accounts, and their re-logins): the site's login page in a hidden
    // window, the form filled and sent the way a person would. The window is shown only when the site asks for a check
    // (Cloudflare's Turnstile on the login form) that doesn't pass by itself. Resolves like login(), or
    // { ok: false, code: 'CC-AUTH-04', error } with the site's own message for a wrong email or password.
    // shouldStop(): checked every quarter second (and while the page loads); true ends it at once with { ok: false, stopped: true }.
    // The window shows after checkMs while the site's check still keeps Login locked, else after showAfterMs.
    const POLL_MS = 250;   // how often the sign-in page is looked at (once a second made each sign-in ~10 s)
    async function signIn({ email, password, partition, route = 'direct', shouldStop = () => false, checkMs = 4000, showAfterMs = 12000, timeoutMs = 4 * 60000 } = {}) {
        partition = partition || 'persist:login-' + crypto.randomBytes(4).toString('hex');
        await useRoute(partition, route);
        const win = newWindow(partition, false);
        const fill = `(()=>{const e=document.querySelector('input[type=email],input[name=email],input[autocomplete=username]');const p=document.querySelector('input[type=password]');
            if(!e||!p)return 'noform';const set=(el,v)=>{const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};
            if(e.value!==${JSON.stringify(email)})set(e,${JSON.stringify(email)});if(p.value!==${JSON.stringify(password)})set(p,${JSON.stringify(password)});
            const f=p.closest('form')||document;const b=[...f.querySelectorAll('button[type=submit],input[type=submit]')].filter(x=>!x.closest('[class*=termly],[id*=termly],[class*=consent],[id*=consent]'))[0];
            if(!b||b.disabled)return 'waiting';b.click();return 'sent';})()`;
        // What the page shows now: the site's error box ("Oops, there was an error… Error: <why>", or a notification),
        // its two-factor code box (stays on /auth/login), or the "confirm your email" page (/auth/login?message=confirmMail).
        const look = `(()=>{const q=s=>[...document.querySelectorAll(s)];
            if(/[?&]message=confirmMail/.test(location.search))return {state:'unverified'};
            if(document.querySelector('input[autocomplete=one-time-code]'))return {state:'code'};
            const els=q('[role=alert],.mantine-Alert-message,.mantine-Notification-description,.mantine-InputWrapper-error');
            const t=els.filter(x=>!els.some(y=>y!==x&&x.contains(y))).map(x=>x.textContent.trim()).filter(Boolean).join(' ');
            const field=q('.mantine-InputWrapper-error').map(x=>x.textContent.trim()).filter(Boolean).join(' ');
            const m=/Error:\\s*([\\s\\S]+)$/.exec(t);const text=(m?m[1]:field||t).replace(/\\s+/g,' ').trim().slice(0,140);
            return {state:'',text,err:!!(m||field||/invalid|incorrect|wrong|password|banned|suspend|not found|disabled|blocked/i.test(text))};})()`;
        const run = (js) => win.webContents.executeJavaScript(js).catch(() => '');
        // false: another sign-in's window is on screen; this one tries again on its next look.
        const showWin = (title) => {
            if (HIDE_WINDOWS) return true;
            if (onScreen && onScreen !== win && !onScreen.isDestroyed()) return false;
            onScreen = win; win.setTitle(title); win.show(); win.moveTop(); win.focus(); win.flashFrame(true); return true;
        };
        try {
            // The page load can be slow (proxies, Cloudflare): Stop doesn't wait for it.
            const loaded = win.loadURL(LOGIN_URL).catch(() => {});
            let loading = true; loaded.then(() => { loading = false; });
            while (loading && !shouldStop()) await Promise.race([loaded, sleep(500)]);
            if (shouldStop()) return { ok: false, stopped: true };
            let t0 = Date.now();
            let shown = false, sentAt = 0, sentEver = false, busyUntil = 0, locked = false, codeAsked = false, lastErr = '', leftAuth = false; const diag = {};
            while (Date.now() - t0 < timeoutMs && !win.isDestroyed()) {
                if (shouldStop()) return { ok: false, stopped: true };
                if (!/\/auth(\/|$)/.test(win.webContents.getURL())) {
                    if (!leftAuth) await sleep(300);   // let the site finish setting its session
                    const token = await findToken(partition, win, route, transport, diag);
                    if (token) return { ok: true, token, partition, ...(await whoIs(transport, token, route)) };
                    leftAuth = true;
                    await sleep(500); continue;   // signed in, the token isn't readable yet: look again (the login form is gone)
                }
                const p = (await run(look)) || {};
                if (p.state === 'unverified') return { ok: false, code: 'CC-AUTH-04', error: "the email isn't confirmed on the site yet (check that inbox, then import it again)" };
                // Two-factor: only the person can type the code. Show the window and give them the full wait from now.
                if (p.state === 'code') {
                    if (!codeAsked) { codeAsked = true; t0 = Date.now(); }
                    if (!shown) shown = showWin(t('window.signin.code', { email }));
                    await sleep(POLL_MS); continue;
                }
                if (p.text) {
                    lastErr = p.text;
                    // Too many sign-ins from this connection: wait it out instead of sending again and again.
                    if (/too many|rate.?limit|slow down|try again later/i.test(p.text)) busyUntil = Date.now() + 30000;
                    // The site's check was refused, or the request failed on the way: the check resets itself, so send again.
                    else if (/captcha|turnstile|challenge|verification|fetch|network|timed? ?out|50\d|bad gateway/i.test(p.text)) {}
                    // The site's error box, a field error or a refusal (wrong password, banned, …) is its answer. Its other
                    // pop-ups ("Reconnecting to websocket server…", "also available in the browser") aren't.
                    else if (p.err) return { ok: false, code: 'CC-AUTH-04', error: p.text };
                }
                // Send (again) every few seconds: the Login button stays disabled until the check on the form has passed.
                if (Date.now() - sentAt > 4000 && Date.now() > busyUntil) { const r = await run(fill); locked = r === 'waiting'; if (r === 'sent') { sentAt = Date.now(); sentEver = true; } }
                if (!shown && Date.now() - t0 > (locked && !sentEver ? checkMs : showAfterMs)) shown = showWin(t('window.signin.title', { email }));
                await sleep(POLL_MS);
            }
            // Say why: a code never typed, the site kept saying "too many", its check never passed, or what it last said.
            const why = leftAuth ? 'timed out: signed in, but the new session never worked from this connection' + (route === 'direct' ? '' : ' (its proxy)') + (diag.status ? ', last answer: ' + diag.status : '')
                : codeAsked ? 'timed out: the account needs its two-factor code, typed in the sign-in window'
                : busyUntil ? 'timed out: the site said too many sign-ins, try again later'
                : !sentEver ? "timed out: the site's check on the login form never passed"
                : lastErr ? 'timed out: the site kept saying "' + lastErr + '"'
                : 'timed out: no answer after Login';
            return { ok: false, code: 'CC-AUTH-04', error: why };
        } finally {
            if (onScreen === win) onScreen = null;
            if (!win.isDestroyed()) win.destroy();
            // Clearing the page cache takes a while: the next sign-in doesn't wait for it.
            trimSession(partition).catch(() => {});
        }
    }

    // Silent re-login: the account's saved login session, in a hidden window. A new token or null.
    async function refresh(acct) {
        if (!acct.partition) return null;
        const route = acct.route || 'direct';
        await useRoute(acct.partition, route);
        const win = newWindow(acct.partition, false);
        try {
            await win.loadURL(ORIGIN + '/').catch(() => {});
            await sleep(3000);
            if (/\/auth(\/|$)/.test(win.webContents.getURL())) return null;   // sent to the login page: the session is gone too
            const token = await findToken(acct.partition, win, route, transport);
            return token && token !== acct.token ? token : null;
        } catch (e) {
            log.add(acct.id, 'Silent re-login failed: ' + e.message, 'warn');
            return null;
        } finally {
            if (!win.isDestroyed()) win.destroy();
            await trimSession(acct.partition);   // loading the site rebuilt its cache
        }
    }

    // Removing an account also forgets its login session.
    async function forget(partition) {
        if (partition) await session.fromPartition(partition).clearStorageData().catch(() => {});
    }

    // At start: trim sessions saved before trimming existed (or left big by a crash).
    async function trimAll(partitions) {
        for (const p of partitions) if (p) await trimSession(p);
        await trimSession(require('./transport').PARTITION);
    }

    return { login, signIn, refresh, forget, trimAll };
}

module.exports = { createAuth };
