# RELEASING.md: Vakyartha

Current local checkpoint (2026-10-27): app code `0d7ab3d` / Projection `6ca8487` is freshly built, installed and relaunched.161 app/383 framework checks, native/type/build and wide/narrow WebKit checks pass; exact provenance and installed smoke are recorded below. Historical manifests/outcomes apply only to their recorded revisions.


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

## The bundled Node engine

The release app ships the Node binary that runs the build (and its npm), so the build machine's Node **is** the shipped engine. `scripts/bundle-sidecar.ts` refuses to package it unless:

- it is signed by the Node.js Foundation (Developer ID team `HX7739G8FX`, `codesign --verify --strict`);
- it is on an LTS line; and
- it is that line's newest release in `https://nodejs.org/dist/index.json`, so security patches cannot be missed.

`VAK_NODE_CHECK=offline` skips only the nodejs.org lookup and prints a warning; never use it for a published release.

To update: download `node-vX.Y.Z-darwin-arm64.tar.gz`, `SHASUMS256.txt` and `SHASUMS256.txt.sig` from `https://nodejs.org/dist/vX.Y.Z/` into an empty folder; check the tarball against `SHASUMS256.txt` (`shasum -a 256 -c`), and the PGP signature when `gpg` and the release keys are available; check `codesign --verify --strict` and the team ID on `bin/node`; then replace `~/.local/bin/node`, `~/.local/lib/node_modules/{npm,corepack}` and `~/.local/include/node`, keeping the previous copy until the new build is verified. A security release is taken as soon as it is verified; the 14-day age rule is for packages and integrations.

Current: Node 24.22.1 (Krypton LTS, security release of 2026-10-20) with npm 11.19.1, adopted 2026-10-26. Tarball SHA-256 matched `SHASUMS256.txt`; signature valid for Node.js Foundation (HX7739G8FX), timestamped 2026-10-21. The PGP signature of `SHASUMS256.txt` was not checked (`gpg` is not installed).

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
   # Quit the app normally after checking it is idle.
   # Move the previous .app to a recoverable backup; replace the whole bundle.
   ditto src-tauri/target/release/bundle/macos/Vakyartha.app /Applications/Vakyartha.app
   # Launch the installed bundle and verify About, data path and behavior.
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


## External discovery source checkpoint — 2026-10-26

The source checkout now uses pushed Projection `801e227`, including unreviewed-tool consent defaults and HTTP protocol/session/redirect corrections. External catalog discovery/import is source-validated, including live public metadata and one isolated hosted documentation lifecycle. [Implementation, verification and limits](EXTERNAL-CATALOGS.md). This checkpoint does not replace the installed app or its recorded artifact provenance; a future installation must regenerate the UI and sidecar and follow the existing clean-build/verification procedure. No release/tag/public download was created for it.


## External catalog layout and identity local install — 2026-10-26

Compiled pushed app `9f192f5` with pushed Projection `da49065` from an exact exported source snapshot, fresh `npm ci`, regenerated UI/sidecar and a previously absent Rust release target. Both app and DMG built successfully (133.20 MiB / 42.85 MiB). Retained at `src-tauri/target/release/bundle/` and `/var/folders/bz/dq3r0_6s4msbsq08r5h4slcr0000gn/T/vakyartha-catalog-ui-9f192f5-swyz2kua/rust-release/release/bundle/`.

Validation: 144 app tests, 327 pinned framework tests/replay, typecheck, native test, catalog WebKit at 1440/1100/620 pixels and wide/narrow canvas checks pass. Live identity fetches returned PNG/SVG assets from all three discovery sources after the upstream dual-stack correction. The installed desktop About shows 0.2.0, Node v24.21.0, macOS Keychain and the existing data folder. Native inspection confirms a shared heading/tab/toolbar/grid axis, publisher/source logos and distinct bottom-aligned review/requirements buttons with real catalog results. No paid/model/microphone run or integration adoption was needed.

Replaced `/Applications/Vakyartha.app` as a whole after quitting; all 1,949 installed files/symlinks match the fresh bundle, including the regenerated sidecar. Prior install retained at `/var/folders/bz/dq3r0_6s4msbsq08r5h4slcr0000gn/T/vakyartha-catalog-ui-9f192f5-swyz2kua/previous-installed-Vakyartha.app`. Existing user data/settings are preserved. Ignored receipt: `.vak/builds/2026-10-26-catalog-ui-install.json`; its source snapshot, test/build logs and installed manifest are retained at `/var/folders/bz/dq3r0_6s4msbsq08r5h4slcr0000gn/T/vakyartha-catalog-ui-9f192f5-swyz2kua`.

