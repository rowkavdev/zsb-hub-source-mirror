/**
 * GAMES
 *
 * The site's /rewards has a reward chain per game: play N plinko drops, N dice rolls, ... and claim the next tier.
 * This plays the smallest bets that reach a game's next tier, then claims it, but only when the bets are
 * expected to lose less than the tier pays (and less than the "expected loss allowed" setting).
 *   rewards  GET /api/rewards -> { next<Chain>Reward: { reward: { id, required<Thing>, rewardString }, isRedeemable,
 *            <thing count> } }; rewardString "10;N" = N tokens, "1;N" = $N, other codes are items
 *   claim    POST /api/rewards { id }
 *   plinko   POST /api/casino/plinko { bet, risk } -> { bet, multiplier }          (tokens; bet >= 1)
 *   dice     POST /api/casino/dice { bet, targetNumber, playerChoice: 'under' }  -> { outcome, tokensWonOrLost }
 *            (bet >= 100; pays 100/chance x 0.93, so every bet loses 7% on average whatever the chance)
 *   crash    socket: joinRoomCrash; on crashNewRound (betting open) placeBetCrash { bet, autoCashout };
 *            crashRoundEnd { crashPoint, bets: [{ userId, bet, cashedOutAt?, profit? }] } says how it went
 *            (one round every ~20 s, so a play takes that long). Bets 1 token, cashing out at 1.01x.
 *   blackjack socket: joinRoomBlackjack; createTableBlackjack { isPrivate: true } -> blackjackTableJoined { tableId };
 *            blackjackTableState { phase: betting|dealing|acting|..., dealer: { value, holeCardHidden },
 *            seats: [{ userId, status, bet, hands: [{ value, isSoft }], activeHandIndex, turnId, netProfit }] }.
 *            placeBetBlackjack { bet } while betting; actionBlackjack { action: hit|stand, turnId } on this seat's
 *            turn; netProfit is set once the round is paid. One private table per run, 1-token hands.
 * Armory XP per play (to every active pass): plinko 0.5, dice 5, crash 5, blackjack 10. "Armory XP" mode keeps
 * playing at the smallest bets up to each game's daily limit (GET /api/gameLimitations <game>HostLeft).
 * What each game really costs is measured from its own answers; until there are enough plays, a cautious guess.
 * Practice mode (the default) only logs what a run would play.
 */

const GAP_MS = 300;
const OPEN_RETRY_MS = 3000;   // wait before the second try at a socket game's connection
const MIN_SAMPLE = 50;          // plays before the measured loss replaces the guess
const LOCK_TRIES = 6;
const MAX_STEPS = 12;           // plays-then-claim steps per game per run
const RUN_MS = 15 * 60000;      // a run hands the account back after this (other plugins wait while it plays)
const ROUND_MS = 60000;         // longest wait for a blackjack table to move
// Longest wait for a crash round to open or end (a round takes ~20 s). The site's Crash pauses now and then for every
// player at once (bursts of 40+ of ours across every proxy in the same minute, 2026-11-12): a fresh socket joins the
// same paused game, so the socket waits the pause out instead of reconnecting after 35 s.
const CRASH_MS = 120000;
// Accounts playing Crash at once: the pauses came right after 55-76 of ours started it together. The rest play
// their other games first and come back for a place.
const CRASH_AT_ONCE = 30;
const FULL_WAIT_MS = 5000;      // an account with only Crash left waits this long between looks for a place
// The site's ways of saying the account is busy with another of its actions (an open, a claim): wait, try again.
const BUSY = /locked|another action|wait a moment/i;

