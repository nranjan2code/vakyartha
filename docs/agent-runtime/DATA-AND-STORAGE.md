# Data identity, folder authority and storage layout

Status: code-inspected baseline and proposed target, 2026-10-29. Follows the user's request to check source before trusting older folder/IA documentation. [Information architecture](INFORMATION-ARCHITECTURE.md) defines navigation; [implementation design](IMPLEMENTATION-DESIGN.md) defines native ownership. Proposed directories are not current on-disk migrations.

## 1. Direct answer: what lives where

Source files stay in the user-selected folder. Private app state stays in the app's private data root. Project/workspace views are metadata references to that state, not additional copies of chats, task journals or files. Nothing creates a hidden app database or credential store in a selected source folder.

| Current runtime | Current private data root |
| --- | --- |
| Installed macOS app | `~/Library/Application Support/com.nranjan2code.vakyartha/` |
| Desktop development | `<repository>/.vak/desktop/`, unless explicitly overridden by development configuration |
| Browser development | `<repository>/.vak/web/`; its explicit transcript override may use that root directly |
| Other native platforms | Native platform app-data resolver; effective path must be shown, not guessed from a folder selection |

Environment/dev data is not committed. Stored secrets remain in the canonical platform vault; never copy them into workspace/project metadata, transcripts, export packages or backup manifests. A provider-sent snapshot is already disclosed data; later folder revocation cannot unsend it.

## 2. What current source actually represents

Inspected `sidecar/workspace-registry.ts`, `sidecar/sandbox-realms.ts`, `sidecar/server.ts`, `sidecar/task-files.ts`, `src/workspaces-panel.ts` and `src/main.ts`.

| Current entity/path | Observed behavior |
| --- | --- |
| `Project` | UUID, name, canonical folder string, revision and optional shared Realm; current creation requires a folder |
| `WorkspaceBinding` | Keyed by session ID; folder string, optional project/Realm IDs, mode, sharing flag, revision and access state |
| `<data>/workspaces.json` | TS-written projects and bindings; no independent stable `workspaceId` entity or durable physical folder identity |
| Desktop `<data>/host-sessions/` | Revisioned canonical conversation/surface snapshots written only by the native Rust actor through the framework's `HostSessionStore` adapter |
| Browser `<data>/sessions/` | Framework host filesystem store used only by browser development; session readers use the active backend |
| `<data>/tasks/` | Current TS task journals; a task links its canonical session |
| `<data>/outputs/<task>--<run>.md` | Current private task Markdown outputs with hash/version receipts |
| `<data>/attachments/<session>/` | Session-owned attachments |
| `<data>/media/` | Existing media jobs/private assets and media metadata owner |
| `<data>/apps/`, `app-drafts/`, `app-state/` | Existing executable package/draft/state owners |
| `<data>/sandbox/realms/<realm-id>/workspace/` | Existing helper-owned retained working copy; original stays external until reviewed Apply |
| `<data>/logs/` and optional transcripts | Numeric/diagnostic records with their distinct retention scopes |

Direct editing writes admitted originals; copy/review operates in a Realm. Shared project Realms exist already. The target must preserve these capabilities while correcting authority and ownership. Do not describe stable folder identity, native registry control or fully unified navigation as already implemented.

The Rust control actor is started with the desktop engine and its current control snapshot is schema 12. It models Project, Workspace, WorkspaceBinding and ProjectMembership as separate records, captures canonical folder identity, and can register workspaces, bind/revoke/rebind a session, change project membership, create/fence roots, and revalidate a grant. Trusted shell commands can use this native state, but the TypeScript `WorkspaceRegistry` still owns the active product workspace routes; do not infer a single-writer cutover from the native registry. Both admission paths reject system/private roots, reserved path components and the app-data root or its ancestors. No sandbox command receives the native grant through an enforced dispatch path yet. See [implementation progress](IMPLEMENTATION-PROGRESS.md) for evidence and limits.

