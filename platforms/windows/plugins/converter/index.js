/**
 * CONVERTER
 *
 * On the accounts chosen in its settings, one run is (each step can be turned off):
 *   1. sell clicked weapon cases       DELETE /api/cases { id, type: 'case', amount }  (pays 70% of the price)
 *   2. sell skins up to a price         DELETE /api/inventory { type: 'price', value, currency: 'tokens' }
 *   3. buy the chosen capsule           POST /api/cases { id, type, amount }  — whole opens only, with the cash left
 *                                       after "keep" amounts; refused above the max price
 *   4. open them, drops sold to tokens  POST /api/open/<type>. Pro: only after the server confirms auto-open sells
 *                                       everything to tokens (GET/PUT /api/user/autoOpen/config). Non-Pro accounts
 *                                       lost auto-sell (site update, 2026-11-06): drops go to the inventory, and from
 *                                       /api/me inventoryCount / inventorySize and the items an open adds (count ×
 *                                       multiplier) it opens until the inventory would pass 90%, sells the drops for
 *                                       tokens (DELETE /api/inventory, price cap, favourites stay), and goes on;
 *                                       a last sell at the end.
 *   5. upgrade into Dragon Lores        POST /api/casino/upgrade { userSkinReq: null, userTokensReq: 5M,
 *                                       upgradeSkinReq: <Souvenir AWP | Dragon Lore (FN), $500K> } — 70% a try,
 *                                       until under 5M tokens or the 300-a-day limit (shared with the Armory's
 *                                       upgrades, so the Armory leaves these accounts alone: ctx.shared "converter/dlore")
 * Prices come from the site's shop data (/_next/data/<build>/en/cases/{cases,capsules}.json).
 * Practice mode (the default) only logs what a run would do.
 *
 * Every write is sent once and the result is read back from the account (/api/me, /api/cases):
 * what counts is what the account holds afterwards, not what an answer said.
 */

const PRESET = 'ZSB Hub convert';
const NO_CAP = 999999;   // autosellAmount is a value cap: drops worth more are kept
const OPEN_GAP_MS = 300;
const CATALOG_MS = 30 * 60 * 1000;
const MAX_OPEN_FAILS = 5;
const INV_FILL = 0.9;    // non-Pro: sell the drops before the inventory passes this
const INV_FULL = /inventory (is )?full|full inventory|no (more |free )?(space|slots?)|not enough (inventory )?(space|slots?)/i;   // the site's "inventory full" answers
const FULL_RETRIES = 2;  // a refusal that selling doesn't cure this many times in a row stops the run
// The upgrade target the old hub used live (2026-10-23: 357 tries, 252 hits). 5M tokens stake $350K of its $500K: 70%.
const DLORE_SKIN = {
    _id: '6353e5c6167322ae1095edf7', name: 'Souvenir AWP | Dragon Lore (Factory New)', classId: '1242384628',
    iconUrl: '-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXH5ApeO4YmlhxYQknCRvCo04DEVlxkKgpot621FAR17P7NdTRH-t26q4SZlvD7PYTQgXtu5Mx2gv2P9o6migzl_Us5ZmCmLYDDJgU9NA6B81S5yezvg8e-7cycnXJgvHZx5WGdwUJqz1Tl4g',
    type: 'Weapon', weaponType: 'Sniper Rifle', gunType: 'AWP', knifeType: null, exterior: 'Factory New', rarity: 'Covert',
    rarityColor: 'eb4b4b', price: 500000, souvenir: true, __v: 0, isNonObtainable: false,
};
const DLORE_STAKE = 5000000;
const WHO = { basic: 'non-Pro accounts', pro: 'Pro accounts', both: 'every account' };

