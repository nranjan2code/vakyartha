---
name: interactive-ui
description: Create or update forms, tables, charts, metrics and linked data; handle submitted UI actions. Use the always-on surface-design guidance for visual layout.
license: MIT
compatibility: Works with Vakyartha Projection engine and reactive client surfaces.
metadata:
  author: nranjan2code
  version: "1.2"
allowed-tools: vak_render vak_update vak_submit
---

# Interactive UI & Reactive Data Bindings

Implementation guide for building reactive, data-bound interfaces, multi-view mappings, editable forms and handling user-submitted actions.

## Overview & Relationship to Surface Design

- **Role**: This skill governs canonical state, component data mappings, input bindings and action handling.
- **Visual hierarchy**: Always adhere to the always-on `surface-design` skill for sizing, component choice, density, responsiveness and spoken harmony.
- **Data independence**: Keep distinct tasks and independently requested datasets in separate collections. Do not force unrelated entities into one shared array.

## Data Architecture & Pointers

1. **Canonical state (`data`)**:
   - Store source records as structured arrays and objects in the surface's top-level `data` payload (e.g. `data: { records: [...] }`).
   - Keep raw numbers separate from presentation strings (e.g. store `1500.5`, not `"$1,500.50"`).
   - Retain unknown or missing values explicitly as `null`; do not silently convert missing metrics to `0`.
2. **Pointers**: Use standard JSON pointer paths (e.g. `"{/records}"`, `"{/filter/startDate}"`).

## Reactive Component Mappings

When multiple visual components reflect the same underlying records, map that collection dynamically rather than duplicating raw cells:

### 1. Data Tables
```json
{
  "kind": "table",
  "props": {
    "columns": ["Date", "Item", "Amount"],
    "rows": {
      "records": "{/records}",
      "fields": ["date", "item", "amount"]
    }
  }
}
```

### 2. Analytical Charts
```json
{
  "kind": "chart",
  "props": {
    "chart": "bar",
    "series": {
      "records": "{/records}",
      "label": "category",
      "fields": ["budget", "actual"]
    }
  }
}
```
- For `scatter` charts, specify `x: "xField"` alongside `fields: ["yField"]`.
- The mapping automatically populates categories from the `label` field and multiple bars/lines from the `fields` array.

### 3. Metric Aggregates (`stat`)
```json
{
  "kind": "stat",
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
- Only use an aggregate explicitly requested or appropriate for the metric. Do not sum rates, percentages or prices across differing currencies.

## Forms & Interactive Controls

1. **Input definitions**:
   - Place input controls in structural layout containers (`stack`, `grid`) beside other elements.
   - Specify the input kind: `text`, `number`, `select`, `checkbox`, `date`.
   - Bind to an exact path in state: `bind: "/filter/category"`, or for a record row: `bind: "/records/0/status"`.
   - Provide an initial value at that target data path in `data`.
2. **Local interactivity vs calculations**:
   - Editing a bound input updates local displays bound to that same pointer immediately.
   - Dynamic formula strings (e.g. `"=A1+B1"`) are not executed client-side. Per-row formulas require calculation tools or recalculation on submission.
   - Table-level search, pagination and sorting are client-side view filters; they do not mutate canonical records or alter aggregate scopes.

## Action Handling & State Mutations

When the user interacts with an action button or submits a form (`vak_submit`):
1. **Read submitted state**: Extract the submitted payload, updated input paths and target action.
2. **Coherent update**: Recalculate derived totals, update affected charts, and revise natural-language summaries to match the new values.
3. **Preserve unrelated state**: Keep unaffected surfaces, historical context and unsubmitted user drafts intact.
4. **Visible acknowledgement**: Confirm the operation visibly on the surface (e.g. status badge, updated metric, or receipt card).

## Tool Schema Adherence

- **Initial render (`vak_render`)**: Supply a complete surface descriptor including `id`, `data`, and a root component tree with all child nodes.
- **Incremental updates (`vak_update`)**: Target the existing canonical surface `id` and supply the updated data and component modifications.
- **Correct validation failures**: If a tool call fails validation (e.g. missing pointer path or invalid prop), immediately repair the schema in the same run.
