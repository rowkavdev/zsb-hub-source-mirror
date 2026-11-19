/**
 * TRADER
 *
 * Trade routes: from accounts -> one receiving account, with rules for what goes. Every check
 * (and when a route is saved), each sender with something to send makes ONE trade per route:
 *
 *   POST /api/trading (sender)                    -> { _id } = tradeId
 *   both sockets: watchTrade(tradeId)            -> tradeInfo
 *   sender: tradeAddSkins { userId, skinIds, tradeId }      (up to /api/me tradeItems per trade)
 *   sender: tradeAddTokens { userId, tokens, tradeId }     -> tradeTokensAdded   (Pro senders only)
 *   sender tradeAccept -> receiver tradeAccept -> sender tradeConfirm -> tradeConfirmed
 *   anything wrong: sender tradeDelete — nothing moves until the confirm.
 * Afterwards the sender is read back to check the items/tokens really left.
 *
 * Both accounts must be in this app and clicking (the receiver has to accept on its own socket).
 * Receivers keep `dailyCap` of the site's 100 received trades a day (/api/me dailyTradesLeft).
 * One trade at a time per sender; a receiver takes them one after another.
 *
 * Open trades (for a trade left stuck or unconfirmed): GET /api/trading on each account lists the running trades it is
 * in (activeUserTrades: host, guest, who accepted); watchTrade from an account IN the trade gives its contents
 * (tradeInfo: offeredSkins, hostTokens, guestTokens). A trade between two hub accounts can be finished (each side that
 * hasn't accepted accepts, the host confirms); one hosted by a hub account can be deleted (only the host can).
 */

const PAGES_MAX = 60;
const WAIT_RETRY_MS = 60000;   // a pair skipped because another plugin had an account busy is tried again after this

let ctx = null;
let state = null;            // saved: { history: [...], today: { day, trades, tokens, items } }
const busy = new Set();      // accounts in a trade right now
// Routes come first (a tester, 2026-11-14): a pair another plugin has tied up asks that plugin for the accounts
// (ctx.accounts.want) and checks again every WANT_RETRY_MS; the Armory hands them over once what it has going ends.
const WANT_RETRY_MS = 5000;
// Single trades and Send to many ask for every account in them the same way (a tester 2026-11-15: 21 Dragon Lore
// senders all "waiting — star farming") and go right away.
const LOCKED = /locked|another action|wait a moment/i;   // the site's ways of saying the account is busy this moment
const LOCK_RETRY_MS = 2000, LOCK_MAX_MS = 60000;
const oneWants = new Set();   // accounts a single trade / Send to many asked for (the route check leaves these alone)
function askFor(ids, why) {
    if (!ctx.accounts.want) return;
    for (const id of ids) { ctx.accounts.want(id, why); oneWants.add(id); }
}
function giveBack(ids) {
    for (const id of ids) { oneWants.delete(id); if (ctx.accounts.want && !wanting.has(id)) ctx.accounts.want(id, null); }
}
const wanting = new Map();   // account id -> what it's wanted for
const said = new Set();      // pairs whose wait was logged (said once until the trade happens)
let running = false, lastRun = 0, rerun = false, routeHalt = false;   // routeHalt: Stop pressed on a route run

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const count = (n) => Math.round(n).toLocaleString('en-US');
const day = () => new Date().toISOString().slice(0, 10);
const S = (k) => ctx.settings.get(k);
const sleep = (ms) => ctx.sleep(ms);

function today() {
    if (!state.today || state.today.day !== day()) state.today = { day: day(), trades: 0, tokens: 0, items: 0 };
    return state.today;
}

async function getJson(aid, path) {
    const r = await ctx.request(aid, path);
    if (r.kind !== 'ok') throw new Error(r.kind === 'not-running' ? 'account not clicking' : `HTTP ${r.status} on ${path.split('?')[0]}`);
    return r.json;
}

const uidCache = new Map();
async function userId(aid) {
    if (!uidCache.has(aid)) { const p = await getJson(aid, '/api/user/profile'); if (!p || !p.userId) throw new Error('no user id'); uidCache.set(aid, p.userId); }
    return uidCache.get(aid);
}

const favorite = (s) => !!(s.favorite || s.isFavorite || s.favorited || s.isFavourite);
const isTerminal = (s) => !!s.isTerminal || /terminal/i.test(s.name || '');
const terminalKind = (s) => (/genesis/i.test(s.name || '') ? 'genesis' : /dead hand/i.test(s.name || '') ? 'deadhand' : 'other');

// What a route takes from this sender's inventory, most valuable first.
async function pickItems(aid, route) {
    const names = String(route.names || '').split(',').map(x => x.trim()).filter(Boolean);
    const wantSkins = !!route.skins && (num(route.skinsOver) > 0 || names.length > 0);
    if (route.terminals === 'none' && !wantSkins) return [];
    const take = (s) => {
        if (!s || !s._id || (route.skipFavorites && favorite(s))) return false;
        if (isTerminal(s)) return route.terminals === 'all' || route.terminals === terminalKind(s);
        if (!wantSkins) return false;
        if (num(route.skinsOver) > 0 && num(s.price) >= num(route.skinsOver)) return true;
        return names.some(n => String(s.name || '').toLowerCase().includes(n.toLowerCase()));
    };
    // Searches keep it short when only names / terminals are wanted; a price rule reads every page.
    const searches = wantSkins && num(route.skinsOver) > 0 ? [''] : [...(wantSkins ? names : []), ...(route.terminals !== 'none' ? ['Terminal'] : [])];
    const seen = new Map();
    for (const q of searches) {
        for (let page = 1, pages = 1; page <= pages && page <= PAGES_MAX; page++) {
            if (ctx.stopping) return [];
            const j = await getJson(aid, `/api/inventory?page=${page}${q ? '&search=' + encodeURIComponent(q) : ''}&showUpgradedSkins=true&favoriteSkinsFilter=showFavorites&showStickers=true`);
            pages = (j && j.pages) || 0;
            for (const s of (j && j.skins) || []) if (take(s)) seen.set(s._id, s);
            await sleep(250);
        }
    }
    return [...seen.values()].sort((a, b) => num(b.price) - num(a.price));
}

async function trade(from, to, route, fromName, toName) {
    const log = (msg, level = 'info') => ctx.log(`${fromName} → ${toName}: ${msg}`, level, from);
    const practice = ctx.power.practice();
    const [sMe, rMe] = await Promise.all([getJson(from, '/api/me'), getJson(to, '/api/me')]);
    const left = rMe.dailyTradesLeft == null ? 100 : num(rMe.dailyTradesLeft);
    const plan = (what) => { if (ctx.power.practice()) state.plans = { ...(state.plans || {}), [from + '>' + to]: { t: Date.now(), from: fromName, to: toName, what } }; };
    if (left <= num(S('dailyCap'))) { plan(`skip — ${toName} has ${left} trades left today`); log(`skipped — ${toName} has ${left} received trades left today`); return false; }

    const pro = sMe.membership === 'pro';
    const cap = num(sMe.tradeItems) || (pro ? 200 : 50);
    const items = (await pickItems(from, route)).slice(0, cap);
    let tokens = 0;
    if (route.tokens && pro) {
        const spare = num(sMe.tokens) - num(route.keepTokens);
        if (spare >= Math.max(1, num(route.minTokens))) tokens = Math.floor(spare);
    }
    const sending = items.length >= Math.max(1, num(route.minItems)) ? items : [];
    if (!sending.length && !tokens) { plan(items.length ? `wait — only ${items.length} item(s), route needs ${num(route.minItems)}` : 'nothing to send right now'); return false; }
    const what = [sending.length ? `${sending.length} item(s)` : '', tokens ? `${count(tokens)} tokens` : ''].filter(Boolean).join(' + ');
    if (practice) { plan('send ' + what + (route.tokens && !pro ? ' (no tokens: not Pro)' : '')); log(`practice — would send ${what}`); return false; }
    return (await execute(from, to, sending, tokens, sMe, fromName, toName)).ok;
}

// The trade itself: create it, both sides join, add the items and tokens, accept, confirm, and read the sender back.
async function execute(from, to, sending, tokens, sMe, fromName, toName) {
    const log = (msg, level = 'info') => ctx.log(`${fromName} → ${toName}: ${msg}`, level, from);
    const what = [sending.length ? `${sending.length} item(s)` : '', tokens ? `${count(tokens)} tokens` : ''].filter(Boolean).join(' + ');
    const rec = { t: Date.now(), from: fromName, to: toName, items: sending.length, tokens, ok: false, why: '' };
    busy.add(from); busy.add(to);
    let tradeId = null, sSock = null, rSock = null, sUid = null;
    try {
        const rUid = await userId(to); sUid = await userId(from);
        const cr = await ctx.request(from, '/api/trading', { method: 'POST' });
        tradeId = cr.kind === 'ok' && cr.json && cr.json._id;
        if (!tradeId) throw new Error(`couldn't create the trade (${(cr.json && (cr.json.error || cr.json.message)) || 'HTTP ' + cr.status})`);
        [sSock, rSock] = await Promise.all([ctx.socket(from), ctx.socket(to)]);
        sSock.emit('watchTrade', tradeId);
        if (!await sSock.wait(['tradeInfo'], 8000)) throw new Error('sender could not open the trade');
        rSock.emit('watchTrade', tradeId);
        const w = await rSock.wait(['tradeInfo', 'tradeWatchError'], 8000);
        if (!w || w.ev !== 'tradeInfo') throw new Error('receiver could not join the trade');
        if (sending.length) {
            sSock.emit('tradeAddSkins', { userId: sUid, skinIds: sending.map(s => s._id), tradeId });
            const r = await sSock.wait(['tradeSkinsCapped', 'tradeError'], 2500);
            if (r && r.ev === 'tradeError') throw new Error('adding items: ' + JSON.stringify(r.data).slice(0, 120));
        }
        if (tokens) {
            sSock.emit('tradeAddTokens', { userId: sUid, tokens, tradeId });
            const r = await sSock.wait(['tradeTokensAdded', 'tradeError'], 6000);
            if (!r || r.ev === 'tradeError') throw new Error('adding tokens: ' + (r ? JSON.stringify(r.data).slice(0, 120) : 'no answer'));
        }
        await sleep(1000);
        sSock.emit('tradeAccept', { userId: sUid, tradeId }); await sleep(1500);
        rSock.emit('tradeAccept', { userId: rUid, tradeId }); await sleep(800);
        sSock.emit('tradeConfirm', { userId: sUid, tradeId });
        const done = await sSock.wait(['tradeConfirmed', 'tradeError', 'tradeDeleted'], 12000);
        if (!done || done.ev !== 'tradeConfirmed') throw new Error('not confirmed: ' + (done ? done.ev : 'no answer'));
        tradeId = null;   // finished: nothing to cancel
        // Check on the sender that it really left.
        await sleep(1500);
        const after = await getJson(from, '/api/me');
        if (tokens && num(sMe.tokens) - num(after.tokens) < tokens * 0.99) throw new Error(`confirmed, but the sender's tokens only went ${count(sMe.tokens)} → ${count(after.tokens)}`);
        rec.ok = true;
        const t = today(); t.trades++; t.items += sending.length; t.tokens += tokens;
        log(`sent ${what}`, 'ok');
    } catch (e) {
        rec.why = e.message;
        log('trade failed: ' + e.message, 'warn');
        if (tradeId && sSock && sUid) { try { sSock.emit('tradeDelete', { userId: sUid, tradeId }); await sleep(500); } catch (_) {} }
    } finally {
        if (sSock) sSock.close();
        if (rSock) rSock.close();
        busy.delete(from); busy.delete(to);
        state.history = [rec, ...(state.history || [])].slice(0, 50);
        ctx.data.set(state);
    }
    return rec;
}