let ctx = null;
let state = null;            // saved: { last: { acctId: t }, today: { day, sold, skins, spent, opened, tokens }, runs: [...] }
const lanes = new Map();     // acctId -> { phase, started, opened, of }
const memberAt = new Map();  // acctId -> when Pro or not was last read
const catalog = { build: null, cases: null, capsules: null, at: 0 };
let paused = null;
let halt = false;            // "Stop" pressed: running lanes end after their current request
const halted = () => ctx.stopping || halt;           // why buying stopped (price changed) — cleared by changing the capsule or its max price

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const money = (n) => '$' + (Math.abs(n) >= 1e9 ? +(n / 1e9).toFixed(2) + 'B' : Math.abs(n) >= 1e6 ? +(n / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e3 ? +(n / 1e3).toFixed(1) + 'k' : Math.round(n));
const count = (n) => Math.round(n).toLocaleString('en-US');
const day = () => new Date().toISOString().slice(0, 10);
const S = (k) => ctx.settings.get(k);

class Stop extends Error {}

function save() { ctx.data.set(state); }

function today() {
    if (!state.today || state.today.day !== day()) state.today = { day: day(), sold: 0, skins: 0, spent: 0, opened: 0, tokens: 0, tries: 0, dlores: 0, inCases: true };
    if (!state.today.inCases) Object.assign(state.today, { opened: 0, inCases: true });   // before 1.5.0 it counted opens, not cases
    return state.today;
}

// Pro or not, from the account's last /api/me. Unknown counts as matching, so the Armory never spends the day's
// upgrades on an account that turns out to be a Dragon Lore one.
const MEMBER_MS = 10 * 60000;
const remember = (aid, me) => {
    if (!me || !me.membership) return;
    memberAt.set(aid, Date.now());
    if ((state.member || {})[aid] !== me.membership) { state.member = { ...(state.member || {}), [aid]: me.membership }; save(); }
};
function dloreOn(aid) {
    if (!S('dlore') || !ctx.settings.runsOn('accounts', aid)) return false;
    const m = (state.member || {})[aid], who = S('dloreWho') || 'basic';
    return who === 'both' || m == null || (who === 'pro') === (m === 'pro');
}
function publish() { if (ctx.shared) ctx.shared.set('dlore', ctx.accounts.list().filter(a => dloreOn(a.id)).map(a => a.id)); }

async function req(aid, path, opts) {
    const r = await ctx.request(aid, path, opts);
    if (r.kind === 'not-running') throw new Stop('the account stopped clicking');
    if (r.kind === 'auth') throw new Stop('logged out');
    if (r.kind === 'cf') throw new Stop('Cloudflare check');
    return r;
}
const getJson = async (aid, path) => { const r = await req(aid, path); if (r.kind !== 'ok') throw new Stop(`HTTP ${r.status} on ${path.split('?')[0]}`); return r.json; };

// The shop's page data. pageProps.cases is a JSON string of { _id, name, price, ... }.
async function refreshCatalog(aid, force) {
    if (!force && catalog.capsules && Date.now() - catalog.at < CATALOG_MS) return;
    const home = await req(aid, '/');
    const m = /"buildId"\s*:\s*"([^"]+)"/.exec(home.body || '');
    if (!m) throw new Stop('could not read the shop (no build id)');
    catalog.build = m[1];
    const page = async (file) => {
        const r = await req(aid, `/_next/data/${catalog.build}/en/cases/${file}.json?cases=${file}`);
        const raw = r.json && r.json.pageProps && r.json.pageProps.cases;
        const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!Array.isArray(list)) throw new Stop(`could not read the shop's ${file}`);
        return list.filter(c => c && c._id && num(c.price) > 0);
    };
    catalog.cases = await page('cases');
    catalog.capsules = await page('capsules');
    catalog.at = Date.now();
    ctx.settings.setOptions('capsule', catalog.capsules.slice().sort((a, b) => num(a.price) - num(b.price))
        .map(c => ({ value: c._id, label: `${c.name} — $${num(c.price).toLocaleString('en-US')}${c.isNonBuyable ? ' · not sold in the shop' : ''}` })));
}

const autosellOk = (c) => !!c && c.autosellActivated === true && c.autosellVariant === 'tokens' && num(c.autosellAmount) >= NO_CAP;
const unwrap = (r) => { const c = r && (r.config || r); if (!c || typeof c !== 'object') return null; const { activePresetId, ...rest } = c; return rest; };

