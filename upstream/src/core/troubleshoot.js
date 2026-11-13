/**
 * TROUBLESHOOT
 *
 * What the Troubleshoot window shows besides the report:
 *  - Sessions: every place an account is signed in (the site's own session list, better-auth's /api/auth/list-sessions),
 *    labelled "this hub", "an earlier hub sign-in", or somewhere else (with the IP and browser), and signing them out.
 *  - Clicks: per account, batches the site refused in the last hour (its own cooldown vs the IP's limit) and missed
 *    ones, with the likely cause; and each route's exit IP.
 *
 * In the background (watch(), after each login and every few hours): a card notice when an account's batches are
 * refused while it's signed in somewhere else (CC-AUTH-05) or when a sign-in appears that wasn't there before
 * (CC-AUTH-06), and the hub's own superseded sign-ins are removed (only sessions this install saw as its own).
 *
 * Busy test (busyTest()): the hub stops clicking one account for up to 2 minutes and watches /api/me. The site has no
 * "who else is clicking" answer, but with the hub idle, money, items, opened cases, tokens, XP or the vault moving
 * means something else is using the account (CC-AUTH-07). The exact signs are the account's lifetime counters on the
 * all-time leaderboard (GET /api/leaderboard?period=all&category=clicks | clickedCases, own entry in `me.value`), which
 * move with every batch that lands; /api/me (money, items, opened cases, tokens, XP, vault) covers everything else.
 *
 * Extra clicks (extraCheck(), every 15 minutes per clicking account, and soon after a refused batch): the lifetime
 * counters' growth minus what the hub's own batches added is what something else clicked. No pause needed; more than
 * a few batches' worth raises CC-AUTH-07, a clean stretch clears it.
 *
 * Session tokens never leave this file: the panel gets the session's id, and a sign-out looks the token up here.
 * The hub's own session is never signed out (revoke-other-sessions keeps the caller's; single sign-outs refuse it).
 */

const HOUR = 3600000;
const IP_CACHE_MS = 10 * 60000;
const RECHECK_MS = 30 * 60000;   // refused batches trigger a session check at most this often per account
const FOREIGN = (s) => s.kind === 'other' || s.kind === 'hubElsewhere';
const BUSY_MS = 120000;        // how long a busy test watches at most
const BUSY_EVERY_MS = 10000;   // how often it reads /api/me
const BUSY_SETTLE_MS = 3000;   // after the hub's last request, before the first reading (a plugin call may still land)
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const EXTRA_EVERY_MS = 15 * 60000;   // extra-clicks check per clicking account
const EXTRA_SOON_MS = 2 * 60000;     // after a refused batch, check again if the last one is older than this
const EXTRA_MIN = { money: 150, cases: 40 };   // below this it's noise (a batch half-counted at the edge), not a clicker
const moneyText = (v) => '$' + (Math.abs(v) >= 1000 ? Math.round(Math.abs(v)).toLocaleString('en-US') : Math.abs(v).toFixed(2));

// What moved between two /api/me readings; null when nothing did.
function busyChanges(a, b) {
    const d = (k) => (Number(b[k]) || 0) - (Number(a[k]) || 0);
    const c = {};
    if (a.clicksTotal != null && b.clicksTotal != null && d('clicksTotal')) c.clicks = d('clicksTotal');
    if (a.clickedCasesTotal != null && b.clickedCasesTotal != null && d('clickedCasesTotal')) c.caseClicks = d('clickedCasesTotal');
    if (Math.abs(d('money')) >= 0.01) c.money = d('money');
    if (d('inventoryCount')) c.items = d('inventoryCount');
    if (d('openedCases')) c.opened = d('openedCases');
    if (Math.abs(d('tokens')) >= 0.01) c.tokens = d('tokens');
    if (d('xp')) c.xp = d('xp');
    if (a.vaultLastCollected !== b.vaultLastCollected) c.vault = true;
    return Object.keys(c).length ? c : null;
}
function describeChanges(c) {
    const out = [], sign = (v) => (v > 0 ? '+' : '−');
    if (c.clicks != null) out.push(sign(c.clicks) + Math.abs(c.clicks).toLocaleString('en-US') + ' money clicks');
    if (c.caseClicks != null) out.push(sign(c.caseClicks) + Math.abs(c.caseClicks).toLocaleString('en-US') + ' cases from case clicks');
    if (c.money != null) out.push(sign(c.money) + moneyText(c.money) + ' money');
    if (c.items != null) out.push(sign(c.items) + Math.abs(c.items).toLocaleString('en-US') + ' items');
    if (c.opened != null) out.push(c.opened.toLocaleString('en-US') + ' cases opened');
    if (c.tokens != null) out.push(sign(c.tokens) + Math.round(Math.abs(c.tokens)).toLocaleString('en-US') + ' tokens');
    if (c.xp != null) out.push(sign(c.xp) + Math.abs(c.xp).toLocaleString('en-US') + ' XP');
    if (c.vault) out.push('vault collected');
    return out.join(', ');
}

