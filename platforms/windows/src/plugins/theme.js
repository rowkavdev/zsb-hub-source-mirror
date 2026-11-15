/**
 * THEMES (ctx.panel.theme / ctx.panel.asset)
 *
 * A plugin can restyle the panel: theme({ vars, css }).
 *   vars: the panel's colour variables (VARS below), e.g. { bg: '#0b1020', text: '#e6e9ff' } — with or without
 *         the leading "--". Values are colours (or, for --radius, a length): anything else is dropped.
 *   css:  optional extra CSS. It may only load the plugin's own pictures, through the exact url() that
 *         ctx.panel.asset('file.png') gave; any other url(), @import, @font-face, image-set(), escapes (\)
 *         and the like refuse the whole CSS (no outside requests: no tracking pixels, no fonts from a CDN).
 * asset(file) reads a picture from the plugin's own folder (png, jpg, gif, webp, svg; 2 MB each, 8 MB per
 * plugin) and returns a data: URL: it works the same in the app window (file://) and the browser panel, and
 * the panel's Content-Security-Policy already allows data: images and nothing else from outside.
 * Only one theme is shown at a time: the one picked in Settings > Theme (store.settings.theme). It goes away
 * when its plugin stops, and changes live when the plugin calls theme() again (e.g. from settings.onChange).
 * The class names themes can rely on are in docs/THEMES.md.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VARS = ['bg', 'surface', 'surface-2', 'surface-3', 'line', 'line-2', 'text', 'text-2', 'muted', 'white', 'on-white', 'ok', 'warn', 'bad', 'radius'];
const MAX_CSS = 100 * 1024;                 // the CSS itself, not counting the pictures in it
const MAX_ASSET = 2 * 1024 * 1024;
const MAX_ASSETS = 8 * 1024 * 1024;
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

// A colour: #rgb[a] / #rrggbb[aa], rgb()/rgba()/hsl()/hsla() with plain numbers, or a CSS colour word.
const COLOR = /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|(?:rgba?|hsla?)\(\s*[\d.%\s,/+-]+\)|[a-z]{3,20})$/i;
const LENGTH = /^\d{1,3}(?:\.\d+)?(?:px|rem|em|%)?$/;

function checkVars(vars) {
    const out = {}, dropped = [];
    for (const [k0, v0] of Object.entries(vars && typeof vars === 'object' ? vars : {})) {
        const k = String(k0).replace(/^--/, ''), v = String(v0 ?? '').trim();
        if (!VARS.includes(k)) { dropped.push(`--${k}: not a theme variable`); continue; }
        if (!(k === 'radius' ? LENGTH : COLOR).test(v) || /url|expression|var\(/i.test(v)) { dropped.push(`--${k}: "${v.slice(0, 40)}" isn't a ${k === 'radius' ? 'length' : 'colour'}`); continue; }
        out[k] = v;
    }
    return { vars: out, dropped };
}

// The CSS with the plugin's own asset URLs allowed and everything that could reach outside refused.
// Returns { css } or { error }.
function checkCss(css, assets) {
    let s = String(css ?? '');
    if (!s.trim()) return { css: '' };
    // Pull out the allowed pictures first, so what's left can be checked strictly.
    const keep = [];
    s = s.replace(/url\(\s*(['"]?)(data:[^'")\s]+)\1\s*\)/gi, (m, q, u) => {
        if (!assets.has(u)) return m;   // left in: refused below
        keep.push(u); return `url(__ZSB_ASSET_${keep.length - 1}__)`;
    });
    if (s.length > MAX_CSS) return { error: `the CSS is over ${MAX_CSS / 1024} KB` };
    s = s.replace(/\/\*[\s\S]*?\*\//g, '');
    const bad = [
        [/\\/, 'backslash escapes'],
        [/@import|@font-face|@namespace|@charset/i, '@import / @font-face'],
        [/url\(\s*(?!__ZSB_ASSET_\d+__\))/i, 'url() other than the plugin\'s own pictures (ctx.panel.asset)'],
        [/(?:image-set|image|cross-fade|element|src|paint)\s*\(/i, 'image-set() / src() and the like'],
        [/expression\s*\(|javascript:|behavior\s*:|-moz-binding/i, 'scripts in CSS'],
        [/<\/?\s*(style|script)/i, 'HTML tags'],
    ];
    for (const [re, what] of bad) if (re.test(s)) return { error: `the CSS uses ${what} — not allowed in themes` };
    return { css: s.replace(/__ZSB_ASSET_(\d+)__/g, (_, i) => `"${keep[+i]}"`) };
}

// A picture from the plugin's folder as a data: URL. budget = { used } per plugin.
function readAsset(dir, file, budget) {
    const rel = String(file || '').replace(/\\/g, '/');
    const parts = rel.split('/');
    if (!rel || rel.startsWith('/') || parts.some(x => !x || x === '.' || x === '..' || /:/.test(x))) throw new Error(`asset "${rel}": only files inside the plugin's folder`);
    const type = TYPES[path.extname(rel).toLowerCase()];
    if (!type) throw new Error(`asset "${rel}": only png, jpg, gif, webp or svg pictures`);
    const buf = fs.readFileSync(path.join(dir, ...parts));
    if (buf.length > MAX_ASSET) throw new Error(`asset "${rel}" is over 2 MB`);
    if (budget.used + buf.length > MAX_ASSETS) throw new Error('the plugin\'s pictures are over 8 MB in all');
    budget.used += buf.length;
    return `data:${type};base64,${buf.toString('base64')}`;
}

const stamp = (t) => crypto.createHash('sha1').update(JSON.stringify(t)).digest('hex').slice(0, 12);

module.exports = { VARS, checkVars, checkCss, readAsset, stamp };
