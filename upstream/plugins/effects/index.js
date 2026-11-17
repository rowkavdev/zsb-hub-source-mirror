/**
 * EFFECTS
 *
 * The site's special effects (boosts, cashbacks), on every account at once or one account:
 *   stock      GET    /api/inventory/specialEffects            -> [{ name, effect, amount, ... }] (only ones owned)
 *   buy one    PUT    /api/inventory/specialEffects { name }   -> the updated entry; costs ammo (/api/me ammu)
 *   sell       DELETE /api/inventory/specialEffects { name, amount }  (amount required) -> ammo back
 *   activate   POST   /api/inventory/specialEffects { name }   -> /api/me activeSpecialEffects [{ effect, name, activeTill }]
 * One effect of a kind (family, e.g. caseOpenCountBoost) runs at a time. The catalogue and ammo prices are the
 * site's own (its inventory Special Effects window, 2026-11-14): buy 20/40/80/400/1600, sell back 5/10/20/100/400
 * by rarity. Ammo only — nothing here touches real money.
 *
 * Mass actions (Buy, Sell, Sell all, Use now, Queue) run on the picked effects, on all clicking accounts or one.
 * The queue (per account) starts each queued effect as soon as nothing of its kind is running, in the order queued,
 * and can buy it with ammo first when the account has none (above "keep ammo").
 */

const RARITY = {
    'Mil-Spec Grade': { buy: 20, sell: 5 }, Restricted: { buy: 40, sell: 10 }, Classified: { buy: 80, sell: 20 },
    Covert: { buy: 400, sell: 100 }, Extraordinary: { buy: 1600, sell: 400 },
};
const T = ['Tiny', 'Small', 'Medium', 'Big', 'Huge'], R = Object.keys(RARITY);
const fam = (effect, label, names, mins, values) => names.map((n, i) => ({ effect, family: label, name: n, rarity: R[R.length - names.length + i], durationMinutes: mins[i], value: values[i] }));
const five = (fmt) => T.map(t => fmt(t));
const CATALOG = [
    ...fam('moneyPerClickBoost', 'Money per click', five(t => `${t} Click Boost`), [15, 30, 60, 60, 90], [0.1, 0.25, 0.25, 0.5, 1]),
    ...fam('casesPerClickBoost', 'Cases per click', five(t => `${t} Case Click Boost`), [15, 30, 60, 60, 90], [3, 7, 10, 20, 34]),
    ...fam('casesPerClickMaxPriceBoost', 'Case click max price', five(t => `${t} Case Click Money Boost`), [15, 30, 60, 60, 90], [5, 10, 25, 50, 100]),
    ...fam('xpBoost', 'Case open XP', five(t => `${t} Case Open XP Boost`), [15, 30, 60, 60, 90], [10, 15, 20, 30, 50]),
    ...fam('vaultCapacityBoost', 'Vault capacity', five(t => `${t} Vault Capacity Boost`), [1440, 1440, 2160, 2880, 2880], [500, 1000, 2000, 5000, 10000]),
    ...fam('vaultMoneyPerMinuteBoost', 'Vault money/min', five(t => `${t} Vault Money/min Boost`), [1440, 1440, 2160, 2880, 2880], [5, 10, 20, 50, 100]),
    ...fam('caseOpenCashback', 'Case open cashback', five(t => `${t} Case Open Cashback`), [5, 15, 30, 30, 60], [1, 2, 3, 5, 5]),
    ...fam('casebattleCashback', 'Case battle cashback', five(t => `${t} Casebattle Cashback`), [30, 30, 30, 90, 180], [1, 2, 2.5, 3, 3.5]),
    ...fam('caseOpenCountBoost', 'Case open count', five(t => `${t} Case Open Count Boost`), [5, 10, 20, 30, 60], [2, 5, 5, 10, 15]),
    ...fam('caseOpenMultiplierBoost', 'Case open multiplier', ['Big Case Open Multiplier Boost', 'Huge Case Open Multiplier Boost'], [15, 60], [1, 1]),
    { effect: 'resetSkillmaps', family: 'Skillmaps', name: 'Reset Skillmaps', rarity: 'Extraordinary', noUse: true },
];
const BY_NAME = new Map(CATALOG.map(e => [e.name, e]));
const FAMILIES = [...new Set(CATALOG.map(e => e.family))];
const LOCKED = /locked/i;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const count = (n) => Math.round(n).toLocaleString('en-US');
const mins = (m) => (m >= 60 ? `${+(m / 60).toFixed(1)} h` : `${m} min`);
const left = (ms) => (ms <= 0 ? 'ending' : ms >= 3600000 ? `${Math.floor(ms / 3600000)} h ${Math.round(ms % 3600000 / 60000)} min` : `${Math.max(1, Math.round(ms / 60000))} min`);
function describe(e) {
    const d = e.durationMinutes ? ` for ${mins(e.durationMinutes)}` : '';
    switch (e.effect) {
        case 'moneyPerClickBoost': return `+$${e.value} per click${d}`;
        case 'casesPerClickBoost': return `+${e.value}% cases per click${d}`;
        case 'casesPerClickMaxPriceBoost': return `+$${e.value} case click max price${d}`;
        case 'xpBoost': return `+${e.value}% XP${d}`;
        case 'vaultCapacityBoost': return `+$${count(e.value)} vault capacity${d}`;
        case 'vaultMoneyPerMinuteBoost': return `+$${e.value} vault money/min${d}`;
        case 'caseOpenCashback': return `${e.value}% cashback on case opens${d}`;
        case 'casebattleCashback': return `${e.value}% cashback on case battles${d}`;
        case 'caseOpenCountBoost': return `+${e.value} cases per open${d}`;
        case 'caseOpenMultiplierBoost': return `+${e.value} open multiplier${d}`;
        case 'resetSkillmaps': return 'resets skillmaps with a full refund (buy and sell only here)';
        default: return '';
    }
}

