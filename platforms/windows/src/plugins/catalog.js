/**
 * PLUGIN CATALOG
 *
 * The list of plugins anyone can install, kept in the public releases repo (package.json
 * pluginCatalogUrl points at its folder):
 *   catalog.json       { format: 1, updatedAt, plugins: [{ id, name, version, description, minCore, file, sha256, size }] }
 *   catalog.json.sig   ed25519 signature of catalog.json's exact bytes, base64
 *   <file>             one plugin: { format: 1, id, version, files: { "plugin.json": base64, ..., "plugin.sig": base64 } }
 *
 * Both are signed with the release key (tools/publish-plugins.js). Nothing is trusted on the way:
 * the catalog's signature is checked, the bundle must match the catalog's sha256, and the unpacked
 * folder must carry a plugin.sig the host accepts — the same check as any installed plugin.
 *
 * Installing writes the folder to <data>/plugins/<id>. A copy there that's newer than the one
 * built into the app wins (host.scan), so this is also how built-in plugins get fixes without a
 * new app release. Nothing updates by itself: the panel shows "Update" and the user presses it.
 *
 * Errors come back as codes (catalog / download / sha / signature / format / mincore / not-found),
 * the panel words them (plugins.err.<code>).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { verify, newer } = require('./host');

const EVERY_MS = 6 * 60 * 60 * 1000;
const MAX_BYTES = 5 * 1024 * 1024;

class Catalog {
    constructor({ host, url, publicKey, log, fetch: fetchFn = globalThis.fetch }) {
        Object.assign(this, { host, url: url ? url.replace(/\/?$/, '/') : null, publicKey, log, fetch: fetchFn });
        this.entries = [];
        this.checkedAt = 0;
        this.error = null;
        this.busy = null;
        this.timer = null;
    }

    get available() { return !!(this.url && this.publicKey); }

    start() {
        if (!this.available) return;
        this.refresh();
        this.timer = setInterval(() => this.refresh(), EVERY_MS);
        if (this.timer.unref) this.timer.unref();
    }

    stop() { clearInterval(this.timer); this.timer = null; }

    async get(name) {
        const res = await this.fetch(this.url + name, { cache: 'no-store' });
        if (!res.ok) throw Object.assign(new Error(`${name}: HTTP ${res.status}`), { code: 'download' });
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_BYTES) throw Object.assign(new Error(`${name}: too big`), { code: 'format' });
        return buf;
    }

    // Fetch and check the list. One at a time; a second call waits for the first.
    refresh() {
        if (!this.available) return Promise.resolve({ ok: false, code: 'catalog' });
        if (this.busy) return this.busy;
        this.busy = (async () => {
            try {
                const [body, sig] = await Promise.all([this.get('catalog.json'), this.get('catalog.json.sig')]);
                if (!crypto.verify(null, body, crypto.createPublicKey(this.publicKey), Buffer.from(sig.toString('utf8').trim(), 'base64'))) {
                    throw Object.assign(new Error('catalog signature does not match'), { code: 'signature' });
                }
                const cat = JSON.parse(body.toString('utf8'));
                if (cat.format !== 1 || !Array.isArray(cat.plugins)) throw Object.assign(new Error('unknown catalog format'), { code: 'format' });
                this.entries = cat.plugins.filter(e => e && /^[a-z0-9-]+$/.test(e.id) && e.version && e.file && e.sha256);
                this.error = null;
                return { ok: true };
            } catch (e) {
                this.error = { code: e.code || 'catalog', msg: e.message };
                this.log.add(null, 'Plugin list: ' + e.message, 'warn');
                return { ok: false, code: this.error.code };
            } finally {
                this.checkedAt = Date.now();
                this.busy = null;
                this.host.engine.emit('change');
            }
        })();
        return this.busy;
    }

    // Download, check and install (or update) one plugin, then start it again if it's turned on.
    async install(id) {
        const e = this.entries.find(x => x.id === id);
        if (!e) return { ok: false, code: 'not-found' };
        if (e.minCore && newer(e.minCore, this.host.coreVersion)) return { ok: false, code: 'mincore', minCore: e.minCore };
        const root = this.host.userDir, dir = path.join(root, id), tmp = dir + '.new', old = dir + '.old';
        try {
            const buf = await this.get(e.file);
            if (crypto.createHash('sha256').update(buf).digest('hex') !== e.sha256) throw Object.assign(new Error('download does not match the list'), { code: 'sha' });
            const b = JSON.parse(buf.toString('utf8'));
            if (b.format !== 1 || b.id !== id || b.version !== e.version || !b.files || typeof b.files !== 'object') throw Object.assign(new Error('not a plugin bundle'), { code: 'format' });

            fs.rmSync(tmp, { recursive: true, force: true });
            for (const [rel, data] of Object.entries(b.files)) {
                // Only plain relative paths inside the plugin's folder.
                const parts = rel.split('/');
                if (!rel || rel.startsWith('/') || parts.some(x => !x || x === '.' || x === '..' || /[\\:]/.test(x))) throw Object.assign(new Error('bad file name in bundle'), { code: 'format' });
                const f = path.join(tmp, ...parts);
                fs.mkdirSync(path.dirname(f), { recursive: true });
                fs.writeFileSync(f, Buffer.from(String(data), 'base64'));
            }
            let manifest;
            try { manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'plugin.json'), 'utf8')); } catch (_) { throw Object.assign(new Error('bundle has no plugin.json'), { code: 'format' }); }
            if (manifest.id !== id || manifest.version !== e.version) throw Object.assign(new Error('bundle is a different plugin'), { code: 'format' });
            if (!verify(tmp, this.publicKey)) throw Object.assign(new Error('not signed by the release key'), { code: 'signature' });

            // Swap folders: the old copy stays until the new one is in place.
            fs.rmSync(old, { recursive: true, force: true });
            const had = this.host.plugins.get(id);
            if (had && had.state === 'running' && had.dir === dir) this.host.stopPlugin(id);
            if (fs.existsSync(dir)) fs.renameSync(dir, old);
            fs.renameSync(tmp, dir);
            fs.rmSync(old, { recursive: true, force: true });
        } catch (err) {
            fs.rmSync(tmp, { recursive: true, force: true });
            this.log.add(null, `Plugin ${e.name || id} ${e.version} not installed: ${err.message}`, 'error');
            return { ok: false, code: err.code || 'download' };
        }
        this.host.scan();
        this.log.add(null, `Plugin ${e.name || id} ${e.version} installed`, 'ok');
        const r = this.host.startIfEnabled(id);
        this.host.engine.emit('change');
        return { ok: true, started: r.ok };
    }

    // Remove a downloaded copy. A built-in plugin goes back to the version inside the app.
    remove(id) {
        const p = this.host.plugins.get(id);
        if (!p || p.bundled) return { ok: false, code: 'not-found' };
        this.host.stopPlugin(id);
        fs.rmSync(p.dir, { recursive: true, force: true });
        this.host.scan();
        this.host.startIfEnabled(id);
        this.log.add(null, `Plugin ${p.manifest.name || id} removed`);
        this.host.engine.emit('change');
        return { ok: true };
    }

    // What the panel shows: the list, with what's installed.
    view() {
        const installed = Object.fromEntries(this.host.list().map(p => [p.id, p]));
        return {
            available: this.available, checkedAt: this.checkedAt, error: this.error, busy: !!this.busy,
            entries: this.entries.map(e => {
                const have = installed[e.id];
                return {
                    id: e.id, name: e.name || e.id, version: e.version, description: e.description || '', minCore: e.minCore || null,
                    tooNew: !!(e.minCore && newer(e.minCore, this.host.coreVersion)),
                    installed: have ? have.version : null,
                    update: !!(have && newer(e.version, have.version)),
                };
            }),
        };
    }
}

module.exports = { Catalog };
