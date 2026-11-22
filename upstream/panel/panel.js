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
    // A short pop-up at the bottom. kind 'bad' marks a failure (read out at once). Longer text stays up longer.
    function toast(msg, kind) {
        const t = $('#toast'), text = String(msg == null ? '' : msg);
        t.textContent = text; t.classList.toggle('bad', kind === 'bad'); t.setAttribute('role', kind === 'bad' ? 'alert' : 'status'); t.hidden = false;
        clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, Math.max(3500, Math.min(9000, 2000 + 60 * text.length)));
    }

    // Tab stays inside an open dialog.
    // Errors the hub or the network hands back raw, in plain words; the code stays, in brackets or small print.
    const ERR_MAP = [
        [/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_ADDRESS_UNREACHABLE|ENETUNREACH/, 'offline'],
        [/ERR_NAME_NOT_RESOLVED|ENOTFOUND/, 'dns'],
        [/ERR_PROXY|ERR_TUNNEL|ERR_SOCKS|ERR_MANDATORY_PROXY/, 'proxy'],
        [/ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|ETIMEDOUT|^timed? ?out$/i, 'timeout'],
        [/ERR_CONNECTION_|ERR_EMPTY_RESPONSE|ECONNRESET|ECONNREFUSED/, 'refused'],
        [/ERR_CERT|ERR_SSL/, 'cert'],
        [/^No such account\.?$/, 'noAccount'],
        [/^No such plugin$/, 'noPlugin'],
        [/^Not a number$/, 'notNumber'],
        [/^Not one of the choices$/, 'notChoice'],
        [/^window closed$/, 'windowClosed'],
    ];
    function errParts(raw) {
        const s = String(raw == null ? '' : raw);
        for (const [re, k] of ERR_MAP) if (re.test(s)) return { text: T('err.' + k), code: (/(?:net::)?ERR_[A-Z_]+|\bE[A-Z]{5,}\b/.exec(s) || [''])[0] };
        return { text: s, code: '' };
    }
    const plainError = (raw) => { const e = errParts(raw); return e.text + (e.code ? ' (' + e.code + ')' : ''); };
    const errHtml = (raw) => { const e = errParts(raw); return esc(e.text) + (e.code ? ` <small class="err-code">${esc(e.code)}</small>` : ''); };

    // "Nothing here", the same everywhere: what is missing, a hint, a button. plain leaves the box off (inside a card or a dialog).
    // One rule for "needs the user", built from the same issue list Troubleshoot reports: the Accounts tab count,
    // the Problems filter and the Overview status all use it. An account waiting for a free place on its IP
    // (CC-RATE-01) is not a problem: it starts by itself when one frees up.
    const WAIT_CODES = new Set(['CC-RATE-01']);
    const waitingForSlot = (a) => !a.startedAt && (a.issues || []).some(i => WAIT_CODES.has(i.code));
    const needsAttention = (a) => a.status === 'logged-out' || a.status === 'problem' || a.status === 'needs-you' || a.status === 'proxy-down'
        || (a.issues || []).some(i => !WAIT_CODES.has(i.code));
    // The status in words: waiting for a slot, or clicking but with something to look at, read differently from plain Clicking.
    const statusWord = (a) => waitingForSlot(a) ? T('status.slot') : a.startedAt && needsAttention(a) && (a.status === 'clicking' || a.status === 'no-clicks')
        ? T('status.attention') : TX['status.' + a.status] ? T('status.' + a.status) : a.status;
    const FILTERS = ['all', 'problems', 'clicking', 'stopped'];
    // True while someone is typing or choosing in a field inside el, so a redraw would get in the way.
    const typingIn = (el) => { const a = document.activeElement; return !!(a && el && el.contains(a) && (/^(INPUT|TEXTAREA)$/.test(a.tagName) && a.type !== 'checkbox' || a.tagName === 'SELECT')); };
    const emptyHtml = (title, hint, button, plain) => `<div class="empty-note${plain ? ' plain' : ''}"><div><div class="empty-title">${title}</div>${hint ? `<span>${hint}</span>` : ''}</div>${button || ''}</div>`;

    function trapTab(e, box) {
        const f = [...box.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(n => !n.disabled && n.offsetParent !== null);
        if (!f.length) { e.preventDefault(); return; }
        const first = f[0], last = f[f.length - 1], a = document.activeElement;
        if (!box.contains(a)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
    }

    // html: an already-escaped body. cancel: false = a single OK button (for notices).
    // check (optional) runs when OK is pressed: it returns '' to close, or the reason to stay open, shown in the dialog.
    function modal({ title, body = '', html = '', input = null, ok = 'OK', danger = false, cancel = true, wide = false, check = null }) {
        return new Promise((resolve) => {
            const m = $('#modal'), box = m.querySelector('.modal-box');
            box.classList.toggle('wide', wide);
            box.onchange = box.oninput = null;
            const opener = document.activeElement, openedAt = Date.now();
            box.innerHTML = `<h3 id="modalTitle">${esc(title)}</h3>${body ? `<div class="muted">${esc(body)}</div>` : ''}${html}${input != null ? `<input id="modalInput" maxlength="40" value="${esc(input)}">` : ''}
                <div class="modal-err" role="alert" hidden></div>
                <div class="btns">${cancel ? `<button data-m="cancel">${H('modal.cancel')}</button>` : ''}<button data-m="ok" class="${danger ? 'danger' : 'primary'}">${esc(ok)}</button></div>`;
            m.hidden = false;
            const inp = box.querySelector('#modalInput');
            // Focus starts inside: the field, or Cancel when the button would remove or quit something, or OK.
            if (inp) { inp.focus(); inp.select(); }
            else { const f = box.querySelector(danger && cancel ? '[data-m="cancel"]' : '[data-m="ok"]'); if (f) f.focus(); }
            const done = (v) => {
                m.hidden = true; box.innerHTML = ''; document.removeEventListener('keydown', key);
                let back = opener;
                if (!back || back === document.body || !back.isConnected || !back.getClientRects().length) back = menuClosed && menuClosed.at > openedAt - 1500 ? menuClosed.btn : null;
                if (back && back.isConnected && back.focus) back.focus();
                resolve(v);
            };
            const finish = async (v) => {
                if (!check) return done(v);
                const okBtn = box.querySelector('[data-m="ok"]'), err = box.querySelector('.modal-err');
                if (okBtn.disabled) return;
                okBtn.disabled = true;
                let why = '';
                try { why = await check(); } catch (_) { why = T('toast.failed'); }
                if (m.hidden || !okBtn.isConnected) return;   // closed while it was checking
                okBtn.disabled = false;
                if (why) { err.textContent = why; err.hidden = false; return; }
                done(v);
            };
            const key = (e) => {
                if (e.key === 'Escape') done(null);
                else if (e.key === 'Tab') trapTab(e, box);
                // In a plugin's settings, Enter just finishes the field (blur saves it) instead of closing.
                else if (e.key === 'Enter' && e.target.closest && e.target.closest('.psets')) e.target.blur();
                // Enter confirms from a text field only. On a button it presses that button (Cancel cancels).
                else if (e.key === 'Enter' && box.contains(e.target) && e.target.tagName === 'INPUT' && !/^(checkbox|radio|file)$/.test(e.target.type)) finish(inp ? inp.value : true);
            };
            document.addEventListener('keydown', key);
            box.onclick = (e) => { const b = e.target.closest('[data-m]'); if (!b) return; if (b.dataset.m === 'ok') finish(inp ? inp.value : true); else done(null); };
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
        // Saved when Save is pressed; an id the site doesn't know keeps the dialog open with the reason in it.
        let saved = null;
        const p = modal({ title: T('main.title'), html, ok: T('main.save'), check: async () => {
            const r = await call('setMain', pick.account ? { account: pick.account } : { text: pick.text });
            if (r && r.ok) { saved = r; return ''; }
            return plainError(r && r.error) || T('main.bad');
        } });
        const box = $('#modal .modal-box');
        const sync = () => { pick = { account: box.querySelector('#mainAcct').value, text: box.querySelector('#mainText').value }; box.querySelector('#mainText').closest('label').hidden = !!pick.account; };
        sync();
        box.oninput = box.onchange = sync;
        if (!(await p) || !saved) return;
        toast(T('main.saved', { name: saved.name }));
    }

    // What's new: the lines are written per release (text/whats-new.json), **bold** allowed.
    const rich = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    function whatsNewHtml(entries) {
        if (!entries || !entries.length) return emptyHtml(H('whatsnew.empty'), '', '', true);
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
    // Sharing walkthrough (new in 1.2.11): asked once after the tour or the update, and from Settings > Sharing.
    // Step 1 offers Stay anonymous, Choose what to share, or Take it all (which needs a name).
    // Closing it (Esc, outside) keeps whatever was set before.
    const SHARE_CATS = ['system', 'health', 'clicking', 'plugins', 'log'];
    const NAME_RE = /^[\p{L}\p{N} _.'-]{1,32}$/u;
    const tidyName = (v) => String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
    let shareOpen = false, shareKey = null;
    function shareWalkthrough(step = 'start') {
        const m = $('#modal'), box = m.querySelector('.modal-box'), s = S.settings;
        const pick = { usage: s.shareStats !== false, more: { ...(s.shareMore || {}) }, name: s.shareName || '' };
        const catRow = (cat, on, disabled) => `<label class="share-row${disabled ? ' off' : ''}"><span class="switch"><input type="checkbox" data-cat="${cat}" ${on ? 'checked' : ''} ${disabled ? 'disabled' : ''}><i></i></span>
            <span class="share-text"><b>${H(`share.cat.${cat}.title`)}</b><span>${H(`share.cat.${cat}.desc`)}</span></span></label>`;
        const nameField = (required) => `<label class="mfield"><span>${H(required ? 'share.name.labelRequired' : 'share.name.label')}</span>
            <input id="shareName" maxlength="32" autocomplete="off" spellcheck="false" placeholder="${H(required ? 'share.name.placeholderRequired' : 'share.name.placeholder')}" value="${esc(pick.name)}"></label>
            <div class="muted share-hint" id="shareHint"></div>`;
        const steps = {
            start: () => `<h3 id="modalTitle">${H('share.start.title')}</h3><div class="muted">${H('share.start.text')}</div>
                <div class="share-choices">
                  <button class="share-choice primary" data-share="anon"><b>${H('share.anon.title')}</b><span>${H('share.anon.desc')}</span></button>
                  <button class="share-choice" data-share="choose"><b>${H('share.choose.title')}</b><span>${H('share.choose.desc')}</span></button>
                  <button class="share-choice" data-share="all"><b>${H('share.all.title')}</b><span>${H('share.all.desc')}</span></button>
                </div>
                <div class="muted share-hint">${H('share.later')}</div>`,
            choose: () => `<h3 id="modalTitle">${H('share.choose.title')}</h3><div class="muted">${H('share.choose.text')}</div>
                <div class="share-list">${catRow('usage', pick.usage, false)}${SHARE_CATS.map(c => catRow(c, pick.more[c], !pick.usage)).join('')}</div>
                <div class="muted share-hint" id="shareOff"${pick.usage ? ' hidden' : ''}>${H('share.offNote')}</div>
                ${nameField(false)}
                <div class="btns"><button data-share="back">${H('share.back')}</button><button class="primary" data-share="save">${H('share.save')}</button></div>`,
            all: () => `<h3 id="modalTitle">${H('share.all.title')}</h3><div class="muted">${H('share.all.text')}</div>
                <ul class="share-all">${['usage', ...SHARE_CATS].map(c => `<li><b>${H(`share.cat.${c}.title`)}</b> <span class="muted">${H(`share.cat.${c}.desc`)}</span></li>`).join('')}</ul>
                ${nameField(true)}
                <div class="btns"><button data-share="back">${H('share.back')}</button><button class="primary" data-share="saveAll">${H('share.saveAll')}</button></div>`,
        };
        const nameOk = () => { const v = tidyName(pick.name); return !v || NAME_RE.test(v); };
        const syncName = () => {
            const hint = box.querySelector('#shareHint'), v = tidyName(pick.name);
            if (hint) hint.textContent = !nameOk() ? T('settings.shareName.bad') : v ? T('share.name.named') : T('share.name.hint');
            if (hint) hint.classList.toggle('bad', !nameOk());
            const all = box.querySelector('[data-share="saveAll"]');
            if (all) all.disabled = !v || !nameOk();
            const save = box.querySelector('[data-share="save"]');
            if (save) save.disabled = !nameOk();
        };
        const draw = (to) => {
            step = to;
            box.classList.toggle('wide', step !== 'start');
            box.innerHTML = steps[step]();
            syncName();
            const first = box.querySelector(step === 'start' ? '[data-share="anon"]' : step === 'all' ? '#shareName' : 'input[data-cat]');
            if (first) first.focus();
        };
        const done = (patch, toastKey, vars) => {
            m.hidden = true; box.innerHTML = ''; box.classList.remove('wide');
            box.onclick = box.oninput = box.onchange = null; m.onclick = null;
            document.removeEventListener('keydown', key);
            shareOpen = false; shareKey = null;
            if (studio) return;
            saveSettings({ ...patch, shareAsked: true }).then(ok => { settingsDrawn = false; if (ok && toastKey) toast(T(toastKey, vars)); refresh(); });
        };
        const save = (all) => {
            const name = tidyName(pick.name);
            if (!nameOk() || (all && !name)) { syncName(); const i = box.querySelector('#shareName'); if (i) i.focus(); return; }
            if (all) done({ shareStats: true, shareMore: Object.fromEntries(SHARE_CATS.map(c => [c, true])), shareName: name }, 'share.toast.all', { name });
            else done({ shareStats: pick.usage, shareMore: Object.fromEntries(SHARE_CATS.map(c => [c, !!pick.more[c]])), shareName: name }, 'share.toast.saved');
        };
        const key = (e) => {
            if (e.key === 'Escape') done({});
            else if (e.key === 'Tab') trapTab(e, box);
            else if (e.key === 'Enter' && e.target.id === 'shareName') save(step === 'all');
        };
        box.onclick = (e) => {
            const b = e.target.closest('[data-share]');
            if (!b) return;
            const a = b.dataset.share;
            if (a === 'anon') done({ shareMore: Object.fromEntries(SHARE_CATS.map(c => [c, false])), shareName: '' }, 'share.toast.anon');
            else if (a === 'choose' || a === 'all') draw(a);
            else if (a === 'back') draw('start');
            else if (a === 'save') save(false);
            else if (a === 'saveAll') save(true);
        };
        box.oninput = (e) => { if (e.target.id === 'shareName') { pick.name = e.target.value; syncName(); } };
        box.onchange = (e) => {
            const c = e.target.dataset && e.target.dataset.cat;
            if (!c) return;
            if (c === 'usage') {
                pick.usage = e.target.checked;
                box.querySelectorAll('input[data-cat]:not([data-cat="usage"])').forEach(i => { i.disabled = !pick.usage; i.closest('.share-row').classList.toggle('off', !pick.usage); });
                box.querySelector('#shareOff').hidden = pick.usage;
            } else pick.more[c] = e.target.checked;
        };
        m.onclick = (e) => { if (e.target === m) done({}); };
        if (shareKey) document.removeEventListener('keydown', shareKey);   // opened again over itself (text studio)
        shareKey = key;
        document.addEventListener('keydown', key);
        shareOpen = true;
        m.hidden = false;
        draw(steps[step] ? step : 'start');
    }

    // Discord webhooks walkthrough (Settings > Discord webhooks): one channel and webhook each for the Opener's drops,
    // Alerts and the Daily report. Every step can be skipped; a saved webhook is tested straight away.
    let hookOpen = false;
    const HOOK_STEPS = ['intro', 'drops', 'alerts', 'report', 'done'];
    const openerOn = () => (S.plugins || []).some(p => p.id === 'opener' && p.enabled && p.state === 'running');
    function hookWalkthrough(step = 'intro') {
        if (hookOpen) return;
        const m = $('#modal'), box = m.querySelector('.modal-box');
        const opener = document.activeElement;
        const saved = { drops: false };
        let note = null;   // { ok, text } under the current step
        const hk = () => (S.settings.hooks || {});
        const stepNo = (k) => T('hook.walk.step', { n: HOOK_STEPS.indexOf(k), of: 3 });
        const noteHtml = () => note ? `<div class="muted share-hint${note.ok ? ' good' : ' bad'}" role="${note.ok ? 'status' : 'alert'}">${esc(note.text)}</div>` : '';
        const paste = (kind) => `<label class="mfield"><span>${H(hk()[kind] && hk()[kind].set ? 'hook.walk.replace' : 'hook.walk.paste')}</span>
            <input id="hookUrl" type="password" autocomplete="off" spellcheck="false" placeholder="https://discord.com/api/webhooks/…"></label>
            ${hk()[kind] && hk()[kind].set ? `<div class="muted share-hint">${H('hook.walk.isSet', { tail: esc(hk()[kind].tail) })}</div>` : ''}`;
        const nav = (primary) => `<div class="btns"><button data-hw="back">${H('hook.walk.back')}</button><button data-hw="skip">${H('hook.walk.skip')}</button>${primary}</div>`;
        const steps = {
            intro: () => `<h3 id="modalTitle">${H('hook.walk.title')}</h3><div class="muted">${H('hook.walk.intro')}</div>
                <ul class="share-all">${['drops', 'alerts', 'report'].map(k => `<li><b>${H(`hook.walk.${k}.channel`)}</b> <span class="muted">${H(`hook.walk.${k}.why`)}</span></li>`).join('')}</ul>
                <div class="muted share-hint">${H('hook.walk.how')}</div>
                <div class="btns"><button data-hw="close">${H('hook.walk.close')}</button><button class="primary" data-hw="next">${H('hook.walk.start')}</button></div>`,
            drops: () => `<h3 id="modalTitle">${stepNo('drops')} · ${H('hook.walk.drops.title')}</h3><div class="muted">${H('hook.walk.drops.text')}</div>
                ${openerOn() ? `<label class="mfield"><span>${H('hook.walk.paste')}</span><input id="hookUrl" type="password" autocomplete="off" spellcheck="false" placeholder="https://discord.com/api/webhooks/…"></label>`
                    : `<div class="muted share-hint bad">${H('hook.walk.drops.off')}</div>`}
                ${noteHtml()}
                ${nav(saved.drops ? `<button class="primary" data-hw="next">${H('hook.walk.next')}</button>` : openerOn() ? `<button class="primary" data-hw="save">${H('hook.walk.save')}</button>` : '')}`,
            alerts: () => `<h3 id="modalTitle">${stepNo('alerts')} · ${H('hook.walk.alerts.title')}</h3><div class="muted">${H('hook.walk.alerts.text')}</div>
                ${paste('alerts')}
                <div class="share-list">${['problems', 'plugins', 'restarts'].map(k => `<label class="share-row"><span class="switch"><input type="checkbox" data-hwon="${k}" ${((hk().alerts || {}).on || {})[k] !== false ? 'checked' : ''}><i></i></span>
                    <span class="share-text"><b>${H(`hook.alerts.${k}.title`)}</b><span>${H(`hook.alerts.${k}.desc`)}</span></span></label>`).join('')}</div>
                ${noteHtml()}
                ${nav(hk().alerts && hk().alerts.set && note && note.ok ? `<button class="primary" data-hw="next">${H('hook.walk.next')}</button>` : `<button class="primary" data-hw="save">${H('hook.walk.save')}</button>`)}`,
            report: () => `<h3 id="modalTitle">${stepNo('report')} · ${H('hook.walk.report.title')}</h3><div class="muted">${H('hook.walk.report.text')}</div>
                ${paste('report')}
                <label class="mfield"><span>${H('hook.report.time')}</span><input id="hookTime" type="time" value="${esc((hk().report || {}).time || '09:00')}"></label>
                ${noteHtml()}
                ${nav(hk().report && hk().report.set && note && note.ok ? `<button class="primary" data-hw="next">${H('hook.walk.next')}</button>` : `<button class="primary" data-hw="save">${H('hook.walk.save')}</button>`)}`,
            done: () => `<h3 id="modalTitle">${H('hook.walk.done.title')}</h3>
                <ul class="share-all">${['drops', 'alerts', 'report'].map(k => {
                    const on = k === 'drops' ? saved.drops : !!(hk()[k] && hk()[k].set);
                    return `<li><b>${H(`hook.walk.${k}.channel`)}</b> <span class="muted">${H(on ? 'hook.walk.done.on' : 'hook.walk.done.off')}</span></li>`;
                }).join('')}</ul>
                <div class="muted share-hint">${H('hook.walk.done.later')}</div>
                <div class="btns"><button class="primary" data-hw="close">${H('hook.walk.close')}</button></div>`,
        };
        const draw = (to, keepNote) => {
            step = to; if (!keepNote) note = null;
            box.classList.toggle('wide', step !== 'intro' && step !== 'done');
            box.innerHTML = steps[step]();
            const f = box.querySelector('#hookUrl') || box.querySelector('[data-hw="next"], [data-hw="save"], [data-hw="close"]');
            if (f) f.focus();
        };
        const go = (d) => draw(HOOK_STEPS[Math.max(0, Math.min(HOOK_STEPS.length - 1, HOOK_STEPS.indexOf(step) + d))]);
        const close = () => {
            m.hidden = true; box.innerHTML = ''; box.classList.remove('wide');
            box.onclick = box.onchange = null; m.onclick = null;
            document.removeEventListener('keydown', key);
            hookOpen = false; settingsDrawn = false;
            if (opener && opener.isConnected && opener.focus) opener.focus();
            refresh();
        };
        const result = (r, okText) => { note = r && r.ok !== false && !r.error ? { ok: true, text: okText || r.message || T('hook.walk.sent') } : { ok: false, text: plainError(r && r.error) || T('toast.failed') }; return note.ok; };
        let saving = false;
        const save = async () => {
            if (saving) return;
            const inp = box.querySelector('#hookUrl'), url = inp ? inp.value.trim() : '';
            const btn = box.querySelector('[data-hw="save"]');
            saving = true; if (btn) btn.disabled = true;
            try {
                if (step === 'drops') {
                    if (!url) { note = { ok: false, text: T('hook.walk.needUrl') }; return; }
                    await call('pluginSetting', 'opener', 'hookPaste', url);
                    if (result(await call('pluginAction', 'opener', 'hookSave', null)) && result(await call('pluginAction', 'opener', 'hookTest', null), T('hook.walk.sent'))) saved.drops = true;
                } else {
                    const kind = step;
                    if (kind === 'report') { const t = box.querySelector('#hookTime').value; if (!result(await call('hookOptions', 'report', { time: t }))) return; }
                    if (url) { if (!result(await call('hookSet', kind, url))) return; }
                    else if (!(hk()[kind] && hk()[kind].set)) { note = { ok: false, text: T('hook.walk.needUrl') }; return; }
                    result(await call('hookTest', kind), T(kind === 'report' ? 'hook.walk.sentReport' : 'hook.walk.sent'));
                    try { S.settings = await call('setSettings', {}); } catch (_) {}
                }
            } catch (_) { note = { ok: false, text: T('toast.failed') }; }
            finally { saving = false; if (!m.hidden && hookOpen) draw(step, true); }
        };
        const key = (e) => {
            if (e.key === 'Escape') close();
            else if (e.key === 'Tab') trapTab(e, box);
            else if (e.key === 'Enter' && e.target.id === 'hookUrl') { e.preventDefault(); save(); }
        };
        box.onclick = (e) => {
            const b = e.target.closest('[data-hw]');
            if (!b) return;
            const a = b.dataset.hw;
            if (a === 'close') close();
            else if (a === 'next' || a === 'skip') go(1);
            else if (a === 'back') go(-1);
            else if (a === 'save') save();
        };
        box.onchange = async (e) => {
            const k = e.target.dataset && e.target.dataset.hwon;
            if (!k) return;
            const r = await call('hookOptions', 'alerts', { on: { [k]: e.target.checked } });
            if (!r || !r.ok) { e.target.checked = !e.target.checked; toast(T('toast.saveFailed'), 'bad'); }
            else { try { S.settings = await call('setSettings', {}); } catch (_) {} }
        };
        m.onclick = (e) => { if (e.target === m) close(); };
        document.addEventListener('keydown', key);
        hookOpen = true;
        m.hidden = false;
        draw(steps[step] ? step : 'intro');
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
        setHtml('#summary', `<span class="kpi">${H('header.kpi.clicking', { n: t.clicking, max: S.capacity || S.maxPerIp })}<span class="mini"><i data-w="${Math.min(100, Math.round((S.clickingRuns ?? S.running) / (S.capacity || S.maxPerIp) * 100))}"></i></span></span>`
            + (t.total ? `<button class="kpi kpi-btn" data-act="incomeChart" title="${H('income.open')}">${H('header.kpi.income', { money: money(t.total) })}</button>` : '')
            + ((() => { const wait = S.accounts.filter(waitingForSlot).length, idle = S.accounts.length - t.clicking - wait;
                return (idle > 0 ? `<span class="kpi">${H('header.kpi.idle', { n: idle })}</span>` : '') + (wait ? `<span class="kpi">${H('header.kpi.slot', { n: wait })}</span>` : ''); })())
            + (S.update && S.update.status === 'ready' ? `<span class="kpi update">${H('update.ready', { version: S.update.version })}<button class="small primary" data-act="installUpdate">${H('update.restart')}</button></span>` : ''));
        $('#startAll').disabled = !S.accounts.some(a => !a.startedAt && a.hasToken);
        $('#stopAll').disabled = !S.running;
    }

    // A bar chart, one series: { title, labels, values, tips, scale, every } (the plugin `chart` block and the Overview
    // graphs). Values below 0 hang under a zero line; `scale` is the least the axis spans each way (small differences
    // don't fill the plot). Heights and positions go on through CSSOM after the draw (data-h / data-b, sizeCharts);
    // an axis label on every `every`-th bar (default: about 12 across); tips are each bar's hover text.
    function chartHtml(b) {
        const vals = (Array.isArray(b.values) ? b.values : []).slice(0, 400).map(v => Number(v) || 0);
        if (!vals.length) return '';
        const labels = Array.isArray(b.labels) ? b.labels : [], tips = Array.isArray(b.tips) ? b.tips : [], scale = Math.max(0, Number(b.scale) || 0);
        const neg = vals.some(v => v < 0), hi = Math.max(0, scale, ...vals), lo = neg ? Math.min(-scale, ...vals) : 0;
        const pc = (v) => Math.round(v / (hi - lo || 1) * 1000) / 10, zero = pc(-lo), every = Math.max(1, Math.round(Number(b.every)) || Math.ceil(vals.length / 12));
        return `<figure class="pchart">${b.title ? `<figcaption>${esc(b.title)}</figcaption>` : ''}
            <div class="pchart-plot" role="img" aria-label="${esc(b.title || '')}">${neg ? `<div class="pchart-zero" data-b="${zero}"></div>` : ''}${vals.map((v, i) => {
                const h = v ? Math.max(0.5, pc(Math.abs(v))) : 0;
                return `<div class="pchart-bar" title="${esc(tips[i] || `${labels[i] || ''} · ${v}`)}"><i${v < 0 ? ' class="neg"' : ''} data-b="${v < 0 ? Math.max(0, zero - h) : zero}" data-h="${h}"></i></div>`; }).join('')}</div>
            <div class="pchart-x" aria-hidden="true">${vals.map((_, i) => `<span>${i % every === 0 ? esc(labels[i] || '') : ''}</span>`).join('')}</div></figure>`;
    }
    const sizeCharts = (el) => {   // CSSOM: the CSP blocks inline styles
        el.querySelectorAll('.pchart [data-h]').forEach(i => { i.style.height = i.dataset.h + '%'; });
        el.querySelectorAll('.pchart [data-b]').forEach(i => { i.style.bottom = i.dataset.b + '%'; });
    };

    // Only touch the DOM when the markup really changed: rebuilding it every refresh drops hovers and clicks.
    let lastHtml = new WeakMap();   // element -> markup; weak, so removed cards and dialogs are not kept alive by it
    function setHtml(sel, html, el) {
        el = el || $(sel);
        if (lastHtml.get(el) === html) return;
        lastHtml.set(el, html);
        el.innerHTML = html;
        el.querySelectorAll('[data-w]').forEach(i => { i.style.width = i.dataset.w + '%'; });   // CSSOM: the CSP blocks inline styles
        sizeCharts(el);
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
            <div class="banner${i.code === 'CC-MAIN-01' ? '' : ' closable'} ${i.code === 'CC-CF-01' || i.code === 'CC-SITE-02' || i.code === 'CC-NET-03' || i.code === 'CC-MAIN-01' || /^CC-PROXY-/.test(i.code) ? 'warn' : 'bad'}">
              <span class="code">${esc(i.code)}</span>
              <div class="text"><b>${esc(issueText(i))}</b> <span class="muted">${esc(issueFix(i))}</span>${i.detail ? `<div class="muted">${esc(i.detail)}</div>` : ''}</div>
              ${issueAction(i)}
              ${i.code === 'CC-MAIN-01' ? '' : `<button class="small ghost close-x" data-act="dismissIssue" data-acct="${esc(i.acct || '')}" data-code="${esc(i.code)}" title="${H('banner.close')}" aria-label="${H('banner.close')}">×</button>`}
            </div>`).join(''));
    }

    // Plugin tabs sit in a few drop-down groups so the bar stays short. Each plugin names its group (manifest.group);
    // one without goes under More. A group with a single tab shows as a plain tab.
    let openGroup = null;
    function placeTabMenu(m) {
        m.style.left = '';
        const r = m.getBoundingClientRect(), over = r.right - (document.documentElement.clientWidth - 8);
        if (over > 0) m.style.left = -Math.min(over, r.left - 8) + 'px';
    }
    let tabSaved = '';
    function drawTabs() {
        const bad = S.accounts.filter(needsAttention).length;
        const plugBad = S.plugins.filter(p => p.state === 'error').length;
        // A tab whose content has pin (a few words, e.g. 'running') comes out of its drop-down onto the bar, with that word.
        const ptabs = S.tabs.map(t => { const id = 'plugin:' + t.plugin + ':' + t.title, pin = t.content && typeof t.content.pin === 'string' && t.content.pin.slice(0, 20);
            return { id, label: t.title, pin, group: pin ? 'pin:' + id : t.group || 'more' }; });
        const all = [['accounts', T('tabs.accounts'), bad], ['overview', T('tabs.overview'), 0], ['schedule', T('tabs.schedule'), 0], ['plugins', T('tabs.plugins'), plugBad], ...ptabs.map(t => [t.id, t.label, 0]), ['log', T('tabs.log'), 0], ['settings', T('tabs.settings'), 0]];
        if (tab.startsWith('plugin:') && !all.some(t => t[0] === tab)) tab = 'accounts';
        if (tab !== tabSaved && !studio && tourAt < 0) { tabSaved = tab; try { localStorage.setItem('zsb.tab', tab); } catch (_) {} }
        // The count is read out as words ("6 accounts need a look"); the bare number is only for the eye.
        const said = (id, n) => T(id === 'plugins' ? (n === 1 ? 'tabs.count.plugins.one' : 'tabs.count.plugins') : (n === 1 ? 'tabs.count.accounts.one' : 'tabs.count.accounts'), { n });
        const one = ([id, label, n]) => `<button role="tab" data-act="tab" data-tab="${esc(id)}" aria-selected="${id === tab}">${esc(label)}${n ? `<span class="count" aria-hidden="true">${n}</span><span class="sr-only">, ${esc(said(id, n))}</span>` : ''}</button>`;
        const groups = new Map();
        for (const t of ptabs) groups.set(t.group, [...(groups.get(t.group) || []), t]);
        if (openGroup && !(groups.get(openGroup) || []).length) openGroup = null;
        const groupHtml = [...groups].map(([g, list]) => {
            if (list.length === 1) return list[0].pin ? `<button role="tab" data-act="tab" data-tab="${esc(list[0].id)}" aria-selected="${list[0].id === tab}">${esc(list[0].label)}<span class="tg-cur">· ${esc(list[0].pin)}</span></button>` : one([list[0].id, list[0].label, 0]);
            const cur = list.find(t => t.id === tab);
            const name = T('tabs.group.' + g) !== 'tabs.group.' + g ? T('tabs.group.' + g) : g;
            return `<span class="tab-group">
              <button role="tab" data-act="tabGroup" data-group="${esc(g)}" aria-haspopup="true" aria-expanded="${openGroup === g}" aria-selected="${!!cur}">${esc(name)}${cur ? `<span class="tg-cur">· ${esc(cur.label)}</span>` : ''}<span class="caret" aria-hidden="true">▾</span></button>
              <div class="menu tab-menu"${openGroup === g ? '' : ' hidden'}>${list.map(t => `<button data-act="tab" data-tab="${esc(t.id)}"${t.id === tab ? ' class="on"' : ''}>${esc(t.label)}</button>`).join('')}</div>
            </span>`;
        }).join('');
        const html = one(all[0]) + one(all[1]) + one(all[2]) + one(all[3]) + groupHtml + one(all[all.length - 2]) + one(all[all.length - 1]);
        setHtml('#tabs', html);
        const openMenu = $('#tabs .tab-menu:not([hidden])');
        if (openMenu) placeTabMenu(openMenu);
        for (const s of ['accounts', 'overview', 'schedule', 'plugins', 'log', 'settings']) $('#tab-' + s).hidden = tab !== s;
        $('#tab-plugin').hidden = !tab.startsWith('plugin:');
    }

    // --- overview ----------------------------------------------------------
    // Totals over every account, from each one's last /api/me report (an account that isn't clicking keeps what it
    // had when it last reported). The accounts table sorts by any column.
    // Default: income, highest first, with the accounts that need a look on top. (Saved under a new name: the old
    // default, Net worth, sorted every not-yet-reported account to $0 at the bottom of nothing useful.)
    let ovSort = { key: 'income', dir: -1 };
    try { const o = JSON.parse(localStorage.getItem('zsb.ovSort2') || 'null'); if (o && typeof o.key === 'string' && (o.dir === 1 || o.dir === -1)) ovSort = { key: o.key, dir: o.dir }; } catch (_) {}
    // The 8th Overview tile takes turns: Need a look, Exit IPs, Vault. It stays on Need a look while any account needs
    // one; otherwise it moves on every 8 s (not with reduced motion), and a click shows the next one and holds it 30 s.
    const OV_ROT = ['look', 'ips', 'vault'];
    let ovRot = 0, ovRotHold = 0;
    // The Overview graph: off by default (it fetches the hub's hourly history, core/income.js). The pick is this
    // viewer's, kept in the browser. The history is fetched only while a graph shows, at most once a minute.
    const OV_GRAPHS = ['off', 'income', 'clicking', 'money', 'tokens', 'networth'], OV_LEVELS = ['money', 'tokens', 'networth'];
    let ovGraph = { what: 'off', range: '24h' }, ovHist = null, ovHistAt = 0, ovHistBusy = false;
    try { const o = JSON.parse(localStorage.getItem('zsb.ovGraph') || 'null'); if (o && OV_GRAPHS.includes(o.what)) ovGraph = { what: o.what, range: o.range === '7d' ? '7d' : '24h' }; } catch (_) {}
    function ovHistory() {
        if (ovGraph.what === 'off' || ovHistBusy || Date.now() - ovHistAt < 60000) return;
        ovHistBusy = true;
        Promise.resolve(call('incomeHistory')).then(h => { ovHist = Array.isArray(h) ? h : []; }).catch(() => { if (!ovHist) ovHist = []; })
            .finally(() => { ovHistBusy = false; ovHistAt = Date.now(); if (tab === 'overview') drawOverview(); });
    }
    // 24 hours: a bar an hour. 7 days: a bar per 6 hours, from local midnight. Income and Clicking are averages;
    // Money, Tokens and Net worth are what the fleet gained or lost (the level at the end of each hour, minus the one before),
    // leaving out an hour when the number of accounts that had reported changed (a restart, an account added): a fake jump.
    function ovGraphHtml() {
        const g = ovGraph;
        const seg = (act, cur, list, label) => `<div class="seg" role="group" aria-label="${H(label)}">${list.map(v => `<button class="${v === cur ? 'on' : ''}" aria-pressed="${v === cur}" data-act="${act}" data-id="${v}">${H('overview.graph.' + v)}</button>`).join('')}</div>`;
        const bar = `<div class="ov-graph-bar"><span class="ov-graph-label">${H('overview.graph')}</span>${seg('ovGraph', g.what, OV_GRAPHS, 'overview.graph')}${g.what === 'off' ? '' : seg('ovRange', g.range, ['24h', '7d'], 'overview.graph.range')}</div>`;
        if (g.what === 'off') return bar;
        if (!ovHist) return bar + `<p class="muted ov-graph-msg">${H('overview.graph.loading')}</p>`;
        const six = g.range === '7d', n = six ? 28 : 24, step = six ? 6 : 1, level = OV_LEVELS.includes(g.what);
        const cur = new Date(); cur.setMinutes(0, 0, 0); if (six) cur.setHours(cur.getHours() - cur.getHours() % 6);
        const starts = Array.from({ length: n + 1 }, (_, i) => { const d = new Date(cur); d.setHours(d.getHours() - (n - 1 - i) * step); return d.getTime(); });
        const pts = [];
        let prev = null, prevN = null;
        for (const b of ovHist) {
            if (!level) { pts.push({ h: b.h, v: g.what === 'income' ? b.avg : b.clicking, n: b.clicking }); continue; }
            const v = b[g.what];
            if (typeof v !== 'number') continue;
            if (prev != null) pts.push(b.reported === prevN ? { h: b.h, v: v - prev, at: v } : { h: b.h, skip: true, at: v });
            prev = v; prevN = b.reported;
        }
        const fmt = (v) => (g.what === 'income' ? T('overview.income.value', { v: money(v) }) : g.what === 'clicking' ? String(Math.round(v)) : g.what === 'tokens' ? num(v) : money(v));
        const signed = (v) => (v < 0 ? '−' : '+') + fmt(Math.abs(v));
        const when = (s, e) => new Date(s).toLocaleString([], { weekday: 'short', hour: 'numeric' }) + (six ? '–' + new Date(e).toLocaleTimeString([], { hour: 'numeric' }) : '');
        const slots = starts.slice(0, n).map((s, i) => {
            const e = starts[i + 1], in_ = pts.filter(p => p.h >= s && p.h < e), d = new Date(s);
            const label = six ? (d.getHours() === 0 ? d.toLocaleDateString([], { weekday: 'short' }) : '') : (d.getHours() % 3 === 0 ? d.toLocaleTimeString([], { hour: 'numeric' }) : '');
            if (!in_.length) return { v: 0, label, tip: T('overview.graph.tip.none', { when: when(s, e) }) };
            const avg = (f) => in_.reduce((t, p) => t + f(p), 0) / in_.length;
            if (level) {
                const ok = in_.filter(p => !p.skip), v = ok.reduce((t, p) => t + p.v, 0);
                return { v, has: 1, label, tip: T(ok.length ? 'overview.graph.tip.change' : 'overview.graph.tip.skip', { when: when(s, e), v: signed(v), now: fmt(in_[in_.length - 1].at) }) };
            }
            const v = avg(p => p.v);
            return { v, has: 1, label, tip: T(g.what === 'income' ? 'overview.graph.tip.income' : 'overview.graph.tip.clicking', { when: when(s, e), v: fmt(v), n: Math.round(avg(p => p.n)) }) };
        });
        if (!slots.some(x => x.has)) return bar + `<p class="muted ov-graph-msg">${H(level && !pts.length ? 'overview.graph.emptyNew' : 'overview.graph.empty')}</p>`;
        const per = T(six ? 'overview.graph.per.6h' : 'overview.graph.per.1h');
        const title = level ? T('overview.graph.cap.change', { what: T('overview.graph.' + g.what), per, now: fmt(prev) })
            : T(g.what === 'income' ? 'overview.graph.cap.income' : 'overview.graph.cap.clicking', { per, peak: fmt(Math.max(...slots.map(x => x.v))) });
        return bar + chartHtml({ title, values: slots.map(x => x.v), labels: slots.map(x => x.label), tips: slots.map(x => x.tip), every: 1 })
            + (level ? `<p class="muted ov-note">${H('overview.graph.note')}</p>` : '');
    }
    function drawOverview() {
        const acc = S.accounts, me = (a) => a.me || {};
        if (typingIn($('#tab-overview'))) return;
        if (!acc.length) { setHtml('#tab-overview', emptyHtml(H('overview.empty'), '', `<button class="small primary" data-act="add">${H('header.add')}</button>`)); return; }
        if (tab === 'overview') ovHistory();
        const sum = (list, f) => list.reduce((s, a) => s + (Number(f(a)) || 0), 0);
        const has = (list, f) => list.some(a => f(a) != null);
        const total = (list, f, fmt) => (has(list, f) ? fmt(sum(list, f)) : '—');
        // Hover text: the exact number (the tile shows it short, e.g. $46.58M).
        const exact = (list, f, cash, unit = '') => (has(list, f) ? (cash ? '$' + sum(list, f).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : Math.round(sum(list, f)).toLocaleString('en-US')) + unit : '');
        const income = (a) => (a.perHour ? a.perHour.total : null);
        const clicking = acc.filter(a => a.startedAt).length, pro = acc.filter(a => me(a).membership === 'pro').length, look = acc.filter(needsAttention).length, slots = acc.filter(waitingForSlot).length;
        const rotTile = () => {
            const which = look && Date.now() > ovRotHold ? 'look' : OV_ROT[ovRot % OV_ROT.length];
            let value, sub, full = '';
            if (which === 'look') { value = String(look); sub = T(look ? 'overview.rot.look.some' : 'overview.rot.look.none'); }
            else if (which === 'ips') {
                value = String(new Set(acc.filter(a => a.startedAt).map(a => a.route || 'direct')).size);
                sub = slots ? T('overview.accounts.slots', { n: slots }) : T('overview.rot.ips.max', { max: S.settings.maxPerIp });
            } else {
                const vault = (a) => (a.perHour ? a.perHour.vault : null);
                value = has(acc, vault) ? T('overview.income.value', { v: money(sum(acc, vault)) }) : '—'; full = exact(acc, vault, true, '/h'); sub = T('overview.rot.vault.sub');
            }
            return `<button class="stat stat-rot" data-act="ovRot" title="${H('overview.rot.tip')}"><span>${H('overview.rot.' + which)}</span><b${full ? ` title="${esc(full)}"` : ''}>${esc(value)}</b><small class="muted">${esc(sub)}</small></button>`;
        };
        const tile = (label, value, sub, full) => `<div class="stat"><span>${H(label)}</span><b title="${esc(full || value)}">${esc(value)}</b>${sub ? `<small class="muted">${esc(sub)}</small>` : ''}</div>`;
        const tiles = `<div class="statrow ov-stats">
            ${tile('overview.accounts', `${clicking} / ${acc.length}`, [look ? T('overview.accounts.look', { n: look }) : '', slots ? T('overview.accounts.slots', { n: slots }) : ''].filter(Boolean).join(' · '))}
            ${tile('overview.income', has(acc, income) ? T('overview.income.value', { v: money(sum(acc, income)) }) : '—', '', exact(acc, income, true, '/h'))}
            ${tile('overview.money', total(acc, a => me(a).money, money), '', exact(acc, a => me(a).money, true))}
            ${tile('overview.tokens', total(acc, a => me(a).tokens, num), '', exact(acc, a => me(a).tokens))}
            ${tile('overview.networth', total(acc, a => me(a).networth, money), '', exact(acc, a => me(a).networth, true))}
            ${tile('overview.premier', total(acc, a => me(a).premier, num), '', exact(acc, a => me(a).premier))}
            ${tile('overview.pro', `${pro} / ${acc.length}`)}
            ${rotTile()}
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
            .map(([name, e]) => `<span class="ov-rank">${esc(name)} <span class="ov-rank-n">· <b>${e.n}</b></span></span>`).join('')}</div>`;
        // Every account.
        const names = folderNames(), folderName = (id) => names.get(id) || '';
        const cols = [['name', T('overview.col.account')], ...(folders.length ? [['folder', T('overview.col.folder')]] : []), ['status', T('overview.col.status')],
            ['income', T('overview.col.income'), 1], ['money', T('overview.col.money'), 1], ['tokens', T('overview.col.tokens'), 1], ['networth', T('overview.col.networth'), 1], ['premier', T('overview.col.premier'), 1],
            ['rank', T('overview.col.rank')], ['pro', T('overview.col.membership')]];
        const val = {
            name: (a) => String(a.name || a.id).toLowerCase(), folder: (a) => folderName(a.folder).toLowerCase(),
            status: (a) => (needsAttention(a) ? '0' : waitingForSlot(a) ? '1' : '2') + statusWord(a),
            income, money: (a) => me(a).money, tokens: (a) => me(a).tokens, networth: (a) => me(a).networth, premier: (a) => me(a).premier,
            rank: (a) => (me(a).rank ? me(a).rank.id : null), pro: (a) => (me(a).membership === 'pro' ? 1 : 0),
        };
        const get = val[ovSort.key] || val.income, lookFirst = ovSort.key === 'income' && ovSort.dir < 0;
        const sorted = [...acc].sort((x, y) => {
            if (lookFirst && needsAttention(x) !== needsAttention(y)) return needsAttention(x) ? -1 : 1;
            const a = get(x), b = get(y);
            if (a == null && b == null) return 0; if (a == null) return 1; if (b == null) return -1;
            return (typeof a === 'string' ? a.localeCompare(b) : a - b) * ovSort.dir;
        });
        const rows = sorted.map(a => [a.name || a.id, ...(folders.length ? [folderName(a.folder) || '—'] : []), statusWord(a),
            income(a) == null ? '—' : money(income(a)), money(me(a).money), num(me(a).tokens), money(me(a).networth), me(a).premier == null ? '—' : Math.round(me(a).premier).toLocaleString(),
            me(a).rank && me(a).rank.name ? me(a).rank.name : '—', me(a).membership === 'pro' ? T('overview.pro.yes') : me(a).membership ? T('overview.pro.no') : '—']);
        setHtml('#tab-overview', `${tiles}${ovGraphHtml()}${folderHtml}${rankHtml}<h4 class="plug-head">${H('overview.all')}</h4>${table(cols, rows, true)}<p class="muted ov-note">${H('overview.note')}</p>`);
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
        if (onScreen) onScreen.observe(el);
        el.innerHTML = `
          <header class="c-head">
            <input type="checkbox" class="c-pick" data-f="pick" data-id="${id}" aria-label="${H('bulk.pick')}" tabindex="-1">
            <button class="icon-btn grip" data-grip="card" data-id="${id}" aria-label="${H('folders.grip.card')}" title="${H('folders.grip.tip')}"><svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg></button>
            <div class="c-title"><div class="name" data-f="name"></div></div>
            <span class="premier" data-f="premier" hidden></span>
            <span class="chip" data-f="chip"></span>
            <button class="icon-btn" data-act="menu" data-id="${id}" aria-expanded="false" aria-label="${H('card.menu.label')}" title="${H('card.menu.tip')}">⋯</button>
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
              <button data-act="type" data-id="${id}" data-type="off" data-f="segOff" title="${H('card.type.off.tip')}">${H('card.type.off')}</button>
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
        // Waiting for a slot is said once by the card's own state and the note above the cards, not as a red box on each.
        const list = a.issues.filter(i => !(WAIT_CODES.has(i.code) && waitingForSlot(a))).map(i => `
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
        const f = c.f, running = !!a.startedAt, me = a.me, ph = a.perHour, slot = waitingForSlot(a);
        c.a = a;
        c.el.className = 'card s-' + (slot ? 'slot' : a.status) + (running ? '' : ' off') + (picked.has(a.id) ? ' picked' : '');
        if (f.pick.checked !== picked.has(a.id)) f.pick.checked = picked.has(a.id);
        f.pick.tabIndex = selecting ? 0 : -1;
        setText(f.name, a.name);
        f.name.title = a.name;
        setText(f.vaultLabel, a.vaultEveryMin ? T('card.vault.every', { min: Math.round(a.vaultEveryMin) }) : T('card.vault'));
        f.chip.className = 'chip ' + (slot ? 'slot' : running && needsAttention(a) && (a.status === 'clicking' || a.status === 'no-clicks') ? 'attention' : a.status);
        setText(f.chip, statusWord(a));

        // The big number: what this account makes per hour, from its own rates.
        // Not clicking: say what's going on instead of empty numbers.
        let hero = a.status === 'logged-out' ? T('card.hero.loggedOut') : T('card.hero.stopped'), unit = '',
            label = a.status === 'logged-out' ? T('card.label.loggedOut') : T('card.label.stopped', { ago: ago(a.lastClickOkAt) });
        if (slot) { hero = T('card.hero.slot'); label = T('card.label.slot'); }
        else if (running && !ph) { hero = '…'; label = T('card.label.waiting'); }
        else if (running) {
            hero = money(ph.total); unit = T('card.hero.unit');
            label = a.clickType === 'off' ? T('card.label.off') : a.clickType === 'cases'
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
        setText(f.ctype, T('card.type.' + (a.clickType === 'cases' || a.clickType === 'off' ? a.clickType : 'money')));
        f.hero.classList.toggle('word', !running);
        f.money.closest('.kv').hidden = !running && !me;   // nothing known yet: no empty stats box

        setHtml(null, a.badges.map(b => `<span class="badge">${esc(b)}</span>`).join(''), f.badges);
        setHtml(null, issueHtml(a), f.issues);

        f.menuBusy.hidden = !running || !!a.test;
        f.segAuto.className = a.type === 'auto' ? 'on' : ''; f.segAuto.setAttribute('aria-pressed', String(a.type === 'auto'));
        f.segMoney.className = a.type === 'money' ? 'on' : ''; f.segMoney.setAttribute('aria-pressed', String(a.type === 'money'));
        f.segCases.className = a.type === 'cases' ? 'on' : ''; f.segCases.setAttribute('aria-pressed', String(a.type === 'cases'));
        f.segOff.className = a.type === 'off' ? 'on' : ''; f.segOff.setAttribute('aria-pressed', String(a.type === 'off'));
        // Waiting for a slot: Start can't make room, so it's an ordinary button, not the card's main action.
        const main = running ? ['stop', T('card.btn.stop'), ''] : a.hasToken ? ['start', T('card.btn.start'), slot ? '' : 'primary'] : ['relogin', T('card.btn.relogin'), 'primary'];
        f.main.dataset.act = main[0];
        f.main.className = main[2];
        setText(f.main, main[1]);
        tickCard(c);
    }

    // Cards off screen skip the 250 ms bar updates (they still get every refresh).
    const onScreen = 'IntersectionObserver' in window ? new IntersectionObserver((list) => { for (const e of list) e.target.dataset.off = e.isIntersecting ? '' : '1'; }, { rootMargin: '200px' }) : null;
    function dropCard(c) { if (onScreen) onScreen.unobserve(c.el); c.el.remove(); }
    const cardShows = (c) => !c.el.hidden && c.el.dataset.off !== '1' && !(c.el.parentNode && c.el.parentNode.parentNode && c.el.parentNode.parentNode.classList.contains('collapsed'));

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
        } else { f.nextBar.style.width = '0%'; setText(f.nextTxt, a.startedAt && a.clickType === 'off' ? T('card.next.off') : '—'); }
        const v = a.vault;
        if (a.startedAt && v && v.lastAt) {
            const held = Math.max(0, Math.min(v.cap, (t - v.lastAt) / 60000 * v.perMin));
            const pct = held / v.cap * 100;
            f.vaultBar.style.width = pct + '%';
            setText(f.vaultTxt, T('card.vault.fill', { pct: Math.floor(pct), money: money(held) }));
        } else { f.vaultBar.style.width = '0%'; setText(f.vaultTxt, a.startedAt && a.clickType === 'off' ? T('card.vault.off') : a.startedAt ? T('card.vault.waiting') : '—'); }
    }

    function drawAccounts() {
        const el = $('#tab-accounts');
        if (!S.accounts.length) {
            for (const c of cards.values()) dropCard(c);
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
            el.innerHTML = `<p class="limit-note" hidden></p><div class="acct-tools"><input type="search" class="acct-search" placeholder="${H('cards.search')}" aria-label="${H('cards.search')}" hidden><div class="seg acct-filter" role="group" aria-label="${H('cards.filter.label')}" hidden>${FILTERS.map(k => `<button data-act="acctFilter" data-id="${k}" aria-pressed="false">${H('cards.filter.' + k)}</button>`).join('')}</div><span class="grow"></span><button class="small" data-act="selectMode" aria-pressed="false">${H('bulk.select')}</button><button class="small" data-act="compact" aria-pressed="false"></button><button class="small" data-act="folderNew">${H('folders.new')}</button></div><div class="bulk-bar" role="toolbar" aria-label="${H('bulk.label')}" hidden><span class="bulk-n" aria-live="polite"></span><button class="small" data-act="bulkAll"></button><button class="small" data-act="bulkNone">${H('bulk.none')}</button><span class="grow"></span><button class="small" data-act="bulk" data-what="start">${H('bulk.start')}</button><button class="small" data-act="bulk" data-what="stop">${H('bulk.stop')}</button><div class="seg" role="group" aria-label="${H('card.type.label')}"><button data-act="bulk" data-what="type" data-arg="auto">${H('card.type.auto')}</button><button data-act="bulk" data-what="type" data-arg="money">${H('card.type.money')}</button><button data-act="bulk" data-what="type" data-arg="cases">${H('card.type.cases')}</button><button data-act="bulk" data-what="type" data-arg="off" title="${H('card.type.off.tip')}">${H('card.type.off')}</button></div><button class="small" data-act="bulk" data-what="folder">${H('bulk.folder')}</button><button class="small danger" data-act="bulk" data-what="remove">${H('bulk.remove')}</button><button class="small primary" data-act="selectMode">${H('bulk.done')}</button></div><div class="acct-none" hidden>${emptyHtml(H('cards.noMatch'), H('cards.noMatchHint'), `<button class="small" data-act="acctClear">${H('cards.clear')}</button>`)}</div><div class="sections"></div>`;
            wrap = el.querySelector('.sections');
            for (const s of sections.values()) s.el.remove();
            sections.clear();
        }
        const note = el.querySelector('.limit-note');
        note.hidden = (S.clickingRuns ?? S.running) < (S.capacity || S.maxPerIp);   // Off accounts take no place
        const waiting = S.accounts.filter(waitingForSlot).length;
        setText(note, T('accounts.limit', { max: S.capacity || S.maxPerIp, per: S.maxPerIp }) + (waiting ? ' ' + T('accounts.limit.waiting', { n: waiting }) : ''));
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
        for (const [id, c] of cards) if (!seen.has(id)) { dropCard(c); cards.delete(id); }
        for (const id of picked) if (!seen.has(id)) picked.delete(id);
        applySearch();
        paintBulk();
    }

    // Folder names and accounts by id, built once per state instead of a search per row.
    let namesOf = null, namesMap = new Map(), acctsOf = null, acctsMap = new Map();
    function folderNames() {
        if (namesOf !== S.folders) { namesOf = S.folders; namesMap = new Map((S.folders || []).map(f => [f.id, f.name])); }
        return namesMap;
    }
    function acctById(id) {
        if (acctsOf !== S.accounts) { acctsOf = S.accounts; acctsMap = new Map(S.accounts.map(a => [a.id, a])); }
        return acctsMap.get(id);
    }

    // The folder an account is in, as a small tag after its name (Troubleshoot lists).
    function folderTag(id) {
        const a = acctById(id), name = a && a.folder && folderNames().get(a.folder);
        return name ? ` <span class="tr-folder">${esc(name)}</span>` : '';
    }

    // Select mode: tick cards (the box, or a click anywhere on a card that isn't a button), then one action for all of
    // them from the bar above the cards. Dragging is off while selecting; Escape or Done leaves it.
    let selecting = false;
    const picked = new Set();
    const shownIds = () => S.accounts.filter(a => { const c = cards.get(a.id); return c && !c.el.hidden; }).map(a => a.id);
    function paintBulk() {
        const el = $('#tab-accounts'), bar = el && el.querySelector('.bulk-bar');
        if (!bar) return;
        el.classList.toggle('selecting', selecting);
        bar.hidden = !selecting;
        const btn = el.querySelector('.acct-tools [data-act="selectMode"]');
        btn.classList.toggle('on', selecting); btn.setAttribute('aria-pressed', String(selecting));
        if (!selecting) return;
        const n = picked.size, shown = shownIds(), all = shown.length && shown.every(id => picked.has(id));
        setText(bar.querySelector('.bulk-n'), n ? T(n === 1 ? 'bulk.n.one' : 'bulk.n', { n }) : T('bulk.n.none'));
        const allBtn = bar.querySelector('[data-act="bulkAll"]');
        setText(allBtn, T(shown.length < S.accounts.length ? 'bulk.allShown' : 'bulk.all', { n: shown.length }));
        allBtn.disabled = !!all;
        bar.querySelector('[data-act="bulkNone"]').disabled = !n;
        bar.querySelectorAll('[data-act="bulk"]').forEach(b => { b.disabled = !n; });
    }
    function setSelecting(on) {
        selecting = !!on;
        if (!selecting) picked.clear();
        for (const c of cards.values()) if (c.a) updateCard(c, c.a);
        paintBulk();
    }
    function togglePick(id, on) {
        if (on === undefined ? !picked.has(id) : on) picked.add(id); else picked.delete(id);
        const c = cards.get(id); if (c && c.a) updateCard(c, c.a);
        paintBulk();
    }
    document.addEventListener('change', (e) => { if (e.target.classList && e.target.classList.contains('c-pick')) togglePick(e.target.dataset.id, e.target.checked); });
    // In select mode a click on a card (not on a button, a box or the menu) ticks it.
    document.addEventListener('click', (e) => {
        if (!selecting || !e.target.closest) return;
        const card = e.target.closest('#tab-accounts .card');
        if (!card || e.target.closest('button, input, select, a, .menu')) return;
        togglePick(card.dataset.id);
    });
    document.addEventListener('keydown', (e) => { if (selecting && e.key === 'Escape' && $('#modal').hidden && !(drag && drag.live)) setSelecting(false); });
    async function bulkAct(what, arg) {
        const ids = [...picked], n = ids.length;
        if (!n) return;
        if (what === 'remove') {
            // Name them, so a wrong tick shows before it's gone (the first 12, then how many more).
            const names = ids.map(id => (S.accounts.find(a => a.id === id) || {}).name || id);
            const list = `<ul class="modal-names">${names.slice(0, 12).map(x => `<li>${esc(x)}</li>`).join('')}${names.length > 12 ? `<li class="muted">${H('bulk.remove.more', { n: names.length - 12 })}</li>` : ''}</ul>`;
            if (!(await modal({ title: T(n === 1 ? 'bulk.remove.title.one' : 'bulk.remove.title', { n }), html: list + `<div class="muted">${H('modal.remove.body')}</div>`, ok: T('modal.remove.ok'), danger: true }))) return;
        }
        if (what === 'folder') {
            const opts = [['', T('folders.none')], ...(S.folders || []).map(f => [f.id, f.name]), ['+', T('folders.newOption')]];
            let v = '';
            const p = modal({ title: T(n === 1 ? 'bulk.move.title.one' : 'bulk.move.title', { n }), ok: T('folders.move.ok'),
                html: `<select id="folderPick" class="folder-pick" aria-label="${H('bulk.folder')}">${opts.map(([k, nm]) => `<option value="${esc(k)}">${esc(nm)}</option>`).join('')}</select>` });
            $('#modal .modal-box').onchange = (e) => { if (e.target.id === 'folderPick') v = e.target.value; };
            if (!(await p)) return;
            if (v === '+') {
                const name = await modal({ title: T('folders.new.title'), input: '', ok: T('folders.new.ok') });
                if (name == null || !name.trim()) return;
                arg = { name: name.trim() };
            } else arg = v || null;
        }
        const r = await call('accountsBulk', ids, what, arg);
        if (!r || !r.ok) { toast(plainError(r && r.error) || T('toast.failed'), 'bad'); return; }
        if (what === 'type' && Object.values(r.results || {}).some(x => x && x.code === 'CC-RATE-01')) return toast(T('toast.limit', { max: S.maxPerIp }));
        if (what === 'start') {
            const codes = Object.values(r.results || {}).map(x => x && !x.ok && x.code);
            if (codes.includes('CC-MAIN-01')) return setMainModal();
            if (codes.includes('CC-RATE-01')) return toast(T('toast.limit', { max: S.maxPerIp }));
            if (codes.includes('CC-AUTH-08')) return toast(T('toast.dupe'));
        }
        toast(T('bulk.done.' + what, { n }), 'ok');
        if (what === 'remove') picked.clear();
        paintBulk();
    }

    // Search and filter buttons above the cards (shown from 9 accounts): hide the cards that don't match, and folders
    // with none. The search looks at account names and folder names.
    let searchQ = '', filterBy = 'all';
    function applySearch() {
        const el = $('#tab-accounts'), box = el.querySelector('.acct-search');
        if (!box) return;
        const few = S.accounts.length <= 8;
        box.hidden = few && !searchQ;
        const chips = el.querySelector('.acct-filter'), bad = S.accounts.filter(needsAttention).length;
        chips.hidden = few && filterBy === 'all';
        chips.querySelectorAll('button').forEach(b => {
            const on = b.dataset.id === filterBy;
            b.classList.toggle('on', on);
            b.setAttribute('aria-pressed', String(on));
            if (b.dataset.id === 'problems') setText(b, bad ? T('cards.filter.problemsN', { n: bad }) : T('cards.filter.problems'));
        });
        const q = searchQ.trim().toLowerCase(), names = folderNames(), active = !!q || filterBy !== 'all';
        const fits = { all: () => true, problems: needsAttention, clicking: (a) => !!a.startedAt, stopped: (a) => !a.startedAt }[filterBy];
        let shown = 0;
        for (const a of S.accounts) {
            const c = cards.get(a.id);
            if (!c) continue;
            const hit = fits(a) && (!q || String(a.name || '').toLowerCase().includes(q) || String(names.get(a.folder) || '').toLowerCase().includes(q));
            c.el.hidden = !hit;
            if (hit) shown++;
        }
        el.querySelector('.acct-none').hidden = !active || shown > 0;
        if (!active) return;
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
            <button class="icon-btn" data-act="folderMenu" data-id="${fid}" aria-expanded="false" aria-label="${H('folders.menu')}" title="${H('card.menu.tip')}">⋯</button>
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
        if (e.button !== 0 || tab !== 'accounts' || drag || selecting) return;
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

    // The ⋯ button whose menu is open, and the one that closed last (a dialog opened from a menu gives focus back to it).
    let menuOpen = null, menuClosed = null;
    function closeMenus(except) {
        document.querySelectorAll('.menu').forEach(m => { if (m !== except) m.hidden = true; });
        if (menuOpen && menuOpen.menu !== except) { menuOpen.btn.setAttribute('aria-expanded', 'false'); menuClosed = { btn: menuOpen.btn, at: Date.now() }; menuOpen = null; }
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
        // A plugin that acts for real says which mode it is in; Practice is a calm tag, Live the green one.
        const mode = (p.settings || []).find(s => s.key === 'runMode');
        if (p.state === 'running' && mode) return mode.value === 'live' ? `<span class="tag ok">${H('plugins.state.live')}</span>` : `<span class="tag">${H('plugins.state.practice')}</span>`;
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
    // optional: an accounts picker that is a tool (e.g. which accounts to pin to a proxy), not what the plugin runs on.
    const needsAccounts = (p) => p.settings.some(s => s.type === 'accounts' && !s.optional && !(s.value && (s.value.all || (s.value.ids || []).length)));

    const catalogEntry = (id) => ((S.catalog && S.catalog.entries) || []).find(e => e.id === id);

    function pluginCard(p) {
        const acc = p.settings.filter(s => s.type === 'accounts' && !s.optional), ce = catalogEntry(p.id), upd = ce && ce.update;
        return `
            <div class="row plug">
              <div class="main">
                <div class="title">${esc(p.name)} <span class="muted">${esc(p.version)}</span> ${p.enabled ? pluginState(p) : ''} ${p.bundled ? `<span class="tag">${H('plugins.tag.builtin')}</span>` : p.verified ? `<span class="tag ok">${H('plugins.tag.signed')}</span>` : `<span class="tag bad">${H('plugins.tag.unverified')}</span>`}</div>
                <div class="desc">${esc(p.description)}</div>
                ${p.error ? `<div class="desc bad-text">${errHtml(p.error.msg)}</div>` : ''}
                ${acc.map(s => `<div class="desc runs-on${p.enabled && needsAccounts(p) ? ' warn-text' : ''}">${accountsSummary(s)}</div>`).join('')}
                ${upd && ce.tooNew ? `<div class="desc muted">${H('plugins.updateNeedsApp', { version: esc(ce.version), app: esc(ce.minCore) })}</div>` : ''}
              </div>
              <div class="plug-btns">
                ${upd && !ce.tooNew ? `<button class="small primary" data-act="pluginInstall" data-id="${esc(p.id)}">${H('plugins.update', { version: esc(ce.version) })}</button>` : ''}
                ${p.removable ? `<button class="small" data-act="pluginRemove" data-id="${esc(p.id)}">${H('plugins.remove')}</button>` : ''}
                ${p.state === 'error' ? `<button class="small" data-act="pluginReload" data-id="${esc(p.id)}">${H('plugins.reload')}</button>` : ''}
                ${p.tab && p.state === 'running' ? `<button class="small" data-act="tab" data-tab="plugin:${esc(p.id)}:${esc(p.tab)}">${H('plugins.open')}</button>`
                    : p.settings.some(s => !s.page) ? `<button class="small" data-act="pluginOpen" data-id="${esc(p.id)}">${H('plugins.settings')}</button>` : ''}
                ${p.enabled ? `<button class="small" data-act="pluginToggle" data-id="${esc(p.id)}" data-on="0">${H('plugins.turnOff')}</button>`
                    : `<button class="small primary" data-act="pluginToggle" data-id="${esc(p.id)}" data-on="1">${H('plugins.turnOn')}</button>`}
              </div>
            </div>`;
    }

    function drawPlugins() {
        // Don't redraw under someone typing in one of its fields.
        if (typingIn($('#tab-plugins'))) return;
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
            + status
            + `<h4 class="plug-head">${H('plugins.section.custom')}</h4>
            <div class="rows"><div class="row plug custom-import">
              <div class="main"><div class="title">${H('plugins.import.title')}</div>
                <div class="desc">${H('plugins.import.desc')}</div>
                ${S.settings.allowUnverifiedPlugins ? '' : `<div class="desc muted">${H('plugins.import.unverified')}</div>`}</div>
              <div class="plug-btns"><button class="small primary" data-act="pluginZip">${H('plugins.import.button')}</button></div>
            </div></div>`
            + `<p class="muted">${H('plugins.note')}</p>`);
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
        return `<label ${at()}>${label}<input type="${f.type === 'number' ? 'number' : 'text'}"${f.type === 'number' && f.min != null ? ` min="${esc(f.min)}"` : ''}${f.type === 'number' && f.max != null ? ` max="${esc(f.max)}"` : ''} data-f="${esc(fk)}" value="${esc(v ?? '')}"${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}>${help}</label>`;
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
    // With s.reorder (the order matters, e.g. a queue) each row after the first has Move up. With s.summaryFirst the
    // summary is the row's title and "Case 2" goes under it (rows that are best known by what they hold). s.images:
    // a picture per row (https URL, or '' for none) in front of its title.
    function listHtml(s) {
        const rows = Array.isArray(s.value) ? s.value : [], fold = Array.isArray(s.summaries), open = openRows.get(s.key) || new Set();
        return rows.map((row, i) => {
            const shut = fold && !open.has(i), sum = fold ? s.summaries[i] || '' : '', num = `${esc(cap(s.itemLabel || s.label || s.key))} ${i + 1}`, pic = Array.isArray(s.images) ? s.images[i] : '';
            return `<div class="prow${shut ? ' shut' : ''}" data-row="${i}">
              <div class="prow-head">${pic ? tilePic(pic, ' prow-img') : ''}<div class="prow-title">${sum && s.summaryFirst ? `<b>${esc(sum)}</b><span class="prow-sum">${num}</span>` : `<b>${num}</b>${sum ? `<span class="prow-sum">${esc(sum)}</span>` : ''}`}</div>
                <div class="pbtns">${fold ? `<button class="small" data-row-toggle="${i}">${shut ? H('pluginmodal.editRow') : H('pluginmodal.doneRow')}</button>` : ''}${s.reorder && i > 0 ? `<button class="small" data-row-up="${i}">${H('pluginmodal.upRow')}</button>` : ''}<button class="small" data-row-del="${i}">${H('pluginmodal.removeRow')}</button></div></div>
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
        // What a screen reader calls the control: its label, or the hint inside it when it has none (a toolbar's search box).
        const al = ` aria-label="${esc(s.label || s.placeholder || s.key)}"`;
        if (s.type === 'list') return `<div class="pset" data-key="${key}" data-type="list">${label}<div class="prows">${listHtml(s)}</div></div>`;
        if (s.type === 'account') return `<div class="pset" data-key="${key}" data-type="account">${label}${accountSelect(s.value, 'data-pset' + al)}</div>`;
        if (s.type === 'choice' && (s.dynamic || s.select || (s.options || []).length > 4)) return `<div class="pset" data-key="${key}" data-type="choice">${label}${choiceSelect(s.options, s.value, 'data-pset' + al)}</div>`;
        if (s.type === 'accounts') {
            const v = s.value || {}, ids = new Set(v.ids || []);
            // One pill per account: its picture, its name, and two lines from the plugin page (accountLines) or its wallet and whether it clicks.
            const lines = (a) => { const l = acctLines && acctLines[a.id]; return Array.isArray(l) && l.length ? l.slice(0, 2).map(String)
                : [T('pick.wallet', { money: money(a.me && a.me.money) }), a.startedAt ? T('pluginmodal.clicking') : T('pluginmodal.notClicking')]; };
            const row = (a) => `
                <label class="pick pick-pill${a.startedAt ? '' : ' off'}" data-name="${esc(String(a.name || '').toLowerCase())}" data-folder="${esc(a.folder || '')}"><input type="checkbox" class="pick-cb" data-pick="acct" value="${esc(a.id)}" ${ids.has(a.id) || v.all ? 'checked' : ''} ${v.all ? 'disabled' : ''}>
                  ${avatarHtml(a)}<span class="pick-txt"><b>${esc(a.name || a.id)}</b>${lines(a).map(x => `<span>${esc(x)}</span>`).join('')}</span><span class="pick-mark" aria-hidden="true"></span></label>`;
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
                ${s.optional ? '' : `<label class="pick-all"><span class="switch"><input type="checkbox" data-pick="all" ${v.all ? 'checked' : ''}><i></i></span><span>${H('pluginmodal.all')} <span class="muted">${H('pluginmodal.allHint')}</span></span></label>`}
                ${S.accounts.length > 1 ? `<div class="pick-tools"><button class="small" data-pick="every" ${v.all ? 'disabled' : ''}>${H('pluginmodal.selectAll')}</button><button class="small" data-pick="clear" ${v.all ? 'disabled' : ''}>${H('pluginmodal.clear')}</button>
                  ${S.accounts.length > 8 ? `<input class="pick-search" data-pick="search" aria-label="${H('pluginmodal.search')}" placeholder="${H('pluginmodal.search')}">` : ''}</div>` : ''}
                <div class="pick-list pick-pills">${list}</div>
                <div class="muted pick-count"></div></div>`;
        }
        if (s.type === 'choice' && (s.options || []).some(o => o.help)) return `<div class="pset pset-wide" data-key="${key}" data-type="choice">${label}<div class="popts" role="group"${al}>${(s.options || []).map(o => `<button type="button" class="popt${o.value === s.value ? ' on' : ''}" aria-pressed="${o.value === s.value}" data-choice="${esc(o.value)}"><span class="popt-mark" aria-hidden="true"></span><span class="popt-txt"><b>${esc(o.label || o.value)}</b>${o.help ? `<span>${esc(o.help)}</span>` : ''}</span></button>`).join('')}</div></div>`;
        if (s.type === 'choice') return `<div class="pset" data-key="${key}" data-type="choice">${label}<div class="seg" role="group"${al}>${(s.options || []).map(o => `<button class="${o.value === s.value ? 'on' : ''}" aria-pressed="${o.value === s.value}" data-choice="${esc(o.value)}">${esc(o.label || o.value)}</button>`).join('')}</div></div>`;
        if (s.type === 'boolean') return `<div class="pset" data-key="${key}" data-type="boolean"><label class="pick-all"><span class="switch"><input type="checkbox" data-pset ${s.value ? 'checked' : ''}><i></i></span><span>${esc(s.label || s.key)}</span></label></div>`;
        // tags: names typed one at a time. Enter (or clicking away) turns the text into a chip and leaves an empty box for
        // the next one; clicking a chip takes it out.
        if (s.type === 'tags') return `<div class="pset pset-wide" data-key="${key}" data-type="tags">${label}<div class="ptags">${tagsHtml(s.value)}<input data-tag-input${al} spellcheck="false" autocomplete="off" placeholder="${esc(tagList(s.value).length ? T('tags.more') : s.placeholder || '')}"></div></div>`;
        // textarea: several lines (a pasted list); saved when the field loses focus.
        if (s.type === 'textarea') return `<div class="pset pset-wide" data-key="${key}" data-type="text">${label}<textarea data-pset${al} rows="6" spellcheck="false" autocomplete="off"${s.placeholder ? ` placeholder="${esc(s.placeholder)}"` : ''}>${esc(s.value || '')}</textarea></div>`;
        return `<div class="pset" data-key="${key}" data-type="${s.type === 'number' ? 'number' : 'text'}">${label}<input type="${s.type === 'number' ? 'number' : 'text'}"${s.type === 'number' ? ` step="any"${s.min != null ? ` min="${esc(s.min)}"` : ''}${s.max != null ? ` max="${esc(s.max)}"` : ''}` : ''}${s.placeholder ? ` placeholder="${esc(s.placeholder)}"` : ''} data-pset${al} value="${esc(s.type === 'number' ? plainNum(s.value) : s.value)}"></div>`;
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

    // Plugins that have switched to Live once on this panel (so the first-time warning isn't asked again).
    const liveSeen = (id) => { try { return JSON.parse(localStorage.getItem('zsb.liveOk') || '[]').includes(id); } catch (_) { return false; } };
    async function confirmLive(p) {
        const ok = await modal({ title: T('live.confirm.title', { name: p.name || p.id }), body: T('live.confirm.body'), ok: T('live.confirm.ok') });
        if (ok) try { const l = JSON.parse(localStorage.getItem('zsb.liveOk') || '[]'); if (!l.includes(p.id)) localStorage.setItem('zsb.liveOk', JSON.stringify([...l, p.id].slice(-50))); } catch (_) {}
        return !!ok;
    }

    // Live settings controls (modal or a plugin's own tab): every change is saved as it's made.
    function bindSettings(root, id, chain = () => {}) {
        const P = () => S.plugins.find(x => x.id === id) || { settings: [] };
        // Kept in pendingSaves so a button pressed right after typing (the field saves as it loses focus) runs with the new value.
        const save = (key, value) => {
            // A number outside its range is saved as the nearest allowed one: say so.
            const sp = P().settings.find(x => x.key === key), n = Number(value);
            if (sp && sp.type === 'number' && Number.isFinite(n)) {
                if (sp.min != null && n < sp.min) toast(T('pset.clamped.min', { label: sp.label || key, min: sp.min }));
                else if (sp.max != null && n > sp.max) toast(T('pset.clamped.max', { label: sp.label || key, max: sp.max }));
            }
            const pr = call('pluginSetting', id, key, value).then(r => { if (r && !r.ok) toast(plainError(r.error), 'bad'); refresh(); });
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
        const saveList = (set, rows, redraw) => { if (redraw) redrawList(set, rows); return call('pluginSetting', id, set.dataset.key, rows).then(r => { if (r && !r.ok) toast(plainError(r.error), 'bad'); return refresh(); }); };
        // An optional picker (a tool, e.g. the Proxy manager's) has no "All accounts" switch.
        const isAll = (set) => { const x = set.querySelector('[data-pick="all"]'); return !!(x && x.checked); };
        const countAccounts = (set) => {
            const boxes = [...set.querySelectorAll('[data-pick="acct"]')], all = isAll(set);
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
            const all = isAll(set), was = new Set(JSON.parse(set.dataset.ids || '[]'));
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
            // A shop grid: ticks, Select all and Queue in Opener (kept in shopSel; the totals follow).
            const sg = e.target.closest('.pshopg');
            if (sg && sg.dataset.shopK) {
                const st = shopOf(sg.dataset.shopK);
                if (e.target.hasAttribute('data-shop-all')) sg.querySelectorAll('[data-shop-tick]').forEach(x => { x.checked = e.target.checked; });
                if (e.target.hasAttribute('data-shop-queue')) { st.queue = e.target.checked; tabHtml = ''; drawPluginTab(); return; }
                if (e.target.hasAttribute('data-shop-under')) { st.under = e.target.value; return; }
                if (e.target.hasAttribute('data-shop-low')) { st.low = e.target.value; return; }
                if (e.target.hasAttribute('data-shop-high')) { st.high = e.target.value; return; }
                if (e.target.hasAttribute('data-shop-pat')) { st.pat = e.target.checked; return; }
                st.ticks = new Set([...sg.querySelectorAll('[data-shop-row]')].filter(r => r.querySelector('[data-shop-tick]').checked).map(r => r.dataset.shopRow));
                shopSync(sg);
                return;
            }
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
            if (e.target.hasAttribute('data-tiles-q')) { tilesFilter(e.target); return; }
            if (e.target.hasAttribute('data-shop-low') || e.target.hasAttribute('data-shop-high')) {
                const st = shopOf(e.target.closest('.pshopg').dataset.shopK);
                st[e.target.hasAttribute('data-shop-low') ? 'low' : 'high'] = e.target.value;
                return;
            }
            if (e.target.hasAttribute('data-shop-amt') || e.target.hasAttribute('data-shop-under')) {
                const sg = e.target.closest('.pshopg'), st = shopOf(sg.dataset.shopK);
                if (e.target.hasAttribute('data-shop-under')) st.under = e.target.value;
                else st.amt[e.target.closest('[data-shop-row]').dataset.shopRow] = e.target.value;
                shopSync(sg);
                return;
            }
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
            // A click on a plugin modal's backdrop (outside its box) closes it, as its × does.
            if (e.target.classList && e.target.classList.contains('pmodal')) {
                const x = e.target.querySelector('.pmodal-head [data-paction]');
                if (x) pluginAction(id, x);
                return;
            }
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
            // A wizard: a step row or Back / Next opens that step's window; ×, Done or a click outside closes it.
            const wz = e.target.closest('.pwiz');
            if (wz) {
                const wk = wz.dataset.wizK;
                if (e.target.classList.contains('pwiz-ov') || e.target.closest('[data-wiz-close]')) { wizGo(wk, null); return chain(e); }
                const go = e.target.closest('[data-wiz-open]');
                if (go) { wizGo(wk, go.dataset.wizOpen); return chain(e); }
                const nx = wz.dataset.wizNext;
                if (nx && e.target.closest('[data-wiz-advance] [data-choice]')) setTimeout(() => wizGo(wk, nx), 0);   // after its save below
            }
            // A shop grid: pick an item (again: put it back), the drops profile, Buy / Buy max.
            const sg = e.target.closest('.pshopg');
            if (sg && (e.target.classList.contains('pshopg-ov') || e.target.closest('[data-shop-close]'))) { shopClose(sg); return chain(e); }
            const sb = sg && e.target.closest('[data-shop-item], [data-shop-mode], [data-shop-drops], [data-shop-fav], [data-shop-buy]');
            if (sb) {
                const st = shopOf(sg.dataset.shopK);
                if (sb.dataset.shopItem != null) {
                    st.item = sb.dataset.shopItem; st.ticks = new Set(); st.amt = {};
                    tabHtml = ''; drawPluginTab();
                    const d = document.querySelector('.pshopg-detail'); if (d) d.focus();
                    return chain(e);
                }
                else if (sb.dataset.shopMode) st.mode = sb.dataset.shopMode;
                else if (sb.dataset.shopDrops) st.drops = sb.dataset.shopDrops;
                else if (sb.dataset.shopFav) st.fav = sb.dataset.shopFav;
                else {
                    const t = shopSync(sg), max = sb.dataset.shopBuy === 'max';
                    if (!t || !t.on.length) { toast(T('block.shopgrid.noneTicked')); return chain(e); }
                    const buys = t.on.map(r => ({ account: r.dataset.shopRow, n: (max ? Number(r.dataset.max) : t.amt(r)) * t.pack }));
                    const n = buys.reduce((s2, x) => s2 + x.n, 0), cost = shopUnits(n / t.pack * t.price, t.unit), name = sg.dataset.name;
                    const fav = st.fav === 'custom' ? { mode: 'custom', low: Number(st.low) || 0, high: Number(st.high) || 0, patterns: !!st.pat } : { mode: st.fav };
                    const queue = st.queue ? (st.mode === 'custom' ? { mode: 'custom', drops: st.drops, under: Number(st.under) || 0, fav } : { mode: 'default' }) : null;
                    const favs = !queue || queue.mode === 'default' ? '' : fav.mode === 'opener' ? T('block.shopgrid.favThen', { text: sg.dataset.qfavs })
                        : fav.mode === 'own' ? T('block.shopgrid.favThenOwn')
                        : T('block.shopgrid.favThen', { text: [fav.low > 0 ? T('block.shopgrid.favUnder', { n: fav.low }) : '', fav.high > 0 ? T('block.shopgrid.favOver', { n: fav.high }) : '', fav.patterns ? T('block.shopgrid.favPats') : ''].filter(Boolean).join(', ') || T('block.shopgrid.favNothing') });
                    const drops = !queue ? '' : queue.mode === 'default' ? sg.dataset.qdefault : queue.drops === 'keep' ? T('block.shopgrid.kept')
                        : T(queue.under > 0 ? 'block.shopgrid.soldUnder' : 'block.shopgrid.sold', { how: T(queue.drops === 'tokens' ? 'block.shopgrid.howTokens' : 'block.shopgrid.howCash'), under: queue.under.toLocaleString('en-US') });
                    sb.dataset.paction = sg.dataset.shopAction;
                    sb.dataset.arg = JSON.stringify({ id: st.item, buys, max, queue });
                    sb.dataset.confirm = T(max ? 'block.shopgrid.confirmMax' : 'block.shopgrid.confirm', { count: n.toLocaleString('en-US'), name, cost, accounts: `${buys.length} account${buys.length === 1 ? '' : 's'}` }) + (queue ? ' ' + T('block.shopgrid.then', { drops }) + (favs ? ' ' + favs : '') : '');
                    const k = sg.dataset.shopK, item = st.item;
                    pluginAction(id, sb).then(r => { if (r && r.ok !== false && !r.error && shopOf(k).item === item) shopClose(document.querySelector(`.pshopg[data-shop-k="${CSS.escape(k)}"]`)); });
                    return chain(e);
                }
                tabHtml = ''; drawPluginTab();
                return chain(e);
            }
            const b = e.target.closest('button');
            const set = b && b.closest('.pset');
            if (b && set && set.dataset.type === 'list' && (b.hasAttribute('data-row-add') || b.dataset.rowDel != null || b.dataset.rowUp != null)) {
                const rows = readRows(set);
                const open = openRows.get(set.dataset.key) || new Set();
                if (b.hasAttribute('data-row-add')) { rows.push(Object.fromEntries(Object.entries(listSpec(set).fields || {}).filter(([, f]) => f.type !== 'heading').map(([fk, f]) => [fk, fieldDefault(f)]))); open.add(rows.length - 1); }
                else if (b.dataset.rowUp != null) {
                    const i = Number(b.dataset.rowUp);
                    if (i > 0 && i < rows.length) {
                        [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]];
                        const a = open.has(i - 1), c = open.has(i);
                        open.delete(i - 1); open.delete(i); if (a) open.add(i); if (c) open.add(i - 1);
                    }
                }
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
            } else if (b && b.dataset.choice != null) {
                const pick = () => {
                    set.querySelectorAll('[data-choice]').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
                    save(set.dataset.key, b.dataset.choice);
                };
                // Practice to Live moves real in-game value: the first time for each plugin, say so and ask.
                const sp = P().settings.find(x => x.key === set.dataset.key);
                if (set.dataset.key === 'runMode' && b.dataset.choice === 'live' && sp && sp.value !== 'live' && !liveSeen(id)) confirmLive(P()).then(ok => { if (ok) pick(); });
                else pick();
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
                const wf = b.closest('[data-wiz-finish]') && b.closest('.pwiz');
                pluginAction(id, b).then(r => { if (wf && r && r.ok !== false && !r.error) wizGo(wf.dataset.wizK, null); });
            }
            // A step card's head opens / folds it (not when the click was on its switch).
            const head = (!b || b.classList.contains('pcard-caret')) && e.target.closest('[data-card]');
            if (head && !e.target.closest('.switch')) {
                const k = head.dataset.card;
                openCards.set(k, !head.closest('.pcard').classList.contains('open'));
                head.closest('.pcard').classList.toggle('open', openCards.get(k));
                const caret = head.querySelector('.pcard-caret'); if (caret) caret.setAttribute('aria-expanded', String(openCards.get(k)));
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
        if (b.dataset.confirm && !(await modal({ title: b.textContent.trim(), body: b.dataset.confirm, ok: b.textContent.trim(), danger: b.classList.contains('danger') }))) return null;
        b.disabled = true;
        await Promise.all([...pendingSaves]).catch(() => {});
        let r = null;
        try { r = await call('pluginAction', id, b.dataset.paction, b.dataset.arg || null); } catch (_) {}
        b.disabled = false;
        if (r && r.message) toast(r.message); else if (!r || !r.ok) toast(plainError(r && r.error) || T('toast.failed'), 'bad');
        // wizard: { id, step }: the plugin moves its wizard's window to that step (null closes it), e.g. the Trader's
        // "Check another account" going back to Send from.
        if (r && r.wizard && r.wizard.id) { const k = id + ':' + r.wizard.id; if (r.wizard.step) wizOpen.set(k, String(r.wizard.step)); else wizOpen.delete(k); tabHtml = ''; }
        refresh();
        return r;
    }

    // A plugin's own tab: blocks it returns from render(). Settings blocks show that plugin's
    // settings as live controls, so a plugin can lay out its whole setup here instead of a dialog.
    // The reference for plugin authors is docs/PLUGIN-UI.md; keep it in step with this list.
    //   stats { items: [{ label, value }] } · table { columns, rows, wrap, empty (shown with no rows) } · text { text }
    //   notice { text, level: ok|warn|bad } · bar { keys, items, text } (a toolbar) · items { items, action, empty } (inventory grid)
    //   buttons { items: [{ label, action, arg, primary, danger, confirm }] } · settings { keys }
    //   picker { action, items: [{ id, title, sub, meta, on }] } — a list to pick one from; a click sends action with the id;
    //   shop { action, unit (singular: 'credit'), items: [{ id, name, sub, price, pack, max (packs affordable) }], accounts?: [{ id, name, credits }] }
    //        — a row each with an amount; with accounts, Buy first asks which of them buy it (arg gets accounts: [ids]);
    //   the button sends action with { id, n } (n in items, whole packs)
    //   card { title, text, toggle: <boolean key>, toggleInvert (switch on = setting off), toggleDisabled (why it can't be
    //   switched now), bodyWhenOff (its body shows with the switch off too), keys, blocks } · section { title, text, blocks }
    //   hero { title, text, pill, level, buttons } · flow { items: [{ label, sub, on }] } · tip { text }
    //   checklist { items: [{ label, done, hint }] } · list { key, summaries } (rows fold to their summary)
    //   card also: id + summary + open (folds), step (number), locked (why it can't be set up yet)
    //   tiles { key, groups, search, next } (picture tiles setting a choice) · wizard { steps, extras, finish } (see wizardHtml)
    const openCards = new Map();
    const openLines = new Set();   // picker entries whose long line list is shown in full (action + id)
    // A picker entry's lines: up to 3 as they are; more fold behind "Show all" (a toggle that doesn't pick the entry).
    const pickLines = (b, i) => {
        const lines = (i.lines || []).map(String), k = b.action + ':' + i.id, open = openLines.has(k), many = lines.length > 3;
        return `<div class="ppick-lines">${(many && !open ? lines.slice(0, 3) : lines).map(l => `<div class="desc">${esc(l)}</div>`).join('')}
            ${many ? `<span class="ppick-more" role="button" tabindex="0" data-plines="${esc(k)}" aria-expanded="${open}">${open ? H('block.picker.fewer') : H('block.picker.all', { n: lines.length })}</span>` : ''}</div>`;
    };
    const btnsHtml = (items) => `<div class="pbtns">${(items || []).map(i => `<button class="${i.primary ? 'primary' : ''} ${i.danger ? 'danger' : ''}" data-paction="${esc(i.action)}" ${i.arg != null ? `data-arg="${esc(i.arg)}"` : ''} ${i.confirm ? `data-confirm="${esc(i.confirm)}"` : ''}${i.disabled ? ' disabled' : ''}>${esc(i.label)}${Number(i.badge) > 0 ? `<span class="pbtn-badge" title="${H('block.buttons.badge', { n: Number(i.badge).toLocaleString('en-US') })}">${esc(Number(i.badge) > 99 ? '99+' : String(Number(i.badge)))}</span>` : ''}</button>`).join('')}</div>`;
    // A shop grid (the Armory shop): pictures grouped by kind; picking one shows the accounts whose credits cover at least
    // one pack, each with a tickbox and an amount, Select all, Buy (the amounts) and Buy max (all each one's credits
    // cover), and optionally Queue in Opener with a drops profile. What's picked lives here (shopSel), across redraws.
    //   shopgrid { action, unit, pack, groups: [{ title, items: [{ id, name, image, price }] }], accounts: [{ id, name, credits }],
    //              queue?: { defaultText (the Opener's drops, e.g. 'sold for cash'), maxUnder, off (why it can't now) }, empty }
    //   sends action with { id, buys: [{ account, n (items) }], max, queue: null | { mode: 'default' } | { mode: 'custom', drops, under } }
    const shopSel = new Map();
    // Picture tiles that set a choice setting (the Opener's item): a search box over groups of tiles; a click saves
    // the setting. Inside a wizard step marked next, picking one goes on to the next step.
    //   tiles { key, search, next, empty, groups: [{ title, items: [{ id, name, image, sub, meta }] }] }
    const tileQ = new Map();   // plugin:key -> what's typed in its search box (kept across redraws)
    // No picture: no empty frame either (the tile shrinks to its name and price).
    const tilePic = (u, cls = '') => /^https:\/\//.test(u || '') ? `<span class="pshopg-img${cls}"><img src="${esc(u)}" alt="" loading="lazy"></span>` : `<span class="pshopg-img none${cls}"></span>`;
    function tilesHtml(b, p) {
        const sp = p.settings.find(x => x.key === b.key), cur = sp ? String(sp.value ?? '') : '';
        const k = p.id + ':' + b.key, q = (tileQ.get(k) || '').trim().toLowerCase();
        const groups = (b.groups || []).filter(g => (g.items || []).length);
        if (!groups.length) return `<p class="muted">${esc(b.empty || '')}</p>`;
        const hit = (i) => !q || String(i.name || '').toLowerCase().includes(q);
        const tile = (i) => `<button type="button" class="pshopg-tile${i.id === cur ? ' on' : ''}" aria-pressed="${i.id === cur}" data-choice="${esc(i.id)}" data-name="${esc(String(i.name || '').toLowerCase())}"${hit(i) ? '' : ' hidden'}>
            ${tilePic(i.image)}<span class="pshopg-name">${esc(i.name)}</span>${i.sub ? `<span class="pshopg-price">${esc(i.sub)}</span>` : ''}${i.meta ? `<span class="ptile-meta">${esc(i.meta)}</span>` : ''}</button>`;
        const any = groups.some(g => g.items.some(hit));
        return `<div class="pset pset-wide ptiles" data-key="${esc(b.key)}" data-type="choice"${b.next ? ' data-wiz-advance' : ''}>
            ${b.search ? `<input type="search" class="ptiles-q" data-tiles-q="${esc(k)}" value="${esc(tileQ.get(k) || '')}" placeholder="${H('block.tiles.search')}" aria-label="${H('block.tiles.search')}" autocomplete="off" spellcheck="false">` : ''}
            ${groups.map(g => `<section class="ptiles-group"${g.items.some(hit) ? '' : ' hidden'}><h5>${esc(g.title)}</h5><div class="pshopg-grid">${g.items.map(tile).join('')}</div></section>`).join('')}
            <p class="muted ptiles-none"${any ? ' hidden' : ''}>${H('block.tiles.none')}</p></div>`;
    }
    function tilesFilter(inp) {
        const box = inp.closest('.ptiles'), q = inp.value.trim().toLowerCase();
        tileQ.set(inp.dataset.tilesQ, inp.value);
        let any = false;
        box.querySelectorAll('.ptiles-group').forEach(g => {
            let n = 0;
            g.querySelectorAll('[data-choice]').forEach(t => { const on = !q || t.dataset.name.includes(q); t.hidden = !on; if (on) n++; });
            g.hidden = !n; if (n) any = true;
        });
        const none = box.querySelector('.ptiles-none'); if (none) none.hidden = any;
    }
    // A wizard: numbered steps, each a row with what it's set to; a click opens that step in a window over the page
    // with Back / Next, the last Next going to the finish (a review with the start buttons). Extras are rows under the
    // steps ("More options") that open the same kind of window with only Done. Which window is open lives here.
    //   wizard { id, steps: [{ id, title, summary, image, done, warn, text, keys, blocks, buttons (beside Next) }], extras: [same],
    //            extrasTitle, finish: { title, text, ready, next (the last Next's label), buttons, blocks } }
    const avatarHtml = (a) => { const ch = esc((String(a.name || a.id || '?').match(/[a-z0-9]/i) || ['?'])[0].toUpperCase());
        return `<span class="pick-av" aria-hidden="true" data-ch="${ch}">${a.me && a.me.image ? `<img src="${esc(a.me.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ch}</span>`; };
    let acctLines = null;   // the plugin tab being drawn: account id -> its two lines for the account pills
    const wizOpen = new Map();   // plugin:wizard id -> the open step's id, '__finish', or nothing
    function wizardHtml(b, p, settingsHtml) {
        const k = p.id + ':' + (b.id || 'wizard'), steps = b.steps || [], extras = b.extras || [], f = b.finish || null;
        const all = [...steps, ...extras];
        let cur = wizOpen.get(k) || null;
        if (cur && (cur === '__finish' ? !f : !all.some(x => x.id === cur))) cur = null;
        const si = steps.findIndex(x => x.id === cur);
        const next = si >= 0 ? (steps[si + 1] ? steps[si + 1].id : f ? '__finish' : '') : '';
        const total = steps.length + (f ? 1 : 0);
        // A step not done yet is a to-do, not a fault: its prompt (warn) reads grey in every plugin. Only a step that is
        // set but still has a problem shows the warning colour.
        const row = (x, i, go) => { const bad = !!x.warn && !!x.done; return `<button type="button" class="pwiz-row${x.done ? ' done' : ''}${bad ? ' warn' : ''}" data-wiz-open="${esc(x.id)}">
            ${i != null ? `<span class="pstep">${x.done ? '✓' : i + 1}</span>` : ''}${x.image ? tilePic(x.image, ' pwiz-img') : ''}
            <span class="pwiz-txt"><b>${esc(x.title || '')}</b><span class="${bad ? 'pcell-warn' : 'muted'}">${esc(x.warn || x.summary || '')}</span></span>
            <span class="pwiz-go">${H(go || (i == null ? 'block.wizard.open' : x.done ? 'block.wizard.change' : 'block.wizard.choose'))}</span></button>`; };
        const start = f ? `<div class="pwiz-start${f.ready ? ' ready' : ''}"><span class="pstep">${steps.length + 1}</span>
            <span class="pwiz-txt"><b>${esc(f.title || '')}</b>${f.text ? `<span class="muted">${esc(f.text)}</span>` : ''}</span>${btnsHtml(f.buttons || [])}</div>` : '';
        const page = `<ol class="pwiz-steps">${steps.map((x, i) => `<li>${row(x, i)}</li>`).join('')}${f ? `<li>${start}</li>` : ''}</ol>
            ${extras.length ? `<div class="pwiz-extras"><h5>${esc(b.extrasTitle || T('block.wizard.more'))}</h5><div class="pwiz-xgrid">${extras.map(x => row(x, null)).join('')}</div></div>` : ''}`;
        let ov = '';
        if (cur) {
            const fin = cur === '__finish', x = fin ? null : all.find(y => y.id === cur), isStep = si >= 0;
            const prev = fin ? steps[steps.length - 1] : si > 0 ? steps[si - 1] : null;
            const kicker = fin || isStep ? T('block.wizard.of', { n: fin ? total : si + 1, total }) : (b.extrasTitle || T('block.wizard.more'));
            const nextStep = steps.find(y => y.id === next);
            const body = fin
                ? `<ol class="pwiz-steps pwiz-review">${steps.map((y, i) => `<li>${row(y, i, 'block.wizard.change')}</li>`).join('')}</ol>${f.text ? `<p class="muted">${esc(f.text)}</p>` : ''}${pluginBlocks(f.blocks, p)}`
                : `${x.text ? `<p class="muted">${esc(x.text)}</p>` : ''}${(x.keys || []).length ? settingsHtml(x.keys, false, false, x.title) : ''}${pluginBlocks(x.blocks, p)}`;
            const back = prev ? `<button type="button" data-wiz-open="${esc(prev.id)}">${H('block.wizard.back')}</button>` : '';
            const foot = fin ? `${back}<span class="pwiz-sp"></span>${btnsHtml(f.buttons || [])}`
                : isStep ? `${back}<span class="pwiz-sp"></span>${(x.buttons || []).length ? btnsHtml(x.buttons) : ''}${next ? `<button type="button" class="primary" data-wiz-open="${esc(next)}">${next === '__finish' ? esc(f.next || T('block.wizard.review')) : H('block.wizard.next', { title: nextStep ? nextStep.title : '' })}</button>`
                    : `<button type="button" class="primary" data-wiz-close>${H('block.wizard.done')}</button>`}`
                : `<span class="pwiz-sp"></span><button type="button" class="primary" data-wiz-close>${H('block.wizard.done')}</button>`;
            ov = `<div class="pshopg-ov pwiz-ov"><div class="pshopg-detail pwiz-dlg" role="dialog" aria-modal="true" aria-labelledby="pwiz-title" tabindex="-1"${fin ? ' data-wiz-finish' : ''}>
                <div class="pwiz-head">${x && x.image ? tilePic(x.image, ' pwiz-img') : ''}<div class="pwiz-titles"><span class="pwiz-kicker">${esc(kicker)}</span><h4 id="pwiz-title">${esc(fin ? f.title || '' : x.title || '')}</h4></div>
                  <button type="button" class="pshopg-x" data-wiz-close aria-label="${H('block.shopgrid.close')}">×</button></div>
                ${total > 1 && (fin || isStep) ? `<div class="pwiz-dots" aria-hidden="true">${[...steps, ...(f ? [{ id: '__finish' }] : [])].map((y, i) => `<i class="${y.id === cur ? 'on' : y.done || i < si ? 'done' : ''}"></i>`).join('')}</div>` : ''}
                <div class="pwiz-body">${body}</div><div class="pwiz-foot">${foot}</div></div></div>`;
        }
        return `<div class="pwiz" data-wiz-k="${esc(k)}" data-wiz-next="${esc(next)}">${page}${ov}</div>`;
    }
    function wizGo(k, id) {
        const was = wizOpen.get(k);
        if (id) wizOpen.set(k, id); else wizOpen.delete(k);
        tabHtml = ''; drawPluginTab();
        if (id) { const d = document.querySelector('.pwiz-dlg'); if (d) { d.focus(); d.scrollTop = 0; d.querySelectorAll('.table-wrap').forEach(w => { w.scrollTop = 0; }); } }
        else { const t = was && document.querySelector(`.pwiz-steps [data-wiz-open="${CSS.escape(was)}"], .pwiz-xgrid [data-wiz-open="${CSS.escape(was)}"]`); if (t) t.focus(); }
    }
    // A shop picture the site doesn't have: an empty tile, not the browser's broken-image mark.
    document.addEventListener('error', (e) => { const t = e.target; if (t && t.tagName === 'IMG' && t.closest('.pshopg-img, .pitem-img')) t.style.visibility = 'hidden';
        else if (t && t.tagName === 'IMG' && t.parentNode && t.parentNode.classList.contains('pick-av')) t.parentNode.textContent = t.parentNode.dataset.ch || '?'; }, true);
    function shopClose(sg) {
        if (!sg) return;
        const st = shopOf(sg.dataset.shopK), was = st.item;
        st.item = null;
        tabHtml = ''; drawPluginTab();
        const t = was && document.querySelector(`[data-shop-item="${CSS.escape(was)}"]`); if (t) t.focus();
    }
    document.addEventListener('keydown', (e) => {
        const d = document.querySelector('.pshopg-detail');
        if (!d || !$('#modal').hidden) return;
        const wz = d.closest('.pwiz');
        if (e.key === 'Escape') { e.preventDefault(); if (wz) wizGo(wz.dataset.wizK, null); else shopClose(d.closest('.pshopg')); return; }
        if (e.key !== 'Tab') return;
        const f = [...d.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])')].filter(x => x.offsetParent);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (!d.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && (document.activeElement === first || document.activeElement === d)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    const shopOf = (k) => { if (!shopSel.has(k)) shopSel.set(k, { item: null, ticks: new Set(), amt: {}, queue: false, mode: 'default', drops: 'money', under: '', fav: 'opener', low: '', high: '', pat: true }); return shopSel.get(k); };
    const shopUnits = (c, unit) => `${Number(c).toLocaleString('en-US')}${unit ? ' ' + unit + (Number(c) === 1 ? '' : 's') : ''}`;
    function shopGridHtml(b, p) {
        const k = p.id + ':' + b.action, st = shopOf(k), pack = Math.max(1, Number(b.pack) || 1), unit = b.unit || '';
        const groups = (b.groups || []).filter(g => (g.items || []).length);
        const sel = groups.flatMap(g => g.items).find(i => i.id === st.item) || null;
        if (!sel) st.item = null;
        const tile = (i) => `<button type="button" class="pshopg-tile${i.id === st.item ? ' on' : ''}" data-shop-item="${esc(i.id)}" aria-pressed="${i.id === st.item}">
            <span class="pshopg-img">${/^https:\/\//.test(i.image || '') ? `<img src="${esc(i.image)}" alt="" loading="lazy">` : ''}</span>
            <span class="pshopg-name">${esc(i.name)}</span><span class="pshopg-price">${H('block.shopgrid.per', { cost: shopUnits(i.price, unit), count: pack })}</span></button>`;
        const grid = groups.length ? `<div class="pshopg-groups">${groups.map(g => `<div class="pshopg-group"><h5>${esc(g.title || '')}</h5><div class="pshopg-grid">${g.items.map(tile).join('')}</div></div>`).join('')}</div>`
            : emptyHtml(esc(b.empty || ''), '', '', true);
        if (!sel) return `<div class="pshopg" data-shop-k="${esc(k)}">${grid}</div>`;
        const price = Math.max(1, Number(sel.price) || 1);
        const able = (b.accounts || []).map(a => ({ ...a, max: Math.floor((Number(a.credits) || 0) / price) })).filter(a => a.max >= 1);
        for (const id of [...st.ticks]) if (!able.some(a => a.id === id)) st.ticks.delete(id);
        const q = b.queue || null, off = q && q.off;
        if (off) st.queue = false;
        const rows = able.map((a, n) => {
            const on = st.ticks.has(a.id), v = Math.min(a.max * pack, Math.max(pack, Number(st.amt[a.id]) || pack));
            return `<div class="pshopg-acct${on ? ' on' : ''}" data-shop-row="${esc(a.id)}" data-max="${a.max}">
                <input type="checkbox" id="shopg-${n}" data-shop-tick${on ? ' checked' : ''}>
                <label for="shopg-${n}"><b>${esc(a.name)}</b><span>${H('block.shopgrid.has', { credits: shopUnits(Number(a.credits) || 0, unit), count: (a.max * pack).toLocaleString('en-US') })}</span></label>
                <input type="number" min="${pack}" step="${pack}" max="${a.max * pack}" value="${v}" data-shop-amt aria-label="${H('block.shopgrid.amount', { name: a.name })}"></div>`;
        }).join('');
        const seg = (attr, cur, opts, label = 'block.shopgrid.profile') => `<div class="seg" role="group" aria-label="${H(label)}">${opts.map(([v, key]) => `<button type="button" class="${v === cur ? 'on' : ''}" aria-pressed="${v === cur}" ${attr}="${v}">${H(key)}</button>`).join('')}</div>`;
        const queue = !q ? '' : `<div class="pshopg-queue">
            <label class="pshopg-check"><input type="checkbox" data-shop-queue${st.queue ? ' checked' : ''}${off ? ' disabled' : ''}><b>${H('block.shopgrid.queue')}</b><span class="muted">${off ? esc(off) : H('block.shopgrid.queueHint')}</span></label>
            ${st.queue ? `${seg('data-shop-mode', st.mode, [['default', 'block.shopgrid.default'], ['custom', 'block.shopgrid.custom']])}
              ${st.mode === 'default' ? `<p class="muted">${H('block.shopgrid.defaultIs', { text: q.defaultText || '' })}${q.favText ? ' ' + H('block.shopgrid.favDefaultIs', { text: q.favText }) : ''}</p>`
                : `<div class="pshopg-custom">${seg('data-shop-drops', st.drops, [['money', 'block.shopgrid.cash'], ['tokens', 'block.shopgrid.tokens'], ['keep', 'block.shopgrid.keep']])}
                  ${st.drops !== 'keep' ? `<label class="pshopg-under"><span>${H('block.shopgrid.under', { max: '$' + Number(q.maxUnder || 0).toLocaleString('en-US') })}</span><input type="number" min="0"${q.maxUnder ? ` max="${Number(q.maxUnder)}"` : ''} step="any" value="${esc(st.under)}" data-shop-under></label>` : ''}</div>
                  <div class="pshopg-custom"><span class="pshopg-lbl">${H('block.shopgrid.fav')}</span>${seg('data-shop-fav', st.fav, [['opener', 'block.shopgrid.favOpener'], ['own', 'block.shopgrid.favOwn'], ['custom', 'block.shopgrid.custom']], 'block.shopgrid.fav')}</div>
                  ${st.fav === 'opener' ? `<p class="muted">${H('block.shopgrid.favOpenerIs', { text: q.favText || '' })}</p>` : st.fav === 'own' ? `<p class="muted">${H('block.shopgrid.favOwnIs')}</p>`
                    : `<div class="pshopg-custom">
                      <label class="pshopg-under"><span>${H('block.shopgrid.favLow')}</span><input type="number" min="0" max="0.1" step="any" placeholder="0.0000001" value="${esc(st.low)}" data-shop-low></label>
                      <label class="pshopg-under"><span>${H('block.shopgrid.favHigh')}</span><input type="number" min="0.9" max="1" step="any" placeholder="0.99999" value="${esc(st.high)}" data-shop-high></label>
                      <label class="pshopg-check"><input type="checkbox" data-shop-pat${st.pat ? ' checked' : ''}><span>${H('block.shopgrid.favPatterns')}</span></label></div>`}`}` : ''}</div>`;
        return `<div class="pshopg" data-shop-k="${esc(k)}" data-shop-action="${esc(b.action)}" data-pack="${pack}" data-price="${price}" data-unit="${esc(unit)}" data-name="${esc(sel.name)}" data-qdefault="${esc((q && q.defaultText) || '')}" data-qfavs="${esc((q && q.favText) || '')}">${grid}
          <div class="pshopg-ov"><div class="pshopg-detail" role="dialog" aria-modal="true" aria-labelledby="pshopg-title" tabindex="-1">
            <div class="pshopg-top"><span class="pshopg-img">${/^https:\/\//.test(sel.image || '') ? `<img src="${esc(sel.image)}" alt="" loading="lazy">` : ''}</span>
              <div class="pshopg-title"><h4 id="pshopg-title">${esc(sel.name)}</h4><span>${H('block.shopgrid.per', { cost: shopUnits(price, unit), count: pack })}</span></div>
              <button type="button" class="pshopg-x" data-shop-close aria-label="${H('block.shopgrid.close')}">×</button></div>
            <div class="pshopg-head"><h5>${H('block.shopgrid.who', { count: pack, cost: shopUnits(price, unit) })}</h5>
            ${able.length ? `<label class="pshopg-check"><input type="checkbox" data-shop-all${able.every(a => st.ticks.has(a.id)) ? ' checked' : ''}><span>${H('block.shopgrid.all')}</span></label><span class="muted" data-shop-count></span>` : ''}</div>
            ${able.length ? `<div class="pshopg-accts">${rows}</div>${queue}
              <div class="pshopg-bar"><button type="button" class="small" data-shop-buy="max"></button><button type="button" class="small primary" data-shop-buy="amt"></button></div>`
            : `<p class="muted">${H('block.shopgrid.none', { count: pack, cost: shopUnits(price, unit) })}</p>`}</div></div></div>`;
    }
    // The ticked count and the two Buy buttons' totals, from the grid as it is (no redraw while typing an amount).
    function shopSync(grid) {
        if (!grid || !grid.dataset.shopK) return;
        const pack = Number(grid.dataset.pack), price = Number(grid.dataset.price), unit = grid.dataset.unit;
        const rows = [...grid.querySelectorAll('[data-shop-row]')], on = rows.filter(r => r.querySelector('[data-shop-tick]').checked);
        const amt = (r) => Math.min(Number(r.dataset.max), Math.max(1, Math.round(Number(r.querySelector('[data-shop-amt]').value) / pack) || 1));
        const packs = on.reduce((s, r) => s + amt(r), 0), maxPacks = on.reduce((s, r) => s + Number(r.dataset.max), 0);
        rows.forEach(r => r.classList.toggle('on', on.includes(r)));
        const c = grid.querySelector('[data-shop-count]'); if (c) c.textContent = T('block.shopgrid.ticked', { n: on.length, total: rows.length });
        const all = grid.querySelector('[data-shop-all]'); if (all) all.checked = rows.length > 0 && on.length === rows.length;
        const bm = grid.querySelector('[data-shop-buy="max"]'), ba = grid.querySelector('[data-shop-buy="amt"]');
        if (bm) { bm.textContent = T('block.shopgrid.max', { count: (maxPacks * pack).toLocaleString('en-US'), cost: shopUnits(maxPacks * price, unit) }); bm.disabled = !on.length; }
        if (ba) { ba.textContent = T('block.shopgrid.buy', { count: (packs * pack).toLocaleString('en-US'), cost: shopUnits(packs * price, unit) }); ba.disabled = !on.length; }
        return { on, amt, pack, price, unit };
    }
    // A shop row's button: "Buy 30 for 3 credits" (items come in packs; a pack costs price).
    const shopLabel = (qty, pack, price, unit) => { const packs = Math.max(1, Math.round(Number(qty) / pack) || 1); const cost = packs * Number(price); return T('block.shop.buy', { count: packs * pack, cost: `${cost}${unit ? ' ' + unit + (cost === 1 ? '' : 's') : ''}` }); };
    // A table cell: text, or { text, level: ok|warn|bad|muted } (coloured text), { bar: 0..1, text } (a progress bar
    // with its text) or { label, action, arg, danger, confirm } (a small button, e.g. a per-row Stop).
    const cellHtml = (v) => {
        if (!v || typeof v !== 'object') return esc(v ?? '');
        if (v.action) return `<button class="small${v.primary ? ' primary' : ''}${v.danger ? ' danger' : ''}" data-paction="${esc(v.action)}"${v.arg != null ? ` data-arg="${esc(v.arg)}"` : ''}${v.confirm ? ` data-confirm="${esc(v.confirm)}"` : ''}>${esc(v.label || '')}</button>`;
        const text = `<span${v.level ? ` class="pcell-${esc(v.level)}"` : ''}>${esc(v.text ?? '')}</span>`;
        if (v.bar == null) return text;
        const pct = Math.max(0, Math.min(100, Number(v.bar) * 100 || 0));
        return `<div class="pcell-bar"><div class="pbar"><i data-w="${pct.toFixed(1)}"></i></div>${text}</div>`;
    };
    function pluginBlocks(blocks, p) {
        const setting = (k) => p.settings.find(x => x.key === k);
        const settingsHtml = (keys, bare, filters, title) => `<div class="psets${filters ? ' pfilters' : ''}">${(keys || []).map(setting).filter(Boolean).map(x => (bare ? { ...x, label: '', help: '' } : title && x.label === title && x.type !== 'boolean' ? { ...x, label: '' } : x)).map(pluginSettingHtml).join('')}</div>`;
        return (blocks || []).map(b => {
            if (b.type === 'hero') return `<div class="phero ${esc(b.level || '')}"><div class="phero-main">${b.pill ? `<span class="ppill ${esc(b.level || '')}">${esc(b.pill)}</span>` : ''}
                <div class="phero-title">${esc(b.title || '')}</div>${b.text ? `<div class="phero-text">${esc(b.text)}</div>` : ''}</div>${b.buttons ? btnsHtml(b.buttons) : ''}</div>`;
            if (b.type === 'flow') return `<div class="pflow">${b.items.map((i, n) => `${n ? '<span class="pflow-arrow">→</span>' : ''}<div class="pflow-item${i.on ? ' on' : ''}"><b>${esc(i.label)}</b><span>${esc(i.on ? i.sub || '' : i.off || 'off')}</span></div>`).join('')}</div>`;
            if (b.type === 'tip') return `<div class="ptip"><b>${H('plugintab.tip')}</b> ${esc(b.text)}</div>`;
            if (b.type === 'checklist') return `<ul class="pcheck">${b.items.map(i => `<li class="${i.done ? 'done' : ''}"><span class="pcheck-mark">${i.done ? '✓' : ''}</span><div><div>${esc(i.label)}</div>${!i.done && i.hint ? `<div class="muted">${esc(i.hint)}</div>` : ''}</div></li>`).join('')}</ul>`;
            if (b.type === 'list') { const sp = setting(b.key); return sp ? `<div class="psets">${pluginSettingHtml({ ...sp, label: '', help: '', summaries: b.summaries || [], summaryFirst: !!b.summaryFirst, images: b.images || [] })}</div>` : ''; }
            if (b.type === 'stats') return `<div class="statrow">${b.items.map(i => `<div class="stat"><span>${esc(i.label)}</span><b>${esc(i.value)}</b></div>`).join('')}</div>`;
            if (b.type === 'table') return b.rows.length ? `<div class="table-wrap"><table${b.wrap ? ' class="wrap"' : ''}><thead><tr>${b.columns.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${b.rows.map(r => `<tr>${r.map(v => `<td${v && typeof v === 'object' && v.action ? ' class="pcell-btn"' : ''}>${cellHtml(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
                : (b.empty ? emptyHtml(esc(b.empty), '', '', true) : '');
            if (b.type === 'text') return `<p class="muted ptext">${esc(b.text || '')}</p>`;
            if (b.type === 'notice') return `<div class="pnotice ${esc(b.level || '')}">${esc(b.text)}</div>`;
            if (b.type === 'buttons') return btnsHtml(b.items);
            if (b.type === 'settings') return settingsHtml(b.keys, b.bare, b.filters);
            if (b.type === 'log') return `<div class="log plog">${(b.lines || []).map(l => `<div class="${esc(l.level || '')}">${l.t ? `<span class="t">${esc(l.t)}</span> ` : ''}${esc(l.text || '')}</div>`).join('')}</div>`;
            if (b.type === 'picker') return `<div class="ppicker${b.grid ? ' grid' : ''}${b.cols === 2 ? ' cols-2' : ''}${b.multi ? ' multi' : ''}">${(b.items || []).map(i => `<button class="ppick${i.on ? ' on' : ''}" data-paction="${esc(b.action)}" data-arg="${esc(i.id)}"${b.multi ? ` aria-pressed="${i.on ? 'true' : 'false'}"` : ''}>
                <div class="ppick-head"><span class="title">${esc(i.title)}</span>${i.on ? `<span class="ppick-tag">${b.tag ? esc(b.tag) : H('block.picker.inUse')}</span>` : ''}</div>
                ${i.lines && i.lines.length ? pickLines(b, i) : i.sub ? `<div class="desc">${esc(i.sub)}</div>` : ''}${i.meta ?`<div class="ppick-meta">${esc(i.meta)}</div>` : ''}</button>`).join('')}</div>`;
            if (b.type === 'shop') return `<div class="pshop"${b.accounts && b.accounts.length ? ` data-shop-accts="${esc(JSON.stringify(b.accounts))}"` : ''}>${(b.items || []).map(i => { const n = i.pack || 1; return `<div class="pshop-row">
                <div class="pshop-name"><div class="title">${esc(i.name)}</div>${i.sub ? `<div class="desc">${esc(i.sub)}</div>` : ''}</div>
                <input type="number" min="${n}" step="${n}" value="${n}" data-shop-qty aria-label="${H('block.shop.qty', { name: i.name })}" data-pack="${n}" data-price="${esc(i.price)}" data-unit="${esc(b.unit || '')}"${i.max != null ? ` max="${esc(i.max * n)}"` : ''}>
                <button class="small" data-paction="${esc(b.action)}" data-shop="${esc(i.id)}"${i.max === 0 ? ' disabled' : ''}>${esc(shopLabel(n, n, i.price, b.unit))}</button></div>`; }).join('')}</div>`;
            if (b.type === 'shopgrid') return shopGridHtml(b, p);
            if (b.type === 'tiles') return tilesHtml(b, p);
            if (b.type === 'wizard') return wizardHtml(b, p, settingsHtml);
            // A toolbar: settings without their labels (a search box), then buttons, on one row that wraps.
            if (b.type === 'chart') return chartHtml(b);
            if (b.type === 'bar') return `<div class="ptoolbar">${(b.keys || []).length ? settingsHtml(b.keys, true) : ''}${(b.items || []).length ? pluginBlocks([{ type: 'buttons', items: b.items }], p) : ''}${b.text ? `<span class="muted ptoolbar-text">${esc(b.text)}</span>` : ''}</div>`;
            // Items like the game's inventory: picture, name, wear/float, price, a rarity stripe; click to pick.
            // A stack (qty: { n picked, of, action }) shows ×of, or n/of once picked with − + All on hover; those
            // buttons sit beside the card's own button (a button can't hold buttons), over its foot.
            const qtyBtn = (i, d, l, t) => `<button class="small" data-paction="${esc(i.qty.action)}" data-arg="${esc(i.id + '|' + d)}" title="${H(t)}">${l}</button>`;
            const qtyCtl = (i) => i.qty && i.on && !i.locked ? `<span class="pitem-ctl">${qtyBtn(i, '-1', '−', 'items.less')}<b class="pitem-ctl-n">${esc(String(i.qty.n))}/${esc(String(i.qty.of) + (i.qty.more ? "+" : ""))}</b>${qtyBtn(i, '+1', '+', 'items.more')}${qtyBtn(i, 'all', H('items.all'), 'items.all')}</span>` : '';
            // reel: one row that scrolls sideways (the Opener's drops), instead of a grid.
            if (b.type === 'items') return (b.items || []).length ? `<div class="pitems${b.reel ? ' reel' : ''}">${b.items.map(i => `<div class="pitem${i.on ? ' on' : ''}${i.locked ? ' locked' : ''}${i.qty ? ' stack' : ''}" data-arg="${esc(i.id)}"${/^[0-9a-f]{6}$/i.test(i.color || '') ? ` data-color="${esc(i.color)}"` : ''}><button class="pitem-main" data-paction="${esc(b.action)}" data-arg="${esc(i.id)}"${i.locked ? ' disabled' : ''} title="${esc(i.hint || i.title || '')}">
                <span class="pitem-img">${/^https:\/\//.test(i.image || '') ? `<img src="${esc(i.image)}" alt="" loading="lazy">` : ''}</span>
                ${(i.tags || []).length || i.fav ? `<span class="pitem-tags">${i.fav ? `<svg class="pitem-star" viewBox="0 0 24 24" role="img" aria-label="${H('items.fav')}"><path d="M12 2.6l2.85 6.05 6.6.8-4.87 4.56 1.27 6.54L12 17.3l-5.85 3.25 1.27-6.54L2.55 9.45l6.6-.8z"/></svg>` : ''}${(i.tags || []).map(t => `<span>${esc(t)}</span>`).join('')}</span>` : ''}
                <span class="pitem-title">${esc(i.title || '')}</span>${i.sub ? `<span class="pitem-sub">${esc(i.sub)}</span>` : ''}${i.detail ? `<span class="pitem-detail">${esc(i.detail)}</span>` : ''}
                <span class="pitem-foot"><b>${esc(i.price || '')}</b>${i.qty ? `<span class="pitem-qty">${i.on ? `${esc(String(i.qty.n))}/${esc(String(i.qty.of) + (i.qty.more ? "+" : ""))}` : `×${esc(String(i.qty.of) + (i.qty.more ? "+" : ""))}`}</span>` : i.meta ? `<span>${esc(i.meta)}</span>` : ''}</span>
                ${i.on ? '<span class="pitem-check" aria-hidden="true">✓</span>' : ''}</button>${qtyCtl(i)}</div>`).join('')}</div>`
                : emptyHtml(esc(b.empty || ''), '', '', true);
            if (b.type === 'section') return `<section class="psection"><h4 class="plug-head">${esc(b.title || '')}</h4>${b.text ? `<p class="muted">${esc(b.text)}</p>` : ''}${pluginBlocks(b.blocks, p)}</section>`;
            if (b.type === 'card') {
                const tg = b.toggle && setting(b.toggle), on = !tg || (b.toggleInvert ? !tg.value : !!tg.value), body = (b.keys || []).length || (b.blocks || []).length;
                const k = b.id ? p.id + ':' + b.id : null, open = !k || (openCards.has(k) ? openCards.get(k) : b.open !== false);
                const cls = ['pcard', on ? '' : 'off', b.locked ? 'locked' : '', k ? 'folds' : '', open ? 'open' : '', b.done ? 'done' : ''].filter(Boolean).join(' ');
                return `<div class="${cls}">
                    <div class="pcard-head"${k && !b.locked ? ` data-card="${esc(k)}"` : ''}>${b.step != null ? `<span class="pstep">${b.done ? '✓' : esc(b.step)}</span>` : ''}
                      ${tg && !b.locked ? `<div class="pset" data-key="${esc(tg.key)}" data-type="boolean"><label class="switch"${b.toggleDisabled ? ` title="${esc(b.toggleDisabled)}"` : ''}><input type="checkbox" data-pset aria-label="${esc(b.title || tg.key)}"${b.toggleInvert ? ' data-invert' : ''} ${on ? 'checked' : ''}${b.toggleDisabled ? ` disabled aria-describedby="${esc('why-' + p.id + '-' + (b.id || tg.key))}"` : ''}><i></i></label></div>` : ''}
                      <div class="pcard-titles"><div class="title">${esc(b.title || '')}</div>
                        ${b.locked ? `<div class="desc">${esc(b.locked)}</div>` : (b.summary && k ? `<div class="desc pcard-sum">${esc(b.summary)}</div>` : '')}
                        ${b.text && !b.locked ? `<div class="desc pcard-text">${esc(b.text)}</div>` : ''}
                        ${tg && !b.locked && b.toggleDisabled ? `<div class="desc pcard-why" id="${esc('why-' + p.id + '-' + (b.id || tg.key))}">${esc(b.toggleDisabled)}</div>` : ''}</div>
                      ${k && !b.locked && body && (on || b.bodyWhenOff) ? `<button type="button" class="pcard-caret" aria-expanded="${open}" aria-label="${H('block.card.fold', { title: b.title || '' })}"><span aria-hidden="true">⌄</span></button>` : ''}</div>
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
    // Make `live`'s children match `next`'s (a parsed copy), changing only what differs. Inline styles are left alone:
    // they're set from data attributes after each draw (the page's rules don't allow style attributes).
    function morph(live, next) {
        const want = [...next.childNodes];
        want.forEach((n, i) => {
            const cur = live.childNodes[i];
            if (!cur) return live.appendChild(n);
            if (cur.nodeType !== n.nodeType || cur.nodeName !== n.nodeName || (cur.nodeType === 1 && (cur.dataset.key || cur.dataset.arg || '') !== (n.dataset.key || n.dataset.arg || ''))) return live.replaceChild(n, cur);
            if (cur.nodeType !== 1) { if (cur.nodeValue !== n.nodeValue) cur.nodeValue = n.nodeValue; return; }
            for (const a of [...cur.attributes]) if (a.name !== 'style' && !n.hasAttribute(a.name)) cur.removeAttribute(a.name);
            for (const a of [...n.attributes]) if (a.name !== 'style' && cur.getAttribute(a.name) !== a.value) cur.setAttribute(a.name, a.value);
            morph(cur, n);
            if (cur.tagName === 'INPUT') { if (cur.value !== n.value) cur.value = n.value; cur.checked = n.checked; }
            else if (cur.tagName === 'TEXTAREA') { if (cur.value !== n.value) cur.value = n.value; }
            else if (cur.tagName === 'SELECT') cur.selectedIndex = [...n.options].findIndex(x => x.selected);
        });
        while (live.childNodes.length > want.length) live.lastChild.remove();
    }

    function drawPluginTab() {
        if (tabPressed) { tabDrawLater = true; return; }
        const t = S.tabs.find(x => 'plugin:' + x.plugin + ':' + x.title === tab);
        const c = t && t.content, p = t && S.plugins.find(x => x.id === t.plugin);
        const el = $('#tab-plugin');
        // Don't redraw under someone typing in one of its fields.
        const a = document.activeElement;
        // A drop-down is patched in place, so it may redraw once its own save is through.
        if (a && el.contains(a) && (/^(INPUT|TEXTAREA)$/.test(a.tagName) && a.type !== 'checkbox' || a.tagName === 'SELECT' && pendingSaves.size)) return;
        // A modal the tab asks for (modal: { title, blocks, close: action }): over the page, closed by its × (the action).
        const md = c && p && c.modal && Array.isArray(c.modal.blocks) ? c.modal : null;
        const mdHtml = md ? `<div class="modal pmodal" role="dialog" aria-modal="true"><div class="modal-box pmodal-box"><div class="pmodal-head"><h3>${esc(md.title || '')}</h3>${md.close ? `<button class="small ghost close-x" data-paction="${esc(md.close)}" aria-label="${H('banner.close')}" title="${H('banner.close')}">×</button>` : ''}</div>${pluginBlocks(md.blocks, p)}</div></div>` : '';
        const html = t && t.failed && p ? `<div class="pnotice bad pfailed"><b>${H('plugintab.failed.title')}</b><div class="muted">${H('plugintab.failed.body', { code: 'CC-PLUG-02' })}</div><div class="code">${esc(t.failed)}</div><div class="pbtns"><button class="small" data-act="pluginReload" data-id="${esc(p.id)}">${H('plugins.reload')}</button></div></div>`
            : !c || !p ? emptyHtml(H('plugintab.empty')) : (() => { acctLines = c.accountLines && typeof c.accountLines === 'object' ? c.accountLines : null;
                try { return `<div class="ptab">${pluginBlocks(c.blocks, p)}${mdHtml}</div>`; } finally { acctLines = null; } })();
        if (html === tabHtml && el.innerHTML) return;
        tabHtml = html;
        const tpl = document.createElement('template');
        tpl.innerHTML = html;
        morph(el, tpl.content);
        el.querySelectorAll('[data-color]').forEach(i => i.style.setProperty('--rc', '#' + i.dataset.color));   // rarity, through CSSOM
        el.querySelectorAll('[data-w]').forEach(i => { i.style.width = i.dataset.w + '%'; });   // table progress bars, the same way
        sizeCharts(el);   // chart bars
        el.querySelectorAll('.pshopg').forEach(shopSync);   // shop grid totals
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
            `<div class="${l.level}"><span class="t">${new Date(l.t).toLocaleTimeString()}</span> ${l.name ? esc(l.name) + ': ' : ''}${esc(l.msg)}</div>`).join('') || emptyHtml(only && logLines.length ? H('log.emptyFiltered') : H('log.empty'), '', '', true);
        if (atBottom) el.scrollTop = el.scrollHeight;
    }

    // --- schedule -----------------------------------------------------------
    // What's running now and what's coming up, who does it, for which accounts and why. Read-only for now, plus Run now /
    // Skip next where the owner offers them; times are changed in each plugin's own Schedule card.
    let schedPulling = false, schedLast = null;
    const span = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? T('sched.spanS', { n: s }) : s < 3600 ? T('sched.spanM', { n: Math.round(s / 60) }) : s < 86400 ? T('sched.spanH', { h: Math.floor(s / 3600), m: Math.round((s % 3600) / 60) }) : T('sched.spanD', { n: Math.round(s / 86400) }); };
    const inTime = (ms) => ms < 45000 ? T('sched.soon') : T('sched.in', { t: span(ms) });
    const clockAt = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const schedWho = (e) => e.n ? `${e.names.map(esc).join(', ')}${e.n > e.names.length ? ' ' + H('sched.more', { n: e.n - e.names.length }) : ''}` : '';
    async function drawSchedule() {
        if (!schedPulling) {
            schedPulling = true;
            call('schedule').then(r => { schedLast = r; }).catch(() => {}).finally(() => { schedPulling = false; if (tab === 'schedule') paintSchedule(); });
        }
        paintSchedule();
    }
    function paintSchedule() {
        const r = schedLast;
        if (!r) { setHtml('#tab-schedule', `<div class="muted">${H('sched.loading')}</div>`); return; }
        const off = Date.now() - r.at;   // this device's clock vs the hub's
        const nowRows = r.now.map(e => `<div class="sched-row">
            <div class="sched-when">${e.since ? H('sched.for', { t: span(r.at - e.since) }) : H('sched.waiting')}</div>
            <div class="sched-main"><div class="sched-what"><b>${esc(e.what)}</b> <span class="muted">· ${esc(e.who)}</span></div>
              ${e.n ? `<div class="sched-acc">${schedWho(e)}</div>` : ''}${e.why ? `<div class="muted sched-why">${esc(e.why)}</div>` : ''}</div></div>`).join('');
        const nextRows = r.next.map(e => {
            const rel = e.at ? e.at - r.at : null, id = esc(e.src + '|' + e.key);
            return `<div class="sched-row">
            <div class="sched-when">${rel == null ? '—' : `<b>${inTime(rel - (Date.now() - off - r.at))}</b><span class="muted">${esc(clockAt(e.at + off))}</span>`}</div>
            <div class="sched-main"><div class="sched-what"><b>${esc(e.what)}</b> <span class="muted">· ${esc(e.who)}</span></div>
              ${e.n ? `<div class="sched-acc">${e.each ? H('sched.each') + ' ' : ''}${schedWho(e)}</div>` : ''}${e.why ? `<div class="muted sched-why">${esc(e.why)}</div>` : ''}</div>
            <div class="sched-btns">${e.canRun ? `<button class="small" data-act="schedDo" data-id="${id}|run">${H('sched.run')}</button>` : ''}${e.canSkip ? `<button class="small ghost" data-act="schedDo" data-id="${id}|skip">${H('sched.skip')}</button>` : ''}</div></div>`;
        }).join('');
        setHtml('#tab-schedule', `<h4 class="plug-head">${H('sched.now')}</h4>
            ${nowRows ? `<div class="sched-list">${nowRows}</div>` : emptyHtml(H('sched.empty.now'), '', '', true)}
            <h4 class="plug-head sched-gap">${H('sched.next')}</h4>
            ${nextRows ? `<div class="sched-list">${nextRows}</div>` : emptyHtml(H('sched.empty.next'), H('sched.empty.nextHint'), '', true)}
            <p class="muted ov-note">${H('sched.note')}</p>`);
    }

    // --- settings ------------------------------------------------------------
    // A switch row; its title and description are settings.<key>.title / .desc (or the keys given).
    function sw(key, on, textKey = key) {
        return `<div class="row"><label class="switch"><input type="checkbox" data-act="setting" data-key="${key}" aria-label="${H(`settings.${textKey}.title`)}" ${on ? 'checked' : ''}><i></i></label>
            <div class="main"><div class="title">${H(`settings.${textKey}.title`)}</div><div class="desc">${H(`settings.${textKey}.desc`)}</div></div></div>`;
    }
    const row = (k, extra = '') => `<div class="row"><div class="main"><div class="title">${H(`settings.${k}.title`)}</div><div class="desc">${H(`settings.${k}.desc`)}</div></div>${extra}</div>`;

    // Settings > Discord webhooks: Drops (the Opener's own), Alerts and the Daily report. The URL itself never reaches here.
    function hookRows(h) {
        const state = (x) => !x ? '' : x.unreadable ? `<span class="share-hint bad">${H('hook.unreadable')}</span>` : x.dead ? `<span class="share-hint bad">${esc(x.dead)}</span>`
            : x.set ? H('hook.isSet', { tail: esc(x.tail) }) : H('hook.notSet');
        const btns = (kind, x) => x && x.set ? `<button class="small" data-act="hookTest" data-kind="${kind}">${H('hook.test')}</button>${kind === 'report' ? `<button class="small" data-act="hookReportNow">${H('hook.report.now')}</button>` : ''}<button class="small danger" data-act="hookClear" data-kind="${kind}">${H('hook.remove')}</button>`
            : `<button class="small" data-act="hookWalk" data-to="${kind}">${H('hook.setUp')}</button>`;
        const a = h.alerts || {}, r = h.report || {};
        const sub = !a.set ? ' off' : '';
        return `<div class="row"><div class="main"><div class="title">${H('hook.drops.title')}</div><div class="desc">${H('hook.drops.desc')}</div></div>
              ${openerOn() ? `<button class="small" data-act="hookWalk" data-to="drops">${H('hook.setUp')}</button>` : ''}</div>
            <div class="row"><div class="main"><div class="title">${H('hook.alerts.title')}</div><div class="desc">${H('hook.alerts.desc')} ${state(a)}</div></div>${btns('alerts', a)}</div>
            ${['problems', 'plugins', 'restarts'].map(k => `<div class="row sub${sub}"><label class="switch"><input type="checkbox" data-act="hookAlertOn" data-key="${k}" aria-label="${H(`hook.alerts.${k}.title`)}" ${(a.on || {})[k] !== false ? 'checked' : ''} ${a.set ? '' : 'disabled'}><i></i></label>
              <div class="main"><div class="title">${H(`hook.alerts.${k}.title`)}</div><div class="desc">${H(`hook.alerts.${k}.desc`)}</div></div></div>`).join('')}
            <div class="row"><div class="main"><div class="title">${H('hook.report.title')}</div><div class="desc">${H('hook.report.desc')} ${state(r)}${r.set && r.last ? ' · ' + H('hook.report.last', { ago: ago(r.last) }) : ''}</div></div>
              <label>${H('hook.report.time')} <input type="time" value="${esc(r.time || '09:00')}" data-act="hookTime" aria-label="${H('hook.report.time')}"></label>
              <div class="extra">${btns('report', r)}</div></div>`;
    }

    const TYPED = ['webPort', 'webPass', 'shareNameInput'];
    // The share name is checked as it is typed, like in the sharing walkthrough.
    function syncShareName() {
        const i = $('#shareNameInput'), h = $('#shareNameHint');
        if (!i || !h) return;
        const v = tidyName(i.value), bad = !!v && !NAME_RE.test(v);
        h.hidden = !bad;
        const b = document.querySelector('[data-act="shareNameSave"]');
        if (b) b.disabled = bad;
    }
    document.addEventListener('input', (e) => { if (e.target.id === 'shareNameInput') syncShareName(); });
    function drawSettings() {
        const s = S.settings, w = s.panelWeb;
        // What was typed but not saved yet (port, password, name) comes back after the redraw.
        const typed = {};
        for (const id of TYPED) { const i = document.getElementById(id); if (i && i.value !== (i.dataset.saved || '')) typed[id] = i.value; }
        // A short row of the sections on top, so Help (and the rest) is one click away instead of a long scroll.
        const jump = secs => `<nav class="set-jump" aria-label="${H('settings.jump')}">${secs.map(([k, key]) => `<button class="small ghost" data-act="setJump" data-to="${k}"${k === 'help' ? ' data-help' : ''}>${H(key)}</button>`).join('')}</nav>`;
        $('#tab-settings').innerHTML = `
        ${jump([['help', 'settings.section.help'], ['clicking', 'settings.section.clicking'], ['recover', 'settings.section.recover'], ['discord', 'settings.section.discord'], ['app', 'settings.section.app'], ['look', 'look.section'],
            ...(S.stats && S.stats.available ? [['sharing', 'settings.section.sharing']] : []), ['web', 'settings.section.web'], ['advanced', 'settings.section.advanced']])}
        <div class="rows">
          <h2 class="section-title" id="set-clicking" tabindex="-1">${H('settings.section.clicking')}</h2>
          <div class="row"><div class="main"><div class="title">${H('settings.main.title')}</div><div class="desc">${s.main && s.main.userId ? H('settings.main.is', { name: esc(s.main.name || s.main.userId) }) : H('settings.main.none')}</div></div>
            <button class="small" data-act="setMain">${H(s.main && s.main.userId ? 'settings.main.change' : 'main.set')}</button></div>
          ${sw('resumeOnLaunch', s.resumeOnLaunch, 'resume')}
          <div class="row"><div class="main"><div class="title">${H('settings.auto.title')}</div><div class="desc">${H('settings.auto.desc')}</div></div>
            <label><input type="text" inputmode="decimal" class="num-in" value="${esc(String(+Number(s.autoCasePct).toFixed(2)))}" data-act="setting" data-key="autoCasePct" aria-label="${H('settings.auto.title')}"> %</label>
            <div class="extra"><button class="small" data-act="allAuto">${H('settings.auto.all')}</button></div></div>
          ${row('caseValue')}
          <div class="row"><div class="main"><div class="title">${H('settings.maxPerIp.title')}</div><div class="desc">${H('settings.maxPerIp.desc', { max: 20 })}</div></div>
            <input type="number" min="1" max="20" value="${s.maxPerIp}" data-act="setting" data-key="maxPerIp" aria-label="${H('settings.maxPerIp.title')}"></div>

          <h2 class="section-title" id="set-recover" tabindex="-1">${H('settings.section.recover')}</h2>
          ${['slots', 'signIn', 'relaunch'].map(k => `<div class="row"><label class="switch"><input type="checkbox" data-act="recover" data-key="${k}" aria-label="${H(`settings.recover.${k}.title`)}" ${(s.autoRecover || {})[k] !== false ? 'checked' : ''}><i></i></label>
            <div class="main"><div class="title">${H(`settings.recover.${k}.title`)}</div><div class="desc">${H(`settings.recover.${k}.desc`)}</div></div></div>`).join('')}

          <h2 class="section-title" id="set-discord" tabindex="-1">${H('settings.section.discord')}</h2>
          ${row('hookWalk', `<button class="small" data-act="hookWalk">${H('settings.hookWalk.button')}</button>`)}
          ${hookRows(s.hooks || {})}

          <h2 class="section-title" id="set-app" tabindex="-1">${H('settings.section.app')}</h2>
          ${sw('startMinimized', s.startMinimized)}
          ${S.platform === 'win32' ? sw('startWithSystem', s.startWithSystem) : ''}
          ${sw('closeToTray', s.closeToTray)}
          ${sw('cleanOldSignIns', s.cleanOldSignIns !== false)}

          <h2 class="section-title" id="set-look" tabindex="-1">${H('look.section')}</h2>
          ${lookHtml(s)}
          <div class="row"><div class="main"><div class="title">${H('settings.theme.title')}</div><div class="desc">${H((S.themes || []).length ? 'settings.theme.desc' : 'settings.theme.none')}</div></div>
            <select data-act="setting" data-key="theme" aria-label="${H('settings.theme.title')}">
              <option value="">${H('settings.theme.default')}</option>
              ${(S.themes || []).map(t => `<option value="${esc(t.id)}" ${s.theme === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
              ${s.theme && !(S.themes || []).some(t => t.id === s.theme) ? `<option value="${esc(s.theme)}" selected>${H('settings.theme.off', { id: esc(s.theme) })}</option>` : ''}
            </select></div>
          ${themeOptsHtml(s)}

          ${S.stats && S.stats.available ? `<h2 class="section-title" id="set-sharing" tabindex="-1">${H('settings.section.sharing')}</h2>
          ${sw('shareStats', s.shareStats)}
          ${SHARE_CATS.map(c => `<div class="row sub${s.shareStats ? '' : ' off'}"><label class="switch"><input type="checkbox" data-act="shareMore" data-key="${c}" aria-label="${H(`share.cat.${c}.title`)}" ${(s.shareMore || {})[c] ? 'checked' : ''} ${s.shareStats ? '' : 'disabled'}><i></i></label>
            <div class="main"><div class="title">${H(`share.cat.${c}.title`)}</div><div class="desc">${H(`share.cat.${c}.desc`)}</div></div></div>`).join('')}
          ${row('shareName', `<input id="shareNameInput" aria-label="${H('settings.shareName.title')}" maxlength="32" autocomplete="off" spellcheck="false" placeholder="${H('share.name.placeholder')}" value="${esc(s.shareName || '')}">
            <button class="small" data-act="shareNameSave">${H('settings.shareName.save')}</button>
            <div class="extra share-hint bad" id="shareNameHint" role="alert" hidden>${H('settings.shareName.bad')}</div>`)}
          ${row('statsPreview', `<button class="small" data-act="statsPreview">${H('settings.statsPreview.button')}</button>`)}
          ${row('shareWalk', `<button class="small" data-act="shareWalk">${H('settings.shareWalk.button')}</button>`)}` : ''}

          <h2 class="section-title" id="set-web" tabindex="-1">${H('settings.section.web')}</h2>
          <div class="row">
            <label class="switch"><input type="checkbox" data-act="web" aria-label="${H('settings.web.title')}" ${w.enabled ? 'checked' : ''}><i></i></label>
            <div class="main"><div class="title">${H('settings.web.title')}</div>
              <div class="desc">${H('settings.web.desc', { port: w.port })}</div></div>
            <div class="extra">
              <label>${H('settings.web.port')} <input type="number" id="webPort" value="${w.port}" min="1024" max="65535"></label>
              <label>${H('settings.web.password')} <input type="password" id="webPass" placeholder="${w.hasPassword ? H('settings.web.passwordSet') : H('settings.web.passwordRequired')}"></label>
              <button class="small" data-act="webSave">${H('settings.web.save')}</button>
            </div>
          </div>

          <h2 class="section-title" id="set-help" tabindex="-1">${H('settings.section.help')}</h2>
          <div class="row"><div class="main"><div class="title">${H('settings.version.title', { version: S.version })}</div><div class="desc" id="updateText">${updateText()}</div></div>
            ${S.update && S.update.status !== 'off' ? `<button class="small" data-act="checkUpdates">${H('settings.update.check')}</button>` : ''}</div>
          ${S.update && S.update.status !== 'off' ? sw('testBuilds', s.testBuilds) : ''}
          ${row('trouble', `<button class="small" data-act="openTrouble">${H('settings.trouble.button')}</button>`)}
          ${row('tour', `<button class="small" data-act="tour">${H('settings.tour.button')}</button>`)}
          ${row('whatsnew', `<button class="small" data-act="whatsNew">${H('settings.whatsnew.button')}</button>`)}

          <h2 class="section-title" id="set-advanced" tabindex="-1">${H('settings.section.advanced')}</h2>
          ${sw('allowUnverifiedPlugins', s.allowUnverifiedPlugins, 'unverified')}
          ${webLook ? '' : row('data', `<button class="small" data-act="openDataFolder">${H('settings.data.button')}</button>`)
              + row('quit', `<button class="small danger" data-act="quit">${H('settings.quit.button')}</button>`)}
        </div>`;
        for (const id of TYPED) { const i = document.getElementById(id); if (!i) continue; i.dataset.saved = i.value; if (id in typed) i.value = typed[id]; }
        paintSwatches($('#tab-settings'));
        // the picked theme's own options, saved as they change like on its Plugins page
        const to = $('#tab-settings [data-theme-opts]');
        if (to) bindSettings(to, to.dataset.themeOpts);
        syncShareName();
    }

    // Settings > Theme: the options of the theme plugin that's picked (its look, say), right under the picker.
    function themeOptsHtml(s) {
        const p = s.theme && (S.themes || []).some(t => t.id === s.theme) && (S.plugins || []).find(x => x.id === s.theme);
        const sets = p ? (p.settings || []).filter(x => !x.page) : [];
        if (!sets.length) return '';
        return `<div class="row sub theme-opts" data-theme-opts="${esc(p.id)}"><div class="psets">${sets.map(pluginSettingHtml).join('')}</div></div>`;
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
            <div class="ichart">${bars}</div><div class="muted">${H('income.note')}</div>` : emptyHtml(H('income.empty'), '', '', true);
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
            case 'error': return H('settings.update.error', { error: plainError(u.error) });
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
        {}, { el: '#add' }, {}, { el: '#summary' }, { sample: 'hero' }, { sample: 'meters' },
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

    // --- look (Settings > Look: accent presets, custom colours) -------------
    // panel/look.js works the colours out; they go in a constructed sheet ahead of a plugin theme's (which wins).
    // Kept in localStorage too, so the panel opens in its colours instead of flashing the default first.
    const LOOK = window.ZSBLook;
    let lookSheet = null, lookSeen = null;
    function applyLook(look) {
        if (!LOOK) return;
        if (!lookSheet) { lookSheet = new CSSStyleSheet(); document.adoptedStyleSheets = [lookSheet, ...document.adoptedStyleSheets]; }
        try { lookSheet.replaceSync(LOOK.css(look)); } catch (_) { lookSheet.replaceSync(''); }
        document.documentElement.dataset.look = LOOK.vars(look).light ? 'light' : 'dark';
        // no GPU here: Fancy stays off (its glows and background would keep the CPU busy), the setting is kept
        const clean = LOOK.clean(look), fancy = clean.graphics === 'fancy' && !(window.ZSBFancy && window.ZSBFancy.noGpu);
        document.documentElement.dataset.graphics = fancy ? 'fancy' : 'simple';
        if (window.ZSBFancy) window.ZSBFancy.set(fancy, clean.scene);
    }
    try { const saved = JSON.parse(localStorage.getItem('zsb.look') || 'null'); if (saved) { applyLook(saved); lookSeen = JSON.stringify(saved); } } catch (_) {}
    function syncLook() {
        const look = S.settings && S.settings.look, k = JSON.stringify(look || null);
        if (k === lookSeen) return;
        lookSeen = k;
        applyLook(look);
        try { localStorage.setItem('zsb.look', k); } catch (_) {}
    }
    // Settings > Look: the accent buttons, the four colour boxes when it's Custom, then background, text size, corners, spacing.
    function lookHtml(s) {
        if (!LOOK) return '';
        const look = LOOK.clean(s.look), custom = look.custom || LOOK.DEFAULT_CUSTOM, on = look.accent === 'custom';
        // No GPU here: Fancy can't be used, so the Graphics choice becomes a note and Scene goes
        const noGpu = !!(window.ZSBFancy && window.ZSBFancy.noGpu);
        const opt = ([k, vals]) => ((k === 'mode' && on) || (k === 'scene' && (look.graphics !== 'fancy' || noGpu))) ? ''
            : k === 'graphics' && noGpu ? `<div class="look-opt"><span>${H('look.graphics')}</span><p class="look-note">${H('look.graphics.noGpu')}</p></div>` : `<div class="look-opt"><span>${H('look.' + k)}</span><div class="seg" role="group" aria-label="${H('look.' + k)}">${vals.map(v => `<button class="${look[k] === v ? 'on' : ''}" aria-pressed="${look[k] === v}" data-act="lookSet" data-key="${k}" data-id="${v}">${H('look.' + k + '.' + v)}</button>`).join('')}</div></div>`;
        const sw = (id, color) => `<button class="look-sw${look.accent === id ? ' on' : ''}" data-act="lookAccent" data-id="${id}" aria-pressed="${look.accent === id}"${color ? ` data-swatch="${color}"` : ''}><i></i>${H('look.accent.' + id)}</button>`;
        const warn = on ? LOOK.vars(look).warn : [];
        return `<div class="row look-row"><div class="main"><div class="title">${H('look.title')}</div><div class="desc">${H('look.desc')}</div></div><div class="look-body">
          <div class="look-sws" role="group" aria-label="${H('look.title')}">${LOOK.PRESETS.map(([id]) => sw(id, LOOK.accentOf(id, look.mode))).join('')}${sw('custom', custom.accent)}</div>
          ${on ? `<div class="look-custom">${LOOK.KEYS.map(k => `<label class="look-color"><input type="color" value="${custom[k]}" data-act="lookColor" data-key="${k}" aria-label="${H('look.color.' + k)}"><span>${H('look.color.' + k)}</span></label>`).join('')}
            <button class="small" data-act="lookReset">${H('look.reset')}</button></div>
            <p class="look-warn"${warn.length ? '' : ' hidden'}>${warn.map(w => H('look.warn.' + w)).join(' ')}</p>` : ''}
          <div class="look-opts">${LOOK.CHOICES.map(opt).join('')}</div></div></div>`;
    }
    // Swatch colours go in through CSSOM (the page's rules don't allow style attributes).
    function paintSwatches(root) { root.querySelectorAll('[data-swatch]').forEach(n => n.style.setProperty('--sw', n.dataset.swatch)); }
    // Dragging a colour box shows it right away; letting go saves it.
    function lookCustomNow() {
        const look = LOOK.clean(S.settings.look), c = { ...(look.custom || LOOK.DEFAULT_CUSTOM) };
        document.querySelectorAll('[data-act="lookColor"]').forEach(i => { c[i.dataset.key] = i.value; });
        return { ...look, accent: 'custom', custom: c };
    }
    document.addEventListener('input', (e) => {
        if (!LOOK || !e.target.matches || !e.target.matches('[data-act="lookColor"]')) return;
        const look = lookCustomNow();
        applyLook(look);
        const sw = document.querySelector('.look-sw[data-id="custom"]');
        if (sw) sw.style.setProperty('--sw', look.custom.accent);
        const w = document.querySelector('.look-warn'), list = LOOK.vars(look).warn;
        if (w) { w.hidden = !list.length; w.textContent = list.map(x => T('look.warn.' + x)).join(' '); }
    });

    // --- plugin theme ----------------------------------------------------
    // The theme picked in Settings (a plugin's ctx.panel.theme): its colour variables and CSS go in one constructed
    // stylesheet (the page's CSP allows no <style> tags, and needs none for this). Fetched only when its stamp
    // changes; the last one is remembered here so a reopened window starts in it instead of flashing the default.
    let themeSheet = null, themeStamp = null;
    function applyTheme(t) {
        if (!('adoptedStyleSheets' in document)) return;
        if (!themeSheet) { themeSheet = new CSSStyleSheet(); document.adoptedStyleSheets = [...document.adoptedStyleSheets, themeSheet]; }
        const vars = t ? Object.entries(t.vars || {}).map(([k, v]) => `--${k}: ${v};`).join(' ') : '';
        try { themeSheet.replaceSync(t ? `:root { ${vars} }
${t.css || ''}` : ''); } catch (_) { themeSheet.replaceSync(''); }
        themeStamp = t ? t.stamp : null;
        // Fancy's scene and glows take their colours from the theme
        if (window.ZSBFancy && window.ZSBFancy.recolor) window.ZSBFancy.recolor();
        document.documentElement.dataset.theme = t ? t.id : '';
    }
    try { const saved = JSON.parse(localStorage.getItem('zsb.theme') || 'null'); if (saved && saved.stamp) applyTheme(saved); } catch (_) {}
    async function syncTheme() {
        const want = S.theme ? S.theme.stamp : null;
        if (want === themeStamp) return;
        let t = null;
        if (want) { try { t = await call('theme'); } catch (_) { return; } }
        applyTheme(t);
        try { if (t && JSON.stringify(t).length < 4e6) localStorage.setItem('zsb.theme', JSON.stringify(t)); else localStorage.removeItem('zsb.theme'); } catch (_) {}
    }

    // --- refresh loop ----------------------------------------------------
    let settingsDrawn = false, tourOffered = false, whatsNewShown = false, shareOffered = false, themesSeen = '';
    async function refresh() {
        try { S = await call('state'); clockOffset = S.now - Date.now(); }
        catch (e) { $('#summary').textContent = T('header.unreachable'); return; }
        if (studio) studioAdjust(S);
        syncTheme();
        syncLook();
        // A theme plugin turned on or off: the Settings picker lists it.
        const th = JSON.stringify([S.themes || [], S.settings.theme]);
        if (th !== themesSeen) { themesSeen = th; settingsDrawn = false; }
        drawHeader(); drawBanners(); drawTabs();
        // First open: the tour, then the sharing question; after an update: the sharing question (once), then What's new.
        const askShare = !!(S.stats && S.stats.available && !S.settings.shareAsked);
        const idle = tourAt < 0 && !shareOpen && $('#modal').hidden;
        if (!S.settings.tourDone && !tourOffered && !studio) { tourOffered = true; setTimeout(startTour, 300); }
        else if (askShare && S.settings.tourDone && !shareOffered && !studio && idle) { shareOffered = true; setTimeout(() => shareWalkthrough(), 300); }
        else if (S.whatsNew && S.settings.tourDone && !askShare && !whatsNewShown && !studio && idle) { whatsNewShown = true; setTimeout(() => showWhatsNew(false), 300); }
        if (tab === 'accounts') drawAccounts();
        else if (tab === 'overview') drawOverview();
        else if (tab === 'schedule') drawSchedule();
        else if (tab === 'plugins') drawPlugins();
        else if (tab.startsWith('plugin:')) drawPluginTab();
        else if (tab === 'settings' && !settingsDrawn) { drawSettings(); settingsDrawn = true; }
        else if (tab === 'settings') { const u = $('#updateText'); if (u) setHtml(null, updateText(), u); }
        if (TR.open) { if (TR.view === 'clicks') pullClicks(); else drawTrouble(); }
        paintBusy();
    }

    // A button whose work takes a moment (the site answers, a window opens) dims until it is through, and a second
    // press waits. Kept by action + id, not by element: a redraw swaps the button for a new one mid-wait.
    const BUSY_ACTS = new Set(['schedDo', 'start', 'stop', 'folderStart', 'folderStop', 'add', 'relogin', 'pluginToggle', 'pluginInstall', 'pluginRemove', 'pluginReload', 'pluginCatalog', 'checkUpdates', 'webSave']);
    const HEAD_BUSY = { 'add|': '#add', 'startAll|': '#startAll', 'stopAll|': '#stopAll' };
    const busyKeys = new Set();
    const busyKey = (el) => el.dataset.act + '|' + (el.dataset.id || '');
    function paintBusy() {
        const mark = (el, on) => { if (on) { el.setAttribute('data-busy', ''); el.setAttribute('aria-busy', 'true'); } else { el.removeAttribute('data-busy'); el.removeAttribute('aria-busy'); } };
        for (const el of document.querySelectorAll('[data-busy]')) if (!(el.dataset.act ? busyKeys.has(busyKey(el)) : busyKeys.has(el.id + '|'))) mark(el, false);
        if (!busyKeys.size) return;
        for (const el of document.querySelectorAll('[data-act]')) if (busyKeys.has(busyKey(el))) mark(el, true);
        for (const [k, sel] of Object.entries(HEAD_BUSY)) if (busyKeys.has(k)) mark($(sel), true);
    }
    async function busyRun(key, fn) {
        if (key) { if (busyKeys.has(key)) return; busyKeys.add(key); paintBusy(); }
        try { await fn(); } catch (err) { actFailed(err); }
        finally { if (key) { busyKeys.delete(key); paintBusy(); } }
    }
    const runAct = (el, e) => busyRun(BUSY_ACTS.has(el.dataset.act) ? busyKey(el) : '', () => act(el, e));

    async function act(el, e) {
        const a = el.dataset.act, id = el.dataset.id;
        switch (a) {
            case 'menu': { const m = cards.get(id).f.menu; closeMenus(m); m.hidden = !m.hidden; menuToggled(el, m); return; }
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
            case 'acctFilter': filterBy = FILTERS.includes(id) ? id : 'all'; drawAccounts(); return;
            case 'selectMode': setSelecting(!selecting); return;
            case 'bulkAll': for (const x of shownIds()) picked.add(x); setSelecting(true); return;
            case 'bulkNone': picked.clear(); setSelecting(true); return;
            case 'bulk': await bulkAct(el.dataset.what, el.dataset.arg); break;
            case 'acctClear': { searchQ = ''; filterBy = 'all'; const box = $('#tab-accounts .acct-search'); if (box) box.value = ''; drawAccounts(); return; }
            case 'compact': {
                compact = !compact;
                try { localStorage.setItem('zsb.compactCards', compact ? '1' : '0'); } catch (_) {}
                applyCompact();
                return;
            }
            case 'ovRot': { const lookNow = S.accounts.some(needsAttention); if (lookNow && Date.now() > ovRotHold) ovRot = 0; ovRot++; ovRotHold = Date.now() + 30000; drawOverview(); return; }
            case 'ovGraph': case 'ovRange': {
                ovGraph = a === 'ovGraph' ? { ...ovGraph, what: id } : { ...ovGraph, range: id };
                if (ovGraph.what === 'off') { ovHist = null; ovHistAt = 0; }   // nothing kept or fetched while off
                try { localStorage.setItem('zsb.ovGraph', JSON.stringify(ovGraph)); } catch (_) {}
                drawOverview(); return;
            }
            case 'ovSort': {
                const k = el.dataset.key;
                ovSort = ovSort.key === k ? { key: k, dir: -ovSort.dir } : { key: k, dir: ['name', 'folder', 'status'].includes(k) ? 1 : -1 };
                try { localStorage.setItem('zsb.ovSort2', JSON.stringify(ovSort)); } catch (_) {}
                drawOverview(); return;
            }
            case 'folderMenu': { const m = sections.get(id).f.menu; closeMenus(m); m.hidden = !m.hidden; menuToggled(el, m); return; }
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
                if (r && r.ok) toast(r.replaced ? T('toast.login.again') : a === 'add' ? T(S.settings.main && S.settings.main.userId ? 'toast.login.added' : 'toast.login.addedNoMain') : T('toast.login.again'));
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
            case 'type': { const r = await call('setType', id, el.dataset.type); if (r && r.ok === false && r.error) toast(plainError(r.error), 'bad'); break; }
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
                if (r && !r.ok) toast(plainError(r.error) || T('toast.plugin.failed'), 'bad');
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
                const r = await call('pluginInstall', id);
                toast(r && r.ok ? T('toast.plugin.installed', { name: e ? e.name : id, version: e ? e.version : '' })
                    : T('plugins.err.' + ((r && r.code) || 'download')));
                break;
            }
            case 'pluginRemove': {
                const p = S.plugins.find(x => x.id === id), name = p ? p.name : id;
                if (!(await modal({ title: T('modal.pluginRemove.title', { name }), body: T('modal.pluginRemove.body'), ok: T('plugins.remove'), danger: true }))) return;
                const r = await call('pluginRemove', id);
                toast(r && r.ok ? T('toast.plugin.removed', { name }) : T('toast.plugin.removeFailed', { name }), r && r.ok ? '' : 'bad');
                break;
            }
            case 'pluginReload': {
                const r = await call('pluginReload', id);
                toast(r && r.ok === false ? (plainError(r.error) || T('toast.failed')) : T('toast.plugin.reloaded'), r && r.ok === false ? 'bad' : '');
                break;
            }
            case 'pluginCatalog': await call('pluginCatalog'); break;
            case 'pluginZip': {
                // A file input made here, not in the tab: the tab redraws while the file window is open.
                const f = await new Promise((res) => {
                    const inp = document.createElement('input');
                    inp.type = 'file'; inp.accept = '.zip,application/zip';
                    inp.addEventListener('change', () => res(inp.files && inp.files[0]), { once: true });
                    inp.addEventListener('cancel', () => res(null), { once: true });
                    inp.click();
                });
                if (!f) return;
                if (f.size > 20 * 1024 * 1024) { toast(T('plugins.import.tooBig')); return; }
                const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(f); });
                toast(T('plugins.import.working'));
                const r = await call('pluginImportZip', b64);
                toast(r && r.ok ? T(r.verified ? 'plugins.import.done' : 'plugins.import.doneUnverified', { name: r.name, version: r.version }) : T('plugins.import.failed', { why: plainError(r && r.error) || '?' }), r && r.ok ? '' : 'bad');
                break;
            }
            case 'setting': {
                if (e.type !== 'change') return;
                let v = el.type === 'checkbox' ? el.checked : el.value;
                if (el.dataset.key === 'autoCasePct') {
                    const n = Number(String(v).replace(',', '.').replace(/[%\s]/g, ''));
                    if (String(v).trim() === '' || !Number.isFinite(n) || n < 0 || n > 100) { toast(T('settings.auto.bad'), 'bad'); el.value = String(+Number(S.settings.autoCasePct).toFixed(2)); break; }
                    v = n; el.value = String(+n.toFixed(2));
                }
                if (!(await saveSettings({ [el.dataset.key]: v }))) break;
                if (el.dataset.key === 'maxPerIp') el.value = S.settings.maxPerIp;
                if (el.dataset.key === 'shareStats') settingsDrawn = false;   // the extras follow it
                break;
            }
            case 'lookAccent': {
                const look = LOOK.clean(S.settings.look);
                const next = { ...look, accent: id, custom: id === 'custom' ? look.custom || LOOK.DEFAULT_CUSTOM : look.custom };
                if (await saveSettings({ look: next })) { syncLook(); settingsDrawn = false; }
                break;
            }
            case 'lookColor': {
                if (e.type !== 'change') return;
                if (await saveSettings({ look: lookCustomNow() })) { syncLook(); settingsDrawn = false; }
                break;
            }
            case 'lookReset': {
                if (await saveSettings({ look: { ...LOOK.clean(S.settings.look), accent: 'custom', custom: LOOK.DEFAULT_CUSTOM } })) { syncLook(); settingsDrawn = false; }
                break;
            }
            case 'lookSet': {
                const look = LOOK.clean(S.settings.look);
                if (look[el.dataset.key] === id) break;
                if (await saveSettings({ look: { ...look, [el.dataset.key]: id } })) { syncLook(); settingsDrawn = false; }
                break;
            }
            case 'shareMore': {
                if (e.type !== 'change') return;
                await saveSettings({ shareMore: { [el.dataset.key]: el.checked } });
                break;
            }
            case 'shareNameSave': {
                const inp = $('#shareNameInput'), v = tidyName(inp && inp.value);
                if (v && !NAME_RE.test(v)) { toast(T('settings.shareName.bad'), 'bad'); return; }
                if (!(await saveSettings({ shareName: v }))) return;
                if (inp) { inp.value = S.settings.shareName || ''; inp.dataset.saved = inp.value; }
                toast(T(v ? 'settings.shareName.saved' : 'settings.shareName.cleared'));
                return;
            }
            case 'recover': {
                if (e.type !== 'change') return;
                await saveSettings({ autoRecover: { [el.dataset.key]: el.checked } });
                if (el.dataset.key === 'relaunch') toast(T('settings.recover.relaunch.next'));
                break;
            }
            case 'hookWalk': hookWalkthrough(el.dataset.to || 'intro'); return;
            case 'schedDo': {
                const [src, key, op] = [id.slice(0, id.indexOf('|')), id.slice(id.indexOf('|') + 1, id.lastIndexOf('|')), id.slice(id.lastIndexOf('|') + 1)];
                const r = await call('scheduleDo', src, key, op);
                toast(r && r.ok ? (r.message || T('sched.done')) : plainError(r && r.error) || T('toast.failed'), r && r.ok ? '' : 'bad');
                schedLast = null; drawSchedule();
                break;
            }
            case 'hookAlertOn': {
                if (e.type !== 'change') return;
                const r = await call('hookOptions', 'alerts', { on: { [el.dataset.key]: el.checked } });
                if (!r || !r.ok) { el.checked = !el.checked; toast(T('toast.saveFailed'), 'bad'); }
                break;
            }
            case 'hookTime': {
                if (e.type !== 'change') return;
                const r = await call('hookOptions', 'report', { time: el.value });
                if (!r || !r.ok) { toast(plainError(r && r.error) || T('toast.saveFailed'), 'bad'); settingsDrawn = false; }
                else toast(T('hook.report.timeSaved', { time: el.value }));
                break;
            }
            case 'hookTest': case 'hookReportNow': {
                const r = await call(a, el.dataset.kind);
                toast(r && r.ok ? (r.message || T('hook.walk.sent')) : plainError(r && r.error) || T('toast.failed'), r && r.ok ? '' : 'bad');
                settingsDrawn = false;
                break;
            }
            case 'hookClear': {
                const kind = el.dataset.kind;
                if (!(await modal({ title: T(`hook.${kind}.removeTitle`), body: T('hook.removeBody'), ok: T('hook.remove'), danger: true }))) return;
                const r = await call('hookClear', kind);
                toast(r && r.ok ? T('hook.removed') : T('toast.failed'), r && r.ok ? '' : 'bad');
                settingsDrawn = false;
                break;
            }
            case 'shareWalk': shareWalkthrough(); return;
            case 'web': if (e.type === 'change') { await saveWeb({ enabled: el.checked }); } break;
            case 'webSave': await saveWeb({}); break;   // port and password only: on/off stays as the switch has it
            case 'openDataFolder': await call('openDataFolder'); break;
            case 'tour': settingsDrawn = false; startTour(); return;
            case 'whatsNew': showWhatsNew(true); return;
            case 'openTrouble': openTrouble('report'); return;
            case 'setJump': { const h = document.getElementById('set-' + el.dataset.to); if (h) { h.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); h.focus({ preventScroll: true }); } return; }
            case 'statsPreview': showStats(); return;
            case 'incomeChart': showIncome(); return;
            case 'checkUpdates': await call('checkUpdates'); break;
            case 'installUpdate': toast(T('update.restarting')); await call('installUpdate'); return;
            case 'allAuto':
                if (!(await modal({ title: T('modal.allAuto.title'), body: T('modal.allAuto.body'), ok: T('modal.allAuto.ok') }))) return;
                await call('setAllType', 'auto'); toast(T('toast.allAuto')); break;
            case 'quit': if (await MODALS.quit()) call('quit'); break;
            default: return;
        }
        await refresh();
    }

    // Saves app settings. A save that fails keeps what was there and says so.
    // A button whose work threw (the hub went away, a refused call): say so instead of doing nothing.
    function actFailed(e) { console.error(e); toast(T('toast.failed'), 'bad'); }

    async function saveSettings(patch) {
        let r = null;
        try { r = await call('setSettings', patch); } catch (_) {}
        if (!r || typeof r !== 'object' || r.ok === false || r.error) { toast(T('toast.saveFailed'), 'bad'); settingsDrawn = false; return false; }
        S.settings = r;
        return true;
    }

    async function saveWeb(patch) {
        const pass = $('#webPass').value, port = $('#webPort').value;
        if (patch.enabled && !pass && !S.settings.panelWeb.hasPassword) { toast(T('toast.web.needsPassword')); settingsDrawn = false; return; }
        if (!(await saveSettings({ panelWeb: { ...patch, port, ...(pass ? { password: pass } : {}) } }))) return;
        toast(patch.enabled === false ? T('toast.web.off') : S.settings.panelWeb.enabled ? T('toast.web.on', { port: S.settings.panelWeb.port }) : T('toast.web.saved'));
        // Saved: the typed port and password are no longer "unsaved", so the redraw shows what the hub now has.
        $('#webPass').value = '';
        for (const id of ['webPort', 'webPass']) $('#' + id).dataset.saved = $('#' + id).value;
        settingsDrawn = false;
    }

    async function copyReport() {
        if (!web) { await call('copyReport'); toast(T('toast.report.app')); return; }
        const text = await call('report');
        try { await navigator.clipboard.writeText(text); toast(T('toast.report.web')); }
        catch (_) {   // plain http isn't a "secure context" for the clipboard API
            const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); toast(T('toast.report.web')); } catch (_) { toast(T('toast.report.failed'), 'bad'); }
            ta.remove();
        }
    }

    // --- Troubleshoot window -------------------------------------------------------
    // Report (copy it, with what's wrong right now), Sessions (where each account is signed in, signing those out) and
    // Clicks (refused and missed batches per account, the likely cause, each connection). Sessions are asked for only
    // while that view is open, three accounts at a time.
    const TR = { open: false, view: (() => { try { const v = localStorage.getItem('zsb.troubleView'); return ['report', 'sessions', 'clicks'].includes(v) ? v : 'report'; } catch (_) { return 'report'; } })(), sess: new Map(), openRows: new Set(), clicks: null, busy: false, queue: null, testing: false };
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

    // Which accounts have it, on this screen only (the copied report leaves names out): a few, then "and N more".
    const namesList = (names) => names.length <= 4 ? names.join(', ') : T('trouble.report.names', { names: names.slice(0, 3).join(', '), n: names.length - 3 });
    function troubleReport() {
        const codes = new Map();
        for (const i of S.appIssues) { const c = codes.get(i.code) || { i, app: false, n: 0 }; c.app = true; codes.set(i.code, c); }
        for (const a of S.accounts) for (const i of a.issues) { if (WAIT_CODES.has(i.code) && waitingForSlot(a)) continue; const c = codes.get(i.code) || { i, app: false, n: 0, names: [] }; c.n++; (c.names = c.names || []).push(a.name); codes.set(i.code, c); }
        const waiting = S.accounts.filter(waitingForSlot).length;
        const rows = [...codes.values()].map(c => `<li><span class="code">${esc(c.i.code)}</span> <span>${esc(issueText(c.i))}</span>
            <span class="muted tr-count">${[c.app ? H('trouble.report.app') : '', c.n ? esc(plural(c.n)) : ''].filter(Boolean).join(' · ')}</span>
            ${c.n ? `<div class="tr-names">${esc(namesList(c.names))}</div>` : ''}</li>`).join('');
        return `<p class="muted">${H('trouble.report.body')}</p>
            <div class="tr-sub">${H('trouble.report.problems')}</div>
            ${rows ? `<ul class="tr-issues">${rows}</ul>` : emptyHtml(H('trouble.report.none'))}
            ${waiting ? `<p class="muted">${H('trouble.report.waiting', { n: waiting })}</p>` : ''}
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
        if (!S.accounts.length) return emptyHtml(H('trouble.sessions.none'), H('trouble.sessions.noneHint'));
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
    // Only the cause word is coloured: the Sessions and Busy test buttons beside it only look, so they stay plain.
    const CAUSE_CLASS = { ok: 'muted', own: 'tr-warn', elsewhere: 'tr-bad', ip: 'tr-warn', behind: 'tr-warn' };
    function troubleClicks() {
        const c = TR.clicks;
        if (!c) return `<p class="muted">${H('trouble.clicks.body')}</p>`;
        const order = { elsewhere: 0, own: 1, ip: 2, behind: 3, ok: 4 };
        const live = c.accounts.filter(a => a.running).sort((a, b) => order[a.cause] - order[b.cause] || (b.refused + b.ipRefused) - (a.refused + a.ipRefused));
        const rows = live.map(a => `<tr><td class="tr-name">${esc(a.name)}${folderTag(a.id)}</td><td>${esc(viaText(a.route))}</td>
            <td class="num">${a.refused}</td><td class="num">${a.ipRefused}</td><td class="num">${a.missed}<span class="muted">/${a.due}</span></td>
            <td><span class="${CAUSE_CLASS[a.cause]}">${H('trouble.cause.' + a.cause)}</span>${a.cause === 'own' || a.cause === 'elsewhere' ? ` <button class="small" data-tr="toSessions" data-id="${esc(a.id)}">${H('trouble.tab.sessions')}</button>` : ''}${(a.cause === 'own' || a.cause === 'elsewhere' || a.cause === 'behind') && !(a.busy && a.busy.state === 'running') ? ` <button class="small" data-tr="busy" data-id="${esc(a.id)}" title="${esc(T('busy.tip'))}">${H(a.busy ? 'busy.again' : 'busy.btn')}</button>` : ''}${busyResult(a.busy)}${extraResult(a.extra)}</td></tr>`).join('');
        const routeName = (id) => { const r = c.routes.find(x => x.id === id); return id === 'direct' ? T('trouble.via.direct') : (r && r.label) || id; };
        const tested = new Map(((c.tested && c.tested.routes) || []).map(x => [x.id, x]));
        const routes = c.routes.map(r => {
            const t = tested.get(r.id), ip = (t && t.ip) || r.ip;
            const test = !t ? '' : !t.ok ? `<span class="tr-bad">${H('trouble.routes.failed', { why: plainError(t.error) })}</span>`
                : `<span class="${t.ms > 3000 ? 'tr-warn' : 'muted'}">${H(t.ms > 3000 ? 'trouble.routes.slow' : 'trouble.routes.ms', { ms: t.ms })}</span>`
                    + (t.sharedWith.length ? ` <span class="tr-warn">${H('trouble.routes.shared', { names: esc(t.sharedWith.map(routeName).join(', ')) })}</span>` : '');
            return `<li><b>${esc(routeName(r.id))}</b>
            <span class="muted">${ip ? esc(ip) : H('trouble.routes.noIp')}</span>${test}
            <span>${r.down ? `<span class="tr-bad">${H('trouble.routes.down')}</span>` : H('trouble.routes.used', { used: r.used, max: r.max })}</span></li>`;
        }).join('');
        return `<p class="muted">${H('trouble.clicks.body')}</p>
            ${live.length ? `<div class="table-wrap"><table class="tr-table"><thead><tr><th>${H('trouble.clicks.account')}</th><th>${H('trouble.clicks.route')}</th>
                <th class="num">${H('trouble.clicks.refused')}</th><th class="num">${H('trouble.clicks.ip')}</th><th class="num">${H('trouble.clicks.missed')}</th><th>${H('trouble.clicks.cause')}</th></tr></thead>
                <tbody>${rows}</tbody></table></div>` : emptyHtml(H('trouble.clicks.none'))}
            <div class="tr-sub tr-subrow"><span>${H('trouble.routes.title')}</span><button class="small" data-tr="test" ${TR.testing ? 'disabled' : ''}>${H(TR.testing ? 'trouble.routes.testing' : 'trouble.routes.test')}</button></div><ul class="tr-routes">${routes}</ul>`;
    }

    function drawTrouble() {
        if (!TR.open || !S) return;
        if (TR.savedView !== TR.view) { TR.savedView = TR.view; try { localStorage.setItem('zsb.troubleView', TR.view); } catch (_) {} }
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

    // One account's line in the Sessions list, updated in place (an open row needs the whole list drawn).
    function sessRow(id) {
        if (!TR.open || TR.view !== 'sessions') return;
        const row = [...trBox().querySelectorAll('.tr-row')].find(b => b.dataset.id === id);
        if (!row || TR.openRows.has(id)) { drawTrouble(); return; }
        const x = TR.sess.get(id);
        row.disabled = !(x && x.ok);
        row.querySelector('.tr-sum').innerHTML = sessionSummary(x);
    }

    // Every account's sessions, three at a time; each line updates as its answer comes in.
    async function checkSessions(have) {   // have: an account whose list is already here
        const ids = S.accounts.map(a => a.id).filter(x => x !== have), queue = { ids: [...ids] };
        TR.queue = queue;
        for (const id of ids) TR.sess.set(id, { state: 'waiting' });
        drawTrouble();
        if (!TR.clicks) TR.clicks = await call('troubleClicks');   // proxy names for the "where" column
        const worker = async () => {
            while (TR.queue === queue && queue.ids.length) {
                const id = queue.ids.shift();
                TR.sess.set(id, { state: 'loading' }); sessRow(id);
                const r = await call('troubleSessions', id).catch(() => ({ ok: false, why: 'net' }));
                if (TR.queue === queue) { TR.sess.set(id, r); sessRow(id); }
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
                if (kind === 'share') shareWalkthrough(arg || 'start');
                if (kind === 'hook') { hookOpen = false; hookWalkthrough(arg || 'intro'); }
                if (kind === 'trouble') openTrouble(arg || 'report');
            },
            toast: (key) => toast(T(key)),
        };
    }

    function menuToggled(btn, m) {
        btn.setAttribute('aria-expanded', String(!m.hidden));
        if (m.hidden) { if (menuOpen && menuOpen.menu === m) menuOpen = null; } else menuOpen = { btn, menu: m };
    }
    // Esc closes an open ⋯ or tab menu and puts focus back on its button.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !$('#modal').hidden) return;
        const btn = menuOpen ? menuOpen.btn : openGroup ? document.querySelector('[data-act="tabGroup"][aria-expanded="true"]') : null;
        if (!btn) return;
        closeMenus();
        if (btn.isConnected) btn.focus();
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.menu, [data-act="menu"], [data-act="folderMenu"], [data-act="tabGroup"]')) closeMenus();
        const el = e.target.closest('[data-act]');
        if (el && el.closest('.menu')) closeMenus();
        if (!el || el.tagName === 'INPUT') return;
        runAct(el, e);
    });
    document.addEventListener('change', (e) => { const el = e.target.closest('[data-act]'); if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT')) runAct(el, e); });
    $('#add').addEventListener('click', () => runAct({ dataset: { act: 'add' } }, {}));
    $('#import').addEventListener('click', () => importModal());

    // Import accounts: paste a list, see what was understood as you type, then sign them in.
    async function importModal() {
        let text = '', timer = null;
        const p = modal({ title: T('import.title'), wide: true, ok: T('import.ok'),
            html: `<div class="muted">${H('import.body')}</div><textarea id="importText" class="import-text" rows="8" spellcheck="false" autocomplete="off" placeholder="${H('import.placeholder')}"></textarea><div id="importPreview" class="muted import-preview"></div>` });
        const box = $('#modal .modal-box'), out = box.querySelector('#importPreview'), okBtn = box.querySelector('[data-m="ok"]');
        okBtn.disabled = true;   // nothing to import until the list has an account the hub doesn't have yet
        box.querySelector('#importText').focus();
        box.oninput = (e) => {
            if (e.target.id !== 'importText') return;
            text = e.target.value;
            clearTimeout(timer);
            timer = setTimeout(async () => {
                const r = await call('importPreview', text);
                if (!r) return;
                const fresh = r.found.filter(f => !f.already).length, already = r.found.length - fresh;
                okBtn.disabled = !fresh;
                setHtml(null, `<div><b>${H('import.found', { n: fresh })}</b>${already ? ` · ${H('import.already', { n: already })}` : ''}${r.skipped.length ? ` · ${H('import.skipped', { n: r.skipped.length })}` : ''}</div>`
                    + (r.skipped.length ? `<ul class="import-skips">${r.skipped.slice(0, 8).map(s => `<li>${esc(s.line)} — ${esc(s.why)}</li>`).join('')}</ul>` : ''), out);
            }, 250);
        };
        if (!(await p)) return;
        const r = await call('importStart', text);
        toast(r && r.ok ? T('toast.import.started', { n: r.total }) : plainError(r && r.error) || T('toast.failed'), r && r.ok ? '' : 'bad');
    }
    $('#startAll').addEventListener('click', async () => { if (!(S.settings.main && S.settings.main.userId)) { await setMainModal(); return; } busyRun('startAll|', async () => { await call('startAll'); await refresh(); }); });
    // Stop all sits next to Start all and halts the whole fleet: ask first.
    $('#stopAll').addEventListener('click', async () => {
        const n = S.accounts.filter(a => a.startedAt).length;
        if (!(await modal({ title: T('modal.stopAll.title', { n }), body: T('modal.stopAll.body'), ok: T('modal.stopAll.ok'), danger: true }))) return;
        busyRun('stopAll|', async () => { await call('stopAll'); await refresh(); });
    });
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
        // Back on the tab that was open last time (a plugin's tab that is gone falls back to Accounts in drawTabs).
        if (!studio) try { const t = localStorage.getItem('zsb.tab'); if (t && (/^(accounts|overview|plugins|log|settings)$/.test(t) || t.startsWith('plugin:'))) tab = t; } catch (_) {}
        if (studio) window.parent.postMessage({ clickerStudio: 'ready' }, location.origin);
        refresh(); pullLogs();
        setInterval(refresh, 1500);
        setInterval(pullLogs, 2000);
        setInterval(() => { if (tab === 'overview' && !document.hidden && Date.now() > ovRotHold && !matchMedia('(prefers-reduced-motion: reduce)').matches) { ovRot++; drawOverview(); } }, 8000);
        setInterval(() => { if (tab === 'accounts' && !document.hidden) for (const c of cards.values()) if (cardShows(c)) tickCard(c); }, 250);
    })();
})();