let ctx = null;
let state = null;    // saved: { picked: [names], queues: { aid: [names] }, log: [...] }
const seen = new Map();   // aid -> { at, ammo, stock: { name: n }, active: [{ name, effect, till }] }
let job = null;           // the mass action running now: { what, done, of, at }
let ticking = false;

const S = (k) => ctx.settings.get(k);
const save = () => ctx.data.set(state);
const picked = () => (state.picked || []).filter(n => BY_NAME.has(n));
const famOf = (name) => (BY_NAME.get(name) || {}).effect;

// The accounts the actions and the queue work on: every clicking account, or the one chosen.
function targets() {
    const list = ctx.accounts.list();
    if (S('scope') === 'one') { const a = list.find(x => x.id === S('account')); return a ? [a] : []; }
    return list;
}

async function call(aid, path, opts) {
    for (let i = 0; ; i++) {
        const r = await ctx.request(aid, path, opts);
        const err = r.json && r.json.error;
        if (r.kind === 'ok' && !err) return r.json;
        // Another of the account's actions running (an open, a battle): the site says "locked"; a moment later it takes it.
        if (i < 5 && LOCKED.test(String(err || ''))) { await ctx.sleep(400 + 300 * i); continue; }
        throw new Error(err || (r.kind === 'not-running' ? 'not clicking' : 'HTTP ' + r.status));
    }
}

// Stock, ammo and what's running, read fresh.
async function look(aid) {
    const [me, list] = await Promise.all([call(aid, '/api/me'), call(aid, '/api/inventory/specialEffects')]);
    const now = Date.now();
    const stock = {};
    for (const e of Array.isArray(list) ? list : []) if (e && e.name) stock[e.name] = num(e.amount);
    const active = (Array.isArray(me.activeSpecialEffects) ? me.activeSpecialEffects : [])
        .map(e => ({ name: e.name, effect: e.effect || famOf(e.name), till: Date.parse(e.activeTill || '') || 0 })).filter(e => e.till > now);
    const v = { at: now, ammo: num(me.ammu), stock, active };
    seen.set(aid, v);
    return v;
}

async function buyOne(aid, name, v) {
    const e = BY_NAME.get(name), cost = RARITY[e.rarity].buy;
    if (v.ammo - cost < num(S('keepAmmo'))) return false;
    const got = await call(aid, '/api/inventory/specialEffects', { method: 'PUT', body: { name } });
    v.ammo -= cost;
    v.stock[name] = got && got.amount != null ? num(got.amount) : (v.stock[name] || 0) + 1;
    return true;
}

async function activate(aid, name, v) {
    await call(aid, '/api/inventory/specialEffects', { method: 'POST', body: { name } });
    const e = BY_NAME.get(name);
    v.stock[name] = Math.max(0, (v.stock[name] || 0) - 1);
    v.active.push({ name, effect: e.effect, till: Date.now() + num(e.durationMinutes) * 60000 });
}

