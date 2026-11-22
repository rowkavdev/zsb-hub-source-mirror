/**
 * SITE SOCKET (Electron)
 *
 * The site's live socket (socket.io v4 on wss://ws.case-clicker.com) — trades happen on it. Plugins
 * get it through ctx.socket(accountId); the core passes the account's socket token here.
 *
 *   open(token) -> { emit(ev, ...args), wait(events, ms) -> { ev, data } | null, close() }   (most events take one argument; a few, like joinGameCoinflip, take several)
 *
 * Opened from the main process with the check window's cookies (cf_clearance) and user agent. If
 * that's refused, it's opened inside the check window instead (that page already passed Cloudflare).
 * Protocol: on "0{…}" send "40{token, client}" (client: the X-CC-Client value, the site's rules for scripts), "2" -> "3" (ping), events are "42[ev, data]".
 */

const { session } = require('electron');
const { ORIGIN } = require('./dev');

const WS_URL = 'wss://ws.' + new URL(ORIGIN).host.replace(/^www\./, '') + '/socket.io/?EIO=4&transport=websocket';
const CONNECT_MS = 15000;
const DIRECT_SKIP_MS = 10 * 60000;

// Events land in a queue; wait() takes the first matching one (earlier ones included).
function queue() {
    const events = [], waiters = [];
    return {
        push(ev, data) {
            const i = waiters.findIndex(w => w.evs.includes(ev));
            if (i >= 0) { const [w] = waiters.splice(i, 1); clearTimeout(w.t); w.res({ ev, data }); } else { events.push({ ev, data }); if (events.length > 200) events.shift(); }
        },
        wait(evs, ms) {
            const i = events.findIndex(e => evs.includes(e.ev));
            if (i >= 0) return Promise.resolve(events.splice(i, 1)[0]);
            return new Promise(res => { const w = { evs, res }; w.t = setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) waiters.splice(k, 1); res(null); }, ms); waiters.push(w); });
        },
        end() { for (const w of waiters.splice(0)) { clearTimeout(w.t); w.res(null); } },
    };
}

async function openDirect(token, partition, client) {
    const ses = session.fromPartition(partition);
    const cookies = await ses.cookies.get({ url: ORIGIN }).catch(() => []);
    const headers = { 'user-agent': ses.getUserAgent(), origin: ORIGIN, 'X-CC-Client': client };
    if (cookies.length) headers.cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const ws = new WebSocket(WS_URL, { headers });
    const q = queue();
    // A refused login or a failed connection closes the socket: left open it stayed connected (answering pings) for good.
    await new Promise((resolve, reject) => {
        const fail = (msg) => { clearTimeout(t); q.end(); try { ws.close(); } catch (_) {} reject(new Error(msg)); };
        const t = setTimeout(() => fail('socket connect timeout'), CONNECT_MS);
        ws.onmessage = (m) => {
            const d = String(m.data);
            if (d[0] === '0') ws.send('40' + JSON.stringify({ token, client }));
            else if (d === '2') ws.send('3');
            else if (d.startsWith('40')) { clearTimeout(t); resolve(); }
            else if (d.startsWith('44')) fail('socket refused the login');
            else if (d.startsWith('42')) { let p; try { p = JSON.parse(d.slice(2)); } catch (_) { return; } q.push(p[0], p[1]); }
        };
        ws.onerror = () => fail('socket connection failed');
        ws.onclose = () => { clearTimeout(t); q.end(); };
    });
    return {
        emit: (ev, ...args) => { if (ws.readyState !== 1) return false; ws.send('42' + JSON.stringify(frame(ev, args))); return true; },
        wait: (evs, ms = 8000) => q.wait(evs, ms),
        close: () => { try { ws.close(); } catch (_) {} q.end(); },
    };
}

// [event, ...arguments]; one (or no) argument is sent as before: [event, data].
const frame = (ev, args) => args.length > 1 ? [ev, ...args] : [ev, args[0]];

