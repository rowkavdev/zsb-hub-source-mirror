/**
 * SKILLMAPS
 *
 * Buys a preset's skills with an account's cash, as far as its cash and skill points go.
 *   maps   /_next/data/<build>/en/skillmaps/<map>.json -> pageProps { skillmap: JSON string
 *          { name, requiredRankId, skills: [{ id, requiredPrevSkillId, cost, name, rewards: ['15;0.1'] }] },
 *          skillIds: JSON string of the ids this account owns on that map }
 *   cash   /api/me -> { money, skillPoints, rank: { id, name }, casesPerClick (the case click %) }
 *          A skill costs its price in cash AND one skill point; points come with rank-ups.
 *   buy    POST /api/skill { mapName, skillId }   sell  DELETE /api/skill (only with "sell skills outside the preset")
 * A skill can be bought once the one before it is owned and the account's rank reaches its map's.
 * An account gets 3 points a rank up to Global Elite: 54 in all, so no preset is ever more than 54 skills.
 * Each buy is checked by reading the map back.
 */

const MAPS = ['Dust II', 'Mirage', 'Inferno', 'Ancient', 'Anubis', 'Cobblestone'];
const MAX_POINTS = 54;       // 3 a rank, up to Global Elite (rank 18): every account's lifetime total
const MAX_BUYS = 200;
const GAP_MS = 400;
// How hard Apply tries (the tests turn these down).
const T = {
    STEP_TRIES: 8,                // tries per sell or buy, each checked against the maps
    STEP_WAIT_MS: 2000,           // first wait between two tries of a step (doubling)
    STEP_WAIT_MAX_MS: 30000,      // longest wait between two tries of a step
    REQ_WAIT_MS: 10 * 60000,      // longest Apply waits out a passing failure on one read (rate limit, Cloudflare, re-login…)
    RESUME_MS: 60000,             // an unfinished Apply carries on by itself after this long
    RESUME_MAX: 10,               // … until this many tries in a row got nothing done
};
const HOLD_WAIT_MS = 15 * 60000;   // longest Apply waits for another plugin to finish what it's doing on the account
const FAILS_KEPT = 50;

// Reward codes the skills use (from the site's skill map page).
const EFFECTS = {
    11: { label: 'Money per click', fmt: (v) => '+$' + +v.toFixed(3) },
    13: { label: 'Vault capacity', fmt: (v) => '+$' + v.toLocaleString('en-US') },
    14: { label: 'Vault money a minute', fmt: (v) => '+$' + v.toLocaleString('en-US') },
    15: { label: 'Case click chance', fmt: (v) => '+' + +v.toFixed(2) + '%' },
    16: { label: 'Inventory size', fmt: (v) => '+' + v.toLocaleString('en-US') },
    17: { label: 'Max case open count', fmt: (v) => '+' + v },
    19: { label: 'Case click max case price', fmt: (v) => '+$' + v.toLocaleString('en-US') },
    20: { label: 'Case open multiplier', fmt: (v) => '+' + v },
};

// The presets: name, what it's for, and the reward it buys first when cash or points don't cover everything
// ('15' case click %, '11' money per click, null = cheapest first).
const PRESETS = {
    opens35: { name: 'Max case open, money click, $5.75m', sub: 'Max case open (35×2). Needs 5k Premier.', goal: '11' },
    opens31: { name: 'Case open, money click, $5.81m', sub: '31 case opens (31×2). Needs 5k Premier.', goal: '11' },
    opens19: { name: '$25 cases, case open, $5.11m', sub: '33.5% $25 cases, 19 case opens (19×2). Needs 5k Premier.', goal: '15' },
    ge16: { name: '$10 cases, case click, $211k', sub: '33.6% cases, 16 case opens. No Premier needed.', goal: '15' },
};
const PRESET_ORDER = ['opens35', 'opens31', 'opens19', 'ge16'];
const DEFAULT_PRESET = 'ge16';