Artifact SHA-256:

- Native executable: `35098a26ae576ba519b89b9db3393b011684aba84268a48fcedc34b9fed60d1c`
- Bundled sidecar: `e736ad7ef640c87f81ac82f0ca063cd8ec19ac759e1d7edb7af9f79313daa409`
- Disk image: `435f03705d8469be5a012e1b2c390e460a66fa4635db174215d3d993db227a71`

Version remains 0.2.0, unsigned/unnotarized. No tag or public release created. Subsequent installation-record documentation does not change compiled source.


## Authoring design correction — installed 2026-10-27

Built app code `a6ffcfe4ffca441df3eea90b1ca3fff291e572c7` with pushed Projection `a21cba1cef936be0cfacf71b00e600aee8d84b5f`, from exact git archives in a new source directory and a previously absent Rust target. Fresh `npm ci`, 153 app tests and typecheck pass inside that snapshot; current pinned framework passes 344 tests/replay. Native export, wide/narrow task/canvas and retained-output WebKit checks pass. Release compilation completes from scratch in 2m 11s and produces app + DMG. Node 24.22.1 passes the release signature/current-LTS check. No dependency changes, branch, tag or public release.

The complete bundle replaces the standard build artifact and `/Applications/Vakyartha.app`; all 1,931 regular files/symlinks match the clean bundle. Manifest SHA-256: `7850f5a784156fe05eeda07a363e03fa8a07ff2efd90d0600f178b0f535b8fdc`. Source/target and recoverable prior-install backup paths are in ignored `.vak/builds/2026-10-27-authoring-design-install.json`. User data and credentials are preserved. The installed app was closed, then relaunched explicitly from `/Applications/Vakyartha.app`; native About confirms 0.2.0 / Node 24.22.1 and Schedule navigation works. No installed model call or channel restart test was performed.

The binary contains the completion-boundary correction and caller-default assertions. The frozen local report has correct structure/values/export integrity but fails semantic review for missing budget interpretation and assumed currency; EVALUATION.md/ADR-031 retain this open gate. This installation is not a claim of completed report reliability. Subsequent documentation-only provenance commits do not change executable contents. Concurrent planning/research document edits are preserved outside this build snapshot.


## Transactional authoring — installed 2026-10-27

Exact committed app source `0406e46f44d167a0286928f14aeb191ec0ae31b6`, pushed Projection `0138493679482a49a1d1662a3285e1e4860eba12`. Fresh git archives, fresh `npm ci`, 153 app tests/typecheck inside the snapshot and an initially absent Rust target. Current pin passes 353 framework tests/replay and typecheck/package generation; native export and wide/narrow task/canvas WebKit checks pass. Complete native compilation took 2m07s. Initial DMG packaging failed because its own temporary image remained busy. Verified the image path belonged to this build, ejected it normally, and reran from the same source/new target; regenerated frontend/sidecar, app and DMG all succeeded. No source change or stale artifact reuse.

Installed the complete app and refreshed the standard app/DMG artifacts. All 1,931 files/symlinks match the clean bundle; manifest SHA-256 `b91b4375eb4f87727029b6414ec6624cb6ed185c72f42ec45fed31510f4387d9`. Ignored receipt `.vak/builds/2026-10-27-transactional-install.json` records source/target/backup paths. Idle previous app was closed and `/Applications/Vakyartha.app` relaunched; native About shows 0.2.0 / Node 24.22.1 with existing settings/data. Release packaging verifies the Foundation signature and current LTS patch. No installed model run, paid call, dependency change, new branch, tag or public release.

Both frozen local authoring trials failed and published/exported no invalid candidate. This installation verifies the transactional boundary and rejection behavior, not complete report/comparison reliability. EVALUATION.md/ADR-032 retain that distinction. Later documentation-only provenance commits do not change executable content; concurrent research/planning edits remain outside the source snapshot.

## Source workspace — installed 2026-10-27

