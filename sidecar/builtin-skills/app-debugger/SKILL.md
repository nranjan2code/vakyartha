---
name: app-debugger
description: Diagnose a sandboxed executable app with broken actions, stale refresh, invalid source data, SQL/persistence errors, missing views or failed publication; preserve state and evidence while repairing its package.
license: MIT
metadata:
  author: Vakyartha
  version: "1.0"
---

# Diagnose executable app failures

Load enabled `debug-error` for general root-cause analysis and `app-maintainer` when source needs changing. Read the app's actual README.md, AGENTS.md, SKILLS.md and ARCHITECTURE.md using the offered app-package tool, together with current source, revision and run receipt. Do not infer its behavior from its name, screenshots or an old template.

1. Freeze the failing action, exact inputs, source identity/values, expected visible result and persistence receipt. Retain the original failure and current state; do not reset data or repeatedly refresh to seek a lucky pass.
2. Trace the earliest boundary: visible control and submitted pointer → revision/admission → handler export/arguments → integration schema and Allow/Ask/Off policy → source parsing → SQL/schema/units → returned Projection update → atomic commit → visible/spoken projection. Inspect actual error/tool receipts and source timestamps. Distinguish stale source data from stale UI or a stopped schedule.
3. Use offline known-value reproduction first. App rehearsal is sandboxed and has no external-tool authority; injected fixture data must be clearly identified, never presented as live. Missing helpers, unknown tools and permissions fail closed; do not run app code on the host as fallback.
4. A declared trigger is not streaming or proof of unattended refresh. Check scheduling opt-in, actual due-minute claims, app/computer awake/running state and last completed/failed/uncertain run. Never replay uncertain external effects or clear uncertainty without user inspection.
5. Correct app/domain code in a reviewed draft through `app-maintainer`. A general rendering/binding/catalog defect belongs in Projection's owning repository, not an app-side SVG/CSS/data rewrite; containment defects belong in the sandbox owner. Do not install dependencies or weaken security/limits to make a diagnostic pass.
6. Independently check original sources, values, calculations, controls, wide/narrow WebKit behavior and reopening/persistence after the fix. A safe rejection, valid surface, test pass or publication receipt alone does not prove the original outcome.
7. Update the app's four documentation files where behavior/contracts changed; write reproduction, root cause, verification and remaining limits. Report partial mechanism improvements separately from an unresolved user outcome.

Skills guide procedures only. Existing draft/publication fingerprints, integration approvals and app recovery authority remain enforced by their owners.
