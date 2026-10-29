---
name: interactive-ui
description: Create or update forms, tables, charts, metrics and linked data; handle submitted UI actions. Use the always-on surface-design guidance for visual layout.
license: MIT
compatibility: Works with Vakyartha Projection engine and reactive client surfaces.
metadata:
  author: nranjan2code
  version: "1.4"
allowed-tools: vak_render vak_update vak_submit
---

# Canonical data and interaction

Use the required surface-design guidance for composition. The currently offered tool schema and authoring instructions own envelopes, child representation and available props; do not copy a flat-node or transactional envelope into another mode. Use only offered tools.

## One data owner, related projections

Store complete source records and editable criteria in surface data. Preserve identities, supplied values, units and numeric types; missing facts remain explicit. Independently requested outputs and unrelated datasets stay separate. Related table/chart/stat views map the same collection rather than copying cells:

- table rows: {"records":"{/records}","fields":["label","value"]}; columns match fields in count and order.
- chart series: {"records":"{/records}","label":"label","fields":["value"]}; omit a separate labels array. Scatter adds x:"numericField".
- stat value: {"records":"{/records}","field":"value","aggregate":"sum"}; supported aggregates are sum, mean, min, max and count.

Only aggregate comparable measures; do not sum prices, percentages, averages or different currencies. Formula strings do not execute. Per-record arithmetic and derived results need an offered computation tool or independently checked calculations. Submit complete data with views that reference it; unresolved pointers are not a result.

## Inputs and submitted actions

Initialize supplied defaults at the exact canonical bind path. Display bindings use {/path}; inputs use bind:"/path". Props.value and placeholders do not initialize a bound input. Use the offered input/choice/date/textarea components and a form with an explicit submit action. Follow the active schema for inline children or existing node IDs.

A local bound edit updates displays of that pointer. Table search/sort/paging changes only that table's view, not canonical records, chart populations or aggregates. Global criteria require an explicit submitted operation that updates all affected results and interpretations. A refresh label alone does not read a source.

Read the actual submitted action, surface and paths. Repeated leaf field names may be full canonical pointer keys. Update affected values, views and visible acknowledgement together while preserving unrelated surfaces, records and unsent edits. Use canonical IDs for targeted changes; replacing a surface must include its complete retained data and content.

Conversational surface submissions can continue the assistant. Executable app actions run the published handler directly; do not add a model call or parallel persistence path for them. An approval-looking control cannot grant tool access. Claim saves, source refreshes or other external effects only from their actual receipts.
