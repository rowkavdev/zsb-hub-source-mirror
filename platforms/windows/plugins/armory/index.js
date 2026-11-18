/**
 * ARMORY (star farming)
 *
 * The Armory is a battle pass: up to 5 passes at once (3 without Pro), each levels every 100 XP up to 40
 * (4,000 XP) and pays credits as it levels. Every game played gives XP to all active passes at once.
 *   passes   GET /api/armory -> { credits, armoryPasses: [{ _id, xp, isActive }] }
 *            POST /api/armory starts a pass (free) · DELETE /api/armory restarts a full one
 *   limits   GET /api/gameLimitations -> { cbHostLeft, cbGuestLeft, ... } (per 24 h)
 *   battles  socket: createGame { teams: 1, playerCount: 2, isPrivate, battlePrice, cases: [{ ...case, count }],
 *            mode: 'coop'|'standard', isCrazyMode, isTimeshift } -> gameCreated <id>; the other account sends
 *            joinGame { session (its get-session data), gameId, bot: false, index: 1 }; watchGame <id> streams
 *            `game` / caseBattleInfo until status 'finished'. 1 XP per round for each player; up to
 *            /api/me casebattleRounds rounds (100; 200 with the case battle package). One HOSTED battle at a time per
 *            account; joining has only the daily limit.
 *   cases    GET /api/casebattle/cases -> { cases: [{ _id, name, price, type, rankNeeded, isNonBuyable }] }
 *   credits  /_next/data/<build>/en/armory.json -> pageProps.armoryRewards (JSON string: [{ id, name, type,
 *            creditPrice }]); PATCH /api/armory { id, type, amount } buys amount x 10 of the item (measured:
 *            20 credits of Auto Racing capsules = 200 capsules, worth ~$2.36 each)
 *   1 credit per pass per level (100 XP): 5 passes = 5 credits per 100 XP.
 * Co-op splits the pot evenly as cash (checked live: both players got the same back, no skins to sell);
 * standard gives the pot to the winner (team). Custom and community cases pay it in money, not skins (the user, 2026-11-18).
 * Teams (the default since 1.20): 2 teams of our own accounts (2v2, 3v3 with the package), so every battle is one
 * side's win and the other's loss and the "win/lose case battles" missions move along with the XP. 2 teams need 4 or 6
 * players (createGame); with 2-3 of ours it's a free-for-all standard battle (one wins, the others lose).
 * Measured live (2026-11-05), XP per play on every pass: jackpot round 50, guess the rank 15 (25 when right), upgrade 10, blackjack 10, crash 5, dice 5,
 * coinflip 2, battle round 1 (credited when the battle ends), plinko 0.5. Daily limits: jackpot 200, upgrade 300,
 * coinflip 500 hosted + 500 joined, battles 200 hosted + 400 joined. (Coinflip is off for now: its flips are public.)
 * The account list and the ticked games are the master list: battles, upgrades, jackpots and Guess the Rank are played
 * here; blackjack, crash, dice and plinko by the Games plugin, which reads the list (ctx.shared "armory/farm"), or,
 * when Games isn't on and live (it says so in ctx.shared "games/live"), by the Armory itself during its turn
 * (casino.js), alongside the battles while they wait for their rounds.
 * Practice mode (the default) only logs what it would do.
 */

const FULL_XP = 4000;
const makeCasino = require('./casino');
const CASES_MS = 60 * 60 * 1000;
const ROUND_SECS = 8.6;         // how long a battle round takes (measured live)
const ROUND_SECS_TS = 3.8;      // with timeshift (case battle package)
const JOIN_WAIT_MS = 60000;     // a battle not started by then gets bots; still not started that much later, it's deleted
const ROUND_MS = 12000;         // time allowed per round (they run ~8.6 s each) before giving up on a battle
// Battles that got stuck (user reports 2026-11-18, after the site's maintenance on 2026-11-17): a dropped socket left the
// host waiting blind for the whole allowance, and a battle the site stopped playing held its host for the whole turn.
const SILENT_MS = 20000;               // no word about a running battle that long: ask the site about it (twice, then reconnect)
const STUCK_MS = 5 * 60000;            // a battle whose round hasn't moved that long while the site answers is stuck
const OFFLINE_MAX_MS = 45 * 60000;     // time out of touch (maintenance, a dropped socket) added to a battle's allowance, at most
const STUCK_CANCEL_MS = 30 * 60000;    // stuck that long: the site is asked once to cancel it (everyone gets the price back)
const PAUSE_WAIT_MS = 30000;           // the site paused (maintenance) or battles switched off: look again after this

