/*
 * Skin themes: the whole panel styled after a CS2 skin — its colours, fonts and small details — with no picture of
 * the skin. Pick a look in Settings > Theme (looks.js). Shown when picked there.
 */
const { LOOKS, lookCss } = require('./looks');

let ctx = null, shown = '';

function show() {
    if (!ctx) return;
    const l = LOOKS.find(x => x.id === ctx.settings.get('look')) || LOOKS[0];
    const res = ctx.panel.theme({ vars: l.vars, css: lookCss(l, (file) => ctx.panel.asset(file)) });
    if (!res.ok) { ctx.log(`theme not used: ${res.error}`, 'warn'); return; }
    if (shown !== l.id) ctx.log(`theme: ${l.name}`);
    shown = l.id;
}

module.exports = {
    start(c) {
        ctx = c;
        show();
        ctx.settings.onChange(show);
    },
    stop() { ctx = null; shown = ''; },
};