// Basic strategy without doubles or splits (1-token hands; S17). up: the dealer's up card value (ace = 11).
function bjAction(hand, up) {
    const v = num(hand.value);
    if (hand.isSoft) return v >= 19 || (v === 18 && up >= 2 && up <= 8) ? 'stand' : 'hit';
    if (v >= 17) return 'stand';
    if (v >= 13) return up >= 2 && up <= 6 ? 'stand' : 'hit';
    if (v === 12) return up >= 4 && up <= 6 ? 'stand' : 'hit';
    return 'hit';
}
const GAMES = {
    plinko: { label: 'Plinko', chain: 'nextPlinkoReward', stake: 1, guess: 0.05, xp: 0.5, limit: 'plinkoHostLeft',
        play: async (aid) => { const r = await call(aid, '/api/casino/plinko', { bet: 1, risk: 'Low' }); return r && { bet: num(r.bet) || 1, back: (num(r.bet) || 1) * num(r.multiplier) }; } },
    dice: { label: 'Dice', chain: 'nextDicesReward', stake: 100, guess: 0.07, xp: 5, limit: 'diceHostLeft',
        play: async (aid) => { const r = await call(aid, '/api/casino/dice', { bet: 100, targetNumber: 95, playerChoice: 'under' }); return r && { bet: 100, back: 100 + num(r.tokensWonOrLost) }; } },
    crash: { label: 'Crash', chain: 'nextCrashReward', stake: 1, guess: 0.06, maxPlays: 60, xp: 5, limit: 'crashHostLeft',
        // The socket stays open for the game's whole turn in a run.
        open: async (aid) => {
            const who = await ctx.request(aid, '/api/auth/get-session');
            const userId = who.json && ((who.json.user && who.json.user.id) || (who.json.session && who.json.session.userId));
            if (!userId) throw new Stop('crash: could not tell which player this account is');
            const sock = await ctx.socket(aid);
            sock.emit('joinRoomCrash');
            return { sock, userId };
        },
        close: (s) => { try { s.sock.emit('exitRoomCrash'); s.sock.close(); } catch (_) {} },
        // "User is locked" (the account busy with an open or a claim): bet again in a later round.
        play: async (aid, s) => {
            for (let tries = 0; tries < LOCK_TRIES; tries++) {
                if (!(await s.sock.wait(['crashNewRound'], crashWait()))) throw new Stop('crash: no new round started');
                await ctx.sleep(500);
                s.sock.emit('placeBetCrash', { bet: 1, autoCashout: 1.01 });
                let locked = false;
                // Events queue up while waiting, so the end of a round from before the bet can come first: skip
                // round ends without this account's bet (a couple at most).
                for (let ends = 0; ends < 3 && !locked; ends++) {
                    const e = await s.sock.wait(['crashRoundEnd', 'crashError'], crashWait());
                    if (!e) throw new Stop('crash: the round never ended');
                    if (e.ev === 'crashError') {
                        const msg = typeof e.data === 'string' ? e.data : (e.data && (e.data.message || e.data.error)) || JSON.stringify(e.data);
                        // Busy, or a queued "new round" from before made the bet late: bet in the next round.
                        if (BUSY.test(msg) || /betting phase is over/i.test(msg)) { locked = true; break; }
                        if (/already placed/i.test(msg)) continue;   // a bet from before is in this round: its end has the result
                        throw new Stop('crash: ' + msg);
                    }
                    const mine = (e.data && Array.isArray(e.data.bets) ? e.data.bets : []).find(b => b.userId === s.userId);
                    if (mine) return { bet: num(mine.bet), back: mine.cashedOutAt ? num(mine.bet) + num(mine.profit) : 0 };
                }
                // No error but no bet either: the site drops a bet sent while the account is busy (e.g. right
                // after a claim) without a word. Same as busy: bet again next round.
            }
            throw new Stop('crash: the bet wasn\'t taken, round after round');
        } },
    blackjack: { label: 'Blackjack', chain: 'nextBlackjackReward', stake: 1, guess: 0.03, maxPlays: 60, xp: 10, limit: 'blackjackHostLeft',
        // One private table for the game's whole turn in a run; it closes when the account leaves.
        open: async (aid) => {
            const who = await ctx.request(aid, '/api/auth/get-session');
            const userId = who.json && ((who.json.user && who.json.user.id) || (who.json.session && who.json.session.userId));
            if (!userId) throw new Stop('blackjack: could not tell which player this account is');
            const sock = await ctx.socket(aid);
            // Still seated at a table from before (the hub closed mid-hand): joining the room says which one
            // (blackjackMySeat) and watching it brings its state, as the site's own page does. Creating a new one
            // would be refused ("You already sit at a table").
            sock.emit('joinRoomBlackjack');
            const mine = await sock.wait(['blackjackMySeat'], 2000);
            if (mine && mine.data && mine.data.tableId) {
                sock.emit('watchTableBlackjack', { tableId: mine.data.tableId, code: mine.data.code });
                return { sock, userId };
            }
            sock.emit('createTableBlackjack', { isPrivate: true });
            const j = await sock.wait(['blackjackTableJoined', 'blackjackError'], 15000);
            if (!j || j.ev === 'blackjackError') { sock.close(); throw new Stop('blackjack: no table (' + (j ? JSON.stringify(j.data) : 'no answer') + ')'); }
            return { sock, userId };
        },
        close: (s) => { try { s.sock.emit('exitRoomBlackjack'); s.sock.close(); } catch (_) {} },
        play: async (aid, s) => {
            let betRound = null, acted = -1;
            const until = Date.now() + 3 * ROUND_MS;
            while (Date.now() < until) {
                const e = await s.sock.wait(['blackjackTableState', 'blackjackError', 'blackjackKicked', 'blackjackTableClosed'], ROUND_MS);
                if (!e) throw new Stop('blackjack: the table went quiet');
                if (e.ev !== 'blackjackTableState') {
                    const msg = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
                    if (e.ev === 'blackjackError' && (BUSY.test(msg) || /already|betting is closed/i.test(msg))) { betRound = null; await ctx.sleep(1500); continue; }   // busy: bet again
                    throw new Stop(`blackjack: ${e.ev.replace('blackjack', '').toLowerCase()} ${msg}`);
                }
                const t = e.data, seat = (t.seats || []).find(x => x && x.userId === s.userId);
                if (!seat) throw new Stop('blackjack: not seated at the table');
                if (t.phase === 'betting' && seat.bet == null && betRound == null) { s.sock.emit('placeBetBlackjack', { bet: 1 }); betRound = t.roundId || 'pending'; continue; }
                if (betRound == null) continue;
                if (t.phase === 'acting' && seat.activeHandIndex != null && seat.turnId !== acted) {
                    const hand = (seat.hands || [])[seat.activeHandIndex];
                    if (hand) { acted = seat.turnId; s.sock.emit('actionBlackjack', { action: bjAction(hand, num(t.dealer && t.dealer.value)), turnId: seat.turnId }); }
                    continue;
                }
                if (seat.netProfit != null && seat.bet != null) return { bet: num(seat.bet), back: num(seat.bet) + num(seat.netProfit) };
            }
            throw new Stop('blackjack: the round never finished');
        } },
};