// "ZSB Hub 1.1.2" / "Chrome" / "Edge" … and the system, from a user agent.
function describeAgent(ua = '') {
    const hub = /ZSBHub\/([\w.-]+)/.exec(ua);
    const app = hub ? 'ZSB Hub ' + hub[1]
        : /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
        : /Electron\//.test(ua) ? 'An app (Electron)' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari'
        : /node|axios|python|curl|undici|got\b/i.test(ua) ? 'A script' : ua ? 'Something else' : 'Unknown';
    const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS'
        : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
    return { app, os, hub: !!hub };
}

class Troubleshoot {
    constructor({ store, engine, site, log, errors, pluginBusy, timing }) {
        this.store = store; this.engine = engine; this.site = site; this.log = log; this.errors = errors;
        this.pluginBusy = pluginBusy || (() => null);   // account id -> { plugin, what } while a plugin job has it
        this.timing = { busyMs: BUSY_MS, everyMs: BUSY_EVERY_MS, settleMs: BUSY_SETTLE_MS, extraClearMs: EXTRA_EVERY_MS, ...(timing || {}) };
        this.busy = new Map();     // account id -> the last busy test: { state: running|found|clear|stopped|failed, … }
        this.extra = new Map();    // account id -> { base: last counter reading, last: last result }
        this.watched = new Map();  // account id -> when watch() last ran
        this.tokens = new Map();   // account id -> Map(session id -> session token), from the last list
        this.seen = new Map();     // account id -> { at, others, earlier } (for the Clicks view's hints)
        this.ownIps = new Map();   // ip -> route id (learned from the hub's own sessions and the routes' probes)
        this.directIp = null;
    }

    route(acct) { const r = this.engine.run.get(acct.id); return r ? r.route : this.engine.routeFor(acct); }
    isMine(acct, token) { return !!(acct.token && token && (acct.token === token || acct.token.startsWith(token + '.'))); }

    // This PC's exit IP (Cloudflare's trace), asked at most every 10 minutes.
    async learnDirectIp() {
        if (this.directIp && Date.now() - this.directIp.at < IP_CACHE_MS) return;
        const p = await this.engine.probeRoute('direct').catch(() => ({ ok: false }));
        if (p.ok) { this.directIp = { ip: p.ip, at: Date.now() }; this.ownIps.set(p.ip, 'direct'); }
    }

    // Which of the hub's connections an IP is: 'direct', a route id, or null (not one of ours).
    routeOfIp(ip) {
        if (!ip) return null;
        for (const [id, x] of (this.engine.routes || new Map())) if (x.ip === ip) return id;
        return this.ownIps.get(ip) || null;
    }

    async request(acct, path, opts = {}) {
        return this.site.request(acct, path, { ...opts, route: this.route(acct), caller: 'troubleshoot', retryOn: ['net', 'timeout', 'site'], tries: 2 });
    }

