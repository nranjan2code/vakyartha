# Data-first authoring

2026-10-27. Implementation direction; shared record field mappings are implemented in Projection. The specialized source-workspace execution has been deleted at the user’s request. A fresh skill-led linked-view/edit/submit workflow passes; generic per-record computation, broad reliability and installed outcome parity remain unproved. Replaces the broad rewrite proposal. No compatibility requirement; preserve required product capabilities and local user data.

## The agent's job

The agent loads relevant skills, obtains or creates data, chooses useful views and handles user intent. It should not recreate table rows, chart series, total metrics and form defaults independently, or learn different protocols for conversation and scheduled work.

The intended model-facing contract has three concepts:

1. **Data:** named records and input values, with explicit source/proposed/user ownership. Supplied facts are referenced, not reauthored. Missing values are explicit. Numeric values and units remain distinct from formatting.
2. **Views:** existing general components arranged on independently identified surfaces. Tables map columns to record fields; charts map axes/series to fields of the same records; metrics reference declared measures; forms edit declared input fields. The runtime projects these references into renderer-specific arrays. The agent does not duplicate those arrays.
3. **Operations:** declared deterministic transformations, local view changes, agent continuations or permission-governed external actions. A binding reads data; it never executes text as code. A skill describes available operations; it cannot create an implementation or authorization by naming one.

Skills contain task procedures and presentation judgment. Runtime code contains one contract for data, transformations, references, revision/conflict handling, validation, publication and target projection. Multiple surfaces, rich component composition, local controls, voice and remote-channel semantics remain requirements. Avoid a new fixed dashboard compiler that only handles a form/table pair.

## What the evidence establishes

Current skill handling reliably selects the UI skill in the tested full catalog. That does not establish correct authoring. The retained calculator creates correct chart results but writes formula text into its table for those same results. Its form is usable in the latest trial; the data has diverged between views. More examples or domain recipes do not remove that responsibility from the agent.

Projection's new caller data schemas and compatible collection references prove narrow contracts. They are optional enforcement for callers that already know a data structure, not the desired end-user authoring API. Do not hand-author a different schema in production for every user request. No automatic schema inference from a fixture or a natural-language prompt has been adopted.

## Concrete cleanup

| Code or document | Disposition |
| --- | --- |
| Duplicate app response/presentation prose | Removed from the server; assistant/interactive-ui skills own it |
| Mandatory framework layout recipe and conflicting table advice | Removed/aligned in Projection; caller chooses presentation |
| Parallel experiment modes in interactive-skill checker | Removed; retain old receipts, maintain one current trial |
| Broad rewrite proposal | Deleted; this smaller model-facing design replaces it |
| Specialized source-workspace derive/prepare/form-report path | Deleted at explicit user direction; original outcome checks remain open for the skill-led path |
| Per-layout task instruction recipes | Move procedures to skills; retain genuine caller requirements and independent outcome checks |
| Recovery parser and guessed aliases | Remove from new authoring once one canonical protocol covers required components; keep external-ingestion decisions explicit |
| Data validation, permission checks, canonical state, revision conflicts, receipts | Essential execution responsibilities, not skill content |

Do not maintain both old and new production authoring stacks as the final design. Existing code is an implementation reference, not a compatibility obligation. New work needs one owner and one public API; app code must not reshape model output to obtain a pass.

## Current proof and next coverage

Shared field mappings now use existing tables/charts/stats and form pointers. Offline checks cover local edits, submission, restore, multiple series/scatter, missing/nonfinite fields and independent-surface patches. A real WebKit test additionally checks the rendered table/chart/total after an edit. The fresh native provider trial passes after a general submission-field repair and prompt/schema cleanup; both preceding failures remain retained. Local primary-provider intent failures remain open. Next coverage should use independent requests, not more variants of one fixture. The same numeric field must appear consistently in every view after an edit or transformation. Include multiple datasets and independent surfaces, missing values, stale commands and target limitations. Reuse the existing catalog/projectors as execution targets where useful, without making their current wire arrays the agent's responsibility.

Freeze cross-domain outcome checks before local provider testing. No increasing retry limits, supplying calculated answers as schema constants or deleting failed evidence. Original source-workspace and installed-chat outcomes remain open until independently verified. Exact evidence and currently implemented mechanisms: `../EVALUATION.md` and `../SKILLS.md`.
