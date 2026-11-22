/**
 * PROXY MANAGER
 *
 * Gives the core network routes (ctx.network.setRoutes): one per proxy. The site allows 20 clicking accounts per exit
 * IP, so every proxy (and this PC's own connection) holds 20; the core spreads accounts over them by itself and keeps
 * each on its route, unless it's pinned to one here. A proxy that stops working pauses its accounts (CC-PROXY-01/02,
 * from the core) until a request through it works again.
 *
 * Exit IPs come from Cloudflare's trace on the site's own domain (/cdn-cgi/trace through the proxy), so no third party
 * sees anything. Two proxies with the same exit IP share their 20.
 *
 * WireGuard configs (pasted whole, one or more) work too: each runs in its own local helper (wireguard.js) that offers
 * the tunnel as a SOCKS5 proxy on 127.0.0.1, and that becomes the route.
 *
 * Extra IPs on this computer (a VPS's additional IPs): "Use this server's extra IPs" finds its public IPv4 addresses
 * besides the one it already uses, and each gets a local relay (localips.js) that sends from that address.
 *
 * Accepted (one per line or comma separated): host:port, host:port:user:pass, user:pass@host:port, user:pass:host:port,
 * http(s)://[user:pass@]host:port, socks5://host:port. SOCKS5 with a password can't work here (the browser engine
 * doesn't support it) and is turned away with a reason.
 */

const crypto = require('crypto');
const wg = require('./wireguard');
const lip = require('./localips');

let ctx = null;
let state = null;            // saved: { proxies: [{ id, label, scheme, host, port, user, pass, ip, ms, ok, error, at }], directIp }
let checking = false;
let picked = null;           // the proxy picked in the list (its details and buttons show below it)
const tunnels = new Map();   // WireGuard entry id -> running helper { port, stop }
const relays = new Map();    // extra-IP entry id -> running relay { port, stop }
let stopping = false;

const S = (k) => ctx.settings.get(k);
// On disk the passwords and WireGuard configs (their keys) are sealed (ctx.secrets: the system keychain), never plain.
const save = () => ctx.data.set({ ...state, proxies: state.proxies.map(({ pass, conf, ...p }) => ({ ...p, sealed: pass ? ctx.secrets.seal(pass) : '', ...(conf ? { sealedConf: ctx.secrets.seal(conf) } : {}) })) });
const load = (saved) => ({ ...saved, proxies: (saved.proxies || []).map(({ sealed, sealedConf, pass, ...p }) => ({ ...p, pass: sealed ? ctx.secrets.unseal(sealed) || '' : pass || '', ...(sealedConf ? { conf: ctx.secrets.unseal(sealedConf) || '' } : {}) })) });
const HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\]|[a-z0-9-]+(?:\.[a-z0-9-]+)+|localhost)$/i;
const PORT = /^\d{1,5}$/;
const okPort = (p) => PORT.test(p) && +p > 0 && +p < 65536;

// One proxy from one piece of text: { scheme, host, port, user, pass } or { error }.
function parseOne(raw) {
    let s = String(raw || '').trim();
    if (!s) return null;
    let scheme = 'http';
    const m = /^([a-z0-9]+):\/\//i.exec(s);
    if (m) {
        const sc = m[1].toLowerCase();
        if (sc === 'socks5' || sc === 'socks5h' || sc === 'socks') scheme = 'socks5';
        else if (sc !== 'http' && sc !== 'https') return { error: `"${sc}" proxies aren't supported (HTTP or SOCKS5 only)` };
        s = s.slice(m[0].length);
    }
    s = s.replace(/\/+$/, '');
    let user = '', pass = '', host = '', port = '';
    if (s.includes('@')) {
        const at = s.lastIndexOf('@');
        const cred = s.slice(0, at), addr = s.slice(at + 1);
        const c = cred.indexOf(':');
        user = c < 0 ? cred : cred.slice(0, c); pass = c < 0 ? '' : cred.slice(c + 1);
        [host, port] = addr.split(':');
    } else {
        const parts = s.split(':');
        if (parts.length === 2) [host, port] = parts;
        else if (parts.length >= 4) {
            // host:port:user:pass, or user:pass:host:port — whichever side has the address.
            if (HOST.test(parts[0]) && okPort(parts[1])) { host = parts[0]; port = parts[1]; user = parts[2]; pass = parts.slice(3).join(':'); }
            else if (HOST.test(parts[parts.length - 2]) && okPort(parts[parts.length - 1])) {
                host = parts[parts.length - 2]; port = parts[parts.length - 1]; user = parts[0]; pass = parts.slice(1, -2).join(':');
            } else return { error: 'can\'t tell the address from the login' };
        } else return { error: 'needs at least host:port' };
    }
    if (!HOST.test(host || '')) return { error: `"${host || ''}" isn't a host name or IP` };
    if (!okPort(port || '')) return { error: `"${port || ''}" isn't a port` };
    if (scheme === 'socks5' && (user || pass)) return { error: 'SOCKS5 with a password can\'t be used here — use the HTTP address of the proxy, or a SOCKS5 that allows your IP' };
    return { scheme, host: host.toLowerCase(), port: +port, user, pass };
}