let ctx = null;
let state = null;    // saved: { last: { aid: t }, games: { id: { plays, bet, back, rewards, tiers } }, cash, items, runs, plans, practiceAt }
const busy = new Set();
let halt = false;    // Stop pressed: the running accounts end after their current play

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const count = (n) => Math.round(n).toLocaleString('en-US');
// Tokens: one decimal, two below 10 (a plinko drop loses ~0.05).
const tok = (n) => (n < 0 ? '−' : '') + Math.abs(Math.abs(n) < 10 ? Math.round(n * 100) / 100 : Math.round(n * 10) / 10).toLocaleString('en-US');
const S = (k) => ctx.settings.get(k);

class Stop extends Error {}
// Crash has all its places taken (CRASH_AT_ONCE): this account plays it later in the run.
class Full extends Stop { constructor() { super('crash: every place is taken'); } }
const crashSeats = new Set();   // accounts holding a Crash place (its socket open)
const crashCap = () => Math.max(1, num(S('crashAtOnce')) || CRASH_AT_ONCE);
const crashWait = () => num(S('crashWaitMs')) || CRASH_MS;
const crashFull = (aid) => !crashSeats.has(aid) && crashSeats.size >= crashCap();

// "User is locked": the site holds an account while another of its actions runs (an open, a claim). Wait it out.
async function call(aid, path, body) {
    for (let i = 0; ; i++) {
        const r = await ctx.request(aid, path, { method: 'POST', body });
        if (r.kind === 'not-running' || r.kind === 'auth' || r.kind === 'cf') throw new Stop(r.kind === 'not-running' ? 'the account stopped clicking' : r.kind);
        const err = r.json && r.json.error;
        if (r.kind === 'ok' && r.json && !err) return r.json;
        if (BUSY.test(String(err || '')) && i < LOCK_TRIES) { await ctx.sleep(1500 * (i + 1)); continue; }
        throw new Stop(`${path.split('/').pop()}: ${err || 'HTTP ' + r.status}`);
    }
}

async function rewards(aid) {
    const r = await ctx.request(aid, '/api/rewards');
    if (r.kind !== 'ok' || !r.json) throw new Stop(`couldn't read the rewards (HTTP ${r.status})`);
    return r.json;
}

// What a tier is worth: tokens, or cash at ~1 token per $. Items count as nothing (not played for).
function worth(rewardString) {
    const [code, n] = String(rewardString || '').split(';');
    return { tokens: code === '10' ? num(n) : 0, cash: code === '1' ? num(n) : 0, other: code !== '10' && code !== '1' ? rewardString : null };
}

// How far a chain is: the required count and the current count, whatever the game calls them.
function progress(entry) {
    const rw = entry.reward || {};
    const key = Object.keys(rw).find(k => /^required/.test(k) && !/PrevRewardId|RankId/.test(k));
    const need = key ? num(rw[key]) : 0;
    const have = num(Object.entries(entry).find(([k, v]) => k !== 'reward' && k !== 'isRedeemable' && typeof v === 'number')?.[1]);
    return { need, have };
}

const stats = (g) => (state.games[g] = state.games[g] || { plays: 0, bet: 0, back: 0, rewards: 0, cash: 0, tiers: 0 });
// Expected loss per play: measured once there's enough of a sample (never below 1% of the stake).
function lossPerPlay(g) {
    const s = stats(g), G = GAMES[g];
    if (s.plays < MIN_SAMPLE || !s.bet) return G.stake * G.guess;
    return Math.max(G.stake * 0.01, (s.bet - s.back) / s.plays);
}

// Right after the last bet the site may still be busy with it: a refused claim is tried again shortly.
async function claim(aid, id) {
    for (let i = 0; i < 4; i++) {
        if (i) await ctx.sleep(1500 * i);
        const r = await ctx.request(aid, '/api/rewards', { method: 'POST', body: { id } });
        if (r.kind === 'ok') return true;
        if (r.kind !== 'api') return false;
    }
    return false;
}

