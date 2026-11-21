/**
 * CORE
 *
 * Puts the pieces together and exposes `rpc`: the one list of things the panel can ask for.
 * The app window calls it over IPC, the optional browser panel over HTTP — same methods, same
 * answers. Nothing here imports Electron; transport and auth are passed in (the app passes the
 * Electron ones, tests pass fakes).
 */

const path = require('path');
const { Store } = require('./store');
const { Errors } = require('./errors');
const { Log, buildReport } = require('./log');
const { Site } = require('./site');
const { Engine } = require('./engine');
const { importZip } = require('../plugins/zipimport');
const { PluginHost } = require('../plugins/host');
const { Catalog } = require('../plugins/catalog');
const { PUBLIC_KEY } = require('../plugins/keys');
const { WhatsNew } = require('./whatsnew');
const { Stats } = require('./stats');
const { Income } = require('./income');
const { createNotify } = require('./notify');
const { parseAccounts } = require('./importer');
const { Troubleshoot } = require('./troubleshoot');
const { clientId, parseUserId, USER_ID } = require('./client');

const SESSION_CHECK_MS = 6 * 60 * 60 * 1000;
const EXPIRY_WARN_DAYS = 7;

// Click types: auto (cases or money by the case click %), money, cases, off (runs without clicking).
const TYPES = ['auto', 'money', 'cases', 'off'];

