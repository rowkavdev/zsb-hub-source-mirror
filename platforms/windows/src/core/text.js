/**
 * TEXT
 *
 * Every piece of text Clicker shows lives in text/en.json (edit it with `npm run text`, which
 * previews changes live). t('key', { name: 'x' }) returns the text with {name} filled in; a
 * missing key comes back as the key itself, so it's easy to spot. The panel gets the whole table
 * over rpc and uses the same rules.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'text', 'en.json');

function load() {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const out = {};
    for (const [k, v] of Object.entries(raw)) if (!k.startsWith('_')) out[k] = typeof v === 'string' ? v : v.text;
    return out;
}

let table = load();

const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));

function t(key, vars) { return fill(table[key] ?? key, vars); }

module.exports = { t, fill, all: () => ({ ...table }), reload: () => { table = load(); }, FILE };
