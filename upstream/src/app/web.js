/**
 * BROWSER PANEL (optional)
 *
 * The same panel files, served over HTTP so it can be checked from a phone or another PC.
 * Off by default; it only turns on with a password set. Sign-in is a small password page that sets a
 * session cookie (some embedded browsers never show an HTTP Basic prompt); HTTP Basic still works for
 * scripts. POST /rpc { method, args } runs the same methods as the app window.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
// Methods that only make sense at the machine itself.
const APP_ONLY = new Set(['copyReport', 'openDataFolder', 'quit']);
const SESSION_MS = 30 * 24 * 3600 * 1000;
const COOKIE = 'zsbhub';

const LOGIN_PAGE = (wrong) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZSB Hub — sign in</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0f;color:#e8e8ee;font:15px system-ui,sans-serif}
form{width:min(320px,calc(100vw - 32px));display:grid;gap:12px;padding:24px;border:1px solid #2a2a33;border-radius:10px;background:#14141a}
h1{margin:0;font-size:18px}p{margin:0;color:#9a9aa8;font-size:13px}.bad{color:#ff7a7a}
input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #2a2a33;background:#0b0b0f;color:inherit}
button{background:#6d5cff;border-color:#6d5cff;color:#fff;cursor:pointer}</style></head><body>
<form method="post" action="/login"><h1>ZSB Hub</h1><p>Enter the browser panel password set in the app.</p>
${wrong ? `<p class="bad">${wrong}</p>` : ''}<input type="password" name="password" autocomplete="current-password" autofocus required>
<button>Sign in</button></form></body></html>`;

function startWebPanel({ port, password, rpc, panelDir, log }) {
    const want = Buffer.from(password);
    const fails = new Map();   // ip -> { n, until } — slows down password guessing

    // A sign-in cookie is "<expiry>.<HMAC of it keyed by the password>": it survives an app restart, and
    // changing the password signs every browser out.
    const sign = (until) => until.toString(16) + '.' + crypto.createHmac('sha256', want).update('zsbhub-session:' + until).digest('hex');
    const right = (s) => { const b = Buffer.from(s); return b.length === want.length && crypto.timingSafeEqual(b, want); };
    const cookieOk = (req) => {
        const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-f0-9]{1,16})\\.([a-f0-9]{64})').exec(req.headers.cookie || '');
        if (!m) return false;
        const until = parseInt(m[1], 16), got = Buffer.from(m[1] + '.' + m[2]), good = Buffer.from(sign(until));
        return until > Date.now() && got.length === good.length && crypto.timingSafeEqual(got, good);
    };
    const authed = (req) => {
        if (cookieOk(req)) return true;
        const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
        return !!m && right(Buffer.from(m[1], 'base64').toString().split(':').slice(1).join(':'));
    };
    const failed = (ip, f) => { const n = (f ? f.n : 0) + 1; fails.set(ip, { n, until: n >= 5 ? Date.now() + 60000 : 0 }); };

    const server = http.createServer((req, res) => {
        const ip = req.socket.remoteAddress;
        const f = fails.get(ip);
        if (f && f.until > Date.now()) { res.writeHead(429); return res.end('Too many wrong passwords — wait a minute'); }
        if (req.method === 'POST' && req.url === '/login') {
            let body = '';
            req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
            req.on('end', () => {
                const pass = new URLSearchParams(body).get('password') || '';
                if (!right(pass)) {
                    failed(ip, f);
                    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                    return res.end(LOGIN_PAGE('Wrong password.'));
                }
                fails.delete(ip);
                res.writeHead(303, { location: '/', 'set-cookie': `${COOKIE}=${sign(Date.now() + SESSION_MS)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}` });
                res.end();
            });
            return;
        }
        if (!authed(req)) {
            if (req.headers.authorization) failed(ip, f);
            // A page load gets the sign-in page; scripts (and /rpc) get a plain 401 that still offers Basic.
            if (req.method === 'GET' && /text\/html/.test(req.headers.accept || '')) {
                res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                return res.end(LOGIN_PAGE(''));
            }
            res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="ZSB Hub", charset="UTF-8"' });
            return res.end('Password needed');
        }
        fails.delete(ip);

        if (req.method === 'POST' && req.url === '/rpc') {
            let body = '';
            req.on('data', (c) => { body += c; if (body.length > 30e6) req.destroy(); });   // a plugin zip (20 MB as base64) is the biggest call
            req.on('end', async () => {
                let out;
                try {
                    const { method, args } = JSON.parse(body || '{}');
                    if (!Object.prototype.hasOwnProperty.call(rpc, method) || APP_ONLY.has(method)) out = { ok: false, error: 'Not available from the browser' };
                    else out = await rpc[method](...(Array.isArray(args) ? args : []));
                } catch (e) { out = { ok: false, error: e.message }; }
                res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
                res.end(JSON.stringify(out === undefined ? null : out));
            });
            return;
        }

        const rel = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
        const file = path.join(panelDir, rel);
        if (!file.startsWith(panelDir + path.sep) || !TYPES[path.extname(file)]) { res.writeHead(404); return res.end(); }
        fs.readFile(file, (err, data) => {
            if (err) { res.writeHead(404); return res.end(); }
            res.writeHead(200, { 'content-type': TYPES[path.extname(file)], 'cache-control': 'no-store' });
            res.end(data);
        });
    });
    server.on('error', (e) => log.add(null, `Browser panel couldn't start on port ${port}: ${e.code || e.message}`, 'error'));
    server.listen(port, () => log.add(null, `Browser panel on port ${port}`, 'ok'));
    return { close: () => server.close() };
}

module.exports = { startWebPanel };
