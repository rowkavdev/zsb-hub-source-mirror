/**
 * USAGE STATS
 *
 * About once an hour the app sends a summary to the ZSB Hub stats Worker: a random install id, the
 * app version and system, how many accounts are added and clicking, income per hour, how many due
 * clicks landed, error codes seen and plugins running. Never account names, site ids, logins or
 * anything else that says who someone is. Off with settings.shareStats; Settings > See what's sent
 * shows the exact report. A failed send is just skipped.
 *
 * On top of that a user can choose to share more (settings.shareMore, one switch each — asked once
 * in the sharing walkthrough, changeable in Settings):
 *   system    OS version (and Linux distro / desktop), CPU cores, memory (rounded GB), Electron
 *             version, installed or from source, update channel, whether logins are sealed
 *   health    the hub's own memory and CPU use, how late its timers run (event-loop lag)
 *   clicking  per-account states, refused / missed batches in the last hour, connections
 *   plugins   each plugin's version and state, and its last error
 *   log       the last 30 warnings and errors from the log, scrubbed like the log file
 * and attach a name (settings.shareName) — then the report is no longer anonymous.
 *
 * The sender (post) and the address are passed in: the app uses Electron's net, tests a fake.
 */

const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const { monitorEventLoopDelay } = require('perf_hooks');
const { SHARE_KEYS, cleanName } = require('./store');

const FIRST_MS = 2 * 60000;     // after start: accounts have resumed and had their first report
const EVERY_MS = 60 * 60000;
const LOG_LINES = 30;

const round1 = (n) => Math.round(n * 10) / 10;

class Stats {
    constructor({ version, store, engine, errors, plugins, log, url, post, timing = {}, platform = process.platform, arch = process.arch, packaged = null, metrics = null, sealed = null, keyring = null }) {
        Object.assign(this, { version, store, engine, errors, plugins, log, url, post, platform, arch, packaged, metrics, sealed, keyring });
        this.firstMs = timing.firstMs || FIRST_MS;
        this.everyMs = timing.everyMs || EVERY_MS;
        this.startedAt = Date.now();
        this.last = null;            // { at, ok }
        this.timers = [];
        this.cpuMark = { at: Date.now(), usage: process.cpuUsage() };
        this.lag = null;             // event-loop delay histogram, while started
        this.distro = undefined;
    }

    get available() { return !!(this.url && this.post); }

    installId() {
        const s = this.store.settings;
        if (!/^[a-f0-9]{32}$/.test(s.installId || '')) { s.installId = crypto.randomBytes(16).toString('hex'); this.store.saveSettings(); }
        return s.installId;
    }

    // Which extras are on, in a fixed order.
    shared() {
        const m = this.store.settings.shareMore || {};
        return SHARE_KEYS.filter(k => m[k]);
    }

