// Switches for the end-to-end test (test/e2e.js). They only work when running from source
// (`npm start`, `npm run e2e`): an installed, packaged app ignores them and always talks to the real site.
const { app } = require('electron');

const DEV = !app.isPackaged;
const E2E = DEV && process.env.CLICKER_E2E === '1';

module.exports = {
    E2E,
    ORIGIN: (DEV && process.env.CLICKER_ORIGIN) || 'https://case-clicker.com',
    // E2E: keep every window off-screen so a test run doesn't pop windows over your desktop.
    HIDE_WINDOWS: E2E,
    // E2E: the browser panel on a fixed port + password so the test can drive the app.
    PANEL: E2E ? { port: Number(process.env.CLICKER_E2E_PORT), password: process.env.CLICKER_E2E_PASS } : null,
    // E2E: seconds instead of minutes, so a full run takes under two minutes. The UI demo
    // (tools/demo.js) keeps real timings so the panel looks like it will for users.
    FAST: E2E && !process.env.CLICKER_DEMO ? { clickIntervalMs: 2000, reportMs: 3000, vaultFallbackMs: 2500 } : null,
    // Usage stats from source go nowhere unless CLICKER_STATS_URL points at a test copy of the
    // Worker (stats-worker: npm run dev), so dev runs never land in the real numbers.
    STATS_URL: DEV ? process.env.CLICKER_STATS_URL || '' : null,
    // The plugin list: from source the real one, unless CLICKER_CATALOG_URL points elsewhere ('' = none).
    CATALOG_URL: DEV ? process.env.CLICKER_CATALOG_URL ?? null : null,
    STATS_TIMING: E2E && !process.env.CLICKER_DEMO ? { firstMs: 1500, everyMs: 4000 } : null,
};
