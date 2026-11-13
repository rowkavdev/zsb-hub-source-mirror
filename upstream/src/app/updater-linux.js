/**
 * UPDATES (Linux, installed by install.sh)
 *
 * Same behaviour as Windows: check a little after start and every 4 hours, download in the
 * background, never restart by itself. The new version is unpacked into
 * ~/.local/share/zsb-hub/update/app with a "ready" file; the launcher (~/.local/bin/zsb-hub)
 * switches to it the next time the app starts. "Restart to update" quits with code 75, which the
 * launcher reads as "apply the update and start again".
 *
 * Only when started by that launcher (ZSB_HUB_LAUNCHER=1) from ~/.local/share/zsb-hub/app;
 * anything else (from source, unpacked by hand) is 'off'.
 * Test builds: with settings.testBuilds on, GitHub pre-releases count too.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');
const { execFile } = require('child_process');
const { app } = require('electron');

const FIRST_CHECK_MS = 20 * 1000;
const EVERY_MS = 4 * 60 * 60 * 1000;
const ASSET = 'ZSB-Hub-linux-x64.tar.gz';
const RESTART_CODE = 75;

// "1.0.10" > "1.0.9"; a test build 1.0.4-beta.2 sits before 1.0.4 and after 1.0.4-beta.1.
function cmpVersion(a, b) {
    const [ma, pa = ''] = String(a).replace(/^v/, '').split('-'), [mb, pb = ''] = String(b).replace(/^v/, '').split('-');
    const x = ma.split('.').map(Number), y = mb.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
    if (pa === pb) return 0;
    if (!pa) return 1;
    if (!pb) return -1;
    const na = Number((/\d+$/.exec(pa) || [0])[0]), nb = Number((/\d+$/.exec(pb) || [0])[0]);
    return na - nb;
}

function createLinuxUpdater({ log, onChange, onReady, beforeInstall, testBuilds = () => false, repo, fetch: fetchFn = globalThis.fetch, home = process.env.HOME }) {
    const root = path.join(home || '', '.local', 'share', 'zsb-hub');
    let st = { status: 'idle', current: app.getVersion() };
    const set = (patch) => { st = { ...st, ...patch }; onChange(); };

    const exe = process.execPath;
    if (process.env.ZSB_HUB_LAUNCHER !== '1' || path.dirname(exe) !== path.join(root, 'app')) {
        st.status = 'off';
        return { state: () => st, check: () => ({ ok: false, error: 'Updates are off here' }), install: () => ({ ok: false }) };
    }

    const gh = (p) => fetchFn('https://api.github.com/repos/' + repo + p, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'zsb-hub' } })
        .then(r => { if (!r.ok) throw new Error('GitHub answered ' + r.status); return r.json(); });

    // The newest release this install takes: normal ones, plus pre-releases with test builds on.
    async function newest() {
        if (!testBuilds()) return gh('/releases/latest');
        const list = await gh('/releases?per_page=20');
        return list.filter(r => !r.draft).sort((a, b) => cmpVersion(b.tag_name, a.tag_name))[0];
    }

    async function download(url, file, onPercent) {
        const res = await fetchFn(url, { headers: { 'user-agent': 'zsb-hub' } });
        if (!res.ok) throw new Error('download answered ' + res.status);
        const total = Number(res.headers.get('content-length')) || 0;
        const hash = crypto.createHash('sha256');
        let got = 0, lastPct = -1;
        await pipeline(Readable.fromWeb(res.body), new Transform({
            transform(chunk, _e, cb) {
                hash.update(chunk); got += chunk.length;
                const pct = total ? Math.floor(got / total * 100) : 0;
                if (pct !== lastPct) { lastPct = pct; onPercent(pct); }
                cb(null, chunk);
            },
        }), fs.createWriteStream(file));
        return hash.digest('hex');
    }

    const untar = (file, dir) => new Promise((resolve, reject) => execFile('tar', ['-xzf', file, '-C', dir], (e) => (e ? reject(e) : resolve())));

    let busy = false;
    async function check() {
        if (busy || st.status === 'downloading' || st.status === 'ready') return { ok: true, status: st.status };
        busy = true;
        set({ status: 'checking', error: null });
        const upd = path.join(root, 'update'), work = path.join(root, 'update.tmp');
        try {
            const rel = await newest();
            const version = rel && String(rel.tag_name).replace(/^v/, '');
            if (!rel || cmpVersion(version, st.current) <= 0) { set({ status: 'none', checkedAt: Date.now() }); return { ok: true, status: st.status }; }
            const asset = (rel.assets || []).find(a => a.name === ASSET), sum = (rel.assets || []).find(a => a.name === ASSET + '.sha256');
            if (!asset || !sum) { set({ status: 'none', checkedAt: Date.now() }); return { ok: true, status: st.status }; }   // a release without a Linux build
            set({ status: 'downloading', version, percent: 0, checkedAt: Date.now() });
            log.add(null, `Update ${version} found — downloading`);
            fs.rmSync(work, { recursive: true, force: true });
            fs.mkdirSync(work, { recursive: true });
            const want = (await (await fetchFn(sum.browser_download_url, { headers: { 'user-agent': 'zsb-hub' } })).text()).trim().split(/\s+/)[0];
            const file = path.join(work, ASSET);
            const have = await download(asset.browser_download_url, file, (percent) => set({ percent }));
            if (have !== want) throw new Error('the download is damaged (checksum)');
            const x = path.join(work, 'x');
            fs.mkdirSync(x);
            await untar(file, x);
            const inner = fs.readdirSync(x).map(n => path.join(x, n)).find(p => fs.statSync(p).isDirectory());
            if (!inner || !fs.existsSync(path.join(inner, 'zsb-hub'))) throw new Error('the download is not ZSB Hub');
            // Built on Windows, so the archive has no executable marks.
            for (const f of ['zsb-hub', 'chrome_crashpad_handler']) { try { fs.chmodSync(path.join(inner, f), 0o755); } catch (_) {} }
            fs.rmSync(upd, { recursive: true, force: true });
            fs.mkdirSync(upd, { recursive: true });
            fs.renameSync(inner, path.join(upd, 'app'));
            fs.writeFileSync(path.join(upd, 'ready'), version + '\n');
            set({ status: 'ready', version, percent: 100 });
            log.add(null, `Update ${version} is ready — it installs when the app restarts`, 'ok');
            onReady(version);
        } catch (e) {
            set({ status: 'error', error: String((e && e.message) || e).split('\n')[0].slice(0, 160), checkedAt: Date.now() });
            log.add(null, 'Update check failed: ' + st.error, 'warn');
        } finally {
            fs.rmSync(work, { recursive: true, force: true });
            busy = false;
        }
        return { ok: true, status: st.status };
    }

    setTimeout(check, FIRST_CHECK_MS);
    setInterval(check, EVERY_MS);

    function install() {
        if (st.status !== 'ready') return { ok: false, error: 'No update is ready' };
        beforeInstall();
        // A normal quit (accounts saved, they resume after), then the code the launcher restarts on.
        app.once('will-quit', (e) => { e.preventDefault(); app.exit(RESTART_CODE); });
        setTimeout(() => app.quit(), 200);
        return { ok: true };
    }

    return { state: () => st, check, install };
}

module.exports = { createLinuxUpdater, cmpVersion };
