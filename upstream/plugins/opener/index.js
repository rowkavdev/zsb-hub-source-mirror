/**
 * OPENER
 *
 * On the accounts chosen in its settings, one run:
 *   1. buy the chosen item with cash (or skip: only open what's there)   POST /api/cases { id, type, amount }
 *      — whole opens when it can, with the cash left after the "keep" amounts, refused above the max price
 *   2. open them                                                         POST /api/open/<type>
 *      drops sold: auto-open set to sell to cash or tokens first (GET/PUT /api/user/autoOpen/config, preset
 *      "ZSB Hub opener"), read back before opening; drops kept: opened without auto-open, into the inventory.
 *      "Set auto-favourite from here" also writes the favourite rules (floats, patterns, blacklist) into that
 *      config, and then every open goes through auto-open, so the rules apply even when nothing is sold.
 *      Non-Pro accounts lost auto-sell (site update, 2026-11-06): their drops go to the inventory, and from
 *      /api/me inventoryCount / inventorySize it opens until the inventory would pass 90%, sells the drops
 *      (DELETE /api/inventory, up to the keep-over price, favourites stay), goes on, and sells once more at the end.
 * Items come from the site's shop data (/_next/data/<build>/en/cases/{cases,capsules,collections}.json);
 * their type (case, capsule, collectionCase) comes from which list they're in. An item can only be opened
 * once the account's rank reaches its rankNeeded. XP and rank-ups are read from /api/me before and after.
 * What the drops were worth comes from each open's answer: { totalValue, favoritedSkins } with auto-open,
 * the list of dropped skins (each with its price) without. Cash read from /api/me would also count clicks.
 * A tool, not a schedule: Preview shows what it would do; Open now buys once and opens all of it, in turns of
 * RUN_MS with a short break between them so other plugins get the account (later turns only open, never buy again).
 */

const PRESET = 'ZSB Hub opener';
const NO_CAP = 999999;   // autosellAmount is a value cap: drops worth more are kept
const OPEN_GAP_MS = 300;
const CATALOG_MS = 30 * 60 * 1000;
const MAX_OPEN_FAILS = 5;
const INV_FILL = 0.9;           // non-Pro selling: sell the drops before the inventory passes this
const INV_FULL = /inventory (is )?full|full inventory|no (more |free )?(space|slots?)|not enough (inventory )?(space|slots?)/i;   // the site's "inventory full" answers
const FULL_RETRIES = 2;         // a refusal that selling doesn't cure this many times in a row stops the run
const RUN_MS = 15 * 60000;      // a turn of opening; then the account is handed back for BREAK_MS (other plugins wait meanwhile)
const BREAK_MS = 60000;
const LISTS = [['cases', 'case', 'Case'], ['capsules', 'capsule', 'Capsule'], ['collections', 'collectionCase', 'Collection']];

