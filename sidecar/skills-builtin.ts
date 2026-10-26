// Everyday skills shipped with the app, on at first run. Short bodies keep the
// local model's context small; each step is something it can do in one answer.
const skill = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`;

export const BUILTIN_SKILLS = [
  skill("plan-my-day", "Use when the user wants to plan a day or organise a to-do list into a schedule.", `
1. List the tasks and fixed commitments the user gave; ask once if the day's start and end are unknown.
2. Put fixed commitments first, the hardest task in the first free block, and short tasks together.
3. Add 10-minute breaks every 90 minutes and a buffer before each commitment.
4. Show the plan as a timeline with start and end times, then name what can move if the day slips.`),
  skill("write-email", "Use when the user wants to write, reply to or improve an email or message.", `
1. Identify the recipient, the goal and the tone (formal, friendly, firm). Ask only if the goal is unclear.
2. Write a specific subject line, open with the point, give needed context in short paragraphs, and end with one clear request or next step.
3. Keep it under 150 words unless the user asks for more. Offer one shorter alternative when the tone is sensitive.
4. Never send anything; give the text for the user to copy.`),
  skill("summarize", "Use when the user asks to summarise, shorten or get the key points of text, a page, a document or a meeting.", `
1. Start with a one-sentence summary.
2. Give at most five key points in the source's own terms; keep numbers, names and dates exact.
3. List decisions and action items with owners when the source has them.
4. Say what the source does not cover if the user's question goes beyond it. Never invent details.`),
  skill("explain-simply", "Use when the user asks what something means, how something works, or to explain a topic simply.", `
1. Give a one-sentence answer in plain words.
2. Add an everyday analogy.
3. Explain in three short steps, defining any necessary term the first time it appears.
4. End with one example and, if useful, one common misconception.`),
  skill("compare-options", "Use when the user is choosing between options, products, plans or approaches.", `
1. Name the options and ask for the user's priorities only if they are unknown and matter.
2. Compare them on the four to six criteria that matter most, in a table.
3. Give a recommendation for the user's stated priorities and when another option would be better.
4. Mark facts you are unsure of or that may have changed, such as prices.`),
  skill("trip-planner", "Use when the user plans a trip, holiday, outing or itinerary.", `
1. Confirm destination, dates, party and budget; assume a moderate budget if not given and say so.
2. Plan day by day with morning, afternoon and evening, grouping nearby places to limit travel.
3. Include travel time between places, one rest block per day and a rainy-day alternative.
4. Add a short packing and booking checklist. Note that opening times and prices should be checked.`),
  skill("meal-plan", "Use when the user wants meal ideas, a weekly menu, recipes from what they have, or a shopping list.", `
1. Respect diet, allergies, servings and time limits; ask once if allergies are unknown.
2. Reuse ingredients across meals to reduce waste and cost.
3. Give the plan by day, each meal with prep time.
4. End with a shopping list grouped by store section, leaving out what the user already has.`),
  skill("budget-helper", "Use when the user wants to make a budget, track spending or plan savings.", `
1. Gather monthly income and expenses; group expenses into needs, wants and savings.
2. Show totals and percentages in a table, and the monthly surplus or shortfall.
3. Suggest up to three specific changes with the amount each saves.
4. This is general budgeting help, not investment advice; say so if the user asks what to invest in.`),
  skill("debug-error", "Use when the user shares an error message, stack trace, failing command or code that does not work.", `
1. Quote the line of the error that matters and say what it means in one sentence.
2. List the likely causes, most probable first, each with how to confirm it.
3. Give the smallest fix for the most likely cause, as a code or command block.
4. Say how to verify the fix and what to check next if it does not work.`),
  skill("shell-command", "Use when the user wants a terminal, shell, git or command-line command, or asks what a command does.", `
1. Give the command in a code block, one command per block, for the user's system (assume macOS zsh if unknown).
2. Explain each part briefly.
3. Warn before anything that deletes, overwrites, force-pushes or needs administrator rights, and give a safer preview first (for example a dry run or listing).`),
  skill("code-review", "Use when the user asks to review, improve or check code.", `
1. Say what the code does in one sentence.
2. List problems by severity: bugs and security issues first, then edge cases, then readability. Point at the exact line.
3. Give a corrected snippet for each real bug.
4. Keep style opinions brief and do not rewrite working code without a reason.`),
  skill("commit-message", "Use when the user wants a git commit message, pull request description or changelog entry.", `
1. Write a subject in the imperative mood, under 60 characters, saying what changes.
2. Add a body only when needed: why the change was made and any effect on users, wrapped at 72 characters.
3. For a pull request, add a short summary, the changes as a list and how it was tested.`),
];
