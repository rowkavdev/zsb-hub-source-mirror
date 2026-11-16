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
// Drops' value as a share of what the opened cases cost (each case at its shop price, bought now or earlier).
const pct = (value, cost) => Math.round(100 * value / cost) + '%';
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
const lanes = new Map();     // aid -> { phase, opened, of, halt }
// What the page shows per account for the current (or last) job, across its turns: cases opened and left, the time
// spent opening (for the speed and the ETA), drops' value, and how it ended. Not saved: a restart starts it over.
const prog = new Map();      // aid -> { item, opened, left, openMs, value, t0, result, at }
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

// ---- Discord webhook for favourited drops ----
// The URL is a secret (anyone with it can post to the channel): pasted into a box that's emptied once saved, kept
// sealed with the system keychain (ctx.secrets), never logged or shown — the panel shows only "…/1234" of it.
// Drops queue up and go out every HOOK_GAP_MS. Drops of the same item from one multi-open are one embed ("×4", a
// line per float), with the item's picture; up to 10 embeds a message and under Discord's 6,000-character limit.
// A 429 waits its retry_after, and a hook Discord says is gone (401/404) stops sending until a new one is saved.
const HOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,25}\/[\w-]{20,200}$/;
const HOOK_GAP_MS = 2000;
let hookUrl = null;          // unsealed, in memory only
let hookQ = [];
let hookWait = 0, hookBusy = false, hookDead = '';
const hookTail = () => hookUrl ? '…/' + hookUrl.slice(-4) : '';
function hookPush(d) {
    if (!hookUrl || hookDead) return;
    if (num(S('hookMin')) > 0 && num(d.price) < num(S('hookMin'))) return;
    if (hookQ.length < 200) hookQ.push(d);
}
// A favourited skin from the open answer (the site's Skin) -> what the post needs.
let hookOpenSeq = 0;   // one id per open call: only drops from the same multi-open are grouped
const hookDrop = (s, acct, from, open) => ({
    name: String(s.name || 'a skin').slice(0, 200), price: num(s.price), float: s.float, icon: s.iconUrl || '',
    rarity: s.rarity || '', color: s.rarityColor || '', exterior: s.exterior || '', statTrak: !!s.statTrak, souvenir: !!s.souvenir,
    // patternId is often the site's database id (24 hex), not a name; the name already says the pattern ('Blue Gem').
    pattern: s.hasPattern && s.patternId && !/^[0-9a-f]{24}$/i.test(String(s.patternId)) ? String(s.patternId).slice(0, 60) : '',
    from: String((s.origin && s.origin.name) || from || '').slice(0, 100), acct, open, t: Date.now(),
});
// The site's picture rule (its icon resolver): "-…" is a Steam economy image, "/…" and https are as they are,
// anything else is under /pictures/skins/. Discord fetches it, so it must be a full https URL.
function iconUrl(icon) {
    const s = String(icon || '');
    if (!s) return null;
    if (s.startsWith('-')) return 'https://steamcommunity-a.akamaihd.net/economy/image/' + s;
    if (/^https:\/\//.test(s)) return s;
    if (s.startsWith('/')) return 'https://case-clicker.com' + s;
    return 'https://case-clicker.com/pictures/skins/' + s;
}
const usd = (v) => '$' + num(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MAX_FLOAT_LINES = 15;
function hookEmbed(g) {
    const d = g[0], lines = g.slice(0, MAX_FLOAT_LINES).map(x => `${x.float == null ? '—' : String(x.float)}  —  ${usd(x.price)}`);
    if (g.length > MAX_FLOAT_LINES) lines.push(`…and ${g.length - MAX_FLOAT_LINES} more (${usd(g.slice(MAX_FLOAT_LINES).reduce((s, x) => s + x.price, 0))})`);
    const color = parseInt(String(d.color).replace(/^#/, ''), 16);
    const img = iconUrl(d.icon);
    return {
        title: (d.name + (g.length > 1 ? `  ×${g.length}` : '')).slice(0, 256),
        color: Number.isFinite(color) && color >= 0 && color <= 0xffffff ? color : 0xd4a017,
        fields: [
            { name: g.length > 1 ? `Floats (${g.length})` : 'Float', value: lines.join('\n').slice(0, 1024) },
            ...(d.rarity ? [{ name: 'Rarity', value: d.rarity, inline: true }] : []),
            ...(d.exterior ? [{ name: 'Exterior', value: d.exterior, inline: true }] : []),
            { name: d.souvenir ? 'Souvenir' : 'StatTrak', value: d.souvenir || d.statTrak ? 'Yes' : 'No', inline: true },
            ...(d.pattern ? [{ name: 'Pattern', value: d.pattern, inline: true }] : []),
            ...(d.from ? [{ name: 'From', value: d.from, inline: true }] : []),
            ...(g.length > 1 ? [{ name: 'Total', value: usd(g.reduce((s, x) => s + x.price, 0)), inline: true }] : []),
        ],
        ...(img ? { thumbnail: { url: img } } : {}),   // small, top right (image would be full width below)
        footer: { text: `ZSB Hub Opener · ${d.acct}`.slice(0, 200) },
        timestamp: new Date(g[g.length - 1].t).toISOString(),
    };
}
// The next message: the queue grouped by open + item (drops of one multi-open), in order, up to 10 embeds and ~5,500 characters.
function hookBatch() {
    const groups = new Map();
    for (const d of hookQ) {
        const k = d.open + '\u0000' + d.acct + '\u0000' + d.name;
        if (!groups.has(k)) { if (groups.size >= 10) continue; groups.set(k, []); }
        groups.get(k).push(d);
    }
    const embeds = [], used = new Set();
    let size = 0;
    for (const g of groups.values()) {
        const e = hookEmbed(g), n = JSON.stringify(e).length;
        if (embeds.length && size + n > 5500) break;
        embeds.push(e); size += n; for (const d of g) used.add(d);
    }
    return { embeds, used };
}
async function hookPost(body) {
    const r = await globalThis.fetch(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    if (r.status === 429) { let j = {}; try { j = await r.json(); } catch (_) {} return { wait: Math.max(1000, num(j.retry_after) * 1000 || 5000) }; }
    if (r.status === 401 || r.status === 404) return { dead: `Discord says the webhook is gone (HTTP ${r.status}) — save a new one` };
    if (!r.ok) return { error: 'HTTP ' + r.status };
    return { ok: true };
}
async function hookFlush() {
    if (hookBusy || !hookQ.length || !hookUrl || hookDead || Date.now() < hookWait) return;
    hookBusy = true;
    const { embeds, used } = hookBatch();
    try {
        const r = await hookPost({ username: 'ZSB Hub', allowed_mentions: { parse: [] }, embeds });
        if (r.ok) { hookQ = hookQ.filter(d => !used.has(d)); state.hookSent = (state.hookSent || 0) + used.size; save(); }
        else if (r.wait) hookWait = Date.now() + r.wait;
        else if (r.dead) { hookDead = r.dead; hookQ = []; ctx.log('Discord webhook: ' + r.dead, 'warn'); }
        else { hookWait = Date.now() + 15000; ctx.log('Discord webhook: not sent (' + r.error + '), trying again shortly', 'warn'); }
    } catch (e) { hookWait = Date.now() + 15000; ctx.log('Discord webhook: not sent (' + (e.name === 'TimeoutError' ? 'timed out' : 'no connection') + '), trying again shortly', 'warn'); }
    finally { hookBusy = false; }
}

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
    const opts = items.slice().sort((a, b) => order[a.kind] - order[b.kind] || num(a.rankNeeded) - num(b.rankNeeded) || num(a.price) - num(b.price))
        .map(c => ({ value: c._id, label: `${c.kind}: ${c.name} — $${num(c.price).toLocaleString('en-US')}${num(c.rankNeeded) > 1 ? ` · rank ${c.rankNeeded}` : ''}${c.isNonBuyable ? ' · not sold, open only' : ''}` }));
    ctx.settings.setOptions('item', opts);
    ctx.settings.setOptions('sets.item', opts);
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

// Sets: other accounts open something else. A set has its own item, buy rules and accounts; an account on a set (the
// first set that has it) opens that set's item, everyone else the main What to open. A set with no item yet doesn't count.
const SET_KEYS = ['item', 'source', 'buyAmount', 'maxPrice', 'keepMoney', 'keepPct', 'spendPerRun'];
const setsOf = () => (Array.isArray(S('sets')) ? S('sets') : []);
const onSet = (s, aid) => !!(s && s.item && s.accounts && (s.accounts.all || (s.accounts.ids || []).includes(aid)));
const setOf = (aid) => setsOf().find(s => onSet(s, aid)) || null;
const setName = (s) => String((s && s.name) || '').trim() || `Set ${setsOf().indexOf(s) + 1}`;
// The settings an account opens with: its set's, or the main ones.
const cfgOf = (aid) => { const s = setOf(aid); return (k) => (s && SET_KEYS.includes(k) ? s[k] : S(k)); };
const opensHere = (aid) => ctx.settings.runsOn('accounts', aid) || !!setOf(aid);
// Buys a set amount: 'amount' right away, 'stockAmount' once what's in stock is opened.
const amountish = (C = S) => C('source') === 'amount' || C('source') === 'stockAmount';
const buys = (C = S) => amountish(C) || C('source') === 'buy';
// How many an account with this much cash buys: a set amount ('amount', fewer if the cash doesn't cover it), or
// what the spare cash covers ('buy'; the caller rounds that to whole opens). Keep cash applies to both; Keep % and
// Most per Open now only to spare cash.
function buyCount(cash, price, C = S) {
    if (!(price > 0)) return 0;
    const spare = C('source') === 'buy';
    let budget = cash - Math.max(num(C('keepMoney')), spare ? cash * num(C('keepPct')) / 100 : 0);
    if (spare && num(C('spendPerRun')) > 0) budget = Math.min(budget, num(C('spendPerRun')));
    const afford = Math.floor(Math.max(0, budget) / price);
    return spare ? afford : Math.min(Math.max(0, Math.floor(num(C('buyAmount')))), afford);
}

async function run(aid, name, practice, cont) {
    const lane = { phase: 'starting', opened: 0, of: 0, halt: false };
    lanes.set(aid, lane);
    if (!practice && (!cont || !prog.has(aid))) prog.set(aid, { item: '', opened: 0, left: null, openMs: 0, value: 0, t0: Date.now(), result: '', at: 0 });
    const p = practice ? {} : prog.get(aid);
    if (!practice) { p.result = ''; p.at = 0; }
    const plan = [];
    const log = (msg, level = 'info') => { if (practice && /^would /.test(msg)) plan.push(msg.replace(/^would /, '')); ctx.log((practice ? 'practice — ' : '') + msg, level, aid); };
    // cost: what the opened cases cost at the shop price (stock included); pv: the drops' value from those (items the shop
    // doesn't sell have no price, so they're left out of the % — their value still counts in "drops worth").
    const rec = { t: Date.now(), acct: name, item: '', spent: 0, opened: 0, value: 0, cost: 0, pv: 0, favs: 0, xp: 0, rank: '', result: '' };
    let start = null, item = null;
    const C = cfgOf(aid);   // its set's item and buy rules, or the main ones
    try {
        start = await getJson(aid, '/api/me');
        await refreshCatalog(aid);
        item = catalog.items.find(c => c._id === C('item'));
        if (!item) throw new Stop(C('item') ? 'the chosen item is no longer in the shop' : 'nothing chosen to open yet');
        rec.item = item.name; p.item = item.name;
        const rankId = num(start.rank && start.rank.id);
        if (num(item.rankNeeded) > rankId) throw new Stop(`${item.name} needs rank ${item.rankNeeded} (the account is ${(start.rank && start.rank.name) || 'rank ' + rankId})`);
        let perCall = Math.max(1, parseInt(start.caseOpenCount) || 1), mult = Math.max(1, parseInt(start.maxCaseOpenMultiplier) || 1);
        const perOpen = perCall * mult;
        let stock = await stockOf(aid, item._id);

        // 1. cash -> items (whole opens when there's enough for one)
        // A backlog from runs that ran out of time is opened first; more is bought once it's down.
        // Stock first: what's in stock is opened first, then the set amount is bought and opened (p.bought: it has).
        const stockFirst = C('source') === 'stockAmount', want = Math.floor(num(C('buyAmount')));
        const buyStep = async (cash) => {
            lane.phase = 'buying'; p.bought = true;
            const price = num(item.price);
            let buy = buyCount(cash, price, C);
            if (C('source') === 'buy' && stock + buy >= perOpen) buy = Math.floor((stock + buy) / perOpen) * perOpen - stock;
            else if (amountish(C) && buy < want && buy > 0 && !item.isNonBuyable) log(`the cash covers ${count(buy)} of the ${count(want)} ${item.name}${num(C('keepMoney')) > 0 ? ` (keeping ${money(num(C('keepMoney')))})` : ''}`, 'warn');
            if (item.isNonBuyable) log(`${item.name} can't be bought in the shop — opening only what's there`, 'warn');
            else if (paused) log(`not buying: ${paused}`, 'warn');
            else if (num(C('maxPrice')) > 0 && price > num(C('maxPrice'))) log(`not buying: ${item.name} costs $${price}, over your limit of $${num(C('maxPrice'))}`, 'warn');
            else if (buy > 0) {
                if (practice) { log(`would buy ${count(buy)} ${item.name} for ${money(buy * price)}`); stock += buy; }
                else {
                    const pre = num((await getJson(aid, '/api/me')).money);
                    const br = await req(aid, '/api/cases', { method: 'POST', body: { id: item._id, type: item.type, amount: buy } });
                    const spent = Math.max(0, pre - num((await getJson(aid, '/api/me')).money));
                    stock = await stockOf(aid, item._id);
                    rec.spent += spent;
                    if (br.kind !== 'ok' && !spent) { catalog.at = 0; throw new Stop(`buying failed (${(br.json && br.json.error) || 'HTTP ' + br.status}), nothing was charged`); }
                    // Charged more than the shop said: the price moved. Stop buying everywhere until it's looked at.
                    if (spent / buy > price * 1.02) { paused = `charged $${(spent / buy).toFixed(2)} each instead of $${price} — check the price, then change the item or its max price`; log('buying stopped: ' + paused, 'error'); }
                    log(`bought ${count(buy)} ${item.name} for ${money(spent)}`, 'ok');
                }
            } else if (!stock) log(`not enough cash for one ${item.name} ($${price})`);
        };
        if (cont) lane.phase = 'opening';   // a later turn of the same job: it bought already
        else if (C('source') === 'buy' && stock >= perOpen * 200) log(`${count(stock)} already in stock — opening those before buying more`);
        else if (stockFirst && stock > 0 && !practice) log(`opening the ${count(stock)} ${item.name} in stock first, then buying ${count(want)} more`);
        else if (buys(C)) {
            if (stockFirst && stock > 0) log(`would open the ${count(stock)} ${item.name} in stock first, then:`);
            await buyStep(num(start.money));
        }
        // A later turn that starts with the stock already open: buy now.
        if (stockFirst && !practice && !p.bought && stock <= 0) await buyStep(num((await getJson(aid, '/api/me')).money));

        // 2. open them
        if (stock > 0) {
            lane.phase = 'opening';
            if (!practice && ctx.accounts.setBusy) ctx.accounts.setBusy(aid, S('exclusive') ? 'opening cases (others paused until done)' : 'opening cases');   // other plugins wait
            lane.of = stock; p.left = stock;
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
            if (practice && boostKinds().length) log(`would keep ${boostKinds().map(k => ({ caseOpenCountBoost: 'an open-count boost', caseOpenMultiplierBoost: 'a multiplier boost', caseOpenCashback: 'case-open cashback' })[k]).join(', ')} running while opening${S('boostBuy') ? ', buying with ammo when there are none' : ''}`);
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
                // Boosts: checked when opening starts, every BOOST_EVERY_MS and right as one ends; the open size follows.
                const boost = { at: 0, end: 0, said: new Set() };
                const boostCheck = async () => {
                    boost.at = Date.now();
                    try { const b = await keepBoosts(aid, log, boost.said); perCall = b.perCall; mult = b.mult; boost.end = b.nextEnd; }
                    catch (e) { log('boosts: ' + e.message, 'warn'); }
                };
                for (;;) {
                while (stock > 0) {
                    const t0 = Date.now();
                    if (halted() || lane.halt) throw new Stop(ctx.stopping ? 'turned off' : 'stopped by you');
                    if (boostKinds().length && (Date.now() - boost.at >= (num(S('boostEveryMs')) || BOOST_EVERY_MS) || (boost.end && Date.now() >= boost.end))) await boostCheck();
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
                        stock -= c * m; lane.opened += c * m; rec.opened += c * m; p.opened += c * m; p.left = stock; fails = 0; full = 0;
                        if (bySell) inv.used += c * m;
                        const j = r.json;
                        const v = Array.isArray(j) ? j.reduce((t, x) => t + num(x && x.price), 0) : num(j && j.totalValue);
                        rec.value += v; p.value += v;
                        if (num(item.price) > 0) { rec.cost += c * m * num(item.price); rec.pv += v; }
                        if (j && !Array.isArray(j)) {
                            const oid = ++hookOpenSeq;
                            for (const f of Array.isArray(j.favoritedSkins) ? j.favoritedSkins : []) { rec.favs++; hookPush(hookDrop(f, (ctx.accounts.get(aid) || {}).name || aid, item.name, oid)); log(`kept a favourited drop: ${f.name || 'a skin'}${f.price ? ` ($${num(f.price).toLocaleString('en-US')})` : ''}`, 'ok'); }
                        }
                        if (lane.opened % (perOpen * 25) < c * m) {
                            stock = await stockOf(aid, item._id); p.left = stock; save();
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
                        stock = await stockOf(aid, item._id); p.left = stock;
                    }
                    await ctx.sleep(OPEN_GAP_MS);
                    p.openMs += Date.now() - t0;
                }
                // Stock first: the stock is open — sell its drops (non-Pro) for the cash, buy the set amount, open that.
                if (stock > 0 || !stockFirst || p.bought || halted() || lane.halt) break;
                if (bySell && rec.opened) await sellDrops();
                await buyStep(num((await getJson(aid, '/api/me')).money));
                lane.phase = 'opening';
                if (stock <= 0) break;
                lane.of = lane.opened + stock; p.left = stock;
                }
                if (bySell && rec.opened) await sellDrops();
                log(`opened ${count(rec.opened)} ${item.name}${rec.sells ? ` (no auto-sell: sold the drops ${rec.sells}×)` : ''} — drops worth ${money(rec.value)}${rec.cost ? ` (${pct(rec.pv, rec.cost)} of what they cost)` : ''}`, 'ok');
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
                        for (const k of ['opened', 'spent', 'value', 'xp', 'cost', 'pv']) it[k] = (it[k] || 0) + rec[k];
                    }
                }
            } catch (_) {}
        }
        const t = today();
        for (const k of ['spent', 'opened', 'value', 'xp', 'favs', 'cost', 'pv']) t[k] = (t[k] || 0) + rec[k];
        state.last[aid] = Date.now();
        state.runs = [rec, ...(state.runs || [])].slice(0, 30);
        // The job goes on after a break while there's more to open; otherwise it's done.
        if (!practice && rec.left > 0 && !halted() && !lane.halt) jobs.set(aid, { practice: false, cont: true, at: Date.now() + (num(S('turnMs')) ? 500 : BREAK_MS) });
        else { jobs.delete(aid); if (!practice) { p.result = rec.result; p.at = Date.now(); } }
        lanes.delete(aid);
        if (ctx.accounts.setBusy) ctx.accounts.setBusy(aid, null);
        save();
    }
}

// ---- Boosts while opening ----
// The site's case-open effects (its inventory Special Effects window): one of each kind runs at a time; /api/me
// caseOpenCount and maxCaseOpenMultiplier include a running boost, activeSpecialEffects[].activeTill is its end.
// Activate POST /api/inventory/specialEffects { name }; buy one with ammo PUT { name } (/api/me ammu).
const BOOST = {
    caseOpenCountBoost: [['Huge Case Open Count Boost', 15, 60, 1600], ['Big Case Open Count Boost', 10, 30, 400], ['Medium Case Open Count Boost', 5, 20, 80], ['Small Case Open Count Boost', 5, 10, 40], ['Tiny Case Open Count Boost', 2, 5, 20]],
    caseOpenMultiplierBoost: [['Huge Case Open Multiplier Boost', 1, 60, 1600], ['Big Case Open Multiplier Boost', 1, 15, 400]],
    caseOpenCashback: [['Huge Case Open Cashback', 5, 60, 1600], ['Big Case Open Cashback', 5, 30, 400], ['Medium Case Open Cashback', 3, 30, 80], ['Small Case Open Cashback', 2, 15, 40], ['Tiny Case Open Cashback', 1, 5, 20]],
};
const BOOST_EVERY_MS = 10000;
const boostKinds = () => [S('boostCount') && 'caseOpenCountBoost', S('boostMult') && 'caseOpenMultiplierBoost', S('boostCashback') && 'caseOpenCashback'].filter(Boolean);
const activeOf = (me) => (Array.isArray(me.activeSpecialEffects) ? me.activeSpecialEffects : []).filter(e => (Date.parse(e.activeTill || '') || 0) > Date.now());

// Starts the chosen kinds that aren't running: the biggest in stock first; with none, buys the one that gives the
// most per ammo (value × minutes ÷ price) above "keep ammo". Returns the open size now and when the next boost ends.
async function keepBoosts(aid, log, said) {
    let me = await getJson(aid, '/api/me');
    const kinds = boostKinds();
    const need = kinds.filter(k => !activeOf(me).some(e => e.effect === k));
    let started = 0;
    if (need.length) {
        const list = await getJson(aid, '/api/inventory/specialEffects');
        const stock = new Map((Array.isArray(list) ? list : []).map(e => [e && e.name, num(e && e.amount)]));
        let ammo = num(me.ammu);
        for (const k of need) {
            let name = (BOOST[k].find(([n]) => stock.get(n) > 0) || [])[0];
            if (!name && S('boostBuy')) {
                const keep = num(S('boostKeepAmmo'));
                const best = BOOST[k].filter(([, , , cost]) => ammo - cost >= keep).sort((x, y) => (y[1] * y[2] / y[3]) - (x[1] * x[2] / x[3]) || x[3] - y[3])[0];
                if (best) {
                    const b = await req(aid, '/api/inventory/specialEffects', { method: 'PUT', body: { name: best[0] } });
                    if (b.kind === 'ok' && !(b.json && b.json.error)) { ammo -= best[3]; name = best[0]; log(`bought 1 ${name} with ${best[3]} ammo`); }
                    else log(`couldn't buy ${best[0]} (${(b.json && b.json.error) || 'HTTP ' + b.status})`, 'warn');
                }
            }
            if (!name) { if (!said.has(k)) { said.add(k); log(`no ${BOOST[k][0][0].replace(/^Huge /, '').toLowerCase()} in stock${S('boostBuy') ? ' and not enough ammo to buy one' : ''} — opening without it`); } continue; }
            const r = await req(aid, '/api/inventory/specialEffects', { method: 'POST', body: { name } });
            if (r.kind === 'ok' && !(r.json && r.json.error)) { started++; said.delete(k); log(`started ${name}`, 'ok'); }
            else log(`couldn't start ${name} (${(r.json && r.json.error) || 'HTTP ' + r.status})`, 'warn');
        }
    }
    if (started) me = await getJson(aid, '/api/me');
    const ends = activeOf(me).filter(e => kinds.includes(e.effect)).map(e => Date.parse(e.activeTill));
    return { perCall: Math.max(1, parseInt(me.caseOpenCount) || 1), mult: Math.max(1, parseInt(me.maxCaseOpenMultiplier) || 1), nextEnd: ends.length ? Math.min(...ends) : 0 };
}

// Runs the jobs started from the page (Open now / Preview), a few accounts at a time.
// At most PER_IP accounts open at once on one exit IP (the site gets angry from 4 at once on one connection with a
// bad ping): more than that at once needs accounts on proxies. ipOf(aid): the account's exit-IP group ('direct' is
// this PC's connection; proxies with the same exit IP are one group).
const PER_IP = 3;
const maxLanes = () => Math.max(1, Math.min(10, num(S('lanes')) || 1));
function ipGroups() {
    try {
        const st = ctx.network.state(), g = new Map(st.routes.map(r => [r.id, r.group || r.id]));
        return new Map(st.accounts.map(a => [a.id, g.get(a.route || 'direct') || a.route || 'direct']));
    } catch (_) { return new Map(); }
}
const ipOf = (groups, aid) => groups.get(aid) || 'direct';
function tick() {
    const max = maxLanes(), groups = ipGroups(), perIp = new Map();
    for (const aid of lanes.keys()) perIp.set(ipOf(groups, aid), (perIp.get(ipOf(groups, aid)) || 0) + 1);
    for (const [aid, j] of jobs) {
        if (lanes.size >= max) break;
        const a = ctx.accounts.get(aid);
        if (!a || !opensHere(aid)) { jobs.delete(aid); continue; }
        if (!a.healthy || lanes.has(aid) || Date.now() < j.at) continue;
        if (ctx.accounts.busy && ctx.accounts.busy(aid)) continue;   // another plugin's turn: try again in a moment
        const ip = ipOf(groups, aid);
        if ((perIp.get(ip) || 0) >= PER_IP) continue;               // this IP has its 3 opening: wait for one to finish
        perIp.set(ip, (perIp.get(ip) || 0) + 1);
        j.at = Infinity;   // running
        run(aid, a.name, j.practice, j.cont);
    }
}

module.exports = {
    start(c) {
        ctx = c;
        state = { last: {}, runs: [], items: {}, ...ctx.data.get() };
        hookUrl = state.hook ? ctx.secrets.unseal(state.hook) : null;
        hookQ = []; hookDead = ''; hookWait = 0;
        if (state.hook && !hookUrl) ctx.log('Discord webhook: the saved one can\'t be read on this computer — paste it again', 'warn');
        ctx.every(HOOK_GAP_MS, hookFlush);
        ctx.panel.action('hookSave', () => {
            const u = String(S('hookPaste') || '').trim();
            ctx.settings.set('hookPaste', '');   // the URL doesn't stay in the box
            if (!u) return { ok: false, error: 'Paste the webhook URL first (Discord: channel settings → Integrations → Webhooks → Copy Webhook URL).' };
            if (!HOOK_RE.test(u)) return { ok: false, error: 'That isn\'t a Discord webhook URL — it starts with https://discord.com/api/webhooks/' };
            hookUrl = u; hookDead = ''; hookWait = 0; state.hook = ctx.secrets.seal(u); save();
            return { message: 'Webhook saved — favourited drops post there. Send a test to check it.' };
        });
        ctx.panel.action('hookTest', async () => {
            if (!hookUrl) return { ok: false, error: 'Save a webhook first.' };
            try {
                const r = await hookPost({ username: 'ZSB Hub', allowed_mentions: { parse: [] }, content: 'ZSB Hub: favourited drops from the Opener will post here.' });
                if (r.ok) { hookDead = ''; return { message: 'Test sent — check the channel.' }; }
                if (r.dead) { hookDead = r.dead; return { ok: false, error: r.dead }; }
                return { ok: false, error: r.wait ? 'Discord is rate-limiting this webhook — try again in a moment.' : 'Not sent: ' + r.error };
            } catch (e) { return { ok: false, error: 'Not sent: ' + (e.name === 'TimeoutError' ? 'timed out' : 'no connection to Discord') }; }
        });
        ctx.panel.action('hookClear', () => { hookUrl = null; hookQ = []; hookDead = ''; delete state.hook; save(); return { message: 'Webhook removed.' }; });
        today();
        ctx.settings.onChange((k) => { if (k === 'item' || k === 'maxPrice' || k === 'sets') paused = null; });
        // Fill the item list as soon as any account is clicking, so it can be chosen before the first run.
        const fill = async () => { if (catalog.items) return; const a = ctx.accounts.list().find(x => x.healthy); if (a) { try { await refreshCatalog(a.id); } catch (_) {} } };
        fill();
        ctx.every(15000, fill);
        ctx.every(2000, tick);
        const start = (practice, only) => {
            const all = ctx.accounts.list().filter(a => opensHere(a.id) && (!only || a.id === only));
            if (!all.length) return { ok: false, error: 'Choose accounts first.' };
            const chosen = all.filter(a => cfgOf(a.id)('item'));
            if (!chosen.length) return { ok: false, error: 'Pick something to open first.' };
            halt = false;
            for (const a of chosen) if (!lanes.has(a.id)) {
                jobs.set(a.id, { practice, cont: false, at: 0 });
                if (!practice) prog.delete(a.id);   // a new job: its progress starts over
                // Others paused until done: the accounts waiting their turn are held from now, not only while opening.
                if (!practice && S('exclusive') && ctx.accounts.setBusy) ctx.accounts.setBusy(a.id, 'waiting to open cases (others paused until done)');
            }
            tick();
            return { message: practice ? 'Previewing — what it would do shows up here in a moment.' : `Opening on ${chosen.length} account${chosen.length === 1 ? '' : 's'}.` };
        };
        ctx.panel.action('preview', () => start(true));
        ctx.panel.action('open', () => start(false));
        const stoppedByYou = (aid) => { const p = prog.get(aid) || { item: '', opened: 0, left: null, openMs: 0, value: 0, t0: Date.now() }; p.result = 'stopped by you'; p.at = Date.now(); prog.set(aid, p); };
        ctx.panel.action('openOne', (aid) => start(false, String(aid || '')));
        // Stop one account: a running one ends after its current open, a waiting one (or one on a break) at once.
        ctx.panel.action('stopOne', (aid) => {
            aid = String(aid || '');
            const name = (ctx.accounts.get(aid) || {}).name || aid, l = lanes.get(aid);
            if (l) { l.halt = true; jobs.delete(aid); return { message: `Stopping ${name} after its current open.` }; }
            if (!jobs.has(aid)) return { message: `${name} isn't opening.` };
            jobs.delete(aid);
            if (ctx.accounts.setBusy) ctx.accounts.setBusy(aid, null);
            stoppedByYou(aid);
            return { message: `Stopped ${name}.` };
        });
        ctx.panel.action('stop', () => {
            if (!lanes.size && ![...jobs.values()].some(j => !j.practice)) return { message: 'Nothing is opening.' };
            for (const aid of jobs.keys()) if (!lanes.has(aid)) {
                if (ctx.accounts.setBusy) ctx.accounts.setBusy(aid, null);
                stoppedByYou(aid);
            }
            jobs.clear(); halt = lanes.size > 0;
            return { message: lanes.size ? 'Stopping after the current open.' : 'Stopped.' };
        });

        // The page: what's happening now on top (with Open now / Stop all), then a row per account with its status,
        // progress, speed, time left and its own Stop / Open; then the settings, folded, and the history.
        const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`; };
        const ago = (t) => dur(Date.now() - t) + ' ago';
        const rateOf = (p) => (p && p.opened && p.openMs > 3000 ? p.opened / p.openMs : 0);   // cases per ms of opening
        // Time left: the cases left at this account's own speed, plus the breaks between turns on the way.
        const etaOf = (p) => {
            const r = rateOf(p); if (!r || !p.left) return 0;
            const ms = p.left / r, turn = num(S('turnMs')) || RUN_MS;
            return S('exclusive') ? ms : ms + Math.floor(ms / turn) * (num(S('turnMs')) ? 500 : BREAK_MS);
        };
        const PHASE = { starting: 'Starting', buying: 'Buying', opening: 'Opening', 'selling drops': 'Selling drops' };
        ctx.panel.tab('Opener', () => {
            const t = today();
            const chosen = ctx.accounts.list().filter(a => opensHere(a.id));
            const n = chosen.length;
            const itemOf = (id) => catalog.items && catalog.items.find(x => x._id === id);
            const item = itemOf(S('item'));
            // Sets in use: accounts on one open its item; the main What to open is for the rest (defs).
            const sets = setsOf(), setsOn = sets.some(s => s.item);
            const defs = chosen.filter(a => !setOf(a.id)), nd = defs.length;
            const buying = buys(), keep = S('drops') === 'keep';
            // The buy plan: each chosen account's cash (from its last check), what it buys and what's left.
            const price = item ? num(item.price) : 0, each = Math.floor(num(S('buyAmount')));
            const plan = buying && item && price > 0 ? defs.map(a => {
                const cash = num((ctx.accounts.stats(a.id) || {}).money), b = buyCount(cash, price);
                return { name: a.name, cash, buy: b, cost: b * price, short: amountish() && b < each };
            }) : [];
            const planBuy = plan.reduce((s, p) => s + p.buy, 0), planCost = plan.reduce((s, p) => s + p.cost, 0), short = plan.filter(p => p.short).length;
            const usd = (v) => '$' + num(v).toLocaleString('en-US');
            const blockedBuy = item && buying ? (item.isNonBuyable ? `${item.name} isn't sold in the shop — set Source to From stock`
                : num(S('maxPrice')) > 0 && price > num(S('maxPrice')) ? `${item.name} costs ${usd(price)}, over your max price of ${usd(S('maxPrice'))} — nothing is bought` : null) : null;
            const buyTxt = !item ? '' : S('source') === 'stockAmount' ? `Open the ${item.name} in stock, then buy ${count(each)} on each account (${money(planCost)} in all)` : S('source') === 'amount' ? `Buy ${count(each)} ${item.name} on each account (${money(planCost)} in all)` : `Buy ${item.name} with the spare cash (about ${money(planCost)} in all)`;
            const plans = Object.values(state.plans || {}).filter(x => chosen.some(a => a.name === x.name) && x.t > (state.practiceAt || 0) - 60000).sort((a, b) => b.t - a.t);
            const dropsTxt = keep ? 'kept' : `sold for ${S('drops') === 'tokens' ? 'tokens' : 'cash'}${num(S('keepOver')) > 0 ? ` when worth under ${num(S('keepOver'))}` : ''}`;
            const measured = item && state.items[item._id];
            // Each account's own plan: what it opens and what it buys (its set's settings, or the main ones).
            const planFor = (a) => {
                const C = cfgOf(a.id), it = itemOf(C('item')), pr = it ? num(it.price) : 0, by = buys(C);
                const blocked = it && by && (it.isNonBuyable || (num(C('maxPrice')) > 0 && pr > num(C('maxPrice'))));
                const b = it && by && !blocked ? buyCount(num((ctx.accounts.stats(a.id) || {}).money), pr, C) : 0;
                return { C, set: setOf(a.id), item: it, buying: by && !blocked, buy: b, cost: b * pr };
            };
            // An account on two sets opens the first one's item: say which.
            const chosenOn = (s) => ctx.accounts.list().filter(a => s.item && setOf(a.id) === s).length;
            const setClash = ctx.accounts.list().filter(a => sets.filter(s => onSet(s, a.id)).length > 1).map(a => a.name);
            const plansOf = new Map(chosen.map(a => [a.id, planFor(a)]));
            const ready = chosen.filter(a => plansOf.get(a.id).item);
            const byItem = [...ready.reduce((m, a) => { const nm = plansOf.get(a.id).item.name; m.set(nm, (m.get(nm) || 0) + 1); return m; }, new Map())];
            const tBuy = ready.reduce((s, a) => s + plansOf.get(a.id).buy, 0), tCost = ready.reduce((s, a) => s + plansOf.get(a.id).cost, 0);
            const anyBuy = ready.some(a => plansOf.get(a.id).buying);
            const itemsTxt = byItem.length <= 3 ? byItem.map(x => x[0]).join(', ') : `${byItem.length} items`;
            // How many really open at once: the setting, but at most PER_IP per exit IP the chosen accounts are on.
            const groups = ipGroups(), ips = new Set(chosen.map(a => ipOf(groups, a.id)));
            const setLanes = maxLanes(), maxLanes_ = Math.min(setLanes, PER_IP * Math.max(1, ips.size));
            const ipFull = (id) => { const ip = ipOf(groups, id); return [...lanes.keys()].filter(x => ipOf(groups, x) === ip).length >= PER_IP; };
            const capNote = setLanes > maxLanes_ ? `Set to ${setLanes} at once, but ${ips.size === 1 ? 'these accounts are all on one IP' : `these accounts are on ${ips.size} IPs`}: at most ${maxLanes_} open at once (${PER_IP} per IP — the site gets touchy from 4 on one connection). Put accounts on proxies to open more at once.` : '';

            // Each account now: running, on a break, waiting its turn, or how its last job ended.
            const active = (id) => lanes.has(id) || (jobs.has(id) && !jobs.get(id).practice);
            const status = (a) => {
                const l = lanes.get(a.id), j = jobs.get(a.id), p = prog.get(a.id);
                if (l) return { text: (j && j.practice) || !p ? 'Previewing' : PHASE[l.phase] || l.phase, level: 'ok' };
                if (j && j.practice) return { text: 'Preview waiting', level: 'muted' };
                if (j && j.cont) return { text: `On a break · back in ${dur(j.at - Date.now())}` };
                if (j) return { text: !a.healthy ? 'Waiting · not clicking' : ctx.accounts.busy && ctx.accounts.busy(a.id) ? 'Waiting · another plugin is using it' : ipFull(a.id) && maxLanes_ < setLanes ? `Waiting · ${PER_IP} at a time on this IP` : lanes.size >= maxLanes_ ? `Waiting · ${maxLanes_} at a time` : 'Waiting', level: 'muted' };
                if (!a.healthy) return { text: 'Not clicking', level: 'muted' };
                if (p && p.at) {
                    if (p.result === 'done') return { text: `Done ${ago(p.at)}` };
                    if (p.result === 'nothing to open') return { text: `Nothing to open (${ago(p.at)})`, level: 'muted' };
                    if (p.result === 'stopped by you') return { text: `Stopped by you ${ago(p.at)}`, level: 'warn' };
                    return { text: `Stopped: ${p.result}`, level: 'bad' };
                }
                return { text: 'Idle', level: 'muted' };
            };
            // Running first, then on a break, then waiting, then the rest in the usual order.
            const rank = (a) => (lanes.has(a.id) ? 0 : jobs.has(a.id) && jobs.get(a.id).cont ? 1 : jobs.has(a.id) ? 2 : 3);
            const rows = chosen.map((a, i) => [a, i]).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map(([a]) => {
                const p = prog.get(a.id), on = active(a.id), me = ctx.accounts.stats(a.id) || {}, pl = plansOf.get(a.id);
                const total = p && p.left != null ? p.opened + p.left : 0, r = rateOf(p), eta = on ? etaOf(p) : 0;
                return [
                    a.name,
                    ...(setsOn ? [pl.item ? (pl.set ? setName(pl.set) + ' · ' : '') + pl.item.name : { text: 'nothing chosen', level: 'muted' }] : []),
                    status(a),
                    total ? { bar: p.opened / total, text: `${count(p.opened)} / ${count(total)}` } : { text: '—', level: 'muted' },
                    p && p.left != null ? count(p.left) : '—',
                    r ? `${count(r * 60000)}/min` : '—',
                    eta ? dur(eta) : on && p && p.left ? 'working it out' : '—',
                    money(num(me.money)),
                    on ? { label: 'Stop', action: 'stopOne', arg: a.id }
                        : pl.item && a.healthy ? { label: 'Open', action: 'openOne', arg: a.id, confirm: `${pl.buying ? pl.C('source') === 'stockAmount' ? `Open the ${pl.item.name} in stock, then buy ${count(Math.floor(num(pl.C('buyAmount'))))} and open those` : `Buy ${pl.item.name}${pl.C('source') === 'amount' ? ` (${count(Math.floor(num(pl.C('buyAmount'))))})` : ' with the spare cash'} and open it` : `Open the ${pl.item.name} in stock`} on ${a.name}? Drops are ${dropsTxt}.` } : '',
                ];
            });

            // The top: running (how far, how long, Stop all) or ready (what Open now will do, Open now / Preview).
            const act = chosen.filter(a => active(a.id)), running = act.filter(a => lanes.has(a.id)).length;
            const ps = act.map(a => prog.get(a.id)).filter(Boolean);
            const done = ps.reduce((s, p) => s + p.opened, 0), left = ps.reduce((s, p) => s + (p.left || 0), 0), worth = ps.reduce((s, p) => s + p.value, 0);
            // Time left for all of them. Accounts not started yet have no count: each is guessed to take as long as the
            // measured ones (their cases ÷ speed), started maxLanes at a time after the ones running now.
            const known = ps.filter(p => p.left != null), notYet = act.length - known.length;
            const durs = known.map(p => { const r = rateOf(p); return r ? (p.opened + p.left) / r : 0; }).filter(Boolean);
            const avgDur = durs.length ? durs.reduce((s, x) => s + x, 0) / durs.length : 0;
            const nowEta = Math.max(0, ...known.map(etaOf));
            const eta = !act.length || !nowEta && known.some(p => p.left) ? 0 : !notYet ? nowEta : avgDur ? nowEta + Math.ceil(notYet / maxLanes_) * avgDur : 0;
            const names = [...new Set(ps.map(p => p.item).filter(Boolean))];
            const hero = act.length ? {
                type: 'hero', level: 'ok', pill: 'Running',
                title: `Opening ${names.join(', ') || (item ? item.name : 'cases')} on ${act.length} account${act.length === 1 ? '' : 's'}`,
                text: [!(done + left) ? 'starting' : notYet ? `${count(done)} opened · ${act.length - notYet} of ${act.length} accounts started` : `${count(done)} of ${count(done + left)} opened`,
                    eta ? `about ${dur(eta)} left` : done ? 'working out the time left' : '',
                    worth ? `drops worth ${money(worth)} so far` : '',
                    act.length > running ? `${running} at a time` : ''].filter(Boolean).join(' · '),
                buttons: [{ label: act.length === 1 ? 'Stop' : 'Stop all', action: 'stop', danger: true }],
            } : {
                type: 'hero',
                title: !n ? 'Choose accounts to open on' : !ready.length ? 'Pick something to open' : `Ready to open ${itemsTxt}`,
                text: !n ? 'Which accounts — below.' : !ready.length ? 'What to open — below.'
                    : `${anyBuy ? `Buys ${count(tBuy)} for ${money(tCost)}` : 'Opens what\'s in stock'} on ${ready.length} account${ready.length === 1 ? '' : 's'}, ${maxLanes_} at a time · drops ${dropsTxt}${S('exclusive') ? ' · other plugins wait until it\'s done' : ''}${ready.length < n ? ` · ${n - ready.length} with nothing chosen` : ''}`,
                buttons: ready.length ? [
                    { label: 'Open now', action: 'open', primary: true, confirm: !setsOn
                        ? `${buying && !blockedBuy ? `${buyTxt} and open it` : `Open the ${item.name} in stock`} on ${n} account${n === 1 ? '' : 's'}? Drops are ${dropsTxt}.`
                        : `Open on ${ready.length} account${ready.length === 1 ? '' : 's'}: ${byItem.map(([nm, k]) => `${nm} on ${k}`).join(', ')}${anyBuy ? ` (buying about ${money(tCost)} in all)` : ''}? Drops are ${dropsTxt}.` },
                    { label: 'Preview', action: 'preview' }] : [],
            };

            return { pin: act.length ? 'running' : undefined, blocks: [
                hero,
                ...(paused ? [{ type: 'notice', level: 'bad', text: 'Buying is stopped: ' + paused }] : []),
                ...(n ? [{ type: 'table', columns: ['Account', ...(setsOn ? ['Opens'] : []), 'Status', 'Opened', 'Left', 'Speed', 'Time left', 'Cash', ''], rows }] : []),
                ...(plans.length && !act.length ? [{ type: 'section', title: 'Preview — what Open now would do', blocks: [
                    { type: 'table', wrap: true, columns: ['Account', 'Would', 'When'], rows: plans.slice(0, 10).map(x => [x.name, x.lines.join(' · '), new Date(x.t).toLocaleTimeString()]) }] }] : []),
                ...(t.opened ? [{ type: 'stats', items: [
                    { label: 'Opened today', value: count(t.opened) },
                    { label: 'Spent today', value: money(t.spent) },
                    { label: 'Drops worth', value: money(t.value || 0) + (t.cost ? ` · ${pct(t.pv, t.cost)}` : '') },
                    { label: 'XP today', value: count(t.xp) + (t.ranks ? ` · ${t.ranks} rank-up${t.ranks === 1 ? '' : 's'}` : '') },
                ] }] : []),
                { type: 'section', title: 'Settings', blocks: [
                { type: 'card', id: 'item', open: !item && !setsOn, title: 'What to open',
                    summary: (setsOn ? (nd ? 'everyone else: ' : 'no one else: ') : '') + (!item ? 'nothing chosen' : !buying ? `${item.name} · from stock` : blockedBuy ? `${item.name} · not buying` : `${item.name} · ${S('source') === 'stockAmount' ? 'stock first, then ' : ''}${count(planBuy)} for ${money(planCost)}${nd > 1 ? ` on ${nd} accounts` : ''}`)
                        + (sets.length ? ` · ${sets.length} set${sets.length === 1 ? '' : 's'}` : ''),
                    keys: amountish() ? ['item', 'source', 'buyAmount', 'maxPrice', 'keepMoney'] : buying ? ['item', 'source', 'maxPrice', 'keepMoney', 'keepPct', 'spendPerRun'] : ['item', 'source'],
                    blocks: [
                        ...(blockedBuy ? [{ type: 'notice', level: 'warn', text: blockedBuy }] : []),
                        ...(plan.length && !blockedBuy ? [
                            { type: 'stats', items: [
                                { label: 'Price each', value: usd(price) },
                                { label: amountish() ? (nd > 1 ? `Buying (${count(each)} each)` : 'Buying') : 'Spare cash buys', value: count(planBuy) },
                                { label: 'Total cost', value: money(planCost) },
                            ] },
                            ...(short ? [{ type: 'notice', level: 'warn', text: `${short} account${short === 1 ? '' : 's'} can't cover ${count(each)}${num(S('keepMoney')) > 0 ? ` and keep ${money(num(S('keepMoney')))}` : ''} — ${short === 1 ? 'it buys' : 'they buy'} what the cash allows.` }] : []),
                            { type: 'table', columns: ['Account', 'Cash', 'Buys', 'Cost', 'Cash after'],
                                rows: [...plan.map(p => [p.name, money(p.cash), p.short ? `${count(p.buy)} (short)` : count(p.buy), money(p.cost), money(p.cash - p.cost)]),
                                    ...(plan.length > 1 ? [['Total', money(plan.reduce((s, p) => s + p.cash, 0)), count(planBuy), money(planCost), money(plan.reduce((s, p) => s + p.cash - p.cost, 0))]] : [])] },
                        ] : []),
                        ...(measured && measured.opened ? [{ type: 'stats', items: [
                            { label: 'Opened so far', value: count(measured.opened) },
                            { label: 'Drops worth', value: price > 0 ? pct(measured.value || 0, measured.opened * price) + ' of the cost' : money(measured.value || 0) },
                            { label: 'XP per open', value: +(measured.xp / measured.opened).toFixed(2) + '' },
                        ] }] : []),
                        { type: 'section', title: 'Sets — other accounts open something else', text: 'A set has its own item, buying and accounts. Its accounts open that even when not ticked under Which accounts; everyone else opens the item above.', blocks: [
                            ...(setClash.length ? [{ type: 'notice', level: 'warn', text: `On more than one set: ${setClash.join(', ')} — each opens its first set's item.` }] : []),
                            { type: 'list', key: 'sets', summaries: sets.map(s => {
                                const it = itemOf(s.item), k = chosenOn(s);
                                if (!s.item) return `${s.name ? setName(s) + ': ' : ''}no item yet — not used`;
                                return `${s.name ? setName(s) + ': ' : ''}${it ? it.name : 'item not in the shop'} · ${({ amount: `buys ${count(Math.floor(num(s.buyAmount)))} each`, stockAmount: `stock first, then buys ${count(Math.floor(num(s.buyAmount)))} each`, buy: 'buys with spare cash', owned: 'from stock' })[s.source] || ''} · ${k} account${k === 1 ? '' : 's'}`;
                            }) },
                        ] },
                    ] },
                { type: 'card', id: 'accounts', open: !n, title: 'Which accounts', summary: n ? `${n} account${n === 1 ? '' : 's'}${n > nd ? ` (${n - nd} on sets)` : ''} · ${maxLanes_} at a time${maxLanes_ < setLanes ? ` (${PER_IP} per IP)` : ''}${S('exclusive') ? ' · other plugins wait until done' : ''}` : 'none yet',
                    keys: ['accounts', 'lanes', 'exclusive'], blocks: capNote ? [{ type: 'notice', level: 'warn', text: capNote }] : [] },
                { type: 'card', id: 'drops', open: false, title: 'Drops', summary: dropsTxt, keys: keep ? ['drops'] : ['drops', 'keepOver'] },
                { type: 'card', id: 'boosts', open: false, title: 'Boosts', summary: boostKinds().length ? `keeps ${boostKinds().map(k => ({ caseOpenCountBoost: 'open count', caseOpenMultiplierBoost: 'multiplier', caseOpenCashback: 'cashback' })[k]).join(', ')} running while opening${S('boostBuy') ? ' · buys with ammo' : ''}` : 'off — opens at the account’s own size',
                    keys: ['boostCount', 'boostMult', 'boostCashback', ...(boostKinds().length ? ['boostBuy', ...(S('boostBuy') ? ['boostKeepAmmo'] : [])] : [])] },
                { type: 'card', id: 'favs', open: false, title: 'Auto-favourite', summary: favText(),
                    keys: !S('favSet') ? ['favSet'] : ['favSet', 'favLow', ...(S('favLow') ? ['lowFloat'] : []), 'favHigh', ...(S('favHigh') ? ['highFloat'] : []),
                        'favCustom', ...(S('favCustom') ? ['customFloats'] : []), 'favPatterns', ...(S('favPatterns') ? ['patternBlacklist'] : [])],
                    blocks: S('favSet') && (S('customFloats') || []).length > customFloats().length
                        ? [{ type: 'notice', level: 'warn', text: `Left out: ${(S('customFloats') || []).filter(f => !customFloats().includes(f)).join(', ')} — custom floats are digits and one dot, up to 20 characters, at most ${MAX_CUSTOM}.` }] : [] },
                { type: 'card', id: 'hook', open: false, title: 'Discord',
                    summary: !hookUrl ? 'off — post favourited drops to a channel' : hookDead ? 'stopped: ' + hookDead : `posts favourited drops${num(S('hookMin')) > 0 ? ` worth ${money(num(S('hookMin')))}+` : ''} to ${hookTail()}${state.hookSent ? ` · ${count(state.hookSent)} sent` : ''}`,
                    keys: hookUrl ? ['hookMin'] : ['hookPaste'],
                    blocks: [
                        ...(hookDead ? [{ type: 'notice', level: 'bad', text: hookDead }] : []),
                        { type: 'buttons', items: hookUrl
                            ? [{ label: 'Send a test', action: 'hookTest' }, { label: 'Remove webhook', action: 'hookClear', danger: true, confirm: 'Remove the Discord webhook? Favourited drops stop posting.' }]
                            : [{ label: 'Save webhook', action: 'hookSave', primary: true }] },
                    ] },
                ] },
                { type: 'section', title: 'Recent runs', blocks: [{ type: 'table', empty: 'No runs yet.', columns: ['When', 'Account', 'Item', 'Spent', 'Opened', 'Drops worth', 'Result'],
                    rows: (state.runs || []).slice(0, 10).map(r => [new Date(r.t).toLocaleTimeString(), r.acct, r.item || '—', money(r.spent), count(r.opened), money(r.value || 0), r.result]) }] },
            ] };
        });
        ctx.panel.badge((aid) => { const l = lanes.get(aid); return l ? 'Opening: ' + l.phase : null; });
    },
    stop() { lanes.clear(); },
};

