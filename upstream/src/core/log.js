/**
 * LOG + REPORT
 *
 * A ring buffer of recent lines (what the panel's Log tab shows) mirrored to a file, and the
 * "Copy report" text. Everything that leaves the app goes through scrub(): tokens, cookies, IP
 * addresses, emails and account names are replaced, so a report is safe to paste anywhere.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_LINES = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const ROUTINE = /^Vault collected$/;

class Log {
    constructor(dir) {
        this.lines = [];
        this.listeners = new Set();
        this.file = dir ? path.join(dir, 'clicker.log') : null;
        this.secrets = () => [];   // set by the app: [{ value, label }] — tokens and account names to hide
        if (this.file) {
            try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
            try { if (fs.statSync(this.file).size > MAX_FILE_BYTES) fs.renameSync(this.file, this.file + '.1'); } catch (_) {}
        }
    }

    // acct is an account id (or null for app-wide lines); level: info | ok | warn | error
    add(acct, msg, level = 'info') {
        const line = { t: Date.now(), acct: acct || null, level, msg: String(msg) };
        this.lines.push(line);
        if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
        // The file is scrubbed too: people zip up their data folder when asking for help.
        if (this.file) {
            const text = new Date(line.t).toISOString() + ' ' + level.toUpperCase().padEnd(5) + ' ' + (acct ? '[' + acct + '] ' : '') + this.scrub(line.msg) + '\n';
            fs.appendFile(this.file, text, () => {});
        }
        for (const fn of this.listeners) { try { fn(line); } catch (_) {} }
    }

    on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

    recent(n = 200) { return this.lines.slice(-n); }

    scrub(text) {
        let s = String(text);
        for (const { value, label } of this.secrets()) {
            if (value && value.length >= 3) s = s.split(value).join(label);
        }
        return s
            .replace(/Bearer\s+\S+/gi, 'Bearer [token]')
            .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[token]')                       // JWTs
            .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '[secret]')                      // long opaque tokens / cookie values
            .replace(/(cf_clearance|cookie|set-cookie)[=:]\s*[^;\s]+/gi, '$1=[cookie]')
            .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g, '[email]')
            .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]')
            .replace(/\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi, '[ip]');
    }
}

// The text behind "Copy report". state comes from the app: { version, accounts: [{ id, status }], errors, plugins }
function buildReport(log, state) {
    const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 90 ? s + 's' : s < 5400 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h'; };
    const out = [];
    out.push('=== ZSB Hub report ===');
    out.push(`App ${state.version} · ${process.platform} ${os.release()} · Electron ${process.versions.electron || '-'} · up ${ago(state.startedAt)}`);
    const by = {};
    for (const a of state.accounts) by[a.status] = (by[a.status] || 0) + 1;
    out.push(`Accounts: ${state.accounts.length} (` + Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ') + ')');
    // Per account, for stability: uptime this run, clicks that landed against clicks that were due,
    // failed batches, vault collects, last click, and the income estimate.
    const money = (n) => '$' + (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : Math.round(n));
    const dur = (ms) => { const m = Math.floor(ms / 60000); return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm'; };
    if (state.accounts.length) {
        out.push('');
        out.push('Accounts (this run):');
        for (const a of state.accounts) {
            const head = `  acct#${a.id}  ${a.status.padEnd(11)} ${(a.type === 'auto' ? 'auto→' + a.clickType : a.type).padEnd(11)}${a.via ? ' via ' + a.via + ' ·' : ''}`;
            const sess = a.sessions ? ` · signed in: ${a.sessions}` : '';
            if (!a.running) { out.push(`${head} not running · last click ${a.lastClickAt ? ago(a.lastClickAt) + ' ago' : 'never'}${sess}`); continue; }
            const ph = a.perHour;
            out.push(`${head} up ${dur(a.upMs)} · clicks ${a.clicks.toLocaleString('en-US')} / ${a.expected.toLocaleString('en-US')} expected (${a.pct == null ? '-' : a.pct + '%'})`
                + ` · failed batches ${a.failedBatches}${a.rateLimited ? ` (${a.rateLimited} too fast)` : ''} · margin ${((a.marginMs || 0) / 1000).toFixed(2)}s · vault ×${a.vaults} · last click ${a.lastClickAt ? ago(a.lastClickAt) + ' ago' : 'none yet'}`
                + (ph ? ` · ≈ ${money(ph.total)}/h (clicks ${money(ph.clickMoney)}, cases ${money(ph.caseMoney)}, vault ${money(ph.vault)})` : ' · no report yet') + sess);
        }
    }
    if (state.plugins.length) out.push('Plugins: ' + state.plugins.map(p => `${p.id} ${p.version}${p.enabled ? '' : ' (off)'}${p.state === 'error' ? ' (error)' : ''}`).join(', '));
    // Income per hour over the last 12 hours (hourly averages of the estimate), oldest first.
    const hrs = (state.income || []).slice(-12);
    if (hrs.length) out.push('Income/h, last ' + hrs.length + 'h: ' + hrs.map(h => `${new Date(h.h).toISOString().slice(11, 13)}h ${money(h.avg)} (${h.clicking})`).join(' · '));
    out.push('');
    out.push('Active problems:');
    if (!state.errors.length) out.push('  none');
    for (const e of state.errors) {
        out.push(`  ${e.code} ×${e.count}  ${!e.acct ? 'app' : e.acct.startsWith('plugin:') ? e.acct : 'acct#' + e.acct}  since ${ago(e.first)}  ${e.text}${e.detail ? ' — ' + e.detail : ''}`);
    }
    const totals = [...state.errorCounts].sort((a, b) => b[1] - a[1]);
    if (totals.length) out.push('Seen since start: ' + totals.map(([c, n]) => `${c} ×${n}`).join(', '));
    out.push('');
    // Routine lines (every vault collect) would fill the whole section; the vault counts above cover them.
    const routine = (l) => l.level === 'info' && ROUTINE.test(l.msg);
    const all = log.recent(MAX_LINES), skipped = all.filter(routine).length;
    out.push('Last 50 log lines' + (skipped ? ` (${skipped} routine "Vault collected" lines left out)` : '') + ':');
    for (const l of all.filter(l => !routine(l)).slice(-50)) {
        out.push(`  ${new Date(l.t).toISOString().slice(11, 19)} ${l.level.padEnd(5)} ${l.acct ? 'acct#' + l.acct + ' ' : ''}${l.msg}`);
    }
    return log.scrub(out.join('\n'));
}

module.exports = { Log, buildReport };