    // viewed: the user is looking at the list (the Sessions view), so nothing in it is "new" to them later.
    async sessions(id, { viewed = false } = {}) {
        const acct = this.store.get(id);
        if (!acct) return { ok: false, why: 'gone' };
        if (!acct.token) return { ok: false, why: 'auth' };
        await this.learnDirectIp();
        const r = await this.request(acct, '/api/auth/list-sessions');
        if (r.kind !== 'ok' || !Array.isArray(r.json)) return { ok: false, why: r.kind === 'ok' ? 'shape' : r.kind };
        const tokens = new Map();
        // The hub's own session first: its IP tells which address this account's route has.
        const mine = r.json.find(s => this.isMine(acct, s.token));
        if (mine && mine.ipAddress) this.ownIps.set(mine.ipAddress, this.route(acct));
        // Sessions this install has seen as its own: the only ones the automatic clean-up may remove later.
        if (mine && !(acct.ownSessions || []).includes(String(mine.id))) { acct.ownSessions = [...(acct.ownSessions || []), String(mine.id)].slice(-20); this.store.saveAccountsSoon(); }
        const fresh = new Set(acct.newSessions || []);
        const sessions = r.json.map(s => {
            tokens.set(String(s.id), s.token);
            const agent = describeAgent(s.userAgent), via = this.routeOfIp(s.ipAddress);
            const kind = this.isMine(acct, s.token) ? 'this' : agent.hub && via ? 'earlier' : agent.hub ? 'hubElsewhere' : 'other';
            return { sid: String(s.id), kind, via, ip: s.ipAddress || null, app: agent.app, os: agent.os, fresh: fresh.has(String(s.id)) && kind !== 'this',
                createdAt: Date.parse(s.createdAt) || null, updatedAt: Date.parse(s.updatedAt) || null, expiresAt: Date.parse(s.expiresAt) || null };
        }).sort((a, b) => (a.kind === 'this' ? -1 : b.kind === 'this' ? 1 : (b.createdAt || 0) - (a.createdAt || 0)));
        this.tokens.set(id, tokens);
        const counts = { others: sessions.filter(s => s.kind === 'other' || s.kind === 'hubElsewhere').length, earlier: sessions.filter(s => s.kind === 'earlier').length, found: !!mine };
        this.seen.set(id, { at: Date.now(), ...counts });
        // A new sign-in that's gone again needs no notice.
        if (fresh.size && !sessions.some(s => s.fresh)) this.acknowledge(id);
        if (viewed) { acct.knownSessions = sessions.map(s => s.sid); this.store.saveAccountsSoon(); }
        this.judge(acct, counts);
        return { ok: true, sessions, ...counts };
    }

    // CC-AUTH-05 while the site refuses the account's batches and it's signed in somewhere else.
    judge(acct, counts) {
        if (!this.errors) return;
        const h = this.engine.clickHealth(acct);
        if (h.running && h.refused >= 2 && counts.others) {
            if (!this.errors.has(acct.id, 'CC-AUTH-05')) { this.log.add(acct.id, `${h.refused} batches refused in the last hour, and it's signed in somewhere else too — something else may be clicking it`, 'warn'); this.errors.raise(acct.id, 'CC-AUTH-05'); }
        } else this.errors.clear(acct.id, 'CC-AUTH-05');
    }

    // The user looked at an account's new sign-ins (or they're gone).
    acknowledge(id) {
        const acct = this.store.get(id);
        if (acct && acct.newSessions && acct.newSessions.length) { acct.newSessions = []; this.store.saveAccountsSoon(); }
        if (this.errors) this.errors.clear(id, 'CC-AUTH-06');
        return { ok: true };
    }

    // The background check: the list, the hub's own superseded sign-ins removed (when the setting is on), and a
    // notice for a sign-in that wasn't there at the last check. The first check only notes what's there.
    async watch(id) {
        const acct = this.store.get(id);
        if (!acct || !acct.token) return { ok: false, why: 'auth' };
        this.watched.set(id, Date.now());
        let list = await this.sessions(id);
        if (!list.ok) return list;
        if (list.found && this.store.settings.cleanOldSignIns !== false) {
            const own = new Set(acct.ownSessions || []);
            let n = 0;
            for (const s of list.sessions.filter(x => x.kind !== 'this' && own.has(x.sid))) if ((await this.revoke(id, s.sid, true)).ok) n++;
            if (n) {
                this.log.add(id, `Removed ${n} old sign-in${n === 1 ? '' : 's'} this hub had left on the site`, 'info');
                list = await this.sessions(id);
                if (!list.ok) return list;
            }
        }
        if (Array.isArray(acct.knownSessions)) {
            const added = list.sessions.filter(s => FOREIGN(s) && !acct.knownSessions.includes(s.sid));
            if (added.length) {
                acct.newSessions = [...new Set([...(acct.newSessions || []), ...added.map(s => s.sid)])];
                const what = added.map(s => s.app + (s.os ? ' on ' + s.os : '')).join(', ');
                this.log.add(id, 'Signed in from a new place: ' + what, 'warn');
                if (this.errors) this.errors.raise(id, 'CC-AUTH-06', what);
            }
        }
        acct.knownSessions = list.sessions.map(s => s.sid);
        this.store.saveAccountsSoon();
        return list;
    }