const PLANS = {
    // From the user's own maps (2026-11-16): each is 54 skills, prerequisites included, and costs what the site says.
    opens35: ['d19', 'd18', 'd23', 'd17', 'd16', 'd15', 'd14', 'd13', 'e19', 'e38', 'e39', 'e40', 'e41', 'e24', 'e25', 'e26', 'e31', 'e32', 'e14', 'e13', 'e12', 'e11', 'e10', 'e6', 'e1', 'e18', 'e17', 'e16', 'e15', 'f1', 'f3', 'f9', 'f4', 'f5', 'f6', 'f7', 'f8', 'f10', 'f11', 'f12', 'f13', 'f14', 'f15', 'f20', 'f19', 'f16', 'f23', 'f22', 'f21', 'f24', 'f28', 'f29', 'f30', 'f31'],   // $5,750,500
    opens31: ['d13', 'd14', 'd15', 'd16', 'd17', 'e19', 'e38', 'e39', 'e40', 'e41', 'e24', 'e25', 'e26', 'e27', 'e28', 'e31', 'e32', 'e18', 'e17', 'e16', 'e15', 'e10', 'e6', 'e1', 'e2', 'f1', 'f3', 'f9', 'f10', 'f11', 'f12', 'f13', 'f14', 'f15', 'f4', 'f5', 'f6', 'f7', 'f8', 'f20', 'f19', 'f18', 'f17', 'f16', 'f23', 'f22', 'f21', 'f24', 'f25', 'f26', 'f28', 'f29', 'f30', 'f31'],   // $5,808,500
    opens19: ['c15', 'c14', 'c13', 'c17', 'c16', 'c24', 'c30', 'c31', 'c34', 'c35', 'd1', 'd2', 'd25', 'd24', 'd18', 'd21', 'd13', 'd14', 'd15', 'd16', 'd17', 'e19', 'e24', 'e34', 'e33', 'e35', 'e36', 'e17', 'e16', 'e15', 'e11', 'e10', 'e6', 'e1', 'e18', 'f1', 'f3', 'f9', 'f10', 'f11', 'f26', 'f25', 'f27', 'f24', 'f23', 'f22', 'f21', 'f16', 'f19', 'f20', 'f28', 'f29', 'f30', 'f31'],   // $5,110,550
    ge16: ['b17', 'b16', 'b14', 'b13', 'b12', 'b15', 'b11', 'b27', 'b26', 'b28', 'b25', 'b18', 'b1', 'c23', 'c22', 'c21', 'c20', 'c15', 'c14', 'c13', 'c17', 'c16', 'c24', 'c30', 'c31', 'c34', 'c35', 'd1', 'd2', 'd3', 'd5', 'd25', 'd24', 'd18', 'd21', 'd13', 'd14', 'd15', 'd16', 'd17', 'e19', 'e24', 'e34', 'e33', 'e35', 'e36', 'e17', 'e16', 'e15', 'e11', 'e10', 'e6', 'e1', 'e18'],   // $211,330
};

let ctx = null;
let state = null;            // saved: { accts: { aid: {...} }, fails: [{ t, name, text }] }
let build = null;
let defs = null;             // [{ name, rank, skills }] from the last read; the same for every account
const busy = new Map();      // aid -> while Apply works on it: what it's waiting for ('' once it has the account)
const ownedBy = new Map();   // aid -> { t, ids } the skills an account owns, from its last map read (for the live cost check)
const triedAt = new Map();   // aid -> when its maps were last asked for, so a failing read isn't retried on every redraw
const OWNED_MS = 5 * 60000;  // how old an account's owned skills may get before they're read again

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const money = (n) => '$' + (Math.abs(n) >= 1e6 ? +(n / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e3 ? +(n / 1e3).toFixed(1) + 'k' : Math.round(n));
// The site's rank ids are CS's ranks, Silver I (1) to Global Elite (18): the short names players use, for the pills.
const RANK_SHORT = [null, 'S1', 'S2', 'S3', 'S4', 'SE', 'SEM', 'Nova 1', 'Nova 2', 'Nova 3', 'Nova M', 'MG1', 'MG2', 'MGE', 'DMG', 'LE', 'LEM', 'SMFC', 'GE'];
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const S = (k) => ctx.settings.get(k);
const preset = () => (PRESETS[S('plan')] ? S('plan') : DEFAULT_PRESET);

class Stop extends Error {}

const save = () => ctx.data.set(state);
const effectsOf = (skill) => (skill.rewards || []).map(r => String(r).split(';')).filter(([c]) => EFFECTS[c]).map(([c, v]) => ({ code: c, value: num(v) }));

// A line for the failure printout. Only failures are kept; the page shows them when there are any.
function fail(name, text) {
    state.fails = [{ t: Date.now(), name, text }, ...(state.fails || [])].slice(0, FAILS_KEPT);
}

// Failures that pass by themselves: Apply waits them out instead of stopping halfway.
const PASSING = new Set(['not-running', 'gone', 'auth', 'cf', 'rate', 'site', 'net', 'timeout', 'maintenance', 'proxy']);
const SAID = { 'not-running': 'the account stopped clicking', gone: 'the account stopped clicking', auth: 'logged out', cf: 'Cloudflare check',
    rate: 'the site said slow down', site: 'the site had an error', net: 'network error', timeout: 'no answer from the site', maintenance: 'site maintenance', proxy: 'proxy error' };
async function req(aid, path, opts = {}) {
    // While Apply works on the account its requests go ahead of other plugins' queued ones and wait out passing
    // failures (up to T.REQ_WAIT_MS); a sell or buy is sent once (step() checks the maps and sends it again if needed).
    const applying = busy.has(aid), send = (opts.method || 'GET') !== 'GET';
    const until = Date.now() + T.REQ_WAIT_MS;
    for (let t = 0; ; t++) {
        const r = await ctx.request(aid, path, { ...opts, first: applying });
        if (!PASSING.has(r.kind)) return r;
        if (!applying || Date.now() > until) throw new Stop(`${SAID[r.kind] || r.kind}${applying ? ` for ${T.REQ_WAIT_MS / 60000} minutes` : ''}`);
        if (send && r.kind !== 'not-running' && r.kind !== 'gone') return r;
        if (ctx.stopping) throw new Stop('turned off');
        await ctx.sleep(Math.min(T.STEP_WAIT_MAX_MS, T.STEP_WAIT_MS * 2 ** t));
    }
}

async function readBuild(aid) {
    const home = await req(aid, '/');
    const m = /"buildId"\s*:\s*"([^"]+)"/.exec(home.body || '');
    if (!m) throw new Stop('could not read the site (no build id)');
    build = m[1];
}