// Same thing inside the check window's page.
const PAGE_HELPER = `(() => { if (window.__zsbSock) return true;
  const socks = {};
  window.__zsbSock = {
    open(id, url, token, client) { return new Promise((resolve, reject) => {
      const ws = new WebSocket(url); const s = socks[id] = { ws, events: [], waiters: [] };
      const fail = (msg) => { clearTimeout(t); try { ws.close(); } catch (e) {} delete socks[id]; reject(new Error(msg)); };
      const t = setTimeout(() => fail('socket connect timeout'), ${CONNECT_MS});
      ws.onmessage = (m) => { const d = String(m.data);
        if (d[0] === '0') ws.send('40' + JSON.stringify({ token, client }));
        else if (d === '2') ws.send('3');
        else if (d.startsWith('40')) { clearTimeout(t); resolve(true); }
        else if (d.startsWith('44')) fail('socket refused the login');
        else if (d.startsWith('42')) { let p; try { p = JSON.parse(d.slice(2)); } catch (e) { return; }
          const i = s.waiters.findIndex(w => w.evs.includes(p[0])); if (i >= 0) { const [w] = s.waiters.splice(i, 1); w.res({ ev: p[0], data: p[1] }); } else { s.events.push({ ev: p[0], data: p[1] }); if (s.events.length > 200) s.events.shift(); } } };
      ws.onerror = () => fail('socket connection failed'); }); },
    emit(id, msg) { const s = socks[id]; if (!s || s.ws.readyState !== 1) return false; s.ws.send('42' + JSON.stringify(msg)); return true; },
    wait(id, evs, ms) { const s = socks[id]; if (!s) return Promise.resolve(null);
      const i = s.events.findIndex(e => evs.includes(e.ev)); if (i >= 0) return Promise.resolve(s.events.splice(i, 1)[0]);
      return new Promise(res => { const w = { evs, res }; s.waiters.push(w); setTimeout(() => { const k = s.waiters.indexOf(w); if (k >= 0) { s.waiters.splice(k, 1); res(null); } }, ms); }); },
    close(id) { const s = socks[id]; if (s) { try { s.ws.close(); } catch (e) {} delete socks[id]; } return true; },
  }; return true; })()`;

let seq = 0;
async function openInWindow(token, evalInWindow, client) {
    const id = 's' + (++seq);
    const run = (js) => evalInWindow(js).then(v => { if (v && v.notReady) throw new Error('the check window is not ready'); return v; });
    await run(PAGE_HELPER);
    await run(`window.__zsbSock.open(${JSON.stringify(id)}, ${JSON.stringify(WS_URL)}, ${JSON.stringify(token)}, ${JSON.stringify(client)})`);
    return {
        emit: (ev, ...args) => { run(`window.__zsbSock.emit(${JSON.stringify(id)}, ${JSON.stringify(frame(ev, args))})`).catch(() => {}); return true; },
        wait: (evs, ms = 8000) => run(`window.__zsbSock.wait(${JSON.stringify(id)}, ${JSON.stringify(evs)}, ${ms})`).catch(() => null),
        close: () => { run(`window.__zsbSock.close(${JSON.stringify(id)})`).catch(() => {}); },
    };
}

// prepareWindow(ms, route): gets that route's check window through Cloudflare first, so the fallback doesn't need it open.
// A proxied route always opens inside its check window: a socket from the main process wouldn't go through the proxy.
function createSockets({ partition, evalInWindow, prepareWindow, log, client: clientOf = () => '' }) {
    const inWindow = async (token, route, client) => {
        if (prepareWindow && !(await prepareWindow(30000, route))) throw new Error('the check window did not get through Cloudflare');
        return openInWindow(token, (js) => evalInWindow(js, route), client);
    };
    // After a direct socket fails, the next ones go straight through the check window for a while: on some connections
    // the direct one never works, and each try logged a warning (the most common line in shared logs, 2026-11-21).
    let directFailedAt = 0;
    return {
        // client: the X-CC-Client value for the handshake (the core passes it; else the app's own).
        async open(token, route = 'direct', client = clientOf()) {
            if (route !== 'direct' && evalInWindow) return inWindow(token, route, client);
            if (evalInWindow && Date.now() - directFailedAt < DIRECT_SKIP_MS) return inWindow(token, route, client);
            try { return await openDirect(token, partition, client); } catch (e) {
                if (!evalInWindow) throw e;
                directFailedAt = Date.now();
                log.add(null, `Site socket: ${e.message} — using the check window for sockets for the next ${DIRECT_SKIP_MS / 60000} min`, 'warn');
                return inWindow(token, route, client);
            }
        },
    };
}

module.exports = { createSockets, WS_URL };