let ctx = null;
let state = null;   // saved: { last, today: { day, battles, rounds, spent }, passes: { aid: {...} }, history: [...], plans, practiceAt }
let cases = null;   // battle cases, cheapest first
let casesAt = 0;
let battling = false, halt = false, farming = false;   // farming: a check (battles, flips, jackpots) is running
let recovering = false;   // the sweep after a restart (recoverHosting) is looking at battles left from before
const passBusy = new Set();
// Lending an account mid-turn (the Trader's routes, a tester 2026-11-14): another plugin asks for an account with
// ctx.accounts.want(); the Armory starts nothing new on it, and once its requests, sockets and battles on it are done it
// clears its mark and leaves the account alone for the rest of the turn.
const lent = new Set();      // accounts handed over this turn
const inUse = new Map();     // account id -> the Armory's requests and sockets open on it right now
const use = (id, d) => inUse.set(id, Math.max(0, (inUse.get(id) || 0) + d));
const wantedBy = (id) => (ctx.accounts.wanted ? ctx.accounts.wanted(id) : null);
const isOut = (id) => lent.has(id) || !!wantedBy(id);
// Battle ids the hub hosted, per account (state.hosting). Merged with the copy on disk on every save: a run that was
// just turned off can still be creating a battle while the next run starts, and neither may lose the other's id.
const diskHosting = () => { try { return ctx.data.get().hosting || {}; } catch (_) { return {}; } };
function save() { state.hosting = { ...diskHosting(), ...(state.hosting || {}) }; ctx.data.set(state); }
function setHosting(aid, id, onlyIf) {
    const h = { ...diskHosting(), ...(state.hosting || {}) };
    if (id) h[aid] = id; else if (!onlyIf || h[aid] === onlyIf) delete h[aid];
    state.hosting = h; ctx.data.set(state);
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const money = (n) => '$' + (Math.abs(n) >= 1e6 ? +(n / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e3 ? +(n / 1e3).toFixed(1) + 'k' : +n.toFixed(2));
const count = (n) => Math.round(n).toLocaleString('en-US');
const day = () => new Date().toISOString().slice(0, 10);
const S = (k) => ctx.settings.get(k);
// Live or practice (practice only ever runs when asked: the Run button), and the master on/off, which works in live only.
const practiceMode = () => ctx.power.practice();
const chosen = () => ctx.accounts.list().filter(a => ctx.settings.runsOn('accounts', a.id));

class Stop extends Error {}

function today() {
    if (!state.today || state.today.day !== day()) state.today = { day: day(), battles: 0, rounds: 0, spent: 0, starts: 0, restarts: 0 };
    return state.today;
}

async function json(aid, path, opts) {
    const r = await ctx.request(aid, path, opts);
    if (r.kind === 'not-running' || r.kind === 'auth' || r.kind === 'cf') throw new Stop(r.kind === 'not-running' ? 'the account stopped clicking' : r.kind);
    if (r.kind !== 'ok') { const e = new Stop(`${path.split('?')[0]}: ${(r.json && r.json.error) || 'HTTP ' + r.status}`); e.kind = r.kind; throw e; }
    return r.json;
}

// Clicking but paused by the app: the site under maintenance, a Cloudflare check, its proxy down, a re-login. Its
// requests answer not-running meanwhile; it isn't stopped, so the Armory waits for it instead of giving up.
const paused = (id) => { const a = ctx.accounts.list().find(x => x.id === id); return !!a && a.running && !a.healthy; };
const stoppedClicking = (id) => { const a = ctx.accounts.list().find(x => x.id === id); return !a || !a.running; };
const SITE_DOWN = new Set(['maintenance', 'site', 'net', 'timeout', 'rate']);
const ago = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60000)} min`);
// Case battles switched off on the site (GET /api/games/status -> { disabledGames: ['Casebattle', ...] }), read at most
// every 30 s for all hosts. Anything but a clear answer counts as on.
let offRead = { at: 0, off: false };
async function battlesOff(aid) {
    if (Date.now() - offRead.at < 30000) return offRead.off;
    const r = await ctx.request(aid, '/api/games/status');
    offRead = { at: Date.now(), off: r.kind === 'ok' && !!r.json && Array.isArray(r.json.disabledGames) && r.json.disabledGames.includes('Casebattle') };
    return offRead.off;
}
// Running battles per host, to tell a stuck one: { id, round, rounds, since (when its round last moved), said,
// cancelAsked }. Kept on disk so the time counts across turns and restarts; the panel lists the ones past stuckMs.
const stuckMs = () => num(S('stuckMs')) || STUCK_MS;
const cancelMs = () => num(S('stuckCancelMs')) || STUCK_CANCEL_MS;
function noteRunning(aid, b) {
    const st = state.stuck || (state.stuck = {});
    const s = st[aid];
    if (!s || s.id !== b.id || s.round !== b.round) st[aid] = { id: b.id, round: b.round, rounds: b.rounds, since: b.since || Date.now() };
    return st[aid];
}
function stuckEnded(aid, openIds) {
    const s = (state.stuck || {})[aid];
    if (!s || openIds.includes(s.id)) return;
    delete state.stuck[aid];
    if (s.said) ctx.log('the stuck battle has ended — hosting again', 'ok', aid);
    save();
}

// Everything a battle can use, grouped as on the site: cases, custom cases, community cases (GET /api/communityCases
// ?page=N, 50 a page; they pay out the skins' value in money, as custom cases do), capsules and collections.
const CASE_GROUPS = [['cases', 'Cases'], ['customCases', 'Custom cases'], ['community', 'Community cases'], ['capsules', 'Capsules'], ['collectionCases', 'Collections']];
async function loadCases(aid) {
    if (cases && Date.now() - casesAt < CASES_MS) return;
    const j = await json(aid, '/api/casebattle/cases');
    const community = [];
    for (let page = 1; page <= 10; page++) {
        let c;
        try { c = await json(aid, `/api/communityCases?page=${page}`); } catch (_) { break; }
        community.push(...(c.cases || []));
        if (!c.cases || !c.cases.length || page * (num(c.pageSize) || 50) >= num(c.total)) break;
    }
    const usable = (c) => c && c._id && !c.isNonBuyable && num(c.price) > 0 && num(c.price) < 100000;
    cases = CASE_GROUPS.flatMap(([k, group]) => (k === 'community' ? community : j[k] || []).filter(usable)
        .sort((a, b) => num(a.price) - num(b.price)).map(c => ({ ...c, group })));
    casesAt = Date.now();
    ctx.settings.setOptions('battleCase', cases.map(c => ({ value: c._id, group: c.group, label: `${c.name} — $${num(c.price)}${num(c.rankNeeded) > 1 ? ` · rank ${c.rankNeeded}` : ''}` })));
}
// The chosen case, or Prisma Case (a cheap case that returns ~84% of its price) until one is chosen.
// The armory shop (what credits buy).
let rewards = null;
let casino = null;
async function loadRewards(aid) {
    if (rewards) return;
    const home = await ctx.request(aid, '/');
    const m = /"buildId"\s*:\s*"([^"]+)"/.exec((home && home.body) || '');
    if (!m) return;
    const j = await json(aid, `/_next/data/${m[1]}/en/armory.json`);
    const raw = j && j.pageProps && j.pageProps.armoryRewards;
    rewards = (typeof raw === 'string' ? JSON.parse(raw) : raw || []).filter(x => x && x.id && num(x.creditPrice) > 0);
}

// The master list Games reads: which star accounts farm, and which of its games they play for XP.
const VIA_GAMES = ['plinko', 'dice', 'crash', 'blackjack'];
// Games on and live plays these; otherwise the Armory does (see casinoTurn).
const gamesLive = () => !!(ctx.shared && ctx.shared.get('games/live'));
function publish() {
    if (!ctx.shared) return;
    if (!ctx.power.live()) { ctx.shared.set('farm', null); return; }   // only while star farming is on
    ctx.shared.set('farm', { accounts: chosen().map(a => a.id), games: Object.fromEntries(VIA_GAMES.map(g => [g, !!S('farm_' + g)])) });
}

// The default: "dirt cheap", a $0.04 community case (gufrie01; the user, 2026-11-18): a full battle costs a few dollars.
// A battle needs only the case's id: the site fills in the case and sets the price itself (checked live 2026-11-18: a
// create with cases [{ _id, count }] and a wrong battlePrice made the right battle at the case's price). So a case
// not in the lists (community cases past the pages read) is sent by id; its name and price come from the battle made.
// One the site won't make a battle with (removed): Prisma Case instead, said once.
const DEFAULT_CASE = '6aecdb06b58bea19eec26848';
const learned = new Map();   // case id -> { name, price } read from a battle made with it
const caseGone = new Set();  // case ids the site refused a battle with
const battleCase = () => {
    if (!cases) return null;
    const id = S('battleCase') || DEFAULT_CASE;
    if (!caseGone.has(id)) {
        const c = cases.find(x => x._id === id);
        if (c) return c;
        const l = learned.get(id);
        return { _id: id, byId: true, name: l ? l.name : 'case ' + id, price: l ? l.price : 0, group: 'Community cases' };
    }
    return cases.find(c => c.name === 'Prisma Case' && c.group === 'Cases') || cases[0];
};
const modeOf = () => ['coop', 'standard', 'teams'].includes(S('mode')) ? S('mode') : 'teams';
// Seats for a battle with n of our accounts (host included) free to play it: teams play 2v2 or 3v3 (only ours, no bots
// taking a share of the pot), otherwise every free account up to the host's maximum.
function lineup(n, pkg) {
    if (modeOf() === 'teams') {
        if (pkg && n >= PACKAGE_PLAYERS) return { seats: PACKAGE_PLAYERS, teams: 2 };
        if (n >= 4) return { seats: 4, teams: 2 };
    }
    return { seats: Math.max(2, Math.min(n, pkg ? PACKAGE_PLAYERS : PLAYERS)), teams: 1 };
}
const modeLabel = (players, teams) => teams === 2 ? `${players / 2}v${players / 2} standard` : `${players}-player ${modeOf() === 'coop' ? 'co-op' : 'standard'}`;

// ---- passes ----

async function tendPasses(a, practice, lines) {
    if (passBusy.has(a.id)) return;
    passBusy.add(a.id);
    try {
        const me = await json(a.id, '/api/me');
        const slots = me.membership === 'pro' ? 5 : 3;
        let arm = await json(a.id, '/api/armory');
        let passes = arm.armoryPasses || [];
        const full = passes.filter(p => num(p.xp) >= FULL_XP).length;
        if (S('restart') && full) {
            if (practice) lines.push(`${a.name}: restart ${full} full pass${full === 1 ? '' : 'es'}`);
            else for (let i = 0; i < full; i++) {
                await json(a.id, '/api/armory', { method: 'DELETE' });
                today().restarts++;
                ctx.log(`restarted a full armory pass`, 'ok', a.id);
            }
        }
        if (!practice && S('restart') && full) { arm = await json(a.id, '/api/armory'); passes = arm.armoryPasses || []; }
        const free = Math.max(0, slots - passes.length);
        if (free) {
            if (practice) lines.push(`${a.name}: start ${free} pass${free === 1 ? '' : 'es'} (${passes.length} of ${slots} slots used)`);
            else {
                for (let i = 0; i < free; i++) { await json(a.id, '/api/armory', { method: 'POST' }); today().starts++; }
                ctx.log(`started ${free} armory pass${free === 1 ? '' : 'es'}`, 'ok', a.id);
                arm = await json(a.id, '/api/armory'); passes = arm.armoryPasses || [];
            }
        }
        state.passes[a.id] = { t: Date.now(), name: a.name, slots, credits: num(arm.credits), xp: passes.map(p => num(p.xp)) };
    } finally { passBusy.delete(a.id); }
}

// ---- battles ----
// Hosting is capped at one battle at a time per account, joining isn't (only per day). So every star account hosts
// its own battle back to back and every other star account joins all of them at once: with N accounts each one earns
// XP in N battles at the same time. Up to 4 players; with the case battle package (/api/me boughtPackages includes
// "casebattle_package") a host can take 6 players, use timeshift (~3.8 s a round instead of ~8.6) and 200 rounds.
// Accounts without the package can join those battles.

const PLAYERS = 4, PACKAGE_PLAYERS = 6;
const inBattle = new Map();  // account id -> battles it's in right now
const enter = (id, d) => inBattle.set(id, (inBattle.get(id) || 0) + d);
// With many accounts, every host picking "the first ones with joins left" put the same 3 accounts into ~30 battles at
// once (a tester, 33 accounts): their joins and cash went in minutes, the rest never joined. Hosts now take the accounts
// in the fewest battles right now, and each account's snapshot is shared for SNAP_MS instead of every host asking for
// every other account before every battle (~2,000 requests at once with 33 accounts). Hosts start HOST_STAGGER_MS apart.
const SNAP_MS = 60000, HOST_STAGGER_MS = 1500;
const snaps = new Map();     // account id -> { at, v } (a snapshot shared between hosts)
async function sharedSnapshot(a) {
    const c = snaps.get(a.id);
    if (c && Date.now() - c.at < SNAP_MS) return c.v;
    const v = await snapshot(a);
    snaps.set(a.id, { at: Date.now(), v });
    return v;
}

// What an account can do right now: cash, rounds, package, today's host/join limits.
async function snapshot(a) {
    const [me, lim] = await Promise.all([json(a.id, '/api/me'), json(a.id, '/api/gameLimitations')]);
    return { ...a, cash: num(me.money), maxRounds: num(me.casebattleRounds) || 1, pkg: (me.boughtPackages || []).includes('casebattle_package'),
        host: num(lim.cbHostLeft), guest: num(lim.cbGuestLeft) };
}

async function sessionOf(aid) {
    const s = await json(aid, '/api/auth/get-session');
    if (!s || !s.user) throw new Stop('no login session to join with');
    return s;
}

// An account can host one battle at a time ("You can only host 1 battle at a time"), so one left open — a crash, a
// restart, a battle the watchdog didn't see end — kept it from hosting (the user, 2026-11-11). Before each new
// battle: the one the hub last made with this account (state.hosting, kept on disk; private battles may not be in the
// lobby) and the lobby's list (joinRoomCasebattle -> games) are checked. Still waiting: deleted. Running: waited for.
const isHost = (g, uid) => !!g && !!uid && [g.host && (g.host.userId || g.host._id || g.host), g.players && g.players[0] && g.players[0].userId].includes(uid);
// The account's open battles, read only: [{ id, status, from: 'lobby' | 'hub' }] (after joinRoomCasebattle on h).
async function findOwnBattles(h, host) {
    const uid = (await sessionOf(host.id)).user.id;
    const lobby = await h.wait(['games'], 3000);
    const list = lobby && Array.isArray(lobby.data) ? lobby.data : [];
    const ids = new Map(list.filter(g => g && g.status !== 'finished' && isHost(g, uid)).map(g => [g._id, 'lobby']));
    for (const saved of [(state.hosting || {})[host.id], diskHosting()[host.id]]) if (saved && !ids.has(saved)) ids.set(saved, 'hub');
    const out = [];
    for (const [id, from] of ids) {
        h.emit('caseBattleInfo', id);
        const e = await h.wait(['caseBattleInfo', 'game'], 3000);
        const g = e && (Array.isArray(e.data) ? e.data[0] : e.data);
        const mine = g && (!g._id || g._id === id);
        const status = mine ? g.status : (list.find(x => x._id === id) || {}).status;
        // The round is known only from the battle's own answer (the lobby's list doesn't say).
        if (status && status !== 'finished') out.push({ id, status, from, round: mine && g.currentRound != null ? num(g.currentRound) : null, rounds: mine ? num(g.rounds) || null : null });
    }
    return out;
}
// What the site says about one battle now (caseBattleInfo), or null: no answer, an error, or another battle's answer.
async function battleInfo(h, id, ms = 3000) {
    if (h.emit('caseBattleInfo', id) === false) return null;
    const e = await h.wait(['caseBattleInfo', 'casebattleError'], ms);
    const g = e && e.ev === 'caseBattleInfo' && (Array.isArray(e.data) ? e.data[0] : e.data);
    return g && (!g._id || g._id === id) ? g : null;
}
const seatsTaken = (g) => (g.players || []).filter(Boolean).length;
// Half-full battles left open for hours (a tester, 2026-11-18: 2/4 and 3/4 co-op battles "waiting" for 5-6 h): a refused
// delete has no answer, so the hub forgot battles it thought it had deleted. A delete is now checked: still waiting
// afterwards, bots take the empty seats so it plays out (everyone already in gets their XP, co-op pays the pot back).
// -> 'gone' | 'bots' (playing now, with bots) | null (still waiting: the site refused both).
async function deleteBattle(h, id) {
    h.emit('deleteGame', id);
    await ctx.sleep(700);
    const g = await battleInfo(h, id);
    if (!g || g.status !== 'waiting') return 'gone';
    h.emit('joinBots', { gameId: id });
    await ctx.sleep(700);
    const g2 = await battleInfo(h, id);
    return !g2 || g2.status !== 'waiting' ? 'bots' : null;
}
async function clearOwnBattle(h, host) {
    const open = await findOwnBattles(h, host);
    stuckEnded(host.id, open.map(b => b.id));
    for (const b of open) {
        if (b.status === 'waiting') {
            const r = await deleteBattle(h, b.id);
            if (r === 'gone') { ctx.log(`${host.name} still had a battle waiting from before — deleted it`, 'warn', host.id); continue; }
            if (r === 'bots') {
                ctx.log(`${host.name} still had a battle waiting from before — the site didn't delete it, so bots filled it and it plays out`, 'warn', host.id);
                const err = new Stop('its earlier battle is still running — waiting for it');
                err.battle = { ...b, status: 'running' };
                throw err;
            }
            const err = new Stop(`its battle from before is stuck waiting for players — the site refuses to delete it or add bots`);
            err.refused = b;
            throw err;
        }
        const err = new Stop('its earlier battle is still running — waiting for it');
        err.battle = b;
        // Stuck: its round hasn't moved for stuckMs, counted across checks (only when the site says the round).
        if (b.round != null) {
            const s = noteRunning(host.id, b);
            const still = Date.now() - s.since;
            if (still >= stuckMs()) {
                err.stuck = s;
                if (still >= cancelMs() && !s.cancelAsked) {
                    h.emit('deleteGame', b.id);
                    s.cancelAsked = Date.now(); save();
                    ctx.log(`${host.name}'s battle has been stuck at round ${s.round} of ${s.rounds || '?'} for ${ago(still)} — asked the site to cancel it (everyone gets the price back)`, 'warn', host.id);
                }
            }
        }
        throw err;
    }
    setHosting(host.id, null);
}
// Preview: what the check would find, without deleting anything.
async function previewOwnBattles(host, lines) {
    let s = null;
    try {
        s = await ctx.socket(host.id);
        s.emit('joinRoomCasebattle');
        for (const b of await findOwnBattles(s, host))
            lines.push(`${host.name}: has a battle open (${b.id}, ${b.status}${b.from === 'lobby' ? ', in the lobby' : ', left by the hub'}) — ${b.status === 'waiting' ? 'live would delete it before hosting' : 'live would wait for it to end'}`);
        s.emit('exitRoomCasebattle');
    } catch (e) { lines.push(`${host.name}: couldn't check for an open battle (${e.message})`); }
    finally { if (s) { try { s.close(); } catch (_) {} } }
}

// One battle: the host creates it, each joiner joins from its own socket, wait for the end.
// announce(): called once the account is clear to host (its earlier battle gone), so a wait logs nothing new each retry.
// Accounts being seated in a battle (created, joined): their casino games wait between plays, or the site refuses the
// battle with "User is locked" (seen live, 2026-11-12: a blackjack hand held the account).
const seating = new Map();   // account id -> battles seating it now
// Published as ctx.shared "armory/seating" (account ids) so Games, playing the same accounts, waits between plays too.
const seat = (ids, d) => {
    for (const id of ids) { const n = Math.max(0, (seating.get(id) || 0) + d); if (n) seating.set(id, n); else seating.delete(id); }
    if (ctx.shared) ctx.shared.set('seating', seating.size ? [...seating.keys()] : null);
};
const beingSeated = (id) => (seating.get(id) || 0) > 0;