async function run(aid, name) {
    busy.add(aid);
    const practice = ctx.power.practice();
    const lines = [];
    const log = (msg, level = 'info') => ctx.log((practice ? 'practice — ' : '') + msg, level, aid);
    const rec = { t: Date.now(), acct: name, plays: 0, net: 0, rewards: 0, cash: 0, tiers: 0, result: '' };
    // Switched off during a live run: stop after the current play (a Play now run while off isn't cut short).
    const wasOn = ctx.power.live();
    const offNow = () => ctx.stopping || halt || (wasOn && !ctx.power.live());
    const offWhy = () => (halt && !ctx.stopping ? 'stopped by you' : 'turned off');
    if (!practice && ctx.accounts.setBusy) ctx.accounts.setBusy(aid, 'playing games');   // the Opener waits its turn
    try {
        let tokens = num((await ctx.request(aid, '/api/me')).json?.tokens);
        const keep = num(S('keepTokens'));
        // Games take turns, one tier each per pass, so a slow game (crash: ~20 s a round) doesn't hold up the
        // others. A game drops out of the run when it has nothing worth playing or hits a problem of its own.
        // Reward tiers only on this plugin's own accounts; a star farming account from the Armory's list just farms XP.
        const active = ctx.settings.runsOn('accounts', aid) ? Object.keys(GAMES).filter(g => S(g)) : [];
        const sessions = new Map();   // a socket game's connection, opened on its first play
        const reopened = new Set();   // socket games already reconnected once this run
        const playedRun = new Map();  // plays per game this run ("most plays per game per run")
        const runEnds = Date.now() + RUN_MS;
        // A socket game's connection closed (its Crash place goes to the next account).
        const closeGame = (g) => { if (sessions.has(g)) { GAMES[g].close(sessions.get(g)); sessions.delete(g); } if (g === 'crash') crashSeats.delete(aid); };
        let fullSaid = false;
        const sayFull = () => { if (!fullSaid) log(`Crash: all ${crashCap()} places are taken — plays it when one frees up`); fullSaid = true; };
        let limits = null;            // today's plays left per game (/api/gameLimitations), read once per run
        const leftToday = async (g) => {
            if (!GAMES[g].limit) return Infinity;
            if (!limits) { try { limits = (await ctx.request(aid, '/api/gameLimitations')).json || {}; } catch (_) { limits = {}; } }
            return GAMES[g].limit in limits ? num(limits[GAMES[g].limit]) - (playedRun.get(g) || 0) : Infinity;
        };
        // A tier earned: into the totals, and no longer pending. claimed: this run claimed it (tokens arrive now).
        const book = (g, w, claimed) => {
            const s = stats(g);
            s.rewards += w.tokens; s.cash += w.cash; s.tiers++;
            rec.rewards += w.tokens; rec.cash += w.cash; rec.tiers++;
            if (claimed) tokens += w.tokens;
            if (state.pending[aid]) delete state.pending[aid][g];
            ctx.data.set(state);   // kept right away: a run can be cut short (turned off, app closed)
        };
        // One step of a game: claim its ready tier, or play to its next one. false = done for this run.
        const step = async (g) => {
            const G = GAMES[g];
            const entry = (await rewards(aid))[G.chain];
            // The tier these plays were for, if it was claimed in the meantime by something else (the Rewards
            // plugin claims every ready tier): it's still what the bets earned, so it counts here.
            const pend = (state.pending[aid] || {})[g];
            if (pend && (!entry || !entry.reward || entry.reward.id !== pend.id)) {
                book(g, pend.w, false);
                log(`${G.label}: the tier played for was claimed elsewhere — counted, ${pend.w.tokens ? '+' + pend.w.tokens + ' tokens' : '+$' + pend.w.cash}`, 'ok');
            }
            if (!entry || !entry.reward) return false;
            const w = worth(entry.reward.rewardString);
            if (entry.isRedeemable) {
                if (practice) { lines.push(`${G.label}: claim the ready tier (${w.tokens ? w.tokens + ' tokens' : w.cash ? '$' + w.cash : w.other})`); return false; }
                if (!(await claim(aid, entry.reward.id))) { log(`${G.label}: the ready tier couldn't be claimed — next run`, 'warn'); return false; }
                book(g, w, true);
                log(`${G.label}: claimed a reward tier — ${w.tokens ? '+' + w.tokens + ' tokens' : w.cash ? '+$' + w.cash : w.other}`, 'ok');
                return true;
            }
            const { need, have } = progress(entry);
            const left = Math.max(0, need - have);
            const cost = left * lossPerPlay(g), value = w.tokens + w.cash;
            // A tier bigger than a run's plays is played over several runs (the site counts every play).
            const most = Math.min(num(S('maxPlays')), G.maxPlays || Infinity) - (playedRun.get(g) || 0);
            const today = await leftToday(g);
            const now = Math.min(left, most, today);
            const why = today <= 0 ? 'the daily limit is reached — again after 00:00 UTC'
                : now <= 0 ? `this run's ${num(S('maxPlays'))} plays are used up — the rest next run`
                : !value ? `the tier pays an item (${w.other}), not tokens`
                : cost >= value ? `expected loss ${tok(cost)} ≥ the reward (${tok(value)})`
                : cost > num(S('maxLoss')) ? `expected loss ${tok(cost)} is over your limit of ${num(S('maxLoss'))}`
                : tokens - keep < G.stake * Math.min(left, 3) ? `not enough tokens (${tok(tokens)}, keeping ${keep})` : null;
            if (why) { lines.push(`${G.label}: skip — ${why}`); return false; }
            if (!practice && Date.now() > runEnds) return false;   // time's up: don't announce plays that won't happen
            const line = `${G.label}: play ${now < left ? `${now} of the ${left}` : left}× for a tier worth ${w.tokens ? w.tokens + ' tokens' : '$' + w.cash} (expected loss ${tok(cost)})`;
            if (practice) { lines.push(line); log('would ' + line.replace(/^[^:]+: /, '').replace(/^play/, 'play ' + G.label.toLowerCase())); return false; }
            if (g === 'crash' && crashFull(aid)) throw new Full();
            log(line);
            state.pending[aid] = { ...state.pending[aid], [g]: { id: entry.reward.id, w } };
            await playN(g, now);
            return true;
        };
        // A socket game's connection. A slow proxy can time out: one more try, then only that game sits out the run
        // (a Stop: the other games go on) instead of the whole run ending.
        const openGame = async (g) => {
            const G = GAMES[g];
            for (let k = 0; ; k++) {
                try { return await G.open(aid); } catch (e) {
                    if (e instanceof Stop) throw e;
                    if (k >= 1 || offNow()) throw new Stop(`${G.label}: couldn't connect (${e.message})`);
                    await ctx.sleep(OPEN_RETRY_MS);
                }
            }
        };
        // n plays of a game at its smallest bet (fewer if the run's time or the tokens run out).
        const playN = async (g, n) => {
            const G = GAMES[g], s = stats(g);
            let played = 0;
            for (let i = 0; i < n; i++) {
                if (offNow()) throw new Stop(offWhy());
                if (tokens - keep < G.stake) throw new Stop(`${G.label}: down to ${tok(tokens)} tokens`);
                if (Date.now() > runEnds) break;   // time's up: the rest next run
                const other = ctx.accounts.busy && ctx.accounts.busy(aid, ALONGSIDE);
                if (other) throw new Stop(`waiting — ${other.what} (${other.plugin})`);
                await seatWait(aid, () => offNow() || Date.now() > runEnds);
                if (offNow()) throw new Stop(offWhy());
                playedRun.set(g, (playedRun.get(g) || 0) + 1);
                if (G.open && !sessions.has(g)) {
                    if (g === 'crash') { if (crashFull(aid)) throw new Full(); crashSeats.add(aid); }
                    try { sessions.set(g, await openGame(g)); } catch (e) { if (g === 'crash') crashSeats.delete(aid); throw e; }
                }
                let p;
                try { p = await G.play(aid, sessions.get(g)); } catch (e) {
                    // A socket game whose connection went quiet, or whose table kicked it (several busy rounds in a
                    // row): a fresh connection or table, once per run.
                    if (!(e instanceof Stop) || !G.open || reopened.has(g) || !/no new round|never ended|went quiet|kicked|closed/.test(e.message)) throw e;
                    reopened.add(g);
                    log(`${G.label}: ${e.message.replace(/^\w+: /, '')} — reconnecting`, 'warn');
                    G.close(sessions.get(g)); sessions.delete(g);
                    sessions.set(g, await openGame(g));
                    p = await G.play(aid, sessions.get(g));
                }
                s.plays++; s.bet += p.bet; s.back += p.back;
                rec.plays++; rec.net += p.back - p.bet; rec.xp = (rec.xp || 0) + (G.xp || 0);
                tokens += p.back - p.bet;
                played++;
                await ctx.sleep(GAP_MS);
            }
            ctx.data.set(state);
            return played;
        };
        try {
            for (let pass = 0; pass < MAX_STEPS && active.length && Date.now() < runEnds; pass++) {
                let moved = false, full = false;
                for (const g of [...active]) {
                    if (offNow()) throw new Stop(offWhy());
                    const other = ctx.accounts.busy && ctx.accounts.busy(aid, ALONGSIDE);
                    if (other) throw new Stop(`waiting — ${other.what} (${other.plugin})`);
                    let more = false;
                    try { more = await step(g); moved = moved || more; } catch (e) {
                        if (e instanceof Full) { sayFull(); full = more = true; continue; }   // later in the run
                        if (!(e instanceof Stop) || offNow() || /logged out|Cloudflare|stopped clicking|^waiting/.test(e.message)) throw e;
                        log(`${GAMES[g].label} stopped for this run: ${e.message}`, 'warn');   // the other games go on
                        closeGame(g);
                    }
                    if (!more) { active.splice(active.indexOf(g), 1); if (g === 'crash') closeGame(g); }
                }
                // Only Crash left and no place yet: wait for one (doesn't use up a step).
                if (full && !moved) { await ctx.sleep(FULL_WAIT_MS); pass--; }
            }
            // Armory XP: every play counts for all active passes, so after the tiers each game keeps going at its
            // smallest bet up to its daily limit (cheapest XP first).
            if (farms(aid) && Date.now() < runEnds) {
                const lim = await ctx.request(aid, '/api/gameLimitations');
                const left = (lim.kind === 'ok' && lim.json) || {};
                const order = Object.keys(GAMES).filter(g => farmsGame(g) && GAMES[g].limit).sort((a, b) => (GAMES[a].stake * GAMES[a].guess / GAMES[a].xp) - (GAMES[b].stake * GAMES[b].guess / GAMES[b].xp));
                const queue = [...order];
                while (queue.length) {
                    const g = queue.shift();
                    if (Date.now() > runEnds) break;
                    const G = GAMES[g];
                    const n = Math.min(num(left[G.limit]), Math.max(0, Math.min(num(S('maxPlays')), G.maxPlays || Infinity) - (playedRun.get(g) || 0)));
                    if (n <= 0) continue;
                    if (practice) { lines.push(`${G.label}: ${n} plays for Armory XP (~${count(n * G.xp)} XP, ${num(left[G.limit])} left today)`); continue; }
                    try {
                        const done = await playN(g, n);
                        if (done) log(`${G.label}: ${done} plays for Armory XP (+${count(done * G.xp)} XP on every pass)`, 'ok');
                        if (g === 'crash') closeGame(g);   // done with it: the place goes to the next account
                    } catch (e) {
                        // Crash full: the other games first, then wait for a place.
                        if (e instanceof Full) { sayFull(); queue.push(g); if (queue.every(x => x === g)) await ctx.sleep(FULL_WAIT_MS); continue; }
                        if (!(e instanceof Stop) || offNow() || /logged out|Cloudflare|stopped clicking|^waiting/.test(e.message)) throw e;
                        log(`${G.label} stopped for this run: ${e.message}`, 'warn');
                        closeGame(g);
                    }
                }
            }
        } finally { for (const g of [...sessions.keys()]) closeGame(g); crashSeats.delete(aid); }
        rec.result = practice ? 'practice' : rec.plays || rec.tiers ? 'done' : 'nothing worth playing';
        if (practice) { state.practiceAt = Date.now(); state.plans = { ...(state.plans || {}), [aid]: { t: Date.now(), name, lines: lines.length ? lines : ['nothing to play right now'] } }; }
        else if (rec.plays || rec.tiers) log(`games: ${rec.plays} plays, net ${tok(rec.net)} tokens, rewards +${tok(rec.rewards)} tokens${rec.cash ? ` +$${rec.cash}` : ''}`, 'ok');
    } catch (e) {
        rec.result = e instanceof Stop ? e.message : 'error: ' + e.message;
        if (!(e instanceof Stop) && !ctx.stopping) ctx.log('stopped: ' + e.message, 'error', aid);   // turned off mid-run isn't an error
        else if (!ctx.stopping) log('stopped: ' + e.message, 'warn');
    } finally {
        state.last[aid] = Date.now();
        state.runs = [rec, ...(state.runs || [])].slice(0, 30);
        busy.delete(aid);
        if (!busy.size) halt = false;
        if (ctx.accounts.setBusy) ctx.accounts.setBusy(aid, null);
        ctx.data.set(state);
    }
}