let ctx = null;
let state = null;            // saved: { last: { aid: t }, today: {...}, runs: [...], items: { id: { opened, spent, value, xp } }, plans, practiceAt }
const lanes = new Map();     // aid -> { phase, opened, of }
const jobs = new Map();      // aid -> { practice, cont, at }: an Open now / Preview still to run (cont: only open, don't buy)
const catalog = { build: null, items: null, at: 0 };
let paused = null;           // why buying stopped (the price moved) — cleared by changing the item or its max price
let halt = false;            // "Stop" pressed: running lanes end after their current request
const halted = () => ctx.stopping || halt;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const money = (n) => (n < 0 ? '-' : '') + '$' + (Math.abs(n) >= 1e9 ? +(Math.abs(n) / 1e9).toFixed(2) + 'B' : Math.abs(n) >= 1e6 ? +(Math.abs(n) / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e3 ? +(Math.abs(n) / 1e3).toFixed(1) + 'k' : +Math.abs(n).toFixed(2));
const count = (n) => Math.round(n).toLocaleString('en-US');
const day = () => new Date().toISOString().slice(0, 10);
const S = (k) => ctx.settings.get(k);

class Stop extends Error {}

function save() { ctx.data.set(state); }

function today() {
    if (!state.today || state.today.day !== day()) state.today = { day: day(), spent: 0, opened: 0, value: 0, xp: 0, ranks: 0, favs: 0 };
    return state.today;
}

async function req(aid, path, opts) {
    const r = await ctx.request(aid, path, opts);
    if (r.kind === 'not-running') throw new Stop('the account stopped clicking');
    if (r.kind === 'auth') throw new Stop('logged out');
    if (r.kind === 'cf') throw new Stop('Cloudflare check');
    return r;
}
const getJson = async (aid, path) => { const r = await req(aid, path); if (r.kind !== 'ok') throw new Stop(`HTTP ${r.status} on ${path.split('?')[0]}`); return r.json; };

// The shop's page data. pageProps.cases is a JSON string of { _id, name, price, rankNeeded, isNonBuyable, ... }.
async function refreshCatalog(aid, force) {
    if (!force && catalog.items && Date.now() - catalog.at < CATALOG_MS) return;
    const home = await req(aid, '/');
    const m = /"buildId"\s*:\s*"([^"]+)"/.exec(home.body || '');
    if (!m) throw new Stop('could not read the shop (no build id)');
    catalog.build = m[1];
    const items = [];
    for (const [file, type, kind] of LISTS) {
        const r = await req(aid, `/_next/data/${catalog.build}/en/cases/${file}.json?cases=${file}`);
        const raw = r.json && r.json.pageProps && r.json.pageProps.cases;
        const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(list)) throw new Stop(`could not read the shop's ${file}`);
        for (const c of list) if (c && c._id && num(c.price) > 0) items.push({ ...c, type: c.type || type, kind });
    }
    catalog.items = items;
    catalog.at = Date.now();
    const order = { Case: 0, Capsule: 1, Collection: 2 };
    ctx.settings.setOptions('item', items.slice().sort((a, b) => order[a.kind] - order[b.kind] || num(a.rankNeeded) - num(b.rankNeeded) || num(a.price) - num(b.price))
        .map(c => ({ value: c._id, label: `${c.kind}: ${c.name} — $${num(c.price).toLocaleString('en-US')}${num(c.rankNeeded) > 1 ? ` · rank ${c.rankNeeded}` : ''}${c.isNonBuyable ? ' · not sold, open only' : ''}` })));
}

const wantVariant = () => (S('drops') === 'tokens' ? 'tokens' : 'money');
const capOf = () => (num(S('keepOver')) > 0 ? num(S('keepOver')) : NO_CAP);
const unwrap = (r) => { const c = r && (r.config || r); if (!c || typeof c !== 'object') return null; const { activePresetId, ...rest } = c; return rest; };

// Auto-favourite, as the site's own settings page has it (read from its bundle, 2026-11-11): low floats under
// customLowFloat (0 to 0.1), high floats over customHighFloat (0.9 to 1), up to 10 custom floats (digits and one
// dot, up to 20 characters), and patterns, less a blacklist of names from /api/patternNames. Favourited drops
// are never sold, by auto-sell or by the inventory sell.
const FAV_KEYS = ['favoriteLowFloats', 'customLowFloat', 'favoriteHighFloats', 'customHighFloat', 'favoriteCustomFloats', 'customSelectedFloats', 'favoritePatterns', 'patternBlacklist'];
const SELL_KEYS = ['autosellActivated', 'autosellVariant', 'autosellAmount'];
const MAX_CUSTOM = 10;
const floatOk = (s) => s.length <= 20 && /^\d*\.?\d*$/.test(s) && /\d/.test(s);
let patternNames = null;     // the site's pattern names, read once

const customFloats = () => (S('customFloats') || []).filter(floatOk).slice(0, MAX_CUSTOM);
function favRules(patterns) {
    return {
        favoriteLowFloats: !!S('favLow'), customLowFloat: num(S('lowFloat')),
        favoriteHighFloats: !!S('favHigh'), customHighFloat: num(S('highFloat')),
        favoriteCustomFloats: !!S('favCustom'), customSelectedFloats: customFloats(),
        favoritePatterns: !!S('favPatterns'), patternBlacklist: patterns,
    };
}
// The blacklist with the site's own spelling of each name; names it doesn't know are left out, with a warning.
async function blacklist(aid, log) {
    const typed = S('patternBlacklist') || [];
    if (!typed.length) return [];
    if (!patternNames) { const r = await req(aid, '/api/patternNames'); if (r.kind === 'ok' && Array.isArray(r.json)) patternNames = r.json.map(String); }
    if (!patternNames) return typed;
    const out = [];
    for (const t of typed) {
        const hit = patternNames.find(n => n.toLowerCase() === t.toLowerCase());
        if (hit) out.push(hit); else log(`"${t}" isn't a pattern name the site knows — left off the blacklist`, 'warn');
    }
    return out;
}
const same = (a, b) => (typeof b === 'number' ? num(a) === b : JSON.stringify(a ?? null) === JSON.stringify(b ?? null));
const matches = (c, want, keys) => !!c && keys.every(k => same(c[k], want[k]));

