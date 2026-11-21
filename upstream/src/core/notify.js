/**
 * DISCORD WEBHOOKS — Alerts and the Daily report (Settings > Discord webhooks; the walkthrough sets them up).
 *
 * Each webhook URL is a secret (anyone with it can post to the channel): kept sealed with the system keychain in
 * settings.hooks.<kind>.sealed, never logged, never sent to the panel (it gets "…/1234").
 *
 * Alerts (settings.hooks.alerts.on: { problems, plugins, restarts }), checked every TICK_MS, one message per tick:
 *   problems  accounts that need a look (as the panel counts them: logged out, a problem, a check, a proxy down;
 *             waiting for a slot isn't one) for at least SETTLE_MS, so a moment's hiccup isn't sent; then "fixed"
 *             once they're fine again.
 *   plugins   a plugin run that stopped with a reason ("[opener] stopped: …"), not ones turned off or stopped by you.
 *   restarts  the hub came back after a crash or freeze (src/app/watchdog.js), or gave up restarting.
 * Daily report (settings.hooks.report: { time 'HH:MM' local, last }): once a day at that time: the fleet now, the
 * last 24 h (income history, alerts, plugin stops, restarts) and the change since the last report.
 *
 * Discord answers: 429 waits retry_after; 401/403/404 means the webhook is gone: it stops and the panel says so.
 */

const HOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const TICK_MS = 60000, SETTLE_MS = 60000, MAX_LINES = 12, DAY = 24 * 3600000;
const KINDS = ['alerts', 'report'];
const ALERT_ON = { problems: true, plugins: true, restarts: true };
const COLOR = { bad: 0xf85149, ok: 0x3fb950, info: 0x8b949e, warn: 0xd29922 };

const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
const num = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const signed = (n, f) => (n > 0 ? '+' : n < 0 ? '−' : '±') + f(Math.abs(n));
const clip = (lines) => lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES - 1), `…and ${lines.length - MAX_LINES + 1} more`] : lines;
const WAIT_CODES = new Set(['CC-RATE-01']);
const BAD_STATUS = new Set(['logged-out', 'problem', 'needs-you', 'proxy-down']);

