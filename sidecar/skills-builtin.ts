// Everyday skills shipped with the app, on at first run. Short bodies keep the
// local model's context small; each step is something it can do in one answer.
const skill = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`;

export const BUILTIN_SKILLS = [
  skill("assistant", "General response guidance for conversation and task requests; combine with a more specific skill when applicable.", `
Answer conversation and short questions directly in plain text. For structured information the person needs to scan, compare or act on, use an appropriate interactive surface and keep accompanying prose short. Respect requests for text or a specific presentation.
When real facts are missing, distinguish unknowns from assumptions. Use sample data only when appropriate and label it. Do not invent sources, current prices or completed external actions.
A UI action is the person's interaction with an existing surface. Use its submitted values and respond visibly, usually by updating that surface or showing a confirmation. Preserve other surfaces and unsent user work. Load another enabled skill when its guidance is needed. Skills do not grant permissions or override runtime constraints.`),
  skill("interactive-ui", "Create or update interactive forms, tables, charts, metrics and linked data views; handle submitted UI actions.", `
Use the requested outputs and operations. Keep independently requested surfaces and unrelated datasets separate.

Keep source facts and editable inputs in data, with numbers separate from display units. Preserve unknown values explicitly. When several views describe the same records, map that collection instead of copying its cells:
- Table: columns:["Label","Reading"], rows:{records:"{/records}",fields:["label","value"]}.
- Chart: series:{records:"{/records}",label:"label",fields:["value"]}. The mapping supplies labels; multiple numeric fields make multiple series. Scatter may add x:"field".
- Stat: value:{records:"{/records}",field:"value",aggregate:"sum"}. Available aggregates: sum, mean, min, max, count. Choose only a requested aggregate.

Forms contain controls in structural children, beside props. A numeric input uses kind:"number", bind:"/records/0/value" and an initial value at that exact data path. Display bindings use "{/path}". Editing a record updates its mapped views locally. Formula strings do not execute; use an offered calculation tool, or explain that submission triggers recalculation.

On a submitted action, read the current values and paths. Update affected results and interpretations coherently; preserve unrelated surfaces, original facts and user edits. Make the acknowledgement visible. Describe unsupported behavior honestly.

Follow the offered tool schema: replacements contain complete data and a root tree; later edits target canonical IDs. Load another enabled skill when it supplies a needed task procedure. Skills never grant execution permission.`),
  skill("plan-my-day", "Use when the user wants to plan a day or organise a to-do list into a schedule.", `
Use the supplied tasks, fixed commitments and time window. Place fixed commitments first, then fit flexible work with realistic duration, travel and breaks. Ask about a missing constraint only when it changes the plan materially. Match the requested detail and show what can move if time runs short.`),
  skill("write-email", "Use when the user wants to write, reply to or improve an email or message.", `
Match the recipient, purpose, tone and requested length. Put the point early, include necessary context and end with a clear next step. Draft by default; sending requires explicit user authorization and an available governed tool. Do not invent recipient details or completed delivery.`),
  skill("summarize", "Use when the user asks to summarise, shorten or get the key points of text, a page, a document or a meeting.", `
Summarize the supplied source at the requested length. Preserve names, numbers, qualifications and disagreements. Include decisions and action items when present, without inventing owners or dates. Distinguish the source's claims from information it does not establish.`),
  skill("explain-simply", "Use when the user asks what something means, how something works, or to explain a topic simply.", `
Answer the specific question in familiar language. Define necessary terms and scale detail to the person's question. Use an example or analogy only when it improves understanding; a short answer need not become a lesson.`),
  skill("compare-options", "Use when the user is choosing between options, products, plans or approaches.", `
Compare the supplied options against the person's priorities, preserving facts and units. Use a table when it helps scanning. Ask about missing priorities only when they could change the conclusion. Recommend an option when requested, explaining tradeoffs and separating verified facts from assumptions.`),
  skill("trip-planner", "Use when the user plans a trip, holiday, outing or itinerary.", `
Use the supplied destination, dates, party and constraints. Group nearby activities, allow realistic travel/rest time and offer alternatives where useful. Do not invent a spending level or force a fixed daily format. Distinguish estimates from verified prices, opening times and booking availability; use enabled capabilities when current information is needed.`),
  skill("meal-plan", "Use when the user wants meal ideas, a weekly menu, recipes from what they have, or a shopping list.", `
Respect supplied diet, allergies, servings, equipment, time and cost constraints. Reuse ingredients when helpful and distinguish known ingredients from a proposed shopping list. Ask only about missing constraints that materially affect suitability. Match the requested meal, recipe or planning period instead of always producing a weekly plan.`),
  skill("budget-helper", "Use when the user wants to make a budget, track spending or plan savings.", `
Use the requested purpose, time period, people, currency and supplied amounts. Do not substitute a monthly household budget for a trip, project or other scope. Keep assumptions visible and missing amounts explicit. Show relevant item calculations and requested totals consistently; suggest changes when asked. Use interactive-ui when editable inputs or linked views are useful.`),
  skill("debug-error", "Use when the user shares an error message, stack trace, failing command or code that does not work.", `
Identify the relevant error and use available context to locate its earliest cause. Separate confirmed evidence from hypotheses, propose the smallest supported correction and explain how to verify it. Respect whether the user requested an explanation, investigation or actual changes; avoid unrelated rewrites.`),
  skill("shell-command", "Use when the user wants a terminal, shell, git or command-line command, or asks what a command does.", `
Use the person's known operating system and shell. Give or run the command according to the request and available permissions, explaining non-obvious parts briefly. For destructive operations, make the affected scope clear and use a preview when useful. Do not infer authority to delete, overwrite or publish.`),
  skill("code-review", "Use when the user asks to review, improve or check code.", `
Report actionable findings with location, impact and evidence, prioritized by severity. Focus on correctness, security and maintainability rather than personal style. Include a small correction when useful; do not rewrite unrelated code or turn a review into implementation without authorization. State meaningful verification limits.`),
  skill("commit-message", "Use when the user wants a git commit message, pull request description or changelog entry.", `
Follow the requested or repository's message conventions. Describe the actual final change and why it matters, without invented implementation or test claims. Keep simple changes short; add context and verification when a reviewer needs them. Do not create a commit or publish a request merely because text was requested.`),
];
