/**
 * INCOME HISTORY
 *
 * The fleet's estimated income ($/h, same estimate as the header) sampled every minute and kept as
 * hourly averages for 7 days in income.json — for the panel's income chart, the Overview graphs and Copy report.
 * Also the fleet's money, tokens and net worth at the last sample of each hour (levels, not averages), when known,
 * and how many accounts had reported then (a change in that count makes the levels jump: a restart, an account added).
 *   hours(): [{ h: ms at the start of the hour, avg: $/h, clicking: accounts (avg), money?, tokens?, networth?, reported? }], oldest first
 */

const fs = require('fs');
const path = require('path');

const HOUR = 60 * 60 * 1000;
const KEEP_HOURS = 7 * 24;
const SAMPLE_MS = 60 * 1000;
const SAVE_MS = 5 * 60 * 1000;
const LEVELS = ['money', 'tokens', 'networth', 'reported'];

class Income {
    constructor({ dataDir, sample, sampleMs = SAMPLE_MS }) {
        this.file = path.join(dataDir, 'income.json');
        this.sample = sample;   // () -> { total, clicking }
        this.sampleMs = sampleMs;
        this.buckets = [];      // { h, sum, n, clicking }
        try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (Array.isArray(j.buckets)) this.buckets = j.buckets; } catch (_) {}
    }

    start() {
        this.timer = setInterval(() => this.take(), this.sampleMs);
        this.saver = setInterval(() => this.save(), SAVE_MS);
        for (const t of [this.timer, this.saver]) if (t.unref) t.unref();
    }

    stop() { clearInterval(this.timer); clearInterval(this.saver); this.save(); }

    take(now = Date.now()) {
        const t = this.sample(), { total, clicking } = t;
        if (!clicking || !total) return;   // nothing running, or no estimate yet (just started): skip, not a $0 sample
        const h = Math.floor(now / HOUR) * HOUR;
        let b = this.buckets[this.buckets.length - 1];
        if (!b || b.h !== h) { b = { h, sum: 0, n: 0, clicking: 0 }; this.buckets.push(b); }
        b.sum += total; b.n++; b.clicking += clicking;
        for (const k of LEVELS) if (Number.isFinite(t[k])) b[k] = Math.round(t[k]);
        const oldest = h - (KEEP_HOURS - 1) * HOUR;
        while (this.buckets.length && this.buckets[0].h < oldest) this.buckets.shift();
    }

    save() {
        try { fs.writeFileSync(this.file + '.tmp', JSON.stringify({ buckets: this.buckets })); fs.renameSync(this.file + '.tmp', this.file); } catch (_) {}
    }

    hours() {
        return this.buckets.map(b => {
            const o = { h: b.h, avg: Math.round(b.sum / b.n), clicking: Math.round(b.clicking / b.n) };
            for (const k of LEVELS) if (Number.isFinite(b[k])) o[k] = b[k];
            return o;
        });
    }
}

module.exports = { Income, HOUR };