// ---- mass actions ----
async function mass(kind, names, accts) {
    const qty = Math.max(1, Math.floor(num(S('qty')) || 1));
    const practice = ctx.power.practice();
    job = { what: kind, done: 0, of: accts.length, at: Date.now() };
    const totals = { n: 0, ammo: 0, skipped: [] };
    try {
        for (const a of accts) {
            if (ctx.stopping) break;
            if (!a.healthy) { totals.skipped.push(`${a.name} (not clicking)`); job.done++; continue; }
            try {
                const v = await look(a.id);
                const did = [];
                for (const name of names) {
                    const e = BY_NAME.get(name), have = v.stock[name] || 0;
                    if (kind === 'buy') {
                        let k = 0;
                        for (; k < qty; k++) {
                            if (practice) { if (v.ammo - RARITY[e.rarity].buy * (k + 1) < num(S('keepAmmo'))) break; continue; }
                            if (!(await buyOne(a.id, name, v))) break;
                        }
                        if (k) { did.push(`${k} ${name}`); totals.n += k; totals.ammo -= k * RARITY[e.rarity].buy; }
                        if (k < qty) totals.skipped.push(`${a.name}: not enough ammo for ${qty - k} ${name}`);
                    } else if (kind === 'sell' || kind === 'sellAll') {
                        const k = kind === 'sellAll' ? have : Math.min(qty, have);
                        if (!k) continue;
                        if (!practice) { const got = await call(a.id, '/api/inventory/specialEffects', { method: 'DELETE', body: { name, amount: k } }); v.stock[name] = got && got.amount != null ? num(got.amount) : have - k; v.ammo += k * RARITY[e.rarity].sell; }
                        did.push(`${k} ${name}`); totals.n += k; totals.ammo += k * RARITY[e.rarity].sell;
                    } else if (kind === 'use') {
                        if (e.noUse) continue;
                        const running = v.active.find(x => x.effect === e.effect);
                        if (running) { totals.skipped.push(`${a.name}: ${running.name} is still running (${left(running.till - Date.now())})`); continue; }
                        if (!have && !(S('buyToUse') && (practice || await buyOne(a.id, name, v)))) { totals.skipped.push(`${a.name}: no ${name}`); continue; }
                        if (!practice) await activate(a.id, name, v);
                        did.push(name); totals.n++;
                    } else if (kind === 'queue') {
                        if (e.noUse) continue;
                        const q = (state.queues[a.id] = state.queues[a.id] || []);
                        for (let k = 0; k < qty; k++) q.push(name);
                        did.push(`${qty}× ${name}`); totals.n += qty;
                    }
                }
                const verb = { buy: 'bought', sell: 'sold', sellAll: 'sold', use: 'started', queue: 'queued' }[kind];
                if (did.length) ctx.log(`${practice ? 'practice — would have ' : ''}${verb} ${did.join(', ')}`, 'ok', a.id);
            } catch (e) { totals.skipped.push(`${a.name}: ${e.message}`); ctx.log(`${kind}: ${e.message}`, 'warn', a.id); }
            job.done++;
        }
    } finally { job = null; save(); }
    if (kind === 'queue') tick();
    return totals;
}

// ---- the queue ----
async function tick() {
    if (ticking || !ctx.power.live()) return;
    ticking = true;
    try {
        for (const a of ctx.accounts.list()) {
            const q = state.queues[a.id];
            if (!q || !q.length || !a.healthy || ctx.stopping) continue;
            let v;
            try { v = await look(a.id); } catch (_) { continue; }
            const started = new Set();
            for (let i = 0; i < q.length; i++) {
                const name = q[i], e = BY_NAME.get(name);
                if (!e || e.noUse) { q.splice(i--, 1); continue; }
                // Only the first queued of each kind is next; later ones wait their turn.
                if (started.has(e.effect)) continue;
                started.add(e.effect);
                if (v.active.some(x => x.effect === e.effect)) continue;
                try {
                    if (!(v.stock[name] > 0) && !(S('buyForQueue') && await buyOne(a.id, name, v))) {
                        v.waiting = { ...(v.waiting || {}), [name]: S('buyForQueue') ? 'not enough ammo' : 'none in stock' };
                        continue;
                    }
                    await activate(a.id, name, v);
                    q.splice(i--, 1);
                    ctx.log(`queue: started ${name} (${describe(e)}) — ${q.length} left in the queue`, 'ok', a.id);
                } catch (err) { ctx.log(`queue: ${name} — ${err.message}`, 'warn', a.id); }
            }
            if (!q.length) delete state.queues[a.id];
        }
        save();
    } finally { ticking = false; }
}