// --- Single trade --------------------------------------------------------
// One trade by hand: from one account to another, items by name (how many of each) and/or a number of tokens. "Look up"
// counts those items on every account so the sender list shows who has them.
let lookup = null;   // { terms, key, at, running, done, total, counts: { aid: { n, favs, value, favValue } | { skipped } | { error } } }
let one = null;      // the last single trade: { t, running, ok, text }

// The item names typed in the single trade (an older single name is a plain string).
const oneTerms = () => { const v = S('oneItem'); return (Array.isArray(v) ? v : v ? [v] : []).map(x => String(x).trim()).filter(Boolean); };
const termsKey = (terms) => terms.map(t => t.toLowerCase()).sort().join('|');
const termsLabel = (terms) => terms.join(' / ');

// The sender's items whose name has `term` in it, most valuable first: the others, and the favourited ones apart.
async function findItems(aid, term) {
    const items = [], favItems = [];
    const q = term.toLowerCase();
    for (let page = 1, pages = 1; page <= pages && page <= PAGES_MAX; page++) {
        if (ctx.stopping) break;
        const j = await getJson(aid, `/api/inventory?page=${page}&search=${encodeURIComponent(term)}&showUpgradedSkins=true&favoriteSkinsFilter=showFavorites&showStickers=true`);
        pages = (j && j.pages) || 0;
        for (const s of (j && j.skins) || []) {
            if (!s || !s._id || !String(s.name || '').toLowerCase().includes(q)) continue;
            (favorite(s) ? favItems : items).push(s);
        }
        await sleep(250);
    }
    const dear = (a, b) => num(b.price) - num(a.price);
    return { items: items.sort(dear), favItems: favItems.sort(dear) };
}

// Every name's items, each item once (one can match two names): [{ term, items, favItems }].
async function findAll(aid, terms) {
    const seen = new Set(), out = [];
    for (const term of terms) {
        if (ctx.stopping) break;
        const f = await findItems(aid, term), fresh = (x) => !seen.has(x._id) && seen.add(x._id);
        out.push({ term, items: f.items.filter(fresh), favItems: f.favItems.filter(fresh) });
    }
    return out;
}

// How many of the items an account has, with its tokens and Pro read fresh (the hub's own report can be minutes old).
async function countOn(aid, terms) {
    const [f, m] = await Promise.all([findAll(aid, terms), getJson(aid, '/api/me')]);
    const all = f.flatMap(x => x.items), favs = f.flatMap(x => x.favItems), sum = (l) => l.reduce((s, x) => s + num(x.price), 0);
    // Each item by its own name ("Terminal" finds Genesis and Dead Hand ones): { name, n, favs, value, favValue }.
    const byName = new Map(), group = (x) => { const k = String(x.name || 'Item'); if (!byName.has(k)) byName.set(k, { name: k, n: 0, favs: 0, value: 0, favValue: 0 }); return byName.get(k); };
    for (const x of all) { const g = group(x); g.n++; g.value += num(x.price); }
    for (const x of favs) { const g = group(x); g.favs++; g.favValue += num(x.price); }
    const names = [...byName.values()].sort((a, b) => (b.value + b.favValue) - (a.value + a.favValue) || (b.n + b.favs) - (a.n + a.favs));
    return { n: all.length, favs: favs.length, value: sum(all), favValue: sum(favs), names, tokens: m && m.tokens, membership: m && m.membership };
}

async function lookUp(terms) {
    const accts = ctx.accounts.list();
    const me = lookup = { terms, key: termsKey(terms), at: Date.now(), running: true, done: 0, total: accts.length, counts: {} };
    for (const a of accts) {
        if (ctx.stopping || lookup !== me) return;   // stopped, or a newer look-up took over
        if (!a.healthy) me.counts[a.id] = { skipped: true };
        else {
            try { me.counts[a.id] = await countOn(a.id, terms); }
            catch (e) { me.counts[a.id] = { error: e.message }; }
        }
        me.done++;
    }
    me.running = false; me.at = Date.now();
}

// Amounts typed in the single trade: "" = none (tokens) / all (items), "all", 1500, 500K, 2.5M, 1B.
function amount(v, emptyIsAll) {
    const t = String(v ?? '').trim().toLowerCase().replace(/[, _]/g, '');
    if (!t || t === '0') return emptyIsAll ? 'all' : 0;
    if (t === 'all' || t === 'max') return 'all';
    const m = /^(\d+(?:\.\d+)?)([kmb]?)$/.exec(t);
    if (!m) return NaN;
    return Math.floor(Number(m[1]) * ({ '': 1, k: 1e3, m: 1e6, b: 1e9 })[m[2]]);
}

// --- Pick from the inventory --------------------------------------------
// "View inventory" opens a sender's inventory like the game shows it (dearest first, with a search); the items clicked
// there go in its single trade, on top of anything the item names find. Favourited ones are locked unless "Include
// favourited items" is on. Not saved: a restart forgets the picks.
let inv = null;   // { aid, open, items: [], page, pages, count, search, loading, error, sel: Map(id -> skin) }
const PICKED = '\u0000picked';
const tradeCap = (aid) => { if (inv && inv.aid === aid && inv.cap) return inv.cap; const me = ctx.accounts.stats(aid) || {}; return num(me.tradeItems) || (me.membership === 'pro' ? 200 : 50); };
const picksFor = (aid) => (inv && inv.aid === aid ? [...inv.sel.values()] : []);
// The game's inventory filters (same names and values as its own inventory page), as the query they make.
const INV_FILTERS = [['invExterior', 'exterior'], ['invRarity', 'rarity'], ['invFavs', 'favoriteSkinsFilter'], ['invStSv', 'statTrakSouvenir'],
    ['invQuality', 'quality'], ['invEvent', 'eventName'], ['invFloatRank', 'filterFloatRanks'], ['invPatterns', 'patterns']];
