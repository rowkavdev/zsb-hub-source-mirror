import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { packager } from '@electron/packager';

const product = 'ZSB Hub Community';
const electronVersion = '41.1.1';
const wireproxy = {
  x64: ['wireproxy_darwin_amd64.tar.gz', '5d89742a0f381d9508d3ad828a0d300dceee24fa49015427eaff42a23f7a50bd'],
  arm64: ['wireproxy_darwin_arm64.tar.gz', '28d34342c48c309b628d9c06ab4efc05b82fba49821f360605c02139c02547a5'],
};

function replaceIn(file, anchor, replacement) {
  const source = readFileSync(file, 'utf8');
  if (source.split(anchor).length !== 2) throw Error('Could not adapt the macOS build at ' + file + '.');
  writeFileSync(file, source.replace(anchor, replacement));
}

function makeIcon(scratch) {
  const iconset = join(scratch, 'hub.iconset');
  mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = String(size * scale);
      const name = 'icon_' + size + 'x' + size + (scale === 2 ? '@2x' : '') + '.png';
      execFileSync('sips', ['-z', pixels, pixels, 'packaging/macos/icon.png', '--out', join(iconset, name)]);
    }
  }
  const icon = join(scratch, 'hub.icns');
  execFileSync('iconutil', ['-c', 'icns', '-o', icon, iconset]);
  return icon;
}

const [tag, out = 'dist'] = process.argv.slice(2);
if (!/^v\d+\.\d+\.\d+$/.test(tag || '') || process.platform !== 'darwin' || !wireproxy[process.arch]) {
  throw Error('Run on macOS as: node packaging/macos/build.mjs vX.Y.Z [output]');
}
const output = resolve(out);
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'zsb-macos-build-'));
try {
  const tree = join(scratch, 'snapshot.tar');
  execFileSync('git', ['archive', '--output=' + tree, 'refs/tags/upstream-' + tag, 'upstream/']);
  execFileSync('tar', ['-xf', tree, '-C', scratch]);
  const appSource = join(scratch, 'upstream');
  const manifestPath = join(appSource, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (tag !== 'v' + manifest.version) throw Error('Snapshot version does not match ' + tag + '.');
  const { dependencies, ...metadata } = manifest;
  // The shipped app imports electron-updater only in its Windows branch.
  if (Object.keys(dependencies || {}).some(name => name !== 'electron-updater')) {
    throw Error('Review new runtime dependencies before packaging this snapshot.');
  }
  writeFileSync(manifestPath, JSON.stringify({ ...metadata, productName: product, releaseStage: 'community-macos', statsUrl: '' }, null, 2) + '\n');

  replaceIn(join(appSource, 'main.js'), "app.on('window-all-closed', () => {});",
    "app.on('activate', () => { if (core) showPanel(); });\napp.on('window-all-closed', () => {});");
  const [asset, sha256] = wireproxy[process.arch];
  replaceIn(join(appSource, 'plugins/proxies/wireguard.js'), '    assets: {',
    '    assets: {\n' + `        'darwin-${process.arch}': { file: '${asset}', sha256: '${sha256}' },`);

  const [folder] = await packager({
    dir: appSource, out: scratch, name: product, executableName: product,
    appBundleId: 'com.rowkavdev.zsb-hub-community', appVersion: manifest.version,
    arch: process.arch, platform: 'darwin', electronVersion, prune: false, asar: true,
    icon: makeIcon(scratch),
  });
  const app = join(folder, product + '.app');
  const resources = join(app, 'Contents', 'Resources');
  for (const license of ['LICENSE', 'LICENSE.electron.txt', 'LICENSES.chromium.html']) {
    const from = join(folder, license);
    if (existsSync(from)) cpSync(from, join(resources, license));
  }
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  const zip = join(output, `ZSB-Hub-Community-${manifest.version}-macos-${process.arch}.zip`);
  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip], { stdio: 'inherit' });
  console.log(zip);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
