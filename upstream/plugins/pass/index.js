// Monthly pass: GET /api/monthlyPass -> { period, tier, totalTiers, isPremium, claimableFreeTiers: [2, 4],
// claimablePremiumTiers: [2, 3], claimedFreeTiers, claimedPremiumTiers, endsAt, ... }.
// Claim = POST /api/monthlyPass { tier, track: 'free' | 'premium' } -> { claimed: [{ tier, track, reward }], pass }.
// The Pro track ('premium') is only claimable on accounts with the Pro pass (isPremium). Buying or
// redeeming a Pro pass is never done here.

const GAP_MS = 300;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const latest = new Map();   // account id -> { at, pass, claimed: { free, premium } }
const busy = new Set();
const strikes = new Map();  // account id -> checks in a row with a refused claim (only 3+ in a row is a problem)
let totals = { free: 0, premium: 0 };

const tracksFor = (choice) => (choice === 'both' ? ['free', 'premium'] : choice === 'pro' ? ['premium'] : ['free']);
const claimable = (pass, track) => (track === 'premium' ? (pass.isPremium ? pass.claimablePremiumTiers : []) : pass.claimableFreeTiers) || [];

module.exports = {
    start(ctx) {
        ctx.errors.define('CC-PASS-01', { group: 'manual', text: 'A monthly pass tier couldn\'t be claimed.', fix: 'Nothing to do — it tries again on the next check.' });

        // At least a minute apart; everyMs (not in the manifest) is only for the tests.
        ctx.everyAccount(ctx.settings.get('everyMs') || Math.max(1, ctx.settings.get('checkEveryMin')) * 60000, async (acct) => {
            if (!ctx.settings.get('on') || !ctx.settings.runsOn('accounts', acct.id) || busy.has(acct.id)) return;
            busy.add(acct.id);
            const done = { free: 0, premium: 0 };
            let pass = null, refused = null;
            try {
                const r = await ctx.request(acct.id, '/api/monthlyPass');
                if (r.kind !== 'ok' || !r.json) return;
                pass = r.json;
                for (const track of tracksFor(ctx.settings.get('track'))) {
                    for (const tier of claimable(pass, track).filter(Number.isFinite)) {
                        if (!ctx.settings.get('on') || !ctx.settings.runsOn('accounts', acct.id)) break;
                        const c = await ctx.request(acct.id, '/api/monthlyPass', { method: 'POST', body: { tier, track } });
                        if (c.kind !== 'ok' || !c.json || c.json.error) {
                            if (c.kind === 'api' || (c.json && c.json.error)) refused = `tier ${tier} ${track}: ${(c.json && c.json.error) || 'HTTP ' + c.status}`;
                            break;   // don't hammer a failing claim; the next check tries again
                        }
                        done[track] += Array.isArray(c.json.claimed) ? c.json.claimed.length : 1;
                        if (c.json.pass) pass = { ...pass, ...c.json.pass };
                        await sleep(GAP_MS);
                    }
                }
            } finally {
                busy.delete(acct.id);
                if (pass) {
                    const n = refused ? (strikes.get(acct.id) || 0) + 1 : 0;
                    strikes.set(acct.id, n);
                    if (n >= 3) ctx.errors.raise(acct.id, 'CC-PASS-01', refused);
                    else if (!n) ctx.errors.clear(acct.id, 'CC-PASS-01');
                    const prev = latest.get(acct.id), before = prev && prev.claimed || { free: 0, premium: 0 };
                    latest.set(acct.id, { at: Date.now(), pass, claimed: { free: before.free + done.free, premium: before.premium + done.premium } });
                }
            }
            totals = { free: totals.free + done.free, premium: totals.premium + done.premium };
            const parts = [done.free && `${done.free} free`, done.premium && `${done.premium} Pro`].filter(Boolean);
            if (parts.length) ctx.log(`Claimed ${parts.join(' + ')} pass tier${done.free + done.premium === 1 ? '' : 's'}`, 'ok', acct.id);
        });

        ctx.panel.tab('Pass', () => {
            const chosen = ctx.accounts.list().filter(a => ctx.settings.runsOn('accounts', a.id));
            const wantPro = ctx.settings.get('track') !== 'free';
            const rows = chosen.map(a => {
                const m = latest.get(a.id), p = m && m.pass;
                const waiting = p ? tracksFor(ctx.settings.get('track')).reduce((n, t) => n + claimable(p, t).length, 0) : null;
                return [a.name, !a.running ? 'not clicking' : p ? `${p.tier ?? '—'} / ${p.totalTiers ?? '—'}` : 'waiting',
                    p ? (p.isPremium ? 'yes' : wantPro ? 'no — free only' : 'no') : '—',
                    m ? `${m.claimed.free} free · ${m.claimed.premium} Pro` : '—', waiting == null ? '—' : String(waiting)];
            });
            const n = chosen.length, track = { free: 'Free', pro: 'Pro', both: 'Free + Pro' }[ctx.settings.get('track')] || 'Free';
            const on = !!ctx.settings.get('on');
            return { blocks: [
                { type: 'card', id: 'power', toggle: 'on', open: false, title: on ? 'Monthly pass — on' : 'Monthly pass — off',
                    summary: !on ? 'not claiming' : n ? `claims ready tiers on ${n} account${n === 1 ? '' : 's'}` : 'choose accounts first' },
                { type: 'stats', items: [{ label: 'Free tiers claimed', value: totals.free.toLocaleString() }, { label: 'Pro tiers claimed', value: totals.premium.toLocaleString() }] },
                { type: 'card', id: 'accounts', open: !n, title: 'Accounts', summary: n ? `${n} account${n === 1 ? '' : 's'}` : 'none yet', keys: ['accounts'], bare: true,
                    blocks: n ? [{ type: 'table', columns: ['Account', 'Tier', 'Pro pass', 'Claimed', 'Ready now'], rows }] : [] },
                { type: 'card', id: 'claim', open: false, title: 'What to claim', summary: `${track} track${track === 'Free' ? '' : ' · Pro only on accounts with the Pro pass'} · every ${ctx.settings.get('checkEveryMin')} min`, keys: ['track', 'checkEveryMin'] },
            ] };
        });

        ctx.on('stopped', (id) => latest.delete(id));
    },

    stop() { latest.clear(); busy.clear(); totals = { free: 0, premium: 0 }; },
};
