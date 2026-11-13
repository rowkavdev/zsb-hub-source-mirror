# ZSB Hub source mirror

Private reference snapshots of the application files shipped in the public [ZSB Hub Linux releases](https://github.com/GothGirlZSB/zsb-hub-releases/releases). The original files are under `upstream/` and the release and archive digest are recorded in `upstream-release.json`. Each imported release gets an `upstream-vX.Y.Z` Git tag for comparison.

The mirror starts at the latest stable release. GitHub Actions checks every six hours for newer stable releases with a Linux x64 archive and imports them in publication order. Use **Actions → Sync ZSB Hub release source → Run workflow** to check immediately. An unchanged run leaves Git history untouched.

The workflow checks the archive against the SHA-256 digest published by GitHub. It extracts regular application files from the Electron archive and leaves installer binaries and vendored dependencies out of Git. It never runs the installer, application, or bundled plugin code. This snapshot may differ from the original development tree and is intended for private inspection. The original authors retain ownership of their files.