const INV_KEYS = ['invSearch', 'invSort', ...INV_FILTERS.map(x => x[0])];
const invQuery = () => {
    const q = [['sort', String(S('invSort') || 'price')], ['search', String(S('invSearch') || '').trim()], ...INV_FILTERS.map(([k, p]) => [p, String(S(k) || '')])];
    return q.filter(([, v]) => v).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('');
};
const invFiltered = () => !!String(S('invSearch') || '').trim() || INV_FILTERS.some(([k]) => S(k));
// The Event filter's choices are the site's own list (/api/events: Any, None, Only, then each event), fetched once.
const EVENTS_BASE = [{ value: '', label: 'Any' }, { value: 'None', label: 'None' }, { value: 'All', label: 'Only' }];
let eventsLoaded = false;
async function invEvents(aid) {
    if (eventsLoaded) return;
    eventsLoaded = true;
    try {
        const j = await getJson(aid, '/api/events');
        const list = (Array.isArray(j) ? j : []).map(x => (typeof x === 'string' ? { value: x, label: x } : x)).filter(x => x && typeof x.value === 'string');
        if (list.length) ctx.settings.setOptions('invEvent', list.some(x => x.value === '') ? list : [...EVENTS_BASE, ...list]);
    } catch { eventsLoaded = false; }
}
async function invLoad(more) {
    const me = inv;
    if (!me) return;
    if (me.loading) { if (!more) me.again = true; return; }   // a filter changed mid-load: load again once this one's in
    if (!more) { me.items = []; me.page = 0; me.pages = 1; me.count = 0; me.search = String(S('invSearch') || '').trim(); me.query = invQuery(); }
    if (me.page >= me.pages) return;
    me.loading = true; me.error = '';
    try {
        const page = me.page + 1;
        const j = await getJson(me.aid, `/api/inventory?page=${page}${me.query}&showStickers=true&showUpgradedSkins=true`);
        if (inv !== me) return;
        me.page = page; me.pages = num(j && j.pages); me.count = num(j && j.count);
        const seen = new Set(me.items.map(x => x._id));
        for (const s of (j && j.skins) || []) if (s && s._id && !seen.has(s._id)) { seen.add(s._id); me.items.push(s); }
        // Sorted by price, copies of a stack are side by side: a page that ends on a stackable item likely cuts that
        // stack, so the next page comes on its own (up to AUTO_PAGES pages, so a huge inventory isn't read whole).
        const last = me.items[me.items.length - 1];
        me.chain = me.query.includes('sort=price&') || me.query.endsWith('sort=price') ? !!(last && stackKey(last) && me.page < me.pages && me.page < AUTO_PAGES) : false;
    } catch (e) { me.error = e.message; me.chain = false; }
    finally {
        me.loading = false;
        if (inv !== me) return;
        if (me.again) { me.again = false; invLoad(false); }
        else if (me.chain) { me.chain = false; invLoad(true); }
    }
}
const AUTO_PAGES = 10;
// Load pages until want() holds, there are no more, or `max` more were read; waits out a load already running.
async function invLoadUntil(want, max) {
    const me = inv;
    for (let n = 0; me && inv === me && !want() && n < max; ) {
        if (me.loading) { await ctx.sleep(50); continue; }
        if (me.page >= me.pages) break;
        await invLoad(true); n++;
    }
}
// Can a stack have more copies on pages not loaded yet? Sorted by price only the last one can; otherwise any can.
const stackMayGrow = (g) => !!(inv && inv.page < inv.pages && (!/(^|&)sort=price(&|$)/.test(inv.query.slice(1)) || g.items.includes(inv.items[inv.items.length - 1])));
// The site's picture rule: "-…" is a Steam economy image, "/…" and https are as they are, else under /pictures/skins/.
function iconUrl(icon) {
    const s = String(icon || '');
    if (!s) return '';
    if (s.startsWith('-')) return 'https://steamcommunity-a.akamaihd.net/economy/image/' + s;
    if (/^https:\/\//.test(s)) return s;
    if (s.startsWith('/')) return 'https://case-clicker.com' + s;
    return 'https://case-clicker.com/pictures/skins/' + s;
}
const WEAR = { 'Factory New': 'FN', 'Minimal Wear': 'MW', 'Field-Tested': 'FT', 'Well-Worn': 'WW', 'Battle-Scarred': 'BS' };
// One item as a card: "★ Flip Knife | Slaughter (Minimal Wear)" → "★ Flip Knife" over "Slaughter", MW · float, price.
// Stacks, like the game: items with no float (stickers, terminals, cases…) of the same name, price and kind are one
// card ×N; picking takes N of them in list order.
const stackKey = (s) => (s.float == null && !s.hasPattern ? [s.name, num(s.price), favorite(s) ? 'f' : '', s.statTrak ? 'st' : '', s.souvenir ? 'sv' : ''].join('|') : '');
function invStacks() {
    const out = [], by = new Map();
    for (const s of (inv ? inv.items : [])) {
        const k = stackKey(s);
        if (k && by.has(k)) { by.get(k).items.push(s); continue; }
        const g = { s, items: [s] };
        if (k) by.set(k, g);
        out.push(g);
    }
    return out;
}
const stackOf = (id) => invStacks().find(g => g.items.some(x => x._id === id)) || null;
// Pick n of a stack (the first n), replacing what of it was picked.
const stackSet = (g, n) => { for (const x of g.items) inv.sel.delete(x._id); for (const x of g.items.slice(0, n)) inv.sel.set(x._id, x); };
function invCard(g, locked) {
    const s = g.s, picked = g.items.filter(x => inv.sel.has(x._id)).length;
    const more = stackMayGrow(g) && !!stackKey(s);
    return { ...invCard1(s, locked), on: picked > 0, ...(g.items.length > 1 || more ? { qty: { n: picked, of: g.items.length, more, action: 'invQty' } } : {}) };
}
function invCard1(s, locked) {
    const full = String(s.name || 'Item'), m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(full), base = m ? m[1] : full, ext = s.exterior || (m && WEAR[m[2]] ? m[2] : '');
    const [title, sub] = base.includes(' | ') ? [base.slice(0, base.indexOf(' | ')), base.slice(base.indexOf(' | ') + 3)] : ['', base];
    const fl = Number(s.float);
    return {
        id: s._id, title: title || s.type || '', sub, image: iconUrl(s.iconUrl || s.image), color: String(s.rarityColor || '').replace(/^#/, ''),
        price: '$' + num(s.price).toLocaleString('en-US', { maximumFractionDigits: 2 }),
        detail: [WEAR[ext] || '', Number.isFinite(fl) && s.float != null ? String(fl) : ''].filter(Boolean).join(' · '),
        tags: [s.statTrak ? 'ST' : '', s.souvenir ? 'SV' : ''].filter(Boolean), fav: favorite(s),
        on: !!(inv && inv.sel.has(s._id)), locked,
        hint: full + (locked ? ' — favourited: switch on "Include favourited items" to trade it' : ''),
    };
}

// The picked senders (an older single pick is a plain id), without the receiver.
function senderIds() {
    const v = S('oneFrom'), to = S('oneTo');
    const ids = v && Array.isArray(v.ids) ? v.ids : typeof v === 'string' && v ? [v] : [];
    const known = new Set(ctx.accounts.list().map(a => a.id));
    return [...new Set(ids)].filter(id => id !== to && known.has(id));
}

// Presets: what to send in one click, like the private dashboard's buttons. Each sender sends its own.
const PRESETS = [
    { id: 'tokens', title: 'Tokens', sub: 'all of them · Pro senders only', item: '', tokens: 'all' },
    { id: 'dlores', title: 'Dragon Lores', sub: 'all, or type how many', item: 'Dragon Lore', tokens: '' },
    { id: 'terminals', title: 'Terminals', sub: 'Genesis + Dead Hand', item: 'Terminal', tokens: '' },
    { id: 'genesis', title: 'Genesis', sub: 'Genesis terminals only', item: 'Genesis Terminal', tokens: '' },
    { id: 'deadhand', title: 'Dead Hand', sub: 'Dead Hand terminals only', item: 'Dead Hand Terminal', tokens: '' },
    { id: 'tokens_terminals', title: 'Tokens + terminals', sub: 'all of both', item: 'Terminal', tokens: 'all' },
    { id: 'custom', title: 'Custom', sub: 'type the item and amounts below' },
];
function presetNow() {
    const terms = oneTerms(), item = terms.length > 1 ? null : (terms[0] || '').toLowerCase(), tk = amount(S('oneTokens'), false);
    const p = PRESETS.find(x => x.id !== 'custom' && x.item.toLowerCase() === item && amount(x.tokens, false) === tk);
    return p ? p.id : 'custom';
}

// The sender list as the page shows it: everyone but the receiver, and after a look-up that found the item only the
// accounts that have it (plus any already picked). Most of the item first, then most tokens.
function oneView() {
    const accts = ctx.accounts.list(), to = S('oneTo'), terms = oneTerms(), picked = new Set(senderIds()), withFavs = !!S('oneFavs');
    const lk = lookup && terms.length && lookup.key === termsKey(terms) ? lookup : null;
    // How many it can send: favourited ones count only with the switch on.
    const has = (id) => { const c = lk && lk.counts[id]; return c && c.n != null ? c.n + (withFavs ? c.favs || 0 : 0) : -1; };
    // An account's tokens and Pro: from the look-up when it read them, else the hub's last report.
    const meOf = (id) => { const c = lk && lk.counts[id]; return c && c.tokens != null ? c : ctx.accounts.stats(id) || {}; };
    const senders = accts.filter(a => a.id !== to).sort((x, y) => (lk ? has(y.id) - has(x.id) : 0) || num(meOf(y.id).tokens) - num(meOf(x.id).tokens));
    const withIt = lk ? senders.filter(a => has(a.id) > 0) : [];
    const listed = withIt.length ? senders.filter(a => has(a.id) > 0 || picked.has(a.id)) : senders;
    return { lk, has, meOf, senders, withIt, listed, picked };
}
const oneListed = () => oneView().listed;

// What's wrong with the single trade as set up, or null.
function oneProblem() {
    const to = S('oneTo'), byId = new Map(ctx.accounts.list().map(a => [a.id, a])), ids = senderIds();
    const terms = oneTerms(), tokens = amount(S('oneTokens'), false), want = amount(S('oneCount'), true);
    if (!to || !byId.has(to)) return 'Pick who receives.';
    if (Number.isNaN(tokens)) return 'Tokens: type a number like 500K or 2.5M, or "all".';
    if (Number.isNaN(want)) return 'How many: type a number, or leave it empty for all.';
    if (!terms.length && !tokens && !ids.some(id => picksFor(id).length)) return 'Pick what to send: a preset, item names or tokens, or items from View inventory.';
    if (!ids.length) return 'Pick who sends: click one or more accounts in the list, or All.';
    if (!byId.get(to).healthy) return `${byId.get(to).name} isn't clicking — start it first.`;
    if (ids.length === 1 && !byId.get(ids[0]).healthy) return `${byId.get(ids[0]).name} isn't clicking — start it first.`;
    if (one && one.running) return 'A trade is going already.';
    return null;
}

// One sender's trade: works out what it sends, then sends it (in practice, only says what it would).
async function sendFrom(from, to, accts, terms, want, tokens, withFavs, prog, quit = () => false) {
    const fromName = accts.get(from).name, toName = accts.get(to).name;
    if (!accts.get(from).healthy) return { ok: false, skip: true, text: `${fromName} isn't clicking.` };
    // A trade you start goes now. Other plugins' marks (the Armory's star farming, Games, the Opener) cover whole turns,
    // but the site only locks an account for the moment one action is in flight, so their marks aren't waited on: the
    // accounts were asked for when the send started (nothing new starts on them), and a "locked" answer is tried again
    // every LOCK_RETRY_MS for up to LOCK_MAX_MS. Only a route trade on the same account (the Trader's own) is waited out.
    const practice = ctx.power.practice(), end = Date.now() + LOCK_MAX_MS;
    while (busy.has(from) || busy.has(to)) {
        if (ctx.stopping) return { ok: false, text: `${fromName}: the Trader was turned off.` };
        if (quit()) return { ok: false, halted: true, text: `${fromName}: stopped by you.` };
        if (Date.now() > end) return { ok: false, text: `${fromName}: still in a route trade after a minute — try again.` };
        if (prog) prog(`waiting for a route trade on ${fromName}`);
        await ctx.sleep(500);
    }
    for (;;) {
        const r = await sendFromNow(from, to, accts, terms, want, tokens, withFavs, fromName, toName);
        if (!r.locked || Date.now() > end || ctx.stopping || quit()) return r;
        if (prog) prog(`the site says ${fromName} or ${toName} is busy for a moment — trying again`);
        await ctx.sleep(LOCK_RETRY_MS);
    }
}
async function sendFromNow(from, to, accts, terms, want, tokens, withFavs, fromName, toName) {
    const [sMe, rMe] = await Promise.all([getJson(from, '/api/me'), getJson(to, '/api/me')]);
    if (rMe.dailyTradesLeft != null && num(rMe.dailyTradesLeft) <= 0) return { ok: false, stop: true, text: `${toName} has no received trades left today.` };
    const pro = sMe.membership === 'pro', cap = num(sMe.tradeItems) || (pro ? 200 : 50), held = Math.floor(num(sMe.tokens));
    const notes = [];
    let tk = 0;
    if (tokens) {
        if (!pro) { if (!terms.length) return { ok: false, skip: true, text: `${fromName} isn't Pro — only Pro accounts can trade tokens.` }; notes.push('no tokens: not Pro'); }
        else if (tokens === 'all') tk = held;
        else if (tokens > held) { if (!terms.length) return { ok: false, skip: true, text: `${fromName} has only ${count(held)} tokens.` }; notes.push(`no tokens: it has only ${count(held)}`); }
        else tk = tokens;
    }
    const picks = picksFor(from);
    let items = picks.slice();
    const parts = picks.length ? [[PICKED, picks.slice()]] : [];   // [name, the items of it that go]
    if (terms.length) {
        const found = await findAll(from, terms);
        let favsLeft = 0;
        for (const f of found) {
            const inIt = new Set(items.map(x => x._id));
            const pool = (withFavs ? [...f.items, ...f.favItems].sort((a, b) => num(b.price) - num(a.price)) : f.items).filter(x => !inIt.has(x._id));
            if (!withFavs) favsLeft += f.favItems.length;
            const take = pool.slice(0, want === 'all' ? pool.length : want);
            if (want !== 'all' && want > pool.length && pool.length) notes.push(`only ${pool.length} × ${f.term}`);
            if (take.length) { items.push(...take); parts.push([f.term, take]); }
        }
        if (items.length > cap) {
            notes.push(`${cap} is the most per trade`);
            items = items.slice(0, cap);
            const kept = new Set(items.map(x => x._id));
            for (const p of parts) p[1] = p[1].filter(x => kept.has(x._id));
        }
        if (!items.length && !tk) return { ok: false, skip: true, text: `${fromName} has no ${terms.map(t => `"${t}"`).join(' or ')} to send${favsLeft ? ` — ${favsLeft} favourited (switch on "Include favourited items" to send those)` : ''}.` };
    }
    if (items.length > cap) {   // picked by hand, more than one trade holds
        notes.push(`${cap} is the most per trade`);
        items = items.slice(0, cap);
        const kept = new Set(items.map(x => x._id));
        for (const p of parts) p[1] = p[1].filter(x => kept.has(x._id));
    }
    if (!items.length && !tk) return { ok: false, skip: true, text: `${fromName} has no tokens to send.` };
    const what = [...parts.filter(p => p[1].length).map(([t, l]) => t === PICKED ? `${l.length} picked item${l.length === 1 ? '' : 's'}` : `${l.length} × ${t}`), tk ? `${count(tk)} tokens` : ''].filter(Boolean).join(' + ');
    const note = notes.length ? ` (${notes.join(', ')})` : '';
    if (ctx.power.practice()) { ctx.log(`${fromName} → ${toName}: practice — would send ${what}`, 'info', from); return { ok: true, what, note }; }
    const mark = (on) => { if (ctx.accounts.setBusy) for (const id of [from, to]) ctx.accounts.setBusy(id, on ? 'trading' : null); };
    mark(true);
    try {
        const rec = await execute(from, to, items, tk, sMe, fromName, toName);
        if (rec.ok && inv && inv.aid === from) { for (const x of items) inv.sel.delete(x._id); inv.items = inv.items.filter(x => !items.some(y => y._id === x._id)); }
        return rec.ok ? { ok: true, what, note } : { ok: false, locked: LOCKED.test(rec.why || ''), text: `${fromName}: the trade didn't go through — ${rec.why}` };
    } finally { mark(false); }
}

// The single trade: each picked sender, one after another, makes one trade to the receiver.
async function sendOne() {
    const accts = new Map(ctx.accounts.list().map(a => [a.id, a]));
    const to = S('oneTo'), ids = senderIds(), toName = accts.get(to).name;
    const terms = oneTerms(), want = amount(S('oneCount'), true), tokens = amount(S('oneTokens'), false), withFavs = !!S('oneFavs');
    const practice = ctx.power.practice();
    const me = one = { t: Date.now(), running: true, done: 0, total: ids.length, results: [], text: ids.length > 1 ? `Getting it ready… 0/${ids.length}` : 'Getting it ready…' };
    const asked = practice ? [] : [...new Set([to, ...ids])];
    askFor(asked, `single trade to ${toName}`);
    try {
    for (const id of ids) {
        if (ctx.stopping || me.halt) break;
        let r;
        const head = ids.length > 1 ? `${practice ? 'Working it out' : 'Sending'}… ${me.done}/${ids.length} · ` : '';
        try { r = await sendFrom(id, to, accts, terms, want, tokens, withFavs, (w) => { me.text = head + w[0].toUpperCase() + w.slice(1) + '…'; }, () => me.halt); } catch (e) { r = { ok: false, text: `${accts.get(id).name}: ${e.message}` }; }
        giveBack(asked.filter(x => x === id && x !== to));
        const name = accts.get(id).name;
        me.results.push({ name, ...r, text: r.ok ? `${practice ? 'would send' : 'sent'} ${r.what}${r.note}` : r.text });
        me.done++;
        if (ids.length > 1) me.text = `${practice ? 'Working it out' : 'Sending'}… ${me.done}/${ids.length}`;
        if (r.stop) break;
    }
    } finally { giveBack(asked); }
    const ok = me.results.filter(r => r.ok), skipped = me.results.filter(r => r.skip), failed = me.results.filter(r => !r.ok && !r.skip);
    if (ids.length === 1 && me.results.length === 1) {
        const r = me.results[0];
        me.text = !r.ok ? r.text : practice ? `Practice — would send ${r.what} from ${r.name} to ${toName}${r.note}. Set the mode to Live to send it.`
            : `Sent ${r.what} from ${r.name} to ${toName}${r.note}.`;
        me.ok = r.ok; me.results = [];
    } else {
        const notRun = ids.length - me.results.length;
        const tail = [skipped.length ? `${skipped.length} had nothing to send` : '', failed.length ? `${failed.length} failed` : '', me.halt && notRun ? `stopped by you, ${notRun} not sent` : ''].filter(Boolean).join(' · ');
        me.text = practice ? `Practice — ${ok.length} of ${ids.length} would send to ${toName}${tail ? ` · ${tail}` : ''}. Set the mode to Live to send.`
            : `${ok.length} of ${ids.length} sent to ${toName}${tail ? ` · ${tail}` : ''}.`;
        me.ok = !failed.length && ok.length > 0;
    }
    me.running = false;
    // Keep the look-up's numbers right for the accounts that changed.
    if (!practice && ok.length && lookup && !lookup.running && terms.length && lookup.key === termsKey(terms)) {
        for (const id of [to, ...ids]) { try { lookup.counts[id] = await countOn(id, lookup.terms); } catch (_) {} }
    }
}

// Send to many: one source sends the same number of tokens to each picked receiver, one trade after another.
let fan = null;      // the last run: { t, running, done, total, ok, text, results }
function fanIds() {
    const v = S('fanTo'), from = S('fanFrom');
    const ids = v && Array.isArray(v.ids) ? v.ids : [];
    const known = new Set(ctx.accounts.list().map(a => a.id));
    return [...new Set(ids)].filter(id => id !== from && known.has(id));
}
function fanProblem() {
    const from = S('fanFrom'), byId = new Map(ctx.accounts.list().map(a => [a.id, a])), ids = fanIds(), tk = amount(S('fanTokens'), false);
    if (!from || !byId.has(from)) return 'Pick the account that sends.';
    if (Number.isNaN(tk) || tk === 'all') return 'Tokens each: type a number like 500K or 2.5M.';
    if (!tk) return 'Type how many tokens each receiver gets.';
    if (!ids.length) return 'Pick who receives: click one or more accounts, or All.';
    if (!byId.get(from).healthy) return `${byId.get(from).name} isn't clicking — start it first.`;
    const me = ctx.accounts.stats(from);
    if (me && me.membership && me.membership !== 'pro') return `${byId.get(from).name} isn't Pro — only Pro accounts can trade tokens.`;
    if ((fan && fan.running) || (one && one.running)) return 'A trade is going already.';
    return null;
}
async function sendFan() {
    const accts = new Map(ctx.accounts.list().map(a => [a.id, a]));
    const from = S('fanFrom'), ids = fanIds(), tk = amount(S('fanTokens'), false), fromName = accts.get(from).name;
    const practice = ctx.power.practice();
    const me = fan = { t: Date.now(), running: true, done: 0, total: ids.length, results: [], text: `Getting it ready… 0/${ids.length}` };
    let left = null;
    const asked = practice ? [] : [...new Set([from, ...ids])];
    askFor(asked, `send to many from ${fromName}`);
    try {
    try { left = Math.floor(num((await getJson(from, '/api/me')).tokens)); } catch (_) {}
    for (const id of ids) {
        if (ctx.stopping || me.halt) break;
        const name = accts.get(id).name;
        let r;
        if (left != null && left < tk) r = { ok: false, skip: true, text: `not sent: ${fromName} has ${count(left)} tokens left` };
        else {
            try { r = await sendFrom(from, id, accts, [], 'all', tk, false, (w) => { me.text = `Sending… ${me.done}/${ids.length} · ${w[0].toUpperCase() + w.slice(1)}…`; }, () => me.halt); } catch (e) { r = { ok: false, text: e.message }; }
            giveBack(asked.filter(x => x === id && x !== from));
            if (r.ok && left != null) left -= tk;
        }
        me.results.push({ name, ok: r.ok, skip: r.skip, text: r.ok ? `${practice ? 'would get' : 'got'} ${count(tk)} tokens${r.note || ''}` : String(r.text || '').replace(fromName + ': ', '') });
        me.done++;
        me.text = `${practice ? 'Working it out' : 'Sending'}… ${me.done}/${ids.length}`;
    }
    } finally { giveBack(asked); }
    const ok = me.results.filter(r => r.ok), failed = me.results.filter(r => !r.ok);
    me.text = practice ? `Practice — ${ok.length} of ${ids.length} would get ${count(tk)} tokens from ${fromName} (${count(ok.length * tk)} in all)${failed.length ? ` · ${failed.length} wouldn't` : ''}. Set the mode to Live to send.`
        : `${ok.length} of ${ids.length} got ${count(tk)} tokens from ${fromName} (${count(ok.length * tk)} in all)${failed.length ? ` · ${failed.length} not sent` : ''}${me.halt && ids.length > me.results.length ? ` · stopped by you, ${ids.length - me.results.length} not sent` : ''}.`;
    me.ok = ok.length > 0 && !failed.length;
    me.running = false;
}

async function check() {
    if (running) { rerun = true; return; }
    running = true; lastRun = Date.now();
    let waited = false;
    const wantNow = new Map();
    try {
        const accts = ctx.accounts.list(), byId = new Map(accts.map(a => [a.id, a]));
        const done = new Set();
        for (const route of S('routes') || []) {
            const to = byId.get(route.to);
            if (!to) continue;
            if (!to.healthy) { ctx.log(`route to ${to.name}: not clicking, skipped`); continue; }
            const from = accts.filter(a => a.id !== to.id && (route.from.all || (route.from.ids || []).includes(a.id)));
            for (const a of from) {
                if (ctx.stopping || routeHalt) return;
                if (done.has(a.id) || busy.has(a.id) || !a.healthy) continue;
                // Another plugin has either side tied up (opening cases, playing games): this pair waits for the
                // next check. While trading, both are marked so they wait for the trade in turn.
                const other = !ctx.power.practice() && ctx.accounts.busy && (ctx.accounts.busy(a.id) || ctx.accounts.busy(to.id));
                if (other) {
                    waited = true;
                    const why = `trade route ${a.name} → ${to.name}`;
                    if (ctx.accounts.want) for (const id of [a.id, to.id]) if (ctx.accounts.busy(id)) { ctx.accounts.want(id, why); wantNow.set(id, why); }
                    if (!said.has(a.id + '>' + to.id)) { said.add(a.id + '>' + to.id); ctx.log(`${a.name} → ${to.name}: waiting — ${other.what} (${other.plugin}); asked it to hand the accounts over`, 'info', a.id); }
                    continue;
                }
                said.delete(a.id + '>' + to.id);
                const mark = (on) => { if (!ctx.power.practice() && ctx.accounts.setBusy) for (const id of [a.id, to.id]) ctx.accounts.setBusy(id, on ? 'trading' : null); };
                mark(true);
                try { if (await trade(a.id, to.id, route, a.name, to.name) || ctx.power.practice()) done.add(a.id); }
                catch (e) { ctx.log(`${a.name}: ${e.message}`, 'warn', a.id); }
                finally { mark(false); }
            }
        }
    } finally {
        if (ctx.power.practice()) { state.practiceAt = Date.now(); ctx.data.set(state); }
        running = false;
        if (routeHalt) { routeHalt = false; rerun = false; waited = false; ctx.log('route run stopped by you'); }
        if (rerun) { rerun = false; setTimeout(() => { if (!ctx.stopping && ctx.power.live()) check(); }, 1000); }
        else if (waited) setTimeout(() => { if (!ctx.stopping && ctx.power.live()) check(); }, wantNow.size ? WANT_RETRY_MS : WAIT_RETRY_MS);   // a busy account: try again soon
        // Asks for accounts no pair waits on any more are taken back.
        for (const id of wanting.keys()) if (!wantNow.has(id) && !oneWants.has(id) && ctx.accounts.want) ctx.accounts.want(id, null);
        wanting.clear(); for (const [id, w] of wantNow) wanting.set(id, w);
    }
}

// --- Open trades -----------------------------------------------------------
// Never watched from an account outside the trade: a watch from anyone else would join it as the guest.
let open = null;   // { running, done, total, at, trades: [{ id, at, host, guest, items, value, hostTokens, guestTokens, note }], errors }
const tradeWhat = (x) => [x.items ? `${count(x.items)} item${x.items === 1 ? '' : 's'}${x.value ? ` ($${count(x.value)})` : ''}` : '',
    x.hostTokens ? `${count(x.hostTokens)} tokens` : '', x.guestTokens ? `${count(x.guestTokens)} tokens back` : ''].filter(Boolean).join(' + ') || 'nothing in it';

async function watch(aid, tradeId) {
    const sock = await ctx.socket(aid);
    sock.emit('watchTrade', tradeId);
    const r = await sock.wait(['tradeInfo', 'tradeWatchError', 'tradeError'], 8000);
    if (!r || r.ev !== 'tradeInfo') { sock.close(); throw new Error(r ? `the site said ${JSON.stringify(r.data).slice(0, 80)}` : 'no answer from the trade'); }
    return { sock, info: r.data || {} };
}

async function checkTrades() {
    const accts = ctx.accounts.list().filter(a => a.healthy);
    open = { running: true, done: 0, total: accts.length, at: Date.now(), trades: [], errors: [] };
    const byUid = new Map(), found = new Map();
    for (const a of accts) {
        if (ctx.stopping) break;
        try {
            byUid.set(await userId(a.id), a);
            const j = await getJson(a.id, '/api/trading');
            for (const x of (j && j.activeUserTrades) || []) if (x && x._id && !found.has(x._id)) found.set(x._id, x);
        } catch (e) { open.errors.push(`${a.name}: ${e.message}`); }
        open.done++;
        await sleep(150);
    }
    const side = (s) => { const u = (s && s.user) || {}; return { uid: u.userId || null, name: u.name || '', acct: (u.userId && byUid.get(u.userId)) || null, accepted: !!(s && s.hasAccepted) }; };
    for (const x of found.values()) {
        const rec = { id: x._id, at: Date.parse(x.createdAt) || 0, host: side(x.host), guest: side(x.guest), items: 0, value: 0, hostTokens: 0, guestTokens: 0, note: '' };
        const ours = rec.host.acct || rec.guest.acct;
        if (ours && (busy.has(rec.host.acct && rec.host.acct.id) || busy.has(rec.guest.acct && rec.guest.acct.id))) rec.note = 'the Trader is using it right now';
        else if (ours) {
            try {
                const { sock, info } = await watch(ours.id, x._id);
                sock.close();
                const sk = Array.isArray(info.offeredSkins) ? info.offeredSkins : [];
                rec.items = sk.length; rec.value = sk.reduce((s, k) => s + num(k && k.price), 0);
                rec.hostTokens = num(info.hostTokens); rec.guestTokens = num(info.guestTokens);
                if (info.host && info.host.user) rec.host = side(info.host);
                if (info.guest && info.guest.user) rec.guest = side(info.guest);
            } catch (e) { rec.note = "couldn't look inside: " + e.message; }
        }
        open.trades.push(rec);
    }
    open.trades.sort((a, b) => a.at - b.at);
    open.running = false; open.at = Date.now();
    if (open.trades.length) ctx.log(`open trades: ${open.trades.length} running — ${open.trades.map(x => `${x.host.acct ? x.host.acct.name : x.host.name || '?'} → ${x.guest.acct ? x.guest.acct.name : x.guest.name || 'nobody'}`).join(', ')}`);
}

// Both sides accept (each only if it hasn't) and the host confirms; or the host deletes it.
async function settleTrade(id, how) {
    const x = open && open.trades.find(r => r.id === id);
    if (!x) throw new Error('that trade isn\'t in the list any more — check again');
    const h = x.host.acct, g = x.guest.acct;
    if (how === 'finish' && !(h && g)) throw new Error('both sides have to be hub accounts to finish it here');
    if (how === 'delete' && !h) throw new Error('only the host can delete a trade, and the host isn\'t a hub account');
    const ids = [h, g].filter(Boolean).map(a => a.id);
    if (ids.some(i => busy.has(i))) throw new Error('the Trader is using one of the accounts right now');
    for (const i of ids) busy.add(i);
    const mark = (on) => { if (ctx.accounts.setBusy) for (const i of ids) ctx.accounts.setBusy(i, on ? 'trading' : null); };
    mark(true);
    const socks = [];
    const log = (msg, level) => ctx.log(`trade ${h ? h.name : x.host.name} → ${g ? g.name : x.guest.name || 'nobody'}: ${msg}`, level, h ? h.id : g.id);
    try {
        const hUid = await userId(h.id);
        const hw = await watch(h.id, id); socks.push(hw.sock);
        if (how === 'delete') {
            hw.sock.emit('tradeDelete', { userId: hUid, tradeId: id });
            const r = await hw.sock.wait(['tradeDeleted', 'tradeError'], 8000);
            if (!r || r.ev !== 'tradeDeleted') throw new Error('not deleted: ' + (r ? JSON.stringify(r.data).slice(0, 100) : 'no answer'));
            log('deleted — nothing moved', 'ok');
            return 'Deleted — nothing moved.';
        }
        const gUid = await userId(g.id);
        const gw = await watch(g.id, id); socks.push(gw.sock);
        const acc = (s) => !!(s && s.hasAccepted);
        if (!acc(hw.info.host)) { hw.sock.emit('tradeAccept', { userId: hUid, tradeId: id }); await sleep(1500); }
        if (!acc(gw.info.guest)) { gw.sock.emit('tradeAccept', { userId: gUid, tradeId: id }); await sleep(800); }
        hw.sock.emit('tradeConfirm', { userId: hUid, tradeId: id });
        const done = await hw.sock.wait(['tradeConfirmed', 'tradeError', 'tradeDeleted'], 12000);
        if (!done || done.ev !== 'tradeConfirmed') throw new Error('not confirmed: ' + (done ? (done.ev === 'tradeError' ? JSON.stringify(done.data).slice(0, 100) : done.ev) : 'no answer'));
        const what = tradeWhat(x);
        state.history = [{ t: Date.now(), from: h.name, to: g.name, items: x.items, tokens: x.hostTokens, ok: true, why: '' }, ...(state.history || [])].slice(0, 50);
        const td = today(); td.trades++; td.items += x.items; td.tokens += x.hostTokens;
        ctx.data.set(state);
        log(`finished — ${what}`, 'ok');
        return `Finished — ${what} went to ${g.name}.`;
    } catch (e) {
        log((how === 'delete' ? 'delete' : 'finish') + ' failed: ' + e.message, 'warn');
        throw e;
    } finally {
        for (const s of socks) s.close();
        for (const i of ids) busy.delete(i);
        mark(false);
    }
}

module.exports = {
    start(c) {
        ctx = c;
        state = { history: [], ...ctx.data.get() };
        today();
        // The main account (Settings), when it's in the hub, is where things go by default: the single trade's receiver
        // starts on it, and the page offers it for routes.
        const mainId = () => (ctx.accounts.main ? ctx.accounts.main() : null);
        const suggestMain = () => { const m = mainId(); if (m && !S('oneTo')) ctx.settings.set('oneTo', m); };
        suggestMain();
        ctx.every(15000, () => {
            suggestMain();
            const every = num(S('everyMs')) || Math.max(5, num(S('everyMin'))) * 60000;
            if (ctx.power.live() && Date.now() - lastRun >= every) check();   // on the schedule only when on and live
            plan();
        });
        // The Schedule tab (hub 1.2.18+): the next route check, with Run now / Skip next.
        const plan = () => {
            if (!ctx.schedule) return;
            const routes = S('routes') || [];
            if (!ctx.power.live() || !routes.length) { ctx.schedule.set('check', null); return; }
            const every = num(S('everyMs')) || Math.max(5, num(S('everyMin'))) * 60000;
            const from = new Set();
            for (const r of routes) {
                if (r.to) from.add(r.to);
                if (r.from && r.from.all) for (const a of ctx.accounts.list()) from.add(a.id);
                else for (const id of (r.from && r.from.ids) || []) from.add(id);
            }
            ctx.schedule.set('check', { what: running ? 'Checking routes (running)' : 'Check trade routes', at: running ? Date.now() : Math.max(lastRun + every, Date.now()), accounts: [...from],
                why: `every ${Math.round(every / 60000)} min: ${routes.length} route${routes.length === 1 ? '' : 's'}, each moves what's over its keep amount`,
                runNow: () => { lastRun = 0; check(true); return { message: running ? 'Already checking — it goes again right after.' : 'Checking routes now.' }; },
                skip: () => { lastRun = Math.max(lastRun + every, Date.now()); plan(); return { message: 'Skipped: the next check is one interval later.' }; } });
        };
        plan();
        ctx.settings.onChange((k) => { if (k === 'routes' || k === 'on' || k === 'runMode') lastRun = 0; });
        ctx.panel.action('check', () => {
            if (!(S('routes') || []).length) return { ok: false, error: 'Add a route first.' };
            lastRun = 0; check(true);
            return { message: running ? 'Already checking — it goes again right after.' : ctx.power.practice() ? 'Checking routes — the plan shows up here in a moment.' : 'Checking routes now.' };
        });
        // Stop: the trade in flight finishes (a half-made trade would be left stuck), nothing after it starts.
        ctx.panel.action('checkStop', () => { if (!running) return { message: 'No route run going.' }; routeHalt = true; return { message: 'Stopping after the current trade.' }; });
        ctx.panel.action('oneStop', () => { if (!(one && one.running)) return { message: 'Nothing is sending.' }; one.halt = true; return { message: 'Stopping after the current trade.' }; });
        ctx.panel.action('fanStop', () => { if (!(fan && fan.running)) return { message: 'Nothing is sending.' }; fan.halt = true; return { message: 'Stopping after the current trade.' }; });
        ctx.panel.action('tradesCheck', () => {
            if (open && open.running) return { message: 'Already checking.' };
            checkTrades().catch(e => { open = { ...(open || {}), running: false, trades: (open && open.trades) || [], errors: [...((open && open.errors) || []), e.message] }; });
            return { message: 'Checking every clicking account for running trades…' };
        });
        const settle = (how) => async (id) => {
            if (ctx.power.practice()) return { ok: false, error: 'Practice mode — set the mode to Live (top card) to finish or delete trades.' };
            try {
                const msg = await settleTrade(String(id || ''), how);
                if (open) open.trades = open.trades.filter(r => r.id !== String(id));
                return { message: msg };
            } catch (e) { return { ok: false, error: e.message }; }
        };
        ctx.panel.action('tradeFinish', settle('finish'));
        ctx.panel.action('tradeDelete', settle('delete'));
        ctx.panel.action('oneLookup', () => {
            const terms = oneTerms();
            if (!terms.length) return { ok: false, error: 'Type an item name first.' };
            if (lookup && lookup.running && lookup.key === termsKey(terms)) return { message: 'Already looking.' };
            lookUp(terms).catch(() => {});
            return { message: `Looking for ${terms.map(t => `"${t}"`).join(', ')} on every account…` };
        });
        const setSenders = (ids) => { const r = ctx.settings.set('oneFrom', { all: false, ids }); return r && r.ok === false ? r : {}; };
        ctx.panel.action('onePick', (aid) => {   // flips one sender in or out
            if (!ctx.accounts.list().some(a => a.id === aid)) return { ok: false, error: 'No such account.' };
            const ids = senderIds();
            return setSenders(ids.includes(aid) ? ids.filter(x => x !== aid) : [...ids, aid]);
        });
        ctx.panel.action('oneAll', () => {   // every account the list shows now (after a look-up: the ones that have the item)
            const ids = oneListed().map(a => a.id);
            if (!ids.length) return { ok: false, error: 'No accounts to pick.' };
            const r = setSenders(ids);
            return r.ok === false ? r : { message: `${ids.length} sender${ids.length === 1 ? '' : 's'} picked.` };
        });
        ctx.panel.action('oneNone', () => setSenders([]));
        ctx.panel.action('onePreset', (id) => {
            const p = PRESETS.find(x => x.id === id);
            if (!p) return { ok: false, error: 'No such preset.' };
            if (p.id === 'custom') return { message: 'Type the item and the amounts below.' };
            for (const [k, v] of [['oneItem', p.item ? [p.item] : []], ['oneCount', ''], ['oneTokens', p.tokens]]) {
                const r = ctx.settings.set(k, v);
                if (r && r.ok === false) return r;
            }
            if (p.item && !(lookup && lookup.running && lookup.key === termsKey([p.item]))) lookUp([p.item]).catch(() => {});
            return { message: p.item ? `${p.title}: looking for "${p.item}" on every account…` : `${p.title}: now pick who sends.` };
        });
        ctx.panel.action('oneToMain', () => {
            const m = mainId();
            if (!m) return { ok: false, error: "Your main account isn't one of the hub's accounts." };
            const r = ctx.settings.set('oneTo', m);
            if (r && r.ok === false) return r;
            return {};
        });
        ctx.panel.action('routeToMain', () => {
            const m = mainId();
            if (!m) return { ok: false, error: "Your main account isn't one of the hub's accounts." };
            const routes = S('routes') || [];
            const r = ctx.settings.set('routes', [...routes, { to: m, from: { all: true, ids: [] }, tokens: false, keepTokens: 0, minTokens: 1000000, terminals: 'none', skins: false, skinsOver: 0, names: '', skipFavorites: true, minItems: 1 }]);
            return r && r.ok === false ? r : { message: 'Route to your main added (from all accounts) — switch on what it sends.' };
        });
        const setFan = (ids) => { ctx.settings.set('fanTo', { ids }); return { ok: true }; };
        ctx.panel.action('fanPick', (aid) => { const ids = fanIds(); return setFan(ids.includes(aid) ? ids.filter(x => x !== aid) : [...ids, String(aid)]); });
        ctx.panel.action('fanAll', () => setFan(ctx.accounts.list().filter(a => a.id !== S('fanFrom')).map(a => a.id)));
        ctx.panel.action('fanNone', () => setFan([]));
        ctx.panel.action('fanSend', () => {
            const why = fanProblem();
            if (why) return { ok: false, error: why };
            sendFan().catch(() => { if (fan) { fan.running = false; fan.ok = false; fan.text = 'Stopped by an error.'; } });
            return { message: ctx.power.practice() ? 'Practice — working out what it would send…' : 'Sending the trades…' };
        });
        // View inventory: the one picked sender's (or the account given), in a modal; clicks pick items for the trade.
        ctx.settings.setOptions('invEvent', EVENTS_BASE);
        ctx.panel.action('invOpen', (arg) => {
            const ids = senderIds(), aid = String(arg || '') || (ids.length === 1 ? ids[0] : '');
            const a = ctx.accounts.get(aid);
            if (!a) return { ok: false, error: ids.length > 1 ? 'Pick just one sender to view its inventory.' : 'Pick who sends first (2. Send from).' };
            if (!a.healthy) return { ok: false, error: `${a.name} isn't clicking — start it first.` };
            if (!inv || inv.aid !== aid) inv = { aid, open: true, items: [], page: 0, pages: 1, count: 0, search: '', loading: false, error: '', sel: new Map() };
            inv.open = true;
            invEvents(aid);
            if (!inv.cap) getJson(aid, '/api/me').then(m => { if (inv && inv.aid === aid && m) inv.cap = num(m.tradeItems) || (m.membership === 'pro' ? 200 : 50); }).catch(() => {});   // this account's own per-trade limit
            if (!inv.items.length || inv.query !== invQuery()) invLoad(false);
            return {};
        });
        ctx.panel.action('invClose', () => { if (inv) inv.open = false; return {}; });
        // From the inventory: Check another account (back to Send from, with no sender picked, so one more click
        // offers its View inventory), or send the trade now with what's picked.
        ctx.panel.action('invAnother', () => { if (inv) inv.open = false; setSenders([]); return { wizard: { id: 'one', step: 'from' } }; });
        ctx.panel.action('invSend', () => {
            const ids = senderIds();
            if (!inv || ids.length !== 1 || ids[0] !== inv.aid) return { ok: false, error: 'This inventory\'s account isn\'t the sender any more.' };
            const why = oneProblem();
            if (why) return { ok: false, error: why };
            inv.open = false;
            sendOne().catch(() => {});
            return { wizard: { id: 'one', step: null }, message: ctx.power.practice() ? 'Practice — working out what it would send…' : 'Sending the trade…' };
        });
        ctx.panel.action('invMore', () => { if (inv) invLoad(true); return {}; });
        ctx.panel.action('invClear', () => { if (inv) inv.sel.clear(); return {}; });
        // Reset: every filter back to Any and the search cleared (the sort stays), as the game's Reset does.
        ctx.panel.action('invReset', () => { for (const k of ['invSearch', ...INV_FILTERS.map(x => x[0])]) ctx.settings.set(k, ''); if (inv && inv.open) invLoad(false); return {}; });
        // A click picks the item (one of a stack), or unpicks it (all of the stack).
        ctx.panel.action('invToggle', (id) => {
            const g = inv && stackOf(String(id || ''));
            if (!g) return { ok: false, error: 'That item isn\'t in the list any more.' };
            if (g.items.some(x => inv.sel.has(x._id))) { stackSet(g, 0); return {}; }
            if (favorite(g.s) && !S('oneFavs')) return { ok: false, error: 'Favourited — switch on "Include favourited items" to trade it.' };
            const cap = tradeCap(inv.aid);
            if (inv.sel.size >= cap) return { ok: false, error: `${cap} items is the most one trade holds.` };
            stackSet(g, 1);
            return {};
        });
        // A picked stack's − + All ("<id>|-1", "<id>|+1", "<id>|all"); All stops at what the trade still holds.
        ctx.panel.action('invQty', async (arg) => {
            const [id, d] = String(arg || '').split('|');
            let g = inv && stackOf(id);
            if (!g) return { ok: false, error: 'That item isn\'t in the list any more.' };
            if (favorite(g.s) && !S('oneFavs')) return { ok: false, error: 'Favourited — switch on "Include favourited items" to trade it.' };
            const cap = tradeCap(inv.aid), free = () => cap - (inv.sel.size - g.items.filter(x => inv.sel.has(x._id)).length);
            // All (or + at the end of what's loaded): read more pages until the stack fills what the trade holds.
            if ((d === 'all' || d === '+1') && g.items.length < free() && stackMayGrow(g)) {
                const want = d === 'all' ? free() : g.items.filter(x => inv.sel.has(x._id)).length + 1;
                await invLoadUntil(() => { g = stackOf(id) || g; return g.items.length >= want || !stackMayGrow(g); }, 20);
                g = stackOf(id) || g;
            }
            const n = g.items.filter(x => inv.sel.has(x._id)).length, room = Math.min(g.items.length, free());
            if (d === '+1' && n >= room) return { ok: false, error: n >= free() ? `${cap} items is the most one trade holds.` : `That's all ${g.items.length} of them.` };
            stackSet(g, Math.max(0, Math.min(room, d === 'all' ? room : d === '-1' ? n - 1 : n + 1)));
            return {};
        });
        ctx.settings.onChange((k) => { if (INV_KEYS.includes(k) && inv && inv.open && inv.query !== invQuery()) invLoad(false); });
        ctx.panel.action('oneSend', () => {
            const why = oneProblem();
            if (why) return { ok: false, error: why };
            sendOne().catch(() => {});
            return { message: ctx.power.practice() ? 'Practice — working out what it would send…' : 'Sending the trade…' };
        });
        ctx.panel.tab('Trader', () => {
            const t = today(), practice = ctx.power.practice(), live = ctx.power.live(), routes = S('routes') || [];
            const accts = new Map(ctx.accounts.list().map(a => [a.id, a]));
            const isPro = (id) => { const me = ctx.accounts.stats(id); return !!(me && me.membership === 'pro'); };
            const sendersOf = (r) => [...accts.values()].filter(a => a.id !== r.to && (r.from.all || (r.from.ids || []).includes(a.id)));
            const sendsSomething = (r) => r.tokens || r.terminals !== 'none' || (r.skins && (num(r.skinsOver) > 0 || String(r.names || '').trim()));
            const short = (n) => (n >= 1e6 ? +(n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? +(n / 1e3).toFixed(1) + 'k' : String(n));
            const summary = (r) => {
                const to = accts.get(r.to);
                if (!to) return 'pick who receives';
                const from = sendersOf(r), fromTxt = r.from.all ? 'all accounts' : !from.length ? 'no senders yet' : from.length <= 2 ? from.map(a => a.name).join(', ') : `${from.length} accounts`;
                const what = [r.tokens && `tokens${num(r.keepTokens) ? ` (keep ${short(num(r.keepTokens))})` : ''}`,
                    r.terminals !== 'none' && ({ all: 'terminals', genesis: 'Genesis terminals', deadhand: 'Dead Hand terminals' })[r.terminals],
                    r.skins && (num(r.skinsOver) > 0 ? `skins ≥ $${short(num(r.skinsOver))}` : ''), r.skins && String(r.names || '').trim() && `"${String(r.names).trim()}"`].filter(Boolean);
                return `${fromTxt} → ${to.name} · ${what.length ? what.join(' · ') : 'nothing to send yet'}`;
            };
            const problems = [];
            routes.forEach((r, i) => {
                const to = accts.get(r.to), from = sendersOf(r);
                if (!to) return problems.push(`Route ${i + 1}: pick who receives.`);
                if (!from.length) problems.push(`Route ${i + 1}: pick the accounts it sends from.`);
                if (!sendsSomething(r)) problems.push(`Route ${i + 1}: switch on what it sends.`);
                if (!to.healthy) problems.push(`Route ${i + 1}: ${to.name} isn't clicking.`);
                if (r.tokens && from.length && !from.some(a => isPro(a.id))) problems.push(`Route ${i + 1} sends tokens, but no sender is Pro.`);
            });
            // Only the plans of the routes there are now (a changed or removed route's old plan would mislead).
            const pairs = new Set(routes.flatMap(r => sendersOf(r).map(a => a.id + '>' + r.to)));
            const plans = practice ? Object.entries(state.plans || {}).filter(([k]) => pairs.has(k)).map(([, x]) => x).sort((a, b) => b.t - a.t) : [];
            const every = Math.max(5, num(S('everyMin')));
            // Single trade: presets, then one or more senders; the list shows each account's tokens and, after a look-up, how many of the item it has.
            const oneTo = S('oneTo'), terms = oneTerms(), term = termsLabel(terms), withFavs = !!S('oneFavs');
            const oneTokens = amount(S('oneTokens'), false), oneCount = amount(S('oneCount'), true);
            const { lk, has, meOf, withIt, listed, picked } = oneView();
            // One line per item the account has, by its own name; the panel folds more than 3 behind "Show all".
            const itemLines = (a) => {
                if (!lk) return [];
                const c = lk.counts[a.id];
                if (!c) return ['looking…'];
                if (c.skipped) return ['not looked at'];
                if (c.error) return ['couldn\'t look: ' + c.error];
                const names = c.names || [];
                if (!names.length) return [`no ${termsLabel(lk.terms)}`];
                return names.map(g => {
                    const n = g.n + (withFavs ? g.favs : 0), value = g.value + (withFavs ? g.favValue : 0);
                    // Favourited ones: part of the count with the switch on; otherwise said apart, as staying put.
                    const favTxt = !g.favs ? '' : withFavs ? ` (${g.favs} favourited)` : n ? ` · ${g.favs} favourited kept` : ` (${g.favs} favourited, kept)`;
                    return `${count(n || g.favs)} × ${g.name}${value ? ` · $${short(value)}` : ''}${favTxt}`;
                });
            };
            const meta = (a) => { const me = meOf(a.id); return [me.tokens == null ? null : `${short(num(me.tokens))} tokens`, me.membership === 'pro' ? 'Pro' : me.membership ? 'not Pro' : null, a.healthy ? null : 'not clicking'].filter(Boolean).join(' · '); };
            const lkTotal = withIt.reduce((s, a) => s + has(a.id), 0);
            const fromIds = senderIds(), toA = accts.get(oneTo), mainA = accts.get(mainId());
            const fromTxt = !fromIds.length ? '?' : fromIds.length === 1 ? accts.get(fromIds[0]).name : `${fromIds.length} accounts`;
            const tokTxt = oneTokens === 'all' ? 'all tokens' : oneTokens > 0 ? `${count(oneTokens)} tokens` : '';
            const pickN = fromIds.reduce((s, id) => s + picksFor(id).length, 0);
            const oneWhat = [pickN ? `${pickN} picked item${pickN === 1 ? '' : 's'}` : '', term ? `${oneCount === 'all' ? 'all' : Number.isNaN(oneCount) ? '?' : count(oneCount)}${terms.length > 1 ? ' of each' : ''} × ${term}` : '', tokTxt].filter(Boolean).join(' + ');
            const each = fromIds.length > 1 ? ' each' : '';
            const oneWhy = oneProblem(), preset = presetNow();
            // Picking by hand: the one sender's inventory in a modal; what's picked shows here.
            const invA = inv && accts.get(inv.aid), invPicked = inv ? [...inv.sel.values()] : [];
            const invValue = invPicked.reduce((s, x) => s + num(x.price), 0);
            const soleA = fromIds.length === 1 ? accts.get(fromIds[0]) : null;
            const invBlocks = [{ type: 'text', text: 'Or pick items by hand from the inventory.' },
                ...(invPicked.length && invA ? [{ type: 'text', text: `Picked from ${invA.name}: ${count(invPicked.length)} item${invPicked.length === 1 ? '' : 's'} worth $${short(invValue)}${fromIds.includes(inv.aid) ? '' : ` — ${invA.name} isn't a sender now, so they don't go`}.` }] : []),
                soleA ? { type: 'buttons', items: [{ label: `View ${soleA.name}'s inventory`, action: 'invOpen', arg: soleA.id, primary: !term && !oneTokens },
                    ...(invPicked.length ? [{ label: 'Clear picked', action: 'invClear' }] : [])] }
                    : { type: 'text', text: fromIds.length > 1 ? 'View inventory works with one sender: pick just one in 2. Send from.' : 'Pick one sender (2. Send from), then View inventory to click the items like in the game.' }];
            const invModal = inv && inv.open && invA ? (() => {
                const cap = tradeCap(inv.aid), lockFavs = !withFavs;
                const sendable = fromIds.length === 1 && fromIds[0] === inv.aid, sendWhy = sendable ? oneWhy : `${invA.name} isn't the sender now.`;
                const sendBtn = { label: practice ? 'Confirm and practice send' : 'Confirm and trade now', action: 'invSend', primary: true, disabled: !!sendWhy || !!(one && one.running),
                    ...(practice ? {} : { confirm: `Send ${oneWhat} from ${invA.name} to ${toA ? toA.name : '?'} now? A trade can't be undone.` }) };
                return { title: `${invA.name}'s inventory`, close: 'invClose', blocks: [
                    // One bar: the search, then Done / Clear picked / Reset filters; under it the game's filters.
                    { type: 'bar', keys: ['invSearch'], items: [sendBtn, { label: 'Check another account', action: 'invAnother' }, { label: 'Done', action: 'invClose' }, ...(invPicked.length ? [{ label: 'Clear picked', action: 'invClear' }] : []), ...(invFiltered() ? [{ label: 'Reset filters', action: 'invReset' }] : [])],
                        text: [sendWhy && !(one && one.running) ? (/^Pick what to send/.test(sendWhy) ? 'Click items to pick them for the trade' : `To send: ${sendWhy.replace(/\.$/, '')}`) : '', `${count(invPicked.length)} picked${invValue ? ` · $${short(invValue)}` : ''}`, `up to ${cap} in one trade`,
                            inv.count ? `${count(inv.count)} item${inv.count === 1 ? '' : 's'}${invFiltered() ? ' match' : ''}` : '',
                            lockFavs ? 'favourited ones locked' : ''].filter(Boolean).join(' · ') },
                    { type: 'settings', keys: INV_KEYS.slice(1), filters: true },
                    ...(inv.error ? [{ type: 'notice', level: 'warn', text: "Couldn't load the inventory: " + inv.error }] : []),
                    { type: 'items', action: 'invToggle', items: invStacks().map(g => invCard(g, lockFavs && favorite(g.s))),
                        empty: inv.loading ? 'Loading…' : invFiltered() ? 'Nothing matches these filters.' : 'Nothing in this inventory.' },
                    ...(inv.page < inv.pages ? [{ type: 'buttons', items: [{ label: inv.loading ? 'Loading…' : `Load more (${count(inv.items.length)} of ${count(inv.count)})`, action: 'invMore' }] }] : []),
                ] };
            })() : null;
            const oneSendBtns = one && one.running && !practice && one.total > 1
                ? [{ label: one.halt ? 'Stopping…' : 'Stop', action: 'oneStop', danger: true, disabled: !!one.halt }]
                : [{ label: practice ? 'Practice send' : fromIds.length > 1 ? `Send ${fromIds.length} trades` : 'Send trade', action: 'oneSend', primary: true, disabled: !!oneWhy,
                    ...(practice ? {} : { confirm: fromIds.length > 1 ? `Send ${fromIds.length} trades now? Trades can't be undone.` : "Send this trade now? A trade can't be undone." }) }];
            const oneCard = { type: 'section', title: 'Single trade', blocks: [
                { type: 'wizard', id: 'one', steps: [
                    { id: 'to', title: 'Send to', done: !!toA, warn: toA ? null : 'pick who receives',
                        summary: toA ? `${toA.name}${mainA && toA.id === mainA.id ? ' (your main)' : ''}` : '',
                        keys: ['oneTo'], blocks: [
                            ...(mainA && oneTo !== mainA.id ? [{ type: 'buttons', items: [{ label: `Your main: ${mainA.name}`, action: 'oneToMain' }] }] : []),
                            ...(mainA && oneTo === mainA.id ? [{ type: 'text', text: 'Your main account.' }] : [])] },
                    { id: 'from', title: 'Send from', done: fromIds.length > 0,
                        buttons: soleA ? [{ label: 'View inventory', action: 'invOpen', arg: soleA.id }] : [], warn: fromIds.length ? null : listed.length ? 'pick one or more senders' : 'add another account to trade between them',
                        summary: fromIds.length ? (fromIds.length <= 3 ? fromIds.map(id => (accts.get(id) || {}).name).join(', ') : `${fromIds.length} accounts`) : '',
                        text: term ? `Pick one or more. Look up shows how many of ${terms.length > 1 ? 'the items' : 'the item'} each account has.` : "Pick one or more. Each account's tokens are shown.",
                        blocks: [
                            { type: 'buttons', items: [
                                ...(term ? [{ label: lk && lk.running ? `Looking… ${lk.done}/${lk.total}` : lk ? 'Look up again' : 'Look up', action: 'oneLookup' }] : []),
                                ...(listed.length ? [{ label: withIt.length ? `All with it (${listed.length})` : `All (${listed.length})`, action: 'oneAll' }] : []),
                                ...(fromIds.length ? [{ label: 'None', action: 'oneNone' }] : []),
                            ] },
                            ...(lk && !lk.running ? [{ type: 'text', text: withIt.length ? `${count(lkTotal)} × ${termsLabel(lk.terms)} on ${withIt.length} account${withIt.length === 1 ? '' : 's'} — only those are listed${withFavs ? ', favourited ones included' : ' (favourited ones stay put)'}.`
                                : `No account has ${lk.terms.map(t => `"${t}"`).join(' or ')} to send${withFavs ? '' : ' (favourited ones are left out)'}.` }] : []),
                            ...(fromIds.length ? [{ type: 'text', text: `${fromIds.length} picked.` }] : []),
                            listed.length ? { type: 'picker', action: 'onePick', tag: 'Sender', grid: true, multi: true, items: listed.map(a => ({ id: a.id, on: picked.has(a.id), title: a.name, lines: itemLines(a), meta: meta(a) })) }
                                : { type: 'text', text: 'Add another account to trade between them.' },
                        ] },
                    { id: 'what', title: 'What to send', done: !!oneWhat, summary: oneWhat ? `${oneWhat}${each}` : 'pick a preset, type an item, or tokens',
                        text: 'Pick a preset, or Custom and type it. Each sender sends its own.',
                        blocks: [
                            { type: 'picker', action: 'onePreset', tag: 'Picked', grid: true, items: PRESETS.map(p => ({ id: p.id, on: p.id === preset, title: p.title, sub: p.sub })) },
                            { type: 'settings', keys: ['oneItem', 'oneCount', 'oneFavs', 'oneTokens'] },
                            { type: 'text', text: 'Items: type a name and press Enter (or click away), then the next. Click a name to take it out.' },
                            { type: 'text', text: 'Tokens take 500K, 2.5M, 1B or "all", and only go from Pro senders (a basic sender still sends the item).' },
                            ...invBlocks,
                        ] },
                ],
                finish: { title: one && one.running ? 'Sending…' : oneWhy ? 'Send' : `Send ${oneWhat}${each}`, ready: !oneWhy, next: 'Review and send',
                    text: oneWhy && !(one && one.running) ? oneWhy : `${oneWhat}${each} from ${fromTxt} to ${toA ? toA.name : '?'}${fromIds.length > 1 ? ` — ${fromIds.length} trades, one after another` : ''}.`,
                    buttons: oneSendBtns,
                    blocks: practice ? [{ type: 'text', text: 'Practice mode: it only says what it would send. Set the mode to Live (top card) to send for real.' }] : [] } },
                ...(one ? [{ type: 'notice', level: one.running ? '' : one.ok ? 'ok' : 'warn', text: one.text }] : []),
                ...(one && one.results && one.results.length ? [{ type: 'table', wrap: true, columns: ['Sender', practice ? 'Would' : 'Result'], rows: one.results.map(r => [r.name, r.text]) }] : []),
            ] };
            // Send to many: source, tokens each, receivers.
            const fanFrom = S('fanFrom'), fanA = accts.get(fanFrom), fanTk = amount(S('fanTokens'), false), fanTo = fanIds(), fanSet = new Set(fanTo);
            const fanWhy = fanProblem(), fanTotal = Number.isFinite(fanTk) ? fanTk * fanTo.length : 0;
            const fanHas = fanA ? num((ctx.accounts.stats(fanFrom) || {}).tokens) : 0;
            const others = [...accts.values()].filter(a => a.id !== fanFrom);
            const fanCard = { type: 'section', title: 'Send to many', blocks: [
                { type: 'wizard', id: 'fan', steps: [
                    { id: 'to', title: 'Send to', done: fanTo.length > 0, warn: fanTo.length ? null : 'pick the receivers',
                        summary: fanTo.length ? (fanTo.length <= 3 ? fanTo.map(id => (accts.get(id) || {}).name).join(', ') : `${fanTo.length} accounts`) : '',
                        blocks: [
                            { type: 'buttons', items: [{ label: `All (${others.length})`, action: 'fanAll' }, ...(fanTo.length ? [{ label: 'None', action: 'fanNone' }] : [])] },
                            ...(fanTo.length ? [{ type: 'text', text: `${fanTo.length} picked.` }] : []),
                            { type: 'picker', action: 'fanPick', tag: 'Receiver', grid: true, multi: true, items: others.map(a => ({ id: a.id, on: fanSet.has(a.id), title: a.name, meta: meta(a) })) },
                        ] },
                    { id: 'from', title: 'Send from', done: !!fanA, warn: fanA ? null : 'pick the account that sends', summary: fanA ? [fanA.name, meta(fanA)].filter(Boolean).join(' · ') : '',
                        text: 'The account that pays. If it is also ticked as a receiver, it is left out of them.', keys: ['fanFrom'] },
                    { id: 'tokens', title: 'Tokens each', done: fanTk > 0, warn: fanTk > 0 ? null : 'how many tokens each', summary: fanTk > 0 ? `${count(fanTk)} to every receiver` : '',
                        text: 'Every receiver gets this many: 500K, 2.5M, 1B. Only Pro accounts can send tokens.', keys: ['fanTokens'] },
                ],
                finish: { title: fan && fan.running ? 'Sending…' : fanWhy ? 'Send' : `Send ${count(fanTotal)} tokens`, ready: !fanWhy, next: 'Review and send',
                    text: fanWhy && !(fan && fan.running) ? fanWhy : `${count(fanTk)} tokens to each of ${fanTo.length} account${fanTo.length === 1 ? '' : 's'} from ${fanA ? fanA.name : '?'} — ${count(fanTotal)} in all, ${fanTo.length} trade${fanTo.length === 1 ? '' : 's'} one after another.`,
                    buttons: fan && fan.running && !practice && fan.total > 1
                        ? [{ label: fan.halt ? 'Stopping…' : 'Stop', action: 'fanStop', danger: true, disabled: !!fan.halt }]
                        : [{ label: practice ? 'Practice send' : fanTo.length > 1 ? `Send ${fanTo.length} trades` : 'Send trade', action: 'fanSend', primary: true, disabled: !!fanWhy,
                        ...(practice ? {} : { confirm: `Send ${count(fanTk)} tokens to each of ${fanTo.length} account${fanTo.length === 1 ? '' : 's'} (${count(fanTotal)} in all)? Trades can't be undone.` }) }],
                    blocks: [] } },
                ...(fanA && fanHas && fanTotal > fanHas && !fanWhy ? [{ type: 'notice', level: 'warn', text: `${fanA.name} has ${count(fanHas)} tokens: enough for ${Math.floor(fanHas / fanTk)} of them. The rest are skipped.` }] : []),
                ...(fan ? [{ type: 'notice', level: fan.running ? '' : fan.ok ? 'ok' : 'warn', text: fan.text }] : []),
                ...(fan && fan.results.length ? [{ type: 'table', wrap: true, columns: ['Receiver', practice ? 'Would' : 'Result'], rows: fan.results.map(r => [r.name, r.text]) }] : []),
            ] };
            // Open trades: what's running on the hub's accounts, to finish or delete one that's stuck.
            const ago = (ms) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`; };
            const who = (s) => (s.acct ? s.acct.name : s.uid ? { text: `${s.name || 'someone'} (not in the hub)`, level: 'warn' } : { text: 'nobody joined', level: 'muted' });
            const openRows = open ? open.trades.map(x => [
                x.at ? ago(x.at) + ' ago' : '—', who(x.host), who(x.guest),
                x.note ? { text: x.note, level: 'muted' } : tradeWhat(x),
                `host ${x.host.accepted ? '✓' : '–'} · guest ${x.guest.uid ? (x.guest.accepted ? '✓' : '–') : '·'}`,
                x.host.acct && x.guest.acct ? { label: 'Accept & confirm', action: 'tradeFinish', arg: x.id, primary: true,
                    confirm: `Finish this trade? ${tradeWhat(x)} goes from ${x.host.acct.name} to ${x.guest.acct.name}. A trade can't be undone.` }
                    : { text: !x.guest.uid ? 'nobody to finish with' : 'other side not in the hub', level: 'muted' },
                x.host.acct ? { label: 'Delete', action: 'tradeDelete', arg: x.id, danger: true, confirm: `Delete this trade hosted by ${x.host.acct.name}? Nothing in it moves.` }
                    : { text: 'only the host can delete', level: 'muted' },
            ]) : [];
            const openCard = { type: 'card', id: 'open', open: !!(open && (open.running || open.trades.length)), title: 'Open trades',
                summary: !open ? 'find trades left stuck or unconfirmed' : open.running ? `checking… ${open.done}/${open.total}` : open.trades.length ? `${open.trades.length} running · checked ${ago(open.at)} ago` : `none running · checked ${ago(open.at)} ago`,
                blocks: [
                    { type: 'text', text: 'Lists the trades the hub\'s accounts are in right now. Finish one between two hub accounts (both accept, the host confirms), or delete one a hub account hosts — nothing in a deleted trade moves.' },
                    { type: 'buttons', items: [{ label: open && open.running ? `Checking… ${open.done}/${open.total}` : open ? 'Check again' : 'Check trades', action: 'tradesCheck', primary: !open }] },
                    ...(open && open.errors.length ? [{ type: 'notice', level: 'warn', text: `Couldn't check ${open.errors.length} account${open.errors.length === 1 ? '' : 's'}: ${open.errors.slice(0, 3).join('; ')}${open.errors.length > 3 ? ' …' : ''}` }] : []),
                    ...(open && !open.running && !open.trades.length ? [{ type: 'notice', level: 'ok', text: `No running trades on ${open.total} account${open.total === 1 ? '' : 's'} — nothing stuck.` }] : []),
                    ...(openRows.length ? [{ type: 'table', columns: ['Started', 'Host', 'Guest', 'In it', 'Accepted', '', ''], rows: openRows }] : []),
                    ...(practice && openRows.length ? [{ type: 'text', text: 'Practice mode: finishing and deleting need Live (top card).' }] : []),
                ] };
            const accountLines = Object.fromEntries([...accts.values()].map(a => { const me = meOf(a.id);
                return [a.id, [me.tokens != null ? `${short(num(me.tokens))} tokens` : 'Tokens not read yet', busy.has(a.id) ? 'Trading now' : me.membership === 'pro' ? 'Pro' : me.membership ? 'Not Pro (no tokens out)' : '']]; }));
            return { modal: invModal, accountLines, blocks: [
                { type: 'card', id: 'power', toggle: 'on', toggleDisabled: practice ? 'Set the mode to Live first' : null, bodyWhenOff: true, open: !live,
                    title: live ? (busy.size ? 'Trader — on, trading now' : 'Trader — on') : 'Trader — off',
                    summary: !routes.length ? 'add a route first' : practice ? 'practice: nothing is sent unless you press Practice run' : `live · ${routes.length} route${routes.length === 1 ? '' : 's'}, every ${every} min`,
                    keys: ['runMode'], blocks: routes.length ? [{ type: 'buttons', items: running && !practice
                        ? [{ label: routeHalt ? 'Stopping…' : 'Stop', action: 'checkStop', danger: true, disabled: routeHalt }]
                        : [{ label: practice ? 'Practice run' : 'Run now', action: 'check', primary: true }] }] : [] },
                ...problems.map(text => ({ type: 'notice', level: 'warn', text })),
                ...(plans.length ? [{ type: 'table', wrap: true, columns: ['From', 'To', 'The last practice run would', 'When'], rows: plans.slice(0, 15).map(x => [x.from, x.to, x.what, new Date(x.t).toLocaleTimeString()]) }] : []),
                ...(t.trades ? [{ type: 'stats', items: [
                    { label: 'Trades today', value: String(t.trades) },
                    { label: 'Items sent today', value: count(t.items) },
                    { label: 'Tokens sent today', value: count(t.tokens) },
                ] }] : []),
                oneCard,
                fanCard,
                openCard,
                { type: 'card', id: 'routes', open: !routes.length, title: 'Trade routes', summary: routes.length ? `${routes.length} route${routes.length === 1 ? '' : 's'}` : 'none yet',
                    blocks: [
                        ...(mainA && !routes.some(r => r.to === mainA.id) ? [{ type: 'buttons', items: [{ label: `Add a route to your main (${mainA.name})`, action: 'routeToMain' }] }] : []),
                        { type: 'list', key: 'routes', summaries: routes.map(summary) }] },
                { type: 'card', id: 'limits', open: false, title: 'Limits', summary: `keep ${num(S('dailyCap'))} daily trades free`, keys: ['dailyCap'] },
                { type: 'card', id: 'schedule', open: false, title: 'Schedule', summary: `every ${every} min`, keys: ['everyMin'] },
                { type: 'section', title: 'Recent trades', blocks: [{ type: 'table', empty: 'No trades yet.', columns: ['When', 'From', 'To', 'Items', 'Tokens', 'Result'],
                    rows: (state.history || []).slice(0, 10).map(r => [new Date(r.t).toLocaleTimeString(), r.from, r.to, String(r.items), count(r.tokens), r.ok ? 'sent' : r.why]) }] },
            ] };
        });
        ctx.panel.badge((aid) => (busy.has(aid) ? 'Trading' : null));
    },
    stop() { busy.clear(); wanting.clear(); said.clear(); },
};
