// Missions: GET /api/missions -> [{ id, goal, duration, currentAmount, targetAmount, isRedeemable, redeemed, validTill }]
// claim = DELETE /api/missions { id }.

const latest = new Map();   // account id -> { at, list }
const claimedBy = new Map(); // account id -> missions claimed since start
let claimedTotal = 0;

// The site's goal codes in plain words (taken from the old hub's dashboard; an unknown code is shown split into words).
const GOALS = {
    clicks: 'Click', clickCases: 'Click cases', clickedCases: 'Click cases', collectVault: 'Collect the vault',
    openCases: 'Open cases', openCapsules: 'Open capsules', openKnifes: 'Open knives', openRedSkins: 'Open Covert (red) skins',
    winBlackjacks: 'Win blackjack hands', '21Blackjacks': 'Hit 21 in blackjack', winCoinflips: 'Win coinflips', loseCoinflips: 'Lose coinflips',
    winCrash: 'Win crash rounds', loseCrash: 'Lose crash rounds', winJackpots: 'Win jackpots', loseJackpots: 'Lose jackpots',
    winCasebattles: 'Win case battles', playUpgrades: 'Play upgrades', playGuessTheRank: 'Play Guess the Rank', doClassifiedTradeups: 'Do Classified trade-ups',
};
// What gets each goal done: the clicker by itself, one of the plugins, or playing by hand.
const BY = {
    clicks: 'clicking', clickCases: 'clicking', clickedCases: 'clicking', collectVault: 'clicking',
    openCases: 'Opener / Converter', openCapsules: 'Opener / Converter', openKnifes: 'Opener / Converter', openRedSkins: 'Opener / Converter',
    winBlackjacks: 'Games', '21Blackjacks': 'Games', winCrash: 'Games', loseCrash: 'Games',
    winCoinflips: 'Armory', loseCoinflips: 'Armory', winJackpots: 'Armory', loseJackpots: 'Armory', winCasebattles: 'Armory', playUpgrades: 'Armory', playGuessTheRank: 'Armory',
};
const byOf = (g) => BY[g] || 'by hand';
const goalName = (g) => GOALS[g] || String(g || 'Mission').replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
const RESETS = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
const left = (ms) => { if (!(ms > 0)) return '—'; const h = Math.floor(ms / 3600000); return h >= 48 ? `${Math.round(h / 24)} days` : h >= 1 ? `${h} h` : `${Math.max(1, Math.round(ms / 60000))} min`; };
const done = (x) => x.redeemed || x.isRedeemable || (x.currentAmount || 0) >= (x.targetAmount || 1);

module.exports = {
    start(ctx) {
        ctx.errors.define('CC-MISS-01', { group: 'manual', text: 'A mission couldn\'t be claimed.', fix: 'Nothing to do — it tries again on the next check.' });

        ctx.everyAccount(ctx.settings.get('checkEverySec') * 1000, async (acct) => {
            const r = await ctx.request(acct.id, '/api/missions');
            if (r.kind !== 'ok' || !Array.isArray(r.json)) return;
            let claimed = 0;
            for (const m of r.json.filter(x => x.isRedeemable && !x.redeemed)) {
                const c = await ctx.request(acct.id, '/api/missions', { method: 'DELETE', body: { id: m.id } });
                if (c.kind === 'ok') { claimed++; m.redeemed = true; m.isRedeemable = false; ctx.errors.clear(acct.id, 'CC-MISS-01'); }
                else if (c.kind === 'api') ctx.errors.raise(acct.id, 'CC-MISS-01', 'HTTP ' + c.status);
            }
            if (claimed) {
                claimedTotal += claimed; claimedBy.set(acct.id, (claimedBy.get(acct.id) || 0) + claimed);
                ctx.log('Claimed ' + claimed + ' mission' + (claimed === 1 ? '' : 's'), 'ok', acct.id);
            }
            latest.set(acct.id, { at: Date.now(), list: r.json });
        }, { what: 'Claim finished missions' });

        ctx.panel.badge((id) => {
            const m = latest.get(id);
            if (!m) return null;
            const open = m.list.filter(x => !x.redeemed);
            return open.length ? `Missions ${open.filter(x => x.currentAmount >= x.targetAmount).length}/${open.length} done` : 'Missions all claimed';
        });

        // One row per mission (same goal and reset) across the accounts, instead of every account's every mission.
        ctx.panel.tab('Missions', () => {
            const accts = ctx.accounts.list().filter(a => latest.has(a.id));
            const groups = new Map();
            for (const a of accts) {
                for (const x of latest.get(a.id).list) {
                    const k = x.goal + '|' + (x.duration || '');
                    const g = groups.get(k) || { goal: x.goal, duration: x.duration, accts: 0, done: 0, pct: [], till: Infinity };
                    g.accts++; if (done(x)) g.done++;
                    g.pct.push(Math.min(1, (x.currentAmount || 0) / (x.targetAmount || 1)));
                    const t = Date.parse(x.validTill); if (t) g.till = Math.min(g.till, t);
                    groups.set(k, g);
                }
            }
            const order = { daily: 0, weekly: 1, monthly: 2 };
            const list = [...groups.values()].sort((a, b) => (order[a.duration] ?? 9) - (order[b.duration] ?? 9) || (byOf(b.goal) === 'clicking') - (byOf(a.goal) === 'clicking') || goalName(a.goal).localeCompare(goalName(b.goal)));
            const median = (v) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] || 0; };
            const rows = list.map(g => [goalName(g.goal), [RESETS[g.duration] || g.duration, g.till < Infinity && 'in ' + left(g.till - Date.now())].filter(Boolean).join(' · ') || '—',
                g.done === g.accts ? `all ${g.accts}` : `${g.done} of ${g.accts}`, g.done === g.accts ? 'done' : `${Math.round(median(g.pct) * 100)}% (typical)`,
                byOf(g.goal)]);
            const open = [...latest.values()].reduce((n, m) => n + m.list.filter(x => !x.redeemed && !done(x)).length, 0);
            const perAcct = accts.map(a => { const l = latest.get(a.id).list; return [a.name, `${l.filter(done).length} of ${l.length}`, String(claimedBy.get(a.id) || 0)]; });
            return {
                blocks: [
                    { type: 'stats', items: [{ label: 'Claimed since start', value: claimedTotal.toLocaleString() }, { label: 'Still to do', value: open.toLocaleString() }, { label: 'Accounts checked', value: String(accts.length) }] },
                    rows.length ? { type: 'table', columns: ['Mission', 'Resets', 'Done on', 'Progress', 'Gets done by'], rows }
                        : { type: 'notice', text: 'Waiting for the first check on a clicking account.' },
                    ...(perAcct.length ? [{ type: 'card', id: 'per-account', open: false, title: 'Per account', summary: `${perAcct.length} account${perAcct.length === 1 ? '' : 's'}`,
                        blocks: [{ type: 'table', columns: ['Account', 'Missions done', 'Claimed since start'], rows: perAcct }] }] : []),
                    { type: 'card', id: 'schedule', open: false, title: 'Schedule', summary: `every ${ctx.settings.get('checkEverySec')} s`, keys: ['checkEverySec'] },
                ],
            };
        });

        ctx.on('stopped', (id) => latest.delete(id));
    },

    stop() { latest.clear(); claimedBy.clear(); },
};
