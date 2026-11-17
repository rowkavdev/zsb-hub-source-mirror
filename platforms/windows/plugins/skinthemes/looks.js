// The curated looks: a whole panel styled after a skin (colours, a heading font, small details), no picture of it.
// Each look: { id, name, font: { file, family } (headings), body: { file, family } (all
// other text: a variable font, every weight in one file), heads (where the heading font goes, when not HEADS), vars,
// css(art) } where art(file) is ctx.panel.asset for the plugin's art/ and fonts/ folders. The heading font goes on the
// brand, tabs, section titles, card names and plugin card heads; code and the log keep the panel's monospace font.

const HEADS = '.brand, .tabs button, .section-title, .c-title .name, .pcard-head, .modal-box h2, main h2';
const FALLBACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

// What every look shares: its fonts, a wash behind the page, the selected tab and main buttons.
function base(l, art) {
    const face = (f, weights) => `@font-face { font-family: "${f.family}"; src: url(${art('fonts/' + f.file)}) format("woff2");${weights ? ` font-weight: ${weights};` : ''} font-display: swap; }`;
    return [
        face(l.body, '100 900'),
        l.font.family === l.body.family ? '' : face(l.font),
        // lining figures: some of these fonts draw old-style numbers by default, which look off in money columns
        l.light ? `:root { color-scheme: light; }` : '',
        `html, body { font-family: "${l.body.family}", ${FALLBACK}; font-variant-numeric: lining-nums; }`,
        `${l.heads || HEADS} { font-family: "${l.font.family}", "${l.body.family}", ${FALLBACK}; }`,
        `html { background: ${l.wash}, var(--bg); background-attachment: fixed; } body { background: transparent; }`,
        `.tabs button[aria-selected="true"] { background: ${l.fill}; color: var(--on-white); }`,
        `button.primary { background: ${l.fill}; border-color: transparent; color: var(--on-white); }`,
        `.top::after { content: ""; position: absolute; left: 0; right: 0; bottom: -1px; pointer-events: none; }`,
    ].join('\n');
}