async function battle(host, joiners, cs, rounds, players, timeshift, announce, teams = 1) {
    let price = +(num(cs.price) * rounds).toFixed(2);
    const socks = [];
    let battleId = null, closed = false, h = null;   // closed: finished, or deleted by us; h: the host's socket
    const sock = async (a) => { const x = await connectSocket(a.id); socks.push(x); return x; };
    for (const a of [host, ...joiners]) enter(a.id, 1);
    const seated = [host, ...joiners].map(a => a.id);
    let seatingNow = true;
    seat(seated, 1);
    const doneSeating = () => { if (seatingNow) { seatingNow = false; seat(seated, -1); } };
    try {
        h = await sock(host);
        h.emit('joinRoomCasebattle');
        await clearOwnBattle(h, host);
        if (announce) announce();
        const create = async () => {
            h.emit('createGame', { teams, playerCount: players, isPrivate: true, battlePrice: price, cases: [cs.byId ? { _id: cs._id, count: rounds } : { ...cs, count: rounds }],
                mode: teams === 2 || modeOf() !== 'coop' ? 'standard' : 'coop', isCrazyMode: false, isTimeshift: !!timeshift });
            return h.wait(['gameCreated', 'casebattleError'], 15000);
        };
        let c = await create();
        // Busy with a casino play that was already going: it ends in a moment and the next one waits.
        for (let i = 0; i < 10 && c && c.ev === 'casebattleError' && BUSY.test(String(c.data)); i++) { await ctx.sleep(2000); c = await create(); }
        // "no game created": the site refuses a create now and then (about 1 in 20 live, 2026-11-12) and takes the same
        // one a moment later: one more try before giving the battle up.
        if (c && c.ev === 'casebattleError' && /no game created/i.test(String(c.data))) { await ctx.sleep(NO_GAME_RETRY_MS); c = await create(); }
        // Still hosting one the checks above didn't find (not in the lobby, not ours on disk): look once more, then retry.
        if (c && c.ev === 'casebattleError' && /host 1|at a time/i.test(String(c.data))) {
            h.emit('joinRoomCasebattle');
            await clearOwnBattle(h, host);
            c = await create();
        }
        if (!c) throw new Stop('the site didn\'t answer the new battle');
        if (c.ev === 'casebattleError') {
            const why = typeof c.data === 'string' ? c.data : JSON.stringify(c.data);
            if (cs.byId && !caseGone.has(cs._id) && /no game created|case/i.test(why)) {
                caseGone.add(cs._id);
                ctx.log(`the site won't make a battle with ${cs.name} (${why}) — Prisma Case from the next battle on`, 'warn', host.id);
            }
            throw new Stop('battle not created: ' + why);
        }
        const id = typeof c.data === 'string' ? c.data : c.data && (c.data._id || c.data.gameId);
        battleId = id;
        setHosting(host.id, id);
        // A case sent by id: its name and price as the site has them (for the logs, the cash check and the totals).
        if (cs.byId && !learned.has(cs._id)) {
            const g = await battleInfo(h, id);
            const k = g && (g.cases || []).find(x => x && x._id === cs._id);
            if (k) { learned.set(cs._id, { name: k.name || cs.name, price: num(k.price) }); cs.name = k.name || cs.name; cs.price = num(k.price); }
            if (g && num(g.battlePrice)) price = num(g.battlePrice);
        }
        // Out of the lobby once the battle exists (the user's ask, 2026-11-11): the host watches only its own battle.
        h.emit('exitRoomCasebattle');
        h.emit('watchGame', id);
        let joined = 0;
        const uids = new Set();
        for (const [i, a] of joiners.entries()) {
            const g = await sock(a);
            g.emit('watchGame', id);
            const session = await sessionOf(a.id);
            uids.add(session.user.id);
            g.emit('joinGame', { session, gameId: id, bot: false, index: i + 1 });
            let err = await g.wait(['casebattleError'], 1500);
            // Busy with a casino play already going (a crash round): it ends shortly and the next one waits (seating).
            for (let k = 0; k < 15 && err && BUSY.test(String(err.data)); k++) {
                await ctx.sleep(2000);
                g.emit('joinGame', { session, gameId: id, bot: false, index: i + 1 });
                err = await g.wait(['casebattleError'], 1500);
            }
            g.emit('exitWatchGame', id);   // joined (or refused): no need to sit in the battle's watch room
            if (err) ctx.log(`${a.name} couldn't join ${host.name}'s battle: ${typeof err.data === 'string' ? err.data : JSON.stringify(err.data)}`, 'warn', a.id);
            else joined++;
        }
        doneSeating();
        // The seats as the site has them: a join can be refused after the moment waited for it, or taken without a seat
        // (the half-full battles above). Our accounts actually seated count; with no answer, the joins without an error.
        const now = await battleInfo(h, id);
        if (now && now.status === 'waiting') {
            const ours = (now.players || []).filter(p => p && uids.has(p.userId)).length;
            if (ours < joined) ctx.log(`${joined - ours} of ${host.name}'s joiners didn't get a seat — bots take the empty ones`, 'warn', host.id);
            joined = Math.min(joined, ours);
        }
        if (!joined && joiners.length) {
            const r = await deleteBattle(h, id);
            if (r === 'gone') { closed = true; throw new Stop('nobody could join — battle deleted'); }
            if (!r) throw new Stop('nobody could join, and the site refuses to delete the battle or add bots — battle cancelled');
            ctx.log(`nobody could join ${host.name}'s battle and the site didn't delete it — bots filled it`, 'warn', host.id);
        }
        // Seats nobody of ours took (a joiner refused): bots, so the battle starts instead of waiting forever.
        let botsAt = 0;
        if (now ? now.status === 'waiting' && seatsTaken(now) < players && joined < players - 1 : joined < players - 1) { h.emit('joinBots', { gameId: id }); botsAt = Date.now(); }
        // Watchdog (a tester, 2026-11-11): a battle that never started — a join the site took without seating the
        // account, or bots that never came — held its host and joiners until the time below ran out. Not started after
        // JOIN_WAIT_MS: bots take the empty seats; still not started JOIN_WAIT_MS later: the battle is deleted.
        const joinWait = num(S('joinWaitMs')) || JOIN_WAIT_MS;
        const silentMs = num(S('silentMs')) || SILENT_MS;
        let last = null, started = false, deadline = Date.now() + joinWait;
        let until = Date.now() + rounds * (timeshift ? ROUND_SECS_TS : ROUND_SECS) * 1500 + 60000;
        const latest = until + OFFLINE_MAX_MS;
        // heard: the last word about this battle; asked: questions since then; round/movedAt: the round and when it moved.
        let heard = Date.now(), asked = 0, round = -1, movedAt = Date.now(), errSaid = false;
        // Out of touch (a dropped socket, the site down for maintenance): the host's socket is opened again and watches the
        // battle once more. The time away is added to the allowance (up to OFFLINE_MAX_MS): the battle plays on without us.
        const reconnect = async () => {
            const from = Date.now();
            ctx.log(`lost touch with ${host.name}'s battle${paused(host.id) ? ' (the site is paused)' : ''} — reconnecting`, 'warn', host.id);
            for (let i = 0; ; i++) {
                if (ctx.stopping) throw new Stop('turned off');
                if (stoppedClicking(host.id)) throw new Stop('the account stopped clicking');
                if (Date.now() - from > OFFLINE_MAX_MS) throw new Stop(`lost touch with the battle for ${ago(Date.now() - from)} — left it`);
                if (!paused(host.id)) {
                    try {
                        try { h.close(); } catch (_) {}
                        h = await sock(host);
                        h.emit('watchGame', id);
                        h.emit('caseBattleInfo', id);
                        ctx.log(`back in touch with ${host.name}'s battle after ${ago(Date.now() - from)}`, 'ok', host.id);
                        return Date.now() - from;
                    } catch (e) { if (e instanceof Stop) throw e; }
                }
                await ctx.sleep(Math.min(PAUSE_WAIT_MS, 2000 * 2 ** Math.min(i, 4)));
            }
        };
        while (Date.now() < until) {
            if (ctx.stopping) throw new Stop('turned off');
            if (!started && Date.now() >= deadline) {
                if (botsAt) {
                    const r = await deleteBattle(h, id);
                    if (r === 'bots') { started = true; continue; }   // the second bots call took: it plays out
                    closed = r === 'gone';   // refused: its id stays, and the next check tries again
                    throw new Stop(`the battle didn't start within ${Math.round(2 * joinWait / 1000)} s, even with bots — battle cancelled${closed ? '' : ' (the site refused the delete: tried again later)'}`);
                }
                ctx.log(`${host.name}'s battle hasn't started after ${Math.round(joinWait / 1000)} s — bots take the empty seats`, 'warn', host.id);
                h.emit('joinBots', { gameId: id }); botsAt = Date.now(); deadline = botsAt + joinWait;
            }
            const step = Math.max(250, Math.min(15000, silentMs / 2, started ? Infinity : deadline - Date.now()));
            const e = await h.wait(['game', 'caseBattleInfo', 'casebattleError', 'gameFinished', 'gameDeleted'], step);
            if (!e) {
                if (Date.now() - heard < silentMs) continue;
                // Quiet for a while: ask about it (an answer counts as word); a socket that can't send, or two questions
                // without an answer, mean the connection is gone.
                if (asked < 2 && h.emit('caseBattleInfo', id) !== false) { asked++; heard = Date.now() - silentMs / 2; continue; }
                const away = await reconnect();
                until = Math.min(latest, until + away + silentMs);
                heard = movedAt = Date.now(); asked = 0;
                if (!started) deadline = Date.now() + joinWait;
                continue;
            }
            // An error on the host's socket isn't always about this battle (a bots call that came too late, "no empty
            // slots"): said once, then the battle is looked at again; the watchdog and the stuck check do the rest.
            if (e.ev === 'casebattleError') {
                const msg = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
                if (!errSaid) ctx.log(`${host.name}'s battle: the site said "${msg}" — checking on it`, 'warn', host.id);
                errSaid = true; h.emit('caseBattleInfo', id); continue;
            }
            if (e.ev === 'gameFinished' || e.ev === 'gameDeleted') {
                if ((typeof e.data === 'string' ? e.data : e.data && e.data._id) !== id) continue;
                heard = Date.now(); asked = 0;
                if (e.ev === 'gameDeleted') { closed = true; throw new Stop('the battle was cancelled on the site'); }
                h.emit('caseBattleInfo', id);   // its final state, with the skins, comes next
                continue;
            }
            const game = Array.isArray(e.data) ? e.data[0] : e.data;
            if (!game || (game._id && game._id !== id)) continue;
            heard = Date.now(); asked = 0;
            last = game;
            if (game.status && game.status !== 'waiting') started = true;
            if (game.status === 'finished') { closed = true; break; }
            if (game.currentRound != null && num(game.currentRound) !== round) { round = num(game.currentRound); movedAt = Date.now(); }
            // The site answers but the battle doesn't move: stuck on its side. The host and joiners are freed for other
            // battles; the host's next battle waits for this one (clearOwnBattle), which keeps being looked at.
            if (started && Date.now() - movedAt >= stuckMs()) {
                const tot = num(game.rounds) || rounds;
                const st = noteRunning(host.id, { id, round, rounds: tot, since: movedAt });
                st.said = true; save();
                throw new Stop(`stuck: ${host.name}'s battle hasn't moved past round ${round} of ${tot} for ${ago(Date.now() - movedAt)} — left it; ${host.name} keeps joining the others' battles`);
            }
        }
        if (!last || last.status !== 'finished') throw new Stop('the battle didn\'t finish in time');
        const value = (last.openedSkins || []).reduce((t, x) => t + num(x.price), 0);
        return { id, rounds: num(last.rounds) || rounds, price, players: (last.players || []).length || players, joined, value };
    } finally {
        doneSeating();
        if (battleId && h) { try { h.emit('exitWatchGame', battleId); } catch (_) {} }
        if (closed && battleId) setHosting(host.id, null, battleId);
        for (const x of socks) { try { x.close(); } catch (_) {} }
        for (const a of [host, ...joiners]) enter(a.id, -1);
    }
}

