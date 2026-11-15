# ZSB Hub Source Mirror

Versioned snapshots of the application files shipped in the stable ZSB Hub Linux releases. Browse the desktop code, inspect bundled plugins, or compare how the Hub changes between releases.

[Browse the source](upstream/) · [Current snapshot metadata](upstream-release.json) · [Release tags](https://github.com/rowkavdev/zsb-hub-source-mirror/tags) · [Sync history](https://github.com/rowkavdev/zsb-hub-source-mirror/actions/workflows/sync.yml)

## Find your way around

| Path | Contents |
| --- | --- |
| [`upstream/main.js`](upstream/main.js) | Electron entry point |
| [`upstream/src/core/`](upstream/src/core/) | Farming engine, account storage, and core services |
| [`upstream/src/plugins/`](upstream/src/plugins/) | Plugin host, ZIP importer, and catalog integration |
| [`upstream/plugins/`](upstream/plugins/) | Plugins bundled with the release |
| [`upstream/panel/`](upstream/panel/) | Desktop panel HTML, JavaScript, and CSS |
| [`upstream-release.json`](upstream-release.json) | Mirrored version, archive digest, and upstream release link |

## Compare releases

Each imported release is tagged `upstream-vX.Y.Z`. To compare the application files from 1.2.8 and 1.2.9 locally, fetch the tags and diff the snapshots.

```sh
git fetch --tags
git diff upstream-v1.2.8 upstream-v1.2.9 -- upstream/
```

[Compare 1.2.8 and 1.2.9 on GitHub](https://github.com/rowkavdev/zsb-hub-source-mirror/compare/upstream-v1.2.8...upstream-v1.2.9)

## How the mirror updates

GitHub Actions checks hourly at **23 minutes past the hour (UTC)**. To check now, open **Actions → Sync ZSB Hub release source → Run workflow**. The workflow imports new stable releases with a Linux x64 archive in publication order. A check with no eligible release creates no snapshot commit.

Each import verifies the archive's published SHA-256, extracts regular application files from the packaged Electron app, and records the source in the metadata. Installer binaries and vendored dependencies are excluded. The sync inspects the files without running the application.

This independent mirror archives the shipped application for reference. Ownership of the upstream files remains with their original authors. [Upstream releases](https://github.com/GothGirlZSB/zsb-hub-releases/releases)