// Make auto-open sell every drop to tokens, keeping the account's own other choices. Checked by reading it back.
async function ensureAutosell(aid, log) {
    const cur = unwrap(await getJson(aid, '/api/user/autoOpen/config'));
    if (autosellOk(cur)) return true;
    const want = { ...(cur || {}), autosellActivated: true, autosellVariant: 'tokens', autosellAmount: NO_CAP };
    const res = await getJson(aid, '/api/user/autoOpen/presets');
    const list = Array.isArray(res) ? res : (res && Array.isArray(res.presets) ? res.presets : []);
    let preset = list.find(p => p && p.name === PRESET);
    if (!preset) {
        const cr = await req(aid, '/api/user/autoOpen/presets', { method: 'POST', body: { name: PRESET, config: want } });
        if (cr.kind !== 'ok' || !cr.json || !cr.json._id) throw new Stop(`couldn't make the auto-open preset (HTTP ${cr.status})`);
        preset = cr.json;
    }
    const pr = await req(aid, '/api/user/autoOpen/config', { method: 'PUT', body: { config: want, activePresetId: preset._id } });
    if (pr.kind !== 'ok') throw new Stop(`couldn't set auto-open (HTTP ${pr.status})`);
    if (!autosellOk(unwrap(await getJson(aid, '/api/user/autoOpen/config')))) throw new Stop('the site did not confirm "sell everything to tokens" — not opening');
    log('auto-open set to sell every drop to tokens');
    return true;
}

// Non-Pro drops are sold up to this price (favourites stay, and never a Dragon Lore).
const dropMax = () => Math.min(num(S('dropSellMax')) || 9999, DLORE_SKIN.price - 1);

// A sell finishes on the site a moment after it answers (seen live 2026-11-06: tokens and the inventory count kept
// moving after the reply). Read /api/me until the inventory count stops falling, up to 15 s.
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