// Every map with the skills this account owns on it.
async function readMaps(aid) {
    if (!build) await readBuild(aid);
    const out = [], owned = new Set();
    for (const name of MAPS) {
        const path = () => `/_next/data/${build}/en/skillmaps/${encodeURIComponent(name)}.json?skillmap=${encodeURIComponent(name)}`;
        let r = await req(aid, path());
        if (r.status === 404) { await readBuild(aid); r = await req(aid, path()); }   // the site was updated
        const pp = r.json && r.json.pageProps;
        if (r.kind !== 'ok' || !pp || !pp.skillmap) throw new Stop(`could not read the ${name} skill map (HTTP ${r.status})`);
        const map = typeof pp.skillmap === 'string' ? JSON.parse(pp.skillmap) : pp.skillmap;
        const ids = typeof pp.skillIds === 'string' ? JSON.parse(pp.skillIds) : pp.skillIds || [];
        out.push({ name: map.name || name, rank: map.requiredRankId == null ? null : num(map.requiredRankId), skills: Array.isArray(map.skills) ? map.skills : [] });
        for (const id of ids) owned.add(String(id));
    }
    defs = out;
    ownedBy.set(aid, { ...ownedBy.get(aid), t: Date.now(), ids: new Set(owned) });
    return { maps: out, owned };
}

function index(maps) {
    const byId = new Map();
    maps.forEach((m, mi) => m.skills.forEach((s) => byId.set(s.id, { ...s, map: m.name, mapRank: m.rank, mi })));
    return byId;
}

// The preset's skill ids, with every skill they need first added, cut at 54 (every id comes after the skills it
// needs, so the cut never leaves a skill without its prerequisite).
function planOf(byId, id = preset()) {
    const raw = PLANS[id] || [];
    const unknown = [], ids = [];
    const add = (x) => {
        if (ids.includes(x)) return true;
        const s = byId.get(x);
        if (!s) { if (!unknown.includes(x)) unknown.push(x); return false; }
        const chain = [];   // x and the skills it needs that aren't in yet, first-needed first
        for (let t = s; t && !ids.includes(t.id); t = byId.get(t.requiredPrevSkillId)) chain.unshift(t.id);
        if (ids.length + chain.length > MAX_POINTS) return false;
        ids.push(...chain);
        return true;
    };
    for (const x of raw) { if (ids.length >= MAX_POINTS) break; add(String(x).trim()); }
    return { ids, unknown };
}

// Case click % per skill point through a skill: the best (sum of case %) / (skills on the way) over the
// preset's paths that start at it. A 0% prerequisite that opens a big case skill scores like the path, so
// it isn't passed over for cheap filler. Only unowned preset skills count.
function pathValue(byId, plan, owned, rankId, code) {
    const valueOf = (s) => effectsOf(s).filter(e => e.code === code).reduce((t, e) => t + e.value, 0);
    const inPlan = new Set(plan.ids), kids = new Map(), memo = new Map();
    for (const id of plan.ids) { const p = byId.get(id).requiredPrevSkillId; if (p) kids.set(p, [...(kids.get(p) || []), id]); }
    const reach = (s) => s.mapRank == null || s.mapRank <= rankId;
    const paths = (id) => {
        if (memo.has(id)) return memo.get(id);
        const s = byId.get(id), own = valueOf(s);
        const out = [[own, 1]];
        for (const k of kids.get(id) || []) if (inPlan.has(k) && !owned.has(k) && reach(byId.get(k))) for (const [v, n] of paths(k)) out.push([own + v, n + 1]);
        memo.set(id, out);
        return out;
    };
    return (s) => Math.max(...paths(s.id).map(([v, n]) => v / n));
}

// The next skill to buy. If the cash or skill points don't cover it yet, the account saves up for it
// rather than spending on something further down the order.
function next(byId, plan, owned, rankId, locked) {
    const ready = plan.ids.map(id => byId.get(id)).filter(s => !owned.has(s.id) && (!s.requiredPrevSkillId || owned.has(s.requiredPrevSkillId))
        && !locked.has(s.map) && (s.mapRank == null || s.mapRank <= rankId));
    const pos = (s) => plan.ids.indexOf(s.id);
    const code = PRESETS[preset()].goal;
    const worth = code ? pathValue(byId, plan, owned, rankId, code) : null;
    ready.sort(!code ? (a, b) => a.cost - b.cost || pos(a) - pos(b)
        : (a, b) => worth(b) - worth(a) || a.cost - b.cost || pos(a) - pos(b));
    return ready[0] || null;
}

// Owned skills the preset doesn't have, deepest first (a skill can only be sold once nothing after it is owned).
function extras(byId, plan, owned) {
    const inPlan = new Set(plan.ids), out = [];
    const left = new Set([...owned].filter(id => byId.has(id) && !inPlan.has(id)));
    while (left.size) {
        const leaf = [...left].find(id => ![...owned].some(o => byId.get(o) && byId.get(o).requiredPrevSkillId === id && (left.has(o) || inPlan.has(o))));
        if (!leaf) break;   // shouldn't happen: the preset includes every skill its skills need
        out.push(byId.get(leaf)); left.delete(leaf); owned = new Set([...owned].filter(o => o !== leaf));
    }
    return out;
}