const plain = (n) => (n !== 0 && Math.abs(n) < 1e-6 ? n.toFixed(12).replace(/\.?0+$/, '') : String(n));
function favText(rules) {
    if (!S('favSet')) return "each account's own (set on the site)";
    const r = rules || favRules(S('patternBlacklist') || []), bits = [];
    if (r.favoriteLowFloats) bits.push(`floats under ${plain(r.customLowFloat)}`);
    if (r.favoriteHighFloats) bits.push(`floats over ${plain(r.customHighFloat)}`);
    if (r.favoriteCustomFloats && r.customSelectedFloats.length) bits.push(`${r.customSelectedFloats.length} custom float${r.customSelectedFloats.length === 1 ? '' : 's'}`);
    if (r.favoritePatterns) bits.push('patterns' + (r.patternBlacklist.length ? ` (${r.patternBlacklist.length} never)` : ''));
    return bits.length ? bits.join(', ') : 'nothing';
}

// Set the account's auto-open config for this run: auto-sell on (to cash or tokens, up to the keep-over value)
// or off, and the auto-favourite rules from the settings when "Set auto-favourite from here" is on; the
// account's own other choices are kept. Written to the "ZSB Hub opener" preset and checked by reading it back.
async function ensureConfig(aid, log, sell) {
    const cur = unwrap(await getJson(aid, '/api/user/autoOpen/config'));
    const want = { ...(cur || {}) }, keys = ['autosellActivated'];
    want.autosellActivated = sell;
    if (sell) { want.autosellVariant = wantVariant(); want.autosellAmount = capOf(); keys.push(...SELL_KEYS.slice(1)); }
    if (S('favSet')) { Object.assign(want, favRules(await blacklist(aid, log))); keys.push(...FAV_KEYS); }
    if (matches(cur, want, keys)) return;
    const res = await getJson(aid, '/api/user/autoOpen/presets');
    const list = Array.isArray(res) ? res : (res && Array.isArray(res.presets) ? res.presets : []);
    let preset = list.find(p => p && p.name === PRESET);
    if (!preset) {
        const cr = await req(aid, '/api/user/autoOpen/presets', { method: 'POST', body: { name: PRESET, config: want } });
        if (cr.kind !== 'ok' || !cr.json || !cr.json._id) throw new Stop(`couldn't make the auto-open preset (HTTP ${cr.status}${cr.json && cr.json.error ? ': ' + cr.json.error : ''})`);
        preset = cr.json;
    }
    const pr = await req(aid, '/api/user/autoOpen/config', { method: 'PUT', body: { config: want, activePresetId: preset._id } });
    if (pr.kind !== 'ok') throw new Stop(`couldn't set auto-open (HTTP ${pr.status}${pr.json && pr.json.error ? ': ' + pr.json.error : ''})`);
    if (!matches(unwrap(await getJson(aid, '/api/user/autoOpen/config')), want, keys)) throw new Stop('the site did not confirm the auto-open settings — not opening');
    log(`auto-open set: ${sell ? `sell drops for ${wantVariant() === 'tokens' ? 'tokens' : 'cash'}${capOf() < NO_CAP ? ` when worth under ${capOf()}` : ''}` : 'no auto-sell'}${S('favSet') ? `; favourite ${favText(want)}` : ''}`);
}

// A sell finishes on the site a moment after it answers (seen live 2026-11-06): read /api/me until the inventory
// count stops falling, up to 15 s.
async function settled(aid, was) {
    let m = await getJson(aid, '/api/me'), last = num(m.inventoryCount), same = 0;
    for (let i = 0; i < 15 && same < 2; i++) {
        await ctx.sleep(1000);
        m = await getJson(aid, '/api/me');
        const n = num(m.inventoryCount);
        same = n === last && (n < was || i >= 2) ? same + 1 : 0;   // nothing left to sell: stop after a few reads
        last = n;
    }
    return m;
}

