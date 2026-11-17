// The panel's look (Settings > Look): dark or light, an accent colour from the presets or custom colours (accent,
// background, cards, text), text size, corners, spacing and graphics (Simple, or Fancy: panel/fancy.js). Only a few colours are ever picked; every other one (raised
// surfaces, lines, the quieter text) is worked out from them so text stays readable: the quieter text is mixed toward
// the background only as far as it keeps 4.5:1 on every surface. On a light background the status colours get darker
// shades and the accents darker ones too (a pale accent would vanish on white); text on the accent is black or white,
// whichever reads better. A plugin theme (Settings > Theme) still goes on top.
// Loaded by the panel (window.ZSBLook) and by the hub and tests (require).
(function (root) {
    // id, on dark, on light
    const PRESETS = [
        ['white', '#ffffff', '#18181b'],
        ['sky', '#38bdf8', '#0369a1'],
        ['blue', '#7c9cff', '#2563eb'],
        ['violet', '#a78bfa', '#7c3aed'],
        ['pink', '#f472b6', '#be185d'],
        ['teal', '#2dd4bf', '#0f766e'],
    ];
    const DEFAULT_CUSTOM = { accent: '#ffffff', bg: '#000000', surface: '#0a0a0b', text: '#f4f4f5' };
    const LIGHT_BASE = { bg: '#f4f4f5', surface: '#ffffff', text: '#18181b' };
    const KEYS = ['accent', 'bg', 'surface', 'text'];
    // The other choices: [setting, its values (the first is the default)].
    const CHOICES = [
        ['mode', ['dark', 'light']],
        ['size', ['normal', 'small', 'large']],
        ['corners', ['round', 'square', 'cut', 'scoop', 'notch']],
        ['spacing', ['comfortable', 'compact']],
        ['graphics', ['simple', 'fancy']],
        ['scene', ['shards', 'galaxy', 'flux', 'network']],   // the moving background in Fancy: panel/fancy.js + html[data-graphics="fancy"] rules in panel.css
    ];
    // Older saved values and what they became.
    const RENAMED = { scene: { aurora: 'shards', grid: 'shards', stars: 'galaxy' } };
    const SIZE = { small: 0.92, normal: 1, large: 1.12 };
    // [small, medium, large, pill radius, corner-shape]. Cut, scoop and notch use CSS corner-shape (borders follow it);
    // a browser without it just shows round corners. Cut turns pills into long hexagons.
    const CORNERS = {
        round: null,
        square: ['3px', '4px', '5px', '4px'],
        cut: ['6px', '9px', '12px', '999px', 'bevel'],
        scoop: ['8px', '14px', '20px', '14px', 'scoop'],
        notch: ['6px', '10px', '14px', '8px', 'notch'],
    };
    // Dots, check marks and switches stay round.
    const CIRCLES = '.logo, .logo::after, .chip::before, .switch i, .switch i::after, .pcheck-mark, .pstep, .pitem-check, .look-sw i';
    // Compact: the main containers' gaps and padding (compact cards in the Accounts tab keep their own, tighter ones).
    const COMPACT = `.top { padding-top: 10px; padding-bottom: 10px; gap: 14px; }
.tabs { margin-top: 12px; }
.grid { gap: 10px; }
.card { padding: 13px; gap: 11px; }
.kv { padding: 9px; gap: 7px 8px; }
.sections { gap: 16px; }
.rows { gap: 7px; }
.row { padding: 10px 12px; gap: 10px; }
.pcard { padding: 10px 12px; gap: 9px; }
.pcard-body { gap: 9px; }`;
    const HEX = /^#[0-9a-f]{6}$/i;

    const rgb = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    const hex = (c) => '#' + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
    // a toward b by t (0 = a, 1 = b)
    const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
    function lum(h) {
        const [r, g, b] = rgb(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    function contrast(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
    const onColor = (h) => (contrast(h, '#000000') >= contrast(h, '#ffffff') ? '#000000' : '#ffffff');
    // The most text can be faded toward the background and still read at `need`:1 on every surface.
    function fade(text, toward, surfaces, need, most) {
        for (let t = most; t > 0; t -= 0.02) {
            const c = mix(text, toward, t);
            if (surfaces.every(s => contrast(c, s) >= need)) return c;
        }
        return text;
    }

    // A saved look, cleaned: { accent: preset id | 'custom', custom: {accent, bg, surface, text} | null, mode, size, corners, spacing }.
    function clean(look) {
        const l = look && typeof look === 'object' ? look : {};
        const out = { accent: l.accent === 'custom' || PRESETS.some(p => p[0] === l.accent) ? l.accent : 'white', custom: null };
        if (l.custom && typeof l.custom === 'object') {
            out.custom = {};
            for (const k of KEYS) out.custom[k] = HEX.test(l.custom[k] || '') ? l.custom[k].toLowerCase() : DEFAULT_CUSTOM[k];
        }
        for (const [k, vals] of CHOICES) { const v = (RENAMED[k] && RENAMED[k][l[k]]) || l[k]; out[k] = vals.includes(v) ? v : vals[0]; }
        return out;
    }
    // A preset accent's colour on dark or light.
    const accentOf = (id, mode) => { const p = PRESETS.find(x => x[0] === id) || PRESETS[0]; return mode === 'light' ? p[2] : p[1]; };

    // Every colour from the four picked ones.
    function derive(c) {
        const light = lum(c.bg) > 0.35;
        const s2 = mix(c.surface, c.text, 0.04), s3 = mix(c.surface, c.text, 0.08);
        const all = [c.bg, c.surface, s2, s3];
        const v = {
            '--bg': c.bg, '--surface': c.surface, '--surface-2': s2, '--surface-3': s3,
            '--line': mix(c.surface, c.text, 0.10), '--line-2': mix(c.surface, c.text, 0.17),
            '--text': c.text,
            '--text-2': fade(c.text, c.surface, all, 7, 0.4),
            '--muted': fade(c.text, c.surface, all, 4.5, 0.6),
            '--white': c.accent, '--on-white': onColor(c.accent),
        };
        if (light) Object.assign(v, { '--ok': '#166534', '--warn': '#92400e', '--bad': '#b91c1c' });
        return { v, light };
    }

    // The CSS variables for a look ({} = the default look), whether it is light, the extra rules, and what is hard to read.
    function vars(look) {
        const l = clean(look);
        let v = {}, light = false;
        const warn = [];
        if (l.accent === 'custom') {
            const c = l.custom || DEFAULT_CUSTOM;
            ({ v, light } = derive(c));
            if (Math.min(contrast(c.text, c.bg), contrast(c.text, c.surface)) < 4.5) warn.push('text');
            if (Math.min(contrast(c.accent, c.bg), contrast(c.accent, c.surface)) < 3) warn.push('accent');
        } else if (l.mode === 'light') {
            ({ v, light } = derive({ ...LIGHT_BASE, accent: accentOf(l.accent, 'light') }));
        } else if (l.accent !== 'white') {
            const a = accentOf(l.accent, 'dark');
            v = { '--white': a, '--on-white': onColor(a) };
        }
        if (l.size !== 'normal') v['--fs-scale'] = String(SIZE[l.size]);
        const r = CORNERS[l.corners];
        if (r) Object.assign(v, { '--r-s': r[0], '--r-m': r[1], '--radius': r[2], '--r-pill': r[3] });
        const shape = r && r[4] ? `*, ::before, ::after { corner-shape: ${r[4]}; }\n${CIRCLES} { corner-shape: round; }` : '';
        const rules = [shape, l.spacing === 'compact' ? COMPACT : ''].filter(Boolean).join('\n');
        return { vars: v, light, rules, warn };
    }

    // The stylesheet text for a look ('' = the default).
    function css(look) {
        const r = vars(look), keys = Object.keys(r.vars);
        const root = keys.length || r.light ? `:root { ${keys.map(k => `${k}: ${r.vars[k]};`).join(' ')}${r.light ? ' color-scheme: light;' : ''} }` : '';
        return [root, r.rules].filter(Boolean).join('\n');
    }

    const api = { PRESETS, DEFAULT_CUSTOM, KEYS, CHOICES, clean, vars, css, contrast, mix, accentOf };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ZSBLook = api;
})(typeof window !== 'undefined' ? window : this);
