/**
 * WIREGUARD for the Proxy manager
 *
 * A WireGuard config can't be used as a proxy directly, so each one runs in its own copy of wireproxy
 * (github.com/windtf/wireproxy, open source): a small helper that connects that one tunnel and offers it as a SOCKS5
 * proxy on 127.0.0.1. The app's routes then use that local SOCKS5 address (no password needed: it's local only).
 *
 * The helper is downloaded the first time a WireGuard config is added — only the release named here, and only if its
 * sha256 matches the one written below (GitHub's own listing for that release) — and kept in the plugin's folder.
 * A config file is written only while its helper starts, then deleted: the keys live sealed in the plugin's data.
 */

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const net = require('net');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const HELPER = {
    version: 'v1.1.3',
    base: 'https://github.com/windtf/wireproxy/releases/download/v1.1.3/',
    assets: {
        'win32-x64': { file: 'wireproxy_windows_amd64.tar.gz', sha256: 'bce041ea9fe0f8a3351301dcbe29cdf6a523bb25cf9c62f17ebb5699a8051d0f' },
        'linux-x64': { file: 'wireproxy_linux_amd64.tar.gz', sha256: 'e88c1d090740373fc606c1bafd81d9a5eadc642cce5667616e20e9d7a444f51c' },
        'linux-arm64': { file: 'wireproxy_linux_arm64.tar.gz', sha256: '370e00bd2167960d1ecd1c3c1439715bbaa94a0a110a2040468670c9af6021b6' },
    },
};
const BIN = process.platform === 'win32' ? 'wireproxy.exe' : 'wireproxy';

// ---- reading configs ----

// Every WireGuard config in a pasted block (several can follow one another): [{ conf, endpoint, publicKey, label }] and
// what couldn't be used ({ text, why } — never with a key in it).
function parseWireGuard(text) {
    const found = [], skipped = [];
    const parts = String(text || '').split(/(?=^\s*\[Interface\]\s*$)/m).filter(p => /\[Interface\]/i.test(p));
    parts.forEach((p, i) => {
        const get = (k) => { const m = new RegExp('^\\s*' + k + '\\s*=\\s*(.+?)\\s*$', 'im').exec(p); return m ? m[1] : ''; };
        const endpoint = get('Endpoint'), publicKey = get('PublicKey');
        // A name from the first comment line that reads like one (not ProtonVPN's "Key for …" or "# Setting = value" lines).
        const name = (p.match(/^\s*#\s*(.+)$/gm) || []).map(l => l.replace(/^\s*#\s*/, '').trim()).find(l => l && !/=|^key for\b/i.test(l));
        const label = `WireGuard ${endpoint ? endpoint.split(':')[0] : i + 1}`;
        if (!get('PrivateKey')) return skipped.push({ text: label, why: 'no PrivateKey in it' });
        if (!get('Address')) return skipped.push({ text: label, why: 'no Address in it' });
        if (!/\[Peer\]/i.test(p) || !publicKey) return skipped.push({ text: label, why: 'no [Peer] with a PublicKey' });
        if (!/^[^:\s]+:\d+$/.test(endpoint)) return skipped.push({ text: label, why: 'no Endpoint (host:port)' });
        // Only what wireproxy reads: drop any [Socks5]/[http] sections a config might carry (the app adds its own).
        const conf = p.replace(/^\s*\[(Socks5|http|TCPClientTunnel|TCPServerTunnel|STDIOTunnel)\][\s\S]*?(?=^\s*\[|$(?![\s\S]))/gim, '').trim();
        found.push({ conf, endpoint, publicKey, label, name: name && name.length < 60 ? name : null });
    });
    return { found, skipped };
}

// ---- the helper program ----

function download(url, hops = 0) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'user-agent': 'zsb-hub' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) { res.resume(); return resolve(download(res.headers.location, hops + 1)); }
            if (res.statusCode !== 200) { res.resume(); return reject(new Error('download failed (HTTP ' + res.statusCode + ')')); }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

// One file out of a .tar (the release's archives hold the program and its licence).
function untarOne(tar, wanted) {
    for (let off = 0; off + 512 <= tar.length;) {
        const name = tar.toString('utf8', off, off + 100).replace(/\0.*$/s, '');
        if (!name) break;
        const size = parseInt(tar.toString('utf8', off + 124, off + 136).replace(/\0.*$/s, '').trim() || '0', 8);
        if (path.posix.basename(name) === wanted) return tar.subarray(off + 512, off + 512 + size);
        off += 512 + Math.ceil(size / 512) * 512;
    }
    return null;
}

let fetching = null;
// The helper's path, downloading and checking it first if needed. Throws with a plain reason.
async function ensureHelper(dir, log) {
    if (process.env.ZSB_WG_TEST_PORT) return 'test-helper';   // tests only: no download, no program
    const exe = path.join(dir, 'wireproxy-' + HELPER.version, BIN);
    if (fs.existsSync(exe)) return exe;
    const asset = HELPER.assets[`${process.platform}-${process.arch}`];
    if (!asset) throw new Error(`WireGuard isn't available on ${process.platform} ${process.arch} yet`);
    if (fetching) return fetching;
    fetching = (async () => {
        log(`Downloading the WireGuard helper (wireproxy ${HELPER.version}, ${asset.file})`);
        const buf = await download(HELPER.base + asset.file);
        const sum = crypto.createHash('sha256').update(buf).digest('hex');
        if (sum !== asset.sha256) throw new Error('the downloaded WireGuard helper did not match its checksum — not used');
        const bin = untarOne(zlib.gunzipSync(buf), BIN);
        if (!bin) throw new Error('the WireGuard helper archive had no ' + BIN);
        fs.mkdirSync(path.dirname(exe), { recursive: true });
        fs.writeFileSync(exe + '.part', bin, { mode: 0o755 });
        fs.renameSync(exe + '.part', exe);
        log('WireGuard helper ready (checksum ok)');
        return exe;
    })().finally(() => { fetching = null; });
    return fetching;
}

const freePort = () => new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const portOpen = (port) => new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1');
    c.once('connect', () => { c.destroy(); resolve(true); });
    c.once('error', () => resolve(false));
});

