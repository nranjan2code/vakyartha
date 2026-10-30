---
name: diagrams
description: Design, architect, and render world-class visual diagrams across any domain: flowcharts, system architectures, sequence diagrams, ER schemas, state machines, decision trees, data pipelines, and concept maps with dual visual and spoken TTS narration.
license: MIT
compatibility: Universal diagramming capability; active across desktop Canvas, external channels, and spoken voice projection.
metadata:
  author: nranjan2code
  version: "2.0"
allowed-tools: read_skill_file use_skill vak_render vak_update vak_submit
---

# Universal Diagram Architecture & Visual Design

Comprehensive, domain-neutral methodology for designing, structuring, and rendering publication-grade diagrams on the Canvas using Projection's native `diagram` component, coupled with first-class spoken Text-to-Speech (TTS) narration.

## Overview & Skill Chaining

- **When to Use**: Activate this skill whenever the user asks for a diagram, flowchart, system architecture, sequence flow, ER schema, state machine, pipeline, decision tree, org chart, or concept map—or when explaining a multi-stage process where a visual model enhances comprehension.
- **Skill Chaining**:
  - `surface-design` (Required, always-on): Governs Canvas container clamping (`maxWidth: "md"` or `"lg"`), responsive geometry, typography, and theme token styling.
  - `diagrams` (This skill): Governs diagram archetype selection, tier decomposition, node shapes, edge semantics, loop routing, and dual visual/spoken narration.
  - `interactive-ui`: Load via `use_skill` when diagrams combine with interactive forms, parameter sliders, or filter controls.
  - `write-article` / `research-brief`: Load via `use_skill` when embedding structured diagrams into long-form publications or investigation reports.
  - `app-authoring` / `app-maintainer`: Load via `use_skill` when generating architecture or state diagrams for sandboxed applications.
- **Reference Files**:
  - Read `references/diagram-templates.json` via `read_skill_file` for complete, validated Projection surface schemas across the universal diagram archetypes.

---

## The 10 Universal Diagram Archetypes

Select the archetype that directly fits the analytical question:

| Archetype | Domain Neutral Purpose | Primary Visual Grammar | Layout Direction |
| :--- | :--- | :--- | :--- |
| **1. Flowchart & Process Map** | Step-by-step algorithms, business procedures, operational handoffs | Process boxes, decision diamonds ($\diamond$), terminal pills (Start/End), perimeter feedback loops | `tb` (Top-to-Bottom) |
| **2. System & Cloud Architecture** | Microservices, C4 models, multi-tier infrastructure, VPC boundaries | Grouped subgraphs (`containers`), database cylinders, API gateways, external client pills | `tb` or `lr` |
| **3. Sequence & Interaction** | Protocol handshakes, API auth flows, inter-agent message exchanges | Sequential stages, caller-to-receiver edges with numbered action labels, validation steps | `tb` |
| **4. Entity-Relationship (ER)** | Relational databases, domain ontologies, feature store schemas | Entity cards with field/type lists, cardinality relation edges (1:1, 1:N, N:M) | `lr` or `tb` |
| **5. State Machine & Lifecycle** | Order lifecycles, protocol states, device transitions, task states | State cards with entry/exit roles, event-triggered transition edges with guard conditions | `lr` |
| **6. Data Flow & Pipeline (DAG)** | ETL data pipelines, stream ingestion, ML training and inference stages | Sequenced horizontal pipeline tiers (Sources ➔ Ingestion ➔ Transform ➔ Storage ➔ Model ➔ Serving) | `lr` (Left-to-Right) |
| **7. Cross-Functional Swimlane** | Multi-department workflows, clinical triage, approval governance | Subgraphs representing functional owners (e.g. `Legal`, `Engineering`, `Ops`, `Customer`) | `tb` or `lr` |
| **8. Decision Tree & Classifier** | Diagnostic triage, risk scoring, loan approval rules, policy checks | Root condition, branch decision diamonds, terminal recommendation pills with confidence notes | `tb` |
| **9. Mindmap & Concept Tree** | Topic breakdown, functional taxonomies, strategy maps | Central root concept branching into primary pillars, then secondary leaves | `tb` or `lr` |
| **10. Feedback Control Loop** | Closed-loop systems, cybernetic processes, RL agents, continuous improvement | Feedforward processing line with perimeter feedback arc from Monitoring/Measurement to Goal | `tb` |

---

## Visual Design Disciplines: What to Do & What NOT to Do

### ✅ What to Do (Best Practices)
1. **Choose an Intentional Flow Direction**:
   - Use `tb` (Top-to-Bottom) for hierarchical architectures, decision trees, and step-down procedures.
   - Use `lr` (Left-to-Right) for pipelines, data ingestion, chronological lifecycles, and state transitions.
2. **Observe Miller’s Cognitive Budget (5 to 12 Nodes)**:
   - Keep primary diagrams bounded between 5 and 12 nodes for immediate cognitive clarity.
   - If a system has 20+ components, group them into **subgraphs** (e.g. `[Ingestion]`, `[Core Processing]`, `[Governance]`, `[Persistence]`) rather than generating an unreadable flat web.
3. **Use Semantic Node Shapes**:
   - `box` (Default): General processing step, service, or computational task.
   - `diamond`: Condition, gate, policy check, or human approval point (`shape: "diamond"`).
   - `cylinder`: Persistent storage, SQL database, document archive, vector store, or context memory (`shape: "cylinder"`).
   - `pill`: Start trigger, terminal outcome, event, webhook, or external client actor (`shape: "pill"`).
4. **Actionable, Verb-Based Edge Labels**:
   - Edge labels must specify the action, protocol, or data payload (e.g., `"validates JWT"`, `"queries vector store"`, `"escalates on error"`), never blank or vague lines.