    // The engine saw a batch refused: with two in the hour, look at the sessions now instead of at the next round.
    noteRefused(id) {
        const x = this.extra.get(id);
        if (!x || !x.base || Date.now() - x.base.at >= EXTRA_SOON_MS) this.extraCheck(id).catch(() => {});
        const acct = this.store.get(id);
        if (!acct || Date.now() - (this.watched.get(id) || 0) < RECHECK_MS) return;
        if (this.engine.clickHealth(acct).refused < 2) return;
        this.watch(id).catch(() => {});
    }

    // Every connection's exit IP and how long the site took to answer through it, asked now.
    async testRoutes() {
        const ids = ['direct', ...(this.engine.routes ? this.engine.routes.keys() : [])];
        const out = [];
        const worker = async () => {
            for (let id; (id = ids.shift());) {
                const p = await this.engine.probeRoute(id).catch(e => ({ ok: false, error: e.message }));
                if (p.ok) { this.ownIps.set(p.ip, id); if (id === 'direct') this.directIp = { ip: p.ip, at: Date.now() }; }
                out.push({ id, ok: !!p.ok, ip: p.ok ? p.ip : null, ms: p.ok ? p.ms : null, error: p.ok ? null : String(p.error || 'no answer') });
            }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        // Connections that come out on the same IP share that IP's limit.
        for (const r of out) r.sharedWith = r.ip ? out.filter(x => x !== r && x.ip === r.ip).map(x => x.id) : [];
        this.tested = { at: Date.now(), routes: out };
        return this.tested;
    }

    // One session out (never the hub's own).
    async revoke(id, sid, quiet = false) {
        const acct = this.store.get(id), token = (this.tokens.get(id) || new Map()).get(String(sid));
        if (!acct || !token) return { ok: false, why: 'unknown' };
        if (this.isMine(acct, token)) return { ok: false, why: 'mine' };
        const r = await this.request(acct, '/api/auth/revoke-session', { method: 'POST', body: { token } });
        if (r.kind !== 'ok') return { ok: false, why: r.kind, status: r.status };
        this.tokens.get(id).delete(String(sid));
        if (!quiet) this.log.add(id, 'Troubleshoot: signed out one of its other sessions', 'info');
        return { ok: true };
    }

    // Every session but the hub's own.
    async revokeOthers(id) {
        const acct = this.store.get(id);
        if (!acct || !acct.token) return { ok: false, why: 'auth' };
        const r = await this.request(acct, '/api/auth/revoke-other-sessions', { method: 'POST', body: {} });
        if (r.kind !== 'ok') return { ok: false, why: r.kind, status: r.status };
        this.log.add(id, 'Troubleshoot: signed out everywhere else (only this hub stays signed in)', 'ok');
        if (this.errors) this.errors.clear(id, 'CC-AUTH-07');   // a fresh busy test tells whether that was it
        return { ok: true };
    }

    // Earlier hub sign-ins from this hub's own IPs (left over from re-imports and "Log in again").
    async cleanup(id) {
        const list = await this.sessions(id);
        if (!list.ok) return list;
        if (!list.found) return { ok: false, why: 'notFound' };   // can't tell which one is ours: touch nothing
        let n = 0;
        for (const s of list.sessions.filter(x => x.kind === 'earlier')) if ((await this.revoke(id, s.sid)).ok) n++;
        return { ok: true, removed: n };
    }

    // Busy test: pause the hub on this account and watch whether anything else moves it. Starts and returns at once;
    // the result goes to the log, the card (CC-AUTH-07 when something was seen) and busy.get(id).
    busyTest(id) {
        const acct = this.store.get(id), r = this.engine.run.get(id);
        if (!acct || !r) return { ok: false, why: 'stopped' };
        if (r.held) return { ok: false, why: 'running' };
        const job = this.pluginBusy(id);
        if (job) return { ok: false, why: 'plugin', what: job.what };
        if (!this.engine.isHealthy(id)) return { ok: false, why: 'unhealthy' };
        const { busyMs, settleMs } = this.timing, startedAt = Date.now();
        const held = this.engine.hold(id, { startedAt, ends: startedAt + busyMs + settleMs });
        if (!held) return { ok: false, why: 'running' };
        const test = { state: 'running', startedAt, stop: false };
        this.busy.set(id, test);
        this.log.add(id, 'Busy test: clicking paused for up to 2 minutes, watching for anything else using the account', 'info');
        this.runBusy(id, r, held, test).catch(e => { test.state = 'failed'; test.why = e.message; })
            .finally(() => { this.engine.release(id, held); test.endedAt = Date.now(); delete test.stop; this.engine.emit('change'); });
        return { ok: true, startedAt };
    }

    busyStop(id) {
        const t = this.busy.get(id);
        if (!t || t.state !== 'running') return { ok: false };
        t.stop = true;
        return { ok: true };
    }

    async runBusy(id, r, held, test) {
        const { busyMs, everyMs, settleMs } = this.timing;
        const live = () => this.engine.run.get(id) === r && r.held === held && !test.stop;
        // Let the hub's own last batch, vault collect and report finish first.
        for (let i = 0; i < 40 && (r.busy.click || r.busy.vault || r.busy.report); i++) await sleep(500);
        await sleep(settleMs);
        const read = async () => {
            const acct = this.store.get(id);
            if (!acct) return null;
            const board = (cat) => this.request(acct, `/api/leaderboard?period=all&category=${cat}&limit=10`)
                .then(r => (r.kind === 'ok' && r.json && r.json.me && typeof r.json.me.value === 'number' ? r.json.me.value : null)).catch(() => null);
            const [res, clicksTotal, clickedCasesTotal] = await Promise.all([this.request(acct, '/api/me'), board('clicks'), board('clickedCases')]);
            if (!(res && res.kind === 'ok' && res.json && typeof res.json === 'object')) return null;
            return { ...res.json, clicksTotal, clickedCasesTotal };   // a copy: the next reading is compared with it
        };
        if (!live()) { test.state = 'stopped'; return; }
        const base = await read();
        if (!base) { test.state = 'failed'; test.why = 'no answer from the site'; this.log.add(id, "Busy test: the site didn't answer, try again later", 'warn'); return; }
        const t0 = Date.now();
        while (Date.now() - t0 < busyMs) {
            await sleep(Math.min(everyMs, busyMs - (Date.now() - t0)));
            if (!live()) { test.state = 'stopped'; this.log.add(id, 'Busy test: stopped', 'info'); return; }
            const cur = await read();
            if (!cur) continue;
            const c = busyChanges(base, cur);
            if (c) {
                const secs = Math.max(1, Math.round((Date.now() - t0) / 1000)), what = describeChanges(c);
                Object.assign(test, { state: 'found', changes: c, what, secs });
                this.log.add(id, `Busy test: something else is using this account — ${what} in ${secs} s while the hub was paused`, 'warn');
                if (this.errors) this.errors.raise(id, 'CC-AUTH-07', `${what} in ${secs} s`);
                return;
            }
        }
        test.state = 'clear'; test.secs = Math.round((Date.now() - t0) / 1000);
        this.log.add(id, `Busy test: nothing else touched the account in ${Math.round(test.secs / 60 * 10) / 10} minutes`, 'ok');
        if (this.errors) this.errors.clear(id, 'CC-AUTH-07');
    }

    // The account's lifetime counters (all-time leaderboard, own entry): money clicks and cases from case clicks.
    async counters(acct) {
        const board = (cat) => this.request(acct, `/api/leaderboard?period=all&category=${cat}&limit=10`)
            .then(r => (r.kind === 'ok' && r.json && r.json.me && typeof r.json.me.value === 'number' ? r.json.me.value : null)).catch(() => null);
        const [clicks, cases] = await Promise.all([board('clicks'), board('clickedCases')]);
        return clicks == null || cases == null ? null : { clicks, cases };
    }

    // Counter growth since the last reading minus what the hub's own batches added = clicks from somewhere else.
    async extraCheck(id) {
        const acct = this.store.get(id), r = this.engine.run.get(id);
        if (!acct || !r || r.refreshing || !this.engine.isHealthy(id) && !r.held) return { ok: false, why: 'stopped' };
        const x = this.extra.get(id) || {};
        if (x.checking) return { ok: false, why: 'running' };
        x.checking = true; this.extra.set(id, x);
        try {
            for (let i = 0; i < 20 && r.busy.click; i++) await sleep(500);   // not across a batch in flight
            if (r.busy.click) return { ok: false, why: 'busy' };
            const landed = { money: 0, cases: 0, unsure: 0, ...(r.landed || {}) };
            const c = await this.counters(acct);
            // A batch started meanwhile: the counters may or may not have it. Keep the old reading, try next time.
            if (!c || r.busy.click || JSON.stringify(landed) !== JSON.stringify({ money: 0, cases: 0, unsure: 0, ...(r.landed || {}) })) return { ok: false, why: c ? 'busy' : 'noCounters' };
            const now = { at: Date.now(), run: r, ...c, hubMoney: landed.money, hubCases: landed.cases, unsure: landed.unsure };
            const prev = x.base;
            x.base = now;
            if (!prev || prev.run !== r || prev.unsure !== now.unsure) return { ok: true, baseline: true };
            const money = (now.clicks - prev.clicks) - (now.hubMoney - prev.hubMoney);
            const cases = (now.cases - prev.cases) - (now.hubCases - prev.hubCases);
            const minutes = Math.max(1, Math.round((now.at - prev.at) / 60000));
            x.last = { at: now.at, minutes, money, cases };
            if (money >= EXTRA_MIN.money || cases >= EXTRA_MIN.cases) {
                const parts = [];
                if (money >= EXTRA_MIN.money) parts.push(`+${money.toLocaleString('en-US')} money clicks`);
                if (cases >= EXTRA_MIN.cases) parts.push(`+${cases.toLocaleString('en-US')} cases from case clicks`);
                const what = `${parts.join(', ')} from somewhere else in ${minutes} min`;
                if (this.errors && !this.errors.has(id, 'CC-AUTH-07')) this.log.add(id, `Something else is clicking this account: ${what} (on top of the hub's own)`, 'warn');
                if (this.errors) this.errors.raise(id, 'CC-AUTH-07', what);
                x.last.found = true;
                x.cleanFrom = null;
            } else if (money <= 0 && cases <= 0) {
                // A clicker that sends in bursts leaves clean gaps: the notice goes only after a clean stretch of 15 minutes.
                x.cleanFrom = x.cleanFrom || prev.at;
                const clean = now.at - x.cleanFrom;
                if (clean >= this.timing.extraClearMs && this.errors && this.errors.has(id, 'CC-AUTH-07') && !(this.busy.get(id) && this.busy.get(id).state === 'running')) {
                    this.errors.clear(id, 'CC-AUTH-07');
                    this.log.add(id, `No clicks from anywhere else in the last ${Math.round(clean / 60000)} min`, 'ok');
                }
            }
            return { ok: true, ...x.last };
        } finally { x.checking = false; }
    }

    // Every half minute: the clicking accounts whose last check is 15 minutes old, two at a time, spread out.
    async extraTick() {
        if (this.extraTicking) return;
        this.extraTicking = true;
        try {
            const due = [...this.engine.run.keys()].filter(id => {
                const x = this.extra.get(id);
                if (!x || !x.firstAt) { this.extra.set(id, { ...(x || {}), firstAt: Date.now() + Math.random() * 5 * 60000 }); return false; }
                return Date.now() >= x.firstAt && (!x.base || Date.now() - x.base.at >= EXTRA_EVERY_MS);
            }).slice(0, 2);
            for (const id of due) await this.extraCheck(id).catch(() => {});
        } finally { this.extraTicking = false; }
    }

    extraView(id) {
        const x = this.extra.get(id);
        return x && x.last ? { ...x.last } : null;
    }

    busyView(id) {
        const t = this.busy.get(id);
        if (!t) return null;
        const { stop, ...v } = t;
        return v;
    }

    clicks() {
        const routes = ['direct', ...(this.engine.routes ? this.engine.routes.keys() : [])].map(rid => {
            const x = rid === 'direct' ? null : this.engine.routes.get(rid);
            return { id: rid, label: x ? x.label : null, ip: rid === 'direct' ? (this.directIp && this.directIp.ip) || null : x.ip || null,
                down: this.engine.routeDown(rid), used: this.engine.usedIn(this.engine.groupOf(rid)), max: this.engine.settings.maxPerIp };
        });
        const accounts = this.store.accounts.map(a => {
            const h = this.engine.clickHealth(a), seen = this.seen.get(a.id) || null;
            let cause = null;
            if (h.running) {
                if (h.refused >= 2 && seen && seen.others) cause = 'elsewhere';
                else if (h.refused >= 2) cause = 'own';
                else if (h.ipRefused >= 2) cause = 'ip';
                else if (h.missed >= 3) cause = 'behind';
                else cause = 'ok';
            }
            return { id: a.id, name: a.name, route: h.running ? this.engine.run.get(a.id).route : a.route || 'direct', ...h, cause,
                others: seen ? seen.others : null, earlier: seen ? seen.earlier : null, busy: this.busyView(a.id), extra: this.extraView(a.id) };
        });
        return { routes, accounts, hourMs: HOUR, tested: this.tested || null };
    }
}

module.exports = { Troubleshoot, describeAgent, busyChanges, describeChanges };