function createNotify({ store, log, errors, engine, plugins, income, version, fetch = globalThis.fetch, tickMs = TICK_MS, settleMs = SETTLE_MS, now = Date.now }) {
    const S = () => {
        const h = store.settings.hooks || (store.settings.hooks = {});
        for (const k of KINDS) if (!h[k] || typeof h[k] !== 'object') h[k] = {};
        h.alerts.on = { ...ALERT_ON, ...(h.alerts.on || {}) };
        if (!/^\d{2}:\d{2}$/.test(h.report.time || '')) h.report.time = '09:00';
        return h;
    };
    const urls = {};          // kind -> unsealed URL (memory only)
    const dead = {};          // kind -> why Discord refused it
    let waitUntil = 0;        // a 429: nothing goes out before this
    const seen = new Map();   // account id -> { since, reason, sent }
    const fixed = [];         // names whose problem was sent and is gone
    const pluginStops = [];   // lines to send
    const restarts = [];      // lines to send
    const day = { alerts: 0, pluginStops: 0, restarts: 0, problems: new Set() };   // since the last report
    let timer = null, reportTimer = null, offLog = null;

    function load() {
        const h = S();
        for (const k of KINDS) {
            urls[k] = null;
            if (!h[k].sealed) continue;
            try { urls[k] = store.crypt.unseal(h[k].sealed); } catch (_) { urls[k] = null; }
            if (!urls[k]) log.add(null, `Discord ${k} webhook: the saved one can't be read on this computer — set it up again`, 'warn');
        }
    }

    async function post(kind, body) {
        const url = urls[kind];
        if (!url) return { ok: false, error: 'No webhook set' };
        if (dead[kind]) return { ok: false, error: dead[kind] };
        if (now() < waitUntil) return { ok: false, wait: true };
        let r;
        try {
            r = await fetch(url + '?wait=true', { method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ username: 'ZSB Hub', allowed_mentions: { parse: [] }, ...body }), signal: AbortSignal.timeout(10000) });
        } catch (e) { return { ok: false, error: e.name === 'TimeoutError' ? 'timed out' : 'no connection to Discord' }; }
        if (r.ok) return { ok: true };
        if (r.status === 429) {
            let s = 5; try { s = Number((await r.json()).retry_after) || 5; } catch (_) {}
            waitUntil = now() + Math.ceil(s * 1000);
            return { ok: false, wait: true };
        }
        if ([401, 403, 404].includes(r.status)) {
            dead[kind] = 'Discord says this webhook is gone (deleted, or the URL is wrong) — set it up again';
            log.add(null, `Discord ${kind} webhook stopped: ${dead[kind]}`, 'warn');
            return { ok: false, error: dead[kind] };
        }
        return { ok: false, error: 'Discord answered HTTP ' + r.status };
    }

    // ---- alerts --------------------------------------------------------------------------------------------------
    const nameOf = (id) => { const a = store.get(id); return a ? a.name || a.id : id; };
    function needsLook(v) {
        if (BAD_STATUS.has(v.status)) return true;
        return (v.issues || []).some(i => !WAIT_CODES.has(i.code));
    }
    function reasonOf(v) {
        const i = (v.issues || []).find(x => !WAIT_CODES.has(x.code));
        if (i) return `${i.code} ${i.text || ''}`.trim();
        return { 'logged-out': 'logged out', 'needs-you': 'a Cloudflare check needs you', 'proxy-down': 'its proxy is down', problem: 'a problem' }[v.status] || v.status;
    }

    function scan() {
        const t = now(), on = S().alerts.on;
        const still = new Set();
        for (const a of store.accounts) {
            const v = engine.view(a);
            if (!needsLook(v)) continue;
            still.add(a.id);
            const cur = seen.get(a.id);
            if (!cur) { seen.set(a.id, { since: t, reason: reasonOf(v), sent: false }); day.problems.add(a.id); }
            else cur.reason = reasonOf(v);
        }
        for (const [id, s] of seen) if (!still.has(id)) { if (s.sent && on.problems) fixed.push(nameOf(id)); seen.delete(id); }
    }

    function alertBody() {
        const on = S().alerts.on, t = now(), embeds = [];
        if (on.problems) {
            const due = [...seen.entries()].filter(([, s]) => !s.sent && t - s.since >= settleMs);
            if (due.length) {
                embeds.push({ title: `${due.length} account${due.length === 1 ? '' : 's'} need${due.length === 1 ? 's' : ''} a look`, color: COLOR.bad,
                    description: clip(due.map(([id, s]) => `**${nameOf(id)}** — ${s.reason}`)).join('\n') });
                for (const [, s] of due) s.sent = true;
            }
            if (fixed.length) embeds.push({ title: `Fine again: ${fixed.length}`, color: COLOR.ok, description: clip(fixed.splice(0).map(n => `**${n}**`)).join(', ') });
        } else fixed.length = 0;
        if (on.plugins && pluginStops.length) embeds.push({ title: 'Plugin runs stopped', color: COLOR.warn, description: clip(pluginStops.splice(0)).join('\n') });
        else if (!on.plugins) pluginStops.length = 0;
        if (on.restarts && restarts.length) embeds.push({ title: 'ZSB Hub restarted', color: COLOR.warn, description: restarts.splice(0).join('\n') });
        else if (!on.restarts) restarts.length = 0;
        return embeds.length ? { embeds: embeds.slice(0, 10) } : null;
    }

    async function tick() {
        scan();
        if (!urls.alerts || dead.alerts || now() < waitUntil) return;
        const body = alertBody();
        if (!body) return;
        const r = await post('alerts', body);
        if (r.ok) day.alerts++;
    }

    // "[plugin] stopped: why" lines from plugins (ctx.log), not the ones a person or turning it off caused.
    function onLog(line) {
        const m = /^\[([\w-]+)\] stopped: (.+)$/.exec(line.msg);
        if (!m || !/warn|error/.test(line.level) || /^(turned off|stopped by you)\b/.test(m[2])) return;
        const p = (plugins.list() || []).find(x => x.id === m[1]);
        day.pluginStops++;
        if (pluginStops.length < 50) pluginStops.push(`**${p ? p.name : m[1]}**${line.acct ? ' · ' + nameOf(line.acct) : ''} — ${m[2]}`);
    }

    // The watchdog's note on how the last run ended (main.js calls it once at start).
    function lastRunEnded(info) {
        if (!info) return;
        day.restarts++;
        const when = info.at ? ` (${new Date(info.at).toLocaleString('en-GB')})` : '';
        const what = info.why === 'frozen' ? 'it froze and was restarted' : info.why === 'crashed' ? 'it crashed and was restarted' : 'it stopped without quitting and started again';
        const line = info.gaveUp ? `It stopped unexpectedly${when} and kept failing, so it wasn't restarted again — it's running now because it was started.` : `${what[0].toUpperCase() + what.slice(1)}${when}.`;
        log.add(null, 'The hub ' + (info.gaveUp ? 'kept stopping unexpectedly' : what.replace(/^it /, '')), 'warn');
        restarts.push(line);
    }

    // ---- the daily report -----------------------------------------------------------------------------------------
    function snapshot() {
        const views = store.accounts.map(a => engine.view(a));
        const sum = (f) => views.reduce((s, v) => s + (Number(f(v)) || 0), 0);
        return {
            accounts: views.length, clicking: views.filter(v => v.status === 'clicking').length,
            perHour: sum(v => v.startedAt && v.perHour ? v.perHour.total : 0),
            money: sum(v => v.me && v.me.money), tokens: sum(v => v.me && v.me.tokens), networth: sum(v => v.me && v.me.networth),
            premier: sum(v => v.me && v.me.premier),
            look: views.filter(needsLook).length, waiting: views.filter(v => (v.issues || []).some(i => i.code === 'CC-RATE-01')).length,
        };
    }

    function reportBody(t = now()) {
        const h = S().report, s = snapshot(), prev = h.prev || null;
        const hours = (income && income.hours ? income.hours() : []).filter(x => x.h >= t - DAY);
        const earned = hours.reduce((a, x) => a + x.avg, 0);
        const lines = [
            `**Clicking:** ${s.clicking} / ${s.accounts}${s.waiting ? ` · ${s.waiting} waiting for a slot` : ''}`,
            `**Income now:** ${money(s.perHour)}/h${hours.length ? ` · about ${money(earned)} in the last ${hours.length} h` : ''}`,
            `**Money:** ${money(s.money)}${prev ? ` (${signed(s.money - prev.money, money)})` : ''}`,
            `**Tokens:** ${num(s.tokens)}${prev ? ` (${signed(s.tokens - prev.tokens, num)})` : ''}`,
            `**Net worth:** ${money(s.networth)}${prev ? ` (${signed(s.networth - prev.networth, money)})` : ''}`,
            `**Premier (total):** ${num(s.premier)}${prev && prev.premier != null ? ` (${signed(s.premier - prev.premier, num)})` : ''}`,
            '',
            `**Need a look now:** ${s.look || 'none'}`,
            `**Since the last report:** ${day.problems.size} account${day.problems.size === 1 ? '' : 's'} had a problem · ${day.pluginStops} plugin stop${day.pluginStops === 1 ? '' : 's'} · ${day.restarts} restart${day.restarts === 1 ? '' : 's'}`,
        ];
        return { body: { embeds: [{ title: `Daily report · ${new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}`,
            color: s.look ? COLOR.warn : COLOR.ok, description: lines.join('\n'), footer: { text: `ZSB Hub ${version}` } }] }, snap: s };
    }

    // Today's report time as ms (local).
    function dueAt(t = now()) {
        const [hh, mm] = S().report.time.split(':').map(Number), d = new Date(t);
        d.setHours(hh, mm, 0, 0);
        return d.getTime();
    }

    async function sendReport(force = false) {
        const h = S().report, t = now();
        const r = await post('report', reportBody(t).body);
        if (r.ok) {
            h.prev = snapshot(); h.last = t; store.saveSettings();
            day.alerts = 0; day.pluginStops = 0; day.restarts = 0; day.problems = new Set([...seen.keys()]);
        } else if (!force && r.wait) return r;
        return r;
    }

    // Schedule tab: when the next report goes (null: none set up), and Skip next (the one due is marked as sent).
    function nextReport(t = now()) {
        const h = S().report;
        if (!urls.report || dead.report) return null;
        let at = dueAt(t);
        if (at <= t && (h.last || 0) < at) return t;   // due now: it goes within a minute
        while (at <= (h.last || 0) || at <= t) at += DAY;
        return at;
    }
    function skipReport() {
        const at = nextReport();
        if (at == null) return false;
        S().report.last = at; store.saveSettings();
        return true;
    }

    async function reportTick() {
        const h = S().report;
        if (!urls.report || dead.report) return;
        const t = now(), due = dueAt(t);
        if (!h.last) { h.last = t; store.saveSettings(); return; }   // just set up: the first one goes at the next report time
        if (t >= due && h.last < due) await sendReport();
    }

    // ---- set up (rpc) ---------------------------------------------------------------------------------------------
    function set(kind, url) {
        if (!KINDS.includes(kind)) return { ok: false, error: 'No such webhook' };
        const u = String(url || '').trim();
        if (!u) return { ok: false, error: 'Paste the webhook URL first (Discord: channel settings → Integrations → Webhooks → Copy Webhook URL).' };
        if (!HOOK_RE.test(u)) return { ok: false, error: 'That isn\'t a Discord webhook URL — it starts with https://discord.com/api/webhooks/' };
        const h = S();
        h[kind].sealed = store.crypt.seal(u); urls[kind] = u; delete dead[kind];
        if (kind === 'report') h.report.last = now();
        store.saveSettings();
        return { ok: true };
    }
    function clear(kind) {
        if (!KINDS.includes(kind)) return { ok: false, error: 'No such webhook' };
        const h = S(); delete h[kind].sealed; urls[kind] = null; delete dead[kind]; store.saveSettings();
        return { ok: true };
    }
    function options(kind, patch = {}) {
        const h = S();
        if (kind === 'alerts' && patch.on) for (const k of Object.keys(ALERT_ON)) if (patch.on[k] != null) h.alerts.on[k] = !!patch.on[k];
        if (kind === 'report' && patch.time != null) {
            const m = /^(\d{1,2}):(\d{2})$/.exec(String(patch.time));
            if (!m || +m[1] > 23 || +m[2] > 59) return { ok: false, error: 'Use a time like 09:00' };
            h.report.time = String(m[1]).padStart(2, '0') + ':' + m[2];
        }
        store.saveSettings();
        return { ok: true };
    }
    async function test(kind) {
        if (!urls[kind]) return { ok: false, error: 'Save a webhook first.' };
        delete dead[kind];
        const body = kind === 'report' ? reportBody().body
            : { embeds: [{ title: 'ZSB Hub alerts work', color: COLOR.info, description: 'Accounts that need a look, plugin runs that stop and hub restarts will post here.' }] };
        if (kind === 'report') body.embeds[0].title = 'Test — ' + body.embeds[0].title;
        const r = await post(kind, body);
        return r.ok ? { ok: true, message: 'Test sent — check the channel.' } : { ok: false, error: r.wait ? 'Discord is rate-limiting this webhook — try again in a moment.' : 'Not sent: ' + r.error };
    }
    // For the panel: never the URL itself.
    function view() {
        const h = S();
        return Object.fromEntries(KINDS.map(k => [k, {
            set: !!urls[k], tail: urls[k] ? '…/' + urls[k].slice(-4) : '', dead: dead[k] || '', unreadable: !!h[k].sealed && !urls[k],
            ...(k === 'alerts' ? { on: { ...h.alerts.on } } : { time: h.report.time, last: h.report.last || null }),
        }]));
    }

    function start() {
        load();
        offLog = log.on(onLog);
        timer = setInterval(() => { tick().catch(() => {}); }, tickMs);
        reportTimer = setInterval(() => { reportTick().catch(() => {}); }, Math.min(tickMs, 60000));
        for (const x of [timer, reportTimer]) if (x.unref) x.unref();
    }
    function stop() { clearInterval(timer); clearInterval(reportTimer); if (offLog) offLog(); }

    return { start, stop, set, clear, options, test, view, lastRunEnded, tick, reportTick, sendReport, nextReport, skipReport, secrets: () => KINDS.map(k => urls[k]).filter(Boolean) };
}

module.exports = { createNotify, HOOK_RE };
