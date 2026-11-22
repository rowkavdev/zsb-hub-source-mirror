/**
 * EXTRA IPs ON THIS COMPUTER for the Proxy manager
 *
 * A VPS can have more than one public IPv4 address (a provider's "additional IPs"). The site allows 20 clicking
 * accounts per IP, so each one is room for 20 more. The browser engine can't be told which local address to send from,
 * so each extra IP gets a small relay here: a SOCKS5 proxy on 127.0.0.1 (local only, no password) that opens every
 * connection from that IP. The relay's address becomes the route, like a WireGuard helper's. No download, no Squid.
 *
 * Only public IPv4 addresses count: private ones (home routers, VPN and virtual adapters) aren't separate exit IPs.
 * The relay only connects to ports 80 and 443 (the site and its check), nothing else.
 */

const net = require('net');
const os = require('os');

// Private, shared, loopback, link-local and other non-public IPv4 ranges.
const PRIVATE = [/^10\./, /^127\./, /^0\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^192\.0\.0\./, /^198\.1[89]\./, /^2(2[4-9]|[3-5]\d)\./];
const isPublic = (ip) => net.isIPv4(ip) && !PRIVATE.some(r => r.test(ip));

// This computer's public IPv4 addresses: [{ ip, iface }]. ZSB_LOCALIPS_TEST (comma separated) stands in for them in tests.
function listLocalIps(interfaces = os.networkInterfaces()) {
    if (process.env.ZSB_LOCALIPS_TEST) return process.env.ZSB_LOCALIPS_TEST.split(',').map(ip => ({ ip: ip.trim(), iface: 'test' }));
    const out = [], seen = new Set();
    for (const [iface, list] of Object.entries(interfaces || {})) {
        for (const a of list || []) {
            const family = a.family === 4 ? 'IPv4' : a.family;
            if (family !== 'IPv4' || a.internal || !isPublic(a.address) || seen.has(a.address)) continue;
            seen.add(a.address); out.push({ ip: a.address, iface });
        }
    }
    return out;
}

// A SOCKS5 relay on 127.0.0.1 whose connections leave from `ip`. { port, stop() }.
function startRelay(ip, { ports = [80, 443], connectMs = 15000 } = {}) {
    const open = new Set();
    const server = net.createServer((c) => {
        open.add(c);
        c.on('close', () => open.delete(c));
        c.on('error', () => {});
        let buf = Buffer.alloc(0), step = 'hello', out = null;
        const reply = (code) => { try { c.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0])); } catch (_) {} };
        const onData = (d) => {
            buf = Buffer.concat([buf, d]);
            if (step === 'hello') {
                if (buf.length < 2) return;
                if (buf[0] !== 5) return c.destroy();
                const n = buf[1];
                if (buf.length < 2 + n) return;
                const methods = buf.subarray(2, 2 + n);
                buf = buf.subarray(2 + n);
                if (!methods.includes(0)) { c.end(Buffer.from([5, 0xff])); return; }   // no password here: it's local only
                c.write(Buffer.from([5, 0]));
                step = 'request';
            }
            if (step === 'request') {
                if (buf.length < 4) return;
                if (buf[0] !== 5 || buf[1] !== 1) return reply(7);   // CONNECT only
                let host, at;
                if (buf[3] === 1) { if (buf.length < 10) return; host = [...buf.subarray(4, 8)].join('.'); at = 8; }
                else if (buf[3] === 3) { const len = buf[4]; if (buf.length < 5 + len + 2) return; host = buf.subarray(5, 5 + len).toString(); at = 5 + len; }
                else return reply(8);   // IPv6 targets can't leave from an IPv4 address
                const port = buf.readUInt16BE(at);
                const rest = buf.subarray(at + 2);
                step = 'connecting';
                c.removeListener('data', onData);
                if (!ports.includes(port)) return reply(2);
                let connected = false;
                out = net.connect({ host, port, localAddress: ip, family: 4 });
                const t = setTimeout(() => { reply(4); out.destroy(); }, connectMs);
                out.once('connect', () => {
                    clearTimeout(t); connected = true;
                    c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
                    if (rest.length) out.write(rest);
                    out.pipe(c); c.pipe(out);
                });
                // Before it connects, a SOCKS5 failure answer (1: this address can't be used here, 5: refused);
                // after, the browser's connection just closes too.
                out.on('error', (e) => { clearTimeout(t); if (connected) c.destroy(); else reply(e.code === 'EADDRNOTAVAIL' ? 1 : 5); });
                out.on('close', () => { if (connected) c.destroy(); });
                c.on('close', () => out.destroy());
            }
        };
        c.on('data', onData);
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve({
                port: server.address().port,
                stop() { try { server.close(); } catch (_) {} for (const c of open) c.destroy(); open.clear(); },
            });
        });
    });
}

module.exports = { listLocalIps, startRelay, isPublic };