function createCore({ version, dataDir, bundledPluginsDir, transport, auth, crypt, retryDelayMs, whatsNewFile, stats: statsOpts = {},
    catalogUrl = null, pluginKey = PUBLIC_KEY, fetch: fetchFn, sockets = null, incomeSampleMs, busyTiming, extraTickMs: EXTRA_TICK_MS = 30000, pluginPace, notify: notifyOpts }) {
    const startedAt = Date.now();
    const store = new Store(dataDir, crypt);
    const whatsNew = new WhatsNew({ version, store, file: whatsNewFile });
    const errors = new Errors();
    const log = new Log(path.join(dataDir, 'logs'));
    // X-CC-Client on every request: the hub, its version and the player's main account (the site's rules for scripts).
    const site = new Site({ transport, errors, log, retryDelayMs, client: () => clientId(version, store.settings.main && store.settings.main.userId) });
    const engine = new Engine({ store, site, errors, log, auth });
    const plugins = new PluginHost({ coreVersion: version, engine, store, site, errors, log,
        bundledDir: bundledPluginsDir, userDir: path.join(dataDir, 'plugins'), dataDir: path.join(dataDir, 'plugin-data'), publicKey: pluginKey, sockets, pace: pluginPace });
    const catalog = new Catalog({ host: plugins, url: catalogUrl, publicKey: pluginKey, log, fetch: fetchFn });
    const trouble = new Troubleshoot({ store, engine, site, log, errors, pluginBusy: (id) => plugins.busyOf(id), timing: busyTiming });
    const stats = new Stats({ version, store, engine, errors, plugins, log, ...statsOpts });

    let notify = null;   // set below (Discord webhooks); its URLs are hidden too
    // What scrub() hides in logs and reports: tokens, imported sign-ins, and account names (shown as acct#id instead).
    log.secrets = () => store.accounts.flatMap(a => [
        ...(a.token ? [{ value: a.token, label: '[token]' }] : []),
        { value: a.name, label: 'acct#' + a.id },
        ...(a.login ? [{ value: a.login.password, label: '[password]' }, { value: a.login.email, label: 'acct#' + a.id }] : []),
    ]).concat((notify ? notify.secrets() : []).map(u => ({ value: u, label: '[webhook]' }))).sort((x, y) => y.value.length - x.value.length);

    errors.on('change', () => engine.emit('change'));
    engine.on('refused', (id) => trouble.noteRefused(id));
    const income = new Income({ dataDir, sampleMs: incomeSampleMs, sample: () => totals(store.accounts.map(a => engine.view(a))) });
    // Discord Alerts + Daily report (src/core/notify.js).
    notify = createNotify({ store, log, errors, engine, plugins, income, version, ...(fetchFn ? { fetch: fetchFn } : {}), ...(notifyOpts || {}) });

    // Logins last about a year; a week before one runs out, say so on the card (CC-AUTH-03).
    async function checkSession(acct) {
        if (!acct || !acct.token) return;
        const r = await site.request(acct, '/api/auth/get-session');
        // Which site account the login really is: an older entry learns it; one whose login turned out to be another
        // account takes that one's id. Then two entries for one site account show up (CC-AUTH-08).
        const uid = r.kind === 'ok' && r.json && ((r.json.user && r.json.user.id) || (r.json.session && r.json.session.userId));
        if (uid && acct.userId !== String(uid)) {
            if (acct.userId) log.add(acct.id, 'This login is for a different site account than the entry had — it now goes by that one', 'warn');
            acct.userId = String(uid); store.saveAccountsSoon();
        }
        if (uid) checkDupes();
        const exp = r.kind === 'ok' && r.json && r.json.session && Date.parse(r.json.session.expiresAt);
        if (!exp) return;
        acct.sessionExpiresAt = exp; store.saveAccountsSoon();
        const days = Math.floor((exp - Date.now()) / 86400000);
        if (days < EXPIRY_WARN_DAYS) errors.raise(acct.id, 'CC-AUTH-03', days <= 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`);
        else errors.clear(acct.id, 'CC-AUTH-03');
        // Where else it's signed in: old hub sign-ins removed, a notice for a new one or for clicks lost to another clicker.
        await trouble.watch(acct.id);
    }
    // Two entries for one site account: the one added first keeps clicking; the others stop with CC-AUTH-08 until removed.
    function checkDupes() {
        const by = new Map();
        for (const a of store.accounts) if (a.userId) by.set(a.userId, [...(by.get(a.userId) || []), a]);
        for (const a of store.accounts) {
            const same = (a.userId && by.get(a.userId)) || [a];
            const first = same.slice().sort((x, y) => (x.addedAt || 0) - (y.addedAt || 0))[0];
            if (same.length > 1 && a !== first) {
                if (!errors.has(a.id, 'CC-AUTH-08')) log.add(a.id, `Same site account as ${first.name} — this entry stopped so the two don't click it twice`, 'warn');
                errors.raise(a.id, 'CC-AUTH-08', first.name);
                if (engine.isRunning(a.id)) engine.stop(a.id, { quiet: true });
            } else errors.clear(a.id, 'CC-AUTH-08');
        }
    }
    const checkSessions = async () => { for (const a of store.accounts) { try { await checkSession(a); } catch (_) {} } };
    let sessionTimer = null, extraTimer = null;

    function appIssues() { return errors.list().filter(e => !e.acct || e.acct.startsWith('plugin:') || e.acct.startsWith('route:')); }

    function totals(views) {
        const t = { clicking: 0, vault: 0, clickMoney: 0, cases: 0, caseMoney: 0, total: 0 };
        for (const v of views) {
            if (v.status === 'clicking') t.clicking++;
            if (v.startedAt && v.perHour) for (const k of ['vault', 'clickMoney', 'cases', 'caseMoney', 'total']) t[k] += v.perHour[k];
        }
        return t;
    }

    function publicSettings() {
        const { panelWeb, plugins: _p, hooks: _h, ...s } = store.settings;
        return { ...s, panelWeb: { enabled: panelWeb.enabled, port: panelWeb.port, hasPassword: !!panelWeb.password }, hooks: notify.view() };
    }

    function reportText() {
        // Which connection each account uses, and a letter per exit IP (accounts with the same letter share an IP),
        // without the addresses themselves.
        const routeIds = ['direct', ...(engine.routes ? engine.routes.keys() : [])], ipLetter = new Map();
        const via = (route) => {
            const g = engine.groupOf(route);
            if (!ipLetter.has(g)) ipLetter.set(g, String.fromCharCode(65 + ipLetter.size));
            return (route === 'direct' ? 'this PC' : 'proxy ' + Math.max(1, routeIds.indexOf(route))) + ' (IP ' + ipLetter.get(g) + ')';
        };
        return buildReport(log, {
            version, startedAt,
            accounts: store.accounts.map(a => {
                const v = engine.view(a);
                // Sign-ins on the site at the last check: counts only.
                const s = trouble.seen.get(a.id);
                const sessions = s ? (s.found ? 'hub' : 'hub?') + (s.others ? ` + ${s.others} elsewhere` : '') + (s.earlier ? ` + ${s.earlier} old hub` : '') : null;
                return { id: a.id, status: v.status, type: a.type, clickType: v.clickType, perHour: v.perHour, via: via(v.route || 'direct'), sessions, ...engine.stability(a) };
            }),
            errors: errors.list(), errorCounts: errors.counts,
            plugins: plugins.list(), income: income.hours(),
        });
    }

    // ---- the main account ----
    // Required: the player's main site account, picked from the hub's accounts or pasted (its user id or a link with it).
    // Until it's set nothing clicks (CC-MAIN-01); once set, the accounts waiting for it start.
    function setMain(arg = {}) {
        let userId = null, name = null, account = null;
        if (arg.account) {
            const a = store.get(arg.account);
            if (!a) return { ok: false, error: 'No such account.' };
            if (!a.userId) return { ok: false, error: `The site id of ${a.name} isn't known yet — try again in a minute, or paste the main's user id.` };
            userId = a.userId; name = a.name; account = a.id;
        } else {
            userId = parseUserId(arg.text);
            if (!userId) return { ok: false, error: "That isn't a user id: paste the 24-character id, or a profile link with it in it." };
            const a = store.accounts.find(x => x.userId === userId);
            name = a ? a.name : null; account = a ? a.id : null;
        }
        if (!USER_ID.test(userId)) return { ok: false, error: "That isn't a user id." };
        store.setSettings({ main: { userId, name, account } });
        errors.clear(null, 'CC-MAIN-01');
        log.add(null, `Main account set${name ? ': ' + name : ''}`, 'ok');
        // The accounts that were waiting for it start now.
        for (const a of store.accounts) if (a.wasRunning && a.token && !engine.isRunning(a.id)) engine.start(a.id);
        engine.emit('change');
        return { ok: true, name: name || userId };
    }

    // ---- importing a list of email:password accounts ----
    // Preview first (what was understood), then the accounts are signed in, IMPORT_AT_ONCE at a time (one by one took
    // ~10 s each, mostly waiting on the page), and started. Its sign-in is kept sealed for logging back in later.
    const IMPORT_AT_ONCE = 3;
    let importJob = null;   // { total, done, ok, failed: [{ email, why }], current (the emails signing in now), running, stop }
    function importPreview(text) {
        const { found, skipped } = parseAccounts(text);
        const known = new Set(store.accounts.filter(a => a.login).map(a => a.login.email.toLowerCase()));
        return { found: found.map(f => ({ email: f.email, already: known.has(f.email) })), skipped };
    }
    async function runImport(list) {
        const job = importJob, queue = list.slice(), now = new Set();
        const worker = async () => { while (queue.length && !job.stop) { if (await importOne(job, queue.shift(), now) === 'stopped') return; } };
        await Promise.all(Array.from({ length: Math.min(IMPORT_AT_ONCE, list.length) }, worker));
        job.running = false; job.current = null;
        log.add(null, `Import finished: ${job.ok} of ${job.total} signed in${job.failed.length ? `, ${job.failed.length} failed` : ''}${job.stop ? ' (stopped)' : ''}`, job.failed.length ? 'warn' : 'ok');
        engine.emit('change');
    }
    async function importOne(job, { email, password }, now) {
        now.add(email); job.current = [...now].join(', ');
        engine.emit('change');
        try {
            // Sign-ins go through this PC's connection (the one that gets through Cloudflare's checks most easily); once
            // signed in, the account starts on the least used route with room, like any new account (proxies included).
            const route = 'direct';
            let res;
            try { res = await auth.signIn({ email, password, route, shouldStop: () => job.stop }); } catch (e) { res = { ok: false, error: e.message }; }
            if (res && res.ok) {
                const { account, oldPartition } = store.upsert(res);
                if (oldPartition) auth.forget(oldPartition);
                store.setLogin(account.id, { email, password });
                errors.clear(account.id, 'CC-AUTH-01');
                log.add(account.id, 'Imported and signed in', 'ok');
                engine.loggedIn(account.id);
                if (!engine.isRunning(account.id)) engine.start(account.id);
                job.ok++;
            } else if (res && res.stopped) {
                return 'stopped';   // Stop pressed during this sign-in: not a failure, and nothing after it
            } else {
                job.failed.push({ email, why: (res && res.error) || 'sign-in failed' });
                log.add(null, `Import: ${email} couldn't sign in — ${(res && res.error) || 'sign-in failed'}`, 'warn');
            }
            job.done++;
        } finally {
            now.delete(email); job.current = now.size ? [...now].join(', ') : null;
            engine.emit('change');
        }
    }
    function importStart(text) {
        if (importJob && importJob.running) return { ok: false, error: 'An import is already running.' };
        if (!auth.signIn) return { ok: false, error: 'Importing isn\'t available here.' };
        const prev = importPreview(text);
        const known = new Set(prev.found.filter(f => f.already).map(f => f.email));
        const list = parseAccounts(text).found.filter(f => !known.has(f.email));
        if (!list.length) return { ok: false, error: prev.found.length ? 'Every account in the list is already here.' : 'No email:password lines found.' };
        importJob = { total: list.length, done: 0, ok: 0, failed: [], current: null, running: true, stop: false, at: Date.now() };
        runImport(list).catch(() => {});
        return { ok: true, total: list.length };
    }

    async function addAccount(existingId) {
        const existing = existingId ? store.get(existingId) : null;
        // A new account signs in on this PC's connection, like imports, and then starts on the least used route with
        // room (proxies included). Signing in through the picked proxy left the window signed in while the token check
        // through that proxy never passed, so the account never registered (a user, 2026-11-20: this PC full, a proxy
        // picked). "Log in again" keeps the account's own route.
        const route = existing ? engine.routeFor(existing) : 'direct';
        const res = await auth.login({ partition: existing ? existing.partition : undefined, route });
        if (!res.ok) {
            if (res.code) errors.raise(existing ? existing.id : null, res.code, res.error);
            return res;
        }
        // "Log in again" that signed into a different site account adds that one instead of overwriting.
        if (existing && !(res.userId && existing.userId && res.userId !== existing.userId)) {
            store.setToken(existing.id, res.token, res.partition);
            if (!existing.userId && res.userId) existing.userId = res.userId;
            // Still on the placeholder name (the site's name couldn't be read before): use the real one.
            if (res.name && /^Account \d+$/.test(existing.name)) existing.name = res.name;
            store.saveAccounts();
            log.add(existing.id, 'Logged in again', 'ok');
            engine.loggedIn(existing.id);
            checkSession(existing).catch(() => {});
            return { ok: true, id: existing.id };
        }
        const { account, replaced, oldPartition } = store.upsert(res);
        if (oldPartition) auth.forget(oldPartition);
        errors.clear(null, 'CC-AUTH-02');
        log.add(account.id, replaced ? 'Logged in again' : 'Account added', 'ok');
        engine.loggedIn(account.id);
        checkSession(account).catch(() => {});
        // New accounts start straight away — that's what people add them for.
        if (!replaced && !engine.isRunning(account.id)) engine.start(account.id);
        return { ok: true, id: account.id, replaced };
    }

    const rpc = {
        state() {
            const views = store.accounts.map(a => ({ ...engine.view(a), badges: plugins.badges(a.id), folder: a.folder && store.folder(a.folder) ? a.folder : null }));
            return {
                version, startedAt, accounts: views, appIssues: appIssues(), totals: totals(views),
                importJob: importJob && { total: importJob.total, done: importJob.done, ok: importJob.ok, failed: importJob.failed, current: importJob.current, running: importJob.running, stopping: importJob.running && importJob.stop },
                running: engine.run.size, clickingRuns: engine.running().filter(id => !engine.noClicks(id)).length, maxPerIp: store.settings.maxPerIp, capacity: engine.capacity(),
                folders: store.folders.map(f => ({ ...f })),
                settings: publicSettings(), plugins: plugins.list(), tabs: plugins.tabs(), catalog: catalog.view(),
                whatsNew: whatsNew.unseen().length > 0, stats: stats.info(false),
                themes: plugins.themes(), theme: (t => t && { id: t.id, stamp: t.stamp })(plugins.theme()),
                platform: process.platform, now: Date.now(),   // the panel's clock offset (a phone's clock may differ)
            };
        },
        logs(since = 0) {
            const names = Object.fromEntries(store.accounts.map(a => [a.id, a.name]));
            return log.recent(300).filter(l => l.t > since).map(l => ({ ...l, name: l.acct ? names[l.acct] || null : null }));
        },
        addAccount: () => addAccount(null),
        relogin: (id) => addAccount(id),
        importPreview: (text) => importPreview(text),
        importStart: (text) => importStart(text),
        importStop: () => { if (importJob && importJob.running) { importJob.stop = true; engine.emit('change'); } return { ok: true }; },
        // Close an app-wide alert (a tester's ask, 2026-11-11). It shows again only if the problem happens again.
        // "Set your main account" stays: nothing clicks until it's done.
        dismissIssue: (acct, code) => {
            if (code === 'CC-MAIN-01') return { ok: false, error: 'This one stays until a main account is set' };
            if (!errors.has(acct || null, code)) return { ok: false, error: 'No such alert' };
            errors.clear(acct || null, code);
            return { ok: true };
        },
        importDismiss: () => { if (importJob && !importJob.running) importJob = null; return { ok: true }; },
        start: (id) => engine.start(id),
        stop: (id) => engine.stop(id),
        startAll: () => engine.startAll(),
        stopAll: () => { engine.stopAll(); return { ok: true }; },
        setType(id, type) {
            if (!TYPES.includes(type)) return { ok: false, error: 'No such click type' };
            const was = store.get(id);
            if (!was) return { ok: false };
            // Off -> clicking while it runs: it needs a clicking place on its IP (Off takes none).
            if (was.type === 'off' && type !== 'off' && engine.isRunning(id) && !engine.canClick(id))
                return { ok: false, error: `${store.settings.maxPerIp} accounts already click on this IP — stop one, or add a proxy, to click here too.` };
            const a = store.update(id, { type });
            log.add(id, type === 'off' ? 'Clicks and vault off: it stays on for plugins' : type === 'auto' ? `Auto: clicks ${engine.clickType(a)} for now (cases above ${store.settings.autoCasePct}% case click)` : 'Clicks ' + type + ' from the next batch');
            if (type === 'off') engine.slotFreed();   // a clicking place freed up: a waiting account takes it
            engine.emit('change');
            return { ok: true };
        },
        setAllType(type) {
            if (!TYPES.includes(type)) return { ok: false, error: 'No such click type' };
            for (const a of store.accounts) if (!(a.type === 'off' && type !== 'off' && engine.isRunning(a.id) && !engine.canClick(a.id))) store.update(a.id, { type });
            log.add(null, 'All accounts set to ' + type);
            engine.emit('change');
            return { ok: true };
        },
        rename(id, name) { const a = store.update(id, { name }); engine.emit('change'); return { ok: !!a }; },
        // Order and folders (the panel drags cards; before = the account it lands in front of, null = last).
        moveAccount(id, to = {}) {
            const a = store.move(id, { before: to.before || null, folder: to.folder === undefined ? undefined : to.folder || null });
            engine.emit('change');
            return { ok: !!a };
        },
        folderAdd(name, ids) {
            const f = store.addFolder(name);
            for (const id of [].concat(ids || [])) store.move(id, { before: id, folder: f.id });
            engine.emit('change');
            return { ok: true, id: f.id };
        },
        folderUpdate(fid, patch) { const f = store.updateFolder(fid, patch || {}); engine.emit('change'); return { ok: !!f }; },
        folderMove(fid, before) { const f = store.moveFolder(fid, before || null); engine.emit('change'); return { ok: !!f }; },
        folderRemove(fid) { const ok = store.removeFolder(fid); engine.emit('change'); return { ok }; },
        folderStart(fid) {
            const out = {};
            for (const a of store.accounts) if (a.folder === fid && a.token && !engine.isRunning(a.id)) out[a.id] = engine.start(a.id);
            engine.emit('change');
            return { ok: true, results: out };
        },
        folderStop(fid) {
            for (const a of store.accounts) if (a.folder === fid && engine.isRunning(a.id)) engine.stop(a.id);
            engine.emit('change');
            return { ok: true };
        },
        // The account cards' select mode: one action on many accounts. what: start | stop | type (arg auto/money/cases)
        // | folder (arg folder id, '' = none, or { name } for a new one) | remove. Accounts already in that state are
        // skipped; results has each started account's answer (the per-IP limit, a duplicate, no main account).
        async accountsBulk(ids, what, arg) {
            const list = [...new Set([].concat(ids || []))].map(id => store.get(id)).filter(Boolean);
            if (!list.length) return { ok: false, error: 'No accounts chosen' };
            const out = {};
            if (what === 'start') { for (const a of list) if (a.token && !engine.isRunning(a.id)) out[a.id] = engine.start(a.id); }
            else if (what === 'stop') { for (const a of list) if (engine.isRunning(a.id)) engine.stop(a.id); }
            else if (what === 'type') {
                if (!TYPES.includes(arg)) return { ok: false, error: 'No such click type' };
                let full = 0;
                for (const a of list) {
                    if (a.type === 'off' && arg !== 'off' && engine.isRunning(a.id) && !engine.canClick(a.id)) { full++; out[a.id] = { ok: false, code: 'CC-RATE-01' }; continue; }
                    store.update(a.id, { type: arg });
                }
                log.add(null, `${list.length - full} accounts set to ${arg}${full ? ` (${full} left Off: no clicking place left on their IP)` : ''}`);
            } else if (what === 'folder') {
                const fid = arg && typeof arg === 'object' ? store.addFolder(String(arg.name || '').trim() || 'New folder').id : arg || null;
                if (fid && !store.folders.some(f => f.id === fid)) return { ok: false, error: 'No such folder' };
                for (const a of list) store.move(a.id, { before: a.id, folder: fid });
            } else if (what === 'remove') { for (const a of list) await rpc.remove(a.id); }
            else return { ok: false, error: 'No such action' };
            engine.emit('change');
            return { ok: true, n: list.length, results: out };
        },
        async remove(id) {
            const a = store.get(id);
            if (!a) return { ok: false };
            if (engine.isRunning(id)) engine.stop(id, { quiet: true });
            store.remove(id);
            errors.clear(id, 'CC-AUTH-08');
            checkDupes();
            errors.clearAccount(id);
            if (a.partition) await auth.forget(a.partition);
            log.add(null, 'Removed an account');
            engine.emit('change');
            return { ok: true };
        },
        report: () => reportText(),
        // Troubleshoot window: where each account is signed in (and signing those out), and why clicks are refused.
        troubleSessions: (id) => trouble.sessions(id, { viewed: true }),
        troubleSeen: (id) => trouble.acknowledge(id),
        troubleTestRoutes: () => trouble.testRoutes(),
        troubleBusyTest: (id) => trouble.busyTest(id),
        troubleBusyStop: (id) => trouble.busyStop(id),
        troubleExtraCheck: (id) => trouble.extraCheck(id).then(({ run, ...x }) => x),
        troubleRevoke: (id, sid) => trouble.revoke(id, sid),
        troubleRevokeOthers: (id) => trouble.revokeOthers(id),
        troubleCleanup: (id) => trouble.cleanup(id),
        troubleClicks: () => trouble.clicks(),
        text: () => require('./text').all(),
        reloadText: () => { require('./text').reload(); engine.emit('change'); return { ok: true }; },
        // all = the last few versions (Settings button); otherwise only what hasn't been shown yet.
        whatsNew: (all) => (all ? whatsNew.recent() : whatsNew.unseen()),
        // Settings > See what's sent: the report exactly as it would go now.
        statsReport: () => stats.info(true),
        incomeHistory: () => income.hours(),
        // Discord webhooks (Alerts, Daily report): kind 'alerts' | 'report'. The URL never comes back.
        hookSet: (kind, url) => { const r = notify.set(kind, url); engine.emit('change'); return r; },
        hookClear: (kind) => { const r = notify.clear(kind); engine.emit('change'); return r; },
        hookOptions: (kind, patch) => { const r = notify.options(kind, patch || {}); engine.emit('change'); return r; },
        hookTest: (kind) => notify.test(kind),
        schedule: () => schedule(),
        scheduleDo: (src, key, op) => scheduleDo(src, key, op),
        hookReportNow: async () => { const r = await notify.sendReport(true); return r.ok ? { ok: true, message: 'Report sent.' } : { ok: false, error: r.wait ? 'Discord is rate-limiting this webhook — try again in a moment.' : 'Not sent: ' + r.error }; },
        whatsNewSeen: () => { whatsNew.seen(); return { ok: true }; },
        setSettings: (patch) => { const { main: _m, ...p } = patch || {}; store.setSettings(p); engine.emit('change'); return publicSettings(); },
        setMain: (arg) => setMain(arg),
        pluginEnable: (id, on) => plugins.setEnabled(id, on),
        pluginSetting: (id, key, value) => plugins.setPluginSetting(id, key, value),
        pluginReload: (id) => plugins.reload(id),
        pluginRescan: () => { plugins.scan(); engine.emit('change'); return { ok: true }; },
        pluginCatalog: () => catalog.refresh(),
        pluginInstall: (id) => catalog.install(id),
        // The picked panel theme in full ({ id, name, vars, css, stamp } or null): fetched when state's theme.stamp changes.
        theme: () => plugins.theme(),
        // A plugin from a zip the user picked (base64): src/plugins/zipimport.js.
        pluginImportZip: (b64) => {
            const buf = Buffer.from(String(b64 || ''), 'base64');
            if (!buf.length) return { ok: false, code: 'format', error: 'empty file' };
            return importZip(buf, { host: plugins, catalog, log });
        },
        pluginRemove: (id) => catalog.remove(id),
        pluginAction: (id, name, arg) => plugins.runAction(id, name, arg),
    };

    function boot() {
        plugins.scan();
        plugins.startEnabled();
        if (!store.settings.main || !store.settings.main.userId) errors.raise(null, 'CC-MAIN-01');
        engine.resume();
        stats.start();
        catalog.start();
        income.start();
        notify.start();
        setTimeout(checkSessions, 60 * 1000).unref?.();
        sessionTimer = setInterval(checkSessions, SESSION_CHECK_MS);
        if (sessionTimer.unref) sessionTimer.unref();
        extraTimer = setInterval(() => trouble.extraTick().catch(() => {}), EXTRA_TICK_MS);
        if (extraTimer.unref) extraTimer.unref();
        log.add(null, `ZSB Hub ${version} started · ${store.accounts.length} account(s)`);
    }

    function shutdown() {
        // Keep wasRunning so the same accounts start again next launch.
        engine.stopAll({ keepResume: true, quiet: true });
        engine.cancelRecover();
        plugins.stopAll();
        stats.stop();
        catalog.stop();
        income.stop();
        notify.stop();
        clearInterval(sessionTimer);
        clearInterval(extraTimer);
        try { store.saveAccounts(); } catch (_) {}
    }

    // ---- the Schedule tab ----
    // Now: what plugins are doing on which accounts, who's asking for one, accounts waiting for a clicking place.
    // Next: what's coming up and why — each running plugin's own (host.schedule()), the hub's sign-in tries and the
    // daily report — soonest first. Each has Run now / Skip next when its owner offers them.
    function schedule() {
        const name = (id) => { const a = store.get(id); return a ? a.name : id; };
        const accts = (ids) => ({ names: ids.slice(0, 8).map(name), n: ids.length });
        const act = plugins.activity();
        const waiting = store.accounts.filter(a => errors.has(a.id, 'CC-RATE-01')).map(a => a.id);
        const now = [
            ...act.busy.map(b => ({ who: b.pluginName, what: b.what, since: b.since, ...accts(b.accounts) })),
            ...act.wants.map(w => ({ who: w.pluginName, what: 'waiting for: ' + w.what, since: w.since, ...accts([w.account]), why: 'another plugin has the account; it goes once that one lets go' })),
            ...(waiting.length ? [{ who: 'Hub', what: 'Waiting for a clicking place', since: null, ...accts(waiting),
                why: `their IP already has ${store.settings.maxPerIp} clicking; ${engine.recover('slots') ? 'each starts when one there stops' : 'start them by hand (auto-recover is off)'}` }] : []),
        ];
        const next = plugins.schedule().map(e => ({ src: e.plugin, key: e.key, who: e.pluginName, what: e.what, at: e.at, why: e.why, canRun: e.canRun, canSkip: e.canSkip, each: !!e.each, ...accts(e.accounts) }));
        for (const r of engine.reloginList()) next.push({ src: 'hub', key: 'relogin:' + r.id, who: 'Hub', what: 'Sign in again', at: r.at, ...accts([r.id]),
            why: `logged out and signing back in failed; try ${r.n + 1} of ${engine.reloginMs.length} (auto-recover)`, canRun: true, canSkip: false });
        const rep = notify.nextReport();
        if (rep != null) next.push({ src: 'hub', key: 'report', who: 'Hub', what: 'Daily report to Discord', at: rep, names: [], n: 0,
            why: `every day at ${store.settings.hooks.report.time} (Settings > Discord webhooks)`, canRun: true, canSkip: true });
        next.sort((a, b) => (a.at || Infinity) - (b.at || Infinity));
        return { now, next, at: Date.now() };
    }
    async function scheduleDo(src, key, op) {
        if (!['run', 'skip'].includes(op)) return { ok: false, error: 'No such action' };
        if (src === 'hub') {
            if (key === 'report') {
                if (op === 'skip') return notify.skipReport() ? { ok: true, message: 'Skipped: the next report goes a day later.' } : { ok: false, error: 'No report set up.' };
                const r = await notify.sendReport(true);
                return r.ok ? { ok: true, message: 'Report sent.' } : { ok: false, error: r.wait ? 'Discord is rate-limiting this webhook — try again in a moment.' : 'Not sent: ' + r.error };
            }
            if (String(key).startsWith('relogin:') && op === 'run') return engine.reloginNow(String(key).slice(8)) ? { ok: true, message: 'Trying to sign in now.' } : { ok: false, error: 'Nothing waiting there now.' };
            return { ok: false, error: 'Nothing scheduled there now.' };
        }
        const r = await plugins.scheduleDo(src, key, op);
        engine.emit('change');
        return r.ok && !r.message ? { ...r, message: op === 'run' ? 'Running now.' : 'Skipped the next one.' } : r;
    }

    // main.js: how the last run ended (the watchdog's note), once at start, after boot().
    const lastRunEnded = (info) => notify.lastRunEnded(info);

    return { rpc, boot, shutdown, store, errors, log, engine, plugins, catalog, site, income, checkSession, trouble, notify, lastRunEnded };
}

module.exports = { createCore };
