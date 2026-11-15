/**
 * WHAT'S NEW
 *
 * text/whats-new.json holds a few lines per released version. After an update the panel shows
 * the lines for every version since the one last seen (settings.lastVersion), once. A fresh
 * install has nothing to catch up on, so it starts as "seen".
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'text', 'whats-new.json');

// "1.0.10" > "1.0.9"; anything after a "-" (1.1.0-beta.2) is ignored.
function cmp(a, b) {
    const pa = String(a).split('-')[0].split('.').map(Number), pb = String(b).split('-')[0].split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    return 0;
}

function load(file = FILE) {
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Object.entries(raw).filter(([v, items]) => !v.startsWith('_') && Array.isArray(items))
            .map(([version, items]) => ({ version, items })).sort((a, b) => cmp(b.version, a.version));
    } catch (_) { return []; }
}

class WhatsNew {
    constructor({ version, store, file }) {
        this.version = version;
        this.store = store;
        this.entries = load(file);
        const s = store.settings;
        // No lastVersion yet: a fresh install (nothing done) has seen everything; an install from
        // before this existed (walkthrough seen or accounts added) gets this version's notes.
        if (!s.lastVersion && !s.tourDone && !store.accounts.length) store.setSettings({ lastVersion: version });
    }

    // Versions after the last one seen, up to this one, newest first.
    unseen() {
        const last = this.store.settings.lastVersion;
        if (last && cmp(last, this.version) >= 0) return [];
        return this.entries.filter(e => cmp(e.version, this.version) <= 0 && (last ? cmp(e.version, last) > 0 : e.version === this.version));
    }

    recent(n = 5) { return this.entries.filter(e => cmp(e.version, this.version) <= 0).slice(0, n); }

    seen() { this.store.setSettings({ lastVersion: this.version }); }
}

module.exports = { WhatsNew, load, cmp, FILE };
