/**
 * STORE
 *
 * accounts.json and settings.json in the app's data folder. Writes go to a temp file first and
 * are renamed into place, so a crash or power cut mid-save can't leave a half-written file.
 *
 * An account: { id, name, token, userId, type: 'auto'|'money'|'cases'|'off' (off: on without clicking), addedAt, wasRunning, lastClickAt }
 * The id is 4 random hex chars — it's what reports show instead of the name.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const LOOK = require('../../panel/look.js');

const SETTINGS_DEFAULTS = {
    clicksPerBatch: 500,
    clickIntervalMs: 60000,
    vaultFallbackMs: 600000,     // until an account's first report gives its vault numbers
    reportMs: 240000,
    reportRetryMs: 10000,        // until an account's first report lands: retry after this, doubling up to reportMs
    maxPerIp: 20,                // the site's limit; can be lowered, never raised
    autoCasePct: 33.34,          // Auto clicks cases above this case click % (casesPerClick), money otherwise
    resumeOnLaunch: true,        // restart the accounts that were clicking when the app closed
    autoRecover: { slots: true, signIn: true, relaunch: true },   // engine.js top (slots, signIn); main.js watchdog (relaunch)
    startMinimized: false,
    startWithSystem: false,      // Windows only; on Linux the installer adds the autostart entry
    closeToTray: true,           // closing the window keeps clicking in the tray; false = closing quits
    trayHintShown: false,        // the "still running in the tray" notice was shown once
    allowUnverifiedPlugins: false,
    look: LOOK.clean(null),   // Settings > Look: accent preset or custom colours, background, text size, corners, spacing (panel/look.js)
    theme: null,                 // the plugin id whose panel theme is shown (Settings > Theme); null = default
    tourDone: false,             // the first-open walkthrough was seen (or skipped)
    lastVersion: null,           // the newest version whose What's new was shown
    shareStats: true,            // anonymous usage stats (src/core/stats.js); Settings shows exactly what
    shareMore: { system: false, health: false, clicking: false, plugins: false, log: false },   // extra diagnostics (stats.js), each its own switch
    shareName: '',               // optional name sent with the stats ('' = anonymous)
    shareAsked: false,           // the sharing walkthrough (new in 1.2.11) was answered
    installId: null,             // random, made on the first stats report; not tied to anything
    cleanOldSignIns: true,       // remove the hub's own superseded sign-ins from the site's session list
    testBuilds: false,           // also update to test builds (GitHub pre-releases, versions like 1.0.4-beta.1)
    main: null,                  // the player's main site account { userId, name, account? }: required before clicking (X-CC-Client main=)
    panelWeb: { enabled: false, port: 4201, password: '' },
    plugins: {},                 // id -> { enabled, settings }
    folders: [],                 // account folders, in display order: [{ id, name, collapsed }]; accounts point at one by .folder
};

const HARD_MAX_PER_IP = 20;

// The extra diagnostics a user can share (Settings and the sharing walkthrough), and the optional name.
const SHARE_KEYS = ['system', 'health', 'clicking', 'plugins', 'log'];
const NAME_OK = /^[\p{L}\p{N} _.'-]{1,32}$/u;
function cleanName(v) {
    const s = String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 32).trim();
    return NAME_OK.test(s) ? s : '';
}

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) {
        // Keep an unreadable file for a bug report rather than silently overwriting it.
        if (e.code !== 'ENOENT') { try { fs.copyFileSync(file, file + '.broken-' + Date.now()); } catch (_) {} }
        return fallback;
    }
}

function writeJson(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
}

// crypt seals tokens on disk ({ seal(str) -> str, unseal(str) -> str }); the app passes Electron's
// safeStorage (OS keychain). Without one, tokens are stored as they are.
const PLAIN = { seal: (s) => s, unseal: (s) => s };

class Store {
    constructor(dir, crypt = PLAIN) {
        this.dir = dir;
        this.crypt = crypt;
        fs.mkdirSync(dir, { recursive: true });
        this.accountsFile = path.join(dir, 'accounts.json');
        this.settingsFile = path.join(dir, 'settings.json');
        // Imported accounts also keep their sign-in (email + password) for re-logins: sealed the same way as the token.
        this.accounts = readJson(this.accountsFile, []).map(({ sealed, sealedLogin, ...a }) => {
            let token = a.token || null, login = null;
            if (sealed) { try { token = crypt.unseal(sealed); } catch (_) { token = null; } }   // other machine/user: log in again
            if (sealedLogin) { try { login = JSON.parse(crypt.unseal(sealedLogin)); } catch (_) { login = null; } }
            return { ...a, token, login };
        });
        const s = readJson(this.settingsFile, {});
        this.settings = { ...SETTINGS_DEFAULTS, ...s, panelWeb: { ...SETTINGS_DEFAULTS.panelWeb, ...(s.panelWeb || {}) },
            autoRecover: { ...SETTINGS_DEFAULTS.autoRecover, ...(s.autoRecover || {}) },
            shareMore: { ...SETTINGS_DEFAULTS.shareMore, ...(s.shareMore || {}) }, plugins: s.plugins || {}, folders: Array.isArray(s.folders) ? s.folders : [] };
        this.settings.maxPerIp = Math.min(HARD_MAX_PER_IP, Math.max(1, Number(this.settings.maxPerIp) || HARD_MAX_PER_IP));
        this._saveTimer = null;
    }

    saveAccounts() {
        writeJson(this.accountsFile, this.accounts.map(({ token, login, ...a }) => ({ ...a, ...(token ? { sealed: this.crypt.seal(token) } : {}), ...(login ? { sealedLogin: this.crypt.seal(JSON.stringify(login)) } : {}) })));
    }
    // Called on every click — batch the writes.
    saveAccountsSoon() {
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => { this._saveTimer = null; try { this.saveAccounts(); } catch (_) {} }, 5000);
    }
    saveSettings() { writeJson(this.settingsFile, this.settings); }

    get(id) { return this.accounts.find(a => a.id === id) || null; }

    // A login for an account that's already here (same site user) replaces its token instead of adding a duplicate.
    // Returns { account, replaced, oldPartition } — the caller forgets a login session that was replaced.
    upsert({ token, userId, name, partition }) {
        let a = userId ? this.accounts.find(x => x.userId === userId) : null;
        let oldPartition = null;
        const replaced = !!a;
        if (a) {
            a.token = token;
            if (name && a.name.startsWith('Account ')) a.name = name;
            if (partition && partition !== a.partition) { oldPartition = a.partition || null; a.partition = partition; }
        } else {
            let id; do { id = crypto.randomBytes(2).toString('hex'); } while (this.get(id));
            a = { id, name: name || 'Account ' + (this.accounts.length + 1), token, userId: userId || null, partition: partition || null,
                  type: 'auto', addedAt: Date.now(), wasRunning: false, lastClickAt: 0 };
            this.accounts.push(a);
        }
        this.saveAccounts();
        return { account: a, replaced, oldPartition };
    }

    // An imported account's sign-in, kept (sealed) for logging back in when its session ends.
    setLogin(id, login) {
        const a = this.get(id);
        if (!a) return null;
        a.login = login && login.email && login.password ? { email: String(login.email), password: String(login.password) } : null;
        this.saveAccounts();
        return a;
    }

    setToken(id, token, partition) {
        const a = this.get(id);
        if (!a) return null;
        a.token = token;
        if (partition) a.partition = partition;
        this.saveAccounts();
        return a;
    }

    update(id, patch) {
        const a = this.get(id);
        if (!a) return null;
        if (patch.name != null) a.name = String(patch.name).trim().slice(0, 40) || a.name;
        if (['auto', 'money', 'cases', 'off'].includes(patch.type)) a.type = patch.type;
        this.saveAccounts();
        return a;
    }

    remove(id) {
        this.accounts = this.accounts.filter(a => a.id !== id);
        this.saveAccounts();
    }

    // --- order and folders -------------------------------------------------------------
    // The accounts' order is their order in accounts.json. move() puts one just before another (or last) and into
    // a folder (null = none); the panel shows each folder's accounts in that same order.
    move(id, { before = null, folder } = {}) {
        const a = this.get(id);
        if (!a) return null;
        if (folder !== undefined) a.folder = folder && this.folder(folder) ? folder : null;
        if (before !== id) {
            this.accounts = this.accounts.filter(x => x !== a);
            const at = before ? this.accounts.findIndex(x => x.id === before) : -1;
            this.accounts.splice(at < 0 ? this.accounts.length : at, 0, a);
        }
        this.saveAccounts();
        return a;
    }

    get folders() { return Array.isArray(this.settings.folders) ? this.settings.folders : (this.settings.folders = []); }
    folder(fid) { return this.folders.find(f => f.id === fid) || null; }

    addFolder(name) {
        let id; do { id = 'f' + crypto.randomBytes(2).toString('hex'); } while (this.folder(id));
        const f = { id, name: String(name || '').trim().slice(0, 40) || 'Folder ' + (this.folders.length + 1), collapsed: false };
        this.folders.push(f);
        this.saveSettings();
        return f;
    }

    updateFolder(fid, patch) {
        const f = this.folder(fid);
        if (!f) return null;
        if (patch.name != null) f.name = String(patch.name).trim().slice(0, 40) || f.name;
        if (patch.collapsed != null) f.collapsed = !!patch.collapsed;
        this.saveSettings();
        return f;
    }

    // Before another folder, or last.
    moveFolder(fid, before = null) {
        const f = this.folder(fid);
        if (!f || before === fid) return f;
        const rest = this.folders.filter(x => x !== f);
        const at = before ? rest.findIndex(x => x.id === before) : -1;
        rest.splice(at < 0 ? rest.length : at, 0, f);
        this.settings.folders = rest;
        this.saveSettings();
        return f;
    }

    // Its accounts stay, out of any folder.
    removeFolder(fid) {
        if (!this.folder(fid)) return false;
        this.settings.folders = this.folders.filter(f => f.id !== fid);
        let moved = false;
        for (const a of this.accounts) if (a.folder === fid) { a.folder = null; moved = true; }
        this.saveSettings();
        if (moved) this.saveAccounts();
        return true;
    }

    setSettings(patch) {
        const s = this.settings;
        if (patch.maxPerIp != null) s.maxPerIp = Math.min(HARD_MAX_PER_IP, Math.max(1, parseInt(patch.maxPerIp) || HARD_MAX_PER_IP));
        if (patch.resumeOnLaunch != null) s.resumeOnLaunch = !!patch.resumeOnLaunch;
        if (patch.autoCasePct != null) { const v = Number(patch.autoCasePct); if (v >= 0 && v <= 100) s.autoCasePct = v; }
        if (patch.startMinimized != null) s.startMinimized = !!patch.startMinimized;
        if (patch.startWithSystem != null) s.startWithSystem = !!patch.startWithSystem;
        if (patch.closeToTray != null) s.closeToTray = !!patch.closeToTray;
        if (patch.allowUnverifiedPlugins != null) s.allowUnverifiedPlugins = !!patch.allowUnverifiedPlugins;
        if (patch.look !== undefined) s.look = LOOK.clean(patch.look);
        if (patch.theme !== undefined) s.theme = typeof patch.theme === 'string' && /^[a-z0-9-]+$/.test(patch.theme) ? patch.theme : null;
        if (patch.tourDone != null) s.tourDone = !!patch.tourDone;
        if (patch.shareStats != null) s.shareStats = !!patch.shareStats;
        if (patch.shareMore && typeof patch.shareMore === 'object') {
            for (const k of SHARE_KEYS) if (patch.shareMore[k] != null) s.shareMore = { ...s.shareMore, [k]: !!patch.shareMore[k] };
        }
        if (patch.shareName != null) s.shareName = cleanName(patch.shareName);
        if (patch.shareAsked != null) s.shareAsked = !!patch.shareAsked;
        if (patch.cleanOldSignIns != null) s.cleanOldSignIns = !!patch.cleanOldSignIns;
        if (patch.autoRecover && typeof patch.autoRecover === 'object') {
            for (const k of Object.keys(SETTINGS_DEFAULTS.autoRecover)) if (patch.autoRecover[k] != null) s.autoRecover[k] = !!patch.autoRecover[k];
        }
        if (patch.testBuilds != null) s.testBuilds = !!patch.testBuilds;
        if (typeof patch.lastVersion === 'string') s.lastVersion = patch.lastVersion;
        if (patch.main && /^[0-9a-f]{24}$/i.test(patch.main.userId || '')) s.main = { userId: patch.main.userId, name: patch.main.name || null, account: patch.main.account || null };
        if (patch.panelWeb) {
            const w = patch.panelWeb;
            if (w.enabled != null) s.panelWeb.enabled = !!w.enabled;
            if (w.port != null) { const p = parseInt(w.port); if (p >= 1024 && p <= 65535) s.panelWeb.port = p; }
            if (w.password != null) s.panelWeb.password = String(w.password);
        }
        this.saveSettings();
        return s;
    }
}

module.exports = { Store, SETTINGS_DEFAULTS, HARD_MAX_PER_IP, SHARE_KEYS, cleanName };
