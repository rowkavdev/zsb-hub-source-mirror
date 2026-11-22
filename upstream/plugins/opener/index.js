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
 * A tool, not a schedule: Practice run shows what it would do; Open now buys once and opens all of it, in turns of
 * RUN_MS with a short break between them so other plugins get the account (later turns only open, never buy again).
 */

const PRESET = 'ZSB Hub opener';
// Drops' value as a share of what the opened cases cost (each case at its shop price, bought now or earlier).
const pct = (value, cost) => Math.round(100 * value / cost) + '%';
const NO_CAP = 999999;   // autosellAmount is a value cap: drops worth more are kept
// Opens (from the site's API description, 2026-11-18): each runs under the account's lock, shared by every money and
// inventory action (clicks too); one sent while it's held is refused with 400 "User is locked". The lock is free
// once the answer is back, so the next open goes right then — there used to be a flat 300 ms pause after each one
// (a tester at 42×2 ran at 77 cases/s, ~0.3 s of each 1.1 s open was that pause). A lock refusal (a click batch
// landing at the same moment) is tried again after LOCK_RETRY_MS without counting as a failure, up to
// MAX_LOCK_RETRIES in a row; a 429 waits the site's Retry-After (else RATE_WAIT_S), up to MAX_RATE_WAITS in a row.
const LOCK_RETRY_MS = 250, MAX_LOCK_RETRIES = 40, RATE_WAIT_S = 30, MAX_RATE_WAITS = 10;
const LOCKED = /user is locked/i;
const CATALOG_MS = 30 * 60 * 1000;
// The shop's lists: read once for every account at a time (a dozen runs starting together each read it and got
// refused, a tester 2026-11-19), tried CATALOG_TRIES times with a fresh build id (a site update changes it).
const CATALOG_TRIES = 3, CATALOG_RETRY_MS = 5000;
// An account that stops clicking normally for a while (a Cloudflare check, its proxy down, a re-login, the site
// paused, a busy test) is waited for up to BACK_WAIT_MS before its run stops; one stopped by the user stops at once.
const BACK_WAIT_MS = 5 * 60000, BACK_POLL_MS = 2000;
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
const tix = new Map();       // aid -> event tickets it had when last read
const prog = new Map();      // aid -> { item, opened, left, openMs, value, t0, result, at }
const jobs = new Map();      // aid -> { practice, cont, at }: an Open now / Practice run still to run (cont: only open, don't buy)
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
    // An event skin (opened with event tickets): Skin.event { name, gradient } — its name, and the gradient's first colour.
    event: s.event && s.event.name ? String(s.event.name).slice(0, 100) : '',
    eventColor: s.event && (/#([0-9a-f]{6})\b/i.exec(String(s.event.gradient || '')) || [])[1] || '',
});
// The site's picture rule (its icon resolver): "-…" is a Steam economy image, "/…" and https are as they are,
// anything else is under /pictures/skins/. Discord fetches it, so it must be a full https URL.
// ---- Check drops: the favourited drops of each account, for the page's viewer ----
// Kept in the plugin's data (DROPS_KEEP newest per account), each marked seen once the viewer has shown it; the
// "Check drops" button counts the unseen ones. The viewer is the page's modal: a reel of cards per account, newest
// first; the same item from one multi-open is one stack (×N), and a click on a card lists each of its items.
const DROPS_KEEP = 200;
const BOOT = Date.now().toString(36);   // hookOpenSeq starts again with the plugin: opens are BOOT.seq
let dropsView = null;                   // null: closed | { pick: a stack's key or null, fresh: ids that were unseen when it opened }
function keepDrop(aid, d) {
    const all = state.drops || (state.drops = {});
    const list = all[aid] || (all[aid] = []);
    state.dropSeq = (state.dropSeq || 0) + 1;
    list.unshift({ ...d, open: BOOT + '.' + d.open, id: state.dropSeq.toString(36), seen: false });
    if (list.length > DROPS_KEEP) list.length = DROPS_KEEP;
}
const unseenDrops = () => Object.values(state.drops || {}).reduce((t, l) => t + l.filter(d => !d.seen).length, 0);
const stackOf = (aid, d) => aid + '|' + d.open + '|' + d.name;
// Hubs before 1.2.16 show no count on a button: there it goes in the label.
const coreAtLeast = (v) => { const a = String(ctx.coreVersion || '0').split('-')[0].split('.').map(Number), b = v.split('.').map(Number); for (let i = 0; i < 3; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; return true; };
const priceText = (n) => '$' + num(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// A drop -> an item card (the panel's items block): weapon over skin name, wear and float, price, rarity stripe.
function dropCard(d, id, n, fresh) {
    const full = String(d.name || 'Item'), m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(full), base = m ? m[1] : full, wear = m ? m[2] : '';
    const [title, sub] = base.includes(' | ') ? [base.slice(0, base.indexOf(' | ')), base.slice(base.indexOf(' | ') + 3)] : ['', base];
    const fl = Number(d.float), one = n === 1;
    return {
        id, title, sub, image: iconUrl(d.icon), color: String(d.eventColor || d.color || '').replace(/^#/, ''),
        price: one ? priceText(d.price) : priceText(d.price * n),
        detail: [wear, one && d.float != null && Number.isFinite(fl) ? String(fl) : ''].filter(Boolean).join(' · '),
        tags: [fresh ? 'New' : '', d.event || '', d.pattern || ''].filter(Boolean),
        ...(one ? {} : { qty: { n: 0, of: n } }),
        hint: `${full}${d.from ? ` — from ${d.from}` : ''}${one ? '' : ` — ${n} in one open, click to see each`}`,
    };
}
function dropsModal() {
    if (!dropsView) return null;
    const names = (aid, l) => (ctx.accounts.get(aid) || {}).name || (l[0] && l[0].acct) || aid;
    const all = Object.entries(state.drops || {}).filter(([, l]) => l.length);
    const close = { title: 'Favourited drops', close: 'dropsClose' };
    if (dropsView.pick) {
        const aid = dropsView.pick.split('|')[0], l = (state.drops || {})[aid] || [];
        const items = l.filter(d => stackOf(aid, d) === dropsView.pick);
        if (!items.length) { dropsView.pick = null; return dropsModal(); }
        const d0 = items[0];
        return { ...close, blocks: [
            { type: 'bar', items: [{ label: '← All drops', action: 'dropsBack' }], text: `${names(aid, l)} · ${items.length > 1 ? `${items.length}× ` : ''}${d0.name} · ${new Date(d0.t).toLocaleString()}` },
            { type: 'items', action: 'dropsPick', items: items.map(d => dropCard(d, 'one|' + d.id, 1, dropsView.fresh.has(d.id))) },
            { type: 'table', wrap: true, columns: ['Float', 'Price', 'Pattern', 'Event', 'From'],
                rows: items.map(d => [d.float != null ? String(d.float) : '—', priceText(d.price), d.pattern || '—', d.event || '—', d.from || '—']) },
        ] };
    }
    if (!all.length) return { ...close, blocks: [{ type: 'text', text: 'No favourited drops yet. They show up here as the Opener keeps them (Auto-favourite, step 3).' }] };
    return { ...close, blocks: [
        { type: 'bar', items: [{ label: 'Clear all', action: 'dropsClear', danger: true, confirm: 'Clear the list of favourited drops? The items stay in the accounts — only this list is emptied.' }],
            text: 'Newest first. The same item from one open is one card (×N) — click a card to see each item.' },
        ...all.sort((a, b) => num(b[1][0].t) - num(a[1][0].t)).map(([aid, l]) => {
            const stacks = new Map();
            for (const d of l) { const k = stackOf(aid, d); if (!stacks.has(k)) stacks.set(k, []); stacks.get(k).push(d); }
            const fresh = l.filter(d => dropsView.fresh.has(d.id)).length;
            const worth = l.reduce((t, d) => t + num(d.price), 0);
            return { type: 'section', title: `${names(aid, l)} · ${count(l.length)} drop${l.length === 1 ? '' : 's'}${fresh ? ` (${count(fresh)} new)` : ''} · ${money(worth)}`,
                blocks: [{ type: 'items', reel: true, action: 'dropsPick', items: [...stacks].map(([k, g]) => dropCard(g[0], k, g.length, g.some(d => dropsView.fresh.has(d.id)))) }] };
        }),
    ] };
}

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
    const color = parseInt(String(d.eventColor || d.color).replace(/^#/, ''), 16);   // an event drop: the event's colour
    const img = iconUrl(d.icon);
    return {
        title: ((d.event ? `${d.event} · ` : '') + d.name + (g.length > 1 ? `  ×${g.length}` : '')).slice(0, 256),
        color: Number.isFinite(color) && color >= 0 && color <= 0xffffff ? color : 0xd4a017,
        fields: [
            { name: g.length > 1 ? `Floats (${g.length})` : 'Float', value: lines.join('\n').slice(0, 1024) },
            ...(d.event ? [{ name: 'Event', value: d.event, inline: true }] : []),
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
        const k = d.open + '\u0000' + d.acct + '\u0000' + d.name + '\u0000' + d.event;   // event drops apart from plain ones
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

// Waits for the account to click normally again (see BACK_WAIT_MS): true when it's back, else a Stop saying why.
async function waitBack(aid) {
    const limit = num(S('backWaitMs')) || BACK_WAIT_MS, from = Date.now();
    let said = false;
    for (;;) {
        if (halted()) throw new Stop(ctx.stopping ? 'turned off' : 'stopped by you');
        const a = ctx.accounts.get(aid);
        if (!a || !a.running) throw new Stop('the account stopped clicking');
        if (a.healthy) { if (said) ctx.log(`the account is back after ${Math.round((Date.now() - from) / 1000)} s — going on`, 'ok', aid); return true; }
        if (Date.now() - from >= limit) throw new Stop(`the account wasn't clicking normally for ${Math.round(limit / 60000)} min (a Cloudflare check, its proxy down or a re-login) — run it again when it's back`);
        if (!said) { said = true; ctx.log(`the account isn't clicking normally right now (a Cloudflare check, its proxy or a re-login?) — waiting up to ${Math.round(limit / 60000)} min for it`, 'warn', aid); }
        await ctx.sleep(BACK_POLL_MS);
    }
}

async function req(aid, path, opts) {
    for (;;) {
        const r = await ctx.request(aid, path, opts);
        if (r.kind === 'not-running' || r.kind === 'cf') { await waitBack(aid); continue; }
        if (r.kind === 'auth') throw new Stop('logged out');
        return r;
    }
}
const getJson = async (aid, path) => { const r = await req(aid, path); if (r.kind !== 'ok') throw new Stop(`HTTP ${r.status} on ${path.split('?')[0]}`); return r.json; };

// The shop's page data. pageProps.cases is a JSON string of { _id, name, price, rankNeeded, isNonBuyable, ... }.
// What came back instead of the list, for the message: the status and the start of a body that isn't JSON.
const answerOf = (r) => `HTTP ${r.status || r.kind}${r.json ? '' : r.body ? ': ' + String(r.body).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) : ''}`;
let catalogJob = null;
async function refreshCatalog(aid, force) {
    if (!force && catalog.items && Date.now() - catalog.at < (num(S('catalogMs')) || CATALOG_MS)) return;
    const own = !catalogJob;
    if (own) catalogJob = readCatalog(aid).finally(() => { catalogJob = null; });
    try { return await catalogJob; }
    catch (e) { if (own || e.shop) throw e; return refreshCatalog(aid, force); }   // the reading account stopped (not the shop failing): read it as this one
}
async function readCatalog(aid) {
    let why = '';
    for (let i = 0; i < CATALOG_TRIES; i++) {
        if (i) await ctx.sleep(num(S('catalogRetryMs')) || CATALOG_RETRY_MS * i);
        const home = await req(aid, '/');
        const m = /"buildId"\s*:\s*"([^"]+)"/.exec(home.body || '');
        if (!m) { why = `the shop page had no build id (${answerOf(home)})`; continue; }
        catalog.build = m[1];
        const items = [];
        why = '';
        for (const [file, type, kind] of LISTS) {
            const r = await req(aid, `/_next/data/${catalog.build}/en/cases/${file}.json?cases=${file}`);
            const raw = r.json && r.json.pageProps && r.json.pageProps.cases;
            let list = null;
            try { list = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) {}
            if (!Array.isArray(list)) { why = `the shop's ${file} didn't come back (${answerOf(r)})`; break; }
            for (const c of list) if (c && c._id && num(c.price) > 0) items.push({ ...c, type: c.type || type, kind });
        }
        if (why) continue;
        return setCatalog(items);
    }
    throw Object.assign(new Stop(`could not read the shop: ${why}, ${CATALOG_TRIES}× in a row`), { shop: true });
}
function setCatalog(items) {
    catalog.items = items;
    catalog.at = Date.now();
    const order = { Case: 0, Capsule: 1, Collection: 2 };
    const opts = items.slice().sort((a, b) => order[a.kind] - order[b.kind] || num(a.rankNeeded) - num(b.rankNeeded) || num(a.price) - num(b.price))
        .map(c => ({ value: c._id, label: `${c.kind}: ${c.name} — $${num(c.price).toLocaleString('en-US')}${num(c.rankNeeded) > 1 ? ` · rank ${c.rankNeeded}` : ''}${c.isNonBuyable ? ' · not sold, open only' : ''}` }));
    ctx.settings.setOptions('item', opts);
    ctx.settings.setOptions('sets.item', opts);
}

// What happens to drops: the Drops settings, or a job's own (a job queued from the Armory shop with a custom profile).
const wantVariant = (C = S) => (C('drops') === 'tokens' ? 'tokens' : 'money');
const capOf = (C = S) => (num(C('keepOver')) > 0 ? num(C('keepOver')) : NO_CAP);
const sellText = (C = S) => `sold for ${wantVariant(C) === 'tokens' ? 'tokens' : 'cash'}${capOf(C) < NO_CAP ? ` when worth under $${capOf(C).toLocaleString('en-US')}` : ''}`;
const dropsText = (C = S) => (C('drops') === 'keep' ? 'kept' : sellText(C));
// Event tickets (private hub's contract): POST /api/tickets { count } buys them at $0.50 each, /api/me tickets is how
// many the account has, and an open with useEventTickets: true uses one per case. A ticket refusal stops the account.
const TICKET = 0.5;
const ticketsOn = (C = S) => !!C('useTickets');
const ticketBuy = (C = S) => ticketsOn(C) && !!C('buyTickets');
const TICKET_ERR = /ticket/i;
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

const customFloats = (C = S) => (C('customFloats') || []).filter(floatOk).slice(0, MAX_CUSTOM);
function favRules(patterns, C = S) {
    return {
        favoriteLowFloats: !!C('favLow'), customLowFloat: num(C('lowFloat')),
        favoriteHighFloats: !!C('favHigh'), customHighFloat: num(C('highFloat')),
        favoriteCustomFloats: !!C('favCustom'), customSelectedFloats: customFloats(C),
        favoritePatterns: !!C('favPatterns'), patternBlacklist: patterns,
    };
}
// The blacklist with the site's own spelling of each name; names it doesn't know are left out, with a warning.
async function blacklist(aid, log, C = S) {
    const typed = C('patternBlacklist') || [];
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
function favText(rules, C = S) {
    if (!C('favSet')) return "each account's own (set on the site)";
    const r = rules || favRules(C('patternBlacklist') || [], C), bits = [];
    if (r.favoriteLowFloats) bits.push(`floats under ${plain(r.customLowFloat)}`);
    if (r.favoriteHighFloats) bits.push(`floats over ${plain(r.customHighFloat)}`);
    if (r.favoriteCustomFloats && r.customSelectedFloats.length) bits.push(`${r.customSelectedFloats.length} custom float${r.customSelectedFloats.length === 1 ? '' : 's'}`);
    if (r.favoritePatterns) bits.push('patterns' + (r.patternBlacklist.length ? ` (${r.patternBlacklist.length} never)` : ''));
    return bits.length ? bits.join(', ') : 'nothing';
}

// Set the account's auto-open config for this run: auto-sell on (to cash or tokens, up to the keep-over value)
// or off, and the auto-favourite rules from the settings when "Set auto-favourite from here" is on; the
// account's own other choices are kept. Written to the "ZSB Hub opener" preset and checked by reading it back.
async function ensureConfig(aid, log, sell, C = S) {
    const cur = unwrap(await getJson(aid, '/api/user/autoOpen/config'));
    const want = { ...(cur || {}) }, keys = ['autosellActivated'];
    want.autosellActivated = sell;
    if (sell) { want.autosellVariant = wantVariant(C); want.autosellAmount = capOf(C); keys.push(...SELL_KEYS.slice(1)); }
    if (C('favSet')) { Object.assign(want, favRules(await blacklist(aid, log, C), C)); keys.push(...FAV_KEYS); }
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
    log(`auto-open set: ${sell ? `sell drops for ${wantVariant(C) === 'tokens' ? 'tokens' : 'cash'}${capOf(C) < NO_CAP ? ` when worth under $${capOf(C).toLocaleString('en-US')}` : ''}` : 'no auto-sell'}${C('favSet') ? `; favourite ${favText(want, C)}` : ''}`);
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

// Bulk sells go through the site's sell queue (seen 2026-11-17): DELETE /api/inventory answers 202 "queued" straight
// away, then the sell waits its turn and runs. GET /api/queues/status shows it: { jobs: { 'bulk-sell': { state:
// 'queued' (position, total) | 'running' (progress { sold, total, value }) | 'done' (count, value) | 'failed' (error) } } };
// a settled result stays readable for 10 minutes. A tester (2026-11-18): the sell took over 20 minutes, the old fixed
// 20-minute wait gave up and the account stopped "still 90% full" while it was still selling. Now it waits as long as
// the job moves (its place in line or the items sold), giving up only after SELL_STALL_MS without a change (or
// SELL_MAX_MS in all), and says how it's going every SELL_SAY_MS. fresh: a sell was just queued, so a settled job seen
// before an active one may be the last sell's result — it takes a few more reads to count as this one. A site without
// the queue (no such page) returns at once.
const SELL_STALL_MS = 10 * 60000, SELL_MAX_MS = 2 * 3600000, SELL_SAY_MS = 5 * 60000;
async function sellQueue(aid, lane, log, stopped, fresh = false) {
    const t0 = Date.now();
    let quiet = 0, said = false, job = null, seen = false, sig = '', moved = Date.now(), saidAt = Date.now();
    const stall = num(S('sellStallMs')) || SELL_STALL_MS;
    while (Date.now() - t0 < SELL_MAX_MS && (!seen || Date.now() - moved < stall)) {   // before it shows up, the quiet reads end the wait
        if (stopped()) throw new Stop(ctx.stopping ? 'turned off' : 'stopped by you');
        const r = await req(aid, '/api/queues/status');
        if (r.status === 404 || r.status === 405) return null;   // no sell queue on this site
        if (r.kind !== 'ok') { await ctx.sleep(5000); continue; }   // a read that failed: not the end of the sell
        job = (r.json && r.json.jobs && r.json.jobs['bulk-sell']) || null;
        if (job && (job.state === 'queued' || job.state === 'running')) {
            seen = true; quiet = 0;
            const now = JSON.stringify([job.state, num(job.position), job.progress ? num(job.progress.sold) : -1]);
            if (now !== sig) { sig = now; moved = Date.now(); }
            const where = job.state === 'queued' ? `place ${count(num(job.position))} of ${count(num(job.total))} in line`
                : job.progress && num(job.progress.total) ? `${count(num(job.progress.sold))} of ${count(num(job.progress.total))} sold` : 'selling';
            lane.phase = job.state === 'queued' ? `sell queued (${num(job.position)} of ${num(job.total)})` : `selling drops (${where})`;
            if (job.state === 'queued' && !said) { said = true; saidAt = Date.now(); log(`the site queued the sell (${where}) — waiting for it`); }
            else if (Date.now() - saidAt >= SELL_SAY_MS) { saidAt = Date.now(); log(`the site's sell is still going after ${Math.round((Date.now() - t0) / 60000)} min (${where}) — waiting for it`); }
        } else if ((moved = Date.now()), ++quiet >= (fresh && !seen ? 5 : 2)) {   // a settled read is a change: the stall clock restarts
            if (job && job.state === 'failed') log(`the site's sell failed${job.error ? ': ' + job.error : ''}`, 'warn');
            return job;
        }
        await ctx.sleep(seen ? 2000 : 1000);
    }
    log(Date.now() - moved >= stall ? `the site's sell hasn't moved for ${Math.round(stall / 60000)} min — going on without it`
        : `the site's sell is still going after ${SELL_MAX_MS / 3600000} h — going on without it`, 'warn');
    return job;
}
// One bulk sell (DELETE /api/inventory with `type`), sent until the site takes it: 409 "already a sell in the queue"
// waits that one out; 503 "queue full" and 429 (5 bulk sells a minute) wait the site's Retry-After (said once) — they
// used to end as "selling failed" and then "still 90% full". Then waits for the job. -> its last status, or false: not taken.
const SELL_SEND_MS = 30 * 60000;
async function bulkSell(aid, body, lane, log, stopped, what = 'selling the drops') {
    const t0 = Date.now();
    let busySaid = false;
    for (;;) {
        if (stopped()) throw new Stop(ctx.stopping ? 'turned off' : 'stopped by you');
        const r = await req(aid, '/api/inventory', { method: 'DELETE', body });
        if (r.kind === 'ok') return sellQueue(aid, lane, log, stopped, r.status === 202);   // 202 "queued": a job is coming (an old result may show first)
        if (r.status === 409) { await sellQueue(aid, lane, log, stopped); continue; }
        if ((r.status === 503 || r.status === 429) && Date.now() - t0 < SELL_SEND_MS) {
            const wait = Math.min(120, Math.max(1, Number.isFinite(r.retryAfter) ? r.retryAfter : r.status === 503 ? 30 : 15));
            if (!busySaid) { busySaid = true; log(`${what}: the site's sell queue is ${r.status === 503 ? 'full' : 'busy'} — trying again in ${wait} s (and after that until it's taken)`, 'warn'); }
            lane.phase = 'waiting for the sell queue';
            await ctx.sleep(wait * 1000);
            continue;
        }
        log(`${what} failed (${(r.json && r.json.error) || 'HTTP ' + r.status})`, 'warn');
        return false;
    }
}

async function stockOf(aid, id) {
    const cs = await getJson(aid, '/api/cases');
    const it = Array.isArray(cs) ? cs.find(c => c && c._id === id) : null;
    return it ? num(it.amount) : 0;
}

// Sets: other accounts open something else. A set has its own item, buy rules and accounts; an account on a set (the
// first set that has it) opens that set's item, everyone else the main What to open. A set with no item yet doesn't count.
const SET_KEYS = ['item', 'source', 'buyAmount', 'maxPrice', 'keepMoney', 'keepPct', 'spendPerRun', 'useTickets', 'buyTickets'];
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
// Most per Open now only to spare cash. Buying tickets too: each case costs its price plus a ticket.
const budgetOf = (cash, C = S) => {
    const spare = C('source') === 'buy';
    let budget = cash - Math.max(num(C('keepMoney')), spare ? cash * num(C('keepPct')) / 100 : 0);
    if (spare && num(C('spendPerRun')) > 0) budget = Math.min(budget, num(C('spendPerRun')));
    return Math.max(0, budget);
};
function buyCount(cash, price, C = S) {
    if (!(price > 0)) return 0;
    const afford = Math.floor(budgetOf(cash, C) / (price + (ticketBuy(C) ? TICKET : 0)));
    return C('source') === 'buy' ? afford : Math.min(Math.max(0, Math.floor(num(C('buyAmount')))), afford);
}
// A job queued from the Armory shop: opens that item from stock (never buys, no tickets), drops by its own profile
// ({ mode: 'custom', drops, under, fav }) or the Drops settings ('default'). fav: 'opener' (the Auto-favourite card),
// 'own' (leave each account's site rules) or 'custom' (floats under low / over high, patterns; 0 = off).
const MAX_SELL_UNDER = 480000;
function shopCfg(job) {
    const pr = job.profile || {}, custom = pr.mode === 'custom';
    return (k) => {
        if (k === 'item') return job.id;
        if (k === 'source') return 'owned';
        if (k === 'useTickets' || k === 'buyTickets') return false;
        if (custom && k === 'drops') return ['money', 'tokens', 'keep'].includes(pr.drops) ? pr.drops : 'money';
        if (custom && k === 'keepOver') return num(pr.under) > 0 ? Math.min(MAX_SELL_UNDER, num(pr.under)) : MAX_SELL_UNDER;
        const fav = custom && pr.fav && typeof pr.fav === 'object' ? pr.fav : null;
        if (fav && fav.mode === 'own' && k === 'favSet') return false;
        if (fav && fav.mode === 'custom') {
            const low = num(fav.low), high = num(fav.high);
            if (k === 'favSet') return true;
            if (k === 'favLow') return low > 0 && low <= 0.1;
            if (k === 'lowFloat') return low > 0 && low <= 0.1 ? low : num(S(k));
            if (k === 'favHigh') return high >= 0.9 && high < 1;
            if (k === 'highFloat') return high >= 0.9 && high < 1 ? high : num(S(k));
            if (k === 'favCustom') return false;
            if (k === 'customFloats') return [];
            if (k === 'favPatterns') return !!fav.patterns;
        }
        return S(k);
    };
}

async function run(aid, name, practice, cont, shop) {
    const lane = { phase: 'starting', opened: 0, of: 0, halt: false, shop: shop || null };
    lanes.set(aid, lane);
    if (!practice && (!cont || !prog.has(aid))) prog.set(aid, { item: '', opened: 0, left: null, openMs: 0, value: 0, t0: Date.now(), result: '', at: 0 });
    const p = practice ? {} : prog.get(aid);
    if (!practice) { p.result = ''; p.at = 0; p.shop = !!shop; }
    const plan = [];
    const log = (msg, level = 'info') => { if (practice && /^would /.test(msg)) plan.push(msg.replace(/^would /, '')); ctx.log((practice ? 'practice — ' : '') + msg, level, aid); };
    // cost: what the opened cases cost at the shop price (stock included); pv: the drops' value from those (items the shop
    // doesn't sell have no price, so they're left out of the % — their value still counts in "drops worth").
    const rec = { t: Date.now(), acct: name, item: '', spent: 0, opened: 0, value: 0, cost: 0, pv: 0, favs: 0, xp: 0, rank: '', result: '', tickets: 0, ticketCost: 0, ...(shop ? { from: 'shop' } : {}) };
    let start = null, item = null;
    const C = shop ? shopCfg(shop) : cfgOf(aid);   // a shop job's own, its set's item and buy rules, or the main ones
    const useT = ticketsOn(C), buyT = ticketBuy(C);
    let tickets = 0;
    try {
        start = await getJson(aid, '/api/me');
        tickets = num(start.tickets); tix.set(aid, tickets);
        if (!practice) p.tickets = useT ? tickets : null;
        await refreshCatalog(aid);
        // A shop job's item: from the shop list when it's sold there too (its price counts for the %), else as queued.
        item = catalog.items.find(c => c._id === C('item')) || (shop ? { _id: shop.id, name: shop.name || 'item', type: shop.type, price: 0, rankNeeded: 0, isNonBuyable: true } : null);
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
        // Event tickets for the cases about to open: buys what's missing (Buy tickets on), within Keep cash and Most to
        // spend (what this job spent already counts). Without enough it opens what the tickets cover, then stops.
        const ticketStep = async (need) => {
            if (!useT || need <= tickets) return;
            const short = need - tickets;
            if (!buyT) { log(`${count(tickets)} event ticket${tickets === 1 ? '' : 's'} for ${count(need)} ${item.name} — it stops when they run out`, 'warn'); return; }
            const cash = practice ? num(start.money) - rec.spent : num((await getJson(aid, '/api/me')).money);
            let budget = budgetOf(cash, C);
            if (C('source') === 'buy' && num(C('spendPerRun')) > 0) budget = Math.min(budget, Math.max(0, num(C('spendPerRun')) - rec.spent));
            const n = Math.min(short, Math.floor(budget / TICKET));
            if (n <= 0) { log(`no cash to spare for event tickets (${count(short)} short, $${TICKET} each) — it stops when they run out`, 'warn'); return; }
            if (practice) { log(`would buy ${count(n)} event ticket${n === 1 ? '' : 's'} for ${money(n * TICKET)}`); tickets += n; rec.spent += n * TICKET; return; }
            const pre = num((await getJson(aid, '/api/me')).money);
            const r = await req(aid, '/api/tickets', { method: 'POST', body: { count: n } });
            const me = await getJson(aid, '/api/me');
            const spent = Math.max(0, pre - num(me.money));
            rec.spent += spent; rec.ticketCost += spent;
            tickets = num(me.tickets); p.tickets = tickets; tix.set(aid, tickets);
            if (r.kind !== 'ok' || (r.json && r.json.error)) throw new Stop(`event tickets: ${(r.json && r.json.error) || 'HTTP ' + r.status}${spent ? '' : ', nothing was charged'}`);
            log(`bought ${count(n)} event ticket${n === 1 ? '' : 's'} for ${money(spent)}`, 'ok');
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
            const keep = C('drops') === 'keep';
            // Selling without auto-sell (non-Pro): open into the inventory and sell the drops before it passes 90%.
            const bySell = !keep && start.membership !== 'pro';
            const inv = { size: num(start.inventorySize), used: num(start.inventoryCount) };
            const room = () => Math.floor(inv.size * INV_FILL) - inv.used;
            if (keep && num(start.inventorySize) && num(start.inventoryCount) + stock > num(start.inventorySize)) {
                stock = Math.max(0, num(start.inventorySize) - num(start.inventoryCount));
                log(`the inventory has room for ${count(stock)} more drops — opening only that many`, 'warn');
            }
            const what = 'drops ' + dropsText(C) + (C('favSet') ? `, favouriting ${favText(null, C)}` : '') + (useT ? ', with event tickets' : '');
            await ticketStep(stock);
            if (practice && boostKinds().length) log(`would keep ${boostKinds().map(k => ({ caseOpenCountBoost: 'an open-count boost', caseOpenMultiplierBoost: 'a multiplier boost', caseOpenCashback: 'case-open cashback' })[k]).join(', ')} running while opening${S('boostBuy') ? ', buying with ammo when there are none' : ''}`);
            if (practice) log(`would open ${count(stock)} ${item.name} (${perCall}×${mult} at a time), ${what}${bySell ? ` — no auto-sell without Pro: into the inventory (${count(inv.used)} of ${count(inv.size)} used), sold at 90% full` : ''}`);
            else if (stock > 0) {
                if (bySell && !inv.size) throw new Stop('the site did not say how big the inventory is — not opening');
                // Auto-open: selling (Pro), or only favouriting when the rules are set from here.
                const auto = (!keep && !bySell) || !!C('favSet');
                if (auto) await ensureConfig(aid, log, !keep && !bySell, C);
                const sellDrops = async () => {
                    lane.phase = 'selling drops';
                    const stopped = () => halted() || lane.halt;
                    await bulkSell(aid, { type: 'price', value: Math.min(capOf(C), 499999), currency: wantVariant(C) }, lane, log, stopped);
                    const m = await settled(aid, inv.used);
                    inv.used = num(m.inventoryCount); inv.size = num(m.inventorySize) || inv.size;
                    rec.sells = (rec.sells || 0) + 1;
                    lane.phase = 'opening';
                };
                let fails = 0, full = 0, locks = 0, rates = 0, sizeSaid = '';
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
                    // Out of event tickets: this account stops (what's left stays in stock).
                    if (useT && tickets <= 0) { tickets = num((await getJson(aid, '/api/me')).tickets); p.tickets = tickets; tix.set(aid, tickets); }
                    if (useT && tickets <= 0) throw new Stop(`out of event tickets — ${count(stock)} ${item.name} left to open`);
                    // Fewer than a full open left (or fewer tickets): open what there is.
                    const can = useT ? Math.min(stock, tickets) : stock;
                    const c = Math.min(perCall, can), m = Math.max(1, Math.min(mult, Math.floor(can / c)));
                    // The open size, said when the run starts and whenever a boost changes it.
                    if (sizeSaid !== perCall + '×' + mult) {
                        log(`${sizeSaid ? 'open size now' : `opening ${count(stock)} ${item.name},`} ${perCall}×${mult} at a time (${count(perCall * mult)} per open)`);
                        sizeSaid = perCall + '×' + mult;
                    }
                    if (bySell && room() < c * m) {
                        await sellDrops();
                        if (room() < c * m) throw new Stop(`the inventory is still ${Math.round(inv.used / inv.size * 100)}% full after selling the drops — make room, then run again`);
                    }
                    const body = { id: item._id, quickOpen: true, count: String(c), useEventTickets: useT, caseOpenMultiplier: m, autoOpen: auto };
                    const r = await ctx.request(aid, '/api/open/' + item.type, { method: 'POST', body });
                    if (r.kind === 'ok' && !(r.json && r.json.error)) {
                        stock -= c * m; lane.opened += c * m; rec.opened += c * m; p.opened += c * m; p.left = stock; fails = 0; full = 0; locks = 0; rates = 0;
                        rec.calls = (rec.calls || 0) + 1; rec.ms = (rec.ms || 0) + (Date.now() - t0);
                        if (bySell) inv.used += c * m;
                        if (useT) { tickets -= c * m; rec.tickets += c * m; p.tickets = tickets; tix.set(aid, tickets); }
                        const j = r.json;
                        const v = Array.isArray(j) ? j.reduce((t, x) => t + num(x && x.price), 0) : num(j && j.totalValue);
                        rec.value += v; p.value += v;
                        // What they cost: the shop price, plus a ticket each when opened with tickets.
                        if (num(item.price) > 0) { rec.cost += c * m * (num(item.price) + (useT ? TICKET : 0)); rec.pv += v; }
                        if (j && !Array.isArray(j)) {
                            const oid = ++hookOpenSeq;
                            if (Array.isArray(j.favoritedSkins) && j.favoritedSkins.length) setTimeout(save, 0);   // the drops list, once this open's are in
                            for (const f of Array.isArray(j.favoritedSkins) ? j.favoritedSkins : []) { rec.favs++; const d = hookDrop(f, (ctx.accounts.get(aid) || {}).name || aid, item.name, oid); keepDrop(aid, d); hookPush(d); log(`kept a favourited drop: ${f.event && f.event.name ? f.event.name + ' ' : ''}${f.name || 'a skin'}${f.price ? ` ($${num(f.price).toLocaleString('en-US')})` : ''}`, 'ok'); }
                        }
                        if (lane.opened % (perOpen * 25) < c * m) {
                            stock = await stockOf(aid, item._id); p.left = stock; save();
                            if (bySell || useT) {
                                const me = await getJson(aid, '/api/me');
                                if (bySell) inv.used = num(me.inventoryCount);   // drops can count more than the math says
                                if (useT) { tickets = num(me.tickets); p.tickets = tickets; tix.set(aid, tickets); }
                            }
                        }
                    } else {
                        if (r.kind === 'not-running' || r.kind === 'cf') { await waitBack(aid); p.openMs += Date.now() - t0; continue; }   // paused: wait for it (see BACK_WAIT_MS)
                        if (r.kind === 'auth') throw new Stop('logged out');
                        const msg = String((r.json && r.json.error) || '');
                        // The site won't open with tickets (none left, no event on): this account stops.
                        if (useT && TICKET_ERR.test(msg)) throw new Stop('event tickets: ' + msg);
                        if (bySell && INV_FULL.test(msg)) {   // full after all: sell now, but not forever
                            if (++full > FULL_RETRIES) throw new Stop(`the site keeps refusing opens after selling the drops: ${msg}`);
                            inv.used = inv.size; continue;
                        }
                        if (LOCKED.test(msg)) {   // something else held the account's lock for a moment: just send it again
                            if (++locks > MAX_LOCK_RETRIES) throw new Stop(`the site kept the account locked for ${locks} opens in a row — something else is using it (opening on the site, a trade, another tool?)`);
                            await ctx.sleep(LOCK_RETRY_MS);
                            p.openMs += Date.now() - t0;
                            continue;
                        }
                        if (r.kind === 'rate') {
                            const wait = Math.min(120, Math.max(1, Number.isFinite(r.retryAfter) ? r.retryAfter : RATE_WAIT_S));
                            if (++rates > MAX_RATE_WAITS) throw new Stop(`the site refused opens as too many ${rates}× in a row`);
                            if (rates === 1) log(`the site says too many opens — waiting ${wait} s`, 'warn');
                            await ctx.sleep(wait * 1000);
                            continue;
                        }
                        if (++fails >= MAX_OPEN_FAILS) throw new Stop(`opening failed ${fails}× in a row (${(r.json && r.json.error) || 'HTTP ' + r.status})`);
                        await ctx.sleep(2000 * fails);
                        stock = await stockOf(aid, item._id); p.left = stock;
                    }
                    if (num(S('openGapMs'))) await ctx.sleep(num(S('openGapMs')));   // tests only: slows a run down to watch it
                    p.openMs += Date.now() - t0;
                }
                // Stock first: the stock is open — sell its drops (non-Pro) for the cash, buy the set amount, open that.
                if (stock > 0 || !stockFirst || p.bought || halted() || lane.halt) break;
                if (bySell && rec.opened) await sellDrops();
                await buyStep(num((await getJson(aid, '/api/me')).money));
                await ticketStep(stock);
                lane.phase = 'opening';
                if (stock <= 0) break;
                lane.of = lane.opened + stock; p.left = stock;
                }
                if (bySell && rec.opened) await sellDrops();
                log(`opened ${count(rec.opened)} ${item.name}${rec.sells ? ` (no auto-sell: sold the drops ${rec.sells}×)` : ''}${rec.tickets ? ` with ${count(rec.tickets)} event tickets` : ''} — drops worth ${money(rec.value)}${rec.cost ? ` (${pct(rec.pv, rec.cost)} of what they cost${rec.tickets ? ', tickets included' : ''})` : ''}${rec.calls ? ` · ${count(Math.round(rec.ms / rec.calls))} ms per open` : ''}`, 'ok');
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
                        for (const k of ['opened', 'spent', 'value', 'xp', 'cost', 'pv', 'tickets']) it[k] = (it[k] || 0) + rec[k];
                    }
                }
            } catch (_) {}
        }
        const t = today();
        for (const k of ['spent', 'opened', 'value', 'xp', 'favs', 'cost', 'pv', 'tickets']) t[k] = (t[k] || 0) + rec[k];
        state.last[aid] = Date.now();
        state.runs = [rec, ...(state.runs || [])].slice(0, 30);
        // The job goes on after a break while there's more to open; otherwise it's done.
        if (!practice && rec.left > 0 && !halted() && !lane.halt) jobs.set(aid, { practice: false, cont: true, at: Date.now() + (num(S('turnMs')) ? 500 : BREAK_MS), shop: shop || null });
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

// Runs the jobs started from the page (Open now / Practice run), a few accounts at a time.
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

// ---- Jobs queued from the Armory shop ----
// The Armory publishes ctx.shared "armory/openQueue": [{ qid, item: { id, type, name }, accounts: [aid], profile }].
// Each new one becomes a job per account (state.shop, saved across restarts), and its qid goes on "opener/taken" so
// the Armory knows it's here. A shop job starts once its account is free (not opening anything else here), then
// waits its turn like any other: the same lanes, IP limit and other plugins' turns.
const MAX_SEEN = 200;
const SHOP_TYPES = ['case', 'capsule', 'collectionCase', 'keychainCollection'];
function takeShop() {
    if (!ctx.shared) return;
    const q = ctx.shared.get('armory/openQueue');
    const seen = state.shopSeen || [];
    let changed = false;
    for (const e of Array.isArray(q) ? q : []) {
        if (!e || !e.qid || seen.includes(e.qid) || !e.item || !e.item.id) continue;
        seen.push(e.qid); changed = true;
        if (!SHOP_TYPES.includes(e.item.type)) { ctx.log(`not queued from the Armory shop: ${e.item.name || 'an item'} isn't something the Opener can open`, 'warn'); continue; }
        for (const aid of Array.isArray(e.accounts) ? e.accounts.map(String) : []) {
            if (!ctx.accounts.get(aid)) continue;
            (state.shop = state.shop || []).push({ qid: String(e.qid), aid, id: String(e.item.id), type: e.item.type, name: String(e.item.name || '').slice(0, 120), profile: e.profile || { mode: 'default' }, t: Date.now() });
            ctx.log(`queued from the Armory shop: open the ${e.item.name || 'item'} in stock when it's free`, 'info', aid);
        }
    }
    if (changed) { state.shopSeen = seen.slice(-MAX_SEEN); save(); }
    ctx.shared.set('taken', state.shopSeen || []);
    ctx.shared.set('drops', dropsText());   // the Armory shop's "Opener's Drops setting" says what that is
    ctx.shared.set('favs', favText());      // ...and what the Opener favourites
}
// The account's next queued shop job becomes its job once nothing else of the Opener's is running or waiting on it.
function startShop() {
    let changed = false;
    for (const e of (state.shop || []).slice()) {
        if (jobs.has(e.aid) || lanes.has(e.aid)) continue;
        state.shop = state.shop.filter(x => x !== e); changed = true;
        if (!ctx.accounts.get(e.aid)) continue;
        jobs.set(e.aid, { practice: false, cont: false, at: 0, shop: e });
        prog.delete(e.aid);
    }
    if (changed) save();
}
function tick() {
    takeShop();
    if (!halt) startShop();
    const max = maxLanes(), groups = ipGroups(), perIp = new Map();
    for (const aid of lanes.keys()) perIp.set(ipOf(groups, aid), (perIp.get(ipOf(groups, aid)) || 0) + 1);
    for (const [aid, j] of jobs) {
        if (lanes.size >= max) break;
        const a = ctx.accounts.get(aid);
        if (!a || (!j.shop && !opensHere(aid))) { jobs.delete(aid); continue; }
        if (!a.healthy || lanes.has(aid) || Date.now() < j.at) continue;
        if (ctx.accounts.busy && ctx.accounts.busy(aid)) continue;   // another plugin's turn: try again in a moment
        const ip = ipOf(groups, aid);
        if ((perIp.get(ip) || 0) >= PER_IP) continue;               // this IP has its 3 opening: wait for one to finish
        perIp.set(ip, (perIp.get(ip) || 0) + 1);
        j.at = Infinity;   // running
        run(aid, a.name, j.practice, j.cont, j.shop);
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
        // Check drops: opening the viewer marks every drop seen (the ones that were new keep a New tag while it's open).
        ctx.panel.action('dropsOpen', () => {
            const fresh = new Set();
            for (const l of Object.values(state.drops || {})) for (const d of l) if (!d.seen) { fresh.add(d.id); d.seen = true; }
            dropsView = { pick: null, fresh };
            if (fresh.size) save();
            return {};
        });
        ctx.panel.action('dropsClose', () => { dropsView = null; return {}; });
        ctx.panel.action('dropsPick', (arg) => { if (dropsView && !String(arg).startsWith('one|')) dropsView.pick = String(arg); return {}; });
        ctx.panel.action('dropsBack', () => { if (dropsView) dropsView.pick = null; return {}; });
        ctx.panel.action('dropsClear', () => { state.drops = {}; save(); if (dropsView) dropsView = { pick: null, fresh: new Set() }; return { message: 'Drops list cleared.' }; });
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
            for (const a of chosen) if (!lanes.has(a.id) && !(jobs.get(a.id) || {}).shop) {   // a shop job waiting keeps its place
                jobs.set(a.id, { practice, cont: false, at: 0 });
                if (!practice) prog.delete(a.id);   // a new job: its progress starts over
                // Others paused until done: the accounts waiting their turn are held from now, not only while opening.
                if (!practice && S('exclusive') && ctx.accounts.setBusy) ctx.accounts.setBusy(a.id, 'waiting to open cases (others paused until done)');
            }
            tick();
            return { message: practice ? 'Practice run — what it would do shows up here in a moment.' : `Opening on ${chosen.length} account${chosen.length === 1 ? '' : 's'}.` };
        };
        ctx.panel.action('preview', () => start(true));
        ctx.panel.action('open', () => start(false));
        const stoppedByYou = (aid) => { const p = prog.get(aid) || { item: '', opened: 0, left: null, openMs: 0, value: 0, t0: Date.now() }; p.result = 'stopped by you'; p.at = Date.now(); prog.set(aid, p); };
        ctx.panel.action('openOne', (aid) => start(false, String(aid || '')));
        // Stop one account: a running one ends after its current open, a waiting one (or one on a break) at once.
        ctx.panel.action('stopOne', (aid) => {
            aid = String(aid || '');
            const name = (ctx.accounts.get(aid) || {}).name || aid, l = lanes.get(aid);
            // Its jobs queued from the Armory shop go too: Stop means this account stops opening.
            const queued = (state.shop || []).filter(e => e.aid === aid).length;
            if (queued) { state.shop = state.shop.filter(e => e.aid !== aid); save(); }
            const more = queued ? ` (and ${queued} queued from the shop)` : '';
            if (l) { l.halt = true; jobs.delete(aid); return { message: `Stopping ${name} after its current open${more}.` }; }
            if (!jobs.has(aid)) return { message: queued ? `Removed ${name}'s ${queued} queued from the shop.` : `${name} isn't opening.` };
            jobs.delete(aid);
            if (ctx.accounts.setBusy) ctx.accounts.setBusy(aid, null);
            stoppedByYou(aid);
            return { message: `Stopped ${name}.` };
        });
        // Buy event tickets by hand on the Opener's accounts: N more each ('add'), or each up to N ('upto'). $0.50 each,
        // never below the account's Keep cash (its set's, when it's on one).
        ctx.panel.action('ticketsBuy', async (mode) => {
            const want = Math.floor(num(S('ticketBuyN'))), upto = mode === 'upto';
            if (want <= 0) return { ok: false, error: 'Set how many tickets first.' };
            const list = ctx.accounts.list().filter(a => opensHere(a.id));
            if (!list.length) return { ok: false, error: 'Choose accounts first.' };
            let bought = 0, spent = 0, had = 0;
            const short = [], fail = [];
            for (const a of list) {
                if (!a.healthy) { fail.push(`${a.name} (not clicking)`); continue; }
                try {
                    const me = await getJson(a.id, '/api/me'), have = num(me.tickets);
                    tix.set(a.id, have);
                    const need = upto ? Math.max(0, want - have) : want;
                    if (!need) { had++; continue; }
                    const n = Math.min(need, Math.floor(Math.max(0, num(me.money) - num(cfgOf(a.id)('keepMoney'))) / TICKET));
                    if (n < need) short.push(a.name);
                    if (n <= 0) continue;
                    const r = await req(a.id, '/api/tickets', { method: 'POST', body: { count: n } });
                    const after = await getJson(a.id, '/api/me');
                    tix.set(a.id, num(after.tickets));
                    if (r.kind !== 'ok' || (r.json && r.json.error)) { fail.push(`${a.name}: ${(r.json && r.json.error) || 'HTTP ' + r.status}`); continue; }
                    const cost = Math.max(0, num(me.money) - num(after.money));
                    bought += n; spent += cost;
                    ctx.log(`bought ${count(n)} event ticket${n === 1 ? '' : 's'} for ${money(cost)} (has ${count(num(after.tickets))})`, 'ok', a.id);
                } catch (e) { fail.push(`${a.name}: ${e.message}`); }
            }
            const notes = [short.length ? `not enough cash above Keep cash: ${short.join(', ')}` : '', fail.length ? `not bought: ${fail.join(', ')}` : '', had ? `${had} had ${count(want)} already` : ''].filter(Boolean).join(' · ');
            if (!bought) return fail.length && !short.length && !had ? { ok: false, error: `No tickets bought — ${notes}.` } : { message: `No tickets bought${notes ? ' — ' + notes : ''}.` };
            return { message: `Bought ${count(bought)} event ticket${bought === 1 ? '' : 's'} for ${money(spent)}${notes ? ' · ' + notes : ''}.` };
        });
        // Read how many tickets each Opener account has (the card's Tickets column).
        ctx.panel.action('ticketsCheck', async () => {
            const list = ctx.accounts.list().filter(a => opensHere(a.id) && a.healthy);
            if (!list.length) return { ok: false, error: 'No chosen account is clicking.' };
            let all = 0, read = 0;
            await Promise.all(list.map(async (a) => { try { const n = num((await getJson(a.id, '/api/me')).tickets); tix.set(a.id, n); all += n; read++; } catch (_) {} }));
            return { message: `${count(all)} event ticket${all === 1 ? '' : 's'} on ${read} account${read === 1 ? '' : 's'}.` };
        });
        // Remove one job queued from the Armory shop (qid|aid), before it starts.
        ctx.panel.action('shopDrop', (arg) => {
            const [qid, aid] = String(arg || '').split('|');
            const was = (state.shop || []).length;
            state.shop = (state.shop || []).filter(e => !(e.qid === qid && e.aid === aid));
            if (state.shop.length === was) return { message: 'That one has started or is gone already.' };
            save();
            return { message: `Removed from the queue: ${(ctx.accounts.get(aid) || {}).name || aid}.` };
        });
        ctx.panel.action('stop', () => {
            const queued = (state.shop || []).length;
            if (queued) { state.shop = []; save(); }
            if (!lanes.size && ![...jobs.values()].some(j => !j.practice)) return { message: queued ? `Removed ${queued} queued from the shop.` : 'Nothing is opening.' };
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
                return { name: a.name, cash, buy: b, cost: b * (price + (ticketBuy() ? TICKET : 0)), short: amountish() && b < each };
            }) : [];
            const planBuy = plan.reduce((s, p) => s + p.buy, 0), planCost = plan.reduce((s, p) => s + p.cost, 0), short = plan.filter(p => p.short).length;
            const usd = (v) => '$' + num(v).toLocaleString('en-US');
            const blockedBuy = item && buying ? (item.isNonBuyable ? `${item.name} isn't sold in the shop — set Source to From stock`
                : num(S('maxPrice')) > 0 && price > num(S('maxPrice')) ? `${item.name} costs ${usd(price)}, over your max price of ${usd(S('maxPrice'))} — nothing is bought` : null) : null;
            const buyTxt = !item ? '' : S('source') === 'stockAmount' ? `Open the ${item.name} in stock, then buy ${count(each)} on each account (${money(planCost)} in all)` : S('source') === 'amount' ? `Buy ${count(each)} ${item.name} on each account (${money(planCost)} in all)` : `Buy ${item.name} with the spare cash (about ${money(planCost)} in all)`;
            const plans = Object.values(state.plans || {}).filter(x => chosen.some(a => a.name === x.name) && x.t > (state.practiceAt || 0) - 60000).sort((a, b) => b.t - a.t);
            const dropsTxt = dropsText();
            const measured = item && state.items[item._id];
            // Each account's own plan: what it opens and what it buys (its set's settings, or the main ones).
            const planFor = (a) => {
                const C = cfgOf(a.id), it = itemOf(C('item')), pr = it ? num(it.price) : 0, by = buys(C);
                const blocked = it && by && (it.isNonBuyable || (num(C('maxPrice')) > 0 && pr > num(C('maxPrice'))));
                const b = it && by && !blocked ? buyCount(num((ctx.accounts.stats(a.id) || {}).money), pr, C) : 0;
                return { C, set: setOf(a.id), item: it, buying: by && !blocked, buy: b, cost: b * (pr + (ticketBuy(C) ? TICKET : 0)) };
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
                if (l) return { text: (j && j.practice) || !p ? 'Practice run' : PHASE[l.phase] || l.phase, level: 'ok' };
                if (j && j.practice) return { text: 'Practice run waiting', level: 'muted' };
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
            // A job queued from the Armory shop: running or waiting now (its own table below, not this one).
            const shopNow = (id) => (lanes.get(id) && lanes.get(id).shop) || (jobs.get(id) && jobs.get(id).shop) || null;
            // Event tickets: a column when any account opens with them (live while opening, else from its last check).
            const tixOn = chosen.some(a => ticketsOn(plansOf.get(a.id).C));
            const tixOf = (a) => { const p = prog.get(a.id); const v = active(a.id) && p && p.tickets != null ? p.tickets : tix.has(a.id) ? tix.get(a.id) : null; return v == null ? { text: '—', level: 'muted' } : count(v); };
            const progCells = (a) => {
                const p = prog.get(a.id), on = active(a.id), total = p && p.left != null ? p.opened + p.left : 0;
                return [total ? { bar: p.opened / total, text: `${count(p.opened)} / ${count(total)}` } : { text: '—', level: 'muted' }, p && p.left != null ? count(p.left) : on ? '—' : { text: '—', level: 'muted' }];
            };
            const rows = chosen.filter(a => !shopNow(a.id)).map((a, i) => [a, i]).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map(([a]) => {
                const p = prog.get(a.id), on = active(a.id), me = ctx.accounts.stats(a.id) || {}, pl = plansOf.get(a.id);
                const total = p && p.left != null ? p.opened + p.left : 0, r = rateOf(p), eta = on ? etaOf(p) : 0;
                return [
                    a.name,
                    ...(setsOn ? [pl.item ? (pl.set ? setName(pl.set) + ' · ' : '') + pl.item.name : { text: 'nothing chosen', level: 'muted' }] : []),
                    status(a),
                    total ? { bar: p.opened / total, text: `${count(p.opened)} / ${count(total)}` } : { text: '—', level: 'muted' },
                    p && p.left != null ? count(p.left) : '—',
                    r ? `${r * 1000 < 10 ? (r * 1000).toFixed(1) : count(Math.round(r * 1000))}/s` : '—',
                    eta ? dur(eta) : on && p && p.left ? 'working it out' : '—',
                    ...(tixOn ? [ticketsOn(pl.C) ? tixOf(a) : { text: 'off', level: 'muted' }] : []),
                    money(num(me.money)),
                    on ? { label: 'Stop', action: 'stopOne', arg: a.id }
                        : pl.item && a.healthy ? { label: 'Open', action: 'openOne', arg: a.id, confirm: `${pl.buying ? pl.C('source') === 'stockAmount' ? `Open the ${pl.item.name} in stock, then buy ${count(Math.floor(num(pl.C('buyAmount'))))} and open those` : `Buy ${pl.item.name}${pl.C('source') === 'amount' ? ` (${count(Math.floor(num(pl.C('buyAmount'))))})` : ' with the spare cash'} and open it` : `Open the ${pl.item.name} in stock`} on ${a.name}? Drops are ${dropsTxt}.` } : '',
                ];
            });

            // Jobs from the Armory shop: the ones running or waiting their turn, then the ones queued behind another job.
            const shopRows = [
                ...ctx.accounts.list().filter(a => shopNow(a.id)).map(a => { const j = shopNow(a.id);
                    return [a.name, j.name || 'item', status(a), ...progCells(a), dropsText(shopCfg(j)), { label: 'Stop', action: 'stopOne', arg: a.id }]; }),
                ...(state.shop || []).map(e => { const a = ctx.accounts.get(e.aid) || { name: e.aid };
                    return [a.name, e.name || 'item', { text: active(e.aid) ? 'Queued · after its current job' : 'Queued', level: 'muted' }, { text: '—', level: 'muted' }, { text: '—', level: 'muted' }, dropsText(shopCfg(e)), { label: 'Remove', action: 'shopDrop', arg: e.qid + '|' + e.aid }]; }),
            ];

            // The top: running (how far, how long, Stop all) or ready (what Open now will do, Open now / Practice run).
            const act = ctx.accounts.list().filter(a => active(a.id) && (opensHere(a.id) || shopNow(a.id))), running = act.filter(a => lanes.has(a.id)).length;
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
                buttons: [{ label: act.length === 1 ? 'Stop' : 'Stop all', action: 'stop' }],
            } : null;

            // What to open: the shop's list as pictures, by kind (search over all of it).
            const pic = (c) => { const f = String((c && (c.iconUrl || c.image)) || ''); return !f ? '' : /^https:\/\//.test(f) ? f : 'https://case-clicker.com/pictures/cases/' + encodeURIComponent(f.replace(/^\/+/, '')); };
            const kinds = [['Case', 'Cases'], ['Capsule', 'Capsules'], ['Collection', 'Collections']];
            const tileGroups = catalog.items ? kinds.map(([k, title]) => ({ title, items: catalog.items.filter(c => c.kind === k)
                .sort((x, y) => num(x.rankNeeded) - num(y.rankNeeded) || num(x.price) - num(y.price) || String(x.name).localeCompare(String(y.name)))
                .map(c => ({ id: c._id, name: c.name, image: pic(c), sub: usd(c.price) + (num(c.rankNeeded) > 1 ? ` · rank ${c.rankNeeded}` : ''), meta: c.isNonBuyable ? 'not sold — open only' : '' })) })) : [];
            const buyKeys = amountish() ? ['source', 'buyAmount', 'maxPrice', 'keepMoney'] : buying ? ['source', 'maxPrice', 'keepMoney', 'keepPct', 'spendPerRun'] : ['source'];
            const buySum = !item ? 'pick what to open first' : !buying ? 'opens what\'s in stock, buys nothing' : blockedBuy ? 'not buying' : `${S('source') === 'stockAmount' ? 'stock first, then ' : ''}buys ${count(planBuy)} for ${money(planCost)}${nd > 1 ? ` on ${nd} accounts` : ''}`;
            const ticketSum = item && ticketsOn() ? ` · event tickets${ticketBuy() ? ', buying them' : ''}` : '';
            const steps = [
                { id: 'item', title: 'What to open', image: item ? pic(item) : '', done: !!item,
                    summary: (setsOn ? (nd ? 'everyone else: ' : 'no one else: ') : '') + (item ? `${item.name} · ${usd(price)} each` : 'pick a case, capsule or collection'),
                    text: setsOn ? 'Accounts on a set open the set\'s item (More options → Sets); this is for everyone else.' : '',
                    blocks: [{ type: 'tiles', key: 'item', search: true, next: true, groups: tileGroups,
                        empty: 'The shop list loads once one of the chosen accounts is clicking.' }] },
                { id: 'buy', title: 'How to get them', done: !!item && !blockedBuy, warn: blockedBuy || '',
                    summary: buySum + ticketSum,
                    keys: [...buyKeys, 'useTickets', ...(ticketsOn() ? ['buyTickets'] : [])],
                    blocks: [
                        ...(blockedBuy ? [{ type: 'notice', level: 'warn', text: blockedBuy }] : []),
                        ...(plan.length && !blockedBuy ? [
                            { type: 'stats', items: [
                                { label: 'Price each', value: usd(price) },
                                { label: amountish() ? (nd > 1 ? `Buying (${count(each)} each)` : 'Buying') : 'Spare cash buys', value: count(planBuy) },
                                { label: 'Total cost', value: money(planCost) },
                            ] },
                            ...(short ? [{ type: 'notice', level: 'warn', text: `${short} account${short === 1 ? '' : 's'} can't cover ${count(each)}${num(S('keepMoney')) > 0 ? ` and keep ${money(num(S('keepMoney')))}` : ''} — ${short === 1 ? 'it buys' : 'they buy'} what the cash allows.` }] : []),
                            { type: 'table', empty: 'No accounts chosen yet.', columns: ['Account', 'Cash', 'Buys', 'Cost', 'Cash after'],
                                rows: [...plan.map(p => [p.name, money(p.cash), p.short ? `${count(p.buy)} (short)` : count(p.buy), money(p.cost), money(p.cash - p.cost)]),
                                    ...(plan.length > 1 ? [['Total', money(plan.reduce((s, p) => s + p.cash, 0)), count(planBuy), money(planCost), money(plan.reduce((s, p) => s + p.cash - p.cost, 0))]] : [])] },
                        ] : []),
                        ...(measured && measured.opened ? [{ type: 'stats', items: [
                            { label: 'Opened so far', value: count(measured.opened) },
                            { label: 'Drops worth', value: measured.cost ? pct(measured.pv || 0, measured.cost) + ' of the cost' + (measured.tickets ? ' (tickets included)' : '') : price > 0 ? pct(measured.value || 0, measured.opened * price) + ' of the cost' : money(measured.value || 0) },
                            { label: 'XP per open', value: +(measured.xp / measured.opened).toFixed(2) + '' },
                        ] }] : []),
                    ] },
                { id: 'accounts', title: 'Accounts', done: n > 0,
                    summary: n ? `${n} account${n === 1 ? '' : 's'}${n > nd ? ` (${n - nd} on sets)` : ''} · ${maxLanes_} at a time${maxLanes_ < setLanes ? ` (${PER_IP} per IP)` : ''}${S('exclusive') ? ' · other plugins wait until done' : ''}` : 'none yet',
                    keys: ['accounts', 'lanes', 'exclusive'], blocks: capNote ? [{ type: 'notice', level: 'warn', text: capNote }] : [] },
                { id: 'drops', title: 'Drops', done: true, summary: `${dropsTxt} · favourites: ${favText()}`,
                    keys: keep ? ['drops'] : ['drops', 'keepOver'],
                    blocks: [{ type: 'text', text: `Favourited drops are never sold. Favourites: ${favText()} — change that under More options → Auto-favourite.` }] },
            ];
            const N = Math.max(0, Math.floor(num(S('ticketBuyN')))), tixKnown = chosen.filter(a => tix.has(a.id));
            const tixAll = tixKnown.reduce((s2, a) => s2 + tix.get(a.id), 0), tixEach = `${count(N)} event ticket${N === 1 ? '' : 's'}`;
            const extras = [
                { id: 'tickets', title: 'Event tickets',
                    summary: (tixKnown.length ? `${count(tixAll)} on ${tixKnown.length} account${tixKnown.length === 1 ? '' : 's'}` : 'buy them here for the Opener\'s accounts') + (ticketsOn() ? ' · opening with them' : ''),
                    keys: ['ticketBuyN'],
                    blocks: [
                        { type: 'text', text: `$${TICKET.toFixed(2)} a ticket, one per case opened with Use event tickets (step 2, How to get them). Buying never goes below an account's Keep cash.` },
                        { type: 'table', empty: 'No accounts chosen yet.', columns: ['Account', 'Tickets', 'Cash'],
                            rows: chosen.map(a => [a.name, tixOf(a), money(num((ctx.accounts.stats(a.id) || {}).money))]) },
                        ...(n && N ? [{ type: 'buttons', items: [
                            { label: `Top up to ${count(N)} each`, action: 'ticketsBuy', arg: 'upto', primary: true, confirm: `Buy event tickets on ${n} account${n === 1 ? '' : 's'} until each has ${tixEach}? $${TICKET.toFixed(2)} each, never below Keep cash.` },
                            { label: `Buy ${count(N)} on each`, action: 'ticketsBuy', arg: 'add', confirm: `Buy ${tixEach} on each of ${n} account${n === 1 ? '' : 's'} (${money(N * TICKET)} each, ${money(N * TICKET * n)} in all)? Never below Keep cash.` },
                            { label: 'Check tickets', action: 'ticketsCheck' },
                        ] }] : []),
                    ] },
                { id: 'favs', title: 'Auto-favourite', summary: favText(),
                    keys: !S('favSet') ? ['favSet'] : ['favSet', 'favLow', ...(S('favLow') ? ['lowFloat'] : []), 'favHigh', ...(S('favHigh') ? ['highFloat'] : []),
                        'favCustom', ...(S('favCustom') ? ['customFloats'] : []), 'favPatterns', ...(S('favPatterns') ? ['patternBlacklist'] : [])],
                    blocks: S('favSet') && (S('customFloats') || []).length > customFloats().length
                        ? [{ type: 'notice', level: 'warn', text: `Left out: ${(S('customFloats') || []).filter(f => !customFloats().includes(f)).join(', ')} — custom floats are digits and one dot, up to 20 characters, at most ${MAX_CUSTOM}.` }] : [] },
                { id: 'boosts', title: 'Boosts', summary: boostKinds().length ? `keeps ${boostKinds().map(k => ({ caseOpenCountBoost: 'open count', caseOpenMultiplierBoost: 'multiplier', caseOpenCashback: 'cashback' })[k]).join(', ')} running while opening${S('boostBuy') ? ' · buys with ammo' : ''}` : 'off — opens at the account’s own size',
                    keys: ['boostCount', 'boostMult', 'boostCashback', ...(boostKinds().length ? ['boostBuy', ...(S('boostBuy') ? ['boostKeepAmmo'] : [])] : [])] },
                { id: 'sets', title: 'Sets', summary: sets.length ? `${sets.length} set${sets.length === 1 ? '' : 's'} — other accounts open something else` : 'off — every account opens the same item',
                    text: 'A set has its own item, buying and accounts. Its accounts open that even when not ticked under Accounts; everyone else opens step 1\'s item.',
                    blocks: [
                        ...(setClash.length ? [{ type: 'notice', level: 'warn', text: `On more than one set: ${setClash.join(', ')} — each opens its first set's item.` }] : []),
                        { type: 'list', key: 'sets', summaries: sets.map(s => {
                            const it = itemOf(s.item), k = chosenOn(s);
                            if (!s.item) return `${s.name ? setName(s) + ': ' : ''}no item yet — not used`;
                            return `${s.name ? setName(s) + ': ' : ''}${it ? it.name : 'item not in the shop'} · ${({ amount: `buys ${count(Math.floor(num(s.buyAmount)))} each`, stockAmount: `stock first, then buys ${count(Math.floor(num(s.buyAmount)))} each`, buy: 'buys with spare cash', owned: 'from stock' })[s.source] || ''}${s.useTickets ? ` · event tickets${s.buyTickets ? ', buying them' : ''}` : ''} · ${k} account${k === 1 ? '' : 's'}`;
                        }) },
                    ] },
                { id: 'hook', title: 'Discord',
                    summary: !hookUrl ? 'off — post favourited drops to a channel' : hookDead ? 'stopped: ' + hookDead : `posts favourited drops${num(S('hookMin')) > 0 ? ` worth ${money(num(S('hookMin')))}+` : ''} to ${hookTail()}${state.hookSent ? ` · ${count(state.hookSent)} sent` : ''}`,
                    keys: hookUrl ? ['hookMin'] : ['hookPaste'],
                    blocks: [
                        ...(hookDead ? [{ type: 'notice', level: 'bad', text: hookDead }] : []),
                        { type: 'buttons', items: hookUrl
                            ? [{ label: 'Send a test', action: 'hookTest' }, { label: 'Remove webhook', action: 'hookClear', danger: true, confirm: 'Remove the Discord webhook? Favourited drops stop posting.' }]
                            : [{ label: 'Save webhook', action: 'hookSave', primary: true }] },
                    ] },
            ];
            // Start: what Open now will do, and the buttons (or, while opening, that it's running — Stop is up top).
            const finish = act.length ? { title: 'Opening now', text: 'Progress is above — Stop all stops it.', ready: true, buttons: [] } : {
                title: !n ? 'Choose accounts to open on' : !ready.length ? 'Pick something to open' : `Ready to open ${itemsTxt}`,
                ready: !!(n && ready.length), next: 'Review and open',
                text: !n ? 'Step 3, Accounts.' : !ready.length ? 'Step 1, What to open.'
                    : `${anyBuy ? `Buys ${count(tBuy)} for ${money(tCost)}${ready.some(a => ticketBuy(plansOf.get(a.id).C)) ? ' (tickets included)' : ''}` : 'Opens what\'s in stock'} on ${ready.length} account${ready.length === 1 ? '' : 's'}, ${maxLanes_} at a time · drops ${dropsTxt}${ready.some(a => ticketsOn(plansOf.get(a.id).C)) ? ' · with event tickets' : ''}${S('exclusive') ? ' · other plugins wait until it\'s done' : ''}${ready.length < n ? ` · ${n - ready.length} with nothing chosen` : ''}`,
                buttons: ready.length ? [
                    { label: 'Open now', action: 'open', primary: true, confirm: !setsOn
                        ? `${buying && !blockedBuy ? `${buyTxt} and open it` : `Open the ${item.name} in stock`} on ${n} account${n === 1 ? '' : 's'}? Drops are ${dropsTxt}.`
                        : `Open on ${ready.length} account${ready.length === 1 ? '' : 's'}: ${byItem.map(([nm, k]) => `${nm} on ${k}`).join(', ')}${anyBuy ? ` (buying about ${money(tCost)} in all)` : ''}? Drops are ${dropsTxt}.` },
                    { label: 'Practice run', action: 'preview' }] : [],
            };
            const wizard = { type: 'wizard', id: 'setup', steps, extras, finish };

            // The account pills: wallet, then the open size (open count × multiplier, boosts included).
            const accountLines = Object.fromEntries(ctx.accounts.list().map(a => { const m = a.me || {};
                return [a.id, [m.money != null ? `Wallet ${money(num(m.money))}` : 'Wallet not read yet', m.openCount ? `Opens ${count(num(m.openCount))} × ${count(num(m.openMult) || 1)}` : 'Open size not read yet']]; }));
            const unseen = unseenDrops(), anyDrops = Object.values(state.drops || {}).some(l => l.length);
            const dropsBtn = anyDrops ? [{ type: 'buttons', items: [{ label: 'Check drops' + (unseen && !coreAtLeast('1.2.16') ? ` (${count(unseen)} new)` : ''), action: 'dropsOpen', badge: unseen, primary: unseen > 0 }] }] : [];
            return { pin: act.length ? 'running' : undefined, modal: dropsModal() || undefined, accountLines, blocks: [
                ...(hero ? [hero] : []),
                ...(paused ? [{ type: 'notice', level: 'bad', text: 'Buying is stopped: ' + paused }] : []),
                ...(hero ? [] : [wizard]),
                ...dropsBtn,
                ...(rows.length ? [{ type: 'table', columns: ['Account', ...(setsOn ? ['Opens'] : []), 'Status', 'Opened', 'Left', 'Speed', 'Time left', ...(tixOn ? ['Tickets'] : []), 'Cash', ''], rows }] : []),
                ...(shopRows.length ? [{ type: 'section', title: 'Queued from the Armory shop', text: 'Opens what the shop bought, from stock — nothing is bought here. Each starts when its account is free.', blocks: [
                    { type: 'table', columns: ['Account', 'Opens', 'Status', 'Opened', 'Left', 'Drops', ''], rows: shopRows }] }] : []),
                ...(plans.length && !act.length ? [{ type: 'section', title: 'Practice run — what Open now would do', blocks: [
                    { type: 'table', wrap: true, columns: ['Account', 'Would', 'When'], rows: plans.slice(0, 10).map(x => [x.name, x.lines.join(' · '), new Date(x.t).toLocaleTimeString()]) }] }] : []),
                ...(t.opened ? [{ type: 'stats', items: [
                    { label: 'Opened today', value: count(t.opened) },
                    { label: 'Spent today', value: money(t.spent) },
                    { label: 'Drops worth', value: money(t.value || 0) + (t.cost ? ` · ${pct(t.pv, t.cost)}` : '') },
                    { label: 'XP today', value: count(t.xp) + (t.ranks ? ` · ${t.ranks} rank-up${t.ranks === 1 ? '' : 's'}` : '') },
                ] }] : []),
                ...(hero ? [{ type: 'section', title: 'Setup', blocks: [wizard] }] : []),
                { type: 'section', title: 'Recent runs', blocks: [{ type: 'table', empty: 'No runs yet.', columns: ['When', 'Account', 'Item', 'Spent', 'Opened', 'Drops worth', 'Result'],
                    rows: (state.runs || []).slice(0, 10).map(r => [new Date(r.t).toLocaleTimeString(), r.acct, r.item || '—', money(r.spent), count(r.opened), money(r.value || 0), r.result]) }] },
            ] };
        });
        ctx.panel.badge((aid) => { const l = lanes.get(aid); return l ? 'Opening: ' + l.phase : null; });
    },
    stop() { lanes.clear(); },
};

