// Blackjack, crash, dice and plinko for Armory XP, played by the Armory itself when the Games plugin isn't on and live
// (with Games running, Games plays them: see publish() in index.js). Smallest bets only, up to each game's daily
// limit. The same site calls as the Games plugin:
//   plinko    POST /api/casino/plinko { bet, risk }                              -> { bet, multiplier }
//   dice      POST /api/casino/dice { bet, targetNumber, playerChoice: 'under' } -> { tokensWonOrLost }
//   crash     socket: joinRoomCrash; on crashNewRound placeBetCrash { bet, autoCashout }; crashRoundEnd { bets }
//   blackjack socket: joinRoomBlackjack; createTableBlackjack { isPrivate } -> blackjackTableJoined;
//             blackjackTableState { phase, dealer, seats }; placeBetBlackjack { bet }; actionBlackjack { action, turnId }
// XP per play on every active pass: blackjack 10, crash 5, dice 5, plinko 0.5.

const BUSY = /locked|another action|wait a moment/i;
const LOCK_TRIES = 6;
const ROUND_MS = 60000;    // longest wait for a blackjack table to move
const CRASH_MS = 120000;   // longest wait for a crash round to open or end (a round takes ~20 s; the site's own
                           // crash pauses for a minute or more at times, and then every room waits together)
const CRASH_AT_ONCE = 30;   // accounts in the crash room at once: more only make the site's pauses longer
const FULL_WAIT_MS = 5000;  // an account with only crash left looks for a free place this often
const GAP_MS = 300;
const ROOM_EVERY = 10;      // plays between looks at the passes' room
const ROOM_WAIT_MS = 15000; // passes full: look again after this (full ones are restarted every minute)

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
class Quit extends Error {}

// Basic strategy without doubles or splits (1-token hands; S17). up: the dealer's up card (ace = 11).
function bjAction(hand, up) {
    const v = num(hand.value);
    if (hand.isSoft) return v >= 19 || (v === 18 && up >= 2 && up <= 8) ? 'stand' : 'hit';
    if (v >= 17) return 'stand';
    if (v >= 13) return up >= 2 && up <= 6 ? 'stand' : 'hit';
    if (v === 12) return up >= 4 && up <= 6 ? 'stand' : 'hit';
    return 'hit';
}

