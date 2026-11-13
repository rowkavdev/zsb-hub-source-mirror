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
 */

const PAGES_MAX = 60;
const WAIT_RETRY_MS = 60000;   // a pair skipped because another plugin had an account busy is tried again after this

let ctx = null;
let state = null;            // saved: { history: [...], today: { day, trades, tokens, items } }
const busy = new Set();      // accounts in a trade right now
let running = false, lastRun = 0, rerun = false;

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
        if (!tradeId) throw new Error(`couldn't create the trade (HTTP ${cr.status})`);
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
    if (!terms.length && !tokens) return 'Pick what to send: a preset, or item names or tokens.';
    if (!ids.length) return 'Pick who sends: click one or more accounts in the list, or All.';
    if (!byId.get(to).healthy) return `${byId.get(to).name} isn't clicking — start it first.`;
    if (ids.length === 1 && !byId.get(ids[0]).healthy) return `${byId.get(ids[0]).name} isn't clicking — start it first.`;
    if (one && one.running) return 'A trade is going already.';
    return null;
}

// One sender's trade: works out what it sends, then sends it (in practice, only says what it would).
async function sendFrom(from, to, accts, terms, want, tokens, withFavs) {
    const fromName = accts.get(from).name, toName = accts.get(to).name;
    if (!accts.get(from).healthy) return { ok: false, skip: true, text: `${fromName} isn't clicking.` };
    const other = ctx.accounts.busy && (ctx.accounts.busy(from) || ctx.accounts.busy(to));
    if (other || busy.has(from) || busy.has(to)) return { ok: false, text: other ? `${fromName}: waiting — ${other.what} (${other.plugin}). Try again in a moment.` : `${fromName}: in a route trade right now. Try again in a moment.` };
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
    let items = [];
    const parts = [];   // [name, how many of it go]
    if (terms.length) {
        const found = await findAll(from, terms);
        let favsLeft = 0;
        for (const f of found) {
            const pool = withFavs ? [...f.items, ...f.favItems].sort((a, b) => num(b.price) - num(a.price)) : f.items;
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
    if (!items.length && !tk) return { ok: false, skip: true, text: `${fromName} has no tokens to send.` };
    const what = [...parts.filter(p => p[1].length).map(([t, l]) => `${l.length} × ${t}`), tk ? `${count(tk)} tokens` : ''].filter(Boolean).join(' + ');
    const note = notes.length ? ` (${notes.join(', ')})` : '';
    if (ctx.power.practice()) { ctx.log(`${fromName} → ${toName}: practice — would send ${what}`, 'info', from); return { ok: true, what, note }; }
    const mark = (on) => { if (ctx.accounts.setBusy) for (const id of [from, to]) ctx.accounts.setBusy(id, on ? 'trading' : null); };
    mark(true);
    try {
        const rec = await execute(from, to, items, tk, sMe, fromName, toName);
        return rec.ok ? { ok: true, what, note } : { ok: false, text: `${fromName}: the trade didn't go through — ${rec.why}` };
    } finally { mark(false); }
}

// The single trade: each picked sender, one after another, makes one trade to the receiver.
async function sendOne() {
    const accts = new Map(ctx.accounts.list().map(a => [a.id, a]));
    const to = S('oneTo'), ids = senderIds(), toName = accts.get(to).name;
    const terms = oneTerms(), want = amount(S('oneCount'), true), tokens = amount(S('oneTokens'), false), withFavs = !!S('oneFavs');
    const practice = ctx.power.practice();
    const me = one = { t: Date.now(), running: true, done: 0, total: ids.length, results: [], text: ids.length > 1 ? `Getting it ready… 0/${ids.length}` : 'Getting it ready…' };
    for (const id of ids) {
        if (ctx.stopping) break;
        let r;
        try { r = await sendFrom(id, to, accts, terms, want, tokens, withFavs); } catch (e) { r = { ok: false, text: `${accts.get(id).name}: ${e.message}` }; }
        const name = accts.get(id).name;
        me.results.push({ name, ...r, text: r.ok ? `${practice ? 'would send' : 'sent'} ${r.what}${r.note}` : r.text });
        me.done++;
        if (ids.length > 1) me.text = `${practice ? 'Working it out' : 'Sending'}… ${me.done}/${ids.length}`;
        if (r.stop) break;
    }
    const ok = me.results.filter(r => r.ok), skipped = me.results.filter(r => r.skip), failed = me.results.filter(r => !r.ok && !r.skip);
    if (ids.length === 1 && me.results.length === 1) {
        const r = me.results[0];
        me.text = !r.ok ? r.text : practice ? `Practice — would send ${r.what} from ${r.name} to ${toName}${r.note}. Set the mode to Live to send it.`
            : `Sent ${r.what} from ${r.name} to ${toName}${r.note}.`;
        me.ok = r.ok; me.results = [];
    } else {
        const tail = [skipped.length ? `${skipped.length} had nothing to send` : '', failed.length ? `${failed.length} failed` : ''].filter(Boolean).join(' · ');
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

async function check() {
    if (running) { rerun = true; return; }
    running = true; lastRun = Date.now();
    let waited = false;
    try {
        const accts = ctx.accounts.list(), byId = new Map(accts.map(a => [a.id, a]));
        const done = new Set();
        for (const route of S('routes') || []) {
            const to = byId.get(route.to);
            if (!to) continue;
            if (!to.healthy) { ctx.log(`route to ${to.name}: not clicking, skipped`); continue; }
            const from = accts.filter(a => a.id !== to.id && (route.from.all || (route.from.ids || []).includes(a.id)));
            for (const a of from) {
                if (ctx.stopping) return;
                if (done.has(a.id) || busy.has(a.id) || !a.healthy) continue;
                // Another plugin has either side tied up (opening cases, playing games): this pair waits for the
                // next check. While trading, both are marked so they wait for the trade in turn.
                const other = !ctx.power.practice() && ctx.accounts.busy && (ctx.accounts.busy(a.id) || ctx.accounts.busy(to.id));
                if (other) { waited = true; ctx.log(`${a.name} → ${to.name}: waiting — ${other.what} (${other.plugin})`, 'info', a.id); continue; }
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
        if (rerun) { rerun = false; setTimeout(() => { if (!ctx.stopping && ctx.power.live()) check(); }, 1000); }
        else if (waited) setTimeout(() => { if (!ctx.stopping && ctx.power.live()) check(); }, WAIT_RETRY_MS);   // a busy account: try again soon
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
        });
        ctx.settings.onChange((k) => { if (k === 'routes' || k === 'on' || k === 'runMode') lastRun = 0; });
        ctx.panel.action('check', () => {
            if (!(S('routes') || []).length) return { ok: false, error: 'Add a route first.' };
            lastRun = 0; check(true);
            return { message: running ? 'Already checking — it goes again right after.' : ctx.power.practice() ? 'Checking routes — the plan shows up here in a moment.' : 'Checking routes now.' };
        });
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
            const oneWhat = [term ? `${oneCount === 'all' ? 'all' : Number.isNaN(oneCount) ? '?' : count(oneCount)}${terms.length > 1 ? ' of each' : ''} × ${term}` : '', tokTxt].filter(Boolean).join(' + ');
            const each = fromIds.length > 1 ? ' each' : '';
            const oneWhy = oneProblem(), preset = presetNow();
            const oneCard = { type: 'card', id: 'one', open: true, title: 'Single trade',
                summary: fromIds.length && toA && oneWhat ? `${oneWhat}${each} · ${fromTxt} → ${toA.name}` : 'send by hand, from one account or many',
                blocks: [
                    { type: 'section', title: '1. Send to', blocks: [{ type: 'settings', keys: ['oneTo'], bare: true },
                        ...(mainA && oneTo !== mainA.id ? [{ type: 'buttons', items: [{ label: `Your main: ${mainA.name}`, action: 'oneToMain' }] }] : []),
                        ...(mainA && oneTo === mainA.id ? [{ type: 'text', text: 'Your main account.' }] : [])] },
                    { type: 'section', title: '2. What to send', text: 'Pick a preset, or Custom and type it. Each sender sends its own.',
                        blocks: [
                            { type: 'picker', action: 'onePreset', tag: 'Picked', grid: true, items: PRESETS.map(p => ({ id: p.id, on: p.id === preset, title: p.title, sub: p.sub })) },
                            { type: 'settings', keys: ['oneItem', 'oneCount', 'oneFavs', 'oneTokens'] },
                            { type: 'text', text: 'Items: type a name and press Enter (or click away), then the next. Click a name to take it out.' },
                            { type: 'text', text: 'Tokens take 500K, 2.5M, 1B or "all", and only go from Pro senders (a basic sender still sends the item).' },
                        ] },
                    { type: 'section', title: '3. Send from', text: term ? `Pick one or more. Look up shows how many of ${terms.length > 1 ? 'the items' : 'the item'} each account has.` : "Pick one or more. Each account's tokens are shown.",
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
                    { type: 'section', title: '4. Send', blocks: [
                        ...(oneWhy && !(one && one.running) ? [{ type: 'notice', text: oneWhy }]
                            : [{ type: 'text', text: `${oneWhat}${each} from ${fromTxt} to ${toA ? toA.name : '?'}${fromIds.length > 1 ? ` — ${fromIds.length} trades, one after another` : ''}.` }]),
                        { type: 'buttons', items: [{ label: practice ? 'Practice send' : fromIds.length > 1 ? `Send ${fromIds.length} trades` : 'Send trade', action: 'oneSend', primary: true,
                            ...(practice ? {} : { confirm: fromIds.length > 1 ? `Send ${fromIds.length} trades now? Trades can't be undone.` : "Send this trade now? A trade can't be undone." }) }] },
                        ...(practice ? [{ type: 'text', text: 'Practice mode: it only says what it would send. Set the mode to Live (top card) to send for real.' }] : []),
                        ...(one ? [{ type: 'notice', level: one.running ? '' : one.ok ? 'ok' : 'warn', text: one.text }] : []),
                        ...(one && one.results && one.results.length ? [{ type: 'table', wrap: true, columns: ['Sender', practice ? 'Would' : 'Result'], rows: one.results.map(r => [r.name, r.text]) }] : []),
                    ] },
                ] };
            return { blocks: [
                { type: 'card', id: 'power', toggle: 'on', toggleDisabled: practice ? 'Set the mode to Live first' : null, bodyWhenOff: true, open: !live,
                    title: live ? (busy.size ? 'Trader — on, trading now' : 'Trader — on') : 'Trader — off',
                    summary: !routes.length ? 'add a route first' : practice ? 'practice: nothing is sent unless you press Check' : `live · ${routes.length} route${routes.length === 1 ? '' : 's'}, every ${every} min`,
                    keys: ['runMode'], blocks: routes.length ? [{ type: 'buttons', items: [{ label: practice ? 'Practice run' : 'Check now', action: 'check', primary: true }] }] : [] },
                ...problems.map(text => ({ type: 'notice', level: 'warn', text })),
                ...(plans.length ? [{ type: 'table', wrap: true, columns: ['From', 'To', 'The last practice check would', 'When'], rows: plans.slice(0, 15).map(x => [x.from, x.to, x.what, new Date(x.t).toLocaleTimeString()]) }] : []),
                ...(t.trades ? [{ type: 'stats', items: [
                    { label: 'Trades today', value: String(t.trades) },
                    { label: 'Items sent today', value: count(t.items) },
                    { label: 'Tokens sent today', value: count(t.tokens) },
                ] }] : []),
                oneCard,
                { type: 'card', id: 'routes', open: !routes.length, title: 'Trade routes', summary: routes.length ? `${routes.length} route${routes.length === 1 ? '' : 's'}` : 'none yet',
                    blocks: [
                        ...(mainA && !routes.some(r => r.to === mainA.id) ? [{ type: 'buttons', items: [{ label: `Add a route to your main (${mainA.name})`, action: 'routeToMain' }] }] : []),
                        { type: 'list', key: 'routes', summaries: routes.map(summary) }] },
                { type: 'card', id: 'limits', open: false, title: 'Limits and schedule', summary: `keep ${num(S('dailyCap'))} daily trades free · every ${every} min`, keys: ['dailyCap', 'everyMin'] },
                { type: 'section', title: 'Recent trades', blocks: [{ type: 'table', empty: 'No trades yet.', columns: ['When', 'From', 'To', 'Items', 'Tokens', 'Result'],
                    rows: (state.history || []).slice(0, 10).map(r => [new Date(r.t).toLocaleTimeString(), r.from, r.to, String(r.items), count(r.tokens), r.ok ? 'sent' : r.why]) }] },
            ] };
        });
        ctx.panel.badge((aid) => (busy.has(aid) ? 'Trading' : null));
    },
    stop() { busy.clear(); },
};