**Current native candidate state (2026-10-30):** the native actor persists exact bounded candidate proposals as immutable `<private-data>/content/sessions/<session-id>/generation-<revision>.json` files. The selected revision, digest, execution fence and exact-retry receipt live in the actor's single-writer control snapshot. This remains an intermediate task commit boundary: product task runs do not yet call the candidate API, and candidate bytes are not published into canonical sessions. Do not treat `content/sessions` as current chat state.

Projection `822622e` exports a revisioned `HostSessionStore`, now wired in desktop mode through the private sidecar pipe to the Rust actor. Compare-and-set revisions, owner-only files, recovery and trusted UI admission protect logical writes; the worker cannot self-admit a chat ID. **This is not a confidentiality boundary against a compromised desktop sidecar:** Node runs as the same OS user and can currently read the app-data directory directly, including `host-sessions/`. Owner-only permissions do not distinguish the app's Rust process from its sidecar. Protecting these bytes from a fully compromised worker requires a proved OS-enforced process boundary or moving sensitive reads into a broker that returns only operation-scoped data; neither is implemented. The private-pipe API and admission check must not be described as preventing direct file reads. Browser development continues to use `<data>/sessions/`. FinOps reads canonical snapshots through the active backend rather than assuming a filesystem path.

New Work tasks now use the same native session authority: the trusted composer allocates the task/session ID and admits it before posting the task contract. The TS-owned `<data>/tasks/` journal remains a separate active writer for task lifecycle state; this admission bridge does not transfer scheduler, approval, workspace or terminal-state authority. Existing queued/scheduled records across restart are not yet reconciled through a native task registry and remain part of the open task cutover.

On first desktop startup, existing `<data>/sessions/*.json` records are inventoried by count, byte size and digest. Import is an explicit copy after user confirmation; source bytes remain in place, and a durable receipt makes retries idempotent. Declining leaves old records untouched and starts a fresh chat. Desktop WebKit smoke verifies the prompt, native list/load/save path, source preservation and private file mode. This storage cutover does not complete task authority, publication, workspace registry or recovery UI.

## 3. Target entity relationships

```mermaid
erDiagram
    PROJECT ||--o{ MEMBERSHIP : organizes
    SESSION ||--o| BINDING : has_active
    WORKSPACE ||--o{ BINDING : identifies_folder
    PROJECT }o--o| WORKSPACE : preferred_context
    SESSION ||--o| ROOT_TASK : anchors
    ROOT_TASK ||--o{ ATTEMPT : owns
    ROOT_TASK ||--o{ ARTIFACT_REF : produces
    BINDING }o--o| WORKING_COPY : selects
    WORKSPACE ||--o{ WORKING_COPY : source_for
```

Membership is organizational and can reference a chat/task/artifact/app through its existing owner. The initial IA uses one optional project membership per such item; it does not require duplicating that item. A project can exist without a folder. A standalone chat can bind a workspace without a project. Initially a chat has at most one effective workspace binding; adding multiple active folders requires an explicit future scope contract.

Retain one canonical session per explicit task with multiple runs/continuations; do not let unrelated tasks concurrently overwrite one session. Ordinary chat has an internal admitted execution scope without becoming a user-visible unattended task. Session ownership and explicit outside-agent surface routing remain distinct from project membership.

| Identity | Meaning and authority |
| --- | --- |
| `projectId` | Organization and optional preferred workspace; not a filesystem grant |
| `workspaceId` | Native-allocated identity for an explicitly registered external folder; not itself permission to every session |
| Folder identity | Canonical display path plus platform directory/object/volume identity or a proved equivalent; path alone is not identity |
| `bindingId` / revision | Admitted association of a session with workspace, mode and allowed capabilities |
| `realmId` | Existing helper-owned working-copy identity, source workspace identity and explicit sharing ownership |
| `rootId`, `runId`, `childId`, `attemptId` | Execution/accounting lineage, not filesystem paths |
| Artifact reference | Existing session/surface/version or owned output/media identity; does not copy canonical content |

Native registry owns project/workspace/binding/membership records and revisions. Rust control owns task/execution/evidence state. Framework service owns canonical semantic records, with native protected persistence. Sandbox owns working copies/promotion. Derived indexes can be rebuilt and never authorize access.