    // The report, exactly as it would be sent now. sending = true resets the per-hour health counters.
    build(reason = 'hourly', sending = false) {
        const accounts = { added: this.store.accounts.length, clicking: 0, money: 0, cases: 0 };
        const perHour = { income: 0, clickMoney: 0, caseMoney: 0, vault: 0, cases: 0 };
        const pcts = [];
        let failedBatches = 0;
        for (const a of this.store.accounts) {
            const v = this.engine.view(a);
            if (v.status === 'clicking') { accounts.clicking++; accounts[v.clickType === 'cases' ? 'cases' : 'money']++; }
            if (v.startedAt && v.perHour) {
                perHour.income += v.perHour.total || 0; perHour.clickMoney += v.perHour.clickMoney || 0;
                perHour.caseMoney += v.perHour.caseMoney || 0; perHour.vault += v.perHour.vault || 0; perHour.cases += v.perHour.cases || 0;
            }
            const st = this.engine.stability(a);
            if (st.running) { failedBatches += st.failedBatches || 0; if (st.pct != null) pcts.push(st.pct); }
        }
        for (const k of Object.keys(perHour)) perHour[k] = Math.round(perHour[k]);
        const report = {
            v: 1, id: this.installId(), app: this.version, os: this.platform, arch: this.arch, reason,
            upMin: Math.round((Date.now() - this.startedAt) / 60000),
            accounts, perHour,
            stability: { pct: pcts.length ? round1(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null, failedBatches },
            errors: Object.fromEntries(this.errors.counts),
            plugins: this.plugins.list().filter(p => p.state === 'running').map(p => p.id),
        };
        const name = cleanName(this.store.settings.shareName);
        if (name) report.name = name;
        const extra = this.shared();
        if (extra.length) report.shared = extra;
        for (const k of extra) {
            try { report[k === 'plugins' ? 'pluginInfo' : k] = this[k + 'Info'](sending); } catch (_) {}
        }
        return report;
    }

    // --- the extras -------------------------------------------------------------------------
    systemInfo() {
        const v = process.versions || {};
        return {
            release: String(os.release()).slice(0, 40),
            ...(this.platform === 'linux' ? { distro: this.linuxDistro(), desktop: String(process.env.XDG_CURRENT_DESKTOP || '').slice(0, 40) || null } : {}),
            cores: (os.cpus() || []).length,
            ramGb: Math.round(os.totalmem() / 2 ** 30),
            electron: v.electron || null, chrome: v.chrome || null, node: v.node || null,
            packaged: this.packaged,
            channel: this.store.settings.testBuilds ? 'test' : 'stable',
            sealed: this.sealed, ...(this.keyring ? { keyring: String(this.keyring).slice(0, 30) } : {}),
            accounts: this.store.accounts.length,
        };
    }

    linuxDistro() {
        if (this.distro !== undefined) return this.distro;
        try {
            const m = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(fs.readFileSync('/etc/os-release', 'utf8'));
            this.distro = m ? m[1].slice(0, 60) : null;
        } catch (_) { this.distro = null; }
        return this.distro;
    }

    healthInfo(sending) {
        const now = Date.now(), mem = process.memoryUsage(), cpu = process.cpuUsage(this.cpuMark.usage);
        const wall = Math.max(1, now - this.cpuMark.at);
        const out = {
            rssMb: Math.round(mem.rss / 2 ** 20), heapMb: Math.round(mem.heapUsed / 2 ** 20),
            cpuPct: round1((cpu.user + cpu.system) / 1000 / wall * 100),
            sysFreePct: Math.round(os.freemem() / os.totalmem() * 100),
            ...(this.platform !== 'win32' ? { load1: round1(os.loadavg()[0]) } : {}),
        };
        if (this.metrics) { try { const mb = this.metrics(); if (typeof mb === 'number') out.appMb = Math.round(mb); } catch (_) {} }
        if (this.lag && this.lag.count) {
            out.lagMs = { p50: round1(this.lag.percentile(50) / 1e6), p99: round1(this.lag.percentile(99) / 1e6), max: round1(this.lag.max / 1e6) };
        }
        if (sending) { this.cpuMark = { at: now, usage: process.cpuUsage() }; if (this.lag) this.lag.reset(); }
        return out;
    }

    clickingInfo() {
        const status = {}, types = {}, e = this.engine;
        let refused = 0, ipRefused = 0, missed = 0, rateLimited = 0, reportFails = 0, vaults = 0;
        const margins = [];
        for (const a of this.store.accounts) {
            const v = e.view(a);
            status[v.status] = (status[v.status] || 0) + 1;
            types[a.type || 'auto'] = (types[a.type || 'auto'] || 0) + 1;
            const h = e.clickHealth ? e.clickHealth(a) : { running: false };
            if (h.running) { refused += h.refused || 0; ipRefused += h.ipRefused || 0; missed += h.missed || 0; if (typeof h.marginMs === 'number') margins.push(h.marginMs); }
            const st = e.stability(a);
            if (st.running) { rateLimited += Number(st.rateLimited) || 0; vaults += Number(st.vaults) || 0; }
            const r = e.run && e.run.get(a.id);
            if (r) reportFails += r.reportFails || 0;
        }
        const routes = e.routes ? [...e.routes.keys()] : [];
        const groups = new Set(['direct', ...routes].map(id => e.groupOf ? e.groupOf(id) : id));
        return {
            status, types, lastHour: { refused, ipRefused, missed }, rateLimited, reportFails, vaults,
            marginMs: margins.length ? Math.round(margins.reduce((x, y) => x + y, 0) / margins.length) : null,
            connections: 1 + routes.length, ips: groups.size,
            down: routes.filter(id => e.routeDown && e.routeDown(id)).length,
            capacity: e.capacity ? e.capacity() : null,
        };
    }

    pluginsInfo() {
        const scrub = (s) => (this.log ? this.log.scrub(String(s)) : String(s)).slice(0, 160);
        return this.plugins.list().slice(0, 40).map(p => ({
            id: p.id, version: p.version || null, state: p.state, enabled: !!p.enabled, bundled: !!p.bundled,
            ...(p.error ? { error: scrub(p.error.message || p.error) } : {}),
        }));
    }

    logInfo() {
        if (!this.log) return [];
        const now = Date.now();
        return this.log.recent(1000).filter(l => l.level === 'warn' || l.level === 'error').slice(-LOG_LINES).map(l => ({
            agoMin: Math.round((now - l.t) / 60000), level: l.level, ...(l.acct ? { acct: String(l.acct).slice(0, 12) } : {}),
            msg: this.log.scrub(l.msg).slice(0, 200),
        }));
    }

    // --- sending -------------------------------------------------------------------------------
    async send(reason) {
        if (!this.available || !this.store.settings.shareStats) return;
        let ok = false;
        try { ok = !!(await this.post(this.url, JSON.stringify(this.build(reason, true)))); } catch (_) {}
        this.last = { at: Date.now(), ok };
    }

    start() {
        if (!this.available) return;
        try { this.lag = monitorEventLoopDelay({ resolution: 20 }); this.lag.enable(); } catch (_) { this.lag = null; }
        this.timers.push(setTimeout(() => {
            this.send('start');
            this.timers.push(setInterval(() => this.send('hourly'), this.everyMs));
        }, this.firstMs));
    }

    stop() {
        for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
        this.timers = [];
        if (this.lag) { try { this.lag.disable(); } catch (_) {} this.lag = null; }
    }

    // For the panel: is it on, what's shared, when it last sent, and the report as it would go now.
    info(withReport) {
        const s = this.store.settings;
        return {
            available: this.available, enabled: !!s.shareStats, last: this.last,
            shared: this.shared(), named: !!cleanName(s.shareName),
            ...(withReport ? { report: this.build() } : {}),
        };
    }
}

module.exports = { Stats };