async function run(aid, name) {
    const lane = { phase: 'start', started: Date.now(), opened: 0, of: 0 };
    lanes.set(aid, lane);
    const practice = ctx.power.practice();
    const plan = [];
    const log = (msg, level = 'info') => { if (practice && /^would /.test(msg)) plan.push(msg.replace(/^would /, '')); ctx.log((practice ? 'practice — ' : '') + msg, level, aid); };
    const rec = { t: Date.now(), acct: name, practice, sold: 0, skins: 0, spent: 0, opened: 0, tokens: 0, tries: 0, dlores: 0, result: '' };
    let startMe = null;
    try {
        startMe = await getJson(aid, '/api/me');
        remember(aid, startMe);
        await refreshCatalog(aid);

        // 1. clicked weapon cases -> cash
        if (S('sellCases')) {
            lane.phase = 'selling cases';
            const prices = Object.fromEntries(catalog.cases.map(c => [c._id, num(c.price)]));
            const owned = (await getJson(aid, '/api/cases')) || [];
            const sell = owned.filter(c => c && prices[c._id] && num(c.amount) > 0 && c._id !== S('capsule'));
            const value = sell.reduce((t, c) => t + num(c.amount) * prices[c._id], 0);
            if (sell.length && value >= num(S('sellCasesMin'))) {
                if (practice) { rec.wouldSell = value * 0.7; log(`would sell ${sell.length} kind(s) of cases worth ${money(value)} (≈ ${money(value * 0.7)} cash)`); }
                else {
                    const before = num((await getJson(aid, '/api/me')).money);
                    for (const c of sell) {
                        if (halted()) throw new Stop(ctx.stopping ? 'turned off' : 'stopped by you');
                        const r = await req(aid, '/api/cases', { method: 'DELETE', body: { id: c._id, type: 'case', amount: num(c.amount) } });
                        if (r.kind !== 'ok') log(`couldn't sell one kind of case (HTTP ${r.status}) — kept`, 'warn');
                    }
                    rec.sold = Math.max(0, num((await getJson(aid, '/api/me')).money) - before);
                    log(`sold cases worth ${money(value)} → +${money(rec.sold)} cash`, 'ok');
                }
            }
        }

        // 2. skins up to a price -> tokens
        if (S('sellSkins')) {
            lane.phase = 'selling skins';
            const upTo = Math.min(num(S('sellSkinsMax')), DLORE_SKIN.price - 1);   // never the Dragon Lores
            if (practice) log(`would sell every unfavourited skin up to ${money(upTo)} for tokens`);
            else {
                const before = num((await getJson(aid, '/api/me')).tokens);
                const r = await req(aid, '/api/inventory', { method: 'DELETE', body: { type: 'price', value: upTo, currency: 'tokens' } });
                if (r.kind !== 'ok') log(`selling skins failed (HTTP ${r.status})`, 'warn');
                rec.skins = Math.max(0, num((await getJson(aid, '/api/me')).tokens) - before);
                if (rec.skins) log(`sold skins → +${count(rec.skins)} tokens`, 'ok');
            }
        }

        const cap = catalog.capsules.find(c => c._id === S('capsule'));
        if ((S('buy') || S('open')) && !cap && !dloreOn(aid)) throw new Stop(S('capsule') ? 'the chosen capsule is no longer in the shop' : 'no capsule chosen yet (Settings)');
        let me = await getJson(aid, '/api/me');
        const perCall = Math.max(1, parseInt(me.caseOpenCount) || 1), mult = Math.max(1, parseInt(me.maxCaseOpenMultiplier) || 1), perOpen = perCall * mult;
        lane.size = rec.size = `${perCall}×${mult}`;   // the account's open size: count × multiplier (boosts included)
        let stock = cap && (S('buy') || S('open')) ? await stockOf(aid, cap._id) : 0;

        // 3. cash -> capsules (whole opens only)
        if (S('buy') && cap) {
            lane.phase = 'buying';
            const price = num(cap.price), cash = num(me.money);
            const budget = cash - Math.max(num(S('keepMoney')), cash * num(S('keepPct')) / 100) + (practice ? rec.wouldSell || 0 : 0);
            let buy = Math.floor((stock + Math.floor(Math.max(0, budget) / price)) / perOpen) * perOpen - stock;
            if (cap.isNonBuyable) log(`not buying: the shop doesn't sell ${cap.name} — opening only what's there`, 'warn');
            else if (paused) log(`not buying: ${paused}`, 'warn');
            else if (num(S('maxPrice')) > 0 && price > num(S('maxPrice'))) log(`not buying: ${cap.name} costs $${price}, over your limit of $${num(S('maxPrice'))}`, 'warn');
            else if (buy > 0 && buy * price >= num(S('minSpend'))) {
                if (practice) log(`would buy ${count(buy)} ${cap.name} for ${money(buy * price)}`);
                else {
                    const pre = num((await getJson(aid, '/api/me')).money);
                    const br = await req(aid, '/api/cases', { method: 'POST', body: { id: cap._id, type: cap.type || 'capsule', amount: buy } });
                    me = await getJson(aid, '/api/me');
                    const spent = Math.max(0, pre - num(me.money));
                    stock = await stockOf(aid, cap._id);
                    rec.spent = spent;
                    if (br.kind !== 'ok' && !spent) { catalog.at = 0; throw new Stop(`buying failed (HTTP ${br.status}), nothing was charged`); }
                    // Charged more than the shop said: the price moved. Stop buying everywhere until it's looked at.
                    if (spent / buy > price * 1.02) { paused = `charged $${(spent / buy).toFixed(2)} each instead of $${price} — check the price, then change the capsule or its max price`; log('buying stopped: ' + paused, 'error'); }
                    log(`bought ${count(buy)} ${cap.name} for ${money(spent)}`, 'ok');
                }
                if (practice) stock += buy;
            }
        }

        // 4. capsules -> tokens
        if (S('open') && cap && stock >= perOpen) {
            lane.phase = 'opening';
            if (!practice && ctx.accounts.setBusy) ctx.accounts.setBusy(aid, 'opening cases');   // other plugins wait
            lane.of = Math.floor(stock / perOpen) * perOpen;   // cases, like lane.opened
            const opens = (n) => `${count(n)} case${n === 1 ? '' : 's'} (${count(n / perOpen)} opens of ${perCall}×${mult})`;
            const pro = (me.membership || startMe.membership) === 'pro';
            const inv = pro ? null : { size: num(me.inventorySize), used: num(me.inventoryCount) };
            const room = () => Math.floor((Math.floor(inv.size * INV_FILL) - inv.used) / perOpen);
            if (practice) log(pro ? `would open ${opens(lane.of)} with every drop sold to tokens`
                : `would open ${opens(lane.of)} into the inventory (${count(inv.used)} of ${count(inv.size)} used), selling the drops for tokens every ${count(Math.max(1, Math.floor(inv.size * INV_FILL / perOpen)))} opens or so`);
            else {
                if (pro) await ensureAutosell(aid, log);
                else if (!inv.size) throw new Stop('the site did not say how big the inventory is — not opening');
                const body = { id: cap._id, quickOpen: true, count: String(perCall), useEventTickets: false, caseOpenMultiplier: mult, autoOpen: pro };
                // Non-Pro: sell the drops for tokens, then read how full the inventory is again.
                const sellDrops = async () => {
                    lane.phase = 'selling drops';
                    const r = await req(aid, '/api/inventory', { method: 'DELETE', body: { type: 'price', value: dropMax(), currency: 'tokens' } });
                    if (r.kind !== 'ok') log(`selling the drops failed (HTTP ${r.status})`, 'warn');
                    const m = await settled(aid, inv.used);
                    inv.used = num(m.inventoryCount); inv.size = num(m.inventorySize) || inv.size;
                    rec.sells = (rec.sells || 0) + 1;
                    lane.phase = 'opening';
                };
                let fails = 0, full = 0, done = 0, left = pro ? Infinity : room();
                while (stock >= perOpen) {
                    if (halted()) throw new Stop(ctx.stopping ? 'turned off' : 'stopped by you');
                    if (left <= 0) {
                        await sellDrops();
                        left = room();
                        if (left <= 0) throw new Stop(`the inventory is still ${Math.round(inv.used / inv.size * 100)}% full after selling the drops up to ${money(dropMax())} — make room, then run again`);
                    }
                    const r = await ctx.request(aid, '/api/open/' + (cap.type || 'capsule'), { method: 'POST', body });
                    if (r.kind === 'ok') {
                        stock -= perOpen; lane.opened += perOpen; rec.opened += perOpen; done++; fails = 0; full = 0;
                        if (!pro) { inv.used += perOpen; left--; }
                        if (done % 25 === 0) {
                            stock = await stockOf(aid, cap._id); save();
                            if (!pro) { const m = await getJson(aid, '/api/me'); inv.used = num(m.inventoryCount); left = room(); }   // drops can count more than the math says
                        }
                    } else {
                        if (r.kind === 'not-running' || r.kind === 'auth' || r.kind === 'cf') throw new Stop(r.kind === 'not-running' ? 'the account stopped clicking' : r.kind);
                        const msg = String((r.json && (r.json.error || r.json.message)) || '');
                        if (!pro && INV_FULL.test(msg)) {   // full after all: sell now, but not forever
                            if (++full > FULL_RETRIES) throw new Stop(`the site keeps refusing opens after selling the drops: ${msg}`);
                            left = 0; continue;
                        }
                        if (++fails >= MAX_OPEN_FAILS) throw new Stop(`opening failed ${fails}× in a row (HTTP ${r.status})`);
                        await ctx.sleep(r.kind === 'rate' ? 30000 : 2000 * fails);
                        stock = await stockOf(aid, cap._id);
                    }
                    await ctx.sleep(OPEN_GAP_MS);
                }
                if (!pro && lane.opened) await sellDrops();
                log(`opened ${opens(lane.opened)}${rec.sells ? ` · sold the drops ${rec.sells}×` : ''}`, 'ok');
            }
        }

        // 5. tokens -> Dragon Lores
        if (dloreOn(aid)) await dlore(aid, lane, rec, practice, log);
        rec.result = practice ? (plan.length ? 'practice' : 'practice — nothing to do') : 'done';
        if (practice) { state.practiceAt = Date.now(); state.plans = { ...(state.plans || {}), [aid]: { t: Date.now(), name, lines: plan.length ? plan : ['nothing to do right now'] } }; }
    } catch (e) {
        rec.result = e instanceof Stop ? e.message : 'error: ' + e.message;
        if (!(e instanceof Stop)) ctx.log('stopped: ' + e.message, 'error', aid);
        else if (!ctx.stopping) log('stopped: ' + e.message, 'warn');
        if (halt && lanes.size <= 1) halt = false;
    } finally {
        if (!practice && startMe) {
            try { const end = await ctx.request(aid, '/api/me'); if (end.kind === 'ok') rec.tokens = Math.max(0, num(end.json.tokens) - num(startMe.tokens)); } catch (_) {}
        }
        const t = today();
        for (const k of ['sold', 'skins', 'spent', 'opened', 'tokens', 'tries', 'dlores']) t[k] = (t[k] || 0) + (rec[k] || 0);
        state.last[aid] = Date.now();
        state.runs = [rec, ...(state.runs || [])].slice(0, 30);
        lanes.delete(aid);
        if (ctx.accounts.setBusy) ctx.accounts.setBusy(aid, null);
        save();
    }
}