async function stockOf(aid, id) {
    const cs = await getJson(aid, '/api/cases');
    const it = Array.isArray(cs) ? cs.find(c => c && c._id === id) : null;
    return it ? num(it.amount) : 0;
}

async function run(aid, name, practice, cont) {
    const lane = { phase: 'start', opened: 0, of: 0 };
    lanes.set(aid, lane);
    const plan = [];
    const log = (msg, level = 'info') => { if (practice && /^would /.test(msg)) plan.push(msg.replace(/^would /, '')); ctx.log((practice ? 'practice — ' : '') + msg, level, aid); };
    const rec = { t: Date.now(), acct: name, item: '', spent: 0, opened: 0, value: 0, favs: 0, xp: 0, rank: '', result: '' };
    let start = null, item = null;
    try {
        start = await getJson(aid, '/api/me');
        await refreshCatalog(aid);
        item = catalog.items.find(c => c._id === S('item'));
        if (!item) throw new Stop(S('item') ? 'the chosen item is no longer in the shop' : 'nothing chosen to open yet');
        rec.item = item.name;
        const rankId = num(start.rank && start.rank.id);
        if (num(item.rankNeeded) > rankId) throw new Stop(`${item.name} needs rank ${item.rankNeeded} (the account is ${(start.rank && start.rank.name) || 'rank ' + rankId})`);
        const perCall = Math.max(1, parseInt(start.caseOpenCount) || 1), mult = Math.max(1, parseInt(start.maxCaseOpenMultiplier) || 1), perOpen = perCall * mult;
        let stock = await stockOf(aid, item._id);

        // 1. cash -> items (whole opens when there's enough for one)
        // A backlog from runs that ran out of time is opened first; more is bought once it's down.
        if (cont) lane.phase = 'opening';   // a later turn of the same job: it bought already
        else if (S('source') === 'buy' && stock >= perOpen * 200) log(`${count(stock)} already in stock — opening those before buying more`);
        else if (S('source') === 'buy') {
            lane.phase = 'buying';
            const price = num(item.price), cash = num(start.money);
            let budget = cash - Math.max(num(S('keepMoney')), cash * num(S('keepPct')) / 100);
            if (num(S('spendPerRun')) > 0) budget = Math.min(budget, num(S('spendPerRun')));
            let buy = Math.floor(Math.max(0, budget) / price);
            if (stock + buy >= perOpen) buy = Math.floor((stock + buy) / perOpen) * perOpen - stock;
            if (item.isNonBuyable) log(`${item.name} can't be bought in the shop — opening only what's there`, 'warn');
            else if (paused) log(`not buying: ${paused}`, 'warn');
            else if (num(S('maxPrice')) > 0 && price > num(S('maxPrice'))) log(`not buying: ${item.name} costs $${price}, over your limit of $${num(S('maxPrice'))}`, 'warn');
            else if (buy > 0) {
                if (practice) { log(`would buy ${count(buy)} ${item.name} for ${money(buy * price)}`); stock += buy; }
                else {
                    const pre = num((await getJson(aid, '/api/me')).money);
                    const br = await req(aid, '/api/cases', { method: 'POST', body: { id: item._id, type: item.type, amount: buy } });
                    const spent = Math.max(0, pre - num((await getJson(aid, '/api/me')).money));
                    stock = await stockOf(aid, item._id);
                    rec.spent = spent;
                    if (br.kind !== 'ok' && !spent) { catalog.at = 0; throw new Stop(`buying failed (${(br.json && br.json.error) || 'HTTP ' + br.status}), nothing was charged`); }
                    // Charged more than the shop said: the price moved. Stop buying everywhere until it's looked at.
                    if (spent / buy > price * 1.02) { paused = `charged $${(spent / buy).toFixed(2)} each instead of $${price} — check the price, then change the item or its max price`; log('buying stopped: ' + paused, 'error'); }
                    log(`bought ${count(buy)} ${item.name} for ${money(spent)}`, 'ok');
                }
            } else if (!stock) log(`not enough cash for one ${item.name} ($${price})`);
        }

        // 2. open them
        if (stock > 0) {
            lane.phase = 'opening';
            if (!practice && ctx.accounts.setBusy) ctx.accounts.setBusy(aid, S('exclusive') ? 'opening cases (others paused until done)' : 'opening cases');   // other plugins wait
            lane.of = stock;
            const keep = S('drops') === 'keep';
            // Selling without auto-sell (non-Pro): open into the inventory and sell the drops before it passes 90%.
            const bySell = !keep && start.membership !== 'pro';
            const inv = { size: num(start.inventorySize), used: num(start.inventoryCount) };
            const room = () => Math.floor(inv.size * INV_FILL) - inv.used;
            if (keep && num(start.inventorySize) && num(start.inventoryCount) + stock > num(start.inventorySize)) {
                stock = Math.max(0, num(start.inventorySize) - num(start.inventoryCount));
                log(`the inventory has room for ${count(stock)} more drops — opening only that many`, 'warn');
            }
            const what = (keep ? 'drops kept' : `drops sold for ${wantVariant() === 'tokens' ? 'tokens' : 'cash'}${capOf() < NO_CAP ? ` when worth under ${capOf()}` : ''}`) + (S('favSet') ? `, favouriting ${favText()}` : '');
            if (practice) log(`would open ${count(stock)} ${item.name} (${perCall}×${mult} at a time), ${what}${bySell ? ` — no auto-sell without Pro: into the inventory (${count(inv.used)} of ${count(inv.size)} used), sold at 90% full` : ''}`);
            else if (stock > 0) {
                if (bySell && !inv.size) throw new Stop('the site did not say how big the inventory is — not opening');
                // Auto-open: selling (Pro), or only favouriting when the rules are set from here.
                const auto = (!keep && !bySell) || !!S('favSet');
                if (auto) await ensureConfig(aid, log, !keep && !bySell);
                const sellDrops = async () => {
                    lane.phase = 'selling drops';
                    const r = await req(aid, '/api/inventory', { method: 'DELETE', body: { type: 'price', value: Math.min(capOf(), 499999), currency: wantVariant() } });
                    if (r.kind !== 'ok') log(`selling the drops failed (${(r.json && r.json.error) || 'HTTP ' + r.status})`, 'warn');
                    const m = await settled(aid, inv.used);
                    inv.used = num(m.inventoryCount); inv.size = num(m.inventorySize) || inv.size;
                    rec.sells = (rec.sells || 0) + 1;
                    lane.phase = 'opening';
                };
                let fails = 0, full = 0;
                const ends = S('exclusive') ? Infinity : Date.now() + (num(S('turnMs')) || RUN_MS);
                while (stock > 0) {
                    if (halted()) throw new Stop(ctx.stopping ? 'turned off' : 'stopped by you');
                    if (Date.now() > ends) { rec.left = stock; log(`${count(stock)} still to open — a 1-minute break for other plugins, then it goes on`); break; }
                    // Fewer than a full open left: open what there is.
                    const c = Math.min(perCall, stock), m = Math.max(1, Math.min(mult, Math.floor(stock / c)));
                    if (bySell && room() < c * m) {
                        await sellDrops();
                        if (room() < c * m) throw new Stop(`the inventory is still ${Math.round(inv.used / inv.size * 100)}% full after selling the drops — make room, then run again`);
                    }
                    const body = { id: item._id, quickOpen: true, count: String(c), useEventTickets: false, caseOpenMultiplier: m, autoOpen: auto };
                    const r = await ctx.request(aid, '/api/open/' + item.type, { method: 'POST', body });
                    if (r.kind === 'ok') {
                        stock -= c * m; lane.opened += c * m; rec.opened += c * m; fails = 0; full = 0;
                        if (bySell) inv.used += c * m;
                        const j = r.json;
                        if (Array.isArray(j)) rec.value += j.reduce((t, x) => t + num(x && x.price), 0);
                        else if (j) {
                            rec.value += num(j.totalValue);
                            for (const f of Array.isArray(j.favoritedSkins) ? j.favoritedSkins : []) { rec.favs++; log(`kept a favourited drop: ${f.name || 'a skin'}${f.price ? ` ($${num(f.price).toLocaleString('en-US')})` : ''}`, 'ok'); }
                        }
                        if (lane.opened % (perOpen * 25) < c * m) {
                            stock = await stockOf(aid, item._id); save();
                            if (bySell) inv.used = num((await getJson(aid, '/api/me')).inventoryCount);   // drops can count more than the math says
                        }
                    } else {
                        if (r.kind === 'not-running' || r.kind === 'auth' || r.kind === 'cf') throw new Stop(r.kind === 'not-running' ? 'the account stopped clicking' : r.kind);
                        const msg = String((r.json && r.json.error) || '');
                        if (bySell && INV_FULL.test(msg)) {   // full after all: sell now, but not forever
                            if (++full > FULL_RETRIES) throw new Stop(`the site keeps refusing opens after selling the drops: ${msg}`);
                            inv.used = inv.size; continue;
                        }
                        if (++fails >= MAX_OPEN_FAILS) throw new Stop(`opening failed ${fails}× in a row (${(r.json && r.json.error) || 'HTTP ' + r.status})`);
                        await ctx.sleep(r.kind === 'rate' ? 30000 : 2000 * fails);
                        stock = await stockOf(aid, item._id);
                    }
                    await ctx.sleep(OPEN_GAP_MS);
                }
                if (bySell && rec.opened) await sellDrops();
                log(`opened ${count(rec.opened)} ${item.name}${rec.sells ? ` (no auto-sell: sold the drops ${rec.sells}×)` : ''} — drops worth ${money(rec.value)} (${rec.spent ? Math.round(100 * rec.value / rec.spent) + '% of the cost' : 'from stock'})`, 'ok');
            }
        }
        rec.result = practice ? (plan.length ? 'practice' : 'practice — nothing to do') : rec.opened ? 'done' : 'nothing to open';
        if (practice) { state.practiceAt = Date.now(); state.plans = { ...(state.plans || {}), [aid]: { t: Date.now(), name, lines: plan.length ? plan : ['nothing to do right now'] } }; }
    } catch (e) {
        rec.result = e instanceof Stop ? e.message : 'error: ' + e.message;
        if (!(e instanceof Stop)) ctx.log('stopped: ' + e.message, 'error', aid);
        else if (!ctx.stopping) log('stopped: ' + e.message, 'warn');
        if (halt && lanes.size <= 1) halt = false;
    } finally {
        // XP and rank-ups, read from the account before and after.
        if (!practice && start && rec.opened) {
            try {
                const end = await ctx.request(aid, '/api/me');
                if (end.kind === 'ok') {
                    const e = end.json;
                    rec.xp = Math.max(0, num(e.xp) - num(start.xp));
                    const r0 = num(start.rank && start.rank.id), r1 = num(e.rank && e.rank.id);
                    if (r1 > r0) { rec.rank = e.rank.name; today().ranks += r1 - r0; ctx.log(`ranked up to ${e.rank.name}`, 'ok', aid); }
                    if (item) {
                        const it = (state.items[item._id] = state.items[item._id] || { name: item.name, opened: 0, spent: 0, value: 0, xp: 0 });
                        for (const k of ['opened', 'spent', 'value', 'xp']) it[k] = (it[k] || 0) + rec[k];
                    }
                }
            } catch (_) {}
        }
        const t = today();
        for (const k of ['spent', 'opened', 'value', 'xp', 'favs']) t[k] = (t[k] || 0) + rec[k];
        state.last[aid] = Date.now();
        state.runs = [rec, ...(state.runs || [])].slice(0, 30);
        // The job goes on after a break while there's more to open; otherwise it's done.
        if (!practice && rec.left > 0 && !halted()) jobs.set(aid, { practice: false, cont: true, at: Date.now() + (num(S('turnMs')) ? 500 : BREAK_MS) });
        else jobs.delete(aid);
        lanes.delete(aid);
        if (ctx.accounts.setBusy) ctx.accounts.setBusy(aid, null);
        save();
    }
}