// One account's hosting for the turn: battle after battle while it fits, with everyone else joining.
async function hostLoop(host, others, cs, ends, practice, lines) {
    let done = 0, waiting = false, busySaid = false, fails = 0, pausedSaid = false;   // waiting: on its earlier battle, already said once; fails: in a row
    if (practice) await previewOwnBattles(host, lines);
    while (Date.now() < ends && !halt && !ctx.stopping && !isOut(host.id)) {
        const keep = num(S('keepMoney'));
        let me;
        try { me = await snapshot(host); }
        catch (e) {
            // The site down (maintenance) or the account paused for it: wait for it to come back, said once.
            if (paused(host.id) || SITE_DOWN.has(e.kind)) {
                if (!pausedSaid) ctx.log(`battles wait: the site isn't answering (${paused(host.id) ? 'paused' : e.message}) — hosting goes on when it's back`, 'warn', host.id);
                pausedSaid = true; await ctx.sleep(PAUSE_WAIT_MS); continue;
            }
            ctx.log('battle: ' + e.message, 'warn', host.id); return;
        }
        if (!practice && await battlesOff(host.id)) {
            if (!pausedSaid) ctx.log('case battles are switched off on the site right now — hosting waits', 'warn', host.id);
            pausedSaid = true; await ctx.sleep(PAUSE_WAIT_MS); continue;
        }
        if (pausedSaid) { pausedSaid = false; ctx.log('the site is answering again — hosting goes on', 'ok', host.id); }
        if (me.host <= 0) { if (!done) lines.push(`${host.name}: no hosted battles left today`); return; }
        const pool = [];
        for (const a of others) { if (isOut(a.id)) continue; try { const x = await sharedSnapshot(a); if (x.guest > 0) pool.push(x); } catch (_) {} }
        const pkg = me.pkg && !!S('package');
        // The accounts in the fewest battles right now first (then the most joins left today), taken at once (no wait
        // between choosing and counting them in) so the next host sees them as busier.
        pool.sort((x, y) => ((inBattle.get(x.id) || 0) - (inBattle.get(y.id) || 0)) || (y.guest - x.guest));
        const lu = lineup(Math.min(pool.length, (pkg ? PACKAGE_PLAYERS : PLAYERS) - 1) + 1, pkg);
        const joiners = pool.slice(0, lu.seats - 1);
        for (const j of joiners) { enter(j.id, 1); const c = snaps.get(j.id); if (c) c.v = { ...c.v, guest: c.v.guest - 1 }; }
        let held = true;
        const release = () => { if (held) { held = false; for (const j of joiners) enter(j.id, -1); } };
        try {
        // A lone star account battles the site's bot (joinBots fills the seat); with others, only they join.
        if (!joiners.length && others.length) { if (!done) lines.push(`${host.name}: nobody left to join today`); return; }
        const players = Math.max(2, joiners.length + 1), timeshift = pkg, teams = players === lu.seats ? lu.teams : 1;
        // Always full battles (the host's maximum: 100, 200 with the package; joiners don't need it): a battle's XP lands
        // only when it ends, and the other games fill the passes meanwhile (full ones restart within a minute, battles or
        // not), so the room at the start says nothing about the room at the end. A short battle wastes a daily host and
        // guest play; a full one ending near a full pass loses only the overflow (~5 XP a battle on average).
        const all = [me, ...joiners];
        if (S('passes') && !practice) for (const a of all) { try { await tendPasses(a, false, []); } catch (_) {} }
        const rounds = Math.max(1, Math.min(num(S('rounds')) || Infinity, me.maxRounds));
        const cost = num(cs.price) * rounds;
        const broke = all.filter(a => a.cash - cost < keep);
        if (broke.length) { if (!done) lines.push(`${host.name}: not enough cash for a ${rounds}-round battle (${broke.map(a => a.name).join(', ')})`); return; }
        // Only a battle that fits in the turn: the other plugins wait while battles run.
        if (!practice && done && Date.now() + rounds * (timeshift ? ROUND_SECS_TS : ROUND_SECS) * 1000 > ends) return;
        const what = `${host.name} hosts ${joiners.length ? joiners.map(a => a.name).join(', ') : 'the site bot'}: ${modeLabel(players, teams)}, ${rounds} rounds of ${cs.name} (${money(cost)} each)${timeshift ? ', timeshift' : ''}`;
        if (practice) { lines.push('battle — ' + what + ` · ${host.name} can host ${me.host} more today`); return; }
        try {
            // battle() counts everyone in itself (before its first wait), so the hold is handed over in the same moment.
            release();
            const r = await battle(me, joiners, cs, rounds, players, timeshift, () => { waiting = false; ctx.log('battle: ' + what, 'info', host.id); }, teams);
            const t = today();
            t.battles++; t.rounds += r.rounds; t.spent += r.price * (r.joined + 1);
            state.history = [{ t: Date.now(), host: host.name, guest: joiners.map(a => a.name).join(', ') || 'bot', players: r.players, rounds: r.rounds, price: r.price, value: r.value }, ...(state.history || [])].slice(0, 40);
            ctx.log(`battle done: ${r.players} players, ${r.rounds} rounds — +${r.rounds} XP for each of ours; pot ${money(r.price * r.players)}, skins worth ${money(r.value)}`, 'ok', host.id);
            save();
            done++; fails = 0;
        } catch (e) {
            // A socket that won't connect (a slow proxy) or another surprise: this host waits a moment and tries once more,
            // then sits out the turn. It never ends the turn for everyone (that freed the accounts while jackpots still ran).
            // Slow connects come in bursts of a minute or two (all the proxies' check windows busy at once, seen live
            // 2026-11-12): waiting longer each time gets past one (one quick retry left 22 hosts out of a turn).
            // Turned off mid-call (a socket opened as it stopped says "plugin stopped"): that's the stop, not a failure to retry.
            if (!(e instanceof Stop) && ctx.stopping) e = new Stop('turned off');
            if (!(e instanceof Stop) && paused(host.id)) { await ctx.sleep(PAUSE_WAIT_MS); continue; }   // the site paused: not this host's failure
            if (!(e instanceof Stop)) {
                if (++fails > CONNECT_RETRY_MS.length) { ctx.log('battle stopped for this turn: ' + e.message, 'warn', host.id); return; }
                ctx.log(`battle: ${e.message} — trying again in ${Math.round(CONNECT_RETRY_MS[fails - 1] / 1000)} s`, 'warn', host.id);
                await ctx.sleep(CONNECT_RETRY_MS[fails - 1]); continue;
            }
            // Waiting out its earlier battle: said once, then quiet until it ends (the user, 2026-11-11).
            if (/still running/.test(e.message)) {
                // Stuck (its round hasn't moved for minutes): the host stops hosting for now and keeps joining.
                if (e.stuck) {
                    const s = e.stuck;
                    if (!s.said) { s.said = true; save(); ctx.log(`${host.name}'s earlier battle looks stuck: round ${s.round} of ${s.rounds || '?'}, no progress for ${ago(Date.now() - s.since)} — ${host.name} skips hosting until it ends and keeps joining the others' battles`, 'warn', host.id); }
                    return;
                }
                if (!waiting) ctx.log(`${host.name}'s earlier battle is still running — waiting for it to end before hosting again`, 'warn', host.id);
                waiting = true;
                await ctx.sleep(num(S('joinWaitMs')) || 30000); continue;
            }
            // The account busy with another of its actions (making skins, an upgrade): try again in a moment, said once.
            if (BUSY.test(e.message)) { if (!busySaid) ctx.log('battle waits: ' + e.message.replace(/^battle not created: /, ''), 'warn', host.id); busySaid = true; await ctx.sleep(3000); continue; }
            ctx.log('battle stopped: ' + e.message, 'warn', host.id);
            if (/not created|nobody could join|battle cancelled|^stuck|lost touch|refuses to delete/.test(e.message)) return;
        }
        } finally { release(); }
    }
}

async function battleTurn(practice, lines, list, ends) {
    if (battling) return;
    battling = true;
    try {
        if (!list.length) { lines.push('battles: no star farming account is clicking and free'); return; }
        await loadCases(list[0].id);
        const cs = battleCase();
        if (!cs) { lines.push('battles: no battle case available'); return; }
        // Every account hosts at the same time; the others join each of those battles.
        // Started a little apart (all within the first half of the turn, however short), not all in the same instant.
        const step = Math.min(HOST_STAGGER_MS, Math.max(0, (ends - Date.now()) / (2 * list.length)));
        await Promise.all(list.map((h, i) => (practice || !i ? Promise.resolve() : ctx.sleep(i * step))
            .then(() => hostLoop(h, list.filter(a => a.id !== h.id), cs, ends, practice, lines))
            // A battle it still has open when its hosting ends (out of hosted battles today, out of cash, nobody to
            // join): looked at now, not on the next day it hosts.
            .then(() => { if (!practice && !ctx.stopping && savedBattle(h.id) && !isOut(h.id)) return tidyOne(h, 'tidying up'); })));
    } finally {
        battling = false;
    }
}

// ---- coinflip and jackpot ----
// Coinflips, upgrades and jackpots stay inside the passes' room (minus jackpot XP still to land when rounds end);
// battles don't (see hostLoop).
const reserved = new Map();  // account id -> XP still to land from jackpot rounds it's in
const reserve = (id, d) => reserved.set(id, Math.max(0, (reserved.get(id) || 0) + d));

async function roomFor(a) {
    if (!S('passes')) return Infinity;
    const arm = await json(a.id, '/api/armory');
    const xp = (arm.armoryPasses || []).map(x => num(x.xp));
    const p = state.passes[a.id];
    if (p) state.passes[a.id] = { ...p, t: Date.now(), credits: num(arm.credits), xp };
    return (xp.length ? FULL_XP - Math.max(...xp) : FULL_XP) - (reserved.get(a.id) || 0);
}

// Coinflip (socket, tokens): joinRoomCoinflip -> games [...]; createGameCoinflip { bet } -> newGame { _id, host }
// (to everyone in the room); joinGameCoinflip(gameId, bot, session) -> joinedGame { _id, status: 'finished', winner:
// 'host'|'guest' }. Games are public, so another player can take one first: that still counts for the host.
// 2 XP per flip for host and guest (measured), 500 hosted + 500 joined a day; 1-token flips between own accounts
// cost nothing on average.
const CF_XP = 2;
const BUSY = /locked|another action|wait a moment/i;   // the site's ways of saying the account is busy with something else
async function coinflipTurn(list, practice, lines, ends) {
    if (list.length < 2) return;
    const bet = Math.max(1, Math.floor(num(S('coinflipBet')) || 1));
    const keep = num(S('keepTokens'));
    // Pair every account with the next one, both ways round, so each hosts and joins.
    const pairs = list.map((h, i) => [h, list[(i + 1) % list.length]]).filter(([h, g]) => h.id !== g.id);
    const lim = new Map();
    for (const a of list) { try { lim.set(a.id, await json(a.id, '/api/gameLimitations')); } catch (_) {} }
    await Promise.all(pairs.map(async ([h, g]) => {
        const lh = lim.get(h.id), lg = lim.get(g.id);
        if (!lh || !lg) return;
        let n = Math.min(num(lh.coinflipHostLeft), num(lg.coinflipGuestLeft), Math.max(1, num(S('coinflipBurst')) || 500));
        if (n <= 0) return;
        if (practice) { lines.push(`coinflip — ${h.name} hosts ${n} ${bet}-token flips, ${g.name} joins (+${n * CF_XP} XP each)`); return; }
        try { n = Math.min(n, Math.floor(Math.min(await roomFor(h), await roomFor(g)) / CF_XP)); } catch (_) { return; }
        if (n <= 0) return;
        let hs = null, gs = null, done = 0, sniped = 0, net = 0, waits = 0;
        try {
            const session = await sessionOf(g.id);
            hs = await ctx.socket(h.id); gs = await ctx.socket(g.id);
            hs.emit('joinRoomCoinflip'); gs.emit('joinRoomCoinflip');
            await hs.wait(['games'], 8000); await gs.wait(['games'], 8000);
            for (let i = 0; i < n && Date.now() < ends && !ctx.stopping && !halt && !isOut(h.id) && !isOut(g.id); i++) {
                if (i % 25 === 0) {
                    const me = await json(h.id, '/api/me'), them = await json(g.id, '/api/me');
                    if (num(me.tokens) - bet * 25 < keep || num(them.tokens) - bet * 25 < keep) { lines.push(`coinflip: not enough tokens (${h.name} / ${g.name})`); break; }
                }
                hs.emit('createGameCoinflip', { bet });
                let id = null, busy = false;
                for (let k = 0; k < 20 && !id; k++) {
                    const e = await hs.wait(['newGame', 'coinflipError'], 5000);
                    if (!e) break;
                    if (e.ev === 'coinflipError' && BUSY.test(String(e.data))) { busy = true; break; }
                    if (e.ev === 'coinflipError') throw new Stop('coinflip: ' + e.data);
                    if (e.data && e.data.host && e.data.host.name === h.name && e.data.status === 'waiting') id = e.data._id;
                }
                if (busy) { i--; if (++waits > 40) throw new Stop('coinflip: the account stayed busy'); await ctx.sleep(1500); continue; }
                if (!id) throw new Stop('coinflip: the new flip never showed up');
                gs.emit('joinGameCoinflip', id, false, session);
                let res = null;
                for (let k = 0; k < 30 && !res; k++) {
                    const e = await gs.wait(['joinedGame', 'coinflipError'], 6000);
                    if (!e) break;
                    if (e.ev === 'coinflipError' && BUSY.test(String(e.data))) { await ctx.sleep(1500); gs.emit('joinGameCoinflip', id, false, session); if (++waits > 40) throw new Stop('coinflip: the account stayed busy'); continue; }
                    if (e.ev === 'coinflipError') { res = { sniped: true }; break; }   // someone else joined it first
                    if (e.data && e.data._id === id) res = e.data;
                }
                if (!res) throw new Stop('coinflip: no answer to the join');
                if (res.sniped) sniped++;
                else { done++; net += res.winner === 'host' ? bet : -bet; }
            }
        } catch (e) {
            if (!(e instanceof Stop)) throw e;
            ctx.log(e.message, 'warn', h.id);
        } finally { if (hs) hs.close(); if (gs) gs.close(); }
        const t = today();
        t.coinflips = (t.coinflips || 0) + done + sniped;
        if (done || sniped) ctx.log(`coinflip: ${h.name} hosted ${done + sniped}, ${g.name} joined ${done}${sniped ? ` (${sniped} taken by other players)` : ''} — +${(done + sniped) * CF_XP} / +${done * CF_XP} XP`, 'ok', h.id);
    }));
}

