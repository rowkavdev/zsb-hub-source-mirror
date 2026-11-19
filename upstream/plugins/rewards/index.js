// Rewards: GET /api/rewards -> { next<Chain>Reward: { reward: { id, rewardString }, isRedeemable }, ... } for every chain
// (rank, premier, clicks, vault, inventory value, ...). Claim = POST /api/rewards { id }, one tier at a time;
// the answer is the dropped skins [{ name, price, ... }] or {}. Claiming can unlock the next tier (drops raise
// inventory value), so it keeps going until nothing is ready.

// A refused claim is skipped for that check (the others are still claimed): the site refuses claims now and
// then, e.g. while the account is opening cases. Only STRIKES checks in a row with a refusal count as a problem.
const MAX_ROUNDS = 40, GAP_MS = 400, STRIKES = 3;
const short = (n) => '$' + (n >= 1e6 ? +(n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? +(n / 1e3).toFixed(1) + 'k' : Math.round(n));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const latest = new Map();   // account id -> { at, claimed, items, value, ready }
const busy = new Set();
const strikes = new Map();  // account id -> checks in a row with a refused claim
let totals = { claimed: 0, items: 0, value: 0 };

const readyOf = (json) => Object.entries(json || {}).filter(([k, x]) => /^next\w+Reward$/.test(k) && x && x.isRedeemable && x.reward && x.reward.id != null);

module.exports = {
    start(ctx) {
        ctx.errors.define('CC-RWD-01', { group: 'manual', text: 'A reward couldn\'t be claimed.', fix: 'Nothing to do — it tries again on the next check.' });

        // At least a minute apart; everyMs (not in the manifest) is only for the tests.
        ctx.everyAccount(ctx.settings.get('everyMs') || Math.max(1, ctx.settings.get('checkEveryMin')) * 60000, async (acct) => {
            if (!ctx.settings.get('on') || !ctx.settings.runsOn('accounts', acct.id) || busy.has(acct.id)) return;
            busy.add(acct.id);
            const run = { at: Date.now(), claimed: 0, items: 0, value: 0, ready: 0 };
            const skipped = new Map();   // reward id -> why it was refused this check
            try {
                for (let round = 0; round < MAX_ROUNDS; round++) {
                    const r = await ctx.request(acct.id, '/api/rewards');
                    if (r.kind !== 'ok') break;
                    const ready = readyOf(r.json).filter(([, x]) => !skipped.has(x.reward.id));
                    run.ready = ready.length;
                    if (!ready.length || !ctx.settings.get('on') || !ctx.settings.runsOn('accounts', acct.id)) break;
                    let stop = false;
                    for (const [, x] of ready) {
                        const c = await ctx.request(acct.id, '/api/rewards', { method: 'POST', body: { id: x.reward.id } });
                        if (c.kind === 'api') { skipped.set(x.reward.id, (c.json && c.json.error) || 'HTTP ' + c.status); await sleep(GAP_MS); continue; }
                        if (c.kind !== 'ok') { stop = true; break; }   // network, logged out, not clicking: the next check
                        run.claimed++;
                        for (const s of Array.isArray(c.json) ? c.json : []) { run.items++; run.value += Number(s.price) || 0; }
                        await sleep(GAP_MS);
                    }
                    if (stop) break;
                }
            } finally { busy.delete(acct.id); }
            const n = skipped.size ? (strikes.get(acct.id) || 0) + 1 : 0;
            strikes.set(acct.id, n);
            if (n >= STRIKES) ctx.errors.raise(acct.id, 'CC-RWD-01', [...skipped.values()][0]);
            else if (!n) ctx.errors.clear(acct.id, 'CC-RWD-01');
            const prev = latest.get(acct.id);
            latest.set(acct.id, { ...run, claimed: (prev ? prev.claimed : 0) + run.claimed, items: (prev ? prev.items : 0) + run.items, value: (prev ? prev.value : 0) + run.value });
            totals = { claimed: totals.claimed + run.claimed, items: totals.items + run.items, value: totals.value + run.value };
            if (run.claimed) ctx.log(`Claimed ${run.claimed} reward tier${run.claimed === 1 ? '' : 's'}${run.items ? `, ${run.items} item${run.items === 1 ? '' : 's'} worth $${Math.round(run.value).toLocaleString()}` : ''}`, 'ok', acct.id);
        }, { what: 'Claim ready rewards', only: (aid) => !!ctx.settings.get('on') && ctx.settings.runsOn('accounts', aid) });

        ctx.panel.tab('Rewards', () => {
            const chosen = ctx.accounts.list().filter(a => ctx.settings.runsOn('accounts', a.id));
            const rows = chosen.map(a => {
                const m = latest.get(a.id);
                return [a.name, !a.running ? 'not clicking' : m ? new Date(m.at).toLocaleTimeString() : 'waiting', m ? m.claimed.toLocaleString() : '0',
                    m ? m.items.toLocaleString() : '0', m ? '$' + Math.round(m.value).toLocaleString() : '$0'];
            });
            const n = chosen.length, on = !!ctx.settings.get('on');
            // The account pills: reward tiers ready at the last check, and what's been claimed.
            const accountLines = Object.fromEntries(ctx.accounts.list().map(a => { const m = latest.get(a.id);
                if (!m) return [a.id, ['Rewards not read yet', ctx.settings.runsOn('accounts', a.id) ? 'Checks soon' : 'Read once chosen']];
                return [a.id, [m.ready ? `${m.ready} tier${m.ready === 1 ? '' : 's'} ready` : 'Nothing ready', `${m.claimed.toLocaleString()} claimed · ${short(m.value)}`]]; }));
            return { accountLines, blocks: [
                { type: 'card', id: 'power', toggle: 'on', open: false, title: on ? 'Rewards — on' : 'Rewards — off',
                    summary: !on ? 'not claiming' : n ? `claims ready tiers on ${n} account${n === 1 ? '' : 's'}` : 'choose accounts first' },
                { type: 'stats', items: [{ label: 'Tiers claimed', value: totals.claimed.toLocaleString() }, { label: 'Items', value: totals.items.toLocaleString() }, { label: 'Item value', value: '$' + Math.round(totals.value).toLocaleString() }] },
                { type: 'card', id: 'accounts', open: !n, title: 'Accounts', summary: n ? `${n} account${n === 1 ? '' : 's'}` : 'none yet', keys: ['accounts'], bare: true,
                    blocks: n ? [{ type: 'table', columns: ['Account', 'Last check', 'Tiers', 'Items', 'Value'], rows }] : [] },
                { type: 'card', id: 'schedule', open: false, title: 'Schedule', summary: `every ${ctx.settings.get('checkEveryMin')} min`, keys: ['checkEveryMin'] },
            ] };
        });

        ctx.on('stopped', (id) => latest.delete(id));
    },

    stop() { latest.clear(); busy.clear(); totals = { claimed: 0, items: 0, value: 0 }; },
};