module.exports = function casino(ctx) {
    const S = (k) => (ctx.settings && ctx.settings.get ? ctx.settings.get(k) : 0);
    const crashWait = () => num(S('crashWaitMs')) || CRASH_MS;
    const crashCap = () => Math.max(1, num(S('crashAtOnce')) || CRASH_AT_ONCE);
    const crashSeats = new Set();   // accounts holding a crash place (their socket open)
    const crashFull = (aid) => !crashSeats.has(aid) && crashSeats.size >= crashCap();

    async function call(aid, path, body) {
        for (let i = 0; ; i++) {
            const r = await ctx.request(aid, path, { method: 'POST', body });
            if (r.kind === 'not-running' || r.kind === 'auth' || r.kind === 'cf') throw new Quit(r.kind === 'not-running' ? 'the account stopped clicking' : r.kind);
            const err = r.json && r.json.error;
            if (r.kind === 'ok' && r.json && !err) return r.json;
            if ((BUSY.test(String(err || '')) || r.status === 429) && i < LOCK_TRIES) { await ctx.sleep(1500 * (i + 1)); continue; }
            throw new Quit(`${path.split('/').pop()}: ${err || 'HTTP ' + r.status}`);
        }
    }
    async function userIdOf(aid, label) {
        const who = await ctx.request(aid, '/api/auth/get-session');
        const id = who.json && ((who.json.user && who.json.user.id) || (who.json.session && who.json.session.userId));
        if (!id) throw new Quit(label + ': could not tell which player this account is');
        return id;
    }

    // Highest XP per play first: the turn may end before the last game gets its go.
    const GAMES = {
        blackjack: { label: 'Blackjack', xp: 10, stake: 1, limit: 'blackjackHostLeft',
            open: async (aid) => {
                const userId = await userIdOf(aid, 'blackjack');
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
                if (!j || j.ev === 'blackjackError') { try { sock.close(); } catch (_) {} throw new Quit('blackjack: no table (' + (j ? JSON.stringify(j.data) : 'no answer') + ')'); }
                return { sock, userId };
            },
            close: (s) => { try { s.sock.emit('exitRoomBlackjack'); s.sock.close(); } catch (_) {} },
            play: async (aid, s) => {
                let betRound = null, acted = -1;
                const until = Date.now() + 3 * ROUND_MS;
                while (Date.now() < until) {
                    const e = await s.sock.wait(['blackjackTableState', 'blackjackError', 'blackjackKicked', 'blackjackTableClosed'], ROUND_MS);
                    if (!e) throw new Quit('blackjack: the table went quiet');
                    if (e.ev !== 'blackjackTableState') {
                        const msg = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
                        if (e.ev === 'blackjackError' && (BUSY.test(msg) || /already|betting is closed/i.test(msg))) { betRound = null; await ctx.sleep(1500); continue; }
                        throw new Quit(`blackjack: ${e.ev.replace('blackjack', '').toLowerCase()} ${msg}`);
                    }
                    const t = e.data, seat = (t.seats || []).find(x => x && x.userId === s.userId);
                    if (!seat) throw new Quit('blackjack: not seated at the table');
                    if (t.phase === 'betting' && seat.bet == null && betRound == null) { s.sock.emit('placeBetBlackjack', { bet: 1 }); betRound = t.roundId || 'pending'; continue; }
                    if (betRound == null) continue;
                    if (t.phase === 'acting' && seat.activeHandIndex != null && seat.turnId !== acted) {
                        const hand = (seat.hands || [])[seat.activeHandIndex];
                        if (hand) { acted = seat.turnId; s.sock.emit('actionBlackjack', { action: bjAction(hand, num(t.dealer && t.dealer.value)), turnId: seat.turnId }); }
                        continue;
                    }
                    if (seat.netProfit != null && seat.bet != null) return num(seat.netProfit);
                }
                throw new Quit('blackjack: the round never finished');
            } },
        crash: { label: 'Crash', xp: 5, stake: 1, limit: 'crashHostLeft',
            open: async (aid) => {
                const userId = await userIdOf(aid, 'crash');
                const sock = await ctx.socket(aid);
                sock.emit('joinRoomCrash');
                return { sock, userId };
            },
            close: (s) => { try { s.sock.emit('exitRoomCrash'); s.sock.close(); } catch (_) {} },
            play: async (aid, s) => {
                for (let tries = 0; tries < LOCK_TRIES; tries++) {
                    if (!(await s.sock.wait(['crashNewRound'], crashWait()))) throw new Quit('crash: no new round started');
                    await ctx.sleep(500);
                    s.sock.emit('placeBetCrash', { bet: 1, autoCashout: 1.01 });
                    let late = false;
                    // A round end from before the bet can be queued first: skip ends without this account's bet.
                    for (let ends = 0; ends < 3 && !late; ends++) {
                        const e = await s.sock.wait(['crashRoundEnd', 'crashError'], crashWait());
                        if (!e) throw new Quit('crash: the round never ended');
                        if (e.ev === 'crashError') {
                            const msg = typeof e.data === 'string' ? e.data : (e.data && (e.data.message || e.data.error)) || JSON.stringify(e.data);
                            if (BUSY.test(msg) || /betting phase is over/i.test(msg)) { late = true; break; }
                            if (/already placed/i.test(msg)) continue;
                            throw new Quit('crash: ' + msg);
                        }
                        const mine = (e.data && Array.isArray(e.data.bets) ? e.data.bets : []).find(b => b.userId === s.userId);
                        if (mine) return mine.cashedOutAt ? num(mine.profit) : -num(mine.bet);
                    }
                }
                throw new Quit('crash: the bet wasn\'t taken, round after round');
            } },
        dice: { label: 'Dice', xp: 5, stake: 100, limit: 'diceHostLeft',
            play: async (aid) => num((await call(aid, '/api/casino/dice', { bet: 100, targetNumber: 95, playerChoice: 'under' })).tokensWonOrLost) },
        plinko: { label: 'Plinko', xp: 0.5, stake: 1, limit: 'plinkoHostLeft',
            play: async (aid) => { const r = await call(aid, '/api/casino/plinko', { bet: 1, risk: 'Low' }); return (num(r.bet) || 1) * (num(r.multiplier) - 1); } },
    };

    // One account's go at the games, one game at a time (two of an account's bets at once get "User is locked").
    // o: { games: [keys], limits (gameLimitations), room () => XP the passes still take, tokens () => tokens now,
    //      keep (tokens to keep), ends, stop () => true to quit, hold () => true to wait before the next play }. Returns [{ game, label, plays, net, xp, error }].
    async function playFor(aid, o) {
        const out = [];
        // Crash with every place taken goes to the back of the list; once only it is left, the account waits for a place.
        const order = Object.keys(GAMES), later = new Set();
        for (let k = 0; k < order.length; k++) {
            const g = order[k];
            if (!o.games.includes(g) || o.stop() || Date.now() >= o.ends) continue;
            const G = GAMES[g];
            if (g === 'crash' && crashFull(aid) && !later.has(g)) { later.add(g); order.push(g); continue; }
            const n = num(o.limits[G.limit]);
            if (n <= 0) continue;
            // The passes' room: XP past a full pass is lost, but full passes are restarted every minute, so a full
            // account waits for room instead of giving up on the turn. Checked again every ROOM_EVERY plays.
            let budget = 0;
            const roomNow = async () => {
                for (;;) {
                    budget = Math.floor((await o.room()) / G.xp);
                    if (budget > 0 || Date.now() >= o.ends || o.stop()) return budget > 0;
                    await ctx.sleep(ROOM_WAIT_MS);
                }
            };
            if (!(await roomNow())) break;
            let tokens = await o.tokens();
            const r = { game: g, label: G.label, plays: 0, net: 0, xp: 0, error: null };
            let s = null, reopened = false;
            try {
                if (g === 'crash') {
                    // Look and take a place with no wait in between (other accounts look at the same time).
                    while (crashFull(aid)) {
                        if (!later.has(g)) { later.add(g); order.push(g); break; }
                        if (Date.now() >= o.ends || o.stop()) break;
                        await ctx.sleep(FULL_WAIT_MS);
                    }
                    if (crashFull(aid)) continue;   // to the back of the list, or out of time
                    crashSeats.add(aid);
                }
                if (G.open) s = await G.open(aid);
                for (let i = 0; i < n && Date.now() < o.ends && !o.stop(); i++) {
                    // A battle is seating this account: no new play until it's in (else "User is locked" for the battle).
                    while (o.hold && o.hold() && Date.now() < o.ends && !o.stop()) await ctx.sleep(500);
                    if (budget <= 0 || (i && i % ROOM_EVERY === 0)) { if (!(await roomNow())) break; }
                    budget--;
                    if (tokens - o.keep < G.stake) { r.error = `down to ${Math.floor(tokens)} tokens`; break; }
                    let net;
                    try { net = await G.play(aid, s); } catch (e) {
                        // A socket game whose connection went quiet: a fresh connection, once per turn.
                        if (!(e instanceof Quit) || !G.open || reopened || !/no new round|never ended|went quiet/.test(e.message)) throw e;
                        reopened = true;
                        G.close(s); s = null; s = await G.open(aid);
                        net = await G.play(aid, s);
                    }
                    r.plays++; r.net += net; r.xp += G.xp; tokens += net;
                    await ctx.sleep(GAP_MS);
                }
            } catch (e) {
                if (!(e instanceof Quit)) throw e;
                r.error = e.message.replace(/^\w+: /, '');
                if (/stopped clicking|^auth$|^cf$/.test(r.error)) { out.push(r); break; }
            } finally { if (s && G.close) G.close(s); if (g === 'crash') crashSeats.delete(aid); }
            out.push(r);
        }
        return out;
    }

    return { GAMES, playFor, crashSeats };
};
