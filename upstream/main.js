/**
 * ZSB Hub — Electron entry point.
 *
 * One window (the panel), a tray icon, the Cloudflare check window and login windows when needed.
 * Closing the panel keeps the clicker running in the tray; Quit stops it.
 */

const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage, safeStorage, clipboard, net } = require('electron');
const path = require('path');
const { createCore } = require('./src/core');
const { createTransport, tagSession, setClient, currentClient } = require('./src/app/transport');
const { createAuth } = require('./src/app/auth');
const { startWebPanel } = require('./src/app/web');
const { createUpdater } = require('./src/app/updater');
const { createSockets } = require('./src/app/sockets');
const dev = require('./src/app/dev');
const { t } = require('./src/core/text');

const { version: VERSION, releaseStage: STAGE, statsUrl: STATS_URL, pluginCatalogUrl: CATALOG_URL } = require('./package.json');

if (!app.requestSingleInstanceLock()) { app.quit(); return; }
// Same id as the installer's Start-menu shortcut: Windows only shows notifications for a matching app id.
if (process.platform === 'win32') app.setAppUserModelId('com.gothgirlzsb.clicker');

// Look like plain Chrome to the site: drop "Electron/x" and the app's own name/version from the user agent.
const uaName = app.getName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
app.userAgentFallback = app.userAgentFallback.replace(/Electron\/\S+\s/, '').replace(new RegExp(uaName + '\\/\\S+\\s'), '');

// Every session the app makes (API, check and login windows) names the hub on requests to the site (X-CC-Client).
app.on('session-created', tagSession);

let win = null, tray = null, core = null, transport = null, web = null, updater = null, quitting = false;

// Anything that goes wrong outside a handler lands in the log (and so in "Copy report") instead of
// vanishing — before the log exists, straight into the log file.
function crashed(kind, e) {
    const msg = `${kind}: ${(e && e.stack) || e}`;
    if (core) { core.log.add(null, msg, 'error'); return; }
    try {
        const dir = path.join(app.getPath('userData'), 'logs');
        require('fs').mkdirSync(dir, { recursive: true });
        require('fs').appendFileSync(path.join(dir, 'clicker.log'), new Date().toISOString() + ' ERROR ' + msg + '\n');
    } catch (_) {}
}
process.on('uncaughtException', (e) => crashed('Uncaught error', e));
process.on('unhandledRejection', (e) => crashed('Unhandled rejection', e));

// Tray / window icon drawn in code: a filled circle in the status colour.
function dot(hex) {
    const size = 32, buf = Buffer.alloc(size * size * 4);
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const d = Math.hypot(x - 15.5, y - 15.5), a = Math.max(0, Math.min(1, 13.5 - d));
        const o = (y * size + x) * 4;
        buf[o] = b; buf[o + 1] = g; buf[o + 2] = r; buf[o + 3] = Math.round(a * 255);   // BGRA
    }
    return nativeImage.createFromBitmap(buf, { width: size, height: size });
}
const ICONS = {};
const icon = (state) => ICONS[state] || (ICONS[state] = dot({ ok: '#3fb950', warn: '#d29922', bad: '#f85149', idle: '#8b949e' }[state]));

function showPanel() {
    if (!win || win.isDestroyed()) createWindow();
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
}

