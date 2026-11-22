/**
 * PLUGIN HOST
 *
 * A plugin is a folder with plugin.json and a main file:
 *   plugin.json  { id, name, version, description, minCore, main, defaultEnabled, settings: { key: { type, label, default } } }
 *   index.js     module.exports = { start(ctx) { ... }, stop() { ... } }   (stop is optional)
 *
 * Setting types: number, text, boolean, choice ({ options: [{ value, label }] }) and accounts — which
 * accounts an operation runs on, { all, ids }. An accounts setting always starts with none chosen;
 * "all" includes accounts added later. Plugins ask with ctx.settings.runsOn(key, accountId).
 * More: account (one account id, '' = none), and list ({ fields: { key: spec } }) — rows of the
 * other types, e.g. trade routes; a list starts empty and holds up to 50 rows. A list's field may be a list
 * itself (core 1.2.22+; its entries: number, text, boolean, choice, account), e.g. each set's own case queue.
 * manifest.tab: the title of the plugin's own tab (ctx.panel.tab) — its setup lives there, and the
 * Plugins tab shows "Open" instead of a settings dialog. manifest.group (optional): the tab bar drop-down its
 * tabs go in ('farming', 'trading', or a name of its own); without one, "More". A tab's content
 * may return pin: 'a few words' (e.g. 'running'): while set, the tab sits on the bar by itself with those words.
 * Any setting may have help (a line under it) and when: '<boolean key>' (shown only while that's on). A list
 * row's field may have when: '<field>' (shown while that field is set) and unless: '<field>' (hidden while it is).
 * A choice with dynamic: true gets its options from the plugin (ctx.settings.setOptions), e.g. a
 * list read from the site; until then any value is kept.
 *
 * Plugins load and unload while the clicker keeps running. Everything a plugin sets up through
 * ctx (listeners, timers, panel tabs, badges, raised errors) is tracked and removed when it stops,
 * so a plugin can't leak timers or leave stale problems behind.
 *
 * Trust: plugins shipped inside the app are trusted. Installed ones (in the data folder) must carry
 * a plugin.sig made with the release key, unless the user turned on "allow unverified plugins".
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const themeKit = require('./theme');
const { PUBLIC_KEY } = require('./keys');

const SIG_FILE = 'plugin.sig';
const NO_ACCOUNTS = Object.freeze({ all: false, ids: Object.freeze([]) });

// A setting's value as stored: the default for the type when unset.
function settingDefault(spec) {
    if (spec.type === 'accounts') return NO_ACCOUNTS;
    if (spec.type === 'list') return [];
    if (spec.type === 'tags') return [];
    if (spec.type === 'account') return '';
    if (spec.type === 'choice' && !(spec.options || []).some(o => o.value === spec.default)) return (spec.options || [])[0] ? spec.options[0].value : null;
    return spec.default;
}

// manifest.power: true gives a plugin the shared on/off: an "on" switch and a Live/Practice mode. On works in live
// only (switching to practice turns it off), and practice never runs by itself, only when asked. ctx.power.live() /
// ctx.power.practice() read it. An old practice switch carries over once: live before means live and on.
const POWER = {
    on: { type: 'boolean', label: 'On', default: false },
    runMode: { type: 'choice', label: 'Mode', default: 'practice', options: [{ value: 'live', label: 'Live' }, { value: 'practice', label: 'Practice' }] },
};
function withPower(manifest) {
    if (!manifest || !manifest.power) return manifest;
    const settings = { ...POWER };
    for (const [k, v] of Object.entries(manifest.settings || {})) settings[k] = k === 'practice' ? { ...v, hidden: true } : v;
    return { ...manifest, settings };
}

function newer(a, b) {   // is version a newer than b?
    const pa = String(a).split('-')[0].split('.').map(Number), pb = String(b).split('-')[0].split('.').map(Number);
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
    return false;
}

function listFiles(dir, base = dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...listFiles(p, base));
        else if (e.name !== SIG_FILE) out.push(path.relative(base, p).split(path.sep).join('/'));
    }
    return out.sort();
}

// What gets signed: every file's path and sha256, in order. Shared with tools/sign-plugin.js.
function digest(dir) {
    return listFiles(dir).map(f => f + '\n' + crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex') + '\n').join('');
}

function verify(dir, key = PUBLIC_KEY) {
    if (!key) return false;
    try {
        const sig = Buffer.from(fs.readFileSync(path.join(dir, SIG_FILE), 'utf8').trim(), 'base64');
        return crypto.verify(null, Buffer.from(digest(dir)), crypto.createPublicKey(key), sig);
    } catch (_) { return false; }
}

// Plugin traffic is paced per exit IP: at most `lanes` site requests (or socket openings) at once, each started at least
// `gapMs` after the one before. Every account's turn tends to start at the same moment (plugins on, a timer for all), and
// ~20 accounts per IP all calling at once got Cloudflare asking for checks on every IP (a 109-account test). The clicks
// themselves don't go through this.
const PACE = { lanes: 3, gapMs: 100 };

class PluginHost {
    constructor({ coreVersion, engine, store, site, errors, log, bundledDir, userDir, dataDir, publicKey = PUBLIC_KEY, sockets = null, pace = PACE }) {
        Object.assign(this, { coreVersion, engine, store, site, errors, log, bundledDir, userDir, dataDir, publicKey, sockets, pace: { ...PACE, ...pace } });
        this.gates = new Map();     // exit-IP group -> { busy, last, q: [start fns], t }
        this.plugins = new Map();   // id -> { manifest, dir, bundled, verified, state, error, mod, res }
        this.busy = new Map();      // account id -> Map(plugin id -> { plugin, what, at }): plugins that have the account tied up
        this.wants = new Map();     // account id -> Map(plugin id -> { plugin, what, at }): plugins asking another to hand the account over
        this.shared = new Map();    // 'plugin/key' -> value a plugin publishes for the others (cleared when it stops)
        for (const d of [userDir, dataDir]) fs.mkdirSync(d, { recursive: true });
    }

    // Any plugin's mark on the account (the first): { plugin, what, at } or null.
    busyOf(aid) { const m = this.busy.get(aid); return m && m.size ? { ...m.values().next().value } : null; }

    // Runs fn when the exit IP of this account's route has a free lane (see PACE). first: goes ahead of the queue
    // (a short job the user is waiting on, like Skillmaps' Apply).
    async paced(aid, fn, first = false) {
        const run = this.engine.run.get(aid);
        const key = this.engine.groupOf(run ? run.route : 'direct');
        let g = this.gates.get(key);
        if (!g) this.gates.set(key, g = { busy: 0, last: 0, q: [], t: null });
        await new Promise(res => { if (first) g.q.unshift(res); else g.q.push(res); this.pump(g); });
        try { return await fn(); } finally { g.busy--; this.pump(g); }
    }
    pump(g) {
        while (g.q.length && g.busy < this.pace.lanes) {
            const wait = g.last + this.pace.gapMs - Date.now();
            if (wait > 0) { if (!g.t) g.t = setTimeout(() => { g.t = null; this.pump(g); }, wait); return; }
            g.busy++; g.last = Date.now(); g.q.shift()();
        }
    }

    cfg(id) {
        const all = this.store.settings.plugins;
        if (!all[id]) all[id] = {};
        return all[id];
    }

    // Find plugins on disk. A user-installed copy of a bundled plugin wins if it's newer.
    scan() {
        const found = new Map();
        const look = (root, bundled) => {
            if (!root || !fs.existsSync(root)) return;
            for (const e of fs.readdirSync(root, { withFileTypes: true })) {
                if (!e.isDirectory()) continue;
                const dir = path.join(root, e.name);
                let manifest;
                try { manifest = withPower(JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'))); } catch (_) { continue; }
                if (!manifest.id || !/^[a-z0-9-]+$/.test(manifest.id)) continue;
                const prev = found.get(manifest.id);
                if (prev && !newer(manifest.version, prev.manifest.version)) continue;
                found.set(manifest.id, { manifest, dir, bundled });
            }
        };
        look(this.bundledDir, true);
        look(this.userDir, false);
        const restart = [];
        for (const [id, p] of found) {
            const cur = this.plugins.get(id);
            if (cur && cur.dir === p.dir && cur.manifest.version === p.manifest.version) continue;
            if (cur && cur.state === 'running') { this.stopPlugin(id); restart.push(id); }
            this.plugins.set(id, { ...p, verified: p.bundled || verify(p.dir, this.publicKey), state: 'off', error: null, mod: null, res: null });
        }
        // A running plugin whose files changed comes back as the new version, instead of staying off.
        for (const id of restart) this.startIfEnabled(id);
        // Gone from disk (removed): stop it and forget it.
        for (const id of [...this.plugins.keys()]) if (!found.has(id)) { this.stopPlugin(id); this.plugins.delete(id); }
    }

    // Start a plugin again after its files changed (install / update / remove), if it's turned on.
    startIfEnabled(id) {
        const p = this.plugins.get(id);
        if (p && p.state !== 'running' && (this.cfg(id).enabled ?? !!p.manifest.defaultEnabled)) return this.startPlugin(id);
        return { ok: true };
    }

    startEnabled() {
        for (const [id, p] of this.plugins) {
            const c = this.cfg(id);
            if (c.enabled ?? !!p.manifest.defaultEnabled) this.startPlugin(id);
        }
    }

    setEnabled(id, on) {
        if (!this.plugins.has(id)) return { ok: false, error: 'No such plugin' };
        this.cfg(id).enabled = !!on; this.store.saveSettings();
        return on ? this.startPlugin(id) : (this.stopPlugin(id), { ok: true });
    }

    // A value checked against its spec: { ok, value } or { ok: false, error }.
    checkValue(p, spec, value) {
        const known = () => new Set(this.store.accounts.map(a => a.id));
        if (spec.type === 'number') {
            value = Number(value);
            if (!Number.isFinite(value)) return { ok: false, error: 'Not a number' };
            if (spec.min != null && value < spec.min) value = spec.min;
            if (spec.max != null && value > spec.max) value = spec.max;
        } else if (spec.type === 'boolean') value = !!value;
        else if (spec.type === 'choice') {
            const opts = this.optionsFor(p, spec);
            if (!(spec.dynamic && !opts.length) && !opts.some(o => o.value === value)) return { ok: false, error: 'Not one of the choices' };
            value = value == null ? '' : String(value);   // a dynamic choice with no options yet has no default: '' (was "null")
        } else if (spec.type === 'accounts') {
            if (!value || typeof value !== 'object') return { ok: false, error: 'Not an account list' };
            const k = known();
            value = { all: !!value.all, ids: [...new Set(Array.isArray(value.ids) ? value.ids.map(String) : [])].filter(i => k.has(i)) };
        } else if (spec.type === 'account') {
            value = value ? String(value) : '';
            if (value && !known().has(value)) return { ok: false, error: 'No such account' };
        } else if (spec.type === 'list') {
            if (!Array.isArray(value)) return { ok: false, error: 'Not a list' };
            const rows = [];
            for (const row of value.slice(0, 50)) {
                const out = {};
                for (const [fk, fs] of Object.entries(spec.fields || {})) {
                    if (fs.type === 'heading') continue;   // a label between fields, holds nothing
                    const r = this.checkValue(p, fs, row && fk in row ? row[fk] : settingDefault(fs));
                    out[fk] = r.ok ? r.value : settingDefault(fs);
                }
                rows.push(out);
            }
            value = rows;
        } else if (spec.type === 'tags') {
            // Short names typed one at a time (the panel shows each as a chip). An older plain-text value becomes one.
            const raw = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
            const seen = new Set();
            value = raw.map(x => String(x ?? '').trim().slice(0, 60)).filter(x => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase())).slice(0, 20);
        } else value = String(value);
        return { ok: true, value };
    }

    optionsFor(p, spec, key) {
        const dyn = p.res && p.res.options && key && p.res.options[key];
        return dyn || (p.dynOptions && key && p.dynOptions[key]) || spec.options || [];
    }

    setPluginSetting(id, key, value) {
        const p = this.plugins.get(id);
        const spec = p && p.manifest.settings && p.manifest.settings[key];
        if (!spec) return { ok: false, error: 'No such setting' };
        const chk = this.checkValue(p, spec.type === 'choice' ? { ...spec, options: this.optionsFor(p, spec, key) } : spec, value);
        if (!chk.ok) return chk;
        value = chk.value;
        const c = this.cfg(id);
        if (p.manifest.power && key === 'on' && value && (c.settings || {}).runMode !== 'live') return { ok: false, error: 'Set the mode to Live first' };
        c.settings = { ...(c.settings || {}), [key]: value };
        if (p.manifest.power && key === 'runMode' && value !== 'live' && c.settings.on) { c.settings.on = false; this.notifySetting(p, 'on', false); }
        this.store.saveSettings();
        this.notifySetting(p, key, value);
        return { ok: true };
    }

    notifySetting(p, key, value) { if (p.res) for (const fn of p.res.settingsListeners) { try { fn(key, value); } catch (_) {} } }

    // Stop, drop the cached code and start again — picks up new files without restarting the app.
    reload(id) {
        const p = this.plugins.get(id);
        if (!p) return { ok: false, error: 'No such plugin' };
        const was = p.state === 'running';
        this.stopPlugin(id);
        p.verified = p.bundled || verify(p.dir, this.publicKey);
        try { p.manifest = withPower(JSON.parse(fs.readFileSync(path.join(p.dir, 'plugin.json'), 'utf8'))); } catch (_) {}
        return was ? this.startPlugin(id) : this.startIfEnabled(id);
    }

    fail(id, code, msg) {
        const p = this.plugins.get(id);
        p.state = 'error'; p.error = { code, msg };
        this.errors.raise('plugin:' + id, code, msg);
        this.log.add(null, `Plugin ${p.manifest.name || id}: ${msg}`, 'error');
        this.engine.emit('change');
        return { ok: false, code, error: msg };
    }

    startPlugin(id) {
        const p = this.plugins.get(id);
        if (!p) return { ok: false, error: 'No such plugin' };
        if (p.state === 'running') return { ok: true };
        this.errors.clearAccount('plugin:' + id);
        if (p.manifest.minCore && newer(p.manifest.minCore, this.coreVersion)) return this.fail(id, 'CC-PLUG-03', `needs app ${p.manifest.minCore} (this is ${this.coreVersion})`);
        if (!p.verified && !this.store.settings.allowUnverifiedPlugins) return this.fail(id, 'CC-PLUG-04', 'not signed by the release key');

        const main = path.join(p.dir, p.manifest.main || 'index.js');
        // Drop every cached module from this plugin's folder so a reload runs the new code.
        for (const k of Object.keys(require.cache)) if (k.startsWith(p.dir + path.sep)) delete require.cache[k];
        p.res = { listeners: [], timers: [], perAccount: [], tabs: [], badges: [], codes: [], settingsListeners: [], sockets: new Set(), sleeps: new Set(), stopping: false, actions: {}, sched: new Map(), theme: null, assets: new Set(), assetUrls: new Map(), assetBudget: { used: 0 } };
        try {
            p.mod = require(main);
            const ctx = this.makeCtx(id, p);
            const ret = p.mod.start && p.mod.start(ctx);
            if (ret && typeof ret.catch === 'function') ret.catch(e => { if (p.state === 'running') { this.cleanup(p); this.fail(id, 'CC-PLUG-01', e.message); } });
        } catch (e) {
            this.cleanup(p);
            return this.fail(id, 'CC-PLUG-01', e.message);
        }
        p.state = 'running'; p.error = null;
        this.log.add(null, `Plugin ${p.manifest.name || id} ${p.manifest.version} started`, 'ok');
        this.engine.emit('change');
        return { ok: true };
    }

    stopPlugin(id) {
        const p = this.plugins.get(id);
        if (!p || p.state !== 'running') { if (p && p.state === 'error') { p.state = 'off'; p.error = null; this.errors.clearAccount('plugin:' + id); } return; }
        try { if (p.mod && p.mod.stop) p.mod.stop(); } catch (e) { this.log.add(null, `Plugin ${id} stop(): ${e.message}`, 'warn'); }
        for (const [aid, m] of this.busy) { m.delete(id); if (!m.size) this.busy.delete(aid); }
        for (const [aid, m] of this.wants) { m.delete(id); if (!m.size) this.wants.delete(aid); }
        for (const k of this.shared.keys()) if (k.startsWith(id + '/')) this.shared.delete(k);
        if (this.routesOwner === id) { this.routesOwner = null; this.engine.setRoutes([]); }   // its proxies go with it
        this.cleanup(p);
        p.state = 'off'; p.mod = null;
        this.log.add(null, `Plugin ${p.manifest.name || id} stopped`);
        this.engine.emit('change');
    }

    stopAll() { for (const id of this.plugins.keys()) this.stopPlugin(id); }

    cleanup(p) {
        const r = p.res;
        if (!r) return;
        r.stopping = true;
        for (const s of r.sockets) { try { s.close(); } catch (_) {} }
        if (r.options) p.dynOptions = r.options;   // keep the last list for the settings window
        for (const [ev, fn] of r.listeners) this.engine.off(ev, fn);
        for (const t of r.timers) clearInterval(t);
        for (const t of r.sleeps) clearTimeout(t);
        for (const pa of r.perAccount) clearInterval(pa.timer);
        // Problems this plugin raised go with it (its own codes, and its crash reports).
        for (const it of this.errors.list()) if (r.codes.includes(it.code)) this.errors.clear(it.acct, it.code);
        this.errors.clear('plugin:' + p.manifest.id, 'CC-PLUG-02');
        p.res = null;
    }

    // Wrap plugin callbacks: a throw becomes CC-PLUG-02 instead of taking the app down.
    guard(id, p, fn) {
        return (...args) => {
            if (p.state !== 'running' && p.state !== 'starting') return;
            try {
                const v = fn(...args);
                if (v && typeof v.catch === 'function') v.catch(e => this.crashed(id, e));
                return v;
            } catch (e) { this.crashed(id, e); }
        };
    }

    crashed(id, e) {
        this.errors.raise('plugin:' + id, 'CC-PLUG-02', e && e.message);
        this.log.add(null, `Plugin ${id} error: ${e && e.message}`, 'error');
    }

    makeCtx(id, p) {
        const host = this, r = p.res, engine = this.engine, store = this.store;
        p.state = 'starting';
        // An account as plugins see it; me: its last numbers from the site (null until read), for pages to show.
        const pubMe = (m) => (m ? { money: m.money, tokens: m.tokens, openCount: m.openCount, openMult: m.openMult, at: m.at } : null);
        const pub = (a) => ({ id: a.id, name: a.name, type: a.type, running: engine.isRunning(a.id), healthy: engine.isHealthy(a.id), me: pubMe(engine.meOf(a.id)) });
        const dataFile = path.join(this.dataDir, id + '.json');
        const ownDir = path.join(this.dataDir, id);
        const settingDefaults = Object.fromEntries(Object.entries(p.manifest.settings || {}).map(([k, v]) => [k, settingDefault(v)]));
        const getSetting = (k) => { const s = (host.cfg(id).settings || {}); return k in s ? s[k] : settingDefaults[k]; };
        if (p.manifest.power) {   // the old practice switch, once: live before means live and on now
            const c = host.cfg(id), st = c.settings || {};
            if (!('runMode' in st) && st.practice === false) { c.settings = { ...st, runMode: 'live', on: true }; host.store.saveSettings(); }
        }
        const ctx = {
            id, coreVersion: this.coreVersion,
            log: (msg, level = 'info', acctId = null) => host.log.add(acctId, `[${id}] ${msg}`, level),
            accounts: {
                list: () => store.accounts.map(pub),
                get: (aid) => { const a = store.get(aid); return a ? pub(a) : null; },
                // The latest /api/me numbers the clicker has for an account (no token).
                stats: (aid) => { const a = store.get(aid); return a ? engine.view(a).me : null; },
                // Long jobs that keep the site busy (opening thousands of cases) mark the account, so other plugins
                // can wait instead of having their requests refused ("User is locked"). setBusy(aid, null) clears. Each plugin has
                // its own mark, so two that share an account (the Armory and Games) don't clear each other's.
                setBusy: (aid, what) => {
                    const m = host.busy.get(aid) || new Map();
                    if (what) { m.set(id, { plugin: id, what: String(what), at: Date.now() }); host.busy.set(aid, m); }
                    else { m.delete(id); if (!m.size) host.busy.delete(aid); }
                },
                // Another plugin's mark on the account: { plugin, what, at } or null. ignore: plugin ids whose marks
                // don't count (plugins built to work alongside each other on the same account).
                busy: (aid, { ignore = [] } = {}) => {
                    for (const b of (host.busy.get(aid) || new Map()).values()) if (b.plugin !== id && !ignore.includes(b.plugin)) return { ...b };
                    return null;
                },
                // Asking for an account another plugin holds (the Trader's routes): want(aid, what) until done, then
                // want(aid, null). A plugin that holds accounts for long stretches (the Armory) checks wanted(aid), starts
                // nothing new on it and clears its busy mark once what it has going there is finished.
                want: (aid, what) => {
                    const m = host.wants.get(aid) || new Map();
                    if (what) { m.set(id, { plugin: id, what: String(what), at: Date.now() }); host.wants.set(aid, m); }
                    else { m.delete(id); if (!m.size) host.wants.delete(aid); }
                },
                // Another plugin asking for the account: { plugin, what, at } or null.
                wanted: (aid) => {
                    for (const w of (host.wants.get(aid) || new Map()).values()) if (w.plugin !== id) return { ...w };
                    return null;
                },
                // The player's main account (Settings), when it's one of the hub's accounts: its id, else null. Plugins
                // suggest it as the place things go (Trader's receiver, …).
                main: () => { const m = store.settings.main; const a = m && m.userId ? store.accounts.find(x => x.userId === m.userId) : null; return a ? a.id : null; },
            },
            // What a plugin publishes for the others (the Armory's star farming list, read by Games): set(key, value)
            // under its own name, get('plugin/key') for another's. Gone when the publishing plugin stops.
            shared: {
                set: (key, value) => { if (value == null) host.shared.delete(id + '/' + key); else host.shared.set(id + '/' + key, JSON.parse(JSON.stringify(value))); },
                get: (key) => { const v = host.shared.get(key); return v == null ? null : JSON.parse(JSON.stringify(v)); },
            },
            // manifest.power: live() — on, in live mode (do things); practice() — in practice mode (only show, when asked).
            power: { live: () => !!getSetting('on') && getSetting('runMode') === 'live', practice: () => getSetting('runMode') !== 'live' },
            on: (ev, fn) => { const g = host.guard(id, p, fn); engine.on(ev, g); r.listeners.push([ev, g]); },
            // A request as this account. Only for accounts that are clicking normally; a 401 goes
            // through the clicker's re-login like any click would. opts.first: ahead of other plugins' queued requests.
            request: async (aid, pathname, { first, ...opts } = {}) => {
                if (!engine.isHealthy(aid)) return { kind: 'not-running', status: 0 };
                return host.paced(aid, () => engine.isHealthy(aid) ? engine.call(engine.run.get(aid), pathname, { ...opts, caller: id }) : { kind: 'not-running', status: 0 }, !!first);
            },
            // The site's live socket (trades) as this account: { emit(ev, data), wait(events, ms) -> { ev, data } | null, close() }.
            // Closed by itself when the plugin stops.
            socket: async (aid) => {
                if (!host.sockets) throw new Error('sockets are not available here');
                if (!engine.isHealthy(aid)) throw new Error('account is not clicking');
                const s = await host.paced(aid, async () => {
                    if (!engine.isHealthy(aid)) throw new Error('account is not clicking');
                    const t = await engine.call(engine.run.get(aid), '/api/auth/token', {});
                    if (t.kind !== 'ok' || !t.json || !t.json.token) throw new Error('no socket token (HTTP ' + t.status + ')');
                    return host.sockets.open(t.json.token, engine.run.get(aid) ? engine.run.get(aid).route : 'direct', host.site.clientId());
                });
                if (r.stopping) { s.close(); throw new Error('plugin stopped'); }
                r.sockets.add(s);
                const close = s.close.bind(s);
                s.close = () => { r.sockets.delete(s); close(); };
                return s;
            },
            // A folder of the plugin's own for files it keeps (made when first asked for).
            get dir() { fs.mkdirSync(ownDir, { recursive: true }); return ownDir; },
            // Secrets a plugin keeps (proxy passwords): sealed with the same system keychain as the account logins.
            // unseal() gives null when it can't be read (another machine or Windows user).
            secrets: {
                seal: (text) => store.crypt.seal(String(text)),
                unseal: (sealed) => { try { return store.crypt.unseal(String(sealed)); } catch (_) { return null; } },
            },
            // Network routes (Proxy manager): setRoutes([{ id, label, proxy: { scheme, host, port, user, pass }, ip }]) — gone when
            // the plugin stops; probe(id) -> { ok, ip, ms } | { ok, error }; pin(aid, routeId | null) moves an account (restarts it if
            // clicking); state() -> where every account is and how full each route is.
            network: {
                setRoutes: (list) => { host.routesOwner = id; engine.setRoutes(list); },
                probe: (rid) => engine.probeRoute(rid),
                pin: (aid, rid) => {
                    const a = store.get(aid); if (!a) return { ok: false, error: 'No such account' };
                    if (rid && !engine.hasRoute(rid)) return { ok: false, error: 'No such proxy' };
                    a.routePin = rid || null; store.saveAccounts();
                    if (engine.isRunning(aid) && engine.run.get(aid).route !== engine.routeFor(a)) { engine.stop(aid, { quiet: true }); engine.start(aid); }
                    return { ok: true };
                },
                state: () => ({
                    maxPerIp: engine.settings.maxPerIp,
                    accounts: store.accounts.map(a => ({ id: a.id, name: a.name, route: engine.isRunning(a.id) ? engine.run.get(a.id).route : a.route || null, pin: a.routePin || null, running: engine.isRunning(a.id) })),
                    routes: ['direct', ...(engine.routes ? engine.routes.keys() : [])].map(rid => ({ id: rid, group: engine.groupOf(rid), used: engine.usedIn(engine.groupOf(rid)), down: engine.routeDown(rid) })),
                }),
            },
            // True once the plugin is being turned off: long loops check it and end.
            get stopping() { return r.stopping; },
            // Pending sleeps are cancelled when the plugin stops; a finished one is forgotten at once (plugins sleep in
            // every loop: keeping each handle grew memory for as long as the plugin ran).
            sleep: (ms) => new Promise(res => { const t = setTimeout(() => { r.sleeps.delete(t); res(); }, ms); r.sleeps.add(t); }),
            every: (ms, fn) => { const t = setInterval(host.guard(id, p, fn), Math.max(1000, ms)); r.timers.push(t); return t; },
            // fn(account) for each healthy account every ms, first runs spread over one interval.
            // opts.what: how the Schedule tab names one of these checks (default "Check"); opts.only(aid): the accounts it
            // really does something on (it's called for every clicking account), so the tab lists just those.
            everyAccount: (ms, fn, opts = {}) => {
                ms = Math.max(5000, ms);
                const g = host.guard(id, p, fn), due = new Map();
                const timer = setInterval(() => {
                    const now = Date.now();
                    for (const aid of engine.running()) {
                        if (!due.has(aid)) due.set(aid, now + Math.floor(Math.random() * ms));
                        if (now >= due.get(aid) && engine.isHealthy(aid)) { due.set(aid, now + ms); g(pub(store.get(aid))); }
                    }
                    for (const aid of due.keys()) if (!engine.isRunning(aid)) due.delete(aid);
                }, 1000);
                r.perAccount.push({ timer, due, ms, what: String(opts.what || 'Check'), only: typeof opts.only === 'function' ? opts.only : null });
            },
            // What's coming up, for the Schedule tab: set(key, { what, at, accounts, why, runNow, skip }) — at: when (ms),
            // accounts: account ids it's for, why: one line on why it runs (then), runNow / skip: functions for the tab's
            // Run now and Skip next buttons (left out: no button). set(key, null) clears; all of it goes when the plugin stops.
            schedule: {
                set: (key, e) => {
                    if (!e) { r.sched.delete(String(key)); return; }
                    r.sched.set(String(key), { what: String(e.what || ''), at: Number(e.at) || null, accounts: Array.isArray(e.accounts) ? e.accounts.map(String) : [],
                        why: e.why ? String(e.why) : '', runNow: typeof e.runNow === 'function' ? e.runNow : null, skip: typeof e.skip === 'function' ? e.skip : null });
                },
                clear: () => r.sched.clear(),
            },
            errors: {
                define: (code, spec) => { if (!host.errors.codes[code]) host.errors.define(code, spec); if (!r.codes.includes(code)) r.codes.push(code); },
                raise: (aid, code, detail) => host.errors.raise(aid, code, detail),
                clear: (aid, code) => host.errors.clear(aid, code),
            },
            settings: {
                get: getSetting,
                all: () => ({ ...settingDefaults, ...(host.cfg(id).settings || {}) }),
                // Is this account chosen in an accounts setting?
                // Change one of its own settings (e.g. a "Go live" button), checked like the panel's changes.
                set: (k, v) => host.setPluginSetting(id, k, v),
                runsOn: (k, aid) => { const v = getSetting(k) || NO_ACCOUNTS; return !!v.all || (Array.isArray(v.ids) && v.ids.includes(aid)); },
                // Options for a dynamic choice (setting key, or 'listKey.fieldKey'): [{ value, label }].
                setOptions: (k, opts) => { r.options = { ...(r.options || {}), [k]: (opts || []).map(o => ({ value: String(o.value), label: String(o.label ?? o.value), ...(o.group ? { group: String(o.group) } : {}) })) }; },
                onChange: (fn) => r.settingsListeners.push(fn),
            },
            // Small JSON file per plugin for anything it wants to keep.
            data: {
                get: () => { try { return JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch (_) { return {}; } },
                set: (obj) => { fs.writeFileSync(dataFile + '.tmp', JSON.stringify(obj)); fs.renameSync(dataFile + '.tmp', dataFile); },
            },
            panel: {
                // render() -> { blocks: [ { type: 'stats', items: [{ label, value }] } | { type: 'table', columns, rows } | { type: 'text', text } ] }
                // opts.group: this tab's drop-down, when it isn't the plugin's own (manifest.group).
                tab: (title, render, opts = {}) => r.tabs.push({ title, render, group: opts.group ? String(opts.group) : null }),
                // A button in the plugin's tab (block { type: 'buttons', items: [{ label, action }] }) runs fn(arg);
                // it may return { ok, message } (message shows as a toast).
                action: (name, fn) => { r.actions[name] = fn; },
                // fn(accountId) -> short text shown on that account's card, or null
                badge: (fn) => r.badges.push(host.guard(id, p, fn)),
                // A theme for the whole panel (src/plugins/theme.js): theme({ vars, css }) or theme(null) to take it back.
                // Returns { ok, dropped: [why each left-out variable] } or { ok: false, error }. Shown when picked in Settings.
                theme: (spec) => {
                    if (!spec) { r.theme = null; host.engine.emit('change'); return { ok: true }; }
                    const v = themeKit.checkVars(spec.vars), c = themeKit.checkCss(spec.css, r.assets);
                    if (c.error) { host.log.add(null, `${p.manifest.name || id}: theme not used — ${c.error}`, 'warn'); return { ok: false, error: c.error }; }
                    r.theme = { vars: v.vars, css: c.css };
                    r.theme.stamp = themeKit.stamp(r.theme);
                    host.engine.emit('change');
                    return { ok: true, dropped: v.dropped };
                },
                // A picture from the plugin's folder, as a URL that works in the app window and the browser panel.
                asset: (file) => {
                    const key = String(file);
                    if (!r.assetUrls.has(key)) { const u = themeKit.readAsset(p.dir, key, r.assetBudget); r.assetUrls.set(key, u); r.assets.add(u); }
                    return r.assetUrls.get(key);
                },
            },
        };
        return ctx;
    }

    // --- what the panel reads -----------------------------------------------
    // Schedule tab: what each running plugin has coming up (its own schedule.set entries, and its everyAccount checks).
    schedule() {
        const out = [];
        for (const [id, p] of this.plugins) {
            if (p.state !== 'running' || !p.res) continue;
            const name = p.manifest.name || id;
            for (const [key, e] of p.res.sched) out.push({ plugin: id, pluginName: name, key, what: e.what, at: e.at, accounts: e.accounts, why: e.why, canRun: !!e.runNow, canSkip: !!e.skip });
            p.res.perAccount.forEach((pa, i) => {
                const ids = pa.due ? this.dueFor(pa) : [];
                if (!ids.length) return;
                const soon = this.dueSoon(pa), at = pa.due.get(soon[0]);
                const sec = Math.round(pa.ms / 1000);
                out.push({ plugin: id, pluginName: name, key: 'every:' + i, what: pa.what, at, accounts: soon,
                    why: `each of ${ids.length} account${ids.length === 1 ? '' : 's'} every ${sec >= 120 ? Math.round(sec / 60) + ' min' : sec + ' s'}`, canRun: true, canSkip: true, each: true });
            });
        }
        return out;
    }

    // The accounts due next: the soonest one and any due within a minute of it.
    dueSoon(pa) {
        const ids = this.dueFor(pa);
        if (!ids.length) return [];
        const at = Math.min(...ids.map(aid => pa.due.get(aid)));
        return ids.filter(aid => pa.due.get(aid) - at < 60000).sort((x, y) => pa.due.get(x) - pa.due.get(y));
    }
    dueFor(pa) { return [...pa.due.keys()].filter(aid => { try { return !pa.only || !!pa.only(aid); } catch (_) { return false; } }); }

    // Run now / Skip next from the Schedule tab.
    async scheduleDo(id, key, op) {
        const p = this.plugins.get(id);
        if (!p || p.state !== 'running' || !p.res) return { ok: false, error: 'That plugin isn\'t running.' };
        if (String(key).startsWith('every:')) {
            const pa = p.res.perAccount[Number(String(key).slice(6))];
            if (!pa || !pa.due) return { ok: false, error: 'Nothing scheduled there now.' };
            const now = Date.now();
            for (const aid of this.dueSoon(pa)) pa.due.set(aid, op === 'run' ? now : Math.max(pa.due.get(aid), now) + pa.ms);
            return { ok: true };
        }
        const e = p.res.sched.get(String(key));
        const fn = e && (op === 'run' ? e.runNow : e.skip);
        if (!fn) return { ok: false, error: 'Nothing scheduled there now.' };
        try { const v = await fn(); return { ok: true, ...(v && typeof v === 'object' ? v : {}) }; }
        catch (err) { this.crashed(id, err); return { ok: false, error: err.message }; }
    }

    // Schedule tab "Now": what each plugin is doing on which accounts (their busy marks), and who's asking for them.
    activity() {
        const out = new Map();   // plugin -> { what -> [aid] }
        for (const [aid, m] of this.busy) for (const b of m.values()) {
            const k = b.plugin + '\u0000' + b.what;
            if (!out.has(k)) out.set(k, { plugin: b.plugin, pluginName: (this.plugins.get(b.plugin) || { manifest: {} }).manifest.name || b.plugin, what: b.what, since: b.at, accounts: [] });
            const o = out.get(k); o.accounts.push(aid); o.since = Math.min(o.since, b.at);
        }
        const wants = [];
        for (const [aid, m] of this.wants) for (const w of m.values()) wants.push({ plugin: w.plugin, pluginName: (this.plugins.get(w.plugin) || { manifest: {} }).manifest.name || w.plugin, what: w.what, since: w.at, account: aid });
        return { busy: [...out.values()], wants };
    }

    list() {
        return [...this.plugins.entries()].map(([id, p]) => ({
            id, name: p.manifest.name || id, version: p.manifest.version, description: p.manifest.description || '',
            bundled: p.bundled, verified: p.verified, state: p.state, error: p.error, removable: !p.bundled,
            enabled: this.cfg(id).enabled ?? !!p.manifest.defaultEnabled, tab: p.manifest.tab || null,
            settings: Object.entries(p.manifest.settings || {}).filter(([, spec]) => !spec.hidden).map(([key, spec]) => ({
                key, ...spec, value: ((this.cfg(id).settings || {})[key]) ?? settingDefault(spec),
                ...(spec.type === 'choice' ? { options: this.optionsFor(p, spec, key) } : {}),
                ...(spec.type === 'list' ? { fields: this.rowFields(p, spec.fields, key) } : {}),
            })),
        }));
    }

    // A list's fields, each dynamic choice with its options (set as 'list.field', or 'list.field.field' a level down).
    rowFields(p, fields, key) {
        return Object.fromEntries(Object.entries(fields || {}).map(([fk, fs]) => [fk, fs.type === 'choice' ? { ...fs, options: this.optionsFor(p, fs, key + '.' + fk) }
            : fs.type === 'list' ? { ...fs, fields: this.rowFields(p, fs.fields, key + '.' + fk) } : fs]));
    }

    async runAction(id, name, arg) {
        const p = this.plugins.get(id);
        const fn = p && p.res && p.res.actions[name];
        if (!fn || p.state !== 'running') return { ok: false, error: 'Not available' };
        try { const v = await fn(arg); return { ok: true, ...(v && typeof v === 'object' ? v : {}) }; }
        catch (e) { this.crashed(id, e); return { ok: false, error: e.message }; }
    }

    tabs() {
        const out = [];
        for (const [id, p] of this.plugins) {
            if (!p.res) continue;
            for (const t of p.res.tabs) {
                // A page that throws says so on the page (with Reload) instead of looking empty; logged once per message.
                let content = null, failed = null;
                try { content = t.render(); t.failed = null; }
                catch (e) { failed = String((e && e.message) || e).slice(0, 200); if (t.failed !== failed) this.crashed(id, e); t.failed = failed; }
                out.push({ plugin: id, title: t.title, group: t.group || p.manifest.group || null, content, ...(failed ? { failed } : {}) });
            }
        }
        return out;
    }

    // Themes from running plugins, and the one picked in Settings (null = the default look).
    themes() {
        const out = [];
        for (const [id, p] of this.plugins) if (p.res && p.res.theme) out.push({ id, name: p.manifest.name || id });
        return out;
    }
    theme() {
        const id = this.store.settings.theme, p = id && this.plugins.get(id);
        const t = p && p.res && p.res.theme;
        return t ? { id, name: p.manifest.name || id, ...t } : null;
    }

    badges(acctId) {
        const out = [];
        for (const p of this.plugins.values()) {
            if (!p.res) continue;
            for (const b of p.res.badges) { const v = b(acctId); if (v) out.push(String(v)); }
        }
        return out;
    }
}

module.exports = { PluginHost, digest, verify, newer };