function render() {
    const on = !!S('on'), accts = targets();
    const scopeName = S('scope') === 'one' ? (accts[0] ? accts[0].name : 'no account chosen') : `all ${accts.length} accounts`;
    const pk = new Set(picked());
    const owned = (name) => accts.reduce((t, a) => t + num(((seen.get(a.id) || {}).stock || {})[name]), 0);
    const running = (name) => accts.filter(a => ((seen.get(a.id) || {}).active || []).some(x => x.name === name && x.till > Date.now())).length;
    const ammo = accts.reduce((t, a) => t + num((seen.get(a.id) || {}).ammo), 0);
    const queued = accts.reduce((t, a) => t + ((state.queues[a.id] || []).length), 0);
    const qty = Math.max(1, Math.floor(num(S('qty')) || 1));
    const names = [...pk];
    const sel = names.length ? `${names.length} picked` : 'pick effects below';
    const ammoCost = names.reduce((t, n) => t + RARITY[BY_NAME.get(n).rarity].buy * qty, 0) * accts.length;

    const rows = accts.map(a => {
        const v = seen.get(a.id), q = state.queues[a.id] || [];
        const act = v ? v.active.filter(x => x.till > Date.now()).map(x => `${x.name} (${left(x.till - Date.now())})`).join(', ') : '';
        const stock = v ? Object.entries(v.stock).filter(([, n]) => n > 0).map(([n, k]) => `${k}× ${n.replace(/ Boost$| Cashback$/, '')}`).join(', ') : '';
        return [a.name, !a.healthy ? 'not clicking' : v ? count(v.ammo) : '—', stock || (v ? 'none' : '—'), act || (v ? 'nothing' : '—'), q.length ? `${q.length}: ${q.slice(0, 3).join(', ')}${q.length > 3 ? ', …' : ''}` : '—'];
    });

    return { blocks: [
        { type: 'card', id: 'power', toggle: 'on', toggleDisabled: ctx.power.practice() ? 'Set the mode to Live first' : null, bodyWhenOff: true, open: ctx.power.practice(), keys: ['runMode'],
            title: on ? 'Effects — queue on' : 'Effects — queue off',
            summary: ctx.power.practice() ? 'practice: the queue only runs in Live' : !on ? 'queued effects wait until this is on' : queued ? `${queued} queued, each starts once nothing of its kind runs` : 'nothing queued' },
        { type: 'stats', items: [
            { label: 'Accounts', value: scopeName }, { label: 'Ammo', value: count(ammo) },
            { label: 'Picked', value: String(names.length) }, { label: 'Queued', value: count(queued) },
        ] },
        { type: 'card', id: 'who', open: false, title: 'Accounts and amounts', summary: `${scopeName} · ${qty} of each per account · keep ${count(num(S('keepAmmo')))} ammo`,
            keys: ['scope', 'account', 'qty', 'keepAmmo', 'buyToUse', 'buyForQueue'] },
        { type: 'card', id: 'act', title: 'Do it', summary: sel, text: names.length ? `On ${scopeName}: buy ${qty} of each (up to ${count(ammoCost)} ammo), sell ${qty} or all, start now, or queue ${qty} of each.` : 'Pick one or more effects below, then choose what to do with them.',
            blocks: [
                { type: 'buttons', items: [
                    { label: `Buy ${qty} each`, action: 'buy', primary: true },
                    { label: `Sell ${qty} each`, action: 'sell' },
                    { label: 'Sell all picked', action: 'sellAll', danger: true, confirm: `Sell every one of the picked effects on ${scopeName}?` },
                    { label: 'Use now', action: 'use' },
                    { label: `Queue ${qty} each`, action: 'queue' },
                ] },
                { type: 'buttons', items: [
                    { label: 'Refresh', action: 'refresh' },
                    { label: 'Pick what they own', action: 'pickOwned' },
                    { label: 'Clear picks', action: 'clearPicks' },
                    { label: 'Clear queue', action: 'clearQueue', confirm: `Empty the queue on ${scopeName}?` },
                ] },
                ...(job ? [{ type: 'notice', text: `${job.what}: ${job.done} of ${job.of} accounts done…` }] : []),
                ...(ctx.power.practice() ? [{ type: 'notice', level: 'warn', text: 'Practice mode: the buttons only show what they would do. Set the mode to Live to buy, sell or start effects.' }] : []),
            ] },
        ...FAMILIES.map(f => ({ type: 'card', id: 'f:' + f, open: CATALOG.some(e => e.family === f && pk.has(e.name)), title: f,
            summary: CATALOG.filter(e => e.family === f && pk.has(e.name)).map(e => e.name.split(' ')[0]).join(', ') || describe(CATALOG.find(e => e.family === f)).replace(/^[^a-z]*/i, '').replace(/ for .*$/, ''),
            blocks: [{ type: 'picker', action: 'pick', multi: true, grid: true, tag: 'Picked', items: CATALOG.filter(e => e.family === f).map(e => {
                const o = owned(e.name), r = running(e.name);
                return { id: e.name, on: pk.has(e.name), title: e.name, sub: describe(e),
                    meta: `${e.rarity} · buy ${RARITY[e.rarity].buy} · sell ${RARITY[e.rarity].sell} ammo · own ${count(o)}${r ? ` · running on ${r}` : ''}` };
            }) }] })),
        { type: 'card', id: 'accounts', open: false, title: 'Per account', summary: `${rows.length} account${rows.length === 1 ? '' : 's'} · Refresh reads them`, bare: true,
            blocks: rows.length ? [{ type: 'table', wrap: true, columns: ['Account', 'Ammo', 'Owned', 'Running', 'Queue'], rows }] : [{ type: 'notice', text: S('scope') === 'one' ? 'Choose the account in "Accounts and amounts".' : 'No accounts yet.' }] },
    ] };
}

