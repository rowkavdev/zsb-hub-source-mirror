/**
 * CLIENT ID
 *
 * The site's rules for scripts (2026-11): every request names the tool that sends it, in the header
 * `X-CC-Client: <name>/<version>` (HTTP) and as `auth.client` in the socket handshake. A private script
 * may add the main account it plays for: `zsb-hub/1.0.6 (main=<user id>)`. The hub always sends it.
 *
 * Format (the site's): name [A-Za-z0-9._-]{1,32}; version up to 16 printable characters without spaces or
 * parentheses; the whole value printable ASCII, at most 100 characters (longer is dropped as if not sent).
 */

const NAME = 'zsb-hub';
const HEADER = 'X-CC-Client';
// A case-clicker user id (24 hex characters, like a MongoDB id).
const USER_ID = /^[0-9a-f]{24}$/i;

function clientId(version, mainUserId) {
    const v = String(version || '').replace(/[^\x21-\x7e]|[()]/g, '').slice(0, 16);
    const base = NAME + (v ? '/' + v : '');
    if (mainUserId && USER_ID.test(mainUserId)) {
        const full = `${base} (main=${mainUserId})`;
        if (full.length <= 100) return full;
    }
    return base;
}

// A user id out of whatever was pasted: the id itself, or a profile link / text that has one in it.
function parseUserId(text) {
    const m = /(?:^|[^0-9a-f])([0-9a-f]{24})(?![0-9a-f])/i.exec(String(text || '').trim());
    return m ? m[1].toLowerCase() : null;
}

// The site's own check of a header value, for tests: a name, an optional version, an optional (main=<id>).
const VALID = /^[A-Za-z0-9._-]{1,32}(?:\/[\x21-\x27\x2a-\x7e]{1,16})?(?: \(main=[^\s()]+\))?$/;
const isValid = (v) => typeof v === 'string' && v.length <= 100 && /^[\x20-\x7e]+$/.test(v) && VALID.test(v);

module.exports = { NAME, HEADER, USER_ID, clientId, parseUserId, isValid };