5. **Route Feedback Loops Outside the Perimeter**:
   - Backward edges (retries, monitoring feedback, governance escalation) curve gracefully around the outer margin.
6. **Harmonious Group-Based Color Coding**:
   - Group related nodes by assigning them a shared `group` name (e.g. `"Inputs"`, `"Processing"`, `"Control"`, `"Execution"`, `"Feedback"`). The engine automatically assigns theme-safe palette series.
7. **Clamp Canvas Measure**:
   - Always enclose diagrams inside a container with `maxWidth: "md"` (720px) or `maxWidth: "lg"` (960px). Never allow unconstrained 100% full-width stretching on ultra-wide screens.

### ❌ What NOT to Do (Anti-Patterns)
1. **No Center-Slicing Spaghetti**: Never draw straight lines that slice through intermediate nodes.
2. **No Text Walls Inside Nodes**: Node labels must be **2 to 4 words maximum**. Detailed descriptions belong in the node's `note` attribute (accessible via click/hover/voice) or in nearby prose.
3. **No Orphan Nodes**: Every node in an operational or architectural diagram must have at least one valid incoming or outgoing edge.
4. **No Ambiguous Arrowheads**: Keep `directed: true` for all causal, procedural, and architectural flows. Avoid bidirectional arrows unless describing a symmetric peer protocol.
5. **No Hardcoded Colors or Absolute Pixels**: Never emit hardcoded CSS hex colors (`#1a1a1a`) or fixed pixel coordinates (`x: 240, y: 180`). Projection's engine computes responsive geometry dynamically.

---

## First-Class Spoken Projection (TTS & Voice Contract)

In Vakyartha, visual interfaces and voice audio are two projections of **one canonical surface**. A diagram cannot be spoken as raw SVG coordinates or an exhaustive list of 30 edges. The following rules are mandatory:

1. **Lead with an Executive Audio Gist**:
   - Always place a concise 1–2 sentence narrative description in the section description or immediately preceding text block.
   - *Example*: `"The applied AI workflow is a closed feedback loop: business tasks define data requirements, models infer recommendations, policy guardrails enforce safety, and operational measurements continuously refine model controls."`
   - Voice TTS traverses this canonical narrative first, giving hands-free and audio users immediate clarity.
2. **Structure Nodes with Distinct Names & Roles**:
   - Ensure every node has a plain-language, pronounceable label. Avoid cryptic acronyms without nearby context.
   - When a user asks for diagram details (`"Read the diagram connections"`), Projection’s `lowerSurface` reads each edge as:
     `**[Source]** → [Action Verb] → **[Target]**`.
3. **Carry Material Caveats in Text**:
   - Never rely solely on visual node positioning or color to convey an essential risk, latency limit, or regulatory threshold. Mention it explicitly in the section text or node `note`.

---

## Canonical Surface Schema Format

When emitting a diagram via `vak_render` or `vak_update`, use the `diagram` component:

```json
{
  "id": "workflow-diagram",
  "type": "diagram",
  "props": {
    "directed": true,
    "nodes": [
      { "id": "goal", "label": "Business goal", "group": "Design", "shape": "pill", "note": "Defines target KPIs and error tolerance." },
      { "id": "data", "label": "Context & Data", "group": "Inputs", "shape": "cylinder", "note": "Operational records and knowledge sources." },
      { "id": "model", "label": "AI Inference", "group": "Processing", "shape": "box", "note": "Classifies, predicts, or generates responses." },
      { "id": "guard", "label": "Policy Guardrails", "group": "Control", "shape": "diamond", "note": "Validates confidence, privacy, and safety." },
      { "id": "human", "label": "Human Review", "group": "Decision", "shape": "diamond", "note": "Escalation for high-impact edge cases." },
      { "id": "action", "label": "System Action", "group": "Execution", "shape": "box", "note": "Updates ERP, dispatches task, or notifies user." },
      { "id": "metrics", "label": "Outcome Tracking", "group": "Feedback", "shape": "pill", "note": "Measures drift, latency, and business impact." }
    ],
    "edges": [
      { "from": "goal", "to": "data", "label": "specifies needs" },
      { "from": "data", "to": "model", "label": "provides context" },
      { "from": "model", "to": "guard", "label": "returns candidate" },
      { "from": "guard", "to": "human", "label": "escalates if low confidence" },
      { "from": "guard", "to": "action", "label": "approves low risk" },
      { "from": "human", "to": "action", "label": "authorizes execution" },
      { "from": "action", "to": "metrics", "label": "logs result" },
      { "from": "metrics", "to": "goal", "label": "refines rules & models" }
    ],
    "subgraphs": [
      { "id": "sg-core", "label": "Decision Pipeline", "nodes": ["model", "guard", "human"] },
      { "id": "sg-exec", "label": "Operational Realm", "nodes": ["action", "metrics"] }
    ]
  }
}
```

---

## Verification & Acceptance Checklist

Before delivering any diagram:
- [ ] **Archetype Match**: Does the selected diagram structure match the domain question (Flowchart, Architecture, Sequence, ER, Pipeline, State)?
- [ ] **Cycle Safety**: If a feedback or retry loop exists, does it route smoothly around the outer margin without cutting through intermediate nodes?
- [ ] **Node Shapes**: Are decisions rendered as diamonds, databases as cylinders, and terminals as pills?
- [ ] **Edge Verbs**: Does every edge describe an active transition or contract?
- [ ] **Container Clamping**: Is the surface clamped to `maxWidth: "md"` or `"lg"`?
- [ ] **Dual Spoken/Visual Contract**: Does the diagram include a 1–2 sentence narrative summary in visible prose for voice TTS?
