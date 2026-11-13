import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { extractFile, listPackage, statFile } from '@electron/asar';

const upstream = 'GothGirlZSB/zsb-hub-releases';
const assetName = 'ZSB-Hub-linux-x64.tar.gz';
const archiveMember = 'ZSB-Hub-linux-x64/resources/app.asar';
const metadataPath = 'upstream-release.json';
const maxArchiveBytes = 256 * 1024 * 1024;
const maxAsarBytes = 32 * 1024 * 1024;
const git = (...args) => execFileSync('git', args, { stdio: 'inherit' });

function releasesAfter(previous) {
  const raw = execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${upstream}/releases?per_page=100`]);
  const releases = JSON.parse(raw).flat()
    .filter(release => !release.draft && !release.prerelease && /^v\d+\.\d+\.\d+$/.test(release.tag_name))
    .map(release => ({ release, asset: release.assets.find(asset => asset.name === assetName) }))
    .filter(({ asset }) => asset)
    .sort((a, b) => a.release.published_at.localeCompare(b.release.published_at) || a.release.id - b.release.id);

  if (releases.length === 0) throw Error('No stable ZSB Hub Linux releases found.');
  if (!previous) return releases.slice(-1);
  return releases.filter(({ release }) =>
    release.published_at > previous.publishedAt ||
    (release.published_at === previous.publishedAt && release.id > previous.releaseId));
}

async function extractRelease({ release, asset }, scratch) {
  const { tag_name: tag, published_at: publishedAt } = release;
  if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest) ||
      !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > maxArchiveBytes) {
    throw Error(`Invalid archive metadata for ${tag}.`);
  }

  execFileSync('gh', ['release', 'download', tag, '--repo', upstream, '--pattern', assetName, '--dir', scratch],
    { stdio: 'inherit' });
  const archive = join(scratch, assetName);
  if (statSync(archive).size !== asset.size) throw Error(`Archive size mismatch for ${tag}.`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (`sha256:${hash.digest('hex')}` !== asset.digest) throw Error(`Archive digest mismatch for ${tag}.`);

  const asar = join(scratch, 'app.asar');
  const archiveBytes = execFileSync('tar', ['-xOzf', archive, '--', archiveMember], { maxBuffer: maxAsarBytes });
  writeFileSync(asar, archiveBytes);
  const snapshot = join(scratch, 'upstream');
  mkdirSync(snapshot);
  let fileCount = 0;
  for (const entry of listPackage(asar)) {
    const name = entry.slice(1);
    const segments = name.split('/');
    if (segments.some(part => part === 'node_modules')) continue;
    if (!entry.startsWith('/') || name.includes('\\') ||
        segments.some(part => !part || part === '.' || part === '..' || part.toLowerCase().startsWith('.git'))) {
      throw Error(`Unsafe archive path in ${tag}: ${JSON.stringify(entry)}`);
    }
    const info = statFile(asar, name, false);
    if ('files' in info || 'link' in info || info.unpacked) continue;

    const file = join(snapshot, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, extractFile(asar, name, false), { flag: 'wx' });
    fileCount++;
  }

  const manifest = JSON.parse(readFileSync(join(snapshot, 'package.json'), 'utf8'));
  if (tag !== `v${manifest.version}` || !existsSync(join(snapshot, manifest.main || 'main.js'))) {
    throw Error(`Application manifest does not match release ${tag}.`);
  }

  return {
    repository: upstream,
    tag,
    releaseId: release.id,
    publishedAt,
    releaseUrl: release.html_url,
    asset: { id: asset.id, name: assetName, size: asset.size, digest: asset.digest },
    fileCount,
  };
}

const previous = existsSync(metadataPath) ? JSON.parse(readFileSync(metadataPath, 'utf8')) : null;
const releases = releasesAfter(previous);
if (releases.length === 0) console.log(`Already up to date at ${previous.tag}.`);
for (const candidate of releases) {
  // Keep the staging directory on the checkout filesystem for the final rename.
  const scratch = mkdtempSync(join(process.cwd(), '.mirror-'));
  try {
    const metadata = await extractRelease(candidate, scratch);
    rmSync('upstream', { recursive: true, force: true });
    renameSync(join(scratch, 'upstream'), 'upstream');
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
    git('add', '-A', '--', 'upstream', metadataPath);
    git('commit', '-m', `Mirror ZSB Hub ${metadata.tag}`);
    git('tag', '-a', `upstream-${metadata.tag}`, '-m', metadata.releaseUrl);
    console.log(`Mirrored ${metadata.tag} with ${metadata.fileCount} files.`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