## 4. Proposed physical layout

Keep the same private root, with explicit bounded namespaces. `control/registry` uses the same native sole-writer generation/selection primitive as root control; do not leave a live TS `workspaces.json` writer beside it.

```text
<private-data>/
  control/
    format.json
    registry/                     projects, workspaces, bindings, membership,
                                  policy references and native revisions
    roots/<root-id>/              authoritative task/run/child/evidence state
    recovery/                     prepared commits and exact uncertain ops
  content/
    sessions/<session-id>/        immutable task candidate generations; not canonical chat state
    inputs/<root-id>/             explicitly captured immutable input snapshots
    outputs/<root-id>/<run-id>/   private task exports and receipts
  host-sessions/                  native-written canonical chat snapshots
  attachments/<session-id>/       existing session-owned asset namespace
  media/                         existing media owner; no second asset library
  apps/                          existing package owner
  app-drafts/                    existing draft owner
  app-state/                     existing app/domain owner
  sandbox/                       helper-owned Realm/control layout unchanged
  logs/                          numeric telemetry and protected diagnostic streams
```

These are entity namespaces, not one private state directory per project name or source-path hash. Renaming/moving a project or associating a task with another project does not move its content, duplicate it or reset execution history. Workspace/project pages query references under the current native registry. Historical task scope remains in its admitted run record even if the sidebar grouping changes.

Native persistence I/O is the sole durable writer for the new protected task/registry/canonical namespaces. Existing media/app/sandbox owners keep their own entities until a separately specified ownership move; any retained writer is confined to that namespace and cannot mutate native control. No reasoning worker receives the whole private root, Realm metadata or unrelated content. It receives only scoped read-only input references and its admitted working tree/scratch through the sandbox.

## 5. Folder identity and authority transitions

Register a selected folder through native admission: validate/canonicalize the user selection, reject forbidden roots, capture its platform identity and display path, allocate/reuse an identified workspace, and create an explicit binding/mode grant. Matching aliases for the same verified folder may reuse identity; they do not merge histories or transfer approvals. The exact platform identity and no-follow/open-handle mechanism is IA-02, not a portable inode assumption.

Before dispatch, resolve current binding/permission/cancellation revisions and verify that the actual enforced filesystem target still matches the admitted object. Close check/use races through the native/sandbox path; canonicalizing once is insufficient. Missing identity support refuses a required strong binding guarantee.

### Execution grants do not follow a mutable chat binding

At root/run admission, native control records an immutable execution grant: `bindingId` and revision, `workspaceId`, physical folder identity, allowed relative path/capability scope, editing mode, and any Realm/sharing identity and revision. Queued, scheduled, waiting and resumed work retains that grant. Dispatch compares it with current authority and the actual enforced target; a mismatch refuses the operation. It never resolves a newer session binding and silently substitutes folder B for admitted folder A.

Rebinding invalidates affected queued/scheduled/waiting roots, descendants, pending approvals and prepared candidates as well as active work. Historical results keep their original scope attribution. Retargeting requires an explicit task-contract amendment or continuation with reviewed inputs and a new admitted grant; changing project membership alone changes none of this. A queued job can remain discoverable as blocked/stale without acquiring the new folder.

A child is not a new chat or binding. Native derives a narrowed grant from the root's fixed grant and records the child's read/write scope and copy/scratch ownership. It gains no Realm membership from a parent/project label. Use immutable/read-only source snapshots for independent analysis, separate child candidate/scratch trees for conflicting writes, or explicit shared-copy membership with serialized operations and version-checked inputs. All derived grants remain constrained by the same root and sharing revisions; child completion cannot promote candidate files outside the existing reviewed sandbox path.

```mermaid
stateDiagram-v2
    [*] --> Unbound
    Unbound --> Admitted: explicit native folder binding
    Admitted --> Missing: object unavailable
    Admitted --> Revoked: user revokes or identity changes
    Admitted --> Inaccessible: platform access lost
    Missing --> AwaitingRevalidation: location becomes available
    Inaccessible --> AwaitingRevalidation: access may be restored
    Revoked --> AwaitingRevalidation: explicit user requests readmission
    AwaitingRevalidation --> Admitted: explicit identity and authority admission
    Admitted --> Unbound: detach without deleting source or copy
```