// Jackpot (socket, skins): joinRoomJackpot; watchGameJackpot(<room>) -> gameInfoJackpot { _id, status, time,
// maxDeposit, players, depositedSkins }; addSkinJackpot(skinId, gameId) -> skinAddedJackpot <skinId> | errorJackpot.
// Standard rooms 'low' ($1k max deposit), 'medium' ($10k), 'high' ($100k), 'ultra' ($1M), open to everyone; a Pro
// account can host one custom room: createGameJackpot { time, maxDeposit, isPrivate } -> gameCreatedJackpot <id>,
// others deposit into it by id (after watchGameJackpot). A round starts once two players are in and runs `time` seconds
// (30-600); the winner gets every skin.
const ROOMS = ['low', 'medium', 'high', 'ultra'];
async function cheapSkins(a, max, want) {
    const first = await json(a.id, '/api/inventory?page=1&sort=price');
    const out = [];
    for (let p = num(first.pages); p >= 1 && out.length < want; p--) {
        const j = p === 1 ? first : await json(a.id, `/api/inventory?page=${p}&sort=price`);
        for (const s of [...(j.skins || [])].reverse()) {
            if (out.length >= want) break;
            if (num(s.price) <= 0 || num(s.price) > max || s.favorite || s.isFavorite || s.isTerminal || s.isSticker || s.isKeychain || /sticker|charm|keychain|graffiti|patch/i.test(s.type || '')) continue;
            out.push(s);
        }
        if ((j.skins || []).length && num(j.skins[0].price) > max) break;   // the rest of the pages cost more
    }
    return out;
}

// Upgrade (REST, tokens into a skin): GET /api/casino/upgrade/skins?price=<target $>&name=&totalPrice=<stake $> ->
// skins around that price; POST /api/casino/upgrade { userSkinReq: null, userTokensReq, upgradeSkinReq: <skin> } ->
// { result, random, skin }. A token stakes $0.07 (after the site's 30% fee) and the chance is stake / price, at most
// 90%. Measured: 1 token on a $0.10 skin (70%) won it, and every upgrade is 10 XP on all passes (300 a day). So
// upgrades are cheap XP that also make the skins jackpot deposits need.
const UP_XP = 10;
let upTarget = null, upTargetAt = 0;
async function upgradeTarget(a) {
    if (upTarget && Date.now() - upTargetAt < CASES_MS) return upTarget;
    const max = num(S('jackpotSkinMax')) || 0.1;
    const list = await json(a.id, `/api/casino/upgrade/skins?price=${max}&name=&totalPrice=0.05`);
    upTarget = (Array.isArray(list) ? list : []).filter(s => num(s.price) > 0 && num(s.price) <= max).sort((x, y) => num(x.price) - num(y.price))[0] || null;
    upTargetAt = Date.now();
    return upTarget;
}

// The Converter's Dragon Lore accounts: they spend the day's 300 upgrades on 5M-token tries (10 XP each all the same).
const dloreAccts = () => new Set((ctx.shared && ctx.shared.get('converter/dlore')) || []);

// Blackjack, crash, dice and plinko when Games isn't on and live: each account plays the ticked ones at the smallest
// bets, one game at a time, up to each daily limit and the passes' room, while its battles wait for their rounds.
// Stops when Games comes on (it takes them over).
async function casinoTurn(list, practice, lines, ends) {
    const games = VIA_GAMES.filter(g => S('farm_' + g));
    if (!games.length || gamesLive()) return;
    const keep = num(S('keepTokens'));
    await Promise.all(list.map(async (a) => {
        let lim;
        try { lim = await json(a.id, '/api/gameLimitations'); } catch (e) { lines.push(`${a.name}: games — ${e.message}`); return; }
        if (practice) {
            const plan = Object.entries(casino.GAMES).filter(([g, G]) => games.includes(g) && num(lim[G.limit]) > 0)
                .map(([, G]) => `${count(num(lim[G.limit]))} ${G.label.toLowerCase()}`);
            if (plan.length) lines.push(`games — ${a.name}: up to ${plan.join(', ')} at the smallest bets (Games is off, so the Armory plays them)`);
            return;
        }
        let res;
        try {
            res = await casino.playFor(a.id, { games, limits: lim, keep, ends,
                room: () => roomFor(a).catch(() => 0),
                tokens: async () => num((await json(a.id, '/api/me')).tokens),
                hold: () => beingSeated(a.id),
                stop: () => ctx.stopping || halt || gamesLive() || isOut(a.id) });
        } catch (e) { ctx.log('games: ' + e.message, 'warn', a.id); return; }
        const t = today();
        for (const r of res) {
            t.casino = (t.casino || 0) + r.plays;
            if (r.plays) ctx.log(`${r.label}: ${count(r.plays)} plays at the smallest bet (${r.net < 0 ? '−' : '+'}${count(Math.abs(r.net))} tokens) — +${count(r.xp)} XP${r.error ? ' · then ' + r.error : ''}`, 'ok', a.id);
            else if (r.error) ctx.log(`${r.label}: ${r.error}`, 'warn', a.id);
        }
    }));
}

async function upgradeTurn(list, practice, lines, ends) {
    const dl = dloreAccts();
    for (const a of list) if (dl.has(a.id) && practice) lines.push(`upgrade — ${a.name}: left to the Converter's Dragon Lore upgrades`);
    await Promise.all(list.filter(a => !dl.has(a.id)).map(async (a) => {
        let lim, target;
        try { lim = await json(a.id, '/api/gameLimitations'); target = await upgradeTarget(a); } catch (e) { lines.push(`${a.name}: upgrade — ${e.message}`); return; }
        if (!target) { lines.push(`upgrade — no target skin under ${money(num(S('jackpotSkinMax')) || 0.1)}`); return; }
        const tokens = Math.max(1, Math.floor(10 * 0.9 * num(target.price) * 1.4286));   // the site's 90% ceiling
        let n = Math.min(num(lim.upgradeHostLeft), Math.max(1, num(S('upgradeBurst')) || 300));
        if (n <= 0) return;
        if (practice) { lines.push(`upgrade — ${a.name}: ${n} upgrades of ${tokens} token${tokens === 1 ? '' : 's'} into ${target.name} (${money(num(target.price))}, ${Math.min(90, Math.round(0.07 * tokens / num(target.price) * 100))}%) · +${n * UP_XP} XP`); return; }
        try { n = Math.min(n, Math.floor(await roomFor(a) / UP_XP)); } catch (_) { return; }
        let done = 0, won = 0, slow = 0;
        const keep = num(S('keepTokens'));
        for (let i = 0; i < n && Date.now() < ends && !ctx.stopping && !halt && !isOut(a.id); i++) {
            if (i % 25 === 0) { const me = await json(a.id, '/api/me'); if (num(me.tokens) - tokens < keep) break; }
            const r = await ctx.request(a.id, '/api/casino/upgrade', { method: 'POST', body: { userSkinReq: null, userTokensReq: tokens, upgradeSkinReq: target } });
            if (r.kind !== 'ok') {
                const msg = (r.json && r.json.error) || 'HTTP ' + r.status;
                if (/locked|another action|wait a moment/i.test(msg)) { await ctx.sleep(3000); continue; }
                if (r.status === 429 && ++slow <= 5) { await ctx.sleep(5000); continue; }   // too many requests: back off
                ctx.log('upgrade: ' + msg, 'warn', a.id); break;
            }
            done++; if (r.json && r.json.result) won++;
            await ctx.sleep(100);
        }
        const t = today();
        t.upgrades = (t.upgrades || 0) + done;
        if (done) ctx.log(`upgrade: ${done} × ${tokens} token${tokens === 1 ? '' : 's'} into ${target.name} — ${won} won (+${done * UP_XP} XP)`, 'ok', a.id);
    }));
}

// Every round an account is in is 50 XP on all its passes (measured), whatever it put in: so each account puts its
// cheapest skin into every room that has a round going and moves on. A second skin into the same round is taken but
// counts for nothing (checked live), so it's one skin a round. A Pro account keeps a private room of its own
// (the site adds a bot to a waiting room, so a round starts even with one of ours); the other star accounts, Pro or
// not, put into it too. Each deposit counts against the daily jackpot limit (200).
const JP_XP = 50;
const ownRooms = new Map();   // Pro host account id -> its current private room id

async function userIdOf(a) {
    const s = await json(a.id, '/api/auth/get-session');
    return String((s && s.user && (s.user.id || s.user._id)) || '');
}

// Guess the Rank (REST, tokens): POST /api/casino/guesstherank { bet, game: 'cs2' } starts a round (a video);
// PATCH { rankId } guesses (cs2: premier ranks 1-7) -> { tokensWon, video: { rank, rating: [{ rating, count }] } }.
// Measured: 15 XP a guess, 25 when it's right (a 1-token bet pays 2 back); 100 a day. A PATCH with no round started
// is refused ("No running game found"). It guesses the rank that has been right most often so far (3 to start).
const GTR_XP = 25;   // the most a guess can give: what the passes need room for
async function gtrTurn(list, practice, lines, ends) {
    await Promise.all(list.map(async (a) => {
        let lim;
        try { lim = await json(a.id, '/api/gameLimitations'); } catch (_) { return; }
        let n = Math.min(num(lim.guessTheRankHostLeft), Math.max(1, num(S('gtrBurst')) || 100));
        if (n <= 0) return;
        const seen = state.gtrRanks = state.gtrRanks || {};
        const pick = () => Number(Object.entries(seen).sort((x, y) => y[1] - x[1])[0]?.[0] || 3);
        if (practice) { lines.push(`guess the rank — ${a.name}: ${n} 1-token guesses (rank ${pick()}), +15-25 XP each`); return; }
        try { n = Math.min(n, Math.floor(await roomFor(a) / GTR_XP)); } catch (_) { return; }
        let done = 0, right = 0, won = 0, slow = 0;
        for (let i = 0; i < n && Date.now() < ends && !ctx.stopping && !halt && !isOut(a.id); i++) {
            const r = await ctx.request(a.id, '/api/casino/guesstherank', { method: 'POST', body: { bet: 1, game: 'cs2' } });
            if (r.kind !== 'ok') {
                const msg = (r.json && r.json.error) || 'HTTP ' + r.status;
                if (BUSY.test(msg)) { i--; await ctx.sleep(1500); continue; }
                if (r.status === 429 && ++slow <= 5) { i--; await ctx.sleep(5000); continue; }   // too many requests: back off
                if (!/running/i.test(msg)) { ctx.log('guess the rank: ' + msg, 'warn', a.id); break; }   // a round left open: guess it below
            }
            const g = await ctx.request(a.id, '/api/casino/guesstherank', { method: 'PATCH', body: { rankId: pick() } });
            if (g.kind !== 'ok') {
                const msg = (g.json && g.json.error) || 'HTTP ' + g.status;
                if (BUSY.test(msg)) { await ctx.sleep(1500); continue; }
                if (g.status === 429 && ++slow <= 5) { await ctx.sleep(5000); continue; }
                ctx.log('guess the rank: ' + msg, 'warn', a.id); break;
            }
            done++;
            const rank = g.json && g.json.video && num(g.json.video.rank);
            if (rank) seen[rank] = (seen[rank] || 0) + 1;
            if (num(g.json && g.json.tokensWon) > 0) { right++; won += num(g.json.tokensWon); }
            await ctx.sleep(200);
        }
        const t = today();
        t.gtr = (t.gtr || 0) + done;
        if (done) ctx.log(`guess the rank: ${done} guesses, ${right} right (+${count(won)} tokens) — +${count(done * 15 + right * 10)} XP`, 'ok', a.id);
    }));
}

// Tokens into skins: POST /api/casino/tokensToSkins { tokens, type: 'skins' } -> 202 { message: 'queued', status:
// { state: 'running' } }; GET /api/casino/tokensToSkins -> { skins: [...] } once done (the last conversion's skins).
// Measured: 1 token = one ~$0.10 skin, 5 tokens = one $0.52 skin, no daily limit and no XP. The cheapest way to get
// jackpot skins: 1 token each.
async function tokenSkins(a, n, lines, ends) {
    const out = [], seen = new Set();
    const keep = num(S('keepTokens'));
    let tokens = num((await json(a.id, '/api/me')).tokens);
    for (let i = 0; i < n && Date.now() < ends && !ctx.stopping && !halt && !isOut(a.id); i++) {
        if (tokens - 1 < keep) { lines.push(`${a.name}: not enough tokens to make jackpot skins`); break; }
        const r = await ctx.request(a.id, '/api/casino/tokensToSkins', { method: 'POST', body: { tokens: 1, type: 'skins' } });
        if (r.kind !== 'ok') {
            const msg = (r.json && (r.json.error || r.json.message)) || 'HTTP ' + r.status;
            if (BUSY.test(msg)) { i--; await ctx.sleep(1500); continue; }
            ctx.log('tokens to skins: ' + msg, 'warn', a.id); break;
        }
        tokens--;
        for (let k = 0; k < 20; k++) {
            await ctx.sleep(400);
            const g = await ctx.request(a.id, '/api/casino/tokensToSkins');
            const j = g.kind === 'ok' && g.json;
            if (!j || (j.status && j.status.state === 'running') || !Array.isArray(j.skins)) continue;
            for (const s of j.skins) if (s && s._id && !seen.has(String(s._id))) { seen.add(String(s._id)); out.push(s); }
            break;
        }
    }
    const t = today();
    t.tokenSkins = (t.tokenSkins || 0) + out.length;
    if (out.length) ctx.log(`made ${out.length} jackpot skin${out.length === 1 ? '' : 's'} from tokens (worth ${money(out.reduce((x, s) => x + num(s.price), 0))})`, 'ok', a.id);
    return out;
}

