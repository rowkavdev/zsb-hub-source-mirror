import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { extractFile, listPackage, statFile } from '@electron/asar';

const upstream = 'GothGirlZSB/zsb-hub-releases';
const maxArchive = 256 * 1024 * 1024;
const maxAsar = 32 * 1024 * 1024;
const platforms = [
  { name: 'linux', label: '', dir: 'upstream', meta: 'upstream-release.json', tag: 'upstream' },
  { name: 'windows', label: ' Windows', dir: 'platforms/windows', meta: 'platforms/windows-release.json', tag: 'windows' },
  { name: 'macos', label: ' macOS', dir: 'platforms/macos', meta: 'platforms/macos-release.json', tag: 'macos-upstream' },
];

const git = (...args) => execFileSync('git', args, { stdio: 'inherit' });

function selectAsset({ tag_name: tag, assets }, platform) {
  if (platform === 'linux') return assets.find(asset => asset.name === 'ZSB-Hub-linux-x64.tar.gz');
  if (platform === 'windows') return assets.find(asset => asset.name === 'ZSB-Hub-Setup-' + tag.slice(1) + '.exe');
  const mac = assets.filter(asset => /\.dmg$/i.test(asset.name)
    || /(?:^|[-_.])(mac(?:os)?|darwin)(?:[-_.]|$).*\.(zip|tar\.gz|tgz)$/i.test(asset.name)
    || /(?:^|[-_.])(mac(?:os)?|darwin)\.(zip|tar\.gz|tgz)$/i.test(asset.name));
  return mac.find(asset => /\.zip$/i.test(asset.name))
    || mac.find(asset => /\.(tar\.gz|tgz)$/i.test(asset.name))
    || mac[0];
}