const LOOKS = [
    {
        id: 'gungnir', name: 'AWP | Gungnir',
        font: { file: 'cinzel-body.woff2', family: 'ZSB Cinzel' },
        body: { file: 'cinzel-body.woff2', family: 'ZSB Cinzel' },   // Nordic capitals everywhere
        // deep fjord navy, ice-white details, a cold blue second colour
        vars: {
            bg: '#060b14', surface: '#0b1422', 'surface-2': '#111d30', 'surface-3': '#18263d', line: '#1a2a42', 'line-2': '#29405f',
            text: '#eef5ff', 'text-2': '#b4c6de', muted: '#8296b2', white: '#e6f1ff', 'on-white': '#07101d',
        },
        wash: 'radial-gradient(ellipse 70% 50% at 50% -10%, hsl(212 80% 60% / .16), transparent 70%), radial-gradient(ellipse 50% 40% at 100% 100%, hsl(200 70% 70% / .07), transparent 70%)',
        fill: 'linear-gradient(180deg, #ffffff, #bcd8ff)',
        css: (art) => [
            `.top::after { height: 14px; bottom: -8px; background: url(${art('art/runes.svg')}) center / 96px 14px repeat-x; opacity: .45; }`,
            `.card, .pcard, .stat { border-top-color: hsl(212 60% 80% / .35); }`,
            `.section-title { color: #b9d4f5; letter-spacing: .18em; }`,
            // its accent is near white: the Fancy scenes and glows in ice blue instead
            `:root { --scene: #7fb8ff; --scene-2: #d6ebff; }`,
            `.brand { letter-spacing: .06em; }`,
            // Cinzel runs wide: keep the top bar on one row
            `.top { gap: 12px; } .top .kpi { padding: 5px 10px; gap: 7px; font-size: calc(12.5px * var(--fs-scale)); } .top .actions button { padding-left: 10px; padding-right: 10px; }`,
        ],
    },
    {
        id: 'dragonlore', name: 'AWP | Dragon Lore',
        font: { file: 'uncial-antiqua.woff2', family: 'ZSB Uncial' },
        body: { file: 'alegreya-body.woff2', family: 'ZSB Alegreya' },
        // a hard font to read in small words: titles only, not the tabs or account names
        heads: '.section-title, .pcard-head, .modal-box h2, main h2',
        vars: {
            bg: '#070a07', surface: '#0d130e', 'surface-2': '#131c14', 'surface-3': '#1a261b', line: '#1d2a1e', 'line-2': '#2f4430',
            text: '#f6efdc', 'text-2': '#cfc4a6', muted: '#998f74', white: '#e8bd5f', 'on-white': '#1a1204',
        },
        wash: 'radial-gradient(ellipse 60% 45% at 90% -8%, hsl(42 75% 55% / .14), transparent 70%), radial-gradient(ellipse 50% 40% at 0% 100%, hsl(150 50% 40% / .12), transparent 70%)',
        fill: 'linear-gradient(135deg, #f2cf7a, #c9902f)',
        css: (art) => [
            `.top::after { height: 12px; bottom: -7px; background: url(${art('art/filigree.svg')}) center / 120px 12px repeat-x; }`,
            `.card, .pcard, .stat { border-color: hsl(42 50% 45% / .22); }`,
            `.section-title { color: #d9b464; }`,
            `:root { --scene-2: #3fae7a; }`,   // the Fancy scenes' second colour: jade
        ],
    },
    {
        id: 'howl', name: 'M4A4 | Howl',
        font: { file: 'black-ops-one.woff2', family: 'ZSB Black Ops' },
        body: { file: 'saira-body.woff2', family: 'ZSB Saira' },
        // the skin: gunmetal grey, bright red swirls, the wolf in orange and yellow flame
        vars: {
            bg: '#121111', surface: '#1a1918', 'surface-2': '#22201f', 'surface-3': '#2c2a28', line: '#2f2c2a', 'line-2': '#48433f',
            text: '#f5f1ee', 'text-2': '#c7bfba', muted: '#968d87', white: '#e2301d', 'on-white': '#ffffff',
        },
        wash: 'radial-gradient(ellipse 60% 45% at 85% -10%, hsl(6 85% 50% / .16), transparent 70%), radial-gradient(ellipse 40% 30% at 0% 100%, hsl(32 100% 55% / .08), transparent 70%)',
        fill: 'linear-gradient(135deg, #ef4423, #c41d10)',
        css: () => [
            `.top { border-bottom-color: rgb(226 48 29 / .5); }`,   // one plain red rule under the top bar
            `.tabs button, .section-title { text-transform: uppercase; letter-spacing: .08em; }`,
            `.section-title { color: #ff8a3d; }`,
            `:root { --scene-2: #ffa62e; }`,   // the Fancy scenes' second colour: flame
        ],
    },
    {
        id: 'asiimov', name: 'AWP | Asiimov',
        font: { file: 'orbitron.woff2', family: 'ZSB Orbitron' },
        body: { file: 'exo-2-body.woff2', family: 'ZSB Exo 2' },
        // the skin: mostly white, with orange panels and black trim; a light panel (like Settings > Look > Light)
        light: true,
        vars: {
            bg: '#eceae7', surface: '#ffffff', 'surface-2': '#f4f3f0', 'surface-3': '#e8e6e2', line: '#dcd9d4', 'line-2': '#c6c2bb',
            text: '#141414', 'text-2': '#43413d', muted: '#67645e', white: '#e2620b', 'on-white': '#111111',
            ok: '#166534', warn: '#92400e', bad: '#b91c1c',
        },
        wash: 'radial-gradient(ellipse 60% 40% at 100% -5%, hsl(25 100% 55% / .14), transparent 70%)',
        fill: 'linear-gradient(135deg, #ff9a3c, #f06a0c)',
        css: (art) => [
            `.top::after { height: 6px; background: url(${art('art/hazard.svg')}) 0 0 / 24px 6px repeat-x; }`,
            `.card, .pcard, .stat { border-left: 3px solid #141414; }`,
            `.brand, .tabs button, .section-title { text-transform: uppercase; letter-spacing: .1em; }`,
            `.section-title { color: #a8470a; }`,
            `:root { --scene-2: #1a1a1a; }`,   // the Fancy scenes' second colour: the black trim
        ],
    },
    {
        id: 'fade', name: 'Karambit | Fade',
        font: { file: 'quicksand-body.woff2', family: 'ZSB Quicksand' },
        body: { file: 'quicksand-body.woff2', family: 'ZSB Quicksand' },
        vars: {
            bg: '#0d0812', surface: '#150e1c', 'surface-2': '#1d1426', 'surface-3': '#271b33', line: '#2a1e36', 'line-2': '#40304f',
            text: '#fbf3fb', 'text-2': '#d6c3d8', muted: '#a08fa6', white: '#ff7cbd', 'on-white': '#1a0712',
        },
        wash: 'radial-gradient(ellipse 50% 40% at 0% 0%, hsl(45 100% 70% / .10), transparent 70%), radial-gradient(ellipse 55% 45% at 100% 0%, hsl(270 90% 65% / .14), transparent 70%)',
        fill: 'linear-gradient(110deg, #ffd36b, #ff5fa8 50%, #8a5cff)',
        css: (art) => [
            `.top::after { height: 2px; background: linear-gradient(90deg, #ffd36b, #ff5fa8, #8a5cff); }`,
            `.card, .pcard, .stat, .tabs { border-radius: 18px; }`,
            `.section-title { color: #ff9ccc; }`,
            `:root { --scene-2: #8a5cff; }`,   // the Fancy scenes' second colour: violet
            `.brand { font-weight: 700; }`,
        ],
    },
    {
        id: 'neonrider', name: 'AK-47 | Neon Rider',
        font: { file: 'audiowide.woff2', family: 'ZSB Audiowide' },
        body: { file: 'oxanium-body.woff2', family: 'ZSB Oxanium' },
        vars: {
            bg: '#0b0219', surface: '#120524', 'surface-2': '#1a0832', 'surface-3': '#230c42', line: '#2a1048', 'line-2': '#40196a',
            text: '#fbefff', 'text-2': '#d2bde6', muted: '#9c86b8', white: '#ff4fd8', 'on-white': '#16021f',
        },
        wash: 'radial-gradient(ellipse 60% 45% at 50% -10%, hsl(185 100% 60% / .10), transparent 70%)',
        fill: 'linear-gradient(135deg, #ff4fd8, #7a3cff)',
        css: (art) => [
            `.top::after { height: 2px; background: linear-gradient(90deg, #3ff0ff, #ff4fd8); }`,
            `.section-title { color: #3ff0ff; }`,
            `:root { --scene-2: #3ff0ff; }`,   // the Fancy scenes' second colour: cyan
            `.c-title .name, .pcard-head { color: #ffe3fa; }`,
        ],
    },
];

// The full CSS for a look.
function lookCss(l, art) { return base(l, art) + '\n' + l.css(art).join('\n'); }

module.exports = { LOOKS, lookCss };