// 5M tokens a try until the account has less or the day's upgrades are used up. The Dragon Lores won are counted on
// their own; the tokens spent come off the run's token gain.
async function dlore(aid, lane, rec, practice, log) {
    lane.phase = 'upgrading';
    const lim = await getJson(aid, '/api/gameLimitations');
    let left = num(lim.upgradeHostLeft), tokens = num((await getJson(aid, '/api/me')).tokens);
    const n = Math.min(left, Math.floor(tokens / DLORE_STAKE));
    if (n <= 0) { if (left <= 0) log('no upgrades left today for Dragon Lores'); return; }
    if (practice) { log(`would upgrade ${count(n)}× ${count(DLORE_STAKE)} tokens into Dragon Lores (70% each, ≈ ${count(n * 0.7)})`); return; }
    if (ctx.accounts.setBusy) ctx.accounts.setBusy(aid, 'upgrading into Dragon Lores');   // other plugins wait
    lane.of = n; lane.opened = 0; lane.unit = 'tries'; lane.size = null;
    let slow = 0;
    while (left > 0 && tokens >= DLORE_STAKE) {
        if (halted()) throw new Stop(ctx.stopping ? 'turned off' : 'stopped by you');
        const r = await ctx.request(aid, '/api/casino/upgrade', { method: 'POST', body: { userSkinReq: null, userTokensReq: DLORE_STAKE, upgradeSkinReq: DLORE_SKIN } });
        if (r.kind === 'ok') {
            left--; tokens -= DLORE_STAKE; rec.tries++; lane.opened++;
            if (r.json && r.json.result === true) rec.dlores++;
            if (rec.tries % 20 === 0) { tokens = num((await getJson(aid, '/api/me')).tokens); save(); }
        } else {
            if (r.kind === 'not-running' || r.kind === 'auth' || r.kind === 'cf') throw new Stop(r.kind === 'not-running' ? 'the account stopped clicking' : r.kind);
            const msg = String((r.json && (r.json.error || r.json.message)) || 'HTTP ' + r.status);
            if (/locked|another action|wait a moment/i.test(msg)) { await ctx.sleep(3000); continue; }
            if (r.status === 429 && ++slow <= 5) { await ctx.sleep(30000); continue; }   // too many requests: back off
            if (!/limit|daily|exceeded|fund|enough|token/i.test(msg)) log('upgrade stopped: ' + msg, 'warn');
            break;
        }
        await ctx.sleep(Math.max(0, num(S('dloreGapMs'))));
    }
    if (rec.tries) log(`upgraded ${count(rec.tries)}× → ${count(rec.dlores)} Dragon Lore${rec.dlores === 1 ? '' : 's'}`, 'ok');
}