// Apply: sell what isn't in the preset (with selling on), then buy the rest of it. Only starts an account that can
// finish it; the page shows the same numbers beforehand (preview()).
// Apply has the account to itself: other plugins start nothing new on it (the busy mark; the Armory hands it over
// when asked), and Apply waits for what they already have going there to finish before it reads the wallet.
async function hold(aid) {
    if (ctx.accounts.setBusy) ctx.accounts.setBusy(aid, 'applying a skill preset (others wait)');
    if (ctx.accounts.want) ctx.accounts.want(aid, 'applying a skill preset');
    const until = Date.now() + HOLD_WAIT_MS;
    for (let b; (b = ctx.accounts.busy && ctx.accounts.busy(aid));) {
        const who = `${b.plugin[0].toUpperCase() + b.plugin.slice(1)} (${b.what})`;
        if (ctx.stopping) throw new Stop('turned off');
        if (Date.now() > until) throw new Stop(`not started: ${who} kept the account busy for ${HOLD_WAIT_MS / 60000} minutes`);
        busy.set(aid, who);
        await ctx.sleep(1000);
    }
    busy.set(aid, '');
}
function release(aid) {
    if (ctx.accounts.setBusy) ctx.accounts.setBusy(aid, null);
    if (ctx.accounts.want) ctx.accounts.want(aid, null);
}

// Apply must not stop halfway (skills sold, the preset not bought). So every sell and buy is one step: send it, then
// read the maps to see whether it happened (the maps are the truth: a buy whose answer was lost but went through
// counts, and is never sent twice), and try again with longer waits if it didn't. Reads wait out what passes (the
// site busy or rate-limiting, a network hiccup, a Cloudflare check, a re-login, the account restarting). If a run
// still can't finish, the account is kept as unfinished and Apply carries on by itself a minute later, even after
// a restart, until the preset is done (or T.RESUME_MAX tries in a row got nowhere).
async function step(aid, what, act, done) {
    let last = '';
    for (let t = 0; t < T.STEP_TRIES; t++) {
        if (ctx.stopping) throw new Stop('turned off');
        if (t) {
            if (await done()) return;   // the try before went through after all
            await ctx.sleep(Math.min(T.STEP_WAIT_MAX_MS, T.STEP_WAIT_MS * 2 ** (t - 1)));
        }
        const r = await act();
        last = (r.json && r.json.error) || (r.kind === 'ok' ? '' : r.kind === 'api' ? 'HTTP ' + r.status : SAID[r.kind] || r.kind);
        if (/skillmap is locked|map is locked/i.test(last)) throw new Locked(last);
        if (await done()) return;
    }
    throw new Stop(`couldn't ${what} after ${T.STEP_TRIES} tries${last ? ` (${last})` : ''}`);
}
class Locked extends Error {}