// Runs one config: { port, stop(), onExit(fn) }. The config file exists only until the helper is listening.
async function startTunnel({ exe, dir, id, conf }) {
    if (exe === 'test-helper') { const exitFns = []; return { port: +process.env.ZSB_WG_TEST_PORT, stop: () => exitFns.forEach(f => f(0, '')), onExit: (f) => exitFns.push(f), lastErr: '' }; }
    const port = await freePort();
    const file = path.join(dir, `wg-${id}.conf`);
    fs.writeFileSync(file, `${conf}\n\n[Socks5]\nBindAddress = 127.0.0.1:${port}\n`, { mode: 0o600 });
    const child = spawn(exe, ['-c', file], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let lastErr = '', exited = false;
    const exitFns = [];
    // The helper logs a lot (DEBUG lines); the last other line is the reason it gives when it stops.
    child.stderr.on('data', (d) => { const l = String(d).split(/\r?\n/).map(x => x.trim()).filter(x => x && !/^DEBUG/.test(x)).pop(); if (l) lastErr = l.slice(0, 160); });
    child.on('exit', (code) => { exited = true; try { fs.unlinkSync(file); } catch (_) {} for (const f of exitFns) f(code, lastErr); });
    const until = Date.now() + 15000;
    while (Date.now() < until && !exited && !(await portOpen(port))) await new Promise(r => setTimeout(r, 300));
    try { fs.unlinkSync(file); } catch (_) {}
    if (exited || !(await portOpen(port))) { try { child.kill(); } catch (_) {} throw new Error('the WireGuard helper did not start' + (lastErr ? ': ' + lastErr : '')); }
    return { port, stop: () => { try { child.kill(); } catch (_) {} }, onExit: (f) => exitFns.push(f), get lastErr() { return lastErr; } };
}

module.exports = { parseWireGuard, ensureHelper, startTunnel, HELPER, untarOne };
