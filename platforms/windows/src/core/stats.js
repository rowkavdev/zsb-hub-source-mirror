/**
 * USAGE STATS
 *
 * About once an hour the app sends an anonymous summary to the ZSB Hub stats Worker: a random
 * install id, the app version and system, how many accounts are added and clicking, income per
 * hour, how many due clicks landed, error codes seen and plugins running. Never account names,
 * site ids, logins or anything else that says who someone is. Off with settings.shareStats;
 * Settings > See what's sent shows the exact report. A failed send is just skipped.
 *
 * The sender (post) and the address are passed in: the app uses Electron's net, tests a fake.
 */

const crypto = require('crypto');

const FIRST_MS = 2 * 60000;     // after start: accounts have resumed and had their first report
const EVERY_MS = 60 * 60000;

class Stats {
    constructor({ version, store, engine, errors, plugins, url, post, timing = {}, platform = process.platform, arch = process.arch }) {
        Object.assign(this, { version, store, engine, errors, plugins, url, post, platform, arch });
        this.firstMs = timing.firstMs || FIRST_MS;
        this.everyMs = timing.everyMs || EVERY_MS;
        this.startedAt = Date.now();
        this.last = null;            // { at, ok }
        this.timers = [];
    }

    get available() { return !!(this.url && this.post); }

    installId() {
        const s = this.store.settings;
        if (!/^[a-f0-9]{32}$/.test(s.installId || '')) { s.installId = crypto.randomBytes(16).toString('hex'); this.store.saveSettings(); }
        return s.installId;
    }

    // The report, exactly as it would be sent now.
    build(reason = 'hourly') {
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
        return {
            v: 1, id: this.installId(), app: this.version, os: this.platform, arch: this.arch, reason,
            upMin: Math.round((Date.now() - this.startedAt) / 60000),
            accounts, perHour,
            stability: { pct: pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length * 10) / 10 : null, failedBatches },
            errors: Object.fromEntries(this.errors.counts),
            plugins: this.plugins.list().filter(p => p.state === 'running').map(p => p.id),
        };
    }

    async send(reason) {
        if (!this.available || !this.store.settings.shareStats) return;
        let ok = false;
        try { ok = !!(await this.post(this.url, JSON.stringify(this.build(reason)))); } catch (_) {}
        this.last = { at: Date.now(), ok };
    }

    start() {
        if (!this.available) return;
        this.timers.push(setTimeout(() => {
            this.send('start');
            this.timers.push(setInterval(() => this.send('hourly'), this.everyMs));
        }, this.firstMs));
    }

    stop() { for (const t of this.timers) { clearTimeout(t); clearInterval(t); } this.timers = []; }

    // For the panel: is it on, when it last sent, and the report as it would go now.
    info(withReport) {
        return {
            available: this.available, enabled: !!this.store.settings.shareStats, last: this.last,
            ...(withReport ? { report: this.build() } : {}),
        };
    }
}

module.exports = { Stats };