async function run(aid, name, resuming = false) {
    busy.set(aid, '');
    const log = (msg, level = 'info') => ctx.log(msg, level, aid);
    const job = (state.unfinished || {})[aid];
    const id = resuming && job ? job.preset : preset();
    const info = { t: Date.now(), name, error: null, preset: id };
    let changed = false;
    try {
        await hold(aid);
        let me = (await req(aid, '/api/me')).json || {};
        let { maps, owned } = await readMaps(aid);
        const byId = index(maps);
        const plan = planOf(byId, id);
        if (plan.unknown.length) fail(name, `${plural(plan.unknown.length, 'skill')} in the preset aren't on any map, skipped: ${plan.unknown.slice(0, 6).join(', ')}${plan.unknown.length > 6 ? ', …' : ''}`);
        let bought = 0, soldN = 0;
        const rankId = num(me.rank && me.rank.id);
        remember(aid, me);   // fresh numbers for the table too
        // Only start if the account can finish the whole preset (cash, skill points, rank), checked with fresh numbers.
        { const why = whyNot(finishCheck(byId, plan, owned, num(me.money), num(me.skillPoints), rankId)); if (why) throw new Stop('not started: ' + why); }
        // From here on the account is part-way: kept as unfinished until the preset is done.
        state.unfinished = { ...(state.unfinished || {}), [aid]: { preset: id, name, since: (job && job.since) || Date.now(), tries: resuming && job ? job.tries : 0 } };
        save();
        const reread = async () => { ({ owned } = await readMaps(aid)); return owned; };
        // Switching presets: skills that aren't in this one are sold first, for their points (and half their price).
        if (S('sellOthers')) {
            for (const s of extras(byId, plan, owned)) {
                await step(aid, `sell ${s.id} ${s.name} (${s.map})`,
                    () => req(aid, '/api/skill', { method: 'DELETE', body: { mapName: s.map, skillId: s.id } }),
                    async () => !(await reread()).has(s.id));
                changed = true; soldN++;
                await ctx.sleep(GAP_MS);
            }
            if (soldN) log(`sold ${plural(soldN, 'skill')} that aren't in the preset`, 'ok');
        }
        const locked = new Set();
        for (let i = 0; i < MAX_BUYS; i++) {
            if (ctx.stopping) throw new Stop('turned off');
            if (owned.size >= MAX_POINTS) break;
            me = (await req(aid, '/api/me')).json || me;
            const cash = num(me.money), points = num(me.skillPoints);
            const s = next(byId, plan, owned, rankId, locked);
            if (!s) break;
            if (s.cost > cash) throw new Stop(`short ${money(s.cost - cash)} for ${s.id} ${s.name} (cash went down while applying)`);
            if (points < 1) throw new Stop(`out of skill points before ${s.id} ${s.name}`);
            try {
                await step(aid, `buy ${s.id} ${s.name} (${s.map})`,
                    () => req(aid, '/api/skill', { method: 'POST', body: { mapName: s.map, skillId: s.id } }),
                    async () => (await reread()).has(s.id));
            } catch (e) {
                if (!(e instanceof Locked)) throw e;
                locked.add(s.map); log(`${s.map} is locked for now (${e.message})`, 'warn'); continue;
            }
            changed = true; bought++;
            log(`bought ${s.id} ${s.name} (${s.map}) for ${money(s.cost)}`, 'ok');
            await ctx.sleep(GAP_MS);
        }
        me = (await req(aid, '/api/me')).json || me;
        remember(aid, me);
        const left = plan.ids.filter(x => !owned.has(x)).length;
        if (left) throw new Stop(`${plural(left, 'skill')} of the preset still to buy${locked.size ? ` (${[...locked].join(', ')} locked)` : ''}`);
        if (bought) log(`${plural(bought, 'skill')} bought, ${money(num(me.money))} cash left`, 'ok');
        if (state.unfinished) delete state.unfinished[aid];
        state.fails = (state.fails || []).filter(x => x.name !== name);   // done: what went wrong on the way is settled
    } catch (e) {
        info.error = e.message;
        const u = (state.unfinished || {})[aid];
        // Part-way: carried on by itself in a minute (the page shows why it stopped and that it will). A try that got
        // something done doesn't count against it.
        if (u && (resuming || !/^not started/.test(e.message))) { u.tries = (u.tries || 0) + (changed ? 0 : 1); u.at = Date.now(); u.why = e.message; }
        if (!ctx.stopping || !(e instanceof Stop)) fail(name, e.message);
        if (!(e instanceof Stop)) ctx.log('stopped: ' + e.message, 'error', aid);
        else if (!ctx.stopping) log('stopped: ' + e.message, 'warn');
    } finally {
        state.accts = { ...(state.accts || {}), [aid]: { ...(state.accts || {})[aid], ...info } };
        release(aid);
        busy.delete(aid);
        save();
    }
}

// The table's "now → after Apply" columns: what the skills give, nothing else (boosts, passes and the like left out),
// so they read like the preset cards. Reward code and how it reads; case click starts at the site's 1%.
const STAT_COLS = [['15', (v) => +v.toFixed(2) + '%'], ['11', (v) => '+$' + +v.toFixed(3)], ['14', (v) => '+$' + Math.round(v).toLocaleString('en-US')]];
// Case opens per open (17) and the open multiplier (20) read as one "16×1" column, from the site's 10×1.
const BASE = { 15: 1, 17: 10, 20: 1 };
const OPEN_CODES = ['17', '20'];
const opens = (v) => `${Math.round(v['17'])}×${Math.round(v['20'])}`;
const openChange = (x) => (!x.was ? '—' : opens(x.was) === opens(x.now) ? opens(x.was) : `${opens(x.was)} → ${opens(x.now)}`);
const change = (x, c, fmt) => (!x.was ? '—' : Math.abs(x.now[c] - x.was[c]) < 1e-9 ? fmt(x.was[c]) : `${fmt(x.was[c])} → ${fmt(x.now[c])}`);

// Can this account finish the whole preset right now? Apply only starts an account that can:
//   cash   — its wallet, plus half the price of the skills it would sell (with selling on), covers the missing skills
//   points — its free skill points, plus one per skill it would sell, cover one per missing skill
//   rank   — every map with a missing skill is open at its rank
// (Cobblestone's 5k Premier lock only shows when a buy is refused; the site doesn't say it up front.)
function finishCheck(byId, plan, owned, wallet, points, rankId) {
    const missing = plan.ids.filter(x => !owned.has(x)).map(x => byId.get(x));
    const others = extras(byId, plan, owned), sell = !!S('sellOthers');
    const cost = missing.reduce((t, s) => t + num(s.cost), 0);
    const refund = sell ? others.reduce((t, s) => t + num(s.cost) / 2, 0) : 0;
    const free = points + (sell ? others.length : 0);
    const locked = [...new Set(missing.filter(s => s.mapRank != null && s.mapRank > rankId).map(s => s.map))];
    const f = { wallet, refund, cost, points, free, missing: missing.length, others: others.length, sell, locked, buyList: missing, sellList: others, total: plan.ids.length,
        cashOk: wallet + refund >= cost, pointsOk: free >= missing.length };
    f.ok = f.cashOk && f.pointsOk && !locked.length;
    return f;
}

