// Selection-only evaluation through the same counted provider interceptor used
// by chat. No lexical substitute or instruction-adherence claim.
import type { Provider } from "@vak/providers";
import type { SkillEvalCase, SkillEvalResult } from "../shared/skills.ts";
import type { Skills } from "./skills.ts";

export async function evaluateSkillPrompts(skills: Skills, name: string, cases: SkillEvalCase[], choice?: { provider: Provider; model: string }): Promise<SkillEvalResult[]> {
  if (!skills.view().some(skill => skill.name === name && skill.enabled && !skill.required)) throw new Error("Enable the published optional skill before evaluating selection; unpublished drafts are not active");
  if (!choice?.model.trim()) throw new Error("Choose an available provider and model; no offline heuristic is treated as a model result");
  if (!Array.isArray(cases) || !cases.length || cases.length > 24 || cases.some(item => !item || typeof item.prompt !== "string" || !item.prompt.trim() || item.prompt.length > 8000 || typeof item.expected !== "boolean")) throw new Error("Provide 1–24 bounded prompt cases with explicit expected selection");
  const results: SkillEvalResult[] = [];
  for (const { prompt, expected } of cases) {
    const start = performance.now();
    try {
      const wrapped = skills.provider(choice.provider);
      let tool = "", args = "", complete = false;
      for await (const event of wrapped.stream({ model: choice.model, system: skills.index(), messages: [{ role: "user", content: prompt }], tools: skills.tools().map(tool => tool.spec), maxTokens: 512, signal: AbortSignal.timeout(60_000) })) {
        if (event.type === "tool_start") tool = event.name;
        else if (event.type === "tool_args") args += event.delta;
        else if (event.type === "done") complete = event.stop === "end" || event.stop === "tool_use";
      }
      if (!complete || tool !== "use_skill") throw new Error("The production selector did not return a complete skill selection");
      const selectedSkills = (JSON.parse(args) as { names: string[] }).names;
      results.push({ prompt, expected, passed: selectedSkills.includes(name) === expected, selectedSkills, durationMs: Math.round(performance.now() - start) });
    } catch (err) {
      results.push({ prompt, expected, passed: false, selectedSkills: [], durationMs: Math.round(performance.now() - start), error: (err as Error).message });
    }
  }
  return results;
}
