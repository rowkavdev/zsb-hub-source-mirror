import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [zip, tag] = process.argv.slice(2);
assert(zip && /^v\d+\.\d+\.\d+$/.test(tag));
const scratch = mkdtempSync(join(tmpdir(), 'zsb-macos-smoke-'));
const profile = join(scratch, 'fixture-profile');
const app = join(scratch, 'ZSB Hub Community.app');
let child;
let output = '';
try {
  execFileSync('ditto', ['-x', '-k', resolve(zip), scratch]);
  execFileSync('codesign', ['--verify', '--deep', '--strict', app]);
  const executable = join(app, 'Contents', 'MacOS', 'ZSB Hub Community');
  assert.equal(execFileSync('lipo', ['-archs', executable], { encoding: 'utf8' }).trim(),
    process.arch === 'arm64' ? 'arm64' : 'x86_64');

  const temporary = createServer();
  await new Promise((resolve, reject) => temporary.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = temporary.address().port;
  await new Promise(resolve => temporary.close(resolve));
  const password = 'mirror-fixture';
  mkdirSync(profile);
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({
    tourDone: true, lastVersion: tag.slice(1), startMinimized: false, resumeOnLaunch: false, shareStats: false,
    panelWeb: { enabled: true, port, password }, allowUnverifiedPlugins: false,
  }));
  child = spawn(executable, ['--user-data-dir=' + profile, '--disable-gpu']);
  const exited = new Promise(resolve => child.on('close', resolve));
  child.on('error', error => { output += error.message; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-5000); });
  const url = 'http://127.0.0.1:' + port;
  const auth = { Authorization: 'Basic ' + Buffer.from('mirror:' + password).toString('base64') };
  let state;
  for (let attempt = 0; attempt < 60 && child.exitCode === null; attempt++) {
    try {
      const reply = await fetch(url + '/rpc', {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'state', args: [] }), signal: AbortSignal.timeout(750),
      });
      if (reply.ok) { state = await reply.json(); break; }
    } catch {}
    await delay(500);
  }
  assert.equal(state?.platform, 'darwin', 'The packaged Hub did not start its panel. ' + output);
  assert.equal(state.stage, 'community-macos');
  assert.equal(state.accounts.length, 0);
  assert(state.plugins.some(plugin => plugin.id === 'proxies'));
  const panel = await fetch(url, { headers: auth, signal: AbortSignal.timeout(3000) });
  assert(panel.ok && (await panel.text()).includes('ZSB'));
  await fetch(url + '/rpc', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'quit', args: [] }), signal: AbortSignal.timeout(3000),
  }).catch(() => {});
  await Promise.race([exited, delay(5000)]);
  console.log('Verified native architecture, signature and Hub startup with an isolated profile on ' + process.arch + '.');
} finally {
  if (child && child.exitCode === null) child.kill('SIGTERM');
  rmSync(scratch, { recursive: true, force: true });
}
