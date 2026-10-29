# Folder workspaces and project chats

Status: proposed design and implementation plan, 2026-10-29. The user requested folder-scoped work in chats, optional Projects in the sidebar, shell support and safety, informed by the sibling harness and external research. No runtime implementation is claimed. The user selected isolated copies with review and explicit Apply as the default on 2026-10-29. Direct editing is outside the initial implementation scope.

## Experience

A standalone chat offers **Work in folder**. The person selects an accessible folder and sees the canonical path, execution mode, permissions and actual sandbox readiness before admitting work. General chats remain usable without a folder. Folder work is general-purpose: files, analysis, documents and software all use the same capability boundary.

The sidebar also offers **Projects**. A project has a name and one selected folder, with its chats beneath it. Creating a chat within a project binds that chat to the folder. The chat header always shows the effective folder and working mode; changing sidebar selection cannot retarget a running command. Long collections use the existing bounded browsing/search helpers. Narrow windows must retain folder/mode visibility without squeezing the conversation or Canvas.

Selected default: each folder-bound chat owns a retained Realm copied from the selected folder. File tools and shell commands use that same copy across turns and restarts. Changes become visible in the original only after complete review and explicit Apply; Undo uses the existing promotion receipt and conflict checks. Other project chats see applied original changes when their own copy is created or explicitly refreshed, not unreviewed changes in another chat. Never silently replace a dirty copy during refresh.

Direct editing, if selected as a supported mode, is a separate explicit grant to the original folder. It requires a verified policy for protected paths, destructive operations, concurrent writers and recovery. A sandboxed write to an original file is still a real write; do not label it as staged or promise Realm-style undo. A shared project Realm is also a separate mode requiring serialized writers and review ownership; do not implicitly share it between chats.

Chat membership and filesystem authority are distinct. Moving a chat to a project changes organization only until the person explicitly rebinds its workspace. A project folder change cannot silently grant that folder to existing chats, pending approvals or scheduled runs. Existing chats with earlier folder content require a clear history/context decision before rebinding; revoking access cannot erase content already recorded in a chat or sent to a provider.

Removing a project from the sidebar never deletes its source folder. Chat deletion, Realm discard, project removal and deletion of original files are separate operations. Retained work and receipts must remain discoverable after organization changes.

## General-purpose file and media work

The user clarified that workspaces must support code, document creation/editing, images, audio, video and other supported file workflows. A project is a working folder and related conversations, not a code-repository type. Capabilities remain extensible through the existing skills and integrations; there is no fixed domain router or separate agent engine per file type. This is intended scope, not a promise that every format or operation is already supported.

| Work | Execution and verification contract |
| --- | --- |
| Code and text | Shared file/shell tree, exact text changes, executable checks where available and authorized; no requirement that the folder be a repository |
| Documents and presentations | Enabled format-aware tools or approved local programs; reopen generated files, check content and render pages/slides for review; retain editable source when supported |
| Spreadsheets and data | Enabled format-aware tools or approved local programs; independently verify values/formulas/recalculation and previews, preserving original formats and unsupported features explicitly |
| Images | Existing image integrations or approved local transforms; preserve source, inspect dimensions/transparency/content and show before/after previews |
| Audio | Existing audio/voice integrations or approved local transforms; preserve source, verify duration/streams and provide playback plus transcript where supported |
| Video | Existing video integrations or approved local transforms; preserve source, verify streams/duration and review playable output/key frames and audio |
| Additional file formats | Discover a supported capability and its real limits; refuse unavailable operations clearly rather than inventing success or installing an unapproved dependency |

These are capability families, not implementations to build into one shell tool. Local deterministic processing runs inside the admitted sandbox. Hosted generation/editing runs through the existing approved provider/integration path; folder selection alone grants neither upload nor paid generation. Missing tools, unsupported models, format limits and unavailable codecs remain explicit. Never change providers or upload source files silently to get a result.