function createWindow() {
    win = new BrowserWindow({
        width: 1180, height: 820, minWidth: 420, minHeight: 500, title: t('app.name'),   // no icon: Windows uses the app's own (build/icon.png)
        backgroundColor: '#000000', autoHideMenuBar: true, show: !core.store.settings.startMinimized,
        webPreferences: { preload: path.join(__dirname, 'src', 'app', 'preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    win.loadFile(path.join(__dirname, 'panel', 'index.html'));
    win.on('close', (e) => {
        if (quitting) return;
        // "Keep clicking in the tray" off: closing the window is quitting.
        if (!core.store.settings.closeToTray) { quit(); return; }
        e.preventDefault();
        // Some Linux desktops have no tray: minimise there so the window can always be found again.
        if (process.platform === 'linux' && !tray) { win.minimize(); return; }
        win.hide();
        // The first time, say where it went.
        if (!core.store.settings.trayHintShown && Notification.isSupported()) {
            new Notification({ title: t('notify.tray.title'), body: t('notify.tray.body') }).show();
            core.store.settings.trayHintShown = true; core.store.saveSettings();
        }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function quit() { quitting = true; app.quit(); }

function setupTray() {
    try { tray = new Tray(icon('ok')); } catch (_) { tray = null; return; }
    tray.setToolTip(t('app.name'));
    tray.on('click', showPanel);
    const menu = () => Menu.buildFromTemplate([
        { label: t('tray.open'), click: showPanel },
        { type: 'separator' },
        { label: t('tray.startAll'), click: () => core.rpc.startAll() },
        { label: t('tray.stopAll'), click: () => core.rpc.stopAll() },
        { type: 'separator' },
        { label: t('tray.quit'), click: quit },
    ]);
    tray.setContextMenu(menu());
}

// Tray colour + tooltip, and a desktop notification when something needs the user.
let notified = new Set();
function onChange() {
    const s = core.rpc.state();
    const needs = s.appIssues.filter(i => i.code === 'CC-CF-01').concat(s.accounts.flatMap(a => a.issues.filter(i => i.code === 'CC-AUTH-01')));
    const bad = s.accounts.some(a => a.status === 'logged-out' || a.status === 'problem') || s.appIssues.length;
    const state = needs.length ? 'warn' : bad ? 'bad' : s.running ? 'ok' : 'idle';
    if (tray) {
        tray.setImage(icon(state));
        tray.setToolTip(t(needs.length ? 'tray.tooltip.needs' : 'tray.tooltip', { clicking: s.totals.clicking, total: s.accounts.length }));
    }
    const keys = new Set(needs.map(i => i.code + '|' + (i.acct || '')));
    for (const k of keys) {
        if (notified.has(k) || !Notification.isSupported()) continue;
        const [code, acct] = k.split('|');
        const name = acct ? (s.accounts.find(a => a.id === acct) || {}).name : null;
        const n = new Notification({ title: t('notify.needs.title'), body: code === 'CC-CF-01' ? t('notify.needs.cf') : t('notify.needs.auth', { name: name || '' }) });
        // A Cloudflare check belongs to a connection: a proxy's ('route:<id>') or this PC's.
        n.on('click', () => (code === 'CC-CF-01' ? transport.openCheck(acct && acct.startsWith('route:') ? acct.slice(6) : 'direct') : showPanel()));
        n.show();
    }
    notified = keys;
    // The check window goes away once requests get through again.
    if (!s.appIssues.some(i => i.code === 'CC-CF-01') && transport.state().cleared) transport.hide();
}

// The Windows installer's "how it runs" page leaves its choices in install-options.json in the
// data folder. Applied once, on the first start after an install, then deleted.
function applyInstallerChoices(dataDir) {
    const file = path.join(dataDir, 'install-options.json');
    let o;
    try { o = JSON.parse(require('fs').readFileSync(file, 'utf8')); } catch (_) { return; }
    try { require('fs').unlinkSync(file); } catch (_) {}
    const patch = {};
    if (typeof o.startWithSystem === 'boolean') patch.startWithSystem = o.startWithSystem;
    if (typeof o.closeToTray === 'boolean') patch.closeToTray = o.closeToTray;
    core.store.setSettings(patch);
    if (process.platform === 'win32' && 'startWithSystem' in patch) app.setLoginItemSettings({ openAtLogin: patch.startWithSystem, args: ['--hidden'] });
    core.log.add(null, 'Installer choices applied: start with Windows ' + (patch.startWithSystem ? 'on' : 'off') + ', keep clicking when closed ' + (patch.closeToTray === false ? 'off' : 'on'));
}

// safeStorage seals tokens with the OS keychain (DPAPI on Windows, the keyring on Linux).
// Usage stats go out on the default session: no site cookies or logins come along.
async function postStats(url, body) {
    const res = await net.fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000) });
    return res.ok;
}

// For the optional system / health diagnostics (Settings > share more): only read when those are on.
function statsSystem() {
    let keyring = null;
    try { if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend) keyring = safeStorage.getSelectedStorageBackend(); } catch (_) {}
    return {
        packaged: app.isPackaged, sealed: safeStorage.isEncryptionAvailable(), keyring,
        // The whole app's memory (main, window, helpers) in MB.
        metrics: () => app.getAppMetrics().reduce((n, m) => n + ((m.memory && m.memory.workingSetSize) || 0), 0) / 1024,
    };
}

function keychain() {
    if (!safeStorage.isEncryptionAvailable()) return undefined;
    return {
        seal: (s) => safeStorage.encryptString(s).toString('base64'),
        unseal: (s) => safeStorage.decryptString(Buffer.from(s, 'base64')),
    };
}

// The app was called "Clicker" before (0.1.x, data in %APPDATA%\Clicker). On the first start under the
// new name, copy that data over — accounts, saved logins, settings — leaving the browser caches behind.
function migrateFromClicker(dataDir) {
    const fs = require('fs');
    const old = path.join(app.getPath('appData'), 'Clicker');
    if (app.getName() !== 'ZSB Hub') return false;   // test builds ("Clicker Test") never touch a real install's data
    if (dataDir !== path.join(app.getPath('appData'), app.getName())) return false;   // a test's own data folder
    if (!fs.existsSync(path.join(old, 'accounts.json')) || fs.existsSync(path.join(dataDir, 'accounts.json'))) return false;
    const skip = /[\\/](Cache|Code Cache|GPUCache|DawnGraphiteCache|DawnWebGPUCache|Service Worker|blob_storage|Crashpad)([\\/]|$)/;
    fs.cpSync(old, dataDir, { recursive: true, force: false, filter: (src) => !skip.test(src) });
    return true;
}

app.whenReady().then(() => {
    const dataDir = app.getPath('userData');
    tagSession(require('electron').session.defaultSession);
    let migrated = false;
    try { migrated = migrateFromClicker(dataDir); } catch (_) {}
    let log = null;
    transport = createTransport({ log: { add: (...a) => log && log.add(...a) } });
    const auth = createAuth({ transport, log: { add: (...a) => log && log.add(...a) } });
    core = createCore({ version: VERSION, dataDir, bundledPluginsDir: path.join(__dirname, 'plugins'), transport, auth, crypt: keychain(),
        stats: { url: dev.STATS_URL ?? STATS_URL ?? '', post: postStats, timing: dev.STATS_TIMING || undefined, ...statsSystem() },
        catalogUrl: dev.CATALOG_URL ?? CATALOG_URL ?? null,
        sockets: createSockets({ partition: 'persist:cc', evalInWindow: transport.evalInWindow, prepareWindow: transport.ready, log: { add: (...a) => log && log.add(...a) }, client: currentClient }) });
    setClient(() => core.site.clientId());
    log = core.log;
    if (migrated) core.log.add(null, 'Moved accounts and settings over from Clicker', 'ok');
    core.log.add(null, `Starting ${VERSION}` + (process.argv.includes('--updated') ? ' (just updated)' : '') + (process.argv.includes('--hidden') ? ' (at sign-in)' : ''));
    if (dev.FAST) Object.assign(core.store.settings, dev.FAST, { startMinimized: true });

    updater = createUpdater({
        log: core.log,
        onChange: () => core.engine.emit('change'),
        onReady: (version) => { if (Notification.isSupported()) new Notification({ title: t('notify.update.title'), body: t('notify.update.body', { version }) }).show(); },
        beforeInstall: () => { quitting = true; },
        testBuilds: () => core.store.settings.testBuilds,
    });

    // The panel's one entry point: every method in core.rpc, plus the window-only ones.
    const rpc = {
        ...core.rpc,
        state: () => ({ ...core.rpc.state(), stage: STAGE || null, update: updater.state(), check: transport.state() }),
        checkUpdates: () => updater.check(),
        installUpdate: () => updater.install(),
        openCheck: (route) => { transport.openCheck(typeof route === 'string' && route ? route : undefined); return { ok: true }; },
        copyReport: () => { clipboard.writeText(core.rpc.report()); return { ok: true }; },
        openDataFolder: () => { require('electron').shell.openPath(dataDir); return { ok: true }; },
        quit: () => { setTimeout(quit, 100); return { ok: true }; },
        setSettings: (patch) => {
            const out = core.rpc.setSettings(patch);
            if (process.platform === 'win32' && patch && patch.startWithSystem != null) app.setLoginItemSettings({ openAtLogin: !!patch.startWithSystem, args: ['--hidden'] });
            if (patch && patch.panelWeb) restartWeb();
            if (patch && patch.testBuilds) updater.check();   // turned on: look for a test build now
            return out;
        },
        // The end-to-end test's way to close the app the same way the tray's Quit does.
        ...(dev.E2E ? { e2eQuit: () => { setTimeout(quit, 100); return { ok: true }; } } : {}),
    };
    ipcMain.handle('rpc', async (_e, method, args) => {
        if (!Object.prototype.hasOwnProperty.call(rpc, method)) return { ok: false, error: 'Unknown method ' + method };
        try { return await rpc[method](...(args || [])); }
        catch (e) { core.log.add(null, method + ' failed: ' + e.message, 'error'); return { ok: false, error: e.message }; }
    });

    function restartWeb() {
        if (web) { web.close(); web = null; }
        const w = dev.PANEL ? { enabled: true, ...dev.PANEL } : core.store.settings.panelWeb;
        if (!w.enabled) return;
        if (!w.password) { core.log.add(null, 'Browser panel needs a password before it turns on', 'warn'); return; }
        // From a browser, window-only actions still act on this machine's desktop (e.g. a VPS desktop).
        web = startWebPanel({ port: w.port, password: w.password, rpc, panelDir: path.join(__dirname, 'panel'), log: core.log });
    }

    applyInstallerChoices(dataDir);
    if (process.argv.includes('--hidden')) core.store.settings.startMinimized = true;
    createWindow();
    setupTray();
    let pending = null;
    core.engine.on('change', () => { if (!pending) pending = setTimeout(() => { pending = null; onChange(); }, 300); });
    core.boot();
    // Source runs only, with CLICKER_DEV_CMD=1: <data>/dev-cmd.json { rpc, args } calls one panel function and writes
    // the answer to dev-out.json, so a test hub can be driven without its panel password. Packaged builds never do this.
    if (!app.isPackaged && process.env.CLICKER_DEV_CMD === '1') {
        const fs = require('fs'), cmdF = path.join(dataDir, 'dev-cmd.json'), outF = path.join(dataDir, 'dev-out.json');
        // devAddSessions(file): a JSON list [{ email, password, token }] (the file is deleted once read) of accounts already
        // signed in elsewhere (moving a hub's accounts to this one): each token is checked with the site, and a working
        // one is added and started like an imported account. Answers counts and the emails that didn't work, never tokens.
        // devReimport(ids): removes these accounts and starts the normal Import with their stored logins, to watch an
        // import from scratch. Their click type, folder, place and plugin account lists are remembered (in memory, by
        // email) for devReimportRestore(). Answers counts only, never a login.
        let reimportMemo = null;
        const devReimport = async (ids) => {
            const memo = new Map(), lines = [];
            const plugs = core.plugins.list();
            for (const id of ids) {
                const a = core.store.get(id);
                if (!a || !a.login || !a.login.email || !a.login.password) continue;
                const lists = [];
                for (const p of plugs) for (const st of (p.settings || [])) if (st.value && Array.isArray(st.value.ids) && st.value.ids.includes(id)) lists.push([p.id, st.key]);
                const i = core.store.accounts.findIndex(x => x.id === id), next = core.store.accounts[i + 1];
                memo.set(a.login.email, { old: id, type: a.type, folder: a.folder || null, before: next ? next.id : null, lists });
                lines.push(a.login.email + ':' + a.login.password);
            }
            for (const m of memo.values()) await core.rpc.remove(m.old);
            reimportMemo = memo;
            const r = core.rpc.importStart(lines.join(String.fromCharCode(10)));
            return { removed: memo.size, importStarted: !!(r && r.ok !== false) };
        };
        // devReimportRestore(): puts each re-imported account back how it was (by email): click type, folder and place, and
        // into the plugin account lists it was on.
        const devReimportRestore = () => {
            if (!reimportMemo) return { error: 'nothing to restore' };
            const res = { restored: 0, missing: 0 };
            for (const [email, m] of reimportMemo) {
                const a = core.store.accounts.find(x => x.login && x.login.email === email);
                if (!a) { res.missing++; continue; }
                if (m.type) core.rpc.setType(a.id, m.type);
                core.rpc.moveAccount(a.id, { before: core.store.get(m.before) ? m.before : null, folder: m.folder });
                for (const [pid, key] of m.lists) {
                    const st = (core.plugins.list().find(p => p.id === pid).settings || []).find(x => x.key === key);
                    const ids = (st.value.ids || []).filter(x => x !== m.old);
                    if (!ids.includes(a.id)) ids.push(a.id);
                    core.rpc.pluginSetting(pid, key, { ...st.value, ids });
                }
                res.restored++;
            }
            reimportMemo = null;
            return res;
        };
        const devAddSessions = async (file) => {
            const list = JSON.parse(fs.readFileSync(file, 'utf8')); fs.unlinkSync(file);
            const crypto = require('crypto'), res = { added: 0, already: 0, bad: [] };
            const known = new Set(core.store.accounts.map(x => x.login && x.login.email).filter(Boolean));
            for (const { email, password, token } of list) {
                if (known.has(email) || core.rpc.importPreview(email + ':x').found.some(x => x.already)) { res.already++; continue; }
                const g = await transport.request({ path: '/api/auth/get-session', token, timeoutMs: 15000, route: 'direct' }).catch(() => ({}));
                const user = (g.status === 200 && g.json && g.json.user) || null;
                if (!user || !user.id) { res.bad.push({ email, why: 'session not accepted (HTTP ' + (g.status || '-') + ')' }); continue; }
                const { account } = core.store.upsert({ ok: true, token, partition: 'persist:login-' + crypto.randomBytes(4).toString('hex'), userId: user.id, name: typeof user.name === 'string' && user.name.trim() ? user.name.trim().slice(0, 40) : null });
                core.store.setLogin(account.id, { email, password });
                core.log.add(account.id, 'Added from a signed-in session', 'ok');
                core.engine.loggedIn(account.id);
                if (!core.engine.isRunning(account.id)) core.engine.start(account.id);
                res.added++;
            }
            return res;
        };
        setInterval(async () => {
            if (!fs.existsSync(cmdF)) return;
            let out;
            try { const c = JSON.parse(fs.readFileSync(cmdF, 'utf8')); fs.unlinkSync(cmdF); out = { t: new Date().toISOString(), rpc: c.rpc, result: c.rpc === 'devAddSessions' ? await devAddSessions(c.args[0])
                : c.rpc === 'devReimport' ? await devReimport(c.args[0] || [])
                : c.rpc === 'devReimportRestore' ? devReimportRestore()
                // devEmails(): which account is which sign-in ([{ id, email }]), to match them with another hub's list.
                // devProcs(): every process (type, MB) and every page (what it shows, its process, JS heap, DOM size).
                : c.rpc === 'devProcs' ? await (async () => {
                    const { webContents } = require('electron');
                    const procs = app.getAppMetrics().map(m => ({ pid: m.pid, type: m.type, name: m.name || '', mb: Math.round(m.memory.workingSetSize / 1024), privMb: Math.round((m.memory.privateBytes || 0) / 1024) }));
                    const pages = await Promise.all(webContents.getAllWebContents().map(async w => {
                        let js = null; try { js = await Promise.race([w.executeJavaScript('({heap:Math.round(performance.memory.usedJSHeapSize/1048576),dom:document.getElementsByTagName("*").length,scripts:document.scripts.length,title:document.title.slice(0,40)})'), new Promise(r => setTimeout(() => r(null), 3000))]); } catch (_) {}
                        let u = ''; try { const x = new URL(w.getURL()); u = x.host + x.pathname; } catch (_) { u = w.getURL().slice(0, 40); }
                        return { id: w.id, type: w.getType(), url: u, pid: w.getOSProcessId(), partition: (w.session && w.session.storagePath ? require('path').basename(w.session.storagePath) : ''), visible: !!(w.getOwnerBrowserWindow && w.getOwnerBrowserWindow() && w.getOwnerBrowserWindow().isVisible()), ...(js || {}) };
                    }));
                    return { procs, pages };
                })()
                : c.rpc === 'devEmails' ? core.store.accounts.map(a => ({ id: a.id, email: (a.login && a.login.email) || null }))
                : await core.rpc[c.rpc](...(c.args || [])) }; }
            catch (e) { try { fs.unlinkSync(cmdF); } catch (_) {} out = { error: String(e && e.message || e) }; }
            fs.writeFileSync(outF, JSON.stringify(out, null, 1));
        }, 1000);
    }
    auth.trimAll(core.store.accounts.map(a => a.partition)).catch(() => {});
    restartWeb();
    onChange();
});

app.on('second-instance', () => showPanel());
app.on('before-quit', () => { quitting = true; if (core) core.shutdown(); if (transport) transport.close(); if (web) web.close(); });
// Closing every window doesn't quit: the clicker lives in the tray.
app.on('window-all-closed', () => {});