// Why an account won't start, in words (null when it will).
function whyNot(f) {
    if (f.ok) return null;
    if (f.locked.length) return `needs a higher rank for ${f.locked.join(', ')}`;
    const parts = [];
    if (!f.cashOk) parts.push(`short ${money(f.cost - f.wallet - f.refund)} (wallet ${money(f.wallet)}${f.refund ? ` + ${money(f.refund)} from selling` : ''}, the preset still costs ${money(f.cost)})`);
    if (!f.pointsOk) parts.push(`short ${plural(f.missing - f.free, 'skill point')} (needs ${f.missing}, has ${f.free}${!f.sell && f.others ? `; turning on selling frees ${f.others} more` : ''})`);
    return parts.join(' and ');
}

// The check for the table and the Apply button, from the last map read and the clicker's latest numbers.
// null until the account's maps have been read once.
function affordOf(aid, id) {
    const o = ownedBy.get(aid), live = ctx.accounts.stats(aid) || {}, saved = (o && o.me) || {};
    // The clicker's latest numbers, field by field, or (before it has them) the ones read with the maps.
    const isLive = live.money != null && Number.isFinite(Number(live.money));
    const get = (k) => (live[k] != null ? live[k] : saved[k]);
    if (!defs || !o || get('money') == null) return null;   // wallet not known yet
    const byId = index(defs);
    const f = finishCheck(byId, planOf(byId, id), o.ids, num(get('money')), num(get('skillPoints')), num(get('rank') && get('rank').id));
    f.rank = get('rank') && get('rank').name;
    f.rankShort = RANK_SHORT[num(get('rank') && get('rank').id)] || null;
    f.live = isLive;
    // Case click %, money per click, vault money a minute and case opens: now, and once Apply has sold and bought.
    f.was = Object.fromEntries([...STAT_COLS.map(([c]) => c), ...OPEN_CODES].map(c => [c, BASE[c] || 0]));
    for (const sid of o.ids) for (const e of byId.get(sid) ? effectsOf(byId.get(sid)) : []) if (f.was[e.code] != null) f.was[e.code] += e.value;
    f.now = { ...f.was };
    const shift = (s, k) => { for (const e of effectsOf(s)) if (f.now[e.code] != null) f.now[e.code] += k * e.value; };
    if (f.sell) f.sellList.forEach(s => shift(s, -1));
    f.buyList.forEach(s => shift(s, 1));
    return f;
}

// What Apply needs from /api/me, kept with the owned skills for when the clicker has no numbers of its own yet.
function remember(aid, me) {
    const o = ownedBy.get(aid);
    if (!o || !me) return;
    o.me = { ...(o.me || {}) };
    for (const k of ['money', 'skillPoints', 'rank']) if (me[k] != null) o.me[k] = me[k];
}

// "54 skills on 4 maps · $1.2M · case click chance +34%" — what a preset amounts to, for the picker.
function presetLine(id) {
    if (!defs) return null;
    const byId = index(defs), plan = planOf(byId, id);
    if (!plan.ids.length) return 'empty';
    const totals = {}, maps = new Set();
    let cost = 0;
    for (const x of plan.ids) {
        const s = byId.get(x);
        cost += num(s.cost); maps.add(s.map);
        for (const e of effectsOf(s)) totals[e.code] = (totals[e.code] || 0) + e.value;
    }
    // Cost, what the preset is for (total case click chance with the base 1%, or money per click), then vault money a minute.
    const goal = PRESETS[id].goal, v = totals[goal] || 0;
    return [money(cost), goal === '15' ? `${+(1 + v).toFixed(2)}% cases` : `+$${+v.toFixed(3)}/click`,
        `+$${(totals['14'] || 0).toLocaleString('en-US')}/min vault`].join(' · ');
}