Exact committed app source `68fd14acfd552e71ceca8dd38d2bac4777a87ff1`, pushed Projection `ca9f512178d0f17df0f20ebba5bb5faecaca0bf7`. Fresh git archives, `npm ci`,158 app tests/typecheck and an initially absent Rust target;373 pinned framework tests/replay pass. The same snapshot passes wide/narrow task WebKit checks. Release compilation took2m11s. DMG packaging initially failed to detach its own temporary image; verified its build-owned path, ejected normally, then rebuilt frontend/sidecar and packaged successfully from the same fresh source/target. No stale target or source changes.

Replaced `/Applications/Vakyartha.app` and the standard app/DMG artifacts as complete bundles. All 1,931 regular files/symlinks match the fresh bundle; manifest SHA256 `f1e19b432ce1f6e8739880759b42044ed7310ce028a7ffcde18012197f8a62fc`. Receipt `.vak/builds/2026-10-27-source-workspace-install.json` retains exact source/target and recoverable previous-install paths. Relaunched explicitly from `/Applications/Vakyartha.app`; native About verifies 0.2.0 / Node 24.22.1, Keychain/existing data, and Schedule loads. No installed model call, paid run, channel test, public release or tag.

The original selected-file report and changed-budget continuation are independently verified on the source workspace path; broader no-total/source-only and free-form probes remain open (EVALUATION.md). Installation does not close those gates. Subsequent documentation-only provenance commits do not change executable contents. Concurrent planning/research edits remain outside this build snapshot.


## Local skill-led cleanup install — 2026-10-27

Built executable source `0d7ab3d` with pushed Projection `6ca8487` in a newly created target `/tmp/vakyartha-skill-release.0DA05T`. After adding the reviewed skill-update UI, the app package was cleaned/rebuilt and previous intermediate bundles were moved aside; the final hook regenerated frontend, sidecar and bundled runtime resources. Node 24.22.1 passes its Foundation-signature/latest-LTS check. No dependency, signing setting or public release changed.

Replaced `/Applications/Vakyartha.app` as a whole bundle, preserving a recoverable previous-app/skills backup. All 1,931 regular files/links/modes match the final build and standard app artifact. The app and DMG are also at the standard `src-tauri/target/release/bundle/` paths. Local receipt `.vak/builds/2026-10-27-skill-install.json` records exact paths, full manifest, backup and skill changes.

- Manifest SHA-256: `f9d0bb30a8d2d92b56481ad3e7857f352179fbedb9fde202a0f9dc0f9bcf1f9d`.
- Native SHA-256: `2d1b8a9fba1d22b28d8ffc6ee576ccb152f62cb369e1e4d616d4776e34a4376b`.
- Sidecar SHA-256: `e4f4205b9f7a7de32f21cc97072531fcd0a480687a93d52c35546d97cd6b7747`.
- DMG SHA-256: `f903decbbb69558ddfc14bd794efb27f27379f0364557e7387b5fedf694d629b`.

Refreshed 11 built-ins only after exact comparison with their previously shipped defaults, seeded assistant/interactive-ui, preserved the removed commit-message skill and the pinned catalog skill. Installed list is 13 built-ins plus 1 catalog skill, with no pending built-in update. Future changes use the Updates filter, current/proposed preview and explicit update action; stale previews cannot overwrite later edits.

Launched explicitly from `/Applications/Vakyartha.app`. Native About verifies 0.2.0, Node 24.22.1, Keychain and installed data path. The local primary model renders Installation check / Ready in 67.1 seconds, and the same result opens in canvas. Current skill selection is recorded in the receipt. This is a bounded installed smoke, separate from the fresh Luna outcome and wider open reliability gates. No installed paid model call, public release or tag. Subsequent documentation-only commits do not alter this executable snapshot.


## Capability pipeline source checkpoint — 2026-10-27

Pushed Projection `adf0604` is adopted for dispatch validation, explicit tool errors, permission revocation, cancellation/transport bounds and finite retries. App skill-selection/metadata and task result wrappers use the matching contract.163 app tests,393 framework tests/replay, typechecks, framework packages, UI build and wide/narrow canvas WebKit pass. See [pipeline review](PIPELINE-REVIEW.md) for scope and remaining limits. No paid/live model run, installed-app replacement, channel restart, new dependency, tag or public release. Existing local primary-provider and original source/value/interaction/receipt failures remain open; this checkpoint does not change the installed executable snapshot above.
