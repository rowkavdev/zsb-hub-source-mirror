/**
 * UPDATES (Windows, installed app)
 *
 * Checks the public releases repo (package.json build.publish) a little after start and every
 * 4 hours, and downloads a new version in the background. Nothing restarts by itself: the panel
 * shows "Update ready" with a button, and if it's never pressed the update installs the next time
 * the app quits. Accounts that were clicking start again after the restart (resume on launch).
 *
 * Test builds: with settings.testBuilds on, GitHub pre-releases (1.0.4-beta.1) count as updates too.
 * Turning it off never goes back down — a test build stays until a newer normal release comes out.
 *
 * state(): { status: 'off' | 'idle' | 'checking' | 'none' | 'downloading' | 'ready' | 'error',
 *            version, percent, checkedAt, error, current }
 */

const { app } = require('electron');

const FIRST_CHECK_MS = 20 * 1000;
const EVERY_MS = 4 * 60 * 60 * 1000;

function createUpdater({ log, onChange, onReady, beforeInstall, testBuilds = () => false }) {
    let st = { status: 'idle', current: app.getVersion() };
    const set = (patch) => { st = { ...st, ...patch }; onChange(); };

    // Linux installs (install.sh) have their own updater; from source it's off.
    if (app.isPackaged && process.platform === 'linux') {
        // (Not package.json "build": electron-builder leaves that out of the packaged app.)
        const { releasesRepo } = require('../../package.json');
        return require('./updater-linux').createLinuxUpdater({ log, onChange, onReady, beforeInstall, testBuilds, repo: releasesRepo });
    }
    if (!app.isPackaged || process.platform !== 'win32') {
        st.status = 'off';
        return { state: () => st, check: () => ({ ok: false, error: 'Updates are off here' }), install: () => ({ ok: false }) };
    }

    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;

    autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }));
    autoUpdater.on('update-not-available', () => set({ status: 'none', checkedAt: Date.now() }));
    autoUpdater.on('update-available', (i) => { set({ status: 'downloading', version: i.version, percent: 0, checkedAt: Date.now() }); log.add(null, `Update ${i.version} found — downloading`); });
    autoUpdater.on('download-progress', (p) => set({ percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (i) => { set({ status: 'ready', version: i.version, percent: 100 }); log.add(null, `Update ${i.version} is ready — it installs when the app restarts`, 'ok'); onReady(i.version); });
    autoUpdater.on('error', (e) => {
        // Offline or GitHub hiccups are normal; the next check tries again. Keep the message for Settings.
        set({ status: 'error', error: String((e && e.message) || e).split('\n')[0].slice(0, 160), checkedAt: Date.now() });
        log.add(null, 'Update check failed: ' + st.error, 'warn');
    });

    let busy = false;
    async function check() {
        if (busy || st.status === 'downloading' || st.status === 'ready') return { ok: true, status: st.status };
        busy = true;
        autoUpdater.allowPrerelease = !!testBuilds();
        autoUpdater.allowDowngrade = false;
        try { await autoUpdater.checkForUpdates(); } catch (_) { /* reported through 'error' */ }
        finally { busy = false; }
        return { ok: true, status: st.status };
    }

    setTimeout(check, FIRST_CHECK_MS);
    setInterval(check, EVERY_MS);

    function install() {
        if (st.status !== 'ready') return { ok: false, error: 'No update is ready' };
        beforeInstall();
        // Silent install, then start the app again.
        setTimeout(() => autoUpdater.quitAndInstall(true, true), 200);
        return { ok: true };
    }

    return { state: () => st, check, install };
}

module.exports = { createUpdater };
