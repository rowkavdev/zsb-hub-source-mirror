// ZSB Hub panel. Runs in the app window (window.clicker from the preload) or in a browser (HTTP /rpc).
// Polls state() and redraws; buttons carry data-act and are handled in one place.
// All wording comes from text/en.json (T / H below) — edit it with `npm run text`.
(() => {
    'use strict';

    const web = !window.clicker;
    const call = web
        // location.origin, not '/rpc': a relative URL inherits user:pass@ from the address bar and fetch refuses it.
        ? (method, ...args) => fetch(location.origin + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) }).then(r => r.json())
        : window.clicker.call;

    const $ = (s) => document.querySelector(s);
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // --- text ------------------------------------------------------------------
    // T: plain text with {vars} filled in. H: the same, escaped for HTML, with **bold** turned on.
    let TX = {};
    const T = (key, vars) => (TX[key] ?? key).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
    const H = (key, vars) => esc(T(key, vars)).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Text written into index.html: data-t (text), data-t-title (hover), data-t-label (screen readers).
    function applyStaticText() {
        document.querySelectorAll('[data-t]').forEach(n => { n.textContent = T(n.dataset.t); });
        document.querySelectorAll('[data-t-title]').forEach(n => { n.title = T(n.dataset.tTitle); });
    }

    const num = (n) => (n == null ? '—' : Math.abs(n) >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : Math.round(n).toLocaleString());
    const money = (n) => (n == null ? '—' : '$' + num(n));
    // Premier rating colours, as the site has them (its premier rank table, read 2026-11-11): grey, light blue,
    // blue, purple, pink, red, then gold from 30,000 up.
    const PREMIER = [[30000, '255, 215, 0'], [25000, '235, 74, 73'], [20000, '226, 20, 240'], [15000, '189, 107, 253'], [10000, '104, 125, 233'], [5000, '137, 187, 230'], [0, '184, 199, 215']];
    const premierColor = (n) => PREMIER.find(([min]) => n >= min)[1];
    const ago = (t) => { if (!t) return T('time.never'); const s = Math.round((Date.now() - t) / 1000); return s < 60 ? T('time.s', { n: s }) : s < 3600 ? T('time.m', { n: Math.round(s / 60) }) : T('time.h', { n: Math.round(s / 3600) }); };

    let S = null, tab = 'accounts', logSince = 0, logLines = [];
    // The text studio previews the app window's wording (?studio&app), even though it runs in a browser.
    const webLook = web && !/[?&]app/.test(location.search);

    // --- toast + modal ---------------------------------------------------
    let toastTimer = null;
    function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500); }

    // html: an already-escaped body. cancel: false = a single OK button (for notices).
    function modal({ title, body = '', html = '', input = null, ok = 'OK', danger = false, cancel = true, wide = false }) {
        return new Promise((resolve) => {
            const m = $('#modal'), box = m.querySelector('.modal-box');
            box.classList.toggle('wide', wide);
            box.onchange = box.oninput = null;
            box.innerHTML = `<h3>${esc(title)}</h3>${body ? `<div class="muted">${esc(body)}</div>` : ''}${html}${input != null ? `<input id="modalInput" maxlength="40" value="${esc(input)}">` : ''}
                <div class="btns">${cancel ? `<button data-m="cancel">${H('modal.cancel')}</button>` : ''}<button data-m="ok" class="${danger ? 'danger' : 'primary'}">${esc(ok)}</button></div>`;
            m.hidden = false;
            const inp = box.querySelector('#modalInput');
            if (inp) { inp.focus(); inp.select(); }
            const done = (v) => { m.hidden = true; box.innerHTML = ''; document.removeEventListener('keydown', key); resolve(v); };
            const key = (e) => {
                if (e.key === 'Escape') done(null);
                // In a plugin's settings, Enter just finishes the field (blur saves it) instead of closing.
                else if (e.key === 'Enter' && e.target.closest && e.target.closest('.psets')) e.target.blur();
                else if (e.key === 'Enter' && e.target.tagName === 'TEXTAREA') return;
                else if (e.key === 'Enter') done(inp ? inp.value : true);
            };
            document.addEventListener('keydown', key);
            box.onclick = (e) => { const b = e.target.closest('[data-m]'); if (b) done(b.dataset.m === 'ok' ? (inp ? inp.value : true) : null); };
            m.onclick = (e) => { if (e.target === m) done(null); };
        });
    }

    const MODALS = {
        rename: (name) => modal({ title: T('modal.rename.title'), input: name || '', ok: T('modal.rename.ok') }),
        remove: (name) => modal({ title: T('modal.remove.title', { name: name || T('modal.remove.unnamed') }), body: T('modal.remove.body'), ok: T('modal.remove.ok'), danger: true }),
        quit: () => modal({ title: T('modal.quit.title'), body: T('modal.quit.body'), ok: T('modal.quit.ok'), danger: true }),
        whatsnew: (entries) => modal({ title: T('whatsnew.title'), html: whatsNewHtml(entries), ok: T('whatsnew.ok'), cancel: false }),
    };

    // The main account: required before anything clicks. Picked from the hub's accounts, or pasted (user id / profile link).
    async function setMainModal() {
        const cur = S.settings.main;
        let pick = { account: cur && cur.userId ? (cur.account || '') : (S.accounts[0] ? S.accounts[0].id : ''), text: cur && cur.userId && !cur.account ? cur.userId : '' };
        const html = `<div class="muted">${H('main.body')}</div>
            <label class="mfield"><span>${H('main.pick')}</span><select id="mainAcct"><option value="">${H('main.notHere')}</option>${S.accounts.map(a => `<option value="${esc(a.id)}"${a.id === pick.account ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
            <label class="mfield"><span>${H('main.paste')}</span><input id="mainText" placeholder="${H('main.paste.placeholder')}" value="${esc(pick.text)}"></label>`;
        const p = modal({ title: T('main.title'), html, ok: T('main.save') });
        const box = $('#modal .modal-box');
        const sync = () => { pick = { account: box.querySelector('#mainAcct').value, text: box.querySelector('#mainText').value }; box.querySelector('#mainText').closest('label').hidden = !!pick.account; };
        sync();
        box.oninput = box.onchange = sync;
        if (!(await p)) return;
        const r = await call('setMain', pick.account ? { account: pick.account } : { text: pick.text });
        if (r && r.ok) toast(T('main.saved', { name: r.name }));
        else { toast((r && r.error) || T('main.bad')); }
    }

    // What's new: the lines are written per release (text/whats-new.json), **bold** allowed.
    const rich = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    function whatsNewHtml(entries) {
        if (!entries || !entries.length) return `<div class="muted">${H('whatsnew.empty')}</div>`;
        return `<div class="whatsnew">${entries.map(e => `<div class="wn-version">${H('whatsnew.version', { version: e.version })}</div>
            <ul>${e.items.map(i => `<li>${rich(i)}</li>`).join('')}</ul>`).join('')}</div>`;
    }
    // Settings > See what's sent: the usage-stats report exactly as it would go now.
    async function showStats() {
        const s = await call('statsReport');
        const status = !s.enabled ? H('modal.stats.off') : !s.last ? H('modal.stats.never')
            : s.last.ok ? H('modal.stats.last', { ago: ago(s.last.at) }) : H('modal.stats.failed', { ago: ago(s.last.at) });
        await modal({ title: T('modal.stats.title'), html: `<div class="muted">${status}</div><pre class="stats-json">${esc(JSON.stringify(s.report, null, 2))}</pre>`,
            ok: T('modal.stats.ok'), cancel: false });
    }
    async function showWhatsNew(all) {
        const entries = await call('whatsNew', !!all);
        await MODALS.whatsnew(entries);
        if (!all) call('whatsNewSeen');
    }

    // --- header, banners, tabs -----------------------------------------
    function drawHeader() {
        // In beta: "Beta 1.0" (a .0 patch is left off); after that just the version.
        const tb = /^(\d+\.\d+\.\d+)-\w+\.(\d+)$/.exec(S.version);   // a test build: 1.0.4-beta.2
        $('#version').textContent = tb ? T('app.testBuild', { version: tb[1], n: tb[2] })
            : S.stage ? T('app.stage', { version: S.version.replace(/\.0$/, '') }) : 'v' + S.version;
        const t = S.totals;
        setHtml('#summary', `<span class="kpi">${H('header.kpi.clicking', { n: t.clicking, max: S.capacity || S.maxPerIp })}<span class="mini"><i data-w="${Math.min(100, Math.round(S.running / (S.capacity || S.maxPerIp) * 100))}"></i></span></span>`
            + (t.total ? `<button class="kpi kpi-btn" data-act="incomeChart" title="${H('income.open')}">${H('header.kpi.income', { money: money(t.total) })}</button>` : '')
            + (S.accounts.length > t.clicking ? `<span class="kpi">${H('header.kpi.idle', { n: S.accounts.length - t.clicking })}</span>` : '')
            + (S.update && S.update.status === 'ready' ? `<span class="kpi update">${H('update.ready', { version: S.update.version })}<button class="small primary" data-act="installUpdate">${H('update.restart')}</button></span>` : ''));
        $('#startAll').disabled = !S.accounts.some(a => !a.startedAt && a.hasToken);
        $('#stopAll').disabled = !S.running;
    }

    // Only touch the DOM when the markup really changed: rebuilding it every refresh drops hovers and clicks.
    let lastHtml = new WeakMap();   // element -> markup; weak, so removed cards and dialogs are not kept alive by it
    function setHtml(sel, html, el) {
        el = el || $(sel);
        if (lastHtml.get(el) === html) return;
        lastHtml.set(el, html);
        el.innerHTML = html;
        el.querySelectorAll('[data-w]').forEach(i => { i.style.width = i.dataset.w + '%'; });   // CSSOM: the CSP blocks inline styles
    }

    // An error code's wording: from the text table (so edits show live), else what the app sent (plugin codes).
    const issueText = (i) => TX[`error.${i.code}.text`] ? T(`error.${i.code}.text`) : i.text;
    const issueFix = (i) => TX[`error.${i.code}.fix`] ? T(`error.${i.code}.fix`) : i.fix;

    function issueAction(i) {
        if (i.code === 'CC-CF-01') return `<button class="small primary" data-act="openCheck" data-route="${esc(i.acct && i.acct.startsWith('route:') ? i.acct.slice(6) : 'direct')}">${H('card.cf.open')}</button>`;
        if (i.code === 'CC-MAIN-01') return `<button class="small primary" data-act="setMain">${H('main.set')}</button>`;
        if (i.code === 'CC-AUTH-02') return `<button class="small" data-act="add">${H('issue.addAccount')}</button>`;
        if (i.acct && i.acct.startsWith('plugin:')) return `<button class="small" data-act="tab" data-tab="plugins">${H('issue.plugins')}</button>`;
        if (i.code === 'CC-AUTH-05' || i.code === 'CC-AUTH-06') return `<button class="small" data-act="trouble" data-view="sessions" data-id="${esc(i.acct || '')}">${H('issue.sessions')}</button>`;
        if (i.code === 'CC-SLOW-01') return `<button class="small" data-act="trouble" data-view="clicks">${H('issue.clicks')}</button>`;
        return '';
    }

    // An account import: progress while it signs accounts in, then what came of it (until dismissed).
    function importBanner() {
        const j = S.importJob;
        if (!j) return '';
        const failed = j.failed.length ? `<div class="muted">${H('import.failed')} ${j.failed.slice(0, 6).map(f => `${esc(f.email)} (${esc(f.why)})`).join(' · ')}${j.failed.length > 6 ? ' …' : ''}</div>` : '';
        return j.running
            ? `<div class="banner"><div class="text"><b>${H('import.progress', { done: j.done, total: j.total })}</b> ${j.current ? `<span class="muted">${H('import.current', { email: esc(j.current) })}</span>` : ''}${failed}</div>${j.stopping ? `<button class="small" disabled>${H('import.stopping')}</button>` : `<button class="small" data-act="importStop">${H('import.stop')}</button>`}</div>`
            : `<div class="banner"><div class="text"><b>${H('import.done', { ok: j.ok, total: j.total })}</b>${failed}</div><button class="small" data-act="importDismiss">${H('import.dismiss')}</button></div>`;
    }

    function drawBanners() {
        setHtml('#banners', importBanner() + S.appIssues.map(i => `
            <div class="banner${i.code === 'CC-MAIN-01' ? '' : ' closable'} ${i.code === 'CC-CF-01' || i.code === 'CC-SITE-02' || i.code === 'CC-MAIN-01' || /^CC-PROXY-/.test(i.code) ? 'warn' : 'bad'}">
              <span class="code">${esc(i.code)}</span>
              <div class="text"><b>${esc(issueText(i))}</b> <span class="muted">${esc(issueFix(i))}</span>${i.detail ? `<div class="muted">${esc(i.detail)}</div>` : ''}</div>
              ${issueAction(i)}
              ${i.code === 'CC-MAIN-01' ? '' : `<button class="small ghost close-x" data-act="dismissIssue" data-acct="${esc(i.acct || '')}" data-code="${esc(i.code)}" title="${H('banner.close')}" aria-label="${H('banner.close')}">×</button>`}
            </div>`).join(''));
    }

    // Plugin tabs sit in a few drop-down groups so the bar stays short. A plugin can name its own (manifest.group);
    // these are the defaults for the known ones. A group with a single tab shows as a plain tab.
    const TAB_GROUPS = { armory: 'farming', games: 'farming', opener: 'farming', pass: 'farming', rewards: 'farming', missions: 'farming', skillmaps: 'farming',
        converter: 'trading', trader: 'trading' };
    let openGroup = null;
    function placeTabMenu(m) {
        m.style.left = '';
        const r = m.getBoundingClientRect(), over = r.right - (document.documentElement.clientWidth - 8);
        if (over > 0) m.style.left = -Math.min(over, r.left - 8) + 'px';
    }
    function drawTabs() {
        const bad = S.accounts.filter(a => a.status === 'logged-out' || a.status === 'problem' || a.status === 'needs-you').length;
        const plugBad = S.plugins.filter(p => p.state === 'error').length;
        const ptabs = S.tabs.map(t => ({ id: 'plugin:' + t.plugin + ':' + t.title, label: t.title, group: t.group || TAB_GROUPS[t.plugin] || 'more' }));
        const all = [['accounts', T('tabs.accounts'), bad], ['overview', T('tabs.overview'), 0], ['plugins', T('tabs.plugins'), plugBad], ...ptabs.map(t => [t.id, t.label, 0]), ['log', T('tabs.log'), 0], ['settings', T('tabs.settings'), 0]];
        if (tab.startsWith('plugin:') && !all.some(t => t[0] === tab)) tab = 'accounts';
        const one = ([id, label, n]) => `<button role="tab" data-act="tab" data-tab="${esc(id)}" aria-selected="${id === tab}">${esc(label)}${n ? `<span class="count">${n}</span>` : ''}</button>`;
        const groups = new Map();
        for (const t of ptabs) groups.set(t.group, [...(groups.get(t.group) || []), t]);
        if (openGroup && !(groups.get(openGroup) || []).length) openGroup = null;
        const groupHtml = [...groups].map(([g, list]) => {
            if (list.length === 1) return one([list[0].id, list[0].label, 0]);
            const cur = list.find(t => t.id === tab);
            const name = T('tabs.group.' + g) !== 'tabs.group.' + g ? T('tabs.group.' + g) : g;
            return `<span class="tab-group">
              <button role="tab" data-act="tabGroup" data-group="${esc(g)}" aria-haspopup="true" aria-expanded="${openGroup === g}" aria-selected="${!!cur}">${esc(name)}${cur ? `<span class="tg-cur">· ${esc(cur.label)}</span>` : ''}<span class="caret" aria-hidden="true">▾</span></button>
              <div class="menu tab-menu"${openGroup === g ? '' : ' hidden'}>${list.map(t => `<button data-act="tab" data-tab="${esc(t.id)}"${t.id === tab ? ' class="on"' : ''}>${esc(t.label)}</button>`).join('')}</div>
            </span>`;
        }).join('');
        const html = one(all[0]) + one(all[1]) + one(all[2]) + groupHtml + one(all[all.length - 2]) + one(all[all.length - 1]);
        setHtml('#tabs', html);
        const openMenu = $('#tabs .tab-menu:not([hidden])');
        if (openMenu) placeTabMenu(openMenu);
        for (const s of ['accounts', 'overview', 'plugins', 'log', 'settings']) $('#tab-' + s).hidden = tab !== s;
        $('#tab-plugin').hidden = !tab.startsWith('plugin:');
    }

    // --- overview ----------------------------------------------------------
    // Totals over every account, from each one's last /api/me report (an account that isn't clicking keeps what it
    // had when it last reported). The accounts table sorts by any column.
    let ovSort = { key: 'networth', dir: -1 };
    function drawOverview() {
        const acc = S.accounts, me = (a) => a.me || {};
        if (!acc.length) { setHtml('#tab-overview', `<div class="muted">${H('overview.empty')}</div>`); return; }
        const sum = (list, f) => list.reduce((s, a) => s + (Number(f(a)) || 0), 0);
        const has = (list, f) => list.some(a => f(a) != null);
        const total = (list, f, fmt) => (has(list, f) ? fmt(sum(list, f)) : '—');
        const income = (a) => (a.perHour ? a.perHour.total : null);
        const clicking = acc.filter(a => a.startedAt).length, pro = acc.filter(a => me(a).membership === 'pro').length;
        const tile = (label, value, sub) => `<div class="stat"><span>${H(label)}</span><b>${esc(value)}</b>${sub ? `<small class="muted">${esc(sub)}</small>` : ''}</div>`;
        const tiles = `<div class="statrow ov-stats">
            ${tile('overview.accounts', `${clicking} / ${acc.length}`, T('overview.accounts.sub'))}
            ${tile('overview.income', has(acc, income) ? '≈ ' + money(sum(acc, income)) : '—', T('overview.income.sub'))}
            ${tile('overview.money', total(acc, a => me(a).money, money))}
            ${tile('overview.tokens', total(acc, a => me(a).tokens, num))}
            ${tile('overview.networth', total(acc, a => me(a).networth, money))}
            ${tile('overview.premier', total(acc, a => me(a).premier, num), T('overview.premier.sub'))}
            ${tile('overview.pro', `${pro} / ${acc.length}`)}
          </div>`;
        const table = (head, rows, sortable) => `<div class="table-wrap"><table class="ov-table"><thead><tr>${head.map(([k, label, numCol]) => sortable
                ? `<th${numCol ? ' class="n"' : ''}><button class="ov-sort${ovSort.key === k ? ' on' : ''}" data-act="ovSort" data-key="${esc(k)}">${esc(label)}${ovSort.key === k ? (ovSort.dir < 0 ? ' ↓' : ' ↑') : ''}</button></th>`
                : `<th${numCol ? ' class="n"' : ''}>${esc(label)}</th>`).join('')}</tr></thead>
            <tbody>${rows.map(r => `<tr>${r.map((v, i) => `<td${head[i][2] ? ' class="n"' : ''}>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
        // By folder (only when there are folders).
        const folders = (S.folders || []).filter(f => acc.some(a => a.folder === f.id));
        const byFolder = folders.length ? [...folders.map(f => [f.name, acc.filter(a => a.folder === f.id)]), [T('folders.none'), acc.filter(a => !a.folder)]].filter(([, l]) => l.length) : [];
        const folderHtml = byFolder.length ? `<h4 class="plug-head">${H('overview.byFolder')}</h4>` + table(
            [['', T('overview.col.folder')], ['', T('overview.col.accounts'), 1], ['', T('overview.col.income'), 1], ['', T('overview.col.money'), 1], ['', T('overview.col.tokens'), 1], ['', T('overview.col.networth'), 1], ['', T('overview.col.premier'), 1]],
            byFolder.map(([name, l]) => [name, `${l.filter(a => a.startedAt).length} / ${l.length}`, has(l, income) ? money(sum(l, income)) : '—',
                total(l, a => me(a).money, money), total(l, a => me(a).tokens, num), total(l, a => me(a).networth, money), total(l, a => me(a).premier, num)])) : '';
        // Ranks, highest first.
        const ranks = new Map();
        for (const a of acc) { const r = me(a).rank; const k = r && r.name ? r.name : T('overview.rank.unknown'); const e = ranks.get(k) || { id: r && r.id != null ? r.id : -1, n: 0 }; e.n++; ranks.set(k, e); }
        const rankHtml = `<h4 class="plug-head">${H('overview.ranks')}</h4><div class="ov-ranks">${[...ranks].sort((x, y) => y[1].id - x[1].id)
            .map(([name, e]) => `<span class="ov-rank"><b>${e.n}</b> ${esc(name)}</span>`).join('')}</div>`;
        // Every account.
        const folderName = (id) => { const f = (S.folders || []).find(x => x.id === id); return f ? f.name : ''; };
        const cols = [['name', T('overview.col.account')], ...(folders.length ? [['folder', T('overview.col.folder')]] : []), ['status', T('overview.col.status')],
            ['income', T('overview.col.income'), 1], ['money', T('overview.col.money'), 1], ['tokens', T('overview.col.tokens'), 1], ['networth', T('overview.col.networth'), 1], ['premier', T('overview.col.premier'), 1],
            ['rank', T('overview.col.rank')], ['pro', T('overview.col.membership')]];
        const val = {
            name: (a) => String(a.name || a.id).toLowerCase(), folder: (a) => folderName(a.folder).toLowerCase(), status: (a) => a.status,
            income, money: (a) => me(a).money, tokens: (a) => me(a).tokens, networth: (a) => me(a).networth, premier: (a) => me(a).premier,
            rank: (a) => (me(a).rank ? me(a).rank.id : null), pro: (a) => (me(a).membership === 'pro' ? 1 : 0),
        };
        const get = val[ovSort.key] || val.networth;
        const sorted = [...acc].sort((x, y) => {
            const a = get(x), b = get(y);
            if (a == null && b == null) return 0; if (a == null) return 1; if (b == null) return -1;
            return (typeof a === 'string' ? a.localeCompare(b) : a - b) * ovSort.dir;
        });
        const rows = sorted.map(a => [a.name || a.id, ...(folders.length ? [folderName(a.folder) || '—'] : []), T('status.' + a.status),
            income(a) == null ? '—' : money(income(a)), money(me(a).money), num(me(a).tokens), money(me(a).networth), me(a).premier == null ? '—' : Math.round(me(a).premier).toLocaleString(),
            me(a).rank && me(a).rank.name ? me(a).rank.name : '—', me(a).membership === 'pro' ? T('overview.pro.yes') : me(a).membership ? T('overview.pro.no') : '—']);
        setHtml('#tab-overview', `${tiles}${folderHtml}${rankHtml}<h4 class="plug-head">${H('overview.all')}</h4>${table(cols, rows, true)}<p class="muted ov-note">${H('overview.note')}</p>`);
    }

    // --- accounts ----------------------------------------------------------
    // Each card is built once and then updated in place, so the live bars move smoothly and a
    // refresh never swallows a click or closes a menu.
    const cards = new Map();   // id -> { el, f: { field: element }, a: latest view }
    let clockOffset = 0;       // server time minus this device's time (a phone's clock may differ)
    const now = () => Date.now() + clockOffset;

    const secs = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return s >= 60 ? Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's' : s + 's'; };
    const setText = (n, v) => { v = String(v); if (n.textContent !== v) n.textContent = v; };

    function newCard(id) {
        const el = document.createElement('article');
        el.className = 'card';
        el.dataset.id = id;
        el.innerHTML = `
          <header class="c-head">
            <button class="icon-btn grip" data-grip="card" data-id="${id}" aria-label="${H('folders.grip.card')}" title="${H('folders.grip.tip')}"><svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg></button>
            <div class="c-title"><div class="name" data-f="name"></div></div>
            <span class="premier" data-f="premier" hidden></span>
            <span class="chip" data-f="chip"></span>
            <button class="icon-btn" data-act="menu" data-id="${id}" aria-label="${H('card.menu.label')}" title="${H('card.menu.tip')}">⋯</button>
          </header>
          <div class="hero"><div class="hero-num" data-f="hero"></div><div class="hero-label" data-f="heroLabel"></div></div>
          <div class="meters">
            <div class="meter-row"><span>${H('card.next')}</span><span data-f="nextTxt"></span></div>
            <div class="bar"><i data-f="nextBar"></i></div>
            <div class="meter-row"><span data-f="vaultLabel">${H('card.vault')}</span><span data-f="vaultTxt"></span></div>
            <div class="bar vault" title="${H('card.vault.tip')}"><i data-f="vaultBar"></i><b class="mark"></b></div>
          </div>
          <dl class="kv">
            <div><dt>${H('card.kv.balance')}</dt><dd data-f="money"></dd></div>
            <div><dt>${H('card.kv.tokens')}</dt><dd data-f="tokens"></dd></div>
            <div><dt>${H('card.kv.clicks')}</dt><dd data-f="clicks"></dd></div>
            <div><dt>${H('card.kv.caseClick')}</dt><dd data-f="cpc"></dd></div>
            <div><dt>${H('card.kv.perClick')}</dt><dd data-f="mpc"></dd></div>
            <div><dt>${H('card.kv.clicking')}</dt><dd data-f="ctype"></dd></div>
          </dl>
          <div class="badges" data-f="badges"></div>
          <div class="issues" data-f="issues"></div>
          <footer class="c-foot">
            <div class="seg" role="group" aria-label="${H('card.type.label')}">
              <button data-act="type" data-id="${id}" data-type="auto" data-f="segAuto" title="${H('card.type.auto.tip')}">${H('card.type.auto')}</button>
              <button data-act="type" data-id="${id}" data-type="money" data-f="segMoney">${H('card.type.money')}</button>
              <button data-act="type" data-id="${id}" data-type="cases" data-f="segCases">${H('card.type.cases')}</button>
            </div>
            <span class="grow"></span>
            <button data-f="main" data-id="${id}"></button>
          </footer>
          <div class="menu" data-f="menu" hidden>
            <button data-act="rename" data-id="${id}">${H('card.menu.rename')}</button>
            <button data-act="relogin" data-id="${id}">${H('card.menu.relogin')}</button>
            <button data-act="moveTo" data-id="${id}">${H('card.menu.folder')}</button>
            <button data-act="busyTest" data-id="${id}" data-f="menuBusy" title="${esc(T('busy.tip'))}">${H('card.menu.busy')}</button>
            <button data-act="remove" data-id="${id}" class="danger">${H('card.menu.remove')}</button>
          </div>`;
        const f = {};
        el.querySelectorAll('[data-f]').forEach(n => { f[n.dataset.f] = n; });
        return { el, f, a: null };
    }

    const BUSY_CODES = new Set(['CC-AUTH-05', 'CC-AUTH-07', 'CC-SLOW-01']);
    const busyWhy = (r) => T('busy.why.' + ((r && r.why) || 'unhealthy'), { what: (r && r.what) || '' });
    function issueHtml(a) {
        const list = a.issues.map(i => `
            <div class="issue ${i.code === 'CC-CF-01' || i.code === 'CC-AUTH-05' || i.code === 'CC-AUTH-06' ? 'warn' : ''}">
              <div><span class="code">${esc(i.code)}</span> ${esc(issueText(i))}${(i.code === 'CC-AUTH-06' || i.code === 'CC-AUTH-08') && i.detail ? ` <span class="muted">${esc(i.detail)}</span>` : ''}</div>
              <div class="fix">${esc(issueFix(i))}</div>
              ${i.code === 'CC-AUTH-08' ? `<div class="issue-btns"><button class="small danger" data-act="remove" data-id="${esc(a.id)}">${H('issue.removeDupe')}</button></div>` : ''}
              ${i.code === 'CC-AUTH-05' || i.code === 'CC-AUTH-06' || i.code === 'CC-AUTH-07' || i.code === 'CC-SLOW-01' ? `<div class="issue-btns">${issueAction({ code: i.code, acct: a.id })}${BUSY_CODES.has(i.code) && !a.test && a.startedAt ? ` <button class="small" data-act="busyTest" data-id="${esc(a.id)}" title="${esc(T('busy.tip'))}">${H(i.code === 'CC-AUTH-07' ? 'busy.again' : 'busy.btn')}</button>` : ''}</div>` : ''}
            </div>`);
        if (a.test) list.unshift(`<div class="issue warn"><div><b>${H('busy.running')}</b></div><div class="fix">${H('busy.running.desc')}</div><div><button class="small" data-act="busyStop" data-id="${esc(a.id)}">${H('busy.stop')}</button></div></div>`);
        if (a.status === 'needs-you') list.unshift(`<div class="issue warn"><div><span class="code">CC-CF-01</span> ${H('card.cf.waiting')}</div><div><button class="small primary" data-act="openCheck" data-route="${esc(a.route || 'direct')}">${H('card.cf.open')}</button></div></div>`);
        return list.join('');
    }

    function updateCard(c, a) {
        const f = c.f, running = !!a.startedAt, me = a.me, ph = a.perHour;
        c.a = a;
        c.el.className = 'card s-' + a.status + (running ? '' : ' off');
        setText(f.name, a.name);
        f.name.title = a.name;
        setText(f.vaultLabel, a.vaultEveryMin ? T('card.vault.every', { min: Math.round(a.vaultEveryMin) }) : T('card.vault'));
        f.chip.className = 'chip ' + a.status;
        setText(f.chip, TX['status.' + a.status] ? T('status.' + a.status) : a.status);

        // The big number: what this account makes per hour, from its own rates.
        // Not clicking: say what's going on instead of empty numbers.
        let hero = a.status === 'logged-out' ? T('card.hero.loggedOut') : T('card.hero.stopped'), unit = '',
            label = a.status === 'logged-out' ? T('card.label.loggedOut') : T('card.label.stopped', { ago: ago(a.lastClickOkAt) });
        if (running && !ph) { hero = '…'; label = T('card.label.waiting'); }
        else if (running) {
            hero = money(ph.total); unit = T('card.hero.unit');
            label = a.clickType === 'cases'
                ? T(ph.caseValueMeasured ? 'card.label.cases' : 'card.label.casesEst', { cases: num(ph.cases), value: '$' + ph.caseValue.toFixed(2), vault: money(ph.vault) })
                : T('card.label.money', { clicks: money(ph.clickMoney), vault: money(ph.vault) });
        }
        const heroKey = hero + unit;
        if (f.hero.dataset.v !== heroKey) { f.hero.dataset.v = heroKey; f.hero.innerHTML = esc(hero) + (unit ? `<small>${esc(unit)}</small>` : ''); }
        setText(f.heroLabel, label);

        const prem = me && me.premier != null ? me.premier : null;
        f.premier.hidden = prem == null;
        if (prem != null) {
            setText(f.premier, num(prem));
            f.premier.style.setProperty('--pc', premierColor(prem));
            f.premier.title = T('card.premier.tip', { rating: Math.round(prem).toLocaleString() });
        }
        setText(f.money, money(me && me.money));
        setText(f.tokens, num(me && me.tokens));
        setText(f.clicks, running ? num(a.clicks) : '—');
        setText(f.cpc, me && me.casesPerClick != null ? +me.casesPerClick.toFixed(2) + '%' : '—');
        setText(f.mpc, me && me.moneyPerClick != null ? money(me.moneyPerClick) : '—');
        setText(f.ctype, a.clickType === 'cases' ? T('card.type.cases') : T('card.type.money'));
        f.hero.classList.toggle('word', !running);
        f.money.closest('.kv').hidden = !running && !me;   // nothing known yet: no empty stats box

        setHtml(null, a.badges.map(b => `<span class="badge">${esc(b)}</span>`).join(''), f.badges);
        setHtml(null, issueHtml(a), f.issues);

        f.menuBusy.hidden = !running || !!a.test;
        f.segAuto.className = a.type === 'auto' ? 'on' : '';
        f.segMoney.className = a.type === 'money' ? 'on' : '';
        f.segCases.className = a.type === 'cases' ? 'on' : '';
        const main = running ? ['stop', T('card.btn.stop'), ''] : a.hasToken ? ['start', T('card.btn.start'), 'primary'] : ['relogin', T('card.btn.relogin'), 'primary'];
        f.main.dataset.act = main[0];
        f.main.className = main[2];
        setText(f.main, main[1]);
        tickCard(c);
    }

    // Moves the two bars between refreshes (every 250 ms).
    function tickCard(c) {
        const a = c.a, f = c.f, t = now();
        if (!a) return;
        if (a.test && a.test.ends) {
            const span = a.test.ends - a.test.startedAt, left = a.test.ends - t;
            f.nextBar.style.width = Math.min(100, Math.max(0, 100 - left / span * 100)) + '%';
            setText(f.nextTxt, T('busy.left', { time: secs(left) }));
        } else if (a.startedAt && a.nextClickAt) {
            const left = a.nextClickAt - t;
            f.nextBar.style.width = Math.min(100, Math.max(0, 100 - left / a.clickIntervalMs * 100)) + '%';
            setText(f.nextTxt, left > 0 ? T('card.next.in', { time: secs(left) }) : T('card.next.sending'));
        } else { f.nextBar.style.width = '0%'; setText(f.nextTxt, '—'); }
        const v = a.vault;
        if (a.startedAt && v && v.lastAt) {
            const held = Math.max(0, Math.min(v.cap, (t - v.lastAt) / 60000 * v.perMin));
            const pct = held / v.cap * 100;
            f.vaultBar.style.width = pct + '%';
            setText(f.vaultTxt, T('card.vault.fill', { pct: Math.floor(pct), money: money(held) }));
        } else { f.vaultBar.style.width = '0%'; setText(f.vaultTxt, a.startedAt ? T('card.vault.waiting') : '—'); }
    }

    function drawAccounts() {
        const el = $('#tab-accounts');
        if (!S.accounts.length) {
            for (const c of cards.values()) c.el.remove();
            cards.clear();
            setHtml(null, `
            <div class="empty">
              <div class="logo"></div>
              <h2>${H('empty.title')}</h2>
              <div class="muted">${H('empty.sub')}</div>
              <div class="steps">
                <div><b class="n">1</b>${H(webLook ? 'empty.step1.web' : 'empty.step1')}</div>
                <div><b class="n">2</b>${H('empty.step2')}</div>
                <div><b class="n">3</b>${H('empty.step3')}</div>
              </div>
              <button class="primary" data-act="add">${H('header.add')}</button>
              <p>${H('empty.limit', { max: S.maxPerIp })}</p>
            </div>`, el);
            return;
        }
        let wrap = el.querySelector('.sections');
        if (!wrap) {
            lastHtml.delete(el);
            el.innerHTML = `<p class="limit-note" hidden></p><div class="acct-tools"><input type="search" class="acct-search" placeholder="${H('cards.search')}" aria-label="${H('cards.search')}" hidden><span class="grow"></span><button class="small" data-act="compact" aria-pressed="false"></button><button class="small" data-act="folderNew">${H('folders.new')}</button></div><div class="sections"></div>`;
            wrap = el.querySelector('.sections');
            for (const s of sections.values()) s.el.remove();
            sections.clear();
        }
        const note = el.querySelector('.limit-note');
        note.hidden = S.running < (S.capacity || S.maxPerIp);
        setText(note, T('accounts.limit', { max: S.capacity || S.maxPerIp, per: S.maxPerIp }));
        applyCompact();
        // Mid-drag the cards stay where the pointer put them; the numbers still update.
        if (drag) { for (const a of S.accounts) { const c = cards.get(a.id); if (c) updateCard(c, a); } return; }
        // One section per folder in folder order, then the accounts in no folder (headed only when folders exist).
        const folders = S.folders || [];
        const keys = [...folders.map(f => f.id), ''];
        keys.forEach((k, i) => {
            let s = sections.get(k);
            if (!s) { s = newSection(k); sections.set(k, s); }
            if (wrap.children[i] !== s.el) wrap.insertBefore(s.el, wrap.children[i] || null);
            updateSection(s, folders.find(f => f.id === k) || null, folders.length > 0);
        });
        for (const [k, s] of sections) if (!keys.includes(k)) { s.el.remove(); sections.delete(k); }
        const at = new Map();   // grid -> next index
        const seen = new Set();
        for (const a of S.accounts) {
            let c = cards.get(a.id);
            if (!c) { c = newCard(a.id); cards.set(a.id, c); }
            const grid = (sections.get(a.folder || '') || sections.get('')).grid, i = at.get(grid) || 0;
            if (grid.children[i] !== c.el) grid.insertBefore(c.el, grid.children[i] || null);
            at.set(grid, i + 1);
            updateCard(c, a);
            seen.add(a.id);
        }
        for (const [id, c] of cards) if (!seen.has(id)) { c.el.remove(); cards.delete(id); }
        applySearch();
    }

    // The folder an account is in, as a small tag after its name (Troubleshoot lists).
    function folderTag(id) {
        const a = S.accounts.find(x => x.id === id), f = a && a.folder && (S.folders || []).find(x => x.id === a.folder);
        return f ? ` <span class="tr-folder">${esc(f.name)}</span>` : '';
    }

    // Search above the cards (shown from 9 accounts): hides the cards whose name doesn't match, and folders with none.
    let searchQ = '';
    function applySearch() {
        const box = $('#tab-accounts .acct-search');
        if (!box) return;
        box.hidden = S.accounts.length <= 8 && !searchQ;
        const q = searchQ.trim().toLowerCase();
        for (const a of S.accounts) { const c = cards.get(a.id); if (c) c.el.hidden = !!q && !String(a.name || '').toLowerCase().includes(q); }
        if (!q) return;
        for (const s of sections.values()) s.el.hidden = !s.grid.querySelector('.card:not([hidden])');
    }
    document.addEventListener('input', (e) => {
        if (!e.target.classList || !e.target.classList.contains('acct-search')) return;
        searchQ = e.target.value;
        drawAccounts();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && e.target.classList && e.target.classList.contains('acct-search') && e.target.value) { e.target.value = ''; searchQ = ''; drawAccounts(); }
    });

    // --- folders -----------------------------------------------------------
    const sections = new Map();   // folder id ('' = no folder) -> { el, grid, f }
    function newSection(fid) {
        const el = document.createElement('section');
        el.className = 'fsec' + (fid ? '' : ' loose');
        el.dataset.folder = fid;
        el.innerHTML = fid ? `
          <header class="f-head click" data-act="folderToggle" data-id="${fid}">
            <button class="icon-btn grip" data-grip="folder" data-id="${fid}" aria-label="${H('folders.grip.folder')}" title="${H('folders.grip.tip')}"><svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg></button>
            <button class="f-toggle" data-act="folderToggle" data-id="${fid}" data-f="toggle"><span class="caret" aria-hidden="true">▾</span><span class="f-name" data-f="name"></span></button>
            <span class="muted f-count" data-f="count"></span>
            <span class="grow"></span>
            <button class="small" data-act="folderStart" data-id="${fid}" data-f="start">${H('folders.start')}</button>
            <button class="small" data-act="folderStop" data-id="${fid}" data-f="stop">${H('folders.stop')}</button>
            <button class="icon-btn" data-act="folderMenu" data-id="${fid}" aria-label="${H('folders.menu')}" title="${H('card.menu.tip')}">⋯</button>
            <div class="menu" data-f="menu" hidden>
              <button data-act="folderRename" data-id="${fid}">${H('folders.rename')}</button>
              <button data-act="folderRemove" data-id="${fid}" class="danger">${H('folders.remove')}</button>
            </div>
          </header>
          <div class="grid" data-folder="${fid}" data-empty="${H('folders.empty')}"></div>`
          : `<header class="f-head" data-f="head"><span class="f-name">${H('folders.none')}</span><span class="muted f-count" data-f="count"></span></header>
          <div class="grid" data-folder="" data-empty="${H('folders.empty')}"></div>`;
        const f = {};
        el.querySelectorAll('[data-f]').forEach(n => { f[n.dataset.f] = n; });
        return { el, grid: el.querySelector('.grid'), f };
    }
    function updateSection(s, folder, any) {
        const mine = S.accounts.filter(a => (a.folder || '') === (folder ? folder.id : ''));
        const on = mine.filter(a => a.startedAt).length;
        setText(s.f.count, mine.length ? T(mine.length === 1 ? 'folders.count.one' : 'folders.count', { n: mine.length, on }) : '');
        if (!folder) {
            // No folders: just the cards, as before. With folders: a plain heading, hidden while empty.
            s.f.head.hidden = !any;
            s.el.classList.toggle('bare', !any);
            s.el.hidden = any && !mine.length && !drag;
            return;
        }
        setText(s.f.name, folder.name);
        s.el.hidden = false;   // a search may hide it again (applySearch)
        s.el.classList.toggle('collapsed', !!folder.collapsed);
        s.f.toggle.setAttribute('aria-expanded', String(!folder.collapsed));
        s.f.start.disabled = !mine.some(a => !a.startedAt && a.hasToken);
        s.f.stop.disabled = !on;
    }
    async function pickFolder(acc) {
        const folders = S.folders || [];
        let v = acc.folder || '';
        const opts = [['', T('folders.none')], ...folders.map(f => [f.id, f.name]), ['+', T('folders.newOption')]];
        const p = modal({ title: T('folders.move.title', { name: acc.name }), ok: T('folders.move.ok'),
            html: `<select id="folderPick" class="folder-pick">${opts.map(([k, n]) => `<option value="${esc(k)}"${k === v ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>` });
        const box = $('#modal .modal-box');
        box.onchange = (e) => { if (e.target.id === 'folderPick') v = e.target.value; };
        if (!(await p)) return;
        if (v === '+') {
            const name = await modal({ title: T('folders.new.title'), input: '', ok: T('folders.new.ok') });
            if (name != null && name.trim()) await call('folderAdd', name.trim(), [acc.id]);
        } else if (v !== (acc.folder || '')) await call('moveAccount', acc.id, { folder: v || null });
    }

    // --- dragging cards and folders ------------------------------------------
    // By the grip (any pointer) or a card's header (mouse). The card follows the pointer and a gap shows where it
    // lands; dropping on a collapsed folder's heading puts it last in that folder. Folders drag as headings only.
    // Arrow keys on a grip move it one place. Escape cancels.
    let drag = null;
    const DRAG_START_PX = 6;
    function dragDown(e) {
        if (e.button !== 0 || tab !== 'accounts' || drag) return;
        const grip = e.target.closest('[data-grip]');
        const head = !grip && e.pointerType === 'mouse' && e.target.closest('.card .c-head');
        if (!grip && (!head || e.target.closest('button, .menu'))) return;
        const kind = grip ? grip.dataset.grip : 'card';
        const el = kind === 'card' ? (grip || head).closest('.card') : grip.closest('.fsec');
        if (!el) return;
        drag = { kind, el, id: kind === 'card' ? el.dataset.id : el.dataset.folder, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, live: false, pid: e.pointerId };
        e.preventDefault();   // no text selection or native drag from the press
    }
    function dragBegin() {
        const d = drag;
        d.live = true;
        closeMenus();
        document.body.classList.add('dragging-' + d.kind);
        if (d.kind === 'folder') for (const s of sections.values()) s.el.classList.add('folded');
        else for (const s of sections.values()) if (s.el.hidden) { s.el.hidden = false; }
        const r = d.el.getBoundingClientRect();
        d.dx = Math.min(Math.max(0, d.x0 - r.left), r.width); d.dy = Math.min(Math.max(0, d.y0 - r.top), Math.max(0, r.height - 4));
        d.ph = document.createElement('div');
        d.ph.className = 'drop-ph ' + d.kind;
        d.ph.style.height = r.height + 'px';
        d.el.parentNode.insertBefore(d.ph, d.el);
        Object.assign(d.el.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', zIndex: 50, pointerEvents: 'none' });
        d.el.classList.add('lifted');
        d.scroll = requestAnimationFrame(dragScroll);
    }
    function dragScroll() {
        const d = drag;
        if (!d || !d.live) return;
        const edge = 60, vh = window.innerHeight;
        const v = d.y < edge ? -Math.ceil((edge - d.y) / 4) : d.y > vh - edge ? Math.ceil((d.y - (vh - edge)) / 4) : 0;
        if (v) { window.scrollBy(0, v); dragOver(); }
        d.scroll = requestAnimationFrame(dragScroll);
    }
    function dragMove(e) {
        const d = drag;
        if (!d || e.pointerId !== d.pid) return;
        d.x = e.clientX; d.y = e.clientY;
        if (!d.live) { if (Math.hypot(d.x - d.x0, d.y - d.y0) < DRAG_START_PX) return; dragBegin(); }
        e.preventDefault();
        d.el.style.left = (d.x - d.dx) + 'px';
        d.el.style.top = (d.y - d.dy) + 'px';
        dragOver();
    }
    function setHot(h) { const d = drag; if (d.hot === h) return; if (d.hot) d.hot.classList.remove('drop-hot'); d.hot = h; if (h) h.classList.add('drop-hot'); }
    function dragOver() {
        const d = drag;
        if (d.kind === 'folder') {
            // Folders show as headings only while one drags: it goes before the first heading below the pointer.
            const wrap = $('#tab-accounts .sections');
            const ref = [...wrap.children].find(n => n !== d.el && n !== d.ph && n.classList.contains('fsec')
                && (n.classList.contains('loose') || d.y < n.getBoundingClientRect().top + n.getBoundingClientRect().height / 2)) || null;
            if (d.ph.nextSibling !== ref) wrap.insertBefore(d.ph, ref);
            return;
        }
        const under = document.elementFromPoint(d.x, d.y);
        if (!under) return;
        const head = under.closest('.fsec:not(.loose) .f-head');
        const sec = head && head.closest('.fsec');
        if (sec && sec.classList.contains('collapsed')) { setHot(head); d.ph.hidden = true; return; }
        setHot(null); d.ph.hidden = false;
        if (head) { const g = sec.querySelector('.grid'); if (d.ph.parentNode !== g || d.ph.nextSibling) g.appendChild(d.ph); return; }
        const card = under.closest('.card');
        if (card && card !== d.el) {
            const g = card.parentNode, r = card.getBoundingClientRect();
            const cols = getComputedStyle(g).gridTemplateColumns.split(' ').length;
            const after = cols > 1 ? d.x > r.left + r.width / 2 : d.y > r.top + r.height / 2;
            const ref = after ? card.nextSibling : card;
            if (ref !== d.ph && d.ph.nextSibling !== ref) g.insertBefore(d.ph, ref);
            return;
        }
        const g = under.closest('.grid');
        if (g && under === g && d.ph.parentNode !== g) g.appendChild(d.ph);
    }
    async function dragEnd(e, cancel) {
        const d = drag;
        if (!d || (e && e.pointerId !== d.pid)) return;
        if (!d.live) { drag = null; return; }
        cancelAnimationFrame(d.scroll);
        document.body.classList.remove('dragging-' + d.kind);
        for (const s of sections.values()) s.el.classList.remove('folded');
        d.el.classList.remove('lifted');
        Object.assign(d.el.style, { position: '', left: '', top: '', width: '', height: '', zIndex: '', pointerEvents: '' });
        let to = null;
        if (!cancel && d.kind === 'card') {
            if (d.hot) to = { folder: d.hot.closest('.fsec').dataset.folder || null, before: null };
            else if (d.ph.parentNode) {
                let n = d.ph.nextSibling; while (n && (n === d.el || !n.classList || !n.classList.contains('card'))) n = n.nextSibling;
                to = { folder: d.ph.parentNode.dataset.folder || null, before: n ? n.dataset.id : null };
                d.ph.parentNode.insertBefore(d.el, d.ph);
            }
        } else if (!cancel && d.kind === 'folder' && d.ph.parentNode) {
            let n = d.ph.nextSibling; while (n && (n === d.el || !n.dataset || n.dataset.folder == null)) n = n.nextSibling;
            to = { before: n && n.dataset.folder ? n.dataset.folder : null };
            d.ph.parentNode.insertBefore(d.el, d.ph);
        }
        if (d.hot) d.hot.classList.remove('drop-hot');
        d.ph.remove();
        drag = null;
        // A drag isn't a click on whatever was under the pointer.
        if (e) {
            const eat = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
            document.addEventListener('click', eat, { capture: true, once: true });
            setTimeout(() => document.removeEventListener('click', eat, { capture: true }), 0);
        }
        // "before" an account in another folder would be the same place; before null = last in the list.
        if (to && d.kind === 'card') await call('moveAccount', d.id, to);
        else if (to) await call('folderMove', d.id, to.before);
        refresh();
    }
    // Arrow keys on a grip: one place up or down (a card stays in its folder).
    async function gripKey(e) {
        const g = e.target.closest && e.target.closest('[data-grip]');
        if (!g || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
        e.preventDefault();
        const up = e.key === 'ArrowUp' || e.key === 'ArrowLeft', id = g.dataset.id;
        if (g.dataset.grip === 'card') {
            const a = S.accounts.find(x => x.id === id); if (!a) return;
            const same = S.accounts.filter(x => (x.folder || '') === (a.folder || '')), i = same.indexOf(a);
            const j = up ? i - 1 : i + 1;
            if (j < 0 || j >= same.length) return;
            await call('moveAccount', id, { before: up ? same[j].id : (same[j + 1] ? same[j + 1].id : null), folder: a.folder || null });
        } else {
            const fl = S.folders || [], i = fl.findIndex(f => f.id === id), j = up ? i - 1 : i + 1;
            if (i < 0 || j < 0 || j >= fl.length) return;
            await call('folderMove', id, up ? fl[j].id : (fl[j + 1] ? fl[j + 1].id : null));
        }
        await refresh();
        const back = document.querySelector(`[data-grip="${g.dataset.grip}"][data-id="${id}"]`);
        if (back) back.focus();
    }
    document.addEventListener('pointerdown', dragDown);
    document.addEventListener('pointermove', dragMove, { passive: false });
    document.addEventListener('pointerup', (e) => dragEnd(e, false));
    document.addEventListener('pointercancel', (e) => dragEnd(e, true));
    document.addEventListener('keydown', (e) => { if (drag && drag.live && e.key === 'Escape') dragEnd(null, true); else gripKey(e); });

    function closeMenus(except) {
        document.querySelectorAll('.menu').forEach(m => { if (m !== except) m.hidden = true; });
        if (openGroup && !(except && except.classList.contains('tab-menu'))) { openGroup = null; document.querySelectorAll('[data-act="tabGroup"]').forEach(b => b.setAttribute('aria-expanded', 'false')); }
    }

    // Compact cards: name, state, income and Start/Stop only. Per device (a phone may want it, the desktop not).
    let compact = false;
    try { compact = localStorage.getItem('zsb.compactCards') === '1'; } catch (_) {}
    function applyCompact() {
        const w = $('#tab-accounts .sections'); if (w) w.classList.toggle('compact', compact);
        const b = $('#tab-accounts [data-act="compact"]'); if (b) { b.setAttribute('aria-pressed', String(compact)); setText(b, T(compact ? 'cards.full' : 'cards.compact')); }
    }

    // --- plugins -------------------------------------------------------------
    function pluginState(p) {
        if (p.state === 'running') return `<span class="tag ok">${H('plugins.state.running')}</span>`;
        if (p.state === 'error') return `<span class="tag bad">${esc(p.error.code)}</span>`;
        return `<span class="tag">${H('plugins.state.off')}</span>`;
    }

    // Which accounts an accounts setting runs on, in words.
    function accountsSummary(s) {
        const v = s.value || {}, total = S.accounts.length, n = (v.ids || []).filter(i => S.accounts.some(a => a.id === i)).length;
        const label = s.label || s.key;
        if (v.all) return H('plugins.accounts.all', { label });
        if (!n) return H('plugins.accounts.none', { label });
        return H('plugins.accounts.some', { label, n, total });
    }
    const needsAccounts = (p) => p.settings.some(s => s.type === 'accounts' && !(s.value && (s.value.all || (s.value.ids || []).length)));

    const catalogEntry = (id) => ((S.catalog && S.catalog.entries) || []).find(e => e.id === id);

    function pluginCard(p) {
        const acc = p.settings.filter(s => s.type === 'accounts'), ce = catalogEntry(p.id), upd = ce && ce.update;
        return `
            <div class="row plug">
              <div class="main">
                <div class="title">${esc(p.name)} <span class="muted">${esc(p.version)}</span> ${p.enabled ? pluginState(p) : ''} ${p.bundled ? `<span class="tag">${H('plugins.tag.builtin')}</span>` : p.verified ? `<span class="tag ok">${H('plugins.tag.signed')}</span>` : `<span class="tag bad">${H('plugins.tag.unverified')}</span>`}</div>
                <div class="desc">${esc(p.description)}</div>
                ${p.error ? `<div class="desc bad-text">${esc(p.error.msg)}</div>` : ''}
                ${acc.map(s => `<div class="desc runs-on${p.enabled && needsAccounts(p) ? ' warn-text' : ''}">${accountsSummary(s)}</div>`).join('')}
                ${upd && ce.tooNew ? `<div class="desc muted">${H('plugins.updateNeedsApp', { version: esc(ce.version), app: esc(ce.minCore) })}</div>` : ''}
              </div>
              <div class="plug-btns">
                ${upd && !ce.tooNew ? `<button class="small primary" data-act="pluginInstall" data-id="${esc(p.id)}">${H('plugins.update', { version: esc(ce.version) })}</button>` : ''}
                ${p.removable ? `<button class="small" data-act="pluginRemove" data-id="${esc(p.id)}">${H('plugins.remove')}</button>` : ''}
                ${p.tab && p.state === 'running' ? `<button class="small" data-act="tab" data-tab="plugin:${esc(p.id)}:${esc(p.tab)}">${H('plugins.open')}</button>`
                    : !p.tab && p.settings.length ? `<button class="small" data-act="pluginOpen" data-id="${esc(p.id)}">${H('plugins.settings')}</button>` : ''}
                ${p.enabled ? `<button class="small" data-act="pluginToggle" data-id="${esc(p.id)}" data-on="0">${H('plugins.turnOff')}</button>`
                    : `<button class="small primary" data-act="pluginToggle" data-id="${esc(p.id)}" data-on="1">${H('plugins.turnOn')}</button>`}
              </div>
            </div>`;
    }

    function drawPlugins() {
        const on = S.plugins.filter(p => p.enabled), off = S.plugins.filter(p => !p.enabled);
        const section = (title, list) => list.length ? `<h4 class="plug-head">${title}</h4><div class="rows">${list.map(pluginCard).join('')}</div>` : '';
        const c = S.catalog || {}, more = (c.entries || []).filter(e => !e.installed);
        const moreCard = (e) => `
            <div class="row plug">
              <div class="main">
                <div class="title">${esc(e.name)} <span class="muted">${esc(e.version)}</span> <span class="tag ok">${H('plugins.tag.signed')}</span></div>
                <div class="desc">${esc(e.description)}</div>
                ${e.tooNew ? `<div class="desc muted">${H('plugins.needsApp', { app: esc(e.minCore) })}</div>` : ''}
              </div>
              <div class="plug-btns">${e.tooNew ? '' : `<button class="small primary" data-act="pluginInstall" data-id="${esc(e.id)}">${H('plugins.install')}</button>`}</div>
            </div>`;
        const status = !c.available ? '' : `<p class="muted">${c.busy ? H('plugins.catalog.checking')
            : c.error ? H('plugins.catalog.error', { code: esc(c.error.code) }) : H('plugins.catalog.checked', { ago: ago(c.checkedAt) })}
            <button class="small" data-act="pluginCatalog">${H('plugins.catalog.check')}</button></p>`;
        setHtml('#tab-plugins', (S.plugins.length ? section(H('plugins.section.on'), on) + section(H('plugins.section.available'), off) : `<div class="muted">${H('plugins.none')}</div>`)
            + (more.length ? `<h4 class="plug-head">${H('plugins.section.more')}</h4><div class="rows">${more.map(moreCard).join('')}</div>` : '')
            + status + `<p class="muted">${H('plugins.note')}</p>`);
    }

    // A plugin's settings window. Every change is saved as it's made; "Done" just closes it.
    const fieldDefault = (f) => f.type === 'accounts' ? { all: false, ids: [] } : f.type === 'list' ? [] : f.type === 'account' ? ''
        : f.type === 'choice' ? (f.default ?? ((f.options || [])[0] || {}).value ?? '') : f.default ?? '';
    // Nothing saved yet: a "choose" line, so the first option doesn't look picked.
    // Options; consecutive ones with the same .group go under one heading (<optgroup>).
    const optionsHtml = (opts, value) => {
        let out = '', group = null;
        for (const o of opts || []) {
            if ((o.group || null) !== group) { if (group) out += '</optgroup>'; group = o.group || null; if (group) out += `<optgroup label="${esc(group)}">`; }
            out += `<option value="${esc(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${esc(o.label || o.value)}</option>`;
        }
        return out + (group ? '</optgroup>' : '');
    };
    const choiceSelect = (opts, value, attr) => `<select ${attr}>${(value === '' || value == null) && !(opts || []).some(o => o.value === '') ? `<option value="" selected disabled>${H('pluginmodal.choose')}</option>` : ''}${optionsHtml(opts, value)}
        ${value !== '' && value != null && !(opts || []).some(o => String(o.value) === String(value)) ? `<option value="${esc(value)}" selected>${esc(value)}</option>` : ''}</select>`;
    const accountSelect = (value, attr) => choiceSelect([{ value: '', label: T('pluginmodal.noAccount') }, ...S.accounts.map(a => ({ value: a.id, label: a.name || a.id }))], value, attr);

    // One field of a list row.
    // One field of a list row. f.when: shown only while that field of the row is set; f.exclude: an
    // accounts field hides the account picked in that field (a route's receiver isn't also a sender).
    function rowFieldHtml(fk, f, v, dep = false) {
        const label = `<span class="prow-label">${esc(f.label || fk)}</span>`;
        const at = (cls = 'prow-f') => `class="${cls}${dep ? ' prow-dep' : ''}${f.newline ? ' prow-nl' : ''}"${f.when ? ` data-fwhen="${esc(f.when)}"` : ''}${f.help ? ` title="${esc(f.help)}"` : ''}`;
        const help = f.help ? `<span class="prow-help">${esc(f.help)}</span>` : '';
        if (f.type === 'heading') return `<div ${at('prow-h')}><b>${esc(f.label || '')}</b>${f.help ? `<span>${esc(f.help)}</span>` : ''}</div>`;
        if (f.type === 'boolean') return `<label ${at('prow-f prow-bool')}><span class="switch"><input type="checkbox" data-f="${esc(fk)}" ${v ? 'checked' : ''}><i></i></span> <span>${esc(f.label || fk)}</span></label>`;
        if (f.type === 'account') return `<label ${at()}>${label}${accountSelect(v, `data-f="${esc(fk)}"`)}${help}</label>`;
        if (f.type === 'choice') return `<label ${at()}>${label}${choiceSelect(f.options, v, `data-f="${esc(fk)}"`)}${help}</label>`;
        if (f.type === 'accounts') {
            const ids = new Set((v && v.ids) || []), all = !!(v && v.all);
            return `<div ${at('prow-f prow-wide')} data-f="${esc(fk)}" data-ftype="accounts"${f.exclude ? ` data-exclude="${esc(f.exclude)}"` : ''}>${label}<div class="pchips">
                <label class="pchip"><input type="checkbox" data-fall ${all ? 'checked' : ''}> ${H('pluginmodal.allShort')}</label>
                ${S.accounts.map(a => `<label class="pchip"><input type="checkbox" data-facct value="${esc(a.id)}" ${all || ids.has(a.id) ? 'checked' : ''} ${all ? 'disabled' : ''}> ${esc(a.name || a.id)}${chipDetail(f, a)}</label>`).join('')}</div></div>`;
        }
        return `<label ${at()}>${label}<input type="${f.type === 'number' ? 'number' : 'text'}" data-f="${esc(fk)}" value="${esc(v ?? '')}"${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}>${help}</label>`;
    }

    // f.detail: a figure from the account's last report next to its name in an accounts field ("tokens", "money").
    const chipDetail = (f, a) => {
        const v = f.detail && a.me ? a.me[f.detail] : null;
        if (v == null) return '';
        return ` <span class="pchip-detail">${esc(f.detail === 'money' ? money(v) : T('pluginmodal.detail.' + f.detail, { n: num(v) }))}</span>`;
    };

    // Is a control "set"? A ticked box, or a value that isn't empty / none / 0.
    const ctlOn = (el) => !!el && (el.type === 'checkbox' ? el.checked : !['', 'none', '0'].includes(String(el.value)));
    // Show a row's fields that depend on another one, and keep the receiver out of the senders.
    function rowReveal(row) {
        row.querySelectorAll('[data-fwhen]').forEach(el => { el.hidden = !ctlOn(row.querySelector(`[data-f="${CSS.escape(el.dataset.fwhen)}"]:not([data-ftype])`)); });
        row.querySelectorAll('[data-exclude]').forEach(el => {
            const other = row.querySelector(`[data-f="${CSS.escape(el.dataset.exclude)}"]`), v = other ? other.value : '';
            el.querySelectorAll('[data-facct]').forEach(b => { const chip = b.closest('.pchip'); chip.hidden = !!v && b.value === v; if (chip.hidden) b.checked = false; });
        });
    }
    const pendingSaves = new Set();   // plugin setting saves still on their way
    const openRows = new Map();   // list key -> Set of row numbers shown open (the rest show their summary)

    const cap = (t) => String(t).charAt(0).toUpperCase() + String(t).slice(1);
    // A list's rows. With s.summaries (one line per row, from the plugin) rows fold to that line and open with Edit.
    function listHtml(s) {
        const rows = Array.isArray(s.value) ? s.value : [], fold = Array.isArray(s.summaries), open = openRows.get(s.key) || new Set();
        return rows.map((row, i) => {
            const shut = fold && !open.has(i), sum = fold ? s.summaries[i] || '' : '';
            return `<div class="prow${shut ? ' shut' : ''}" data-row="${i}">
              <div class="prow-head"><div class="prow-title"><b>${esc(cap(s.itemLabel || s.label || s.key))} ${i + 1}</b>${sum ? `<span class="prow-sum">${esc(sum)}</span>` : ''}</div>
                <div class="pbtns">${fold ? `<button class="small" data-row-toggle="${i}">${shut ? H('pluginmodal.editRow') : H('pluginmodal.doneRow')}</button>` : ''}<button class="small" data-row-del="${i}">${H('pluginmodal.removeRow')}</button></div></div>
              <div class="prow-fields">${Object.entries(s.fields || {}).map(([fk, f]) => rowFieldHtml(fk, f, row[fk] ?? fieldDefault(f), !!(f.when && s.fields[f.when] && s.fields[f.when].type === 'boolean'))).join('')}</div></div>`;
        }).join('')
            + (rows.length ? '' : `<div class="muted">${H('pluginmodal.noRows')}</div>`)
            + `<button class="small" data-row-add>${H('pluginmodal.addRow', { what: esc(s.itemLabel || s.label || s.key) })}</button>`;
    }

    function pluginSettingHtml(s) {
        const wrap = (inner) => inner.replace('<div class="pset"', `<div class="pset"${s.when ? ` data-when="${esc(s.when)}"` : ''}`)
            .replace(/(<\/div>)$/, (s.help ? `<div class="muted pset-help">${esc(s.help)}</div>` : '') + '$1');
        return wrap(pluginSettingInner(s));
    }

    const tagList = (v) => (Array.isArray(v) ? v : v ? [String(v)] : []).filter(Boolean);
    const tagsHtml = (v) => tagList(v).map(t => `<button type="button" class="ptag" data-tag="${esc(t)}" title="${H('tags.remove')}">${esc(t)}<span aria-hidden="true">×</span></button>`).join('');

    // A number as plain digits: 1e-7 shows as 0.0000001.
    const plainNum = (v) => { const n = Number(v); return Number.isFinite(n) && n !== 0 && Math.abs(n) < 1e-6 ? n.toFixed(12).replace(/\.?0+$/, '') : v; };
    function pluginSettingInner(s) {
        const key = esc(s.key), label = s.label === '' ? '' : `<div class="pset-label">${esc(s.label || s.key)}</div>`;
        if (s.type === 'list') return `<div class="pset" data-key="${key}" data-type="list">${label}<div class="prows">${listHtml(s)}</div></div>`;
        if (s.type === 'account') return `<div class="pset" data-key="${key}" data-type="account">${label}${accountSelect(s.value, 'data-pset')}</div>`;
        if (s.type === 'choice' && (s.dynamic || (s.options || []).length > 4)) return `<div class="pset" data-key="${key}" data-type="choice">${label}${choiceSelect(s.options, s.value, 'data-pset')}</div>`;
        if (s.type === 'accounts') {
            const v = s.value || {}, ids = new Set(v.ids || []);
            const row = (a) => `
                <label class="pick" data-name="${esc(String(a.name || '').toLowerCase())}" data-folder="${esc(a.folder || '')}"><input type="checkbox" data-pick="acct" value="${esc(a.id)}" ${ids.has(a.id) || v.all ? 'checked' : ''} ${v.all ? 'disabled' : ''}>
                  <span>${esc(a.name || a.id)}</span><span class="muted">${a.startedAt ? H('pluginmodal.clicking') : H('pluginmodal.notClicking')}</span></label>`;
            // With folders: the accounts under each folder's name, which ticks or clears the whole folder.
            const folders = (S.folders || []).filter(f => S.accounts.some(a => a.folder === f.id));
            const groups = folders.length ? [...folders.map(f => [f.id, f.name]), ['', T('folders.none')]] : null;
            const list = !S.accounts.length ? `<div class="muted">${H('pluginmodal.noAccounts')}</div>`
                : !groups ? S.accounts.map(row).join('')
                : groups.map(([fid, name]) => {
                    const mine = S.accounts.filter(a => (a.folder || '') === fid);
                    return mine.length ? `<label class="pick pick-folder" data-group="${esc(fid)}"><input type="checkbox" data-pick="folder" value="${esc(fid)}" ${v.all ? 'disabled' : ''}>
                      <span>${esc(name)}</span><span class="muted">${mine.length}</span></label>${mine.map(row).join('')}` : '';
                }).join('');
            return `<div class="pset" data-key="${key}" data-type="accounts">${label}
                <label class="pick-all"><span class="switch"><input type="checkbox" data-pick="all" ${v.all ? 'checked' : ''}><i></i></span><span>${H('pluginmodal.all')} <span class="muted">${H('pluginmodal.allHint')}</span></span></label>
                ${S.accounts.length > 1 ? `<div class="pick-tools"><button class="small" data-pick="every" ${v.all ? 'disabled' : ''}>${H('pluginmodal.selectAll')}</button><button class="small" data-pick="clear" ${v.all ? 'disabled' : ''}>${H('pluginmodal.clear')}</button>
                  ${S.accounts.length > 8 ? `<input class="pick-search" data-pick="search" placeholder="${H('pluginmodal.search')}">` : ''}</div>` : ''}
                <div class="pick-list">${list}</div>
                <div class="muted pick-count"></div></div>`;
        }
        if (s.type === 'choice') return `<div class="pset" data-key="${key}" data-type="choice">${label}<div class="seg">${(s.options || []).map(o => `<button class="${o.value === s.value ? 'on' : ''}" data-choice="${esc(o.value)}">${esc(o.label || o.value)}</button>`).join('')}</div></div>`;
        if (s.type === 'boolean') return `<div class="pset" data-key="${key}" data-type="boolean"><label class="pick-all"><span class="switch"><input type="checkbox" data-pset ${s.value ? 'checked' : ''}><i></i></span><span>${esc(s.label || s.key)}</span></label></div>`;
        // tags: names typed one at a time. Enter (or clicking away) turns the text into a chip and leaves an empty box for
        // the next one; clicking a chip takes it out.
        if (s.type === 'tags') return `<div class="pset pset-wide" data-key="${key}" data-type="tags">${label}<div class="ptags">${tagsHtml(s.value)}<input data-tag-input spellcheck="false" autocomplete="off" placeholder="${esc(tagList(s.value).length ? T('tags.more') : s.placeholder || '')}"></div></div>`;
        // textarea: several lines (a pasted list); saved when the field loses focus.
        if (s.type === 'textarea') return `<div class="pset pset-wide" data-key="${key}" data-type="text">${label}<textarea data-pset rows="6" spellcheck="false" autocomplete="off"${s.placeholder ? ` placeholder="${esc(s.placeholder)}"` : ''}>${esc(s.value || '')}</textarea></div>`;
        return `<div class="pset" data-key="${key}" data-type="${s.type === 'number' ? 'number' : 'text'}">${label}<input type="${s.type === 'number' ? 'number' : 'text'}"${s.type === 'number' ? ' step="any"' : ''} data-pset value="${esc(s.type === 'number' ? plainNum(s.value) : s.value)}"></div>`;
    }

    function pluginModal(id) {
        const p = S.plugins.find(x => x.id === id);
        if (!p) return;
        const done = modal({ title: p.name, body: p.description, wide: true, cancel: false, ok: T('pluginmodal.done'),
            html: `<div class="psets">${p.settings.filter(s => !s.page).map(pluginSettingHtml).join('')}</div>
                <div class="muted pset-foot">${H('pluginmodal.note')} <button class="small" data-pset-reload>${H('plugins.reload')}</button></div>` });
        const box = $('#modal .modal-box');
        bindSettings(box, id, box.onclick);
        return done.then(refresh);
    }

    // Live settings controls (modal or a plugin's own tab): every change is saved as it's made.
    function bindSettings(root, id, chain = () => {}) {
        const P = () => S.plugins.find(x => x.id === id) || { settings: [] };
        // Kept in pendingSaves so a button pressed right after typing (the field saves as it loses focus) runs with the new value.
        const save = (key, value) => {
            const pr = call('pluginSetting', id, key, value).then(r => { if (r && !r.ok) toast(r.error); refresh(); });
            pendingSaves.add(pr); pr.finally(() => pendingSaves.delete(pr));
            return pr;
        };
        // Settings that only matter while a switch is on.
        const showWhen = () => root.querySelectorAll('.pset[data-when]').forEach(el => {
            const sw = root.querySelector(`.pset[data-key="${CSS.escape(el.dataset.when)}"] [data-pset]`);
            el.hidden = !!sw && !ctlOn(sw);
        });
        showWhen();
        root.querySelectorAll('.prow').forEach(rowReveal);
        // A list: read every row back from the form, save the whole list.
        const listSpec = (set) => P().settings.find(x => x.key === set.dataset.key);
        const readRows = (set) => [...set.querySelectorAll('.prow')].map(row => {
            const out = {};
            for (const [fk, f] of Object.entries(listSpec(set).fields || {})) {
                if (f.type === 'heading') continue;
                if (f.type === 'accounts') {
                    const el = row.querySelector(`[data-f="${CSS.escape(fk)}"]`), all = el.querySelector('[data-fall]').checked;
                    out[fk] = { all, ids: [...el.querySelectorAll('[data-facct]')].filter(b => b.checked && !b.disabled).map(b => b.value) };
                    if (all) out[fk].ids = JSON.parse(el.dataset.ids || '[]');
                } else {
                    const el = row.querySelector(`[data-f="${CSS.escape(fk)}"]`);
                    out[fk] = !el ? fieldDefault(f) : f.type === 'boolean' ? el.checked : f.type === 'number' ? Number(el.value) : el.value;
                }
            }
            return out;
        });
        const redrawList = (set, rows) => { const sp = { ...listSpec(set), value: rows }; set.querySelector('.prows').innerHTML = listHtml(sp); };
        const saveList = (set, rows, redraw) => { if (redraw) redrawList(set, rows); return call('pluginSetting', id, set.dataset.key, rows).then(r => { if (r && !r.ok) toast(r.error); return refresh(); }); };
        const countAccounts = (set) => {
            const boxes = [...set.querySelectorAll('[data-pick="acct"]')], all = set.querySelector('[data-pick="all"]').checked;
            const c = set.querySelector('.pick-count');
            if (c) c.textContent = all ? T('pluginmodal.countAll') : T('pluginmodal.count', { n: boxes.filter(b => b.checked).length, total: boxes.length });
            // Folder boxes: ticked when all their accounts are, half when some are.
            set.querySelectorAll('[data-pick="folder"]').forEach(f => {
                const mine = boxes.filter(b => b.closest('.pick').dataset.folder === f.value), on = mine.filter(b => b.checked).length;
                f.checked = mine.length > 0 && on === mine.length; f.indeterminate = on > 0 && on < mine.length; f.disabled = all;
            });
        };
        // The ticked accounts live in set.dataset.ids, so turning "All accounts" off goes back to them.
        const saveAccounts = (set) => {
            const all = set.querySelector('[data-pick="all"]').checked, was = new Set(JSON.parse(set.dataset.ids || '[]'));
            set.querySelectorAll('[data-pick="acct"]').forEach(b => { b.disabled = all; b.checked = all || was.has(b.value); });
            set.querySelectorAll('[data-pick="every"], [data-pick="clear"]').forEach(b => { b.disabled = all; });
            countAccounts(set);
            save(set.dataset.key, { all, ids: [...was] });
        };
        const ticked = (set) => { set.dataset.ids = JSON.stringify([...set.querySelectorAll('[data-pick="acct"]')].filter(b => b.checked).map(b => b.value)); saveAccounts(set); };
        root.querySelectorAll('.pset[data-type="accounts"]').forEach(set => {
            const s = P().settings.find(x => x.key === set.dataset.key);
            set.dataset.ids = JSON.stringify((s.value && s.value.ids) || []);
            countAccounts(set);
        });
        // Properties, not addEventListener: the modal box is reused by every dialog (modal() clears them),
        // and the plugin tab is bound again on every draw.
        root.onchange = (e) => {
            const set = e.target.closest('.pset');
            if (!set) return;
            if (set.dataset.type === 'list') {
                if (e.target.hasAttribute('data-fall')) {
                    const el = e.target.closest('[data-ftype="accounts"]');
                    if (e.target.checked) el.dataset.ids = JSON.stringify([...el.querySelectorAll('[data-facct]')].filter(b => b.checked).map(b => b.value));
                    const was = new Set(JSON.parse(el.dataset.ids || '[]'));
                    el.querySelectorAll('[data-facct]').forEach(b => { b.disabled = e.target.checked; b.checked = e.target.checked || was.has(b.value); });
                }
                const row = e.target.closest('.prow');
                if (row) rowReveal(row);
                saveList(set, readRows(set), false);
                return;
            }
            if (e.target.dataset.pick === 'all') saveAccounts(set);
            else if (e.target.dataset.pick === 'acct') ticked(set);
            else if (e.target.dataset.pick === 'folder') {
                set.querySelectorAll(`.pick[data-folder="${CSS.escape(e.target.value)}"] [data-pick="acct"]`).forEach(b => { b.checked = e.target.checked; });
                ticked(set);
            }
            else if (e.target.hasAttribute('data-pset')) { save(set.dataset.key, e.target.type === 'checkbox' ? e.target.checked !== e.target.hasAttribute('data-invert') : e.target.value); showWhen(); }
        };
        root.oninput = (e) => {
            if (e.target.hasAttribute('data-shop-qty')) {
                const q = e.target, btn = q.parentElement.querySelector('button');
                btn.textContent = shopLabel(q.value, Number(q.dataset.pack), q.dataset.price, q.dataset.unit);
                return;
            }
            if (e.target.dataset.pick !== 'search') return;
            const q = e.target.value.trim().toLowerCase();
            const set = e.target.closest('.pset');
            set.querySelectorAll('.pick:not(.pick-folder)').forEach(l => { l.hidden = !!q && !l.dataset.name.includes(q); });
            set.querySelectorAll('.pick-folder').forEach(g => { g.hidden = !!q && !set.querySelector(`.pick[data-folder="${CSS.escape(g.dataset.group)}"]:not([hidden])`); });
        };
        // Tags: the chips are the value; the box after them is the next one being typed.
        const readTags = (set) => [...set.querySelectorAll('.ptag')].map(x => x.dataset.tag);
        const tagsChanged = (set) => {
            const inp = set.querySelector('[data-tag-input]');
            inp.placeholder = readTags(set).length ? T('tags.more') : (P().settings.find(x => x.key === set.dataset.key) || {}).placeholder || '';
            save(set.dataset.key, readTags(set));
        };
        const addTag = (inp) => {
            const set = inp.closest('.pset'), v = inp.value.trim();
            inp.value = '';
            if (!v || readTags(set).some(t => t.toLowerCase() === v.toLowerCase())) return;
            inp.insertAdjacentHTML('beforebegin', tagsHtml([v]));
            tagsChanged(set);
        };
        root.onkeydown = (e) => {
            if (e.target.hasAttribute && e.target.hasAttribute('data-plines') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); e.target.click(); return; }
            if (!e.target.hasAttribute || !e.target.hasAttribute('data-tag-input')) return;
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); addTag(e.target); }
            else if (e.key === 'Backspace' && !e.target.value) {
                const set = e.target.closest('.pset'), last = [...set.querySelectorAll('.ptag')].pop();
                if (last) { last.remove(); tagsChanged(set); }
            }
        };
        // Chromium has no onfocusout property: a listener, swapped on each bind so there's only ever one.
        if (root._tagOut) root.removeEventListener('focusout', root._tagOut);
        root._tagOut = (e) => { if (e.target.hasAttribute && e.target.hasAttribute('data-tag-input')) addTag(e.target); };
        root.addEventListener('focusout', root._tagOut);
        root.onclick = (e) => {
            const more = e.target.closest('[data-plines]');
            if (more) {
                const k = more.dataset.plines;
                if (openLines.has(k)) openLines.delete(k); else openLines.add(k);
                tabHtml = ''; drawPluginTab();
                return;
            }
            const chip = e.target.closest('.ptag');
            if (chip) {
                const set = chip.closest('.pset'), inp = set.querySelector('[data-tag-input]');
                chip.remove(); tagsChanged(set);
                if (inp.value.trim()) inp.focus();
                return chain(e);
            }
            const b = e.target.closest('button');
            const set = b && b.closest('.pset');
            if (b && set && set.dataset.type === 'list' && (b.hasAttribute('data-row-add') || b.dataset.rowDel != null)) {
                const rows = readRows(set);
                const open = openRows.get(set.dataset.key) || new Set();
                if (b.hasAttribute('data-row-add')) { rows.push(Object.fromEntries(Object.entries(listSpec(set).fields || {}).filter(([, f]) => f.type !== 'heading').map(([fk, f]) => [fk, fieldDefault(f)]))); open.add(rows.length - 1); }
                else { rows.splice(Number(b.dataset.rowDel), 1); open.clear(); }
                openRows.set(set.dataset.key, open);
                saveList(set, rows, true);
                set.querySelectorAll('.prow').forEach(rowReveal);
            } else if (b && b.dataset.rowToggle != null) {
                const i = Number(b.dataset.rowToggle), open = openRows.get(set.dataset.key) || new Set(), row = b.closest('.prow');
                if (open.has(i)) open.delete(i); else open.add(i);
                openRows.set(set.dataset.key, open);
                row.classList.toggle('shut', !open.has(i));
                b.textContent = open.has(i) ? T('pluginmodal.doneRow') : T('pluginmodal.editRow');
                if (!open.has(i)) refresh();
            } else if (b && (b.dataset.pick === 'every' || b.dataset.pick === 'clear')) {
                set.querySelectorAll('.pick:not([hidden]) [data-pick="acct"]').forEach(x => { x.checked = b.dataset.pick === 'every'; });
                ticked(set);
            } else if (b && b.dataset.smap != null) {
                smapOpen.set(b.dataset.smapKey, b.dataset.smap); smapSel.delete(b.dataset.smapKey); tabHtml = ''; drawPluginTab();
            } else if (b && b.dataset.smapPick != null) {
                smapSel.set(b.dataset.smapKey, b.dataset.smapPick); tabHtml = ''; drawPluginTab();
            } else if (b && b.dataset.choice != null) {
                set.querySelectorAll('[data-choice]').forEach(x => x.classList.toggle('on', x === b));
                save(set.dataset.key, b.dataset.choice);
            } else if (b && b.hasAttribute('data-pset-reload')) call('pluginReload', id).then(() => toast(T('toast.plugin.reloaded')));
            else if (b && b.dataset.paction) {
                const q = b.dataset.shop != null && b.parentElement.querySelector('[data-shop-qty]');
                if (q) {
                    const n = Math.max(1, Math.round(Number(q.value) / Number(q.dataset.pack)) || 1) * Number(q.dataset.pack);
                    const shop = b.closest('.pshop'), accts = shop && shop.dataset.shopAccts ? JSON.parse(shop.dataset.shopAccts) : [];
                    if (accts.length) {
                        shopPick(b, q, n, accts).then(ids => { if (ids && ids.length) { b.dataset.arg = JSON.stringify({ id: b.dataset.shop, n, accounts: ids }); pluginAction(id, b); } });
                        return chain(e);
                    }
                    b.dataset.arg = JSON.stringify({ id: b.dataset.shop, n });
                }
                // A picker shows the pick at once; the plugin's answer (a toast) and the redraw follow.
                if (b.classList.contains('ppick')) {
                    const box = b.closest('.ppicker');
                    if (box.classList.contains('multi')) b.classList.toggle('on');   // several can be picked: only this one flips
                    else box.querySelectorAll('.ppick').forEach(x => x.classList.toggle('on', x === b));
                }
                pluginAction(id, b);
            }
            // A step card's head opens / folds it (not when the click was on its switch).
            const head = !b && e.target.closest('[data-card]');
            if (head && !e.target.closest('.switch')) {
                const k = head.dataset.card;
                openCards.set(k, !head.closest('.pcard').classList.contains('open'));
                head.closest('.pcard').classList.toggle('open', openCards.get(k));
            }
            chain(e);
        };
    }

    // A shop block with accounts: after Buy, ask which accounts buy it (each one buys the amount with its own credits).
    async function shopPick(b, q, n, accts) {
        const packs = n / Number(q.dataset.pack), cost = packs * Number(q.dataset.price), unit = q.dataset.unit || '';
        const units = (c) => `${c.toLocaleString('en-US')}${unit ? ' ' + unit + (c === 1 ? '' : 's') : ''}`;
        const name = b.closest('.pshop-row').querySelector('.title').textContent;
        const rows = accts.map(a => { const short = Number(a.credits) < cost;
            return `<label class="pshop-acct${short ? ' short' : ''}"><input type="checkbox" value="${esc(a.id)}"${short ? ' disabled' : ''}><span>${esc(a.name)}</span><em>${short ? H('block.shop.pick.short') + ' · ' : ''}${esc(units(Number(a.credits) || 0))}</em></label>`; }).join('');
        let picked = [];
        const p = modal({ title: T('block.shop.pick.title', { count: n.toLocaleString('en-US'), name }), body: T('block.shop.pick.body', { cost: units(cost) }), ok: T('block.shop.pick.ok'),
            html: `<div class="pshop-accts"><label class="pshop-acct all"><input type="checkbox" data-shop-all><span>${H('block.shop.pick.all')}</span></label>${rows}</div>` });
        const box = $('#modal .modal-box');
        box.onchange = (e) => {
            const boxes = [...box.querySelectorAll('.pshop-accts input[value]:not(:disabled)')];
            if (e.target.hasAttribute('data-shop-all')) boxes.forEach(x => { x.checked = e.target.checked; });
            else box.querySelector('[data-shop-all]').checked = boxes.length > 0 && boxes.every(x => x.checked);
            picked = boxes.filter(x => x.checked).map(x => x.value);
        };
        if (!(await p)) return null;
        if (!picked.length) { toast(T('block.shop.pick.none')); return null; }
        return picked;
    }

    // A plugin's button (ctx.panel.action): runs it in the plugin, says how it went.
    async function pluginAction(id, b) {
        if (b.dataset.confirm && !(await modal({ title: b.textContent.trim(), body: b.dataset.confirm, ok: b.textContent.trim(), danger: b.classList.contains('danger') }))) return;
        b.disabled = true;
        await Promise.all([...pendingSaves]).catch(() => {});
        const r = await call('pluginAction', id, b.dataset.paction, b.dataset.arg || null);
        b.disabled = false;
        if (r && r.message) toast(r.message); else if (r && !r.ok) toast(r.error || T('toast.plugin.failed'));
        refresh();
    }

    // A plugin's own tab: blocks it returns from render(). Settings blocks show that plugin's
    // settings as live controls, so a plugin can lay out its whole setup here instead of a dialog.
    //   stats { items: [{ label, value }] } · table { columns, rows } · text { text } · notice { text, level: ok|warn|bad }
    //   buttons { items: [{ label, action, arg, primary, danger, confirm }] } · settings { keys }
    //   skillmap { action, maps: [{ name, image, note, count }], skills: [{ id, map, x, y (% of the picture), next: [ids],
    //   label, icon, cost, gives: [text], needs, owned, inPlan, missing, dependents }] } — a click picks a skill and shows its
    //   details beside the map; their button sends action with the skill's id
    //   picker { action, items: [{ id, title, sub, meta, on }] } — a list to pick one from; a click sends action with the id;
    //   shop { action, unit (singular: 'credit'), items: [{ id, name, sub, price, pack, max (packs affordable) }], accounts?: [{ id, name, credits }] }
    //        — a row each with an amount; with accounts, Buy first asks which of them buy it (arg gets accounts: [ids]);
    //   the button sends action with { id, n } (n in items, whole packs)
    //   card { title, text, toggle: <boolean key>, toggleInvert (switch on = setting off), toggleDisabled (why it can't be
    //   switched now), bodyWhenOff (its body shows with the switch off too), keys, blocks } · section { title, text, blocks }
    //   hero { title, text, pill, level, buttons } · flow { items: [{ label, sub, on }] } · tip { text }
    //   checklist { items: [{ label, done, hint }] } · list { key, summaries } (rows fold to their summary)
    //   card also: id + summary + open (folds), step (number), locked (why it can't be set up yet)
    const openCards = new Map();
    const openLines = new Set();   // picker entries whose long line list is shown in full (action + id)
    // A picker entry's lines: up to 3 as they are; more fold behind "Show all" (a toggle that doesn't pick the entry).
    const pickLines = (b, i) => {
        const lines = (i.lines || []).map(String), k = b.action + ':' + i.id, open = openLines.has(k), many = lines.length > 3;
        return `<div class="ppick-lines">${(many && !open ? lines.slice(0, 3) : lines).map(l => `<div class="desc">${esc(l)}</div>`).join('')}
            ${many ? `<span class="ppick-more" role="button" tabindex="0" data-plines="${esc(k)}" aria-expanded="${open}">${open ? H('block.picker.fewer') : H('block.picker.all', { n: lines.length })}</span>` : ''}</div>`;
    };
    const smapOpen = new Map();   // skill map block -> the map tab shown
    const smapSel = new Map();    // skill map block -> the skill picked
    // Skill icons by what the skill gives (drawn here: the panel loads no icon font).
    const SMAP_ICONS = {
        case: '<path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v8"/>',
        click: '<path d="M7 4l10 7-4.5 1.2L15 18l-2 1-2.3-5.5L7 16z"/>',
        vault: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M12 6v3M12 15v3"/>',
        inventory: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
        opens: '<path d="M5 8h14M5 12h14M5 16h14"/>',
        price: '<path d="M4 12V4h8l8 8-8 8z"/><circle cx="8.5" cy="8.5" r="1.5"/>',
        multi: '<path d="M7 7l10 10M17 7L7 17"/>',
    };
    const smapIcon = (icon) => `<svg class="psmap-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SMAP_ICONS[icon] || '<circle cx="12" cy="12" r="3"/>'}</svg>`;

    const btnsHtml = (items) => `<div class="pbtns">${(items || []).map(i => `<button class="${i.primary ? 'primary' : ''} ${i.danger ? 'danger' : ''}" data-paction="${esc(i.action)}" ${i.arg != null ? `data-arg="${esc(i.arg)}"` : ''} ${i.confirm ? `data-confirm="${esc(i.confirm)}"` : ''}>${esc(i.label)}</button>`).join('')}</div>`;
    // A shop row's button: "Buy 30 for 3 credits" (items come in packs; a pack costs price).
    const shopLabel = (qty, pack, price, unit) => { const packs = Math.max(1, Math.round(Number(qty) / pack) || 1); const cost = packs * Number(price); return T('block.shop.buy', { count: packs * pack, cost: `${cost}${unit ? ' ' + unit + (cost === 1 ? '' : 's') : ''}` }); };
    function pluginBlocks(blocks, p) {
        const setting = (k) => p.settings.find(x => x.key === k);
        const settingsHtml = (keys, bare) => `<div class="psets">${(keys || []).map(setting).filter(Boolean).map(x => (bare ? { ...x, label: '', help: '' } : x)).map(pluginSettingHtml).join('')}</div>`;
        return (blocks || []).map(b => {
            if (b.type === 'hero') return `<div class="phero ${esc(b.level || '')}"><div class="phero-main">${b.pill ? `<span class="ppill ${esc(b.level || '')}">${esc(b.pill)}</span>` : ''}
                <div class="phero-title">${esc(b.title || '')}</div>${b.text ? `<div class="phero-text">${esc(b.text)}</div>` : ''}</div>${b.buttons ? btnsHtml(b.buttons) : ''}</div>`;
            if (b.type === 'flow') return `<div class="pflow">${b.items.map((i, n) => `${n ? '<span class="pflow-arrow">→</span>' : ''}<div class="pflow-item${i.on ? ' on' : ''}"><b>${esc(i.label)}</b><span>${esc(i.on ? i.sub || '' : i.off || 'off')}</span></div>`).join('')}</div>`;
            if (b.type === 'tip') return `<div class="ptip"><b>${H('plugintab.tip')}</b> ${esc(b.text)}</div>`;
            if (b.type === 'checklist') return `<ul class="pcheck">${b.items.map(i => `<li class="${i.done ? 'done' : ''}"><span class="pcheck-mark">${i.done ? '✓' : ''}</span><div><div>${esc(i.label)}</div>${!i.done && i.hint ? `<div class="muted">${esc(i.hint)}</div>` : ''}</div></li>`).join('')}</ul>`;
            if (b.type === 'list') { const sp = setting(b.key); return sp ? `<div class="psets">${pluginSettingHtml({ ...sp, label: '', help: '', summaries: b.summaries || [] })}</div>` : ''; }
            if (b.type === 'stats') return `<div class="statrow">${b.items.map(i => `<div class="stat"><span>${esc(i.label)}</span><b>${esc(i.value)}</b></div>`).join('')}</div>`;
            if (b.type === 'table') return b.rows.length ? `<div class="table-wrap"><table${b.wrap ? ' class="wrap"' : ''}><thead><tr>${b.columns.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${b.rows.map(r => `<tr>${r.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
                : (b.empty ? `<p class="muted">${esc(b.empty)}</p>` : '');
            if (b.type === 'notice') return `<div class="pnotice ${esc(b.level || '')}">${esc(b.text)}</div>`;
            if (b.type === 'buttons') return `<div class="pbtns">${b.items.map(i => `<button class="${i.primary ? 'primary' : ''} ${i.danger ? 'danger' : ''}" data-paction="${esc(i.action)}" ${i.arg != null ? `data-arg="${esc(i.arg)}"` : ''} ${i.confirm ? `data-confirm="${esc(i.confirm)}"` : ''}>${esc(i.label)}</button>`).join('')}</div>`;
            if (b.type === 'settings') return settingsHtml(b.keys, b.bare);
            if (b.type === 'skillmap') {
                // Like the site's skill map page: a tab per map, the map picture with the skills on it, and the picked
                // skill's details beside it (with the button that adds it to the plan or takes it out). The shown map
                // and the picked skill are remembered per plugin while the panel is open.
                const maps = b.maps || [], k = p.id + ':' + (b.id || 'smap');
                const cur = maps.find(m => m.name === smapOpen.get(k)) || maps[0];
                if (!cur) return '';
                const skills = (b.skills || []).filter(s => s.map === cur.name), at = new Map(skills.map(s => [s.id, s]));
                const sel = at.get(smapSel.get(k));
                const lines = skills.flatMap(s => (s.next || []).map(n => at.get(n)).filter(Boolean).map(n =>
                    `<line x1="${s.x}" y1="${s.y}" x2="${n.x}" y2="${n.y}" class="${s.inPlan && n.inPlan ? 'on' : ''}"/>`)).join('');
                const node = (s) => `<button class="psmap-node${s.inPlan ? ' plan' : ''}${s.owned ? ' owned' : ''}${sel === s ? ' sel' : ''}" data-x="${Number(s.x)}" data-y="${Number(s.y)}" data-smap-pick="${esc(s.id)}" data-smap-key="${esc(k)}" aria-label="${esc(s.label)}">${smapIcon(s.icon)}</button>`;
                const side = !sel ? `<div class="psmap-side muted">${H('block.skillmap.pick')}</div>` : `<div class="psmap-side">
                    <div class="psmap-side-head">${smapIcon(sel.icon)}<div><div class="title">${esc(sel.label)}</div><div class="desc">${esc(sel.id)} · ${esc(cur.name)}</div></div></div>
                    <div class="psmap-facts"><div><span>${H('block.skillmap.price')}</span><b>${esc(sel.cost)}</b></div>${(sel.gives || []).map(g => `<div><span>${H('block.skillmap.gives')}</span><b>${esc(g)}</b></div>`).join('')}
                      <div><span>${H('block.skillmap.needs')}</span><b>${sel.needs ? esc(sel.needs) : H('block.skillmap.needsNothing')}</b></div>${sel.owned ? `<div><span>${H('block.skillmap.owned')}</span><b>${H('block.skillmap.ownedYes')}</b></div>` : ''}</div>
                    <button class="${sel.inPlan ? '' : 'primary'}" data-paction="${esc(b.action)}" data-arg="${esc(sel.id)}">${sel.inPlan ? H('block.skillmap.remove') : H('block.skillmap.add')}</button>
                    ${sel.inPlan && sel.dependents ? `<div class="desc">${H('block.skillmap.alsoRemoves', { what: sel.dependents })}</div>` : !sel.inPlan && sel.missing ? `<div class="desc">${H('block.skillmap.alsoAdds', { what: sel.missing })}</div>` : ''}
                  </div>`;
                return `<div class="psmap-wrap">
                    <div class="seg psmap-tabs">${maps.map(m => `<button class="${m === cur ? 'on' : ''}" data-smap="${esc(m.name)}" data-smap-key="${esc(k)}">${esc(m.name)}${m.count ? ` <span class="muted">${esc(m.count)}</span>` : ''}</button>`).join('')}</div>
                    ${cur.note ? `<div class="muted psmap-note">${esc(cur.note)}</div>` : ''}
                    <div class="psmap-layout">
                      <div class="psmap">${cur.image ? `<img src="${esc(cur.image)}" alt="">` : ''}<svg viewBox="0 0 100 100" preserveAspectRatio="none">${lines}</svg>${skills.map(node).join('')}</div>
                      ${side}
                    </div>
                    <div class="psmap-legend"><span><i class="psmap-dot plan"></i>${H('block.skillmap.legendPlan')}</span><span><i class="psmap-dot owned"></i>${H('block.skillmap.legendOwned')}</span><span><i class="psmap-dot"></i>${H('block.skillmap.legendNone')}</span></div>
                  </div>`;
            }
            if (b.type === 'picker') return `<div class="ppicker${b.grid ? ' grid' : ''}${b.multi ? ' multi' : ''}">${(b.items || []).map(i => `<button class="ppick${i.on ? ' on' : ''}" data-paction="${esc(b.action)}" data-arg="${esc(i.id)}"${b.multi ? ` aria-pressed="${i.on ? 'true' : 'false'}"` : ''}>
                <div class="ppick-head"><span class="title">${esc(i.title)}</span>${i.on ? `<span class="ppick-tag">${b.tag ? esc(b.tag) : H('block.picker.inUse')}</span>` : ''}</div>
                ${i.lines && i.lines.length ? pickLines(b, i) : i.sub ? `<div class="desc">${esc(i.sub)}</div>` : ''}${i.meta ?`<div class="ppick-meta">${esc(i.meta)}</div>` : ''}</button>`).join('')}</div>`;
            if (b.type === 'shop') return `<div class="pshop"${b.accounts && b.accounts.length ? ` data-shop-accts="${esc(JSON.stringify(b.accounts))}"` : ''}>${(b.items || []).map(i => { const n = i.pack || 1; return `<div class="pshop-row">
                <div class="pshop-name"><div class="title">${esc(i.name)}</div>${i.sub ? `<div class="desc">${esc(i.sub)}</div>` : ''}</div>
                <input type="number" min="${n}" step="${n}" value="${n}" data-shop-qty data-pack="${n}" data-price="${esc(i.price)}" data-unit="${esc(b.unit || '')}"${i.max != null ? ` max="${esc(i.max * n)}"` : ''}>
                <button class="small" data-paction="${esc(b.action)}" data-shop="${esc(i.id)}"${i.max === 0 ? ' disabled' : ''}>${esc(shopLabel(n, n, i.price, b.unit))}</button></div>`; }).join('')}</div>`;
            if (b.type === 'section') return `<section class="psection"><h4 class="plug-head">${esc(b.title || '')}</h4>${b.text ? `<p class="muted">${esc(b.text)}</p>` : ''}${pluginBlocks(b.blocks, p)}</section>`;
            if (b.type === 'card') {
                const tg = b.toggle && setting(b.toggle), on = !tg || (b.toggleInvert ? !tg.value : !!tg.value), body = (b.keys || []).length || (b.blocks || []).length;
                const k = b.id ? p.id + ':' + b.id : null, open = !k || (openCards.has(k) ? openCards.get(k) : b.open !== false);
                const cls = ['pcard', on ? '' : 'off', b.locked ? 'locked' : '', k ? 'folds' : '', open ? 'open' : '', b.done ? 'done' : ''].filter(Boolean).join(' ');
                return `<div class="${cls}">
                    <div class="pcard-head"${k && !b.locked ? ` data-card="${esc(k)}"` : ''}>${b.step != null ? `<span class="pstep">${b.done ? '✓' : esc(b.step)}</span>` : ''}
                      ${tg && !b.locked ? `<div class="pset" data-key="${esc(tg.key)}" data-type="boolean"><label class="switch"${b.toggleDisabled ? ` title="${esc(b.toggleDisabled)}"` : ''}><input type="checkbox" data-pset${b.toggleInvert ? ' data-invert' : ''} ${on ? 'checked' : ''}${b.toggleDisabled ? ' disabled' : ''}><i></i></label></div>` : ''}
                      <div class="pcard-titles"><div class="title">${esc(b.title || '')}</div>
                        ${b.locked ? `<div class="desc">${esc(b.locked)}</div>` : (b.summary && k ? `<div class="desc pcard-sum">${esc(b.summary)}</div>` : '')}
                        ${b.text && !b.locked ? `<div class="desc pcard-text">${esc(b.text)}</div>` : ''}</div>
                      ${k && !b.locked && body && (on || b.bodyWhenOff) ? `<span class="pcard-caret">⌄</span>` : ''}</div>
                    ${(on || b.bodyWhenOff) && body && !b.locked ? `<div class="pcard-body">${(b.keys || []).length ? settingsHtml(b.keys, b.bare) : ''}${pluginBlocks(b.blocks, p)}</div>` : ''}
                  </div>`;
            }
            return b.text ? `<p class="muted">${esc(b.text)}</p>` : '';
        }).join('');
    }

    let tabHtml = '', tabPressed = false, tabDrawLater = false;
    // Not while a button is held down in the tab: a field saving as it loses focus redraws the tab, and a redraw
    // between press and release would swallow the click. Drawn on release instead.
    document.addEventListener('pointerdown', (e) => { tabPressed = !!e.target.closest('#tab-plugin'); }, true);
    document.addEventListener('pointerup', () => { if (!tabPressed) return; tabPressed = false; if (tabDrawLater) { tabDrawLater = false; setTimeout(drawPluginTab, 0); } }, true);
    function drawPluginTab() {
        if (tabPressed) { tabDrawLater = true; return; }
        const t = S.tabs.find(x => 'plugin:' + x.plugin + ':' + x.title === tab);
        const c = t && t.content, p = t && S.plugins.find(x => x.id === t.plugin);
        const el = $('#tab-plugin');
        // Don't redraw under someone typing in one of its fields.
        const a = document.activeElement;
        if (a && el.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.type !== 'checkbox') return;
        const html = !c || !p ? `<div class="muted">${H('plugintab.empty')}</div>` : `<div class="ptab">${pluginBlocks(c.blocks, p)}</div>`;
        if (html === tabHtml && el.innerHTML) return;
        tabHtml = html;
        el.innerHTML = html;
        // Skill map nodes: placed from here (the page's rules don't allow inline style attributes).
        el.querySelectorAll('.psmap-node').forEach(n => { n.style.left = n.dataset.x + '%'; n.style.top = n.dataset.y + '%'; });
        if (p) bindSettings(el, p.id);
    }

    // --- log -----------------------------------------------------------------
    async function pullLogs() {
        const lines = await call('logs', logSince);
        if (!Array.isArray(lines) || !lines.length) return;
        logSince = lines[lines.length - 1].t;
        logLines = logLines.concat(lines).slice(-500);
        if (tab === 'log') drawLog();
    }

    function drawLog() {
        const el = $('#log'), atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        const only = $('#logProblems').checked;
        el.innerHTML = logLines.filter(l => !only || l.level === 'warn' || l.level === 'error').map(l =>
            `<div class="${l.level}"><span class="t">${new Date(l.t).toLocaleTimeString()}</span> ${l.name ? esc(l.name) + ': ' : ''}${esc(l.msg)}</div>`).join('') || `<div class="muted">${H('log.empty')}</div>`;
        if (atBottom) el.scrollTop = el.scrollHeight;
    }

    // --- settings ------------------------------------------------------------
    // A switch row; its title and description are settings.<key>.title / .desc (or the keys given).
    function sw(key, on, textKey = key) {
        return `<div class="row"><label class="switch"><input type="checkbox" data-act="setting" data-key="${key}" ${on ? 'checked' : ''}><i></i></label>
            <div class="main"><div class="title">${H(`settings.${textKey}.title`)}</div><div class="desc">${H(`settings.${textKey}.desc`)}</div></div></div>`;
    }
    const row = (k, extra = '') => `<div class="row"><div class="main"><div class="title">${H(`settings.${k}.title`)}</div><div class="desc">${H(`settings.${k}.desc`)}</div></div>${extra}</div>`;

    function drawSettings() {
        const s = S.settings, w = s.panelWeb;
        $('#tab-settings').innerHTML = `
        <div class="rows">
          <div class="section-title">${H('settings.section.clicking')}</div>
          <div class="row"><div class="main"><div class="title">${H('settings.main.title')}</div><div class="desc">${s.main && s.main.userId ? H('settings.main.is', { name: esc(s.main.name || s.main.userId) }) : H('settings.main.none')}</div></div>
            <button class="small" data-act="setMain">${H(s.main && s.main.userId ? 'settings.main.change' : 'main.set')}</button></div>
          ${sw('resumeOnLaunch', s.resumeOnLaunch, 'resume')}
          <div class="row"><div class="main"><div class="title">${H('settings.auto.title')}</div><div class="desc">${H('settings.auto.desc')}</div></div>
            <label><input type="number" min="0" max="100" step="0.01" value="${s.autoCasePct}" data-act="setting" data-key="autoCasePct"> %</label>
            <div class="extra"><button class="small" data-act="allAuto">${H('settings.auto.all')}</button></div></div>
          ${row('caseValue')}
          <div class="row"><div class="main"><div class="title">${H('settings.maxPerIp.title')}</div><div class="desc">${H('settings.maxPerIp.desc', { max: 20 })}</div></div>
            <input type="number" min="1" max="20" value="${s.maxPerIp}" data-act="setting" data-key="maxPerIp"></div>

          <div class="section-title">${H('settings.section.app')}</div>
          ${sw('startMinimized', s.startMinimized)}
          ${S.platform === 'win32' ? sw('startWithSystem', s.startWithSystem) : ''}
          ${sw('closeToTray', s.closeToTray)}
          ${sw('cleanOldSignIns', s.cleanOldSignIns !== false)}
          ${S.stats && S.stats.available ? sw('shareStats', s.shareStats)
              + row('statsPreview', `<button class="small" data-act="statsPreview">${H('settings.statsPreview.button')}</button>`) : ''}

          <div class="section-title">${H('settings.section.web')}</div>
          <div class="row">
            <label class="switch"><input type="checkbox" data-act="web" ${w.enabled ? 'checked' : ''}><i></i></label>
            <div class="main"><div class="title">${H('settings.web.title')}</div>
              <div class="desc">${H('settings.web.desc', { port: w.port })}</div></div>
            <div class="extra">
              <label>${H('settings.web.port')} <input type="number" id="webPort" value="${w.port}" min="1024" max="65535"></label>
              <label>${H('settings.web.password')} <input type="password" id="webPass" placeholder="${w.hasPassword ? H('settings.web.passwordSet') : H('settings.web.passwordRequired')}"></label>
              <button class="small" data-act="webSave">${H('settings.web.save')}</button>
            </div>
          </div>

          <div class="section-title">${H('settings.section.help')}</div>
          <div class="row"><div class="main"><div class="title">${H('settings.version.title', { version: S.version })}</div><div class="desc" id="updateText">${updateText()}</div></div>
            ${S.update && S.update.status !== 'off' ? `<button class="small" data-act="checkUpdates">${H('settings.update.check')}</button>` : ''}</div>
          ${S.update && S.update.status !== 'off' ? sw('testBuilds', s.testBuilds) : ''}
          ${row('tour', `<button class="small" data-act="tour">${H('settings.tour.button')}</button>`)}
          ${row('whatsnew', `<button class="small" data-act="whatsNew">${H('settings.whatsnew.button')}</button>`)}

          <div class="section-title">${H('settings.section.advanced')}</div>
          ${sw('allowUnverifiedPlugins', s.allowUnverifiedPlugins, 'unverified')}
          ${webLook ? '' : row('data', `<button class="small" data-act="openDataFolder">${H('settings.data.button')}</button>`)
              + row('quit', `<button class="small danger" data-act="quit">${H('settings.quit.button')}</button>`)}
        </div>`;
    }

    // Income over the last 24 hours: hourly averages of the header's estimate (core/income.js).
    async function showIncome() {
        const hours = (await call('incomeHistory')) || [];
        const last = hours.slice(-24), max = Math.max(1, ...last.map(h => h.avg));
        const sum24 = last.reduce((t, h) => t + h.avg, 0), sum7 = hours.reduce((t, h) => t + h.avg, 0);
        const bars = last.map(h => `<div class="ibar" title="${esc(new Date(h.h).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }))} · ${esc(money(h.avg))}/h · ${h.clicking}">
            <i data-h="${Math.max(2, Math.round(h.avg / max * 100))}"></i><span>${new Date(h.h).getHours()}</span></div>`).join('');
        const html = last.length ? `<div class="statrow"><div class="stat"><span>${H('income.last24')}</span><b>${esc(money(sum24))}</b></div>
              <div class="stat"><span>${H('income.last7')}</span><b>${esc(money(sum7))}</b></div></div>
            <div class="ichart">${bars}</div><div class="muted">${H('income.note')}</div>` : `<div class="muted">${H('income.empty')}</div>`;
        const p = modal({ title: T('income.title'), html, cancel: false, ok: T('pluginmodal.done'), wide: true });
        document.querySelectorAll('#modal .ichart i').forEach(i => { i.style.height = i.dataset.h + '%'; });
        return p;
    }

    // The Settings line under the version: what the updater is doing.
    function updateText() {
        const u = S.update || { status: 'off' };
        switch (u.status) {
            case 'checking': return H('settings.update.checking');
            case 'none': return H('settings.update.none', { ago: ago(u.checkedAt) });
            case 'downloading': return H('settings.update.downloading', { version: u.version, percent: u.percent || 0 });
            case 'ready': return H('settings.update.ready', { version: u.version });
            case 'error': return H('settings.update.error', { error: u.error || '' });
            case 'off': return H('settings.update.off');
            default: return H('settings.update.idle');
        }
    }

    // --- walkthrough ---------------------------------------------------------
    // Runs once on first open (settings.tourDone), or from Settings. Each step highlights the real
    // part of the panel it explains; the card steps use a sample card, since a first open has none.
    // Step wording: tour.<n>.title / tour.<n>.text.
    const SAMPLE = {
        id: 'tour', type: 'auto', clickType: 'cases', status: 'clicking', hasToken: true,
        startedAt: 1, clicks: 12500, lastClickOkAt: 0, vaultEveryMin: 16.1, clickIntervalMs: 60000,
        me: { money: 4_820_000, tokens: 312, casesPerClick: 50, moneyPerClick: 3 },
        perHour: { total: 124950, cases: 15000, caseValue: 6.75, vault: 23700, clickMoney: 0 },
        badges: ['Missions 2/3 done'], issues: [],
    };

    const TOUR = [
        {}, { el: '#add' }, { el: '#summary' }, { sample: 'hero' }, { sample: 'meters' },
        { sample: 'kv' }, { sample: 'foot' }, { el: '#tabs' }, { el: '#report' }, { finish: true },
    ];

    let tourAt = -1, tourEls = null;

    function startTour(at = 0) {
        if (tourAt >= 0) { tourAt = at; drawTour(); return; }
        tab = 'accounts';
        tourEls = { veil: document.createElement('div'), hole: document.createElement('div'), box: document.createElement('div') };
        tourEls.veil.className = 'tour-veil';
        tourEls.hole.className = 'tour-hole';
        tourEls.box.className = 'tour-box';
        tourEls.box.setAttribute('role', 'dialog');
        document.body.append(tourEls.veil, tourEls.hole, tourEls.box);
        tourAt = at;
        drawTour();
        document.addEventListener('keydown', tourKeys);
        window.addEventListener('resize', drawTour);
    }

    function endTour(save = true) {
        if (tourAt < 0) return;
        for (const n of Object.values(tourEls)) n.remove();
        tourAt = -1; tourEls = null;
        document.removeEventListener('keydown', tourKeys);
        window.removeEventListener('resize', drawTour);
        if (save && !studio) call('setSettings', { tourDone: true });
    }

    function tourKeys(e) {
        if (e.key === 'Escape') endTour();
        if (e.key === 'ArrowRight') tourStep(1);
        if (e.key === 'ArrowLeft') tourStep(-1);
    }

    function tourStep(d) {
        const n = tourAt + d;
        if (n < 0) return;
        if (n >= TOUR.length) return endTour();
        tourAt = n; drawTour();
    }

    function drawTour() {
        if (tourAt < 0) return;
        const step = TOUR[tourAt], n = tourAt + 1, { box, hole, veil } = tourEls;
        const vars = { max: S ? S.maxPerIp : 20, auto: S ? S.settings.autoCasePct : 33.34 };
        let sample = null;
        if (step.sample) {
            const c = newCard('tour');
            updateCard(c, { ...SAMPLE, name: T('tour.sample.name'), nextClickAt: now() + 23000, vault: { cap: 12725, perMin: 395, lastAt: now() - 9 * 60000 } });
            c.el.classList.add('tour-card', 'focus-' + step.sample);
            sample = c.el;   // the node itself: its bar widths are styles the CSP wouldn't allow as HTML
        }
        box.innerHTML = `
            <div class="tour-text">
              <div class="tour-count">${H('tour.count', { n, total: TOUR.length })}</div>
              <h3>${H(`tour.${n}.title`, vars)}</h3>
              <p>${H(`tour.${n}.text`, vars)}</p>
              <div class="tour-btns">
                <button class="ghost" data-tour="skip">${step.finish ? H('tour.close') : H('tour.skip')}</button>
                <span class="grow"></span>
                ${tourAt ? `<button data-tour="back">${H('tour.back')}</button>` : ''}
                ${step.finish ? `<button class="primary" data-tour="add">${H('tour.add')}</button>` : `<button class="primary" data-tour="next">${H('tour.next')}</button>`}
              </div>
            </div>`;
        if (sample) box.prepend(sample);
        box.classList.toggle('wide', !!step.sample);
        box.onclick = (e) => {
            const b = e.target.closest('[data-tour]');
            if (!b) return;
            const k = b.dataset.tour;
            if (k === 'next') tourStep(1);
            else if (k === 'back') tourStep(-1);
            else if (k === 'skip') endTour();
            else if (k === 'add') { endTour(); act({ dataset: { act: 'add' } }, {}); }
        };

        // Spotlight the real element; steps without one center the box over a dimmed page.
        const target = step.el && document.querySelector(step.el);
        const r = target && target.getBoundingClientRect();
        veil.classList.toggle('solid', !r);
        hole.hidden = !r;
        const vw = window.innerWidth, vh = window.innerHeight, pad = 6;
        if (r) {
            Object.assign(hole.style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
            const bw = Math.min(380, vw - 32), bh = box.offsetHeight;
            let top = r.bottom + 16;
            if (top + bh > vh - 16) top = Math.max(16, r.top - bh - 16);
            const left = Math.min(Math.max(16, r.left + r.width / 2 - bw / 2), vw - bw - 16);
            Object.assign(box.style, { left: left + 'px', top: top + 'px', width: bw + 'px', transform: 'none' });
        } else {
            Object.assign(box.style, { left: '50%', top: '50%', width: '', transform: 'translate(-50%, -50%)' });
        }
        const first = box.querySelector('[data-tour="next"], [data-tour="add"]');
        if (first) first.focus({ preventScroll: true });
    }

    // --- refresh loop ----------------------------------------------------
    let settingsDrawn = false, tourOffered = false, whatsNewShown = false;
    async function refresh() {
        try { S = await call('state'); clockOffset = S.now - Date.now(); }
        catch (e) { $('#summary').textContent = T('header.unreachable'); return; }
        if (studio) studioAdjust(S);
        drawHeader(); drawBanners(); drawTabs();
        if (!S.settings.tourDone && !tourOffered && !studio) { tourOffered = true; setTimeout(startTour, 300); }
        else if (S.whatsNew && S.settings.tourDone && !whatsNewShown && !studio) { whatsNewShown = true; setTimeout(() => showWhatsNew(false), 300); }
        if (tab === 'accounts') drawAccounts();
        else if (tab === 'overview') drawOverview();
        else if (tab === 'plugins') drawPlugins();
        else if (tab.startsWith('plugin:')) drawPluginTab();
        else if (tab === 'settings' && !settingsDrawn) { drawSettings(); settingsDrawn = true; }
        else if (tab === 'settings') { const u = $('#updateText'); if (u) setHtml(null, updateText(), u); }
        if (TR.open) { if (TR.view === 'clicks') pullClicks(); else drawTrouble(); }
    }

    async function act(el, e) {
        const a = el.dataset.act, id = el.dataset.id;
        switch (a) {
            case 'menu': { const m = cards.get(id).f.menu; closeMenus(m); m.hidden = !m.hidden; return; }
            case 'tabGroup': {
                const g = el.dataset.group, m = el.parentNode.querySelector('.tab-menu');
                closeMenus(m);
                openGroup = openGroup === g ? null : g;
                m.hidden = openGroup !== g;
                // Keep it on screen in a narrow window: shift it left as far as it would spill over the right edge.
                if (!m.hidden) placeTabMenu(m);
                el.setAttribute('aria-expanded', String(openGroup === g));
                return;
            }
            case 'compact': {
                compact = !compact;
                try { localStorage.setItem('zsb.compactCards', compact ? '1' : '0'); } catch (_) {}
                applyCompact();
                return;
            }
            case 'ovSort': {
                const k = el.dataset.key;
                ovSort = ovSort.key === k ? { key: k, dir: -ovSort.dir } : { key: k, dir: ['name', 'folder', 'status'].includes(k) ? 1 : -1 };
                drawOverview(); return;
            }
            case 'folderMenu': { const m = sections.get(id).f.menu; closeMenus(m); m.hidden = !m.hidden; return; }
            case 'moveTo': { const acc = S.accounts.find(x => x.id === id); if (acc) await pickFolder(acc); break; }
            case 'folderNew': {
                const name = await modal({ title: T('folders.new.title'), input: '', ok: T('folders.new.ok') });
                if (name != null && name.trim()) { await call('folderAdd', name.trim()); toast(T('folders.new.toast')); }
                break;
            }
            case 'folderToggle': {
                // The whole heading toggles; its grip and the open menu don't.
                if (e && e.target && e.target.closest && e.target.closest('.grip, .menu')) return; const f = (S.folders || []).find(x => x.id === id); if (f) await call('folderUpdate', id, { collapsed: !f.collapsed }); break; }
            case 'folderRename': {
                const f = (S.folders || []).find(x => x.id === id);
                const v = await modal({ title: T('folders.rename.title'), input: f ? f.name : '', ok: T('modal.rename.ok') });
                if (v != null && v.trim()) await call('folderUpdate', id, { name: v.trim() });
                break;
            }
            case 'folderRemove': {
                const f = (S.folders || []).find(x => x.id === id);
                if (await modal({ title: T('folders.remove.title', { name: f ? f.name : '' }), body: T('folders.remove.body'), ok: T('folders.remove.ok'), danger: true })) await call('folderRemove', id);
                break;
            }
            case 'folderStart': {
                const r = await call('folderStart', id);
                const codes = Object.values((r && r.results) || {}).map(x => x && !x.ok && x.code);
                if (codes.includes('CC-RATE-01')) toast(T('toast.limit', { max: S.maxPerIp }));
                break;
            }
            case 'folderStop': await call('folderStop', id); break;
            case 'trouble': openTrouble(el.dataset.view, el.dataset.id || null); return;
            case 'tab': tab = el.dataset.tab; settingsDrawn = false; if (tab === 'log') drawLog(); break;
            case 'add': case 'relogin': {
                toast(web ? T('toast.login.web') : T('toast.login.app'));
                const r = await call(a === 'add' ? 'addAccount' : 'relogin', id);
                if (r && r.ok) toast(r.replaced ? T('toast.login.again') : a === 'add' ? T('toast.login.added') : T('toast.login.again'));
                else if (r && r.error) toast(r.error === 'A login window is already open' ? T('toast.login.alreadyOpen') : T('toast.login.unfinished'));
                break;
            }
            case 'setMain': await setMainModal(); break;
            case 'importStop': await call('importStop'); break;
            case 'importDismiss': await call('importDismiss'); break;
            case 'dismissIssue': await call('dismissIssue', el.dataset.acct || null, el.dataset.code); break;
            case 'start': { const r = await call('start', id); if (r && !r.ok && r.code === 'CC-RATE-01') toast(T('toast.limit', { max: S.maxPerIp })); else if (r && !r.ok && r.code === 'CC-AUTH-08') toast(T('toast.dupe')); else if (r && !r.ok && r.code === 'CC-MAIN-01') setMainModal(); break; }
            case 'stop': await call('stop', id); break;
            case 'busyTest': { const r = await call('troubleBusyTest', id); toast(r && r.ok ? T('busy.started') : busyWhy(r)); break; }
            case 'busyStop': await call('troubleBusyStop', id); break;
            case 'type': await call('setType', id, el.dataset.type); break;
            case 'rename': {
                const acc = S.accounts.find(x => x.id === id);
                const v = await MODALS.rename(acc && acc.name);
                if (v != null && v.trim()) await call('rename', id, v.trim());
                break;
            }
            case 'remove': {
                const acc = S.accounts.find(x => x.id === id);
                if (await MODALS.remove(acc && acc.name)) await call('remove', id);
                break;
            }
            case 'openCheck': if (web) toast(T('toast.check.web')); await call('openCheck', el.dataset.route || ''); break;
            case 'pluginToggle': {
                const on = el.dataset.on === '1';
                const r = await call('pluginEnable', id, on);
                if (r && !r.ok) toast(r.error || T('toast.plugin.failed'));
                else if (on) {
                    await refresh();
                    // Nothing runs until accounts are chosen, so ask right away — in its own tab if it has one.
                    const p = S.plugins.find(x => x.id === id);
                    if (p && p.tab && p.state === 'running') { tab = 'plugin:' + p.id + ':' + p.tab; settingsDrawn = false; await refresh(); return; }
                    if (p && needsAccounts(p)) { pluginModal(id); return; }
                    toast(T('toast.plugin.on', { name: p ? p.name : id }));
                }
                break;
            }
            case 'pluginOpen': pluginModal(id); return;
            case 'pluginInstall': {
                const e = catalogEntry(id);
                toast(T('toast.plugin.installing', { name: e ? e.name : id }));
                el.disabled = true;
                const r = await call('pluginInstall', id);
                toast(r && r.ok ? T('toast.plugin.installed', { name: e ? e.name : id, version: e ? e.version : '' })
                    : T('plugins.err.' + ((r && r.code) || 'download')));
                break;
            }
            case 'pluginRemove': {
                const p = S.plugins.find(x => x.id === id);
                const r = await call('pluginRemove', id);
                if (r && r.ok) toast(T('toast.plugin.removed', { name: p ? p.name : id }));
                break;
            }
            case 'pluginCatalog': await call('pluginCatalog'); break;
            case 'setting': {
                if (e.type !== 'change') return;
                const v = el.type === 'checkbox' ? el.checked : el.value;
                S.settings = await call('setSettings', { [el.dataset.key]: v });
                if (el.dataset.key === 'maxPerIp') el.value = S.settings.maxPerIp;
                break;
            }
            case 'web': if (e.type === 'change') { await saveWeb({ enabled: el.checked }); } break;
            case 'webSave': await saveWeb({ enabled: true }); break;
            case 'openDataFolder': await call('openDataFolder'); break;
            case 'tour': settingsDrawn = false; startTour(); return;
            case 'whatsNew': showWhatsNew(true); return;
            case 'statsPreview': showStats(); return;
            case 'incomeChart': showIncome(); return;
            case 'checkUpdates': await call('checkUpdates'); break;
            case 'installUpdate': toast(T('update.restarting')); await call('installUpdate'); return;
            case 'allAuto': await call('setAllType', 'auto'); toast(T('toast.allAuto')); break;
            case 'quit': if (await MODALS.quit()) call('quit'); break;
            default: return;
        }
        refresh();
    }

    async function saveWeb(patch) {
        const pass = $('#webPass').value, port = $('#webPort').value;
        if (patch.enabled && !pass && !S.settings.panelWeb.hasPassword) { toast(T('toast.web.needsPassword')); settingsDrawn = false; return; }
        S.settings = await call('setSettings', { panelWeb: { ...patch, port, ...(pass ? { password: pass } : {}) } });
        toast(S.settings.panelWeb.enabled ? T('toast.web.on', { port: S.settings.panelWeb.port }) : T('toast.web.off'));
        settingsDrawn = false;
    }

    async function copyReport() {
        if (!web) { await call('copyReport'); toast(T('toast.report.app')); return; }
        const text = await call('report');
        try { await navigator.clipboard.writeText(text); toast(T('toast.report.web')); }
        catch (_) {   // plain http isn't a "secure context" for the clipboard API
            const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); toast(T('toast.report.web')); } catch (_) { toast(T('toast.report.failed')); }
            ta.remove();
        }
    }

    // --- Troubleshoot window -------------------------------------------------------
    // Report (copy it, with what's wrong right now), Sessions (where each account is signed in, signing those out) and
    // Clicks (refused and missed batches per account, the likely cause, each connection). Sessions are asked for only
    // while that view is open, three accounts at a time.
    const TR = { open: false, view: 'report', sess: new Map(), openRows: new Set(), clicks: null, busy: false, queue: null, testing: false };
    const trBox = () => $('#trouble .modal-box');
    const plural = (n) => (n === 1 ? T('trouble.report.one') : T('trouble.report.many', { n }));
    const fmtDate = (t) => (t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) : '—');

    function openTrouble(view, id) {
        TR.open = true; TR.view = view || TR.view;
        $('#trouble').hidden = false;
        drawTrouble();
        trBox().querySelector('[data-tr="close"]').focus();
        if (TR.view === 'clicks') pullClicks();
        if (TR.view === 'sessions') { if (id) showSessionsOf(id); else if (!TR.sess.size) checkSessions(); }
    }
    // Sessions with one account's list open and in view (from its card, or from a row in Clicks).
    async function showSessionsOf(id) {
        TR.view = 'sessions'; TR.openRows.add(id);
        const rest = !TR.sess.size;
        TR.sess.set(id, { state: 'loading' }); drawTrouble();
        const r = await call('troubleSessions', id).catch(() => ({ ok: false, why: 'net' }));
        if (rest) checkSessions(id);   // the other accounts, behind it
        TR.sess.set(id, r); drawTrouble();
        call('troubleSeen', id).catch(() => {});   // after the list is in: its "New" marks stay on screen this time
        const row = trBox().querySelector(`[data-tr="row"][data-id="${CSS.escape(id)}"]`);
        if (row) { row.scrollIntoView({ block: 'nearest' }); row.focus(); }
    }
    function closeTrouble() {
        TR.open = false; TR.queue = null;
        $('#trouble').hidden = true;
        lastHtml.delete(trBox());
        $('#report').focus();
    }

    // Where a session or account is: this PC, a proxy's name, or the IP.
    function viaText(via, ip) {
        if (via === 'direct') return T('trouble.via.direct');
        if (via) { const r = TR.clicks && TR.clicks.routes.find(x => x.id === via); return (r && r.label) || via; }
        return ip ? T('trouble.via.unknown', { ip }) : '—';
    }

    function troubleReport() {
        const codes = new Map();
        for (const i of S.appIssues) { const c = codes.get(i.code) || { i, app: false, n: 0 }; c.app = true; codes.set(i.code, c); }
        for (const a of S.accounts) for (const i of a.issues) { const c = codes.get(i.code) || { i, app: false, n: 0 }; c.n++; codes.set(i.code, c); }
        const rows = [...codes.values()].map(c => `<li><span class="code">${esc(c.i.code)}</span> <span>${esc(issueText(c.i))}</span>
            <span class="muted tr-count">${[c.app ? H('trouble.report.app') : '', c.n ? esc(plural(c.n)) : ''].filter(Boolean).join(' · ')}</span></li>`).join('');
        return `<p class="muted">${H('trouble.report.body')}</p>
            <div class="tr-sub">${H('trouble.report.problems')}</div>
            ${rows ? `<ul class="tr-issues">${rows}</ul>` : `<div class="tr-empty">${H('trouble.report.none')}</div>`}
            <div class="btns"><button class="primary" data-tr="copy">${H('trouble.report.copy')}</button></div>`;
    }

    function sessionSummary(x) {
        if (!x || x.state === 'waiting') return `<span class="muted">${H('trouble.sessions.waiting')}</span>`;
        if (x.state === 'loading') return `<span class="muted">${H('trouble.sessions.loading')}</span>`;
        if (!x.ok) return `<span class="tr-bad">${x.why === 'auth' ? H('trouble.sessions.loggedOut') : H('trouble.sessions.failed', { why: x.why })}</span>`;
        const parts = [];
        if (x.others) parts.push(`<span class="tr-warn">${H('trouble.sessions.elsewhere', { n: x.others })}</span>`);
        if (x.earlier) parts.push(`<span class="muted">${H('trouble.sessions.earlier', { n: x.earlier })}</span>`);
        if (!x.found) parts.push(`<span class="muted">${H('trouble.sessions.notFound')}</span>`);
        return parts.length ? parts.join(' · ') : `<span class="muted">${H('trouble.sessions.onlyHub')}</span>`;
    }

    function troubleSessions() {
        const earlier = [...TR.sess.values()].reduce((n, x) => n + (x.ok ? x.earlier : 0), 0);
        const rows = S.accounts.map(a => {
            const x = TR.sess.get(a.id), open = TR.openRows.has(a.id) && x && x.ok;
            const list = open ? `<ul class="tr-sessions">${x.sessions.map(s => `<li>
                    <div><b>${H('trouble.kind.' + s.kind)}</b>${s.fresh ? ` <span class="tr-warn">${H('trouble.session.new')}</span>` : ''} <span class="muted">· ${esc(s.app)}${s.os ? ' · ' + esc(s.os) : ''}</span></div>
                    <div class="muted">${esc(viaText(s.via, s.ip))} · ${H('trouble.session.since', { date: esc(fmtDate(s.createdAt)) })}</div>
                    ${s.kind === 'this' ? '' : `<button class="small" data-tr="signOut" data-id="${esc(a.id)}" data-sid="${esc(s.sid)}">${H('trouble.session.signOut')}</button>`}
                </li>`).join('')}</ul>
                ${x.sessions.some(s => s.kind !== 'this') && x.found ? `<div class="btns"><button class="small danger" data-tr="everywhere" data-id="${esc(a.id)}">${H('trouble.everywhere')}</button></div>` : ''}` : '';
            return `<li class="tr-acct${open ? ' open' : ''}">
                <button class="tr-row" data-tr="row" data-id="${esc(a.id)}" aria-expanded="${open}" ${x && x.ok ? '' : 'disabled'}>
                    <span class="tr-name">${esc(a.name)}${folderTag(a.id)}</span><span class="tr-sum">${sessionSummary(x)}</span></button>${list}</li>`;
        }).join('');
        return `<p class="muted">${H('trouble.sessions.body')}</p>
            <div class="tr-tools"><button class="small" data-tr="check" ${TR.queue ? 'disabled' : ''}>${H('trouble.sessions.check')}</button>
            ${earlier ? `<button class="small" data-tr="clean">${H('trouble.sessions.clean', { n: earlier })}</button>` : ''}</div>
            <ul class="tr-accts">${rows}</ul>`;
    }

    // The always-on check: clicks the site counted beyond the hub's own, over the last stretch.
    function extraResult(x) {
        if (!x) return '';
        return x.found
            ? `<div class="small tr-bad">${H('trouble.extra.found', { money: Math.max(0, x.money).toLocaleString('en-US'), cases: Math.max(0, x.cases).toLocaleString('en-US'), min: x.minutes })}</div>`
            : `<div class="small muted">${H('trouble.extra.none', { min: x.minutes })}</div>`;
    }
    function busyResult(b) {
        if (!b) return '';
        const cls = { running: 'muted', found: 'tr-bad', clear: 'tr-ok', stopped: 'muted', failed: 'tr-warn' }[b.state] || 'muted';
        return `<div class="small ${cls}">${H('busy.result.' + b.state, { what: esc(b.what || ''), secs: b.secs || 0, min: Math.round((b.secs || 0) / 6) / 10 })}</div>`;
    }
    const CAUSE_CLASS = { ok: 'muted', own: 'tr-warn', elsewhere: 'tr-bad', ip: 'tr-warn', behind: 'tr-warn' };
    function troubleClicks() {
        const c = TR.clicks;
        if (!c) return `<p class="muted">${H('trouble.clicks.body')}</p>`;
        const order = { elsewhere: 0, own: 1, ip: 2, behind: 3, ok: 4 };
        const live = c.accounts.filter(a => a.running).sort((a, b) => order[a.cause] - order[b.cause] || (b.refused + b.ipRefused) - (a.refused + a.ipRefused));
        const rows = live.map(a => `<tr><td class="tr-name">${esc(a.name)}${folderTag(a.id)}</td><td>${esc(viaText(a.route))}</td>
            <td class="num">${a.refused}</td><td class="num">${a.ipRefused}</td><td class="num">${a.missed}<span class="muted">/${a.due}</span></td>
            <td class="${CAUSE_CLASS[a.cause]}">${H('trouble.cause.' + a.cause)}${a.cause === 'own' || a.cause === 'elsewhere' ? ` <button class="small" data-tr="toSessions" data-id="${esc(a.id)}">${H('trouble.tab.sessions')}</button>` : ''}${(a.cause === 'own' || a.cause === 'elsewhere' || a.cause === 'behind') && !(a.busy && a.busy.state === 'running') ? ` <button class="small" data-tr="busy" data-id="${esc(a.id)}" title="${esc(T('busy.tip'))}">${H(a.busy ? 'busy.again' : 'busy.btn')}</button>` : ''}${busyResult(a.busy)}${extraResult(a.extra)}</td></tr>`).join('');
        const routeName = (id) => { const r = c.routes.find(x => x.id === id); return id === 'direct' ? T('trouble.via.direct') : (r && r.label) || id; };
        const tested = new Map(((c.tested && c.tested.routes) || []).map(x => [x.id, x]));
        const routes = c.routes.map(r => {
            const t = tested.get(r.id), ip = (t && t.ip) || r.ip;
            const test = !t ? '' : !t.ok ? `<span class="tr-bad">${H('trouble.routes.failed', { why: esc(t.error) })}</span>`
                : `<span class="${t.ms > 3000 ? 'tr-warn' : 'muted'}">${H(t.ms > 3000 ? 'trouble.routes.slow' : 'trouble.routes.ms', { ms: t.ms })}</span>`
                    + (t.sharedWith.length ? ` <span class="tr-warn">${H('trouble.routes.shared', { names: esc(t.sharedWith.map(routeName).join(', ')) })}</span>` : '');
            return `<li><b>${esc(routeName(r.id))}</b>
            <span class="muted">${ip ? esc(ip) : H('trouble.routes.noIp')}</span>${test}
            <span>${r.down ? `<span class="tr-bad">${H('trouble.routes.down')}</span>` : H('trouble.routes.used', { used: r.used, max: r.max })}</span></li>`;
        }).join('');
        return `<p class="muted">${H('trouble.clicks.body')}</p>
            ${live.length ? `<div class="table-wrap"><table class="tr-table"><thead><tr><th>${H('trouble.clicks.account')}</th><th>${H('trouble.clicks.route')}</th>
                <th class="num">${H('trouble.clicks.refused')}</th><th class="num">${H('trouble.clicks.ip')}</th><th class="num">${H('trouble.clicks.missed')}</th><th>${H('trouble.clicks.cause')}</th></tr></thead>
                <tbody>${rows}</tbody></table></div>` : `<div class="tr-empty">${H('trouble.clicks.none')}</div>`}
            <div class="tr-sub tr-subrow"><span>${H('trouble.routes.title')}</span><button class="small" data-tr="test" ${TR.testing ? 'disabled' : ''}>${H(TR.testing ? 'trouble.routes.testing' : 'trouble.routes.test')}</button></div><ul class="tr-routes">${routes}</ul>`;
    }

    function drawTrouble() {
        if (!TR.open || !S) return;
        const tabs = ['report', 'sessions', 'clicks'].map(v => `<button role="tab" aria-selected="${TR.view === v}" class="${TR.view === v ? 'on' : ''}" data-tr="view" data-view="${v}">${H('trouble.tab.' + v)}</button>`).join('');
        const body = TR.view === 'sessions' ? troubleSessions() : TR.view === 'clicks' ? troubleClicks() : troubleReport();
        setHtml(null, `<div class="tr-head"><h3 id="troubleTitle">${H('trouble.title')}</h3><button class="small ghost" data-tr="close" aria-label="${H('trouble.close')}">${H('trouble.close')}</button></div>
            <div class="seg tr-tabs" role="tablist">${tabs}</div><div class="tr-body">${body}</div>`, trBox());
    }

    async function pullClicks() {
        if (!TR.open || TR.view !== 'clicks') return;
        TR.clicks = await call('troubleClicks');
        drawTrouble();
    }

    // Every account's sessions, three at a time; the window redraws as each one comes in.
    async function checkSessions(have) {   // have: an account whose list is already here
        const ids = S.accounts.map(a => a.id).filter(x => x !== have), queue = { ids: [...ids] };
        TR.queue = queue;
        for (const id of ids) TR.sess.set(id, { state: 'waiting' });
        drawTrouble();
        if (!TR.clicks) TR.clicks = await call('troubleClicks');   // proxy names for the "where" column
        const worker = async () => {
            while (TR.queue === queue && queue.ids.length) {
                const id = queue.ids.shift();
                TR.sess.set(id, { state: 'loading' }); drawTrouble();
                const r = await call('troubleSessions', id).catch(() => ({ ok: false, why: 'net' }));
                if (TR.queue === queue) { TR.sess.set(id, r); drawTrouble(); }
            }
        };
        await Promise.all([worker(), worker(), worker()]);
        if (TR.queue === queue) { TR.queue = null; drawTrouble(); }
    }

    async function troubleAct(el) {
        const a = el.dataset.tr, id = el.dataset.id, acct = id && S.accounts.find(x => x.id === id);
        const why = (r) => T('trouble.failed', { why: (r && (r.status ? 'HTTP ' + r.status : r.why)) || '?' });
        switch (a) {
            case 'close': closeTrouble(); return;
            case 'view': TR.view = el.dataset.view; drawTrouble(); if (TR.view === 'sessions' && !TR.sess.size) checkSessions(); if (TR.view === 'clicks') pullClicks(); return;
            case 'copy': copyReport(); return;
            case 'check': TR.openRows.clear(); checkSessions(); return;
            case 'row': if (TR.openRows.has(id)) TR.openRows.delete(id); else { TR.openRows.add(id); call('troubleSeen', id).catch(() => {}); } drawTrouble(); return;
            case 'toSessions': showSessionsOf(id); return;
            case 'busy': {
                const r = await call('troubleBusyTest', id);
                if (!r || !r.ok) { toast(busyWhy(r)); return; }
                await pullClicks(); drawTrouble();
                // Follow it while the Clicks view is open.
                while (TR.open && TR.view === 'clicks') {
                    await new Promise(res => setTimeout(res, 5000));
                    if (!TR.open || TR.view !== 'clicks') break;
                    await pullClicks(); drawTrouble();
                    const x = TR.clicks && TR.clicks.accounts.find(y => y.id === id);
                    if (!x || !x.busy || x.busy.state !== 'running') break;
                }
                return;
            }
            case 'test': {
                TR.testing = true; drawTrouble();
                try { await call('troubleTestRoutes'); } catch (_) {}
                TR.testing = false;
                await pullClicks(); drawTrouble();
                return;
            }
            case 'signOut': {
                const s = TR.sess.get(id).sessions.find(x => x.sid === el.dataset.sid);
                const what = `${T('trouble.kind.' + s.kind)} · ${s.app}${s.os ? ' · ' + s.os : ''} · ${viaText(s.via, s.ip)}`;
                if (!(await modal({ title: T('trouble.session.signOut.title'), body: T('trouble.session.signOut.body', { what }), ok: T('trouble.session.signOut'), danger: true }))) return;
                const r = await call('troubleRevoke', id, s.sid);
                toast(r && r.ok ? T('trouble.session.signedOut') : why(r));
                break;
            }
            case 'everywhere': {
                if (!(await modal({ title: T('trouble.everywhere.title', { name: acct.name }), body: T('trouble.everywhere.body'), ok: T('trouble.everywhere'), danger: true }))) return;
                const r = await call('troubleRevokeOthers', id);
                toast(r && r.ok ? T('trouble.everywhere.done', { name: acct.name }) : why(r));
                break;
            }
            case 'clean': {
                const ids = [...TR.sess.entries()].filter(([, x]) => x.ok && x.earlier).map(([k]) => k);
                const n = ids.reduce((t, k) => t + TR.sess.get(k).earlier, 0);
                if (!(await modal({ title: T('trouble.sessions.clean.title', { n }), body: T('trouble.sessions.clean.body'), ok: T('trouble.sessions.clean.ok') }))) return;
                let removed = 0;
                for (const k of ids) { TR.sess.set(k, { state: 'loading' }); drawTrouble(); const r = await call('troubleCleanup', k); removed += (r && r.removed) || 0; }
                toast(T('trouble.sessions.cleaned', { n: removed }));
                for (const k of ids) TR.sess.set(k, await call('troubleSessions', k));
                drawTrouble();
                return;
            }
            default: return;
        }
        // After a sign-out: that account's list again.
        if (id) { TR.sess.set(id, { state: 'loading' }); drawTrouble(); TR.sess.set(id, await call('troubleSessions', id)); drawTrouble(); }
    }

    // --- text studio hooks -----------------------------------------------------
    // Only with ?studio in the address (tools/text-studio.js): the studio swaps in edited text and
    // asks for a view (a tab, a dialog, a walkthrough step, an error on a card) to preview it.
    const studio = /[?&]studio\b/.test(location.search);
    let studioView = {};

    // Fake states for previewing text that only shows up when something's wrong.
    function studioAdjust(s) {
        if (studioView.empty) { s.accounts = []; s.totals = { ...s.totals, clicking: 0, total: 0 }; s.running = 0; }
        if (studioView.error && s.accounts.length) {
            const code = studioView.error, a = s.accounts[0];
            a.issues = [{ code, acct: a.id, text: code, fix: '', detail: '' }];
            a.status = code === 'CC-CF-01' ? 'needs-you' : code === 'CC-AUTH-01' ? 'logged-out' : 'problem';
            if (code === 'CC-AUTH-01') { a.startedAt = null; a.hasToken = false; }
            if (code === 'CC-CF-01') { a.issues = []; s.appIssues = [{ code, acct: null, text: code, fix: '', detail: '' }]; }
        }
        s.stats = { ...(s.stats || {}), available: true };   // the demo has no stats address; show the switch anyway
        if (studioView.update) s.update = { status: studioView.update, version: '0.2.0', percent: 42, checkedAt: Date.now() - 600000, error: 'net::ERR_INTERNET_DISCONNECTED' };
        if (studioView.banner) s.appIssues = [{ code: studioView.banner, acct: studioView.banner.startsWith('CC-PLUG') ? 'plugin:missions' : null, text: studioView.banner, fix: '', detail: '' }];
    }

    function rerenderAll() {
        lastHtml = new WeakMap();
        for (const c of cards.values()) c.el.remove();
        cards.clear();
        $('#tab-accounts').innerHTML = '';
        settingsDrawn = false;
        applyStaticText();
        if (tourAt >= 0) drawTour();
        if (tab === 'log') drawLog();
        return refresh();
    }

    if (studio) {
        window.__clickerStudio = {
            setText(map) { TX = map; return rerenderAll(); },
            async show(spec) {
                const [kind, arg] = String(spec || 'accounts').split(':');
                studioView = {};
                endTour(false); closeMenus();
                $('#modal').hidden = true;
                if (TR.open) closeTrouble();
                if (kind === 'empty') studioView.empty = true;
                if (kind === 'error') studioView.error = arg;
                if (kind === 'banner') studioView.banner = arg;
                if (kind === 'update') studioView.update = arg;
                tab = kind === 'tab' ? arg : kind === 'update' && arg !== 'ready' ? 'settings' : 'accounts';
                await rerenderAll();
                if (kind === 'menu') { const c = cards.values().next().value; if (c) c.f.menu.hidden = false; }
                if (kind === 'modal' && arg === 'whatsnew') MODALS.whatsnew(await call('whatsNew', true));
                else if (kind === 'modal' && arg === 'stats') showStats();
                else if (kind === 'modal' && arg === 'plugin') { const p = S.plugins.find(x => x.settings.some(s => s.type === 'accounts')) || S.plugins[0]; if (p) pluginModal(p.id); }
                else if (kind === 'modal') MODALS[arg] && MODALS[arg](S && S.accounts[0] && S.accounts[0].name);
                if (kind === 'tour') startTour(Math.max(0, Number(arg) - 1));
                if (kind === 'trouble') openTrouble(arg || 'report');
            },
            toast: (key) => toast(T(key)),
        };
    }

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.menu, [data-act="menu"], [data-act="folderMenu"], [data-act="tabGroup"]')) closeMenus();
        const el = e.target.closest('[data-act]');
        if (el && el.closest('.menu')) closeMenus();
        if (!el || el.tagName === 'INPUT') return;
        act(el, e);
    });
    document.addEventListener('change', (e) => { const el = e.target.closest('[data-act]'); if (el && el.tagName === 'INPUT') act(el, e); });
    $('#add').addEventListener('click', () => act({ dataset: { act: 'add' } }, {}));
    $('#import').addEventListener('click', () => importModal());

    // Import accounts: paste a list, see what was understood as you type, then sign them in.
    async function importModal() {
        let text = '', timer = null;
        const p = modal({ title: T('import.title'), wide: true, ok: T('import.ok'),
            html: `<div class="muted">${H('import.body')}</div><textarea id="importText" class="import-text" rows="8" spellcheck="false" autocomplete="off" placeholder="${H('import.placeholder')}"></textarea><div id="importPreview" class="muted import-preview"></div>` });
        const box = $('#modal .modal-box'), out = box.querySelector('#importPreview');
        box.querySelector('#importText').focus();
        box.oninput = (e) => {
            if (e.target.id !== 'importText') return;
            text = e.target.value;
            clearTimeout(timer);
            timer = setTimeout(async () => {
                const r = await call('importPreview', text);
                if (!r) return;
                const fresh = r.found.filter(f => !f.already).length, already = r.found.length - fresh;
                setHtml(null, `<div><b>${H('import.found', { n: fresh })}</b>${already ? ` · ${H('import.already', { n: already })}` : ''}${r.skipped.length ? ` · ${H('import.skipped', { n: r.skipped.length })}` : ''}</div>`
                    + (r.skipped.length ? `<ul class="import-skips">${r.skipped.slice(0, 8).map(s => `<li>${esc(s.line)} — ${esc(s.why)}</li>`).join('')}</ul>` : ''), out);
            }, 250);
        };
        if (!(await p)) return;
        const r = await call('importStart', text);
        toast(r && r.ok ? T('toast.import.started', { n: r.total }) : (r && r.error) || T('toast.plugin.failed'));
    }
    $('#startAll').addEventListener('click', async () => { if (!(S.settings.main && S.settings.main.userId)) { await setMainModal(); return; } await call('startAll'); refresh(); });
    $('#stopAll').addEventListener('click', async () => { await call('stopAll'); refresh(); });
    $('#report').addEventListener('click', () => openTrouble());
    {
        const t = $('#trouble');
        // The backdrop closes it only when the press started there too: a redraw under the pointer mid-click would
        // otherwise land the click on the backdrop.
        let downOnBackdrop = false;
        t.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === t; });
        t.addEventListener('click', (e) => { if (e.target === t) { if (downOnBackdrop) closeTrouble(); return; } const el = e.target.closest('[data-tr]'); if (el && !el.disabled) troubleAct(el); });
        // Escape closes it, unless a confirm is open on top.
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && TR.open && $('#modal').hidden) closeTrouble(); });
    }
    $('#logProblems').addEventListener('change', drawLog);

    (async () => {
        try { TX = await call('text'); } catch (_) {}
        applyStaticText();
        if (studio) window.parent.postMessage({ clickerStudio: 'ready' }, location.origin);
        refresh(); pullLogs();
        setInterval(refresh, 1500);
        setInterval(pullLogs, 2000);
        setInterval(() => { if (tab === 'accounts') for (const c of cards.values()) tickCard(c); }, 250);
    })();
})();