// The Armory's star farming list (its accounts and which games farm XP), when the Armory is on: it decides the XP
// plays instead of this plugin's own "Also play for Armory XP" switch. { accounts: [ids], games: { plinko: true, ... } }
// The Armory's star farming turn holds its accounts all turn; Games plays them alongside (its holds don't count) and
// only waits between plays while one of its battles seats the account (the site says "User is locked" otherwise).
const ALONGSIDE = { ignore: ['armory'] };
const seatedNow = (aid) => ((ctx.shared && ctx.shared.get('armory/seating')) || []).includes(aid);
async function seatWait(aid, quit) { while (seatedNow(aid) && !quit()) await ctx.sleep(500); }

function farm() { return (ctx.shared && ctx.shared.get('armory/farm')) || null; }
const farms = (aid) => { const f = farm(); return f ? f.accounts.includes(aid) : !!S('xpMode'); };
const farmsGame = (g) => { const f = farm(); return f ? !!f.games[g] : !!S(g); };
const runsOn = (aid) => ctx.settings.runsOn('accounts', aid) || (farm() || { accounts: [] }).accounts.includes(aid);

// On the schedule only when on and live; the Run button (asked) plays now, or shows a practice run.
// Tells the Armory whether Games plays blackjack, crash, dice and plinko for star farming (it plays them itself
// otherwise). Every second, so switching Games on or off hands them over at once.
const signal = () => { if (ctx.shared) ctx.shared.set('live', ctx.power.live() ? true : null); };