// Runs the jobs started from the page (Open now / Preview), a few accounts at a time.
function tick() {
    const max = Math.max(1, Math.min(5, num(S('lanes')) || 1));
    for (const [aid, j] of jobs) {
        if (lanes.size >= max) break;
        const a = ctx.accounts.get(aid);
        if (!a || !ctx.settings.runsOn('accounts', aid)) { jobs.delete(aid); continue; }
        if (!a.healthy || lanes.has(aid) || Date.now() < j.at) continue;
        if (ctx.accounts.busy && ctx.accounts.busy(aid)) continue;   // another plugin's turn: try again in a moment
        j.at = Infinity;   // running
        run(aid, a.name, j.practice, j.cont);
    }
}

module.exports = {
    start(c) {
        ctx = c;
        state = { last: {}, runs: [], items: {}, ...ctx.data.get() };
        today();
        ctx.settings.onChange((k) => { if (k === 'item' || k === 'maxPrice') paused = null; });
        // Fill the item list as soon as any account is clicking, so it can be chosen before the first run.
        const fill = async () => { if (catalog.items) return; const a = ctx.accounts.list().find(x => x.healthy); if (a) { try { await refreshCatalog(a.id); } catch (_) {} } };
        fill();
        ctx.every(15000, fill);
        ctx.every(2000, tick);
        const start = (practice) => {
            const chosen = ctx.accounts.list().filter(a => ctx.settings.runsOn('accounts', a.id));
            if (!chosen.length) return { ok: false, error: 'Choose accounts first.' };
            if (!S('item')) return { ok: false, error: 'Pick something to open first.' };
            halt = false;
            for (const a of chosen) if (!lanes.has(a.id)) {
                jobs.set(a.id, { practice, cont: false, at: 0 });
                // Others paused until done: the accounts waiting their turn are held from now, not only while opening.
                if (!practice && S('exclusive') && ctx.accounts.setBusy) ctx.accounts.setBusy(a.id, 'waiting to open cases (others paused until done)');
            }
            tick();
            return { message: practice ? 'Previewing — what it would do shows up here in a moment.' : `Opening on ${chosen.length} account${chosen.length === 1 ? '' : 's'}.` };
        };
        ctx.panel.action('preview', () => start(true));
        ctx.panel.action('open', () => start(false));
        ctx.panel.action('stop', () => {
            if (!lanes.size && ![...jobs.values()].some(j => !j.practice)) return { message: 'Nothing is opening.' };
            for (const aid of jobs.keys()) if (!lanes.has(aid) && ctx.accounts.setBusy) ctx.accounts.setBusy(aid, null);
            jobs.clear(); halt = lanes.size > 0;
            return { message: lanes.size ? 'Stopping after the current open.' : 'Stopped.' };
        });

        ctx.panel.tab('Opener', () => {
            const t = today();
            const waiting = [...jobs.values()].filter(j => !j.practice && j.at !== Infinity).length;
            const chosen = ctx.accounts.list().filter(a => ctx.settings.runsOn('accounts', a.id));
            const n = chosen.length;
            const item = catalog.items && catalog.items.find(x => x._id === S('item'));
            const buying = S('source') === 'buy', keep = S('drops') === 'keep';
            const plans = Object.values(state.plans || {}).filter(x => chosen.some(a => a.name === x.name) && x.t > (state.practiceAt || 0) - 60000).sort((a, b) => b.t - a.t);
            const dropsTxt = keep ? 'kept' : `sold for ${S('drops') === 'tokens' ? 'tokens' : 'cash'}${num(S('keepOver')) > 0 ? ` when worth under ${num(S('keepOver'))}` : ''}`;
            const measured = item && state.items[item._id];
            const accts = chosen.map(a => {
                const me = ctx.accounts.stats(a.id) || {}, rk = me.rank || {};
                return [a.name, rk.name || '—', me.xp == null ? '—' : count(me.xp) + (rk.xpNeededForRankup ? ` / ${count(rk.xpNeededForRankup)}` : ''), money(num(me.money))];
            });
            return { blocks: [
                { type: 'card', id: 'tool', open: true, title: lanes.size ? `Opener — opening on ${lanes.size}` : waiting ? `Opener — ${waiting} waiting their turn` : 'Opener',
                    summary: !n ? 'choose accounts first' : !item ? 'pick something to open' : `${item.name} on ${n} account${n === 1 ? '' : 's'} · drops ${dropsTxt}${S('exclusive') ? ' · other plugins paused until done' : ''}`,
                    keys: ['exclusive'],
                    blocks: n && item ? [{ type: 'buttons', items: [{ label: 'Preview', action: 'preview' },
                        { label: 'Open now', action: 'open', primary: true, confirm: `${S('source') === 'buy' ? `Buy ${item.name} with the cash above your keep amounts and open` : `Open the ${item.name} in stock`} on ${n} account${n === 1 ? '' : 's'}? Drops are ${dropsTxt}.` },
                        ...(lanes.size || waiting ? [{ label: 'Stop', action: 'stop', danger: true }] : [])] }] : [] },
                ...(paused ? [{ type: 'notice', level: 'bad', text: 'Buying is stopped: ' + paused }] : []),
                ...(plans.length ? [{ type: 'table', wrap: true, columns: ['Account', 'Open now would', 'When'], rows: plans.slice(0, 10).map(x => [x.name, x.lines.join(' · '), new Date(x.t).toLocaleTimeString()]) }] : []),
                ...(t.opened ? [{ type: 'stats', items: [
                    { label: 'Opened today', value: count(t.opened) },
                    { label: 'Spent today', value: money(t.spent) },
                    { label: 'Drops worth', value: money(t.value || 0) + (t.spent ? ` · ${Math.round(100 * (t.value || 0) / t.spent)}%` : '') },
                    { label: 'XP today', value: count(t.xp) + (t.ranks ? ` · ${t.ranks} rank-up${t.ranks === 1 ? '' : 's'}` : '') },
                ] }] : []),
                ...(lanes.size ? [{ type: 'table', columns: ['Opening now', 'Step', 'Opened'], rows: [...lanes].map(([id, l]) => [(ctx.accounts.get(id) || {}).name || id, l.phase, l.of ? `${count(l.opened)} / ${count(l.of)}` : count(l.opened)]) }] : []),
                { type: 'card', id: 'accounts', open: !n, title: 'Accounts', summary: n ? `${n} account${n === 1 ? '' : 's'}` : 'none yet', keys: ['accounts'], bare: true,
                    blocks: n ? [{ type: 'table', columns: ['Account', 'Rank', 'XP / next', 'Cash'], rows: accts }] : [] },
                { type: 'card', id: 'item', open: !item, title: 'What to open', summary: item ? `${item.name} · $${num(item.price)} · ${buying ? 'bought' : 'from stock'}` : 'nothing chosen',
                    keys: buying ? ['item', 'source', 'maxPrice', 'keepMoney', 'keepPct', 'spendPerRun', 'lanes'] : ['item', 'source', 'lanes'],
                    blocks: measured && measured.opened ? [{ type: 'stats', items: [
                        { label: 'Opened so far', value: count(measured.opened) },
                        { label: 'Drops worth', value: measured.spent ? Math.round(100 * (measured.value || 0) / measured.spent) + '% of the cost' : money(measured.value || 0) },
                        { label: 'XP per open', value: +(measured.xp / measured.opened).toFixed(2) + '' },
                    ] }] : [] },
                { type: 'card', id: 'drops', open: false, title: 'Drops', summary: dropsTxt, keys: keep ? ['drops'] : ['drops', 'keepOver'] },
                { type: 'card', id: 'favs', open: false, title: 'Auto-favourite', summary: favText(),
                    keys: !S('favSet') ? ['favSet'] : ['favSet', 'favLow', ...(S('favLow') ? ['lowFloat'] : []), 'favHigh', ...(S('favHigh') ? ['highFloat'] : []),
                        'favCustom', ...(S('favCustom') ? ['customFloats'] : []), 'favPatterns', ...(S('favPatterns') ? ['patternBlacklist'] : [])],
                    blocks: S('favSet') && (S('customFloats') || []).length > customFloats().length
                        ? [{ type: 'notice', level: 'warn', text: `Left out: ${(S('customFloats') || []).filter(f => !customFloats().includes(f)).join(', ')} — custom floats are digits and one dot, up to 20 characters, at most ${MAX_CUSTOM}.` }] : [] },
                { type: 'section', title: 'Recent runs', blocks: [{ type: 'table', empty: 'No runs yet.', columns: ['When', 'Account', 'Item', 'Spent', 'Opened', 'Drops worth', 'Result'],
                    rows: (state.runs || []).slice(0, 10).map(r => [new Date(r.t).toLocaleTimeString(), r.acct, r.item || '—', money(r.spent), count(r.opened), money(r.value || 0), r.result]) }] },
            ] };
        });
        ctx.panel.badge((aid) => { const l = lanes.get(aid); return l ? 'Opening: ' + l.phase : null; });
    },
    stop() { lanes.clear(); },
};