// A VPN config pasted by mistake (WireGuard / OpenVPN): turned away as a whole, never read as proxies — its Endpoint line
// would otherwise look like host:port, and its keys must not be shown back.
const VPN_CONFIG = /^\s*\[(Interface|Peer)\]\s*$|^\s*(PrivateKey|PublicKey|PresharedKey|AllowedIPs|Endpoint)\s*=|^\s*(client|remote|<ca>|auth-user-pass)\b/im;
const isWireGuard = (text) => /^\s*\[Interface\]\s*$/im.test(String(text || ''));

// A pasted block: one entry per line, or several on a line separated by commas, semicolons or spaces. Comment lines
// (#, //, ;) and "key = value" lines are not proxies and are left out quietly. { found: [...], skipped: [{ text, why }] }.
function parse(text) {
    const found = [], skipped = [], seen = new Set();
    text = String(text || '');
    if (VPN_CONFIG.test(text)) {
        const wg = /\[(Interface|Peer)\]|PrivateKey\s*=/i.test(text);
        return { found, skipped: [{ text: wg ? 'WireGuard config' : 'VPN config', why: wg
            ? 'part of a WireGuard config — paste the whole config, from [Interface] down to its [Peer] Endpoint'
            : 'this is a VPN config, not a proxy — the Proxy manager takes HTTP or SOCKS5 proxies (host:port, with or without user:pass)' }] };
    }
    const pieces = text.split(/\r?\n/).filter(l => l.trim() && !/^\s*(#|\/\/|;)/.test(l) && !/^\s*[\w.-]+\s*=\s*/.test(l)).flatMap(l => l.split(/[,;\s]+/));
    for (const piece of pieces) {
        const p = parseOne(piece);
        if (!p) continue;
        if (p.error) { skipped.push({ text: mask(piece), why: p.error }); continue; }
        const key = `${p.scheme}|${p.host}|${p.port}|${p.user}`;
        if (seen.has(key)) { skipped.push({ text: mask(piece), why: 'listed twice' }); continue; }
        seen.add(key); found.push(p);
    }
    return { found, skipped };
}
// Never show a password: "user:••••@host:port".
function mask(text) {
    const m = /^([a-z0-9]+:\/\/)?(.*)$/i.exec(String(text)), sc = m[1] || '', rest = m[2];
    if (rest.includes('@')) {
        const at = rest.lastIndexOf('@'), cred = rest.slice(0, at), c = cred.indexOf(':');
        return sc + (c < 0 ? cred : cred.slice(0, c) + ':••••') + rest.slice(at);
    }
    const parts = rest.split(':');
    if (parts.length >= 4) {
        if (HOST.test(parts[0]) && okPort(parts[1])) return sc + parts.slice(0, 3).join(':') + ':••••';
        return sc + parts[0] + ':••••:' + parts.slice(-2).join(':');
    }
    return sc + rest;
}
const show = (p) => p.kind === 'wg' ? `WireGuard · ${p.endpoint}` : p.kind === 'local' ? `this computer's ${p.localIp}` : `${p.scheme === 'socks5' ? 'socks5://' : ''}${p.user ? p.user + ':••••@' : ''}${p.host}:${p.port}`;
const idOf = (p) => 'p' + crypto.createHash('sha1').update(`${p.scheme}|${p.host}|${p.port}|${p.user}`).digest('hex').slice(0, 8);

// A WireGuard or extra-IP entry is a route only while its helper or relay runs (its local SOCKS5 port).
const localPort = (p) => p.kind === 'wg' ? (tunnels.get(p.id) || {}).port : p.kind === 'local' ? (relays.get(p.id) || {}).port : null;
const usable = (p) => (p.kind !== 'wg' && p.kind !== 'local') || !!localPort(p);
function publish() {
    ctx.network.setRoutes(state.proxies.filter(usable).map(p => ({ id: p.id, label: p.label, ip: p.ip || null,
        proxy: p.kind === 'wg' || p.kind === 'local' ? { scheme: 'socks5', host: '127.0.0.1', port: localPort(p) } : { scheme: p.scheme, host: p.host, port: p.port, user: p.user, pass: p.pass } })));
    const opts = [{ value: 'auto', label: 'Auto (spread)' }, { value: 'direct', label: 'This PC\'s connection' }, ...state.proxies.map(p => ({ value: p.id, label: `${p.label}${p.ip ? ' · ' + p.ip : ''}` }))];
    ctx.settings.setOptions('pinRoute', opts);
}

// Every WireGuard entry's helper running; one that stops is started again after a pause (5 s, then longer).
async function startTunnels() {
    const todo = state.proxies.filter(p => p.kind === 'wg' && p.conf && !tunnels.has(p.id) && !p.starting && Date.now() >= (p.retryAt || 0));
    if (!todo.length) return;
    let exe;
    try { exe = await wg.ensureHelper(ctx.dir, (m) => ctx.log(m)); }
    catch (e) { for (const p of todo) Object.assign(p, { ok: false, error: e.message, retryAt: Date.now() + 10 * 60000 }); ctx.log('WireGuard: ' + e.message, 'warn'); save(); return; }
    for (const p of todo) {
        p.starting = true;
        try {
            const t = await wg.startTunnel({ exe, dir: ctx.dir, id: p.id, conf: p.conf });
            if (stopping) { t.stop(); break; }
            tunnels.set(p.id, t); p.fails = 0; p.error = null;
            t.onExit((code, err) => {
                tunnels.delete(p.id);
                if (stopping || !state.proxies.includes(p)) return;   // turned off, or removed: not a failure
                p.fails = (p.fails || 0) + 1; p.ok = false; p.error = 'the WireGuard helper stopped' + (err ? ': ' + err : '');
                p.retryAt = Date.now() + Math.min(10 * 60000, 5000 * 2 ** Math.min(7, p.fails));
                ctx.log(`${p.label}: ${p.error} — trying again shortly`, 'warn');
                publish(); save();
            });
            ctx.log(`${p.label}: WireGuard tunnel up (local SOCKS5 on port ${t.port})`, 'ok');
        } catch (e) {
            p.fails = (p.fails || 0) + 1; p.ok = false; p.error = e.message; p.retryAt = Date.now() + Math.min(10 * 60000, 5000 * 2 ** Math.min(7, p.fails));
            ctx.log(`${p.label}: ${e.message}`, 'warn');
        } finally { p.starting = false; }
    }
    publish(); save();
    testAll();
}

// Every extra-IP entry's relay running. One that can't start is tried again later.
async function startRelays() {
    const todo = state.proxies.filter(p => p.kind === 'local' && !relays.has(p.id) && !p.starting && Date.now() >= (p.retryAt || 0));
    if (!todo.length) return;
    for (const p of todo) {
        p.starting = true;
        try {
            const r = await lip.startRelay(p.localIp);
            if (stopping) { r.stop(); break; }
            relays.set(p.id, r); p.error = null;
        } catch (e) {
            Object.assign(p, { ok: false, error: e.message, retryAt: Date.now() + 5 * 60000 });
            ctx.log(`${p.label}: ${e.message}`, 'warn');
        } finally { p.starting = false; }
    }
    publish(); save();
    testAll();
}

// "Use this server's extra IPs": every public IPv4 address on this computer's adapters, except the one it already
// clicks from and ones already added, becomes an entry with its own relay.
async function addLocalIps() {
    const d = await ctx.network.probe('direct');
    if (d.ok) state.directIp = d.ip;
    const all = lip.listLocalIps();
    if (!all.length) return { ok: false, error: 'This computer has no public IP address on its network adapters (normal for a home PC behind a router). On a VPS, an additional IP has to be added to the server\'s network interface first (your provider\'s guide shows how), then press this again.' };
    const fresh = all.filter(a => a.ip !== state.directIp && !state.proxies.some(p => p.kind === 'local' && p.localIp === a.ip));
    if (!fresh.length) {
        return all.length === 1 && all[0].ip === state.directIp
            ? { ok: false, error: `This computer has one public IP (${all[0].ip}), and it's already This PC's connection. An additional IP has to be added to the server's network interface first (your provider's guide shows how).` }
            : { message: 'Every extra IP on this computer is already in the list.' };
    }
    let n = state.proxies.filter(p => p.kind === 'local').length;
    for (const a of fresh) {
        state.proxies.push({ id: 'l' + crypto.createHash('sha1').update('local|' + a.ip).digest('hex').slice(0, 8), kind: 'local', label: `Extra IP ${++n}`, localIp: a.ip, ip: null, ok: null, error: null, at: 0 });
    }
    save();
    await startRelays();
    return { message: `Added ${fresh.length} extra IP${fresh.length === 1 ? '' : 's'} (${fresh.map(a => a.ip).join(', ')}) — testing ${fresh.length === 1 ? 'it' : 'them'} now. Each one is room for ${ctx.network.state().maxPerIp} more accounts.` };
}

// Every proxy's exit IP and speed (and this PC's), a few at a time.
async function testAll() {
    if (checking) return;
    checking = true;
    try {
        const d = await ctx.network.probe('direct');
        if (d.ok) state.directIp = d.ip;
        let changed = false;
        for (let i = 0; i < state.proxies.length; i += 4) {
            await Promise.all(state.proxies.slice(i, i + 4).filter(usable).map(async (p) => {
                const r = await ctx.network.probe(p.id);
                if (r.ok && p.ip !== r.ip) changed = true;
                Object.assign(p, r.ok ? { ok: true, ip: r.ip, ms: r.ms, error: null } : { ok: false, error: r.error }, { at: Date.now() });
            }));
        }
        save();
        if (changed) publish();   // exit IPs decide which proxies share their 20
    } finally { checking = false; }
}

function addPasted() {
    // WireGuard configs: each one becomes an entry with its own helper.
    if (isWireGuard(S('paste'))) {
        const { found, skipped } = wg.parseWireGuard(S('paste'));
        let added = 0;
        for (const c of found) {
            const id = 'w' + crypto.createHash('sha1').update(c.publicKey + '|' + c.endpoint).digest('hex').slice(0, 8);
            if (state.proxies.some(x => x.id === id)) { skipped.push({ text: c.label, why: 'already added' }); continue; }
            state.proxies.push({ id, kind: 'wg', label: c.name ? c.name.slice(0, 40) : c.label, endpoint: c.endpoint, conf: c.conf, ip: null, ok: null, error: null, at: 0 });
            added++;
        }
        state.lastSkipped = skipped.slice(0, 20);
        save();
        ctx.settings.set('paste', '');   // the keys don't stay in the box
        if (added) startTunnels();
        return added || skipped.length
            ? { message: `Added ${added} WireGuard config${added === 1 ? '' : 's'}${skipped.length ? ` · skipped ${skipped.length} (see below)` : ''}${added ? ' — starting the tunnel (the first time, the helper is downloaded: ~4 MB)' : ''}.` }
            : { ok: false, error: 'No WireGuard config found.' };
    }
    const { found, skipped } = parse(S('paste'));
    let added = 0;
    for (const p of found) {
        const id = idOf(p);
        if (state.proxies.some(x => x.id === id)) { skipped.push({ text: show(p), why: 'already added' }); continue; }
        state.proxies.push({ id, label: `Proxy ${state.proxies.length + 1}`, ...p, ip: null, ok: null, error: null, at: 0 });
        added++;
    }
    state.lastSkipped = skipped.slice(0, 20);
    save();
    ctx.settings.set('paste', '');   // the passwords don't stay in the box
    if (added) { publish(); testAll(); }
    return added || skipped.length
        ? { message: `Added ${added} prox${added === 1 ? 'y' : 'ies'}${skipped.length ? ` · skipped ${skipped.length} (see below)` : ''}${added ? ' — testing them now' : ''}.` }
        : { ok: false, error: 'Nothing to add — paste proxies first.' };
}

module.exports = {
    parse, parseOne, mask,
    start(c) {
        ctx = c;
        const saved = ctx.data.get() || {};
        state = load({ proxies: [], directIp: null, lastSkipped: [], ...saved });
        if ((saved.proxies || []).some(x => x.pass)) save();   // an older file with plain passwords: sealed now
        stopping = false;
        publish();
        setTimeout(testAll, 1500);
        startTunnels();
        startRelays();
        ctx.every(5000, () => { startTunnels(); startRelays(); });
        ctx.every(60000, () => { if (Date.now() - (state.testedAt || 0) >= Math.max(2, num(S('checkEveryMin'))) * 60000) { state.testedAt = Date.now(); testAll(); } });
        ctx.panel.action('add', () => addPasted());
        ctx.panel.action('localips', () => addLocalIps());
        ctx.panel.action('test', () => { testAll(); return { message: 'Testing every proxy — results show up here in a moment.' }; });
        ctx.panel.action('pick', (id) => { picked = picked === id ? null : String(id); return { ok: true }; });
        ctx.panel.action('remove', () => {
            const p = state.proxies.find(x => x.id === picked);
            if (!p) return { ok: false, error: 'Pick a proxy first.' };
            state.proxies = state.proxies.filter(x => x !== p); picked = null; save();
            if (tunnels.has(p.id)) { const t = tunnels.get(p.id); tunnels.delete(p.id); t.stop(); }
            if (relays.has(p.id)) { const t = relays.get(p.id); relays.delete(p.id); t.stop(); }
            for (const a of ctx.network.state().accounts) if (a.pin === p.id) ctx.network.pin(a.id, null);
            publish();
            return { message: `Removed ${p.label}; its accounts move to another route.` };
        });
        // Pins every ticked account (a folder's name ticks the whole folder) to one route, or back to automatic.
        ctx.panel.action('pin', () => {
            const pick = S('pinAccounts') || {}, rid = S('pinRoute');
            const net = ctx.network.state();
            const ids = pick.all ? net.accounts.map(a => a.id) : (pick.ids || []).filter(id => net.accounts.some(a => a.id === id));
            if (!ids.length) return { ok: false, error: 'Tick some accounts (or a folder) first.' };
            if (!rid) return { ok: false, error: 'Pick where they go through.' };
            for (const aid of ids) { const r = ctx.network.pin(aid, rid === 'auto' ? null : rid); if (!r.ok) return r; }
            const one = ids.length === 1, who = one ? (ctx.accounts.get(ids[0]) || {}).name || ids[0] : `${ids.length} accounts`;
            if (rid === 'auto') return { message: `${who} ${one ? 'is' : 'are'} spread automatically again.` };
            const where = rid === 'direct' ? 'this PC\'s connection' : (state.proxies.find(x => x.id === rid) || {}).label || rid;
            // The site allows maxPerIp clicking per exit IP: say so when more are pinned there than can click.
            const after = ctx.network.state(), groupOf = (id) => (after.routes.find(r => r.id === id) || {}).group;
            const there = after.accounts.filter(a => a.pin && groupOf(a.pin) === groupOf(rid)).length;
            const over = there > after.maxPerIp ? ` ${there} accounts are pinned there and ${after.maxPerIp} can click at once, so the rest wait for a slot.` : '';
            return { message: `${who} now go${one ? 'es' : ''} through ${where}.${over}` };
        });

        ctx.panel.tab('Proxies', () => {
            const net = ctx.network.state();
            const routeOf = new Map(net.routes.map(r => [r.id, r]));
            const label = (rid) => rid === 'direct' ? 'This PC' : (state.proxies.find(x => x.id === rid) || {}).label || rid || '—';
            const sameIp = (p) => p.ip && state.proxies.filter(x => x.ip === p.ip).length > 1;
            // Same exit IP as this PC's own: a VPS extra IP that isn't on the server falls back to the main one.
            const sameAsDirect = (p) => p.ip && p.ip === state.directIp;
            const items = [
                { id: 'direct', title: 'This PC\'s connection', sub: state.directIp ? `exit IP ${state.directIp}` : 'exit IP not known yet', meta: `${(routeOf.get('direct') || {}).used || 0} / ${net.maxPerIp} accounts`, on: picked === 'direct' },
                ...state.proxies.map(p => {
                    const r = routeOf.get(p.id) || {};
                    const status = r.down ? 'not working — its accounts wait' : p.kind === 'wg' && !tunnels.has(p.id) ? (p.error ? `tunnel down: ${p.error}` : 'starting the tunnel…')
                        : p.kind === 'local' && !relays.has(p.id) ? (p.error ? `can't send from ${p.localIp}: ${p.error}` : 'starting…')
                        : p.ok === false ? `failed the test: ${p.error}${p.kind === 'local' ? ` (is ${p.localIp} still set up on this server?)` : ''}` : p.ok ? `works · ${p.ms} ms` : 'not tested yet';
                    return { id: p.id, title: p.label, sub: `${show(p)}${p.ip ? ` → ${p.ip}` : ''}${sameAsDirect(p) ? ` (same exit IP as this PC's connection: they share ${net.maxPerIp}${p.kind === 'local' || p.host === '127.0.0.1' ? ' — is its extra IP set up on the server?' : ''})` : sameIp(p) ? ` (same exit IP as another proxy: they share ${net.maxPerIp})` : ''}`,
                        meta: `${r.used || 0} / ${net.maxPerIp} accounts · ${status}`, on: picked === p.id };
                }),
            ];
            const sel = state.proxies.find(x => x.id === picked);
            const working = state.proxies.filter(p => p.ok && !(routeOf.get(p.id) || {}).down).length;
            const room = net.maxPerIp * (1 + new Set(state.proxies.filter(p => p.ok && !sameAsDirect(p)).map(p => p.ip || p.id)).size);
            const rows = net.accounts.map(a => [a.name, a.running ? label(a.route) : 'not clicking', a.pin ? 'pinned' : 'auto']);
            return { blocks: [
                { type: 'stats', items: [
                    { label: 'Proxies working', value: `${working} / ${state.proxies.length}` },
                    { label: 'Room for', value: `${room} accounts` },
                    { label: 'Clicking', value: String(net.accounts.filter(a => a.running).length) },
                ] },
                { type: 'card', id: 'routes', open: true, title: 'Routes', summary: `${state.proxies.length} prox${state.proxies.length === 1 ? 'y' : 'ies'} + this PC`,
                    blocks: [
                        { type: 'picker', action: 'pick', items },
                        ...(sel ? [{ type: 'buttons', items: [{ label: 'Test all', action: 'test' }, { label: `Remove ${sel.label}`, action: 'remove', danger: true, confirm: `Remove ${sel.label}? Its accounts move to another route (or wait, if every route is full).` }] }]
                            : [{ type: 'buttons', items: [{ label: 'Test all', action: 'test' }] }]),
                    ] },
                { type: 'card', id: 'add', open: !state.proxies.length, title: 'Add proxies', summary: 'paste a list — any common format', keys: ['paste'],
                    blocks: [
                        { type: 'buttons', items: [{ label: 'Add', action: 'add', primary: true }, { label: 'Use this server\'s extra IPs', action: 'localips' }] },
                        { type: 'text', text: 'A VPS with additional IPs: once they\'re set up on the server\'s network interface, "Use this server\'s extra IPs" adds each one as a route of its own (20 more accounts per IP, no proxy software needed).' },
                        ...((state.lastSkipped || []).length ? [{ type: 'table', wrap: true, columns: ['Skipped', 'Why'], rows: state.lastSkipped.map(x => [x.text, x.why]) }] : []),
                    ] },
                { type: 'card', id: 'accounts', open: false, title: 'Accounts', summary: `spread by themselves, 20 per exit IP · ${net.accounts.filter(a => a.pin).length} pinned`, keys: ['pinAccounts', 'pinRoute'],
                    blocks: [
                        { type: 'buttons', items: [{ label: 'Apply', action: 'pin' }] },
                        ...(rows.length ? [{ type: 'table', columns: ['Account', 'Goes through', 'How'], rows }] : []),
                    ] },
                { type: 'card', id: 'schedule', open: false, title: 'Testing', summary: `every ${Math.max(2, num(S('checkEveryMin')))} min`, keys: ['checkEveryMin'] },
            ] };
        });
        ctx.panel.badge((aid) => {
            const a = ctx.network.state().accounts.find(x => x.id === aid);
            return a && a.running && a.route && a.route !== 'direct' ? 'via ' + ((state.proxies.find(x => x.id === a.route) || {}).label || a.route) : null;
        });
    },
    stop() { picked = null; stopping = true; for (const t of tunnels.values()) t.stop(); tunnels.clear(); for (const r of relays.values()) r.stop(); relays.clear(); },
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
