/**
 * ACCOUNT IMPORT: reading a pasted list
 *
 * Takes whatever people paste — "email:password", "email,password", tabs, semicolons, pipes, quotes, a header row,
 * several accounts on one line, the password first, extra columns after — and finds the email and password in each
 * entry. Pure (no Electron), so it tests in Node.
 *
 *   parseAccounts(text) -> { found: [{ email, password }], skipped: [{ line, why }] }
 *
 * A password is never put in `skipped` (lines are shown with the password hidden).
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const EMAIL_G = new RegExp(EMAIL.source, 'g');
const SEPS = /^[\s:;,|\t=]+|[\s:;,|\t=]+$/g;
const HEADER = /^\s*["']?(e-?mail|login|user(name)?|account)["']?\s*[:;,|\t]\s*["']?(pass(word)?|pwd)["']?\s*$/i;

// "a@b.com:secret" -> the line with the password hidden, for the skipped list.
const hide = (s) => String(s).replace(EMAIL, (m) => m).replace(/([:;,|\t=]\s*)\S.*$/, '$1••••').slice(0, 80);
const unquote = (s) => s.replace(/^["'`]+|["'`]+$/g, '');

// One entry that holds a single email: the password is what's left beside it.
function pairOf(entry) {
    const m = EMAIL.exec(entry);
    if (!m) return null;
    const email = m[0].toLowerCase();
    const before = unquote(entry.slice(0, m.index).replace(SEPS, '').trim());
    let after = entry.slice(m.index + m[0].length);
    // A separator right after the email; the password runs to the next tab or " | " (an extra column), else to the end.
    after = after.replace(/^["'`]?[\s]*[:;,|\t=][\s]*/, '');
    const col = after.search(/\t|\s\|\s/);
    if (col >= 0) after = after.slice(0, col);
    let password = unquote(after.trim());
    // Password first ("secret:a@b.com"), when nothing came after the email.
    if (!password && before) password = before;
    return { email, password };
}

function parseAccounts(text) {
    const found = [], skipped = [], seen = new Set();
    const lines = String(text || '').split(/\r?\n/);
    lines.forEach((raw, i) => {
        const line = raw.trim();
        if (!line || /^#|^\/\//.test(line) || (i === 0 && HEADER.test(line))) return;
        // Several accounts on one line ("a@x.com:p1, b@y.com:p2"): split before each email after the first.
        const emails = line.match(EMAIL_G) || [];
        let entries = [line];
        if (emails.length > 1) {
            entries = [];
            let rest = line;
            for (let k = emails.length - 1; k > 0; k--) {
                const at = rest.lastIndexOf(emails[k]);
                // Cut at the separator just before that email.
                const cut = rest.slice(0, at).search(/[\s,;|]+$/);
                entries.unshift(rest.slice(cut >= 0 ? cut : at));
                rest = rest.slice(0, cut >= 0 ? cut : at);
            }
            entries.unshift(rest);
        }
        for (const e of entries) {
            const p = pairOf(e.replace(/^[\s,;|]+/, ''));
            if (!p) { skipped.push({ line: hide(e), why: 'no email in it' }); continue; }
            if (!p.password) { skipped.push({ line: p.email, why: 'no password next to the email' }); continue; }
            if (/\s/.test(p.password) && p.password.split(/\s+/).length > 3) { skipped.push({ line: p.email, why: 'the password looks like several words — check the line' }); continue; }
            if (seen.has(p.email)) { skipped.push({ line: p.email, why: 'listed twice' }); continue; }
            seen.add(p.email);
            found.push(p);
        }
    });
    return { found, skipped };
}

module.exports = { parseAccounts };
