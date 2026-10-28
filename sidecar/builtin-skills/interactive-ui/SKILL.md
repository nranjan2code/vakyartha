---
name: interactive-ui
description: Create or update forms, tables, charts, metrics and linked data; handle submitted UI actions. Use the always-on surface-design guidance for visual layout.
license: MIT
compatibility: Works with Vakyartha Projection engine and reactive client surfaces.
metadata:
  author: nranjan2code
  version: "1.3"
allowed-tools: vak_render vak_update vak_submit
---

# Interactive UI & Reactive Data Bindings

Implementation guide for building reactive, data-bound interfaces, multi-view mappings, editable forms and handling user actions.

## Overview & Relationship to Surface Design

- **Role**: This skill governs canonical state (`data`), component data mappings, input bindings and action handling.
- **Visual hierarchy**: Always adhere to the always-on `surface-design` skill for layout rhythm, component choice, density, responsiveness and spoken harmony.
- **Data independence**: Keep distinct tasks and independently requested datasets in separate collections. Do not force unrelated entities into one shared array.

## Data Architecture & Pointers

1. **Canonical state (`data`)**:
   - Store source records as structured arrays and objects in the surface's top-level `data` payload (e.g. `data: { records: [...] }`).
   - Store raw finite numbers, not formatted display strings (e.g. store `1500.5`, not `"$1,500.50"`).
   - Retain unknown or missing values explicitly as `null`; never silently convert missing metrics to `0`.
2. **Pointers**:
   - Use standard JSON pointer paths to bind data (e.g. `"{/records}"`, `"{/filter/startDate}"`, `"{/summary/total}"`).
   - Bound inputs read from and write to canonical pointer paths in `data`.

## Reactive Component Mappings

When multiple visual components reflect the same underlying records, map that collection dynamically rather than duplicating raw cells:

### 1. Data Tables
```json
{
  "id": "itemsTable",
  "type": "table",
  "props": {
    "columns": ["Date", "Item", "Amount"],
    "rows": {
      "records": "{/records}",
      "fields": ["date", "item", "amount"]
    },
    "searchable": true,
    "sortable": true,
    "maxWidth": "full"
  }
}
```
- **Strict field alignment**: `props.columns` MUST match `props.rows.fields` in count and order.
- Columns may be strings (`["Date", "Amount"]`) or objects (`[{ "key": "date", "label": "Date" }, { "key": "amount", "label": "Amount", "align": "end" }]`).

### 2. Analytical Charts
```json
{
  "id": "revenueChart",
  "type": "chart",
  "props": {
    "kind": "bar",
    "series": {
      "records": "{/records}",
      "label": "category",
      "fields": ["budget", "actual"]
    },
    "maxWidth": "md"
  }
}
```
- For `scatter` charts, specify `x: "xField"` alongside `fields: ["yField"]`.
- The mapping automatically populates categories from the record's `label` field and multiple series from the `fields` array.
- **Important**: When mapping chart series from records, DO NOT provide a top-level `labels` array; the framework generates category labels automatically from `series.label`.

### 3. Metric Aggregates (`stat`)
```json
{
  "id": "totalRevenue",
  "type": "stat",
  "props": {
    "label": "Total Revenue",
    "value": {
      "records": "{/records}",
      "field": "revenue",
      "aggregate": "sum"
    }
  }
}
```
- **Supported aggregates**: `sum`, `mean`, `min`, `max`, `count`.
- Only aggregate comparable measures in identical units. Do not sum percentages, averages, unit prices or differing currencies.

## Forms & Interactive Controls

1. **Input components**:
   - Use `input` for single-line controls with `props.kind`: `text`, `number`, `email`, `tel`, `url`, `time`, `range`, `rating`, `file`.
   - Use dedicated components for choice and multi-line inputs:
     - `select`: `props: { label: "...", bind: "/path", options: ["Option A", "Option B"] }` (or options as `[{ "label": "...", "value": "..." }]`). Supports `multiple: true`.
     - `checkbox`: `props: { label: "...", bind: "/path" }` for boolean flags.
     - `date`: `props: { label: "...", bind: "/path", range?: boolean }` for date selection.
     - `textarea`: `props: { label: "...", bind: "/path", placeholder?: "..." }` for multi-line text.
2. **Form container & action submission**:
   ```json
   {
     "id": "filterForm",
     "type": "form",
     "props": { "submit": "apply_filter", "submitLabel": "Apply Filter", "maxWidth": "md" },
     "children": ["categorySelect", "thresholdInput"]
   }
   ```
   - Form children contain the input controls.
   - Bind paths target exact paths in `data` (e.g. `bind: "/filter/category"` or `bind: "/records/0/status"`). Initial values MUST be initialized at that exact path in `data`.
   - Action buttons can also trigger direct actions:
     `{ "id": "btn", "type": "button", "props": { "label": "Approve", "action": "approve", "payload": { "id": "42" }, "style": "primary" } }`.

3. **Interactivity vs Calculations**:
   - Editing a bound input updates all local displays bound to that same pointer immediately without server round-trips.
   - Formula strings (e.g. `"=A1+B1"`) do not evaluate client-side. Derived calculations and row arithmetic must be performed on action submission or via offered calculation tools.
   - Table sorting, search and pagination are client-side view filters; they do not mutate canonical records or change aggregate scopes.

## Action Handling & State Continuation

When the user clicks an action button or submits a form, an action event is received by the assistant:
1. **Read submitted state**: Extract the submitted action name, target surface, and submitted form payload.
2. **Coherent recalculation**: Recompute affected metrics, update dependent charts and tables, and revise visible natural-language findings and caveats to agree with the new values.
3. **Preserve unrelated state**: Preserve unedited records, user form drafts, and unrelated surfaces.
4. **Visible confirmation**: Reflect the updated state clearly on the surface (updated numbers, badge, or receipt section).

## Tool Schema Adherence

- **Progressive Authoring (`vak_render`)**:
  - Arguments: `{ surface: "surface-id", title: "Readable Title", nodes: [...], data: { ... } }`.
  - The surface identifier argument is named `surface` (not `id`).
  - `nodes` is a flat list of node objects; the first node (or node with id `"root"`) is the root container. Parents list child node IDs in `children: ["child1", "child2"]`.
- **Incremental Updates (`vak_update`)**:
  - Arguments: `{ surface: "surface-id", nodes?: [...], data?: [...] }`.
  - Target the existing `surface` identifier.
  - Send patched nodes by node `id` and/or data patches (JSON Patch ops or object merge).
- **Surface Removal (`vak_remove`)**:
  - Arguments: `{ surface: "surface-id", ids?: ["node-to-remove"] }`.
- **Transactional Task Authoring (`vak_submit`)**:
  - In task workflows where `vak_submit` is offered, submit the complete candidate:
    `{ reply: "...", surfaces: [{ op: "replace", surface: "surface-id", title: "...", root: { ...inline node tree... }, data: { ... } }] }`.