Permission revocation is sticky. Availability checks cannot grant authority again. Recreating a directory at the same path does not inherit the old grant. A move/rename can retain `workspaceId` only after verified identity and explicit locator/readmission handling; pending approvals are invalidated by the revision change. A copied folder or different-volume replacement is a new identity unless a separately reviewed migration establishes otherwise.

Project preferred-folder changes affect new defaults, not existing bindings. Moving a chat between projects changes membership only. Rebinding a chat is a separate action showing effective path/mode and context-history implications, with every affected execution grant invalidated as above. No global `cwd` or process environment is retargeted.

## 6. Working-copy ownership and storage operations

Each non-shared copy belongs to an admitted binding/workflow and source workspace. Shared copies have a stable workspace-level sharing record, explicit member grants and serialized writes; project removal does not destroy that owner. A session with no assigned Realm has no blanket access to any Realm from the same source folder. Validate source identity and membership, not merely matching paths.

| User action | Effect | Must not imply |
| --- | --- | --- |
| Remove project | Remove organization/default reference; expose detached items | Delete source files, chats, copies, receipts or revoke unrelated access |
| Detach folder | Revoke that binding and fence future operations | Destroy its retained candidate copy silently |
| Discard working copy | Explicit reviewed destruction through sandbox owner, showing unsaved changes and sharing impact | Delete originals or another member's live copy |
| Delete chat/task | Remove its stated owned content/drafts according to retention and active/uncertain-effect rules | Cascade into shared artifacts, project source or provider records |
| Export/save to folder | Exact admitted destination/mode, current candidate and receipt | Grant arbitrary filesystem writes or upload permission |
| Apply/Undo | Existing fingerprint-bound sandbox promotion/rollback | Pretend a manifest is a filesystem restore checkpoint or undo remote effects |

Unbinding leaves retained work discoverable under Workspaces/Working copies until explicitly discarded. Orphan cleanup is a visible retention policy with reference checks, not a side effect of sidebar navigation. Private outputs are discoverable from their task/project/workspace references; writing an output into the external folder is a separate governed operation.

## 7. Source-level audit evidence and root corrections

The original source audit used temporary synthetic folders, no app instance, helper, provider, credentials or network, and removed fixtures afterward. At that checkpoint it observed:

- `revokeBinding` followed by `verifyDispatchScope` accepted dispatch because `revalidateBinding` restored `admitted` from filesystem availability.
- Replacing the directory with a new directory at the identical path was accepted; the registry stored no physical folder identity to distinguish it.
- `verifySessionRealmAccess` accepted an arbitrary Realm identity when the binding had none assigned. The tool adapter later checked source path, so this probe established a registry authorization gap, not a complete cross-folder exploit demonstration.
- Registry load handles unreadable/corrupt content as empty; the native target must expose recovery failure rather than silently start a new authoritative registry.
- Binding deletion in `sidecar/server.ts` attempts to destroy a non-shared Realm and suppresses destruction errors. Target detach and discard must be distinct and inspectable.
- Sidebar grouping currently derives from `WorkspaceBinding.projectId`, coupling organization to the access record. Target membership is separately modelled; no folder is required merely to organize chats.

Current code has corrected the first three TypeScript registry defects: revocation stays sticky, a replacement directory at the same path receives no inherited grant, and an unassigned binding cannot access an arbitrary Realm. On Node 26.13.0, the workspace registry, containment and Realm suites pass 28/28 on 2026-10-30. These are current TypeScript-path checks, not native product cutover or dispatch-time filesystem enforcement. The corrupt-registry refusal is also covered by a regression. The native registry remains unconnected to product writes; path check/use safety, the detach/discard workflow across all owners, and the IA acceptance flows remain open under IA-01–IA-06 and AR/ISO gates.