// Battle sockets connecting at once, across all hosts: ~100 hosts opening theirs together time out through the proxies
// (51 in one turn live, 2026-11-12, in two bursts: the turn's start and when the first battles end). Only the connect
// waits its turn; an open socket doesn't hold a place.
const SOCKETS_AT_ONCE = 12;
let connecting = 0;
const connectQueue = [];
async function connectSocket(aid) {
    const cap = Math.max(1, num(S('socketsAtOnce')) || SOCKETS_AT_ONCE);
    while (connecting >= cap) await new Promise(res => connectQueue.push(res));
    connecting++;
    try { return await ctx.socket(aid); }
    finally { connecting--; const next = connectQueue.shift(); if (next) next(); }
}
const CONNECT_RETRY_MS = [3000, 10000, 20000];   // waits before a host tries a battle again after a failed connect
const NO_GAME_RETRY_MS = 3000;   // wait before trying a refused battle create again
const REFILL_AT = 20;   // skins left when the jackpot turn makes more from tokens

async function jackpotTurn(list, practice, lines, ends) {
    const max = num(S('jackpotSkinMax')) || 0.1;
    const standard = ROOMS.filter(r => S('jackpot_' + r));
    const hosts = S('jackpotCustom') ? list.filter(a => ctx.accounts.stats && (ctx.accounts.stats(a.id) || {}).membership === 'pro') : [];
    if (!standard.length && !hosts.length) return;
    const time = Math.max(30, Math.min(600, num(S('jackpotTime')) || 30));
    const rooms = [...standard.map(r => ({ key: r, room: r, label: r })), ...hosts.map(h => ({ key: 'own:' + h.id, host: h, label: `${h.name}'s room` }))];

    // Each account: what it can put in today, its cheap skins (made from tokens when short).
    const players = (await Promise.all(list.map(async (a) => {
        let lim;
        try { lim = await json(a.id, '/api/gameLimitations'); } catch (_) { return null; }
        const left = Math.min(num(lim.jackpotHostLeft), Math.max(1, num(S('jackpotBurst')) || 200));
        if (left <= 0) return null;
        let skins;
        try { skins = await cheapSkins(a, max, left); } catch (e) { lines.push(`${a.name}: jackpot — ${e.message}`); return null; }
        const short = S('jackpotTokenSkins') ? Math.max(0, Math.min(left, Math.max(1, num(S('jackpotMakeSkins')) || 100)) - skins.length) : 0;
        if (practice) {
            if (short) lines.push(`jackpot — ${a.name}: make ${short} skins from ${short} tokens first`);
            lines.push(skins.length || short ? `jackpot — ${a.name}: up to ${Math.min(left, skins.length + short)} deposits of skins under ${money(max)} into ${rooms.map(r => r.host && r.host.id === a.id ? 'own room' : r.label).join(', ')} (+${JP_XP} XP a round)`
                : `jackpot — ${a.name}: no skins under ${money(max)} to put in${S('upgrade') ? ' yet (upgrades make some)' : ''}`);
            return null;
        }
        if (short) { try { skins.push(...(await tokenSkins(a, short, lines, ends)).filter(x => num(x.price) > 0 && num(x.price) <= Math.max(max, 0.1))); } catch (e) { ctx.log('tokens to skins: ' + e.message, 'warn', a.id); } }
        if (!skins.length) { lines.push(`jackpot — ${a.name}: no skins under ${money(max)}`); return null; }
        try { await roomFor(a); return { a, left, start: num(lim.jackpotHostLeft), skins, uid: await userIdOf(a), joined: new Set(), botted: new Set(), done: 0, value: 0, byRoom: {} }; } catch (_) { return null; }
    }))).filter(Boolean);
    if (practice || !players.length) return;

    // One watcher keeps every room's current round on a shared board (id, status, who's in), so the accounts don't each
    // look rooms up: they put a skin in by round id, which needs no watching of their own (checked live).
    const board = new Map();   // room key -> { id, status, locked, time, players: Set(userId) }
    let watching = true;
    const watcher = (async () => {
        let s = null;
        try {
            s = await ctx.socket(players[0].a.id);
            s.emit('joinRoomJackpot');
            const listed = await s.wait(['gamesJackpot'], 8000);
            // A Pro account's private room that's still open (one at a time per host) is reused.
            for (const p of players) {
                const g = (Array.isArray(listed && listed.data) ? listed.data : []).find(x => x && x.gameMode === 'custom' && String(x.hostId) === p.uid && x.status !== 'finished');
                if (g) ownRooms.set(p.a.id, String(g._id));
            }
            while (watching && !ctx.stopping) {
                for (const r of rooms) {
                    const id = r.room || ownRooms.get(r.host.id);
                    if (!id) continue;
                    s.emit('watchGameJackpot', id);
                    // The room keeps sending updates and an older one can still be queued: only this room's info counts.
                    let g = null;
                    for (let k = 0; k < 10 && !g; k++) {
                        const e = await s.wait(['gameInfoJackpot', 'errorJackpot'], 8000);
                        if (!e || e.ev === 'errorJackpot') break;
                        const x = e.data || {};
                        if (r.room ? x.gameMode === r.room : String(x._id) === String(id)) g = x;
                    }
                    s.emit('exitWatchGameJackpot', id);
                    if (g && g._id) board.set(r.key, { id: String(g._id), status: g.status, locked: !!g.isLocked, time: num(g.time) || 30, players: new Set((g.players || []).filter(Boolean).map(p => String(p.userId))) });
                }
                await ctx.sleep(1000);
            }
        } catch (e) {
            if (!(e instanceof Stop)) ctx.log('jackpot watcher: ' + e.message, 'warn');
        } finally { if (s) s.close(); }
    })();

    // Mid-turn top-up: an account down to REFILL_AT skins with plays left today makes another batch from tokens in the
    // background (it keeps putting skins in meanwhile), so it doesn't run dry halfway through the turn.
    const cheapEnough = (x) => num(x.price) > 0 && num(x.price) <= Math.max(max, 0.1);
    const refill = (p) => {
        if (p.refilling || p.dry || !S('jackpotTokenSkins') || Date.now() >= ends || ctx.stopping || halt) return;
        const want = Math.min(p.left - p.skins.length, Math.max(1, num(S('jackpotMakeSkins')) || 100));
        if (want <= 0 || p.skins.length > REFILL_AT) return;
        const why = [];
        p.refilling = tokenSkins(p.a, want, why, ends)
            .then(made => { const ok = made.filter(cheapEnough); p.skins.push(...ok); p.refills = (p.refills || 0) + 1; if (!ok.length) p.dry = true; })
            .catch(e => { p.dry = true; ctx.log('tokens to skins: ' + e.message, 'warn', p.a.id); })
            .finally(() => { p.refilling = null; });
    };

    await Promise.all(players.map(async (p) => {
        const { a } = p;
        let s = null;
        try {
            s = await ctx.socket(a.id);
            for (;;) {
                if (!(p.left > 0 && Date.now() < ends && !ctx.stopping && !halt && !isOut(a.id))) break;
                refill(p);
                if (!p.skins.length) { if (p.refilling) { await p.refilling; continue; } break; }
                // Rounds land their XP later; when the passes have no room left (counting what's still to land), wait for
                // the minute check to restart the full ones.
                const pass = state.passes[a.id];
                if (S('passes') && pass && pass.xp.length && FULL_XP - Math.max(...pass.xp) - (reserved.get(a.id) || 0) <= 0) { await ctx.sleep(15000); continue; }
                for (const r of rooms) {
                    if (p.left <= 0 || !p.skins.length || Date.now() >= ends) break;
                    let round = board.get(r.key);
                    // A Pro account opens a new private room of its own when there's none or its last round is over.
                    if (r.host && r.host.id === a.id && (!ownRooms.get(a.id) || (round && round.status === 'finished'))) {
                        s.emit('createGameJackpot', { time, maxDeposit: Math.max(1, Math.ceil(max * 10)), isPrivate: true });
                        let c = await s.wait(['gameCreatedJackpot', 'errorJackpot'], 10000);
                        if (!c) {   // no answer while one is still open: find it in the room list
                            s.emit('joinRoomJackpot');
                            const l = await s.wait(['gamesJackpot'], 8000);
                            const m = (Array.isArray(l && l.data) ? l.data : []).find(x => x && x.gameMode === 'custom' && String(x.hostId) === p.uid && x.status !== 'finished');
                            if (m) c = { ev: 'gameCreatedJackpot', data: m._id };
                        }
                        if (!c || c.ev === 'errorJackpot') {
                            // Usually the account was busy: try again next pass, and give up on the room for this turn after 3.
                            if ((r.fails = (r.fails || 0) + 1) >= 3) { ctx.log(`jackpot: couldn't open a room — ${c ? c.data : 'no answer'}`, 'warn', a.id); rooms.splice(rooms.indexOf(r), 1); break; }
                            continue;
                        }
                        ownRooms.set(a.id, String(c.data));
                        round = { id: String(c.data), status: 'waiting', locked: false, time, players: new Set() };
                        board.set(r.key, round);
                    }
                    // An empty private room can refuse deposits ("No skins found", even from its host — checked live); once
                    // someone is in, everyone's go in. So the host puts in a bot first (the site's "Add Bot", worth ).
                    if (r.host && r.host.id === a.id && round && round.status === 'waiting' && !round.players.size && !p.botted.has(round.id)) {
                        s.emit('addBotJackpot', round.id, 1);
                        p.botted.add(round.id); round.players.add('bot');
                    }
                    if (r.host && round && !round.players.size) continue;   // nobody in yet: wait for the host's bot
                    if (!round || round.status === 'finished' || round.locked) continue;
                    // In this round already: one skin a round (the site counts one play and gives the XP once).
                    if (p.joined.has(round.id) || round.players.has(p.uid)) continue;
                    const skin = p.skins.shift();
                    s.emit('addSkinJackpot', skin._id, round.id);
                    // Only the answer for this skin counts (late answers for earlier tries can still be queued).
                    let res = null;
                    for (let k = 0; k < 5 && !res; k++) {
                        const e = await s.wait(['skinAddedJackpot', 'errorJackpot'], 8000);
                        if (!e) break;
                        if (e.ev === 'errorJackpot' || String(e.data) === String(skin._id)) res = e;
                    }
                    if (!res || res.ev === 'errorJackpot') {
                        const msg = res ? String(res.data) : 'no answer';
                        // Busy (another of the account's actions) or that round just ended: the skin wasn't used, try it
                        // again. "No skins found" comes back for a skin that goes in fine a moment later: busy too.
                        // A round that has started takes no more skins: keep the skin, skip the round till the next one.
                        if (/already (running|finished)/i.test(msg)) { p.skins.unshift(skin); round.locked = true; continue; }
                        if ((BUSY.test(msg) || /no skins? found|already finished/i.test(msg)) && (skin.tries = (skin.tries || 0) + 1) <= 3) { p.skins.unshift(skin); await ctx.sleep(1500); continue; }
                        ctx.log(`jackpot ${r.label}: ${msg} (${skin.name}, ${money(num(skin.price))})`, 'warn', a.id); continue;
                    }
                    p.done++; p.left--; p.value += num(skin.price); p.byRoom[r.label] = (p.byRoom[r.label] || 0) + 1;
                    p.joined.add(round.id); round.players.add(p.uid);
                    // Its 50 XP lands when the round ends: keep that room for it until then.
                    reserve(a.id, JP_XP);
                    setTimeout(() => reserve(a.id, -JP_XP), round.time * 1000 + 30000);
                }
                if (p.left > 0 && p.skins.length) await ctx.sleep(1000);   // the next rounds (the watcher keeps the board fresh)
            }
        } catch (e) {
            if (!(e instanceof Stop)) throw e;
            ctx.log('jackpot: ' + e.message, 'warn', a.id);
        } finally { if (s) s.close(); if (p.refilling) await p.refilling.catch(() => {}); }
        const t = today();
        t.jackpots = (t.jackpots || 0) + p.done;
        if (p.done) {
            // What the site counted (its daily limit) against what it took: a skin it takes without counting is wasted.
            let counted = null;
            try { counted = p.start - num((await json(a.id, '/api/gameLimitations')).jackpotHostLeft); } catch (_) {}
            const rooms = Object.entries(p.byRoom).map(([k, n]) => `${k} ${n}`).join(', ');
            ctx.log(`jackpot: put a skin into ${p.done} rounds (worth ${money(p.value)}; ${rooms})${counted != null && counted < p.done ? ` — but the site counted only ${counted}` : ''} — +${JP_XP} XP each round once it ends`, counted != null && counted < p.done ? 'warn' : 'ok', a.id);
        }
    })).finally(() => { watching = false; });
    await watcher;
}