module.exports = {
    CATALOG, RARITY,
    start(c) {
        ctx = c;
        state = { picked: [], queues: {}, ...ctx.data.get() };
        state.queues = state.queues || {};
        let tickAt = 0;
        ctx.every(1000, () => { if (Date.now() - tickAt >= (num(S('everyMs')) || 15000)) { tickAt = Date.now(); tick(); } });
        // Fresh numbers for the table now and then (one account at a time, not all at once).
        ctx.everyAccount(10 * 60000, async (a) => { if (targets().some(x => x.id === a.id)) { try { await look(a.id); } catch (_) {} } });

        ctx.panel.action('pick', (name) => {
            if (!BY_NAME.has(name)) return { ok: false };
            const s = new Set(picked());
            if (s.has(name)) s.delete(name); else s.add(name);
            state.picked = [...s]; save();
            return { ok: true };
        });
        ctx.panel.action('clearPicks', () => { state.picked = []; save(); return { message: 'Picks cleared.' }; });
        ctx.panel.action('pickOwned', () => {
            const s = new Set();
            for (const a of targets()) for (const [n, k] of Object.entries((seen.get(a.id) || {}).stock || {})) if (k > 0 && BY_NAME.has(n)) s.add(n);
            state.picked = [...s]; save();
            return { message: s.size ? `Picked ${s.size} effect${s.size === 1 ? '' : 's'} they own.` : 'They own none (press Refresh first if the table is empty).' };
        });
        ctx.panel.action('refresh', async () => {
            const list = targets().filter(a => a.healthy);
            let ok = 0;
            for (const a of list) { try { await look(a.id); ok++; } catch (_) {} }
            return { message: `Read ${ok} of ${list.length} account${list.length === 1 ? '' : 's'}.` };
        });
        ctx.panel.action('clearQueue', () => { let n = 0; for (const a of targets()) { n += (state.queues[a.id] || []).length; delete state.queues[a.id]; } save(); return { message: `Removed ${n} from the queue.` }; });
        for (const kind of ['buy', 'sell', 'sellAll', 'use', 'queue']) {
            ctx.panel.action(kind, async () => {
                const names = picked();
                if (!names.length) return { ok: false, error: 'Pick one or more effects first.' };
                if (job) return { ok: false, error: `Still busy: ${job.what} (${job.done} of ${job.of}).` };
                const accts = targets();
                if (!accts.length) return { ok: false, error: S('scope') === 'one' ? 'Choose the account first.' : 'No accounts.' };
                const r = await mass(kind, names, accts);
                const verb = { buy: 'Bought', sell: 'Sold', sellAll: 'Sold', use: 'Started', queue: 'Queued' }[kind];
                const ammo = r.ammo ? ` (${r.ammo > 0 ? '+' : '−'}${count(Math.abs(r.ammo))} ammo)` : '';
                const more = r.skipped.length ? ` · ${r.skipped.length} skipped: ${r.skipped.slice(0, 3).join('; ')}${r.skipped.length > 3 ? '; …' : ''}` : '';
                return { message: `${ctx.power.practice() && kind !== 'queue' ? 'Practice — would have: ' : ''}${verb} ${count(r.n)}${ammo}${more}` };
            });
        }
        ctx.panel.tab('Effects', render);
        ctx.panel.badge((aid) => { const q = state.queues[aid]; return q && q.length && S('on') ? `${q.length} effect${q.length === 1 ? '' : 's'} queued` : null; });
    },
    stop() { seen.clear(); job = null; ticking = false; },
};
