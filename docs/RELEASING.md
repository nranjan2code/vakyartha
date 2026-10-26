# RELEASING.md: Vakyartha

How Vakyartha is versioned, how it takes framework updates from Projection, and how a release is built, checked, installed and published. Rules for any change: [AGENTS.md](../AGENTS.md).

## Versions

- **SemVer**, `MAJOR.MINOR.PATCH`, `0.x` until the first stable release: in `0.x` a minor bump may change behaviour or data; a patch only fixes.
- **One version, three files:** `package.json`, `src-tauri/Cargo.toml` (shown in Settings → About, passed to the sidecar) and `src-tauri/tauri.conf.json` (the bundle). Set them together with `node scripts/version.ts X.Y.Z`; never by hand.
- **Tags:** `vX.Y.Z`, annotated, on the release commit on `main`.
- **CHANGELOG.md:** every release has a section with its date and the Projection version it was built on.

## The framework dependency

Vakyartha uses [Projection](https://github.com/nranjan2code/Projection) as an external library, pinned as a git submodule at `framework/`. The pin is one exact commit, recorded in this repository's history; npm workspaces link `framework/packages/*` as `@vak/*`. Projection never depends on Vakyartha.

**Why a submodule and not npm (yet):** the `@vak/*` packages are not published. The submodule gives an exact, reviewable pin, and lets the app run the framework's TypeScript sources with no build step. When Projection publishes to npm, switch to exact versions (`"@vak/host": "0.3.0"`, no ranges) and drop the submodule. The rest of this procedure stays the same.

### When to update Projection

- **The app needs a framework feature or fix.** Make the change in Projection first (its own tests, its CHANGELOG), push it, then move the pin here. Never edit files under `framework/` in this repository: a change there is lost on the next update and never reaches Projection.
- **A Projection security fix:** update promptly, as a patch release.
- **Before each app release:** read Projection's CHANGELOG since the current pin. Take what is wanted; leave the pin where it is if nothing is needed. An update is a deliberate decision, not routine.
- **Prefer tags.** Pin to a Projection release tag (`vX.Y.Z`) when there is one; a commit on Projection's `main` is acceptable between tags. Never pin to a commit that is not pushed to Projection's GitHub: a fresh clone could not check it out.

### How to update Projection

```bash
git -C framework fetch --tags origin
git -C framework log --oneline HEAD..origin/main     # what changes (also read Projection's CHANGELOG.md)
git -C framework checkout v0.2.0                     # or a pushed commit sha
npm install                                          # relinks workspaces; keep the lockfile change if any
npm run test:framework && npm test && npm run typecheck && npm run build
git add framework package-lock.json
git commit -m "Update Projection to v0.2.0" -m "<what the app gets from it; any Breaking lines from its CHANGELOG>"
```

If an update breaks the app, fix the app in the same commit, or leave the pin and raise it in Projection. A **Breaking** line in Projection's CHANGELOG lists what to change.

### Trying an unpushed Projection change locally

To test a framework change from your local Projection checkout (`~/Projects/vakProjection`) before pushing it:

```bash
git -C framework remote add local ~/Projects/vakProjection   # once
git -C framework fetch local
git -C framework checkout local/main                         # or a branch
```

Run the app and tests, then push the change to Projection and pin to the pushed commit. Never commit a pin that only exists locally. `git -C framework branch -r --contains HEAD` must list `origin/...` before a release.

## Release checklist

1. **Start clean:** on `main`, `git status` clean, `git submodule status` shows no `+` (the checkout matches the pin), and the pin is pushed to Projection (above).
2. **Decide the framework pin** (above) and note it for the changelog: `git -C framework describe --tags --always`.
3. **Version and changelog:** `node scripts/version.ts X.Y.Z`; add a `## X.Y.Z (YYYY-MM-DD)` section to CHANGELOG.md with what changed, `Built on Projection <tag or sha>`, and anything a user must know (data moves, re-entering keys).
4. **Fresh install and checks** (no paid model calls):
   ```bash
   npm ci
   npm run test:framework && npm test && npm run typecheck
   cargo test --manifest-path src-tauri/Cargo.toml --lib
   npm run build && node scripts/canvas-check.ts      # WebKit smoke, wide and narrow
   ```
5. **Build:** `npm run desktop:build`. It bundles the sidecar (framework included), the Node binary and npm. Output: `src-tauri/target/release/bundle/macos/Vakyartha.app` and `bundle/dmg/Vakyartha_X.Y.Z_<arch>.dmg`.
6. **Install locally and smoke-test the installed app:**
   ```bash
   osascript -e 'quit app "Vakyartha"' 2>/dev/null       # a running copy cannot be replaced (a dmg drag fails silently)
   rm -rf /Applications/Vakyartha.app                    # ditto merges into an existing bundle; replace it whole
   ditto src-tauri/target/release/bundle/macos/Vakyartha.app /Applications/Vakyartha.app
   open /Applications/Vakyartha.app
   ```
   Check Settings → About shows `X.Y.Z` and the data folder; send one chat on local Ollama and see an interface; open it in the canvas; check `logs/engine.log` has no errors.
7. **Commit, tag, push** (after the secret scan in AGENTS.md):
   ```bash
   git commit -am "Release X.Y.Z"
   git tag -a vX.Y.Z -m "Vakyartha X.Y.Z (Projection <tag or sha>)"
   git push origin main --follow-tags
   ```
8. **GitHub release (ask first: it publishes a download):**
   ```bash
   gh release create vX.Y.Z src-tauri/target/release/bundle/dmg/Vakyartha_X.Y.Z_*.dmg --title "Vakyartha X.Y.Z" --notes "<the CHANGELOG section>"
   ```
   Until builds are signed and notarized, mark the notes "unsigned: build from source or allow it in System Settings → Privacy & Security".

## Not yet in place

- **Signing and notarization** (Apple Developer ID), then **auto-update** (Tauri updater with signed update manifests). Ask before starting either.
- **CI**: a GitHub Actions run of steps 4–5 on each tag, with `submodules: recursive` checkout.
- **Windows/Linux builds:** unverified.


## Latest release — 0.2.0 (2026-10-26)

Release commit `4ffabb3`, tag `v0.2.0`, built on Projection `2918883`. Checks before the build: fresh `npm ci`, 299 framework and 117 app tests, Rust tests, typecheck, UI build and the WebKit canvas check. `npm run desktop:build` gave `Vakyartha_0.2.0_aarch64.dmg` (42.77 MiB); installed as a complete replacement of `/Applications/Vakyartha.app`, which reports 0.2.0 and started its engine with no log errors. Published as the [v0.2.0 GitHub release](https://github.com/nranjan2code/vakyartha/releases/tag/v0.2.0) with the dmg and the CHANGELOG section, marked unsigned. Unsigned and not notarized; voice approvals, choices and forms are not yet confirmed with a live microphone (MVP-CHECKLIST V3–V6).

## Media plugin local build — 2026-10-26

The media changes are a local development installation on version 0.2.0, not a new published release. Projection is pinned to pushed commit `2f8dcf6`. A clean build uses a previously absent `CARGO_TARGET_DIR`, regenerates frontend assets and the bundled sidecar, and replaces the installed app as a whole. The source commit, artifact hashes and installed verification are recorded below. Provider runs remain mocked; no paid generation or live microphone check is implied.

Built from application commit `2556f53` and Projection `2f8dcf6`, after `npm ci`, 132 app tests, 323 pinned framework tests/replay, typecheck, the native test and the WebKit canvas/media checks. `CARGO_TARGET_DIR=/tmp/vakyartha-media-build-2556f53 npm run desktop:build` succeeded from an absent target directory. The regenerated bundles are also retained at `src-tauri/target/release/bundle/`: app 133.11 MiB and disk image 42.79 MiB.

The previous app was preserved at `/tmp/Vakyartha-before-media-2556f53.app`; `/Applications/Vakyartha.app` was replaced whole. All 1,949 regular files/symlinks match the fresh bundle. The launched app shows 0.2.0, Node v24.21.0, macOS Keychain and the existing data folder. Images/Audio/Video appear independently, off by default; image provider/model selection and all five audio-operation selectors were inspected without saving configuration or generating paid media.

Artifact SHA-256:

- Native executable: `89b33c0df37c83859ecdd08d4e2aa4f93a13a1e65fda7cfc4870f30561128e33`
- Bundled sidecar: `27a28b5a615ad99d0c3ebf8873664cf2f34da50e3a6c68fa4c7997f02a09edf8`
- Disk image: `2f0bffbb1e7f780dd44fcca72561aa18fc563e537b43bf4bae6ea3d1dc6740b5`

The local verification receipt is `.vak/media-checks/2026-10-26-install.json` (ignored). A later documentation-only checkpoint records this install; the compiled code remains `2556f53`. No new tag or GitHub release was published.

Installed-app smoke (2026-10-26): `qwen3.5:4b-mlx` rendered the requested “Local installation check / Ready” card in 33.4 seconds; Open in canvas moved the same surface successfully. The installed catalog and About were inspected. No paid generation was run.

## Task outcome and accessibility local build — 2026-10-26

Compiled app `d29ffbd` with pushed Projection `c147332` from an exact exported source snapshot and an absent Rust target (`/tmp/vakyartha-outcome-rust-final-d29ffbd`), with fresh `npm ci` and regenerated frontend/sidecar. This includes completed Databricks support and the task focus/hidden-field fixes. The concurrent external-catalog work was unfinished at the snapshot and is outside this build. Source validation: 134 app tests, 324 pinned framework tests, typecheck, the native test, wide/narrow task/canvas and retained-output WebKit checks. The exact final snapshot repeats app/typecheck and the 26-step task check at both widths. Both app and DMG succeeded (133.11 MiB / 42.79 MiB), retained in `src-tauri/target/release/bundle/` and the clean target.

After explicit user approval to replace/relaunch the concurrently used app, the prior bundle was preserved and `/Applications/Vakyartha.app` replaced whole. All 1,949 installed files/symlinks match the fresh bundle; bundled sidecar matches the snapshot's regenerated sidecar. Native accessibility inspection confirms optional hidden fields are absent, Tab moves instructions → completion criteria, and Back/Escape returns focus to Schedule. No installed model/provider run was made. The current window is open on the conversation. Version remains 0.2.0, unsigned/unnotarized; no new tag or public release.

Artifact SHA-256:

- Native executable: `a89f27ceb4918432612f5d2f851767efc5094b9422b1ec0883902c9d91399ce1`
- Bundled sidecar: `766fb33a4b3a752ca31879c7d099e53a86a42190cd6d13b2a5003a0b030af15b`
- Disk image: `d2c9c54d26b0b3c540f7f2dacdaf3f6c0435283d998ee057ecfc21e077f5c5e8`

Ignored local receipt: `.vak/builds/2026-10-26-outcome-final-install.json`, including the clean snapshot and previous-install backup paths. Later documentation commits do not change compiled source. File-report reliability still fails the retained trials; live microphone checks remain deferred, as documented in EVALUATION.md and VOICE-CHECK.md.