// After a restart or an update: the battles the hub was hosting when it closed (state.hosting) are looked at as soon as
// their accounts are clicking again, not at the next turn (which can be a while off): still waiting for players, they're
// deleted (the cash back); still running, they're noted so a stuck one is told apart; ended, they're forgotten.
let recoverLeft = null;   // account ids still to look at; null until the plugin starts
const savedBattle = (aid) => ({ ...diskHosting(), ...(state.hosting || {}) })[aid];
// One account's leftover battle: deleted if still waiting, noted if running. false: it couldn't be looked at.
async function tidyOne(a, why) {
    let x = null;
    try {
        x = await connectSocket(a.id);
        x.emit('joinRoomCasebattle');
        try { await clearOwnBattle(x, a); }
        catch (e) {
            if (!(e instanceof Stop)) throw e;
            if (e.battle) { if (!e.stuck) ctx.log(`${why}: ${a.name}'s battle is still running${e.battle.round != null ? ` (round ${e.battle.round} of ${e.battle.rounds || '?'})` : ''} — its next battle waits for it`, 'info', a.id); }
            else if (e.refused) ctx.log(`${why}: ${a.name}: ${e.message}`, 'warn', a.id);
            else throw e;
        }
        x.emit('exitRoomCasebattle');
        return true;
    } catch (e) { ctx.log(`${why}: couldn't look at ${a.name}'s last battle (${e.message})`, 'warn', a.id); return false; }
    finally { if (x) { try { x.close(); } catch (_) {} } }
}
async function recoverHosting() {
    const now = chosen().filter(a => a.healthy && recoverLeft.has(a.id));
    for (const a of now) {
        recoverLeft.delete(a.id);
        if (savedBattle(a.id) && !(await tidyOne(a, 'after the restart'))) recoverLeft.add(a.id);
    }
}

async function check() {
    if (farming || recovering) return;
    farming = true;
    const practice = practiceMode();
    const lines = [], held = [];
    let lend = null, ends = 0;
    try {
        if (S('passes')) for (const a of chosen()) {
            if (!a.healthy) continue;
            try { await tendPasses(a, practice, lines); } catch (e) { lines.push(`${a.name}: passes — ${e.message}`); ctx.log('passes: ' + e.message, 'warn', a.id); }
        }
        // Battles, coinflips and jackpots all at once: joining has no per-account limit, and each burst stays inside
        // the passes' room.
        // The accounts are held for the whole turn (Games and the Opener wait), and the upgrades go first: two of an
        // account's actions at once make the site refuse one ("User is locked").
        // Games' runs don't count: it plays the same accounts alongside, pausing while a battle seats them (armory/seating).
        lent.clear();
        const list = chosen().filter(a => a.healthy && !wantedBy(a.id) && !(ctx.accounts.busy && ctx.accounts.busy(a.id, { ignore: ['games'] })));
        ends = Date.now() + (num(S('turnMs')) || Math.max(5, num(S('turnMin'))) * 60000);
        if (!practice && ctx.accounts.setBusy) for (const a of list) { ctx.accounts.setBusy(a.id, 'star farming'); held.push(a.id); }
        lend = setInterval(() => {
            for (const id of [...held]) {
                const w = wantedBy(id);
                if (!w || (inUse.get(id) || 0) > 0 || (inBattle.get(id) || 0) > 0) continue;
                lent.add(id); held.splice(held.indexOf(id), 1); ctx.accounts.setBusy(id, null);
                ctx.log(`star farming paused on this account for the rest of the turn — ${w.what} (${w.plugin})`, 'info', id);
            }
        }, 1000);
        if (S('upgrade')) await upgradeTurn(list, practice, lines, Math.min(ends, Date.now() + 5 * 60000)).catch(e => ctx.log('upgrade: ' + e.message, 'warn'));
        const jobs = [];
        if (S('battles')) jobs.push(battleTurn(practice, lines, list, ends).catch(e => ctx.log('battles: ' + e.message, 'warn')));
        // Coinflip is off for now: its flips are public, so they flood the site's coinflip page. coinflipTurn stays for when
        // there's a private way to flip.
        jobs.push(casinoTurn(list, practice, lines, ends).catch(e => ctx.log('games: ' + e.message, 'warn')));
        if (S('gtr')) jobs.push(gtrTurn(list, practice, lines, ends).catch(e => ctx.log('guess the rank: ' + e.message, 'warn')));
        if (S('jackpot')) jobs.push(jackpotTurn(list, practice, lines, ends).catch(e => ctx.log('jackpot: ' + e.message, 'warn')));
        await Promise.all(jobs);
    } catch (e) { ctx.log('stopped: ' + e.message, e instanceof Stop ? 'warn' : 'error'); }
    finally {
        clearInterval(lend);
        for (const id of held) {
            ctx.accounts.setBusy(id, null);
            const w = wantedBy(id);   // the turn ended early because the accounts were asked for
            if (w && Date.now() < ends) ctx.log(`star farming paused on this account for the rest of the turn — ${w.what} (${w.plugin})`, 'info', id);
        }
    }
    if (practice) { state.practiceAt = Date.now(); state.plans = { t: Date.now(), lines: lines.length ? lines : ['nothing to do right now'] }; }
    else for (const l of new Set(lines)) ctx.log(l);   // live, these are only what held something back
    halt = false;
    state.last = Date.now();
    save();
    farming = false;
}