The current media tools accept private library/attachment asset paths, not arbitrary project paths. Add an app-owned bounded import/export handoff that validates the chat binding, relative source/destination, real path, object type, size, media signature and revision, and records provenance. Keep media jobs/assets with their existing writer and working files with the Realm owner. Do not loosen media path validation, leak credentials, create a second media library or grant a provider arbitrary workspace access.

Review must fit the file: text differences for code/text; rendered page/slide or cell/formula review for office formats; image comparisons; playback for audio/video. A binary hash proves identity, not quality. Apply binds the exact reviewed candidate bytes/hash and affected paths; Undo refuses later conflicting edits. Previews and parsers process untrusted files under an admitted boundary, with bounded resources and no active document macros or scripts executed implicitly. Large media needs an explicit supported size/resource policy; the existing 512 MiB copy ceiling and text-paged file reader cannot be represented as unrestricted media support.

Outputs remain ordinary files with format, size, provenance and execution receipts, exposed through existing artifacts and multiple Canvas surfaces as appropriate. Retain editable project/source material alongside exports when the format/tool supports it; no generic permanent history store or new format compiler is implied. A workflow can combine types, such as notes and a spreadsheet producing a document, chart images and a narrated video, while preserving the same workspace and approval scope.

## Canonical ownership

Use one app-owned workspace registry for project identity and session bindings. Store the registry outside selected folders under private app data; source folders do not need app metadata. Projection retains the canonical chat/session/surface store, existing tasks retain task/run/approval authority, and the sandbox remains the only Realm/promotion writer. The registry references existing session and Realm IDs rather than copying their records.

A binding identifies session, optional project, canonical source root, execution mode, optional Realm, revision and access state. A project records identity, name, folder and revision. Canonicalize aliases and reject system/home/app-private/control roots and overlapping unsafe grants. Missing, replaced or inaccessible folders revoke execution until explicitly revalidated; do not automatically recreate or follow a replacement path to a new target.

Each admitted run captures its binding revision. Every file/command dispatch and every approval resolution rechecks the current binding, integration policy and cancellation state. Scope identity includes the workspace/Realm and revision, not only session/tool name. A queued or approved operation from an old binding cannot execute against a new one. Serialize conflicting Realm writes; preserve candidate review versions and original conflict refusal across chats.

Do not use process-wide `chdir`, mutate `VAK_SANDBOX_WORKSPACE` on chat switches, or change a global filesystem server configuration to emulate per-chat access. Background sessions and scheduled work must remain bound to their own captured scope. A chat without a folder receives no accidental folder grant from another chat or the global setup setting.

## Tools and safety

Expose discoverable file listing/search/read/edit/write and shell execution through the existing integration catalog, lifecycle, schemas, policies, approvals and logs. Do not add a separate shell runner, filesystem connector or permission database. All tools in a chat resolve the same admitted working tree; changing `cwd` affects only a relative directory inside it.

Shell text is an explicit argument to the approved shell executable, with startup files disabled and a minimal declared environment. Enforce path, network and descendant restrictions in the sandbox; command-name allowlists and prompt instructions cannot establish containment. Current command/Realm deadlines and output caps remain in effect until deliberately extended in the owning runtime with tests. No automatic unsandboxed retry.

Local filesystem integrations with broader global roots cannot be offered as a way around the chat boundary. A session-bound capability must receive enforceable scope, or be unavailable in folder mode. Remote integrations retain their own explicit account/tool authority; selecting a folder does not grant uploads, remote mutations or network access. File transmission to providers and integrations must be disclosed separately from local folder selection.

Folder instructions and setup scripts are read as data. A repository cannot grant itself permissions, disable sandboxing, install tools, start hooks, reveal credentials or widen the root. Read only relevant bounded instructions inside the admitted root; do not traverse parent projects or automatically execute setup. Protected filenames remain excluded/denied according to the sandbox contract; arbitrary secret contents are not automatically detectable.

Use the existing reviewed file changes and receipts in the chat, retaining all interactive surfaces and Canvas selection. A terminal-style stream is optional presentation, not execution authority. Keep actual command/cwd, status, bounded output, changed paths, Apply/Undo receipts and interrupted state inspectable. Rendering a review control does not authorize a write.