// On the schedule only when on and live; the Run button (asked) runs now, or shows a practice run.
function tick(asked) {
    if (!asked && !ctx.power.live()) return;
    const every = num(S('everyMs')) || Math.max(5, num(S('everyMin'))) * 60000;
    const max = Math.max(1, Math.min(5, num(S('lanes')) || 1));
    for (const a of ctx.accounts.list()) {
        if (lanes.size >= max) break;
        if (!a.healthy || lanes.has(a.id) || !ctx.settings.runsOn('accounts', a.id)) continue;
        if (ctx.accounts.busy && ctx.accounts.busy(a.id)) continue;   // another plugin's turn (games): next tick
        if (Date.now() - (state.last[a.id] || 0) < every) continue;
        run(a.id, a.name);
    }
}

module.exports = {
    start(c) {
        ctx = c;
        state = { last: {}, runs: [], ...ctx.data.get() };
        today();
        ctx.settings.onChange((k) => { if (k === 'capsule' || k === 'maxPrice') paused = null; });
        // Fill the capsule list as soon as any account is clicking, so it can be chosen before the first run.
        const fill = async () => { if (catalog.capsules) return; const a = ctx.accounts.list().find(x => x.healthy); if (a) { try { await refreshCatalog(a.id); } catch (_) {} } };
        fill();
        // Which accounts upgrade into Dragon Lores, for the Armory: Pro or not is read once per account.
        const members = async () => {
            if (!S('dlore')) return;
            for (const a of ctx.accounts.list()) {
                if (!a.healthy || lanes.has(a.id) || Date.now() - (memberAt.get(a.id) || 0) < MEMBER_MS || !ctx.settings.runsOn('accounts', a.id)) continue;
                try { const r = await ctx.request(a.id, '/api/me'); if (r.kind === 'ok') remember(a.id, r.json); } catch (_) {}
            }
            publish();
        };
        publish(); members();
        ctx.every(15000, () => { fill(); members(); publish(); tick(); });
        ctx.settings.onChange((k) => { if (k === 'dlore' || k === 'dloreWho' || k === 'accounts') { publish(); members(); } });
        ctx.panel.action('run', () => {
            const chosen = ctx.accounts.list().filter(a => ctx.settings.runsOn('accounts', a.id));
            if (!chosen.length) return { ok: false, error: 'Choose accounts first.' };
            halt = false;
            for (const a of chosen) state.last[a.id] = 0;
            tick(true);
            return { message: ctx.power.practice() ? 'Practice run started — the plan shows up here in a moment.' : 'Converting now.' };
        });
        ctx.panel.action('stop', () => { if (!lanes.size) return { message: 'Nothing is converting.' }; halt = true; return { message: 'Stopping after the current step.' }; });
        ctx.settings.onChange((k, v) => { if (k === 'on' && !v) halt = lanes.size > 0; });
        ctx.panel.tab('Converter', () => {
            const t = today(), practice = ctx.power.practice(), live = ctx.power.live();
            const chosen = ctx.accounts.list().filter(a => ctx.settings.runsOn('accounts', a.id));
            const n = chosen.length;
            const cap = catalog.capsules && catalog.capsules.find(c => c._id === S('capsule'));
            const every = Math.max(5, num(S('everyMin')));
            const plans = practice ? Object.values(state.plans || {}).filter(x => chosen.some(a => a.name === x.name)).sort((a, b) => b.t - a.t) : [];
            const steps = [S('sellCases') && 'sell cases', S('sellSkins') && 'sell skins', S('buy') && (cap ? `buy ${cap.name}` : 'buy capsules'), S('open') && 'open to tokens', S('dlore') && 'Dragon Lores'].filter(Boolean);
            const dl = chosen.filter(a => dloreOn(a.id)).length;
            const step = (id, toggle, title, summary, keys) => ({ type: 'card', id, toggle, open: false, title, summary, keys });
            return { blocks: [
                { type: 'card', id: 'power', toggle: 'on', toggleDisabled: practice ? 'Set the mode to Live first' : null, bodyWhenOff: true, open: !live,
                    title: live ? (lanes.size ? `Converter — on, converting ${lanes.size}` : 'Converter — on') : 'Converter — off',
                    summary: !n ? 'choose accounts first' : !steps.length ? 'switch on a step' : practice ? 'practice: nothing changes unless you press Practice run' : `live on ${n} account${n === 1 ? '' : 's'}, every ${every} min`,
                    keys: ['runMode'], blocks: n ? [{ type: 'buttons', items: [{ label: practice ? 'Practice run' : 'Run now', action: 'run', primary: true }, ...(lanes.size ? [{ label: 'Stop', action: 'stop', danger: true }] : [])] }] : [] },
                ...(paused ? [{ type: 'notice', level: 'bad', text: 'Buying is stopped: ' + paused }] : []),
                ...(plans.length ? [{ type: 'table', wrap: true, columns: ['Account', 'The last practice run would', 'When'], rows: plans.slice(0, 10).map(x => [x.name, x.lines.join(' · '), new Date(x.t).toLocaleTimeString()]) }] : []),
                ...(t.sold || t.spent || t.opened || t.tries ? [{ type: 'stats', items: [
                    { label: 'Cases sold today', value: money(t.sold) },
                    { label: 'Spent on capsules', value: money(t.spent) },
                    { label: 'Cases opened today', value: count(t.opened) },
                    { label: 'Tokens today', value: count(t.tokens + t.skins) },
                    ...(t.tries ? [{ label: 'Dragon Lores today', value: `${count(t.dlores || 0)} of ${count(t.tries)} tries` }] : []),
                ] }] : []),
                ...(lanes.size ? [{ type: 'table', columns: ['Converting now', 'Step', 'Open size', 'Opened'], rows: [...lanes].map(([id, l]) => [(ctx.accounts.get(id) || {}).name || id, l.phase, l.size || '—', (l.of ? `${count(l.opened)} / ${count(l.of)}` : count(l.opened)) + (l.unit === 'tries' ? ' tries' : ' cases')]) }] : []),
                { type: 'card', id: 'accounts', open: !n, title: 'Accounts', summary: n ? `${n} account${n === 1 ? '' : 's'}` : 'none yet', keys: ['accounts'], bare: true },
                { type: 'section', title: 'A run, in order', blocks: [
                    step('s-cases', 'sellCases', 'Sell clicked cases', `for cash, when worth ≥ ${money(num(S('sellCasesMin')))}`, ['sellCasesMin']),
                    step('s-skins', 'sellSkins', 'Sell skins', `up to ${money(num(S('sellSkinsMax')))}, for tokens · favourites stay`, ['sellSkinsMax']),
                    step('s-buy', 'buy', 'Buy capsules', cap ? `${cap.name} · $${num(cap.price).toLocaleString('en-US')} each` : 'pick a capsule', ['capsule', 'maxPrice', 'keepMoney', 'keepPct', 'minSpend']),
                    step('s-open', 'open', 'Open them', `every drop sold to tokens · non-Pro: into the inventory, sold up to ${money(dropMax())} at 90% full`, ['dropSellMax']),
                    step('s-dlore', 'dlore', 'Upgrade into Dragon Lores', `5M tokens a try, 70% · ${WHO[S('dloreWho')] || WHO.basic}${S('dlore') && n ? ` (${dl} of ${n})` : ''} · no Armory upgrades on these`, ['dloreWho']),
                ] },
                { type: 'card', id: 'schedule', open: false, title: 'Schedule', summary: `every ${every} min · ${Math.max(1, num(S('lanes')))} at a time`, keys: ['everyMin', 'lanes'] },
                { type: 'section', title: 'Recent runs', blocks: [{ type: 'table', empty: 'No runs yet.', columns: ['When', 'Account', 'Cases sold', 'Spent', 'Open size', 'Opened', 'Tokens', 'Dragon Lores', 'Result'],
                    rows: (state.runs || []).slice(0, 10).map(r => [new Date(r.t).toLocaleTimeString(), r.acct, money(r.sold), money(r.spent), r.size || '—', r.size ? count(r.opened) : `${count(r.opened)} opens`, count(r.tokens), r.tries ? `${count(r.dlores)} / ${count(r.tries)}` : '—', r.result]) }] },
            ] };
        });
        ctx.panel.badge((aid) => { const l = lanes.get(aid); return l ? 'Converting: ' + l.phase : null; });
    },
    stop() { lanes.clear(); },
};