module.exports = {
    start(c) {
        // Counts this plugin's requests and open sockets per account (lending, above).
        ctx = Object.create(c);
        ctx.request = async (aid, ...rest) => { use(aid, 1); try { return await c.request(aid, ...rest); } finally { use(aid, -1); } };
        ctx.socket = async (aid, ...rest) => {
            use(aid, 1);
            let s;
            try { s = await c.socket(aid, ...rest); } catch (e) { use(aid, -1); throw e; }
            const close = s.close.bind(s);
            let shut = false;
            s.close = (...x) => { if (!shut) { shut = true; use(aid, -1); } return close(...x); };
            return s;
        };
        casino = makeCasino(ctx);
        state = { last: 0, passes: {}, history: [], ...ctx.data.get() };
        today();
        const fill = async () => { if (cases && rewards) return; const a = ctx.accounts.list().find(x => x.healthy); if (a) { try { await loadCases(a.id); await loadRewards(a.id); } catch (_) {} } };
        fill();
        // Every minute: each star account's passes and credits (the shop shows them), and full passes are redeemed
        // (restarted for their credits) whether star farming is on or off — even under Games or a battle: XP past
        // level 40 would be lost, and a battle's XP only lands when it ends.
        let passAt = 0, passRunning = false;
        ctx.every(1000, async () => {
            if (passRunning || Date.now() - passAt < (num(S('everyMs')) ? 1000 : 60000)) return;
            passRunning = true; passAt = Date.now();
            try { await passMinute(); } finally { passRunning = false; }
        });
        async function passMinute() {
            const restart = S('passes') && S('restart');
            for (const a of chosen()) {
                if (!a.healthy) continue;
                try {
                    const arm = await json(a.id, '/api/armory');
                    const xp = (arm.armoryPasses || []).map(x => num(x.xp)), p = state.passes[a.id];
                    state.passes[a.id] = { name: a.name, slots: xp.length, ...p, t: Date.now(), credits: num(arm.credits), xp };
                    if (restart && p && xp.some(x => x >= FULL_XP)) await tendPasses(a, false, []);
                } catch (_) {}
            }
        }
        publish();
        // Battles left from before the restart: looked at for the first 10 minutes, as each account comes back.
        const startedAt = Date.now();
        const due = () => S('on') && !practiceMode() && !battling && !farming && !recovering
            && Date.now() - (state.last || 0) >= (num(S('everyMs')) || Math.max(1, num(S('everyMin'))) * 60000);
        recoverLeft = new Set(Object.keys({ ...diskHosting(), ...(state.hosting || {}) }));
        ctx.every(15000, () => {
            publish();
            fill();
            if (recoverLeft.size && Date.now() - startedAt > 10 * 60000) recoverLeft.clear();
            if (recoverLeft.size && S('on') && !practiceMode() && !farming && !battling && !recovering) {
                recovering = true;
                // A turn that's due starts right after (not a tick later).
                recoverHosting().catch(e => ctx.log('after the restart: ' + e.message, 'warn')).finally(() => { recovering = false; if (!ctx.stopping && due()) check(); });
                return;
            }
            if (due()) check();
        });
        ctx.panel.action('run', () => {
            if (!chosen().length) return { ok: false, error: 'Choose accounts first.' };
            if (farming || recovering) return { message: 'Already running.' };
            check();
            return { message: practiceMode() ? 'Practice run started — the plan shows up here in a moment.' : 'Checking now.' };
        });
        ctx.panel.action('stop', () => { if (!farming) return { message: 'Nothing running.' }; halt = true; return { message: 'Stopping after the current battle, flip or round.' }; });
        // Switching off (or to practice, which the host turns off) stops after the current battle or round.
        ctx.settings.onChange((key, value) => {
            if (key === 'on' && !value) halt = farming;
            else if (key === 'on' && value) state.last = 0;
        });

        // One game: its switch in the header, its own settings when opened, one line saying what a play is worth.
        const GAME_CARDS = [
            { id: 'g-battles', key: 'battles', title: 'Case battles', keys: ['battleCase', 'mode', 'rounds', 'package', 'keepMoney'],
                sum: () => { const cs = battleCase(); return `${cs ? cs.name : 'pick a case'} · ${num(S('rounds')) || 'full'} rounds · 1 XP a round`; } },
            { id: 'g-jackpot', key: 'jackpot', title: 'Jackpot', keys: ['jackpot_low', 'jackpot_medium', 'jackpot_high', 'jackpot_ultra', 'jackpotCustom', 'jackpotTime', 'jackpotSkinMax', 'jackpotTokenSkins'],
                sum: () => `${[...ROOMS.filter(r => S('jackpot_' + r)), ...(S('jackpotCustom') ? ['private rooms'] : [])].join(', ') || 'no rooms'} · 50 XP a round` },
            { id: 'g-upgrade', key: 'upgrade', title: 'Upgrade', sum: () => { const d = chosen().filter(a => dloreAccts().has(a.id)).length; return '1 token into a cheap skin · 10 XP each' + (d ? ` · not on ${d} Dragon Lore account${d === 1 ? '' : 's'} (Converter)` : ''); } },
            { id: 'g-gtr', key: 'gtr', title: 'Guess the Rank', sum: () => '1-token guesses · 15 XP, 25 when right' },
            { id: 'g-blackjack', key: 'farm_blackjack', title: 'Blackjack', sum: () => `${gamesLive() ? 'played by Games' : 'played here (Games is off)'} · 10 XP a hand` },
            { id: 'g-crash', key: 'farm_crash', title: 'Crash', sum: () => `${gamesLive() ? 'played by Games' : 'played here (Games is off)'} · 5 XP a bet` },
            { id: 'g-dice', key: 'farm_dice', title: 'Dice', sum: () => `${gamesLive() ? 'played by Games' : 'played here (Games is off)'} · 5 XP a roll` },
            { id: 'g-plinko', key: 'farm_plinko', title: 'Plinko', sum: () => `${gamesLive() ? 'played by Games' : 'played here (Games is off)'} · 0.5 XP a drop` },
        ];
        // Battles the site stopped playing: which host, where it stopped, for how long (none: nothing shown).
        const stuckNotice = () => {
            const names = new Map(ctx.accounts.list().map(a => [a.id, a.name]));
            const rows = Object.entries(state.stuck || {}).filter(([, s]) => Date.now() - s.since >= stuckMs())
                .map(([aid, s]) => `${names.get(aid) || 'an account'} (round ${s.round} of ${s.rounds || '?'}, ${ago(Date.now() - s.since)}${s.cancelAsked ? ', cancel asked' : ''})`);
            return rows.length ? [{ type: 'notice', level: 'warn', text: `Stuck battle${rows.length === 1 ? '' : 's'} on the site: ${rows.join(', ')}. ${rows.length === 1 ? 'That account skips' : 'Those accounts skip'} hosting until ${rows.length === 1 ? 'it ends' : 'they end'} and keep joining the others' battles.` }] : [];
        };
        ctx.panel.tab('Armory', () => {
            const t = today(), practice = practiceMode(), list = chosen(), n = list.length;
            const on = GAME_CARDS.filter(g => S(g.key)).length;
            const rows = list.map(a => { const p = state.passes[a.id]; return [a.name, p ? `${p.xp.length} / ${p.slots}` : '—', p ? p.xp.map(x => 'L' + Math.min(40, Math.floor(x / 100))).join(' · ') || '—' : '—', p ? count(p.credits) : '—']; });
            const plan = practice && state.plans && n ? state.plans : null;
            const levels = list.flatMap(a => ((state.passes[a.id] || {}).xp || []).map(x => Math.min(40, Math.floor(x / 100))));
            const lvl = levels.length ? Math.round(levels.reduce((x, y) => x + y, 0) / levels.length) : null;
            // The account pills: tokens, then its passes (average level and credits).
            const accountLines = Object.fromEntries(ctx.accounts.list().map(a => { const m = a.me || {}, p = state.passes[a.id], lv = p && p.xp.length ? Math.round(p.xp.reduce((t, x) => t + Math.min(40, Math.floor(x / 100)), 0) / p.xp.length) : null;
                return [a.id, [m.tokens != null ? `${count(num(m.tokens))} tokens` : 'Tokens not read yet', p ? `${lv != null ? `Level ${lv}` : 'No passes'} · ${count(p.credits)} credits` : 'Passes not read yet']]; }));
            return { accountLines, blocks: [
                { type: 'card', id: 'power', toggle: 'on', toggleDisabled: practice ? 'Set the mode to Live first' : null, bodyWhenOff: true, open: practice || !S('on'),
                    title: S('on') && !practice ? (farming ? 'Star farming — on, farming now' : 'Star farming — on') : 'Star farming — off',
                    summary: !n ? 'choose the star farming accounts first' : practice ? 'practice: nothing runs unless you press Practice run' : `live on ${n} account${n === 1 ? '' : 's'} with ${on} game${on === 1 ? '' : 's'}`,
                    keys: ['runMode'] },
                ...(plan ? [{ type: 'table', wrap: true, columns: ['The last practice run would', 'When'], rows: plan.lines.map(l => [l, new Date(plan.t).toLocaleTimeString()]) }] : []),
                ...stuckNotice(),
                ...(n ? [{ type: 'stats', items: [
                    { label: 'Battles today', value: `${count(t.battles)} · ${count(t.rounds)} rounds` },
                    { label: 'Jackpot rounds', value: count(t.jackpots || 0) },
                    { label: 'Upgrades', value: count(t.upgrades || 0) },
                    { label: 'Guesses', value: count(t.gtr || 0) },
                ] }] : []),
                // Who, which games, passes, then Run: one step at a time; each game's details sit under More options.
                { type: 'wizard', id: 'farm', steps: [
                    { id: 'accounts', title: 'Accounts', done: n > 0, warn: n ? null : 'choose the star farming accounts',
                        summary: n ? (n > 3 ? `${list.slice(0, 3).map(a => a.name).join(', ')} and ${n - 3} more` : list.map(a => a.name).join(', ')) : '', keys: ['accounts'] },
                    { id: 'games', title: 'What to farm', done: on > 0, warn: on ? null : 'no game switched on',
                        summary: GAME_CARDS.filter(g => S(g.key)).map(g => g.title).join(', '),
                        text: 'Each game earns pass XP. Blackjack, Crash, Dice and Plinko are played by the Games plugin when it is on, otherwise here.',
                        keys: GAME_CARDS.map(g => g.key) },
                    { id: 'passes', title: 'Passes', done: true,
                        summary: (S('passes') ? `all slots active${S('restart') ? ' · full ones redeemed' : ''}` : 'off') + (lvl != null ? ` · average level ${lvl}` : ''),
                        keys: ['passes', 'restart'], blocks: n ? [{ type: 'table', columns: ['Account', 'Passes', 'Levels', 'Credits'], rows }] : [] },
                ],
                extras: [
                    ...GAME_CARDS.filter(g => g.keys).map(g => ({ id: g.id, title: g.title, summary: S(g.key) ? g.sum() : 'off', keys: g.keys })),
                    { id: 'general', title: 'Turns and limits', summary: `${num(S('turnMin'))} min turns · keep ${count(num(S('keepTokens')))} tokens`, keys: ['turnMin', 'keepTokens'] },
                    { id: 'schedule', title: 'Schedule', summary: `checks every ${num(S('everyMin'))} min`, keys: ['everyMin'] },
                ],
                finish: { title: farming ? 'Farming now' : !n ? 'Choose accounts first' : practice ? 'Practice run' : S('on') ? `Live on ${n} account${n === 1 ? '' : 's'}` : 'Run once',
                    ready: n > 0 && on > 0, next: 'Run',
                    text: !n ? '' : practice ? 'Shows what one check would do, without playing.' : S('on') ? `Checks every ${num(S('everyMin'))} min with ${on} game${on === 1 ? '' : 's'}; Run now checks straight away.` : 'Star farming is off: Run now does one check now.',
                    buttons: n ? [{ label: practice ? 'Practice run' : 'Run now', action: 'run', primary: true }, ...(farming ? [{ label: 'Stop', action: 'stop', danger: true }] : [])] : [] } },
                { type: 'section', title: 'Recent battles', blocks: [{ type: 'table', empty: 'No battles yet.', columns: ['When', 'Host', 'Players', 'Rounds', 'Each paid'],
                    rows: (state.history || []).slice(0, 10).map(h => [new Date(h.t).toLocaleTimeString(), h.host, String(h.players || 2), String(h.rounds), money(h.price)]) }] },
            ] };
        });

        // Spending credits is never automatic: the shop tab lays out every armory item; pick one, tick the accounts
        // (only those whose credits cover a pack) and Buy an amount each, or Buy max (all each one's credits cover).
        // Items come 10 for an item's credit price. Ticking Queue in Opener hands what was bought to the Opener, which
        // opens it from stock on those accounts once each is free (ctx.shared "armory/openQueue"; the Opener lists the
        // ones it took on "opener/taken").
        const MAX_SELL_UNDER = 480000;
        const pruneQueue = () => {
            const taken = (ctx.shared && ctx.shared.get('opener/taken')) || [];
            const q = (state.openQueue || []).filter(e => !taken.includes(e.qid));
            if (q.length !== (state.openQueue || []).length) { state.openQueue = q; save(); }
            if (ctx.shared) ctx.shared.set('openQueue', q.length ? q : null);
        };
        pruneQueue();
        ctx.every(3000, pruneQueue);
        const profileOf = (q) => {
            if (!q || typeof q !== 'object') return null;
            if (q.mode !== 'custom') return { mode: 'default' };
            const drops = ['money', 'tokens', 'keep'].includes(q.drops) ? q.drops : 'money';
            const f = q.fav && typeof q.fav === 'object' ? q.fav : {};
            const fmode = ['opener', 'own', 'custom'].includes(f.mode) ? f.mode : 'opener';
            const low = num(f.low), high = num(f.high);
            const fav = fmode !== 'custom' ? { mode: fmode }
                : { mode: 'custom', low: low > 0 ? Math.min(0.1, low) : 0, high: high > 0 ? Math.min(0.99999999, Math.max(0.9, high)) : 0, patterns: !!f.patterns };
            return { mode: 'custom', drops, under: Math.min(MAX_SELL_UNDER, Math.max(0, num(q.under))), fav };
        };
        ctx.panel.action('buy', async (arg) => {
            let want;
            try { want = typeof arg === 'string' ? JSON.parse(arg) : arg; } catch (_) { want = null; }
            const item = want && rewards && rewards.find(x => x.id === want.id);
            if (!item) return { ok: false, error: 'That item is not in the shop any more.' };
            const price = num(item.creditPrice), max = !!want.max;
            // Each ticked account's own amount (whole packs of 10), or the older shape: one amount for every account.
            const asked = new Map(Array.isArray(want.buys)
                ? want.buys.map(b => [String(b && b.account), Math.max(1, Math.floor(num(b && b.n) / 10))])
                : (Array.isArray(want.accounts) ? want.accounts : []).map(id => [String(id), Math.max(1, Math.floor(num(want.n) / 10))]));
            const list = ctx.accounts.list().filter(x => asked.has(x.id) && ctx.settings.runsOn('accounts', x.id));
            if (!list.length) return { ok: false, error: 'Pick the accounts to buy on.' };
            let bought = 0;
            const short = [], got = [];
            for (const a of list) {
                if (!a.healthy) { short.push(a.name + ' (not clicking)'); continue; }
                try {
                    const arm = await json(a.id, '/api/armory');
                    const can = Math.floor(num(arm.credits) / price), packs = max ? can : asked.get(a.id);
                    const k = Math.min(packs, can);
                    if (k < packs || k <= 0) short.push(a.name);
                    if (k <= 0) continue;
                    await json(a.id, '/api/armory', { method: 'PATCH', body: { id: item.id, type: item.type, amount: k } });
                    bought += k * 10; got.push(a.id);
                    state.passes[a.id] = { ...(state.passes[a.id] || { name: a.name, xp: [] }), credits: num(arm.credits) - k * price };
                    ctx.log(`spent ${k * price} credits on ${k * 10} ${item.name}`, 'ok', a.id);
                } catch (e) { short.push(a.name); ctx.log('buying: ' + e.message, 'warn', a.id); }
            }
            const profile = profileOf(want.queue);
            if (profile && got.length) {
                const qid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
                state.openQueue = [...(state.openQueue || []), { qid, item: { id: item.id, type: item.type, name: item.name }, accounts: got, profile, t: Date.now() }];
                if (ctx.shared) ctx.shared.set('openQueue', state.openQueue);
            }
            save();
            const note = short.length ? ` · short of credits: ${short.join(', ')}` : '';
            const queued = profile && got.length ? ' Queued in the Opener.' : '';
            return bought ? { message: `Bought ${count(bought)} ${item.name} on ${got.length} account${got.length === 1 ? '' : 's'}${note}.${queued}` } : { ok: false, error: 'Not enough credits on those accounts.' };
        });
        // The armory's kinds, in the shop's order; the pictures are the site's own (case-clicker.com/pictures/cases/).
        const KINDS = [['capsule', 'Capsules'], ['case', 'Cases'], ['collectionCase', 'Collections'], ['keychainCollection', 'Charms']];
        const pictureOf = (x) => { const f = String(x.iconUrl || ''); return !f ? '' : /^https:\/\//.test(f) ? f : 'https://case-clicker.com/pictures/cases/' + encodeURIComponent(f.replace(/^\/+/, '')); };
        ctx.panel.tab('Armory shop', () => {
            const list = chosen();
            const credits = list.map(a => (state.passes[a.id] || {}).credits || 0);
            const total = credits.reduce((x, y) => x + y, 0);
            const known = KINDS.map(k => k[0]);
            const groups = rewards ? [...KINDS, ...[...new Set(rewards.map(x => x.type).filter(t => !known.includes(t)))].map(t => [t, 'Other'])]
                .map(([type, title]) => ({ title, items: rewards.filter(x => x.type === type).sort((a, b) => num(a.creditPrice) - num(b.creditPrice) || String(a.name).localeCompare(String(b.name)))
                    .map(x => ({ id: x.id, name: x.name, image: pictureOf(x), price: num(x.creditPrice) })) })) : [];
            const openerOn = !!(ctx.shared && ctx.shared.get('opener/taken'));
            const waiting = (state.openQueue || []).length;
            return { blocks: [
                { type: 'stats', items: [{ label: 'Credits on the star accounts', value: count(total) }, { label: 'Most on one account', value: count(Math.max(0, ...credits)) }, { label: 'Accounts', value: count(list.length) }] },
                ...(waiting ? [{ type: 'notice', level: openerOn ? '' : 'warn', text: openerOn ? `${waiting} purchase${waiting === 1 ? '' : 's'} going to the Opener…` : `${waiting} purchase${waiting === 1 ? ' waits' : 's wait'} for the Opener — turn the Opener plugin on and ${waiting === 1 ? 'it goes' : 'they go'} to its queue.` }] : []),
                ...(rewards ? [{ type: 'shopgrid', action: 'buy', unit: 'credit', pack: 10, groups, empty: 'Nothing in the armory shop right now.',
                    accounts: list.map((a, i) => ({ id: a.id, name: a.name, credits: credits[i] })),
                    queue: { defaultText: (ctx.shared && ctx.shared.get('opener/drops')) || 'as the Opener is set', favText: (ctx.shared && ctx.shared.get('opener/favs')) || '', maxUnder: MAX_SELL_UNDER, off: openerOn ? null : 'Turn the Opener plugin on to queue opening.' } }]
                    : [{ type: 'notice', text: 'The shop loads once a star account is clicking.' }]),
                { type: 'text', text: 'Credits are read from each star farming account about once a minute; an account shows once its credits cover a pack.' },
                { type: 'card', id: 'shop-accounts', open: false, title: 'Credits per account', summary: `${list.length} account${list.length === 1 ? '' : 's'}`,
                    blocks: [{ type: 'table', empty: 'No accounts chosen yet.', columns: ['Account', 'Credits'], rows: list.map((a, i) => [a.name, count(credits[i])]) }] },
            ] };
        }, { group: 'management' });   // buying with credits is upkeep, not farming
    },
    stop() { halt = true; passBusy.clear(); },
};