function tick(asked) {
    if (!asked && !ctx.power.live() || halt) return;
    const every = num(S('everyMs')) || Math.max(5, num(S('everyMin'))) * 60000;
    for (const a of ctx.accounts.list()) {
        if (!a.healthy || busy.has(a.id) || !runsOn(a.id)) continue;
        if (ctx.accounts.busy && ctx.accounts.busy(a.id, ALONGSIDE)) continue;   // another plugin has it tied up (opening cases): next tick
        if (Date.now() - (state.last[a.id] || 0) < every) continue;
        run(a.id, a.name);
    }
}

// The Schedule tab (hub 1.2.18+): the next accounts due, with Run now / Skip next.
function plan() {
    if (!ctx.schedule) return;
    const ids = ctx.power.live() && !halt ? ctx.accounts.list().filter(a => runsOn(a.id) && !busy.has(a.id)).map(a => a.id) : [];
    if (!ids.length) { ctx.schedule.set('run', null); return; }
    const every = num(S('everyMs')) || Math.max(5, num(S('everyMin'))) * 60000;
    const dueOf = (id) => (state.last[id] || 0) + every;
    const at = Math.min(...ids.map(dueOf)), soon = ids.filter(id => dueOf(id) - at < 60000);
    const later = ids.length - soon.length, f = farm();
    ctx.schedule.set('run', { what: 'Play for rewards', at: Math.max(at, Date.now()), accounts: soon,
        why: `each account every ${Math.round(every / 60000)} min${f ? ' · star farming XP for the Armory' : ''}; waits while another plugin has the account${later ? ` · ${later} more later` : ''}`,
        runNow: () => { for (const id of soon) state.last[id] = 0; tick(true); plan(); return { message: 'Playing now.' }; },
        skip: () => { const now = Date.now(); for (const id of soon) state.last[id] = Math.max(dueOf(id), now); ctx.data.set(state); plan(); return { message: 'Skipped: those accounts play one round later.' }; } });
}