module.exports = {
    start(c) {
        ctx = c;
        state = { accts: {}, fails: [], ...ctx.data.get() };
        delete state.history; delete state.owned; delete state.last; delete state.previewAt; delete state.plans; delete state.practiceAt;   // from older versions
        // Read the maps as soon as an account is clicking, so the presets can say what they give before anything runs.
        const fill = async () => { if (defs) return; const a = ctx.accounts.list().find(x => x.healthy); if (a) { try { await readMaps(a.id); } catch (_) {} } };
        fill();
        ctx.every(15000, fill);
        // Keep each chosen account's owned skills fresh (a few accounts at a time), for the live cost check.
        let refreshing = false;
        const refresh = async () => {
            if (refreshing) return;
            refreshing = true;
            try {
                const now = Date.now();
                const due = ctx.accounts.list().filter(a => a.healthy && ctx.settings.runsOn('accounts', a.id) && !busy.has(a.id)
                    && (now - ((ownedBy.get(a.id) || {}).t || 0) > OWNED_MS || !(ownedBy.get(a.id) || {}).me) && now - (triedAt.get(a.id) || 0) > 60000).slice(0, 3);
                for (const a of due) {
                    if (ctx.stopping) break;
                    triedAt.set(a.id, Date.now());
                    try {
                        await readMaps(a.id);
                        const m = (await req(a.id, '/api/me')).json;
                        remember(a.id, m);
                    } catch (_) {}
                }
            } finally { refreshing = false; }
        };
        ctx.every(15000, refresh);
        // An Apply that stopped part-way (or was cut off by a restart) carries on by itself, chosen or not.
        const resume = () => {
            const now = Date.now();
            for (const [aid, u] of Object.entries(state.unfinished || {})) {
                const a = ctx.accounts.list().find(x => x.id === aid);
                if (!a) { delete state.unfinished[aid]; save(); continue; }
                if (!a.healthy || busy.has(aid) || (u.tries || 0) >= T.RESUME_MAX || now - (u.at || 0) < T.RESUME_MS) continue;
                ctx.log(`carrying on with ${(PRESETS[u.preset] || {}).name || u.preset}${u.why ? ` (stopped: ${u.why})` : ''}`, 'info', aid);
                run(aid, a.name, true);
            }
        };
        ctx.every(5000, resume);

        // A tool, not a background job: the table shows what Apply would do for each chosen account; Apply does it.
        const go = () => {
            const chosen = ctx.accounts.list().filter(a => ctx.settings.runsOn('accounts', a.id));
            if (!chosen.length) return { ok: false, error: 'Choose accounts first.' };
            const ready = chosen.filter(a => a.healthy && !busy.has(a.id));
            if (!ready.length) return { ok: false, error: 'None of them is clicking right now.' };
            // An account the live check already shows can't finish isn't started (each run checks again with fresh numbers).
            const short = ready.map(a => [a, affordOf(a.id, preset())]).filter(([, f]) => f && f.live && !f.ok);
            const todo = ready.filter(a => !short.some(([b]) => b === a));
            state.fails = [];
            for (const a of chosen) if (!a.healthy) fail(a.name, 'not clicking — skipped');
            for (const [a, f] of short) fail(a.name, 'not started: ' + whyNot(f));
            save();
            if (!todo.length) return { ok: false, error: `None of them can finish ${PRESETS[preset()].name} yet.` };
            for (const a of todo) run(a.id, a.name);
            return { message: `Applying ${PRESETS[preset()].name} on ${plural(todo.length, 'account')}.` };
        };
        ctx.panel.action('apply', () => go());
        // The maps as last read (ids, names, places, costs, rewards): for building presets from the site's own map.
        ctx.panel.action('maps', () => (defs ? { ok: true, maps: defs } : { ok: false, error: 'The maps load once an account is clicking.' }));
        ctx.panel.action('usePlan', (id) => {
            if (!PRESETS[id]) return { ok: false, error: 'No such preset.' };
            const r = ctx.settings.set('plan', String(id));
            if (r && r.ok === false) return { ok: false, error: `Couldn't save the preset: ${r.error || 'refused'}` };
            return { message: `Preset: ${PRESETS[id].name}` };
        });

        ctx.panel.tab('Skillmaps', () => {
            const chosen = ctx.accounts.list().filter(a => ctx.settings.runsOn('accounts', a.id));
            const n = chosen.length, id = preset();
            const applying = chosen.filter(a => busy.has(a.id)).length;
            // Worked out live from each account's owned skills and the clicker's numbers: picking another preset or
            // turning selling on shows at once what Apply would sell, buy and cost, and what it changes.
            if (chosen.some(a => a.healthy && !(ownedBy.get(a.id) || {}).me)) refresh();
            const checks = new Map(chosen.map(a => [a.id, affordOf(a.id, id)]));
            // What Apply would do for this account now, in words.
            const status = (a, f, x) => {
                if (busy.has(a.id)) return busy.get(a.id) ? { text: `Waiting for ${busy.get(a.id)} to finish`, level: 'muted' } : 'Applying…';
                if (!a.healthy) return { text: 'Not clicking', level: 'muted' };
                const u = (state.unfinished || {})[a.id];
                if (u) {
                    const what = u.preset === id ? '' : ` ${(PRESETS[u.preset] || {}).name || u.preset}`;
                    if ((u.tries || 0) >= T.RESUME_MAX) return { text: `Stopped part-way${what}: ${u.why}. Press Apply to try again.`, level: 'bad' };
                    const inS = Math.max(0, Math.ceil(((u.at || 0) + T.RESUME_MS - Date.now()) / 1000));
                    return { text: `Unfinished${what}: ${u.why || 'cut off'} — carrying on ${inS ? `in ${inS}s` : 'now'}`, level: 'warn' };
                }
                if (!f) return { text: 'Checking…', level: 'muted' };
                // A run that failed partway (a refused buy) says so; "won't start" always comes from the live check below.
                if (x && x.error && x.preset === id && !/^not started/.test(x.error)) return { text: x.error[0].toUpperCase() + x.error.slice(1), level: 'bad' };
                if (!f.missing) return { text: 'Has the whole preset', level: 'ok' };
                const why = whyNot(f);
                return why ? { text: `Won't start: ${why}`, level: 'warn' } : { text: 'Ready', level: 'ok' };
            };
            const rows = chosen.map(a => {
                const x = (state.accts || {})[a.id], f = checks.get(a.id);
                if (!f) return [a.name, '—', '—', '—', '—', '—', '—', '—', '—', status(a, f, x)];
                return [a.name, money(f.wallet),
                    !f.others ? '0' : f.sell ? `${f.others} · +${money(f.refund)}` : { text: `0 (keeps ${f.others})`, level: 'muted' },
                    String(f.missing),
                    !f.cost ? '$0' : f.cashOk ? money(f.cost) : { text: `${money(f.cost)} · short ${money(f.cost - f.wallet - f.refund)}`, level: 'warn' },
                    openChange(f), ...STAT_COLS.map(([c, fmt]) => change(f, c, fmt)),
                    status(a, f, x)];
            });
            const known = [...checks.values()].filter(Boolean), canPay = known.filter(f => f.ok).length;
            const fails = state.fails || [];
            const can = known.length ? ` ${canPay} of ${known.length} can now.` : '';
            // The live preview goes inside the step windows too, so picking a preset or selling shows what it does there and then.
            const COLS = ['Account', 'Wallet', 'Sells', 'Buys', 'Costs', 'Case opens', 'Case click', 'Money / click', 'Vault / min', 'Status'];
            const SHORT = [0, 2, 3, 4, 9];   // Account, Sells, Buys, Costs, Status; the review adds Wallet and Case click. The whole table is on the page.
            const preview = (cols) => (n ? [{ type: 'text', text: 'What Apply does now:' }, { type: 'table', columns: cols.map(i => COLS[i]), rows: rows.map(r => cols.map(i => r[i])) }] : []);
            // The account pills: what each account brings to a preset (skill points, rank as players write it, cash).
            // How much of the preset it has is the table's job.
            const accountLines = Object.fromEntries(ctx.accounts.list().map(a => { const f = affordOf(a.id, id);
                return [a.id, f ? [`${plural(f.points, 'point')}${f.rankShort ? ' · ' + f.rankShort : ''}`, `Wallet ${money(f.wallet)}`]
                    : ['Skills not read yet', ctx.settings.runsOn('accounts', a.id) ? 'Reading maps…' : 'Read once chosen']]; }));
            return { accountLines, blocks: [
                // Who, which preset, what happens to other skills, then Apply: one step at a time.
                { type: 'wizard', id: 'apply', steps: [
                    { id: 'accounts', title: 'Accounts', done: n > 0, warn: n ? null : 'choose accounts first',
                        summary: n > 3 ? `${chosen.slice(0, 3).map(a => a.name).join(', ')} and ${n - 3} more` : chosen.map(a => a.name).join(', '), keys: ['accounts'] },
                    { id: 'preset', title: 'Preset', done: true, summary: PRESETS[id].name,
                        text: `Every preset is at most ${MAX_POINTS} skills: an account gets 3 skill points a rank, ${MAX_POINTS} by Global Elite.`,
                        blocks: [{ type: 'picker', grid: true, cols: 2, action: 'usePlan', items: PRESET_ORDER.map(p => ({ id: p, on: id === p, title: PRESETS[p].name, sub: PRESETS[p].sub, meta: presetLine(p) || undefined })) }, ...preview(SHORT)] },
                    { id: 'others', title: 'Skills outside the preset', done: true, summary: S('sellOthers') ? 'sold first, for half their price' : 'kept',
                        text: 'Selling them brings back half their price and their skill points, which can be what lets an account finish the preset.', keys: ['sellOthers'], blocks: preview(SHORT) },
                ],
                finish: { title: applying ? `Applying on ${plural(applying, 'account')}` : n ? 'Apply' : 'Choose accounts first', ready: !!n && !!canPay, next: 'Review', blocks: preview([0, 1, 2, 3, 4, 6, 9]),
                    text: n ? `An account only starts if it can finish all of ${PRESETS[id].name}: enough cash${S('sellOthers') ? ' (with what selling brings back)' : ''}, skill points and rank.${can}` : '',
                    buttons: n ? [{ label: applying ? `Applying on ${plural(applying, 'account')}…` : 'Apply', action: 'apply', primary: true, disabled: !!applying || (known.length === n && !canPay),
                        confirm: `Buy all of ${PRESETS[id].name} on the ${plural(canPay, 'account')} that can finish it?${S('sellOthers') ? ' Skills outside the preset are SOLD first (for half their price).' : ''}` }] : [] } },
                // What Apply would do, live: stays on the page so a change of preset or selling shows at once.
                ...(n ? [{ type: 'section', title: 'What Apply does', blocks: [
                    { type: 'text', text: 'Worked out from each account\'s skills and wallet now.' },
                    { type: 'table', columns: COLS, rows },
                ] }] : []),
                ...(fails.length ? [{ type: 'section', title: 'What went wrong', blocks: [{ type: 'log',
                    lines: fails.map(f => ({ t: new Date(f.t).toLocaleTimeString(), text: `[${f.name}] ${f.text}`, level: 'error' })) }] }] : []),
            ] };
        });
        // The account card's badge: how much of the chosen preset it has.
        ctx.panel.badge((aid) => { if (!ctx.settings.runsOn('accounts', aid)) return null; const f = affordOf(aid, preset()); return f ? `Skills ${f.total - f.missing}/${f.total}` : null; });
    },
    stop() { busy.clear(); },
    planOf, PLANS, T,   // for the tests
};