function stableReleases() {
  const raw = execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${upstream}/releases?per_page=100`]);
  return JSON.parse(raw).flat()
    .filter(release => !release.draft && !release.prerelease && /^v\d+\.\d+\.\d+$/.test(release.tag_name))
    .sort((a, b) => a.published_at.localeCompare(b.published_at) || a.id - b.id);
}

function importsFor(releases, platform, firstTag) {
  const previous = existsSync(platform.meta) ? JSON.parse(readFileSync(platform.meta, 'utf8')) : null;
  const assets = releases.map(release => ({ release, asset: selectAsset(release, platform.name) })).filter(item => item.asset);
  if (!previous) {
    if (platform.name === 'linux') return assets.slice(-1);
    const first = releases.find(release => release.tag_name === firstTag);
    return first ? assets.filter(({ release }) => release.published_at >= first.published_at) : assets.slice(-1);
  }
  return assets.filter(({ release }) => release.published_at > previous.publishedAt
    || (release.published_at === previous.publishedAt && release.id > previous.releaseId));
}

async function download({ release, asset }, scratch) {
  if (!/^[A-Za-z0-9._ -]+$/.test(asset.name) || asset.name === '.' || asset.name === '..'
    || !/^sha256:[a-f0-9]{64}$/.test(asset.digest) || !Number.isSafeInteger(asset.size)
    || asset.size < 1 || asset.size > maxArchive) throw Error('Invalid archive metadata for ' + release.tag_name + '.');

  execFileSync('gh', ['release', 'download', release.tag_name, '--repo', upstream, '--pattern', asset.name, '--dir', scratch],
    { stdio: 'inherit' });
  const archive = join(scratch, asset.name);
  if (statSync(archive).size !== asset.size) throw Error('Archive size mismatch for ' + release.tag_name + '.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if ('sha256:' + hash.digest('hex') !== asset.digest) throw Error('Archive digest mismatch for ' + release.tag_name + '.');
  return archive;
}

function sevenZipPaths(archive) {
  const output = execFileSync('7z', ['l', '-slt', '--', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return output.split(/\r?\n/).flatMap(line => line.startsWith('Path = ') ? [line.slice(7)] : []);
}

function extractMember(archive, member, limit) {
  if (member.startsWith('/') || member.split(/[\\/]/).includes('..') || /[\r\n*?]/.test(member)) {
    throw Error('Unsafe archive member.');
  }
  return execFileSync('7z', ['x', '-so', '-spd', '--', archive, member], { maxBuffer: limit });
}

function onePath(paths, pattern) {
  const matching = paths.filter(entry => pattern.test(entry.replaceAll('\\', '/')));
  if (matching.length !== 1) throw Error('Expected exactly one matching application member.');
  return matching[0];
}

function extractWindows(archive, scratch) {
  const payload = onePath(sevenZipPaths(archive), /^\$PLUGINSDIR\/app-(?:64|x64)\.7z$/);
  const nested = join(scratch, 'windows-app.7z');
  writeFileSync(nested, extractMember(archive, payload, maxArchive));
  const asar = onePath(sevenZipPaths(nested), /^resources\/app\.asar$/i);
  return extractMember(nested, asar, maxAsar);
}

function extractMac(archive, scratch) {
  const asarPattern = /(?:^|\/)[^/]+\.app\/Contents\/Resources\/app\.asar$/;
  if (/\.(tar\.gz|tgz)$/i.test(archive)) {
    const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const member = onePath(entries.split('\n'), asarPattern);
    if (member.startsWith('/') || member.split('/').includes('..')) throw Error('Unsafe macOS archive member.');
    return execFileSync('tar', ['-xOzf', archive, '--', member], { maxBuffer: maxAsar });
  }
  const paths = sevenZipPaths(archive);
  if (paths.some(path => asarPattern.test(path.replaceAll('\\', '/')))) {
    return extractMember(archive, onePath(paths, asarPattern), maxAsar);
  }
  if (/\.dmg$/i.test(archive)) {
    const volume = onePath(paths, /\.(hfs|hfsx|apfs)$/i);
    const nested = join(scratch, 'macos-volume.img');
    writeFileSync(nested, extractMember(archive, volume, 2 * maxArchive));
    return extractMember(nested, onePath(sevenZipPaths(nested), asarPattern), maxAsar);
  }
  throw Error('macOS app.asar member unavailable.');
}

async function extractRelease(candidate, platform, scratch) {
  const { release, asset } = candidate;
  const tag = release.tag_name;
  const archive = await download(candidate, scratch);
  const archiveBytes = platform.name === 'windows' ? extractWindows(archive, scratch)
    : platform.name === 'macos' ? extractMac(archive, scratch)
      : execFileSync('tar', ['-xOzf', archive, '--', 'ZSB-Hub-linux-x64/resources/app.asar'], { maxBuffer: maxAsar });
  const asar = join(scratch, 'app.asar');
  writeFileSync(asar, archiveBytes);
  const snapshot = join(scratch, 'app');
  mkdirSync(snapshot);
  let fileCount = 0;
  for (const entry of listPackage(asar)) {
    const name = entry.slice(1);
    const segments = name.split('/');
    if (segments.includes('node_modules')) continue;
    if (!entry.startsWith('/') || name.includes('\\') || name.includes(':')
      || segments.some(part => !part || part === '.' || part === '..' || part.toLowerCase().startsWith('.git'))) {
      throw Error('Unsafe archive path in ' + tag + ': ' + JSON.stringify(entry));
    }
    const info = statFile(asar, name, false);
    if ('files' in info || 'link' in info || info.unpacked) continue;
    const file = join(snapshot, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, extractFile(asar, name, false), { flag: 'wx' });
    fileCount++;
  }

  const manifest = JSON.parse(readFileSync(join(snapshot, 'package.json'), 'utf8'));
  if (tag !== 'v' + manifest.version || !existsSync(join(snapshot, manifest.main || 'main.js'))) {
    throw Error('Application manifest does not match release ' + tag + '.');
  }
  return {
    repository: upstream, tag, releaseId: release.id, publishedAt: release.published_at, releaseUrl: release.html_url,
    asset: { id: asset.id, name: asset.name, size: asset.size, digest: asset.digest }, fileCount,
  };
}

const releases = stableReleases();
const firstTag = execFileSync('git', ['tag', '--list', 'upstream-v*', '--sort=version:refname'], { encoding: 'utf8' })
  .trim().split('\n')[0]?.replace(/^upstream-/, '');
for (const platform of platforms) {
  const candidates = importsFor(releases, platform, firstTag);
  if (!candidates.length) console.log('No new ' + platform.name + ' source snapshots.');
  for (const candidate of candidates) {
    const scratch = mkdtempSync(join(process.cwd(), '.mirror-'));
    try {
      const metadata = await extractRelease(candidate, platform, scratch);
      mkdirSync(dirname(platform.dir), { recursive: true });
      rmSync(platform.dir, { recursive: true, force: true });
      renameSync(join(scratch, 'app'), platform.dir);
      writeFileSync(platform.meta, JSON.stringify(metadata, null, 2) + '\n');
      git('add', '-A', '--', platform.dir, platform.meta);
      git('commit', '-m', 'Mirror ZSB Hub' + platform.label + ' ' + metadata.tag);
      git('tag', '-a', platform.tag + '-' + metadata.tag, '-m', metadata.releaseUrl);
      console.log('Mirrored ' + platform.name + ' ' + metadata.tag + ' with ' + metadata.fileCount + ' files.');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
