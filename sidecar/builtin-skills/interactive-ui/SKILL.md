---
name: interactive-ui
description: Create or update forms, tables, charts, metrics and linked data; handle submitted UI actions. Use the always-on surface-design guidance for visual layout.
---

Use the requested outputs and operations. Keep independently requested surfaces and unrelated datasets separate. Apply the always-on surface-design guidance for every canvas; do not depend on skill selection or settings state for visual hierarchy.

Keep source facts and editable inputs in data, with numbers separate from display units. Preserve unknown values explicitly. When several views describe the same records, map that collection instead of copying its cells:
- Table: columns:["Label","Reading"], rows:{records:"{/records}",fields:["label","value"]}.
- Chart: series:{records:"{/records}",label:"label",fields:["value"]}. The mapping supplies labels; multiple numeric fields make multiple series. Scatter may add x:"field".
- Stat: value:{records:"{/records}",field:"value",aggregate:"sum"}. Available aggregates: sum, mean, min, max, count. Choose only a requested aggregate.

Forms contain controls in structural children, beside props. A numeric input uses kind:"number", bind:"/records/0/value" and an initial value at that exact data path. Display bindings use "{/path}". Editing a record updates its mapped views locally. Formula strings do not execute; use an offered calculation tool, or explain that submission triggers recalculation. Local table search/sort/page affects that table only, not other views or aggregate scope.

On a submitted action, read the current values and paths. Update affected results and interpretations coherently; preserve unrelated surfaces, original facts and user edits. Make the acknowledgement visible. Describe unsupported behavior honestly.

Follow the offered tool schema: replacements contain complete data and a root tree; later edits target canonical IDs. Load another enabled skill when it supplies a needed task procedure. Skills never grant execution permission.
