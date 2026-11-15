/**
 * PLUGIN ZIP IMPORT (Plugins tab > Custom plugins > Import .zip)
 *
 * A zip of one plugin folder (plugin.json at the top, or inside one folder at the top) is unpacked into the
 * data folder's plugins/<id>, the same way a plugin list install is (a .new folder, then swapped in). Signed
 * with the release key (plugin.sig) it runs like any listed plugin; unsigned it shows as "unverified" and
 * runs only with Settings > "Allow unverified plugins" on.
 * Refused: an unsigned zip using the id of a built-in or listed plugin (it would take that plugin's place),
 * a minCore newer than this app, paths outside the folder, more than MAX_FILES files or MAX_SIZE unpacked.
 * Zip reading is the small subset plugins need: stored or deflated entries, no encryption, no zip64.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { verify, newer } = require('./host');

const MAX_ZIP = 20 * 1024 * 1024;
const MAX_SIZE = 50 * 1024 * 1024;
const MAX_FILES = 500;

const fail = (code, msg) => Object.assign(new Error(msg), { code });

// { name -> Buffer } of the files in a zip (folders left out).
function unzip(buf) {
    if (buf.length > MAX_ZIP) throw fail('size', 'the zip is over 20 MB');
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw fail('format', 'not a zip file');
    const count = buf.readUInt16LE(eocd + 10);
    let at = buf.readUInt32LE(eocd + 16);
    if (count > MAX_FILES) throw fail('size', `more than ${MAX_FILES} files`);
    const out = {};
    let total = 0;
    for (let n = 0; n < count; n++) {
        if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw fail('format', 'damaged zip');
        const flags = buf.readUInt16LE(at + 8), method = buf.readUInt16LE(at + 10), csize = buf.readUInt32LE(at + 20), usize = buf.readUInt32LE(at + 24);
        const nlen = buf.readUInt16LE(at + 28), xlen = buf.readUInt16LE(at + 30), clen = buf.readUInt16LE(at + 32), local = buf.readUInt32LE(at + 42);
        const name = buf.toString('utf8', at + 46, at + 46 + nlen).replace(/\\/g, '/');
        at += 46 + nlen + xlen + clen;
        if (name.endsWith('/')) continue;
        if (flags & 1) throw fail('format', 'encrypted zips can\'t be imported');
        if (csize === 0xffffffff || usize === 0xffffffff) throw fail('format', 'zip64 isn\'t supported — zip it again');
        total += usize;
        if (total > MAX_SIZE) throw fail('size', 'over 50 MB unpacked');
        if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw fail('format', 'damaged zip');
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const data = buf.subarray(start, start + csize);
        let file;
        if (method === 0) file = Buffer.from(data);
        else if (method === 8) file = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, usize) });
        else throw fail('format', `"${name}" uses a compression this can't read — zip it again with normal (deflate) compression`);
        if (file.length !== usize) throw fail('format', 'damaged zip');
        out[name] = file;
    }
    return out;
}

// files (from unzip) -> { id, manifest, files: { rel -> Buffer } }: plugin.json at the top or in one top folder.
function pluginFiles(files) {
    const names = Object.keys(files).filter(n => !/(^|\/)(__MACOSX|\.DS_Store)(\/|$)/.test(n));
    let prefix = '';
    if (!names.includes('plugin.json')) {
        const tops = new Set(names.map(n => n.split('/')[0]));
        if (tops.size === 1 && names.includes([...tops][0] + '/plugin.json')) prefix = [...tops][0] + '/';
        else throw fail('format', 'no plugin.json at the top of the zip (zip the plugin\'s folder, or the files in it)');
    }
    const out = {};
    for (const n of names) {
        if (!n.startsWith(prefix)) throw fail('format', 'files outside the plugin folder');
        const rel = n.slice(prefix.length), parts = rel.split('/');
        if (!rel || rel.startsWith('/') || parts.some(x => !x || x === '.' || x === '..' || /[:\0]/.test(x))) throw fail('format', `bad file name "${n}"`);
        out[rel] = files[n];
    }
    let manifest;
    try { manifest = JSON.parse(out['plugin.json'].toString('utf8')); } catch (_) { throw fail('format', 'plugin.json isn\'t valid JSON'); }
    if (!manifest || !/^[a-z0-9-]{1,40}$/.test(manifest.id || '')) throw fail('format', 'plugin.json needs an "id" of lower-case letters, digits and -');
    if (!manifest.version || !manifest.main) throw fail('format', 'plugin.json needs a "version" and a "main" file');
    if (!out[manifest.main]) throw fail('format', `the main file "${manifest.main}" isn't in the zip`);
    return { id: manifest.id, manifest, files: out };
}

// Import a zip (Buffer). host: the PluginHost; catalog: for "listed" ids. -> { ok, id, name, version, verified } | { ok: false, code, error }
function importZip(buf, { host, catalog, log }) {
    let id, manifest, tmp;
    try {
        const pf = pluginFiles(unzip(buf));
        ({ id, manifest } = pf);
        if (manifest.minCore && newer(manifest.minCore, host.coreVersion)) throw fail('mincore', `needs app version ${manifest.minCore} or newer`);
        const root = host.userDir, dir = path.join(root, id), old = dir + '.old';
        tmp = dir + '.new';
        fs.rmSync(tmp, { recursive: true, force: true });
        for (const [rel, data] of Object.entries(pf.files)) {
            const f = path.join(tmp, ...rel.split('/'));
            fs.mkdirSync(path.dirname(f), { recursive: true });
            fs.writeFileSync(f, data);
        }
        const signed = verify(tmp, host.publicKey);
        const had = host.plugins.get(id);
        const official = (had && had.bundled) || fs.existsSync(path.join(host.bundledDir || '', id, 'plugin.json')) || (catalog && (catalog.entries || []).some(e => e.id === id));
        if (!signed && official) throw fail('taken', `"${id}" is the name of an official plugin — an unsigned zip can't replace it (change the id in plugin.json)`);
        fs.rmSync(old, { recursive: true, force: true });
        if (had && had.state === 'running' && had.dir === dir) host.stopPlugin(id);
        if (fs.existsSync(dir)) fs.renameSync(dir, old);
        fs.renameSync(tmp, dir);
        fs.rmSync(old, { recursive: true, force: true });
        host.cfg(id).imported = true;
        host.store.saveSettings();
        host.scan();
        const name = manifest.name || id;
        log.add(null, `Plugin ${name} ${manifest.version} imported from a zip${signed ? ' (signed)' : ' (unverified)'}`, signed ? 'ok' : 'warn');
        const started = host.startIfEnabled(id);
        host.engine.emit('change');
        return { ok: true, id, name, version: manifest.version, verified: signed, started: started.ok };
    } catch (e) {
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
        log.add(null, `Plugin zip not imported: ${e.message}`, 'warn');
        return { ok: false, code: e.code || 'import', error: e.message };
    }
}

module.exports = { importZip, unzip, pluginFiles };