## Existing mechanisms and missing seams

Vakyartha already has supervised commands, retained Realms, paged review/file reads, journaled promotion and receipt-bound rollback. Its sandbox adapter currently reads one global folder setting. Its sidebar lists sessions, without a project/folder authority registry. The ordinary one-shot command copies/discards per call, so it cannot provide persistent chat work by itself.

Projection's public `Integrations.toolsFor(session)` already owns per-session tool admission and approvals, but a built-in server is currently instantiated without session context and `BuiltinServer.callTool` receives no session. Identify the smallest general request-context/dispatch hook needed to pass an app-owned workspace binding through the existing lifecycle, before adding a framework capability. An app-side prompt/root argument supplied by the model is not an authority seam. Implement framework changes in Projection and adopt only a tested pushed pin.

The sibling source demonstrates shared file/shell working directories, path validation and a remembered-workspace list that does not erase content when hidden. Its task-environment design explicitly remains in progress with unrecorded acceptance scenarios, and its Bash implementation can execute without a sandbox object. Reuse the ideas after independent verification, not its completeness claims, security assumptions, dependencies or source wholesale.

Current sandbox copies omit `.git` and common credential files, reject Realm symlinks and special objects, and bound copy size/count and command lifetime. Some runtimes need spawn behavior presently denied by the helper. Therefore folder binding must not promise arbitrary repository work, dependency installation, Git worktrees, servers or long builds. Any required general capability is implemented and tested in the sandbox owner first. No new package or runtime is adopted by this proposal.

## Implementation and acceptance

1. Implement the private project/binding registry, revisioned APIs and native folder-selection admission through the existing desktop connection. Do not add a general native filesystem relay. Browser mode must clearly identify whether a folder belongs to the host machine; it cannot infer a host path from a browser upload.
2. Establish the public session-scoped integration seam and bind retained Realm lifecycle to the captured chat scope. Test two concurrent sessions before UI integration. Keep legacy global Sandbox setup explicit rather than silently migrating its authority to all chats.
3. Add chat folder controls and Projects with bounded browsing. Preserve background runs, drafts, task ownership, existing artifacts and multiple surfaces. Rebinding waits for active execution/approvals to settle or explicitly cancels/revokes them.
4. Exercise actual file and shell work in a retained copy, full review, denied/approved Apply, Undo, restart/resume and conflicting original edits. Verify original bytes independently, including deletion/mode changes and interrupted state. Deleting UI records must not erase source files.
5. Prove denied traversal, absolute-path escape, symlink escape, cross-chat Realm IDs, stale binding/approval replay, broad filesystem integrations, shell startup injection, external IO/network and credential/control-state reads. Missing helper or unavailable platform must refuse before effects. Keep broader CPU/memory/Linux requirements in the system-isolation track open.
6. Verify wide/narrow WebKit folder selection, project navigation, permissions, review and exact paging/filter behavior alongside existing Canvas/Skills checks. Freeze one real primary-local workflow: inspect a synthetic file, edit it, execute a verifier, review/apply and independently confirm the original and receipt. Tool mechanics and a heading-only model smoke cannot close that outcome.

External research supports separate workspace scope, permission decisions, project trust and OS-enforced shell containment. Those are mechanism inputs, not proof of this implementation: [working-directory permissions](https://code.claude.com/docs/en/permissions#working-directories), [sandbox scope and exclusions](https://code.claude.com/docs/en/sandboxing), [external-directory authorization](https://opencode.ai/docs/permissions/#external-directories). Checked 2026-10-29.

Related: [existing Realm contract](OVERVIEW.md), [required system isolation](SYSTEM-ISOLATION.md), [runtime ownership](../MVP-SPECS.md#runtime-placement-performance-and-security), [implementation checklist](../MVP-CHECKLIST.md#folder-workspaces-and-project-chats--2026-10-29).