module.exports = {
    start(c) {
        ctx = c;
        state = { last: {}, games: {}, runs: [], pending: {}, ...ctx.data.get() };
        state.pending = state.pending || {};
        signal();
        ctx.every(1000, signal);
        ctx.every(15000, () => { tick(); plan(); });
        plan();
        ctx.panel.action('run', () => {
            const chosen = ctx.accounts.list().filter(a => runsOn(a.id));
            if (!chosen.length) return { ok: false, error: 'Choose accounts first.' };
            for (const a of chosen) state.last[a.id] = 0;
            tick(true);
            return { message: ctx.power.practice() ? 'Practice run started — the plan shows up here in a moment.' : 'Playing now.' };
        });
        // Stop: every running account ends after its current play (a Crash round finishes first). The schedule goes on.
        ctx.panel.action('stop', () => {
            if (!busy.size) return { message: 'Nothing is playing.' };
            halt = true;
            return { message: `Stopping ${busy.size} account${busy.size === 1 ? '' : 's'} after the current play.` };
        });

        ctx.panel.tab('Games', () => {
            const practice = ctx.power.practice(), live = ctx.power.live();
            const chosen = ctx.accounts.list().filter(a => ctx.settings.runsOn('accounts', a.id));
            const n = chosen.length;
            const all = Object.keys(GAMES).map(g => stats(g));
            const bet = all.reduce((t, s) => t + s.bet, 0), back = all.reduce((t, s) => t + s.back, 0);
            const rw = all.reduce((t, s) => t + s.rewards, 0), cash = all.reduce((t, s) => t + s.cash, 0);
            const plans = practice ? Object.values(state.plans || {}).filter(x => chosen.some(a => a.name === x.name)).sort((a, b) => b.t - a.t) : [];
            const xp = farm();
            // The account pills: tokens (what the games bet), then wallet.
            const accountLines = Object.fromEntries(ctx.accounts.list().map(a => { const m = a.me || {};
                return [a.id, [m.tokens != null ? `${tok(num(m.tokens))} tokens` : 'Tokens not read yet', busy.has(a.id) ? 'Playing now' : m.money != null ? `Wallet $${count(num(m.money))}` : '']]; }));
            return { accountLines, blocks: [
                { type: 'card', id: 'power', toggle: 'on', toggleDisabled: practice ? 'Set the mode to Live first' : null, bodyWhenOff: true, open: !live,
                    title: live ? (busy.size ? 'Games — on, playing now' : 'Games — on') : 'Games — off',
                    summary: !n && !xp ? 'choose accounts first' : practice ? 'practice: nothing is played unless you press Practice run' : `live on ${n} account${n === 1 ? '' : 's'}, every ${Math.max(5, num(S('everyMin')))} min`,
                    keys: ['runMode'] },
                ...(plans.length ? [{ type: 'table', wrap: true, columns: ['Account', 'The last practice run would', 'When'], rows: plans.slice(0, 10).map(x => [x.name, x.lines.join(' · '), new Date(x.t).toLocaleTimeString()]) }] : []),
                ...(bet ? [{ type: 'stats', items: [
                    { label: 'Profit', value: tok(back - bet + rw) + ' tokens' + (cash ? ` · $${cash}` : '') },
                    { label: 'Bets', value: tok(bet) },
                    { label: 'House edge paid', value: tok(bet - back) },
                    { label: 'Rewards', value: tok(rw) + ' tokens' },
                ] }] : []),
                // Who, which games, how careful, then Run: one step at a time.
                { type: 'wizard', id: 'play', steps: [
                    { id: 'accounts', title: 'Accounts', done: n > 0, warn: n || xp ? null : 'choose accounts first',
                        summary: n ? (n > 3 ? `${chosen.slice(0, 3).map(a => a.name).join(', ')} and ${n - 3} more` : chosen.map(a => a.name).join(', ')) : xp ? 'the Armory\'s accounts' : '', keys: ['accounts'] },
                    { id: 'games', title: 'Games to play', done: Object.keys(GAMES).some(g => S(g)), warn: Object.keys(GAMES).some(g => S(g)) ? null : 'no game switched on',
                        summary: Object.keys(GAMES).filter(g => S(g)).map(g => GAMES[g].label).join(', '),
                        text: 'Each game is played until its reward tiers are claimed, as long as a tier costs less than How careful allows.',
                        keys: Object.keys(GAMES) },
                    { id: 'careful', title: 'How careful', done: true, summary: `loss ≤ ${num(S('maxLoss'))} a tier · keep ${tok(num(S('keepTokens')))} tokens`, keys: ['maxLoss', 'keepTokens', 'maxPlays'] },
                ],
                extras: [
                    { id: 'tiers', title: 'Reward tiers', summary: all.some(x => x.plays) ? `${count(all.reduce((t, x) => t + x.plays, 0))} plays so far` : 'not played yet',
                        blocks: [{ type: 'table', wrap: true, columns: ['Game', 'Plays', 'Tiers', 'Lost a play', 'Bets', 'Back', 'Reward tokens'],
                            rows: Object.keys(GAMES).map(g => { const x = stats(g); return [GAMES[g].label, count(x.plays), String(x.tiers), x.plays ? tok(lossPerPlay(g)) + (x.plays < MIN_SAMPLE ? ' (guess)' : '') : '—', tok(x.bet), tok(x.back), tok(x.rewards)]; }) }] },
                    { id: 'xp', title: 'Armory XP', keys: xp ? [] : ['xpMode'],
                        summary: xp ? `follows the Armory: ${Object.entries(xp.games).filter(([, on]) => on).map(([g]) => GAMES[g] ? GAMES[g].label : g).join(', ') || 'no games'} on ${xp.accounts.length} account${xp.accounts.length === 1 ? '' : 's'}`
                            : S('xpMode') ? 'on: after the tiers, smallest bets up to each daily limit' : 'off',
                        text: 'After the tiers, keep playing at the smallest bets up to each daily limit, for pass XP.' },
                    { id: 'schedule', title: 'Schedule', summary: `every ${Math.max(5, num(S('everyMin')))} min`, keys: ['everyMin'] },
                ],
                finish: { title: busy.size && !practice ? `Playing on ${busy.size} account${busy.size === 1 ? '' : 's'}` : !n && !xp ? 'Choose accounts first' : practice ? 'Practice run' : live ? 'Games — on' : 'Run once',
                    ready: !!(n || xp), next: 'Run',
                    text: !n && !xp ? '' : practice ? 'Shows what a run would play on each account, without betting.' : live ? `Every ${Math.max(5, num(S('everyMin')))} min; Run now starts straight away.` : 'Games is off: Run now plays once.',
                    buttons: n || xp ? (busy.size && !practice
                        ? [{ label: halt ? 'Stopping…' : busy.size === 1 ? 'Stop' : `Stop all ${busy.size}`, action: 'stop', disabled: halt }]
                        : [{ label: practice ? 'Practice run' : 'Run now', action: 'run', primary: true }]) : [] } },
                { type: 'section', title: 'Recent runs', blocks: [{ type: 'table', empty: 'No runs yet.', columns: ['When', 'Account', 'Plays', 'Net', 'Rewards', 'Result'],
                    rows: (state.runs || []).slice(0, 10).map(r => [new Date(r.t).toLocaleTimeString(), r.acct, String(r.plays), tok(r.net), tok(r.rewards) + (r.cash ? ` · $${r.cash}` : ''), r.result]) }] },
            ] };
        });
        ctx.panel.badge((aid) => (busy.has(aid) && ctx.power.live() ? 'Playing games' : null));
    },
    stop() { busy.clear(); },
};
