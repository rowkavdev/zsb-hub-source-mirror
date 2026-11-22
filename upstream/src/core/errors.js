/**
 * ERROR CODES
 *
 * Every problem the app knows about has a code (CC-<AREA>-<NN>), one plain-English line and a fix.
 * Problems are "raised" on an account (or on the app, account null) and stay active until the
 * thing that fixes them happens — a working click clears network problems, a new token clears a
 * logout — so the panel only ever shows what is wrong right now.
 */

const EventEmitter = require('events');
const { t } = require('./text');

// group: what clears it. 'net' issues clear on any successful request for that account,
// 'auth' on a working token, 'cf' when Cloudflare lets a request through, 'site' when the site answers again after
// maintenance, 'route' when a request through that proxy works again, 'manual' never by itself.
// 'notice' is a heads-up: shown on the card, but the account still counts as clicking.
// The wording (text, fix) is in text/en.json as error.<code>.text / .fix.
const GROUPS = {
    'CC-AUTH-01': 'auth', 'CC-AUTH-02': 'manual', 'CC-CF-01': 'cf', 'CC-RATE-01': 'manual', 'CC-RATE-02': 'net',
    'CC-NET-01': 'net', 'CC-NET-02': 'net', 'CC-SITE-01': 'net', 'CC-SITE-02': 'site', 'CC-API-01': 'net',
    'CC-PLUG-01': 'manual', 'CC-PLUG-02': 'manual', 'CC-PLUG-03': 'manual', 'CC-PLUG-04': 'manual', 'CC-UNK-01': 'net',
    'CC-SLOW-01': 'manual', 'CC-AUTH-03': 'notice', 'CC-PROXY-01': 'route', 'CC-PROXY-02': 'route', 'CC-AUTH-04': 'auth',
    'CC-AUTH-05': 'notice', 'CC-AUTH-06': 'notice', 'CC-AUTH-07': 'notice', 'CC-AUTH-08': 'manual', 'CC-MAIN-01': 'manual',
    'CC-NET-03': 'manual',
};
const CODES = Object.fromEntries(Object.entries(GROUPS).map(([code, group]) => [code, {
    group,
    get text() { return t(`error.${code}.text`); },
    get fix() { return t(`error.${code}.fix`); },
}]));

class Errors extends EventEmitter {
    constructor() {
        super();
        this.codes = { ...CODES };
        this.active = new Map();   // `${acct}|${code}` -> { acct, code, detail, count, first, last }
        // code -> times it started since the app started (for the report and the diagnostics). Raising one that's
        // already on doesn't count again: some are raised on every check while they last, which read as thousands.
        this.counts = new Map();
    }

    define(code, { text, fix, group = 'manual' }) {
        if (!/^CC-[A-Z0-9]+-\d{2}$/.test(code)) throw new Error('Bad error code: ' + code);
        if (CODES[code]) throw new Error('Core code can\'t be redefined: ' + code);
        this.codes[code] = { group, text, fix };
    }

    raise(acct, code, detail = '') {
        if (!this.codes[code]) { detail = code + (detail ? ' ' + detail : ''); code = 'CC-UNK-01'; }
        const key = (acct || '') + '|' + code, now = Date.now();
        const cur = this.active.get(key);
        if (cur) { cur.count++; cur.last = now; if (detail) cur.detail = detail; return; }
        this.counts.set(code, (this.counts.get(code) || 0) + 1);
        this.active.set(key, { acct: acct || null, code, detail, count: 1, first: now, last: now });
        this.emit('change');
    }

    clear(acct, code) {
        if (this.active.delete((acct || '') + '|' + code)) this.emit('change');
    }

    // A success of some kind for this account: drop every issue that kind of success fixes.
    clearGroup(acct, ...groups) {
        let changed = false;
        for (const [key, it] of this.active) {
            if (it.acct === (acct || null) && groups.includes(this.codes[it.code].group)) { this.active.delete(key); changed = true; }
        }
        if (changed) this.emit('change');
    }

    clearAccount(acct) {
        let changed = false;
        for (const [key, it] of this.active) if (it.acct === acct) { this.active.delete(key); changed = true; }
        if (changed) this.emit('change');
    }

    has(acct, code) { return this.active.has((acct || '') + '|' + code); }

    list(acct) {
        const out = [];
        for (const it of this.active.values()) {
            if (acct !== undefined && it.acct !== acct) continue;
            out.push({ ...it, ...this.codes[it.code] });
        }
        return out.sort((a, b) => b.last - a.last);
    }
}

module.exports = { Errors, CODES };
