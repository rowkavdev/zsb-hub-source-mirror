# ZSB Hub Source Mirror

Versioned snapshots of the application files shipped with stable ZSB Hub releases. Browse the desktop code, inspect bundled plugins, or compare how the Hub changes between versions.

[Publisher downloads](https://github.com/GothGirlZSB/zsb-hub-releases/releases/latest) · [Version tags](https://github.com/rowkavdev/zsb-hub-source-mirror/tags) · [Sync history](https://github.com/rowkavdev/zsb-hub-source-mirror/actions/workflows/sync.yml)

| Platform | Source snapshot | Release metadata |
| --- | --- | --- |
| Linux x64 | [`upstream/`](upstream/) | [Linux release](upstream-release.json) |
| Windows x64 | [`platforms/windows/`](platforms/windows/) | [Windows release](platforms/windows-release.json) |
| macOS | Official snapshots appear in `platforms/macos/` when the publisher supplies a Mac package. | [Community downloads](https://github.com/rowkavdev/zsb-hub-source-mirror/releases) |

On Linux, [`upstream/main.js`](upstream/main.js) is the Electron entry point. The [farming engine](upstream/src/core/), [plugin framework](upstream/src/plugins/), [bundled plugins](upstream/plugins/), and [desktop panel](upstream/panel/) are in their original application layout. Windows snapshots preserve the same layout.

## macOS community builds

When a stable release has a Linux snapshot and lacks a publisher Mac package, a separate workflow builds **ZSB Hub Community** for Apple Silicon and Intel. Download the ZIP for your Mac, extract it, and move the app to Applications. These builds are ad hoc signed and distributed without Apple notarization. macOS may require you to approve the first launch in **System Settings → Privacy & Security**.

The app uses its own macOS profile, adds Dock reopening and support for the Mac WireGuard helper, and updates through new downloads from this mirror. GitHub Actions checks the signature and starts the app with a temporary profile on each architecture before publishing both ZIPs.

[Download macOS builds and checksums](https://github.com/rowkavdev/zsb-hub-source-mirror/releases) · [Build workflow](https://github.com/rowkavdev/zsb-hub-source-mirror/actions/workflows/macos.yml) · [Apple’s app launch instructions](https://support.apple.com/en-us/102445)

To build the current snapshot on a Mac with Node.js 24, run `npm ci --ignore-scripts`, fetch the tags, then run `node packaging/macos/build.mjs v1.2.9`. The build targets the architecture of the Mac running it.

## Compare versions

Tags use `upstream-vX.Y.Z` for Linux, `windows-vX.Y.Z` for Windows, and `macos-upstream-vX.Y.Z` for publisher Mac snapshots. Community Mac downloads use separate `macos-vX.Y.Z` release tags.

```sh
git fetch --tags
git diff upstream-v1.2.8 upstream-v1.2.9 -- upstream/
```

[Compare Linux 1.2.8 and 1.2.9 on GitHub](https://github.com/rowkavdev/zsb-hub-source-mirror/compare/upstream-v1.2.8...upstream-v1.2.9)

## How the mirror updates

GitHub Actions checks hourly at **23 minutes past the hour (UTC)**. Run **Sync ZSB Hub release source** from Actions to check immediately. The mirror records stable releases in publication order per platform, with a separate Git tag for each snapshot.

The sync verifies the publisher archive's SHA-256 and extracts application files from the Electron archive without running the app or installer. Installer binaries and vendored dependencies are excluded from the source snapshots. Community Mac packaging uses a separate workflow and stages its Mac changes outside the mirrored source trees.

This independent mirror archives the shipped application for reference. Ownership of the upstream files remains with their original authors. [Upstream releases](https://github.com/GothGirlZSB/zsb-hub-releases/releases)
