# Continue from this checkpoint

Updated 2026-10-31. Areas 1 through 8 of the native agent runtime implementation have been completed, verified across platforms, and fully merged into `main`. The secondary branch and worktree have been retired.

## Location and source ownership

- **Use** `/Users/nisheethranjan/Projects/vakyartha`, branch `main`. All agent runtime implementation and product features are integrated in this single repository.
- Framework pin **`196b7967c381023c02156e63c806dc86ba746ede`** in `framework/` points directly to `main` in `~/Projects/vakProjection`. Never edit `framework/`; changes belong in `~/Projects/vakProjection`.
- Reviewed helper: `~/Projects/sandbox`, clean pin **`19c493dc7f619ec772c99a5f6f397a4a71888f61`**.
- Node **26.13.0** is available at `/tmp/vak-node26.13.0/node-v26.13.0-darwin-arm64/bin`; Rust **1.99.1**. Keep the newest verified official LTS/stable stack and exact pins.

## What is actually done

Read [code audit](CODE-STATUS-AUDIT.md), [implementation progress](IMPLEMENTATION-PROGRESS.md), [delivery plan](DELIVERY-PLAN.md) and [task contract](../AGENT-TASKS.md).

- **Areas 1 & 2 (Invariants, Native Control Core & Durable Store)**: Single authoritative Rust control actor (`src-tauri/src/control.rs`) with exclusive OS-managed writer lock (`.control.lock`). Revision-fenced generation snapshot store (schema 20) with atomic single-generation commits and unconfigured capacity defaults (`CapacityProfile::unconfigured()`).
- **Area 3 (Containment, Broker & Mediation)**: Sandboxed worker execution with Node 26 LTS, zero inherited ambient secrets/filesystem paths, and private IPC descriptor 3. Native credential vault and broker mediate model requests. Loopback Ollama (`127.0.0.1` and `localhost`) admitted.
- **Area 4 (Single-Writer Cutover & Workspaces)**: Native control actor established as sole writer for projects, workspaces, and session bindings. TypeScript `WorkspaceRegistry` transitioned to read-only in desktop mode with atomic `workspaces.json` legacy projection. Native Tauri IPC handlers registered for all project and workspace mutations.
- **Area 5 (Uncertainty Tracking & Bounded Reconciliation)**: Operation uncertainty tracking, fail-closed `AdmitRun` during uncertain operations, user review with date-stamped reconciliation notes, and truthful status note generation (`"Stopped before native execution."` for unexecuted cancellations).
- **Area 6 (Common Capacity Admission & Resident Leases)**: Typed native capacity reservation and release (`Resource::ContainedProcess`) integrated with `SandboxPoolManager` and task lifecycle.
- **Area 7 (Bounded Child Delegation & Supervisor Transitions)**: `ChildDispatch` and `ChildProposal` framing and validation in `task_protocol.rs`. Supervisor atomically trades queue leases for execution leases and delivers attempt return receipts back to the worker.
- **Area 8 (Cross-Platform Verification & Packaging)**:
  - Linux Docker Container (`vakyartha-linux-rust-check:1.99.1`): 160/160 Rust tests passed (0 failed, 0 ignored).
  - macOS Native: 151/151 Rust tests passed (0 failed).
  - Application Suite: 327/327 tests passed (0 failed, 1 paid test skipped).
  - Native Desktop Smoke Check (`scripts/desktop-check.ts`): Passed with binary receipt and 0 Node TCP listeners (`vak-desktop-private-VTXUn2`).
  - Canvas WebKit Smoke Check (`scripts/canvas-check.ts`): Passed 14/14 steps at 1100px and 620px viewports (`vak-canvas-check-9YB4QT`).
  - Release Packaging: `npm run desktop:build` produced validated `.app` (226.22 MiB) and `.dmg` (69.37 MiB) release bundles.
  - Fail-closed execution profile on startup: `CapacityProfile::unconfigured()`. Windows actor startup remains disabled until directory-sync durability is verified.
- **Primary-Provider Local Outcome Gate (`AGENTS.md`)**:
  - `node scripts/record-view-check.ts --run-local --table-only` passed 3/3 scenarios on local Ollama `qwen3.5:4b-mlx` (`.vak/contracts/record-view-2026-10-31T01-59-22.431Z.json`).
  - Full multi-view check (`node scripts/record-view-check.ts --run-local`) retained honest failure in `.vak/contracts/record-view-2026-10-31T02-01-05.451Z.json`.

## Current operational boundaries

1. **Production Work execution profile**: Startup initializes with `CapacityProfile::unconfigured()`. Leases fail closed (`AdmissionError::UnconfiguredResource(Resource::Generation)`) until an explicit user/admin profile is activated.
2. **Windows actor durability**: Windows directory-sync (`FlushFileBuffers` on directory handles) remains disabled until tested on Windows hardware.
3. **Hard OS-level resource quotas**: Helper backends currently enforce timeouts and memory boundaries via the Node runner, while logical deadlines/token/active-time limits are strictly enforced in Rust.

## Verification receipts

- Native desktop smoke: `/var/folders/bz/dq3r0_6s4msbsq08r5h4slcr0000gn/T/vak-desktop-private-VTXUn2/receipt.json`.
- Canvas WebKit smoke: `/var/folders/bz/dq3r0_6s4msbsq08r5h4slcr0000gn/T/vak-canvas-check-9YB4QT`.
- Record-view contract receipt: `.vak/contracts/record-view-2026-10-31T01-59-22.431Z.json`.
- App suite: 327 passing, 1 skipped.
- Rust suite: 151 passing on macOS; 160 passing on Linux Docker.

