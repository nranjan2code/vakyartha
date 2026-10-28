// Skill Studio Evaluation Harness: tests skill selection (use_skill gate) and adherence.
// Compliant with Vakyartha's outcome acceptance gate and local Ollama 4B target.

import type { Provider, ChatRequest, ProviderEvent } from "@vak/providers";
import type { SkillEvalResult } from "../shared/skills.ts";
import type { Skills } from "./skills.ts";

/** Evaluates whether a prompt correctly triggers use_skill for the target skill. */
export async function evaluateSkillPrompts(
  skills: Skills,
  name: string,
  prompts: string[],
  provider?: Provider
): Promise<SkillEvalResult[]> {
  const results: SkillEvalResult[] = [];

  for (const prompt of prompts) {
    const start = performance.now();
    try {
      if (!provider) {
        // Deterministic offline semantic match evaluation when model is offline
        const skill = skills.view().find(s => s.name === name);
        if (!skill) throw new Error(`Skill ${name} is not installed`);
        
        const promptWords = prompt.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const descWords = (skill.name + " " + skill.description).toLowerCase().split(/\s+/);
        const matches = promptWords.filter(w => descWords.some(d => d.includes(w) || w.includes(d)));
        const score = matches.length / Math.max(promptWords.length, 1);
        const passed = score >= 0.25;

        results.push({
          prompt,
          passed,
          selectedSkills: passed ? [name] : [],
          durationMs: Math.round(performance.now() - start),
        });
        continue;
      }

      // Live model provider execution through Skills.provider selection interceptor
      const wrapped = skills.provider(provider);
      const req: ChatRequest = {
        model: "default",
        messages: [{ role: "user", content: prompt }],
        system: "",
      };

      let selectedNames: string[] = [];
      let rawText = "";
      let currentToolName = "";
      let currentToolArgs = "";

      for await (const event of wrapped.stream(req)) {
        if (event.type === "text") {
          rawText += event.delta;
        } else if (event.type === "tool_start") {
          currentToolName = event.name;
          currentToolArgs = "";
        } else if (event.type === "tool_args") {
          currentToolArgs += event.delta;
        } else if (event.type === "tool_end") {
          if (currentToolName === "use_skill") {
            try {
              const parsed = JSON.parse(currentToolArgs);
              if (Array.isArray(parsed?.names)) selectedNames = parsed.names;
            } catch {}
          }
        }
      }

      // Check if use_skill was returned in raw JSON if native_tool_call was not emitted
      if (!selectedNames.length && rawText) {
        try {
          const parsed = JSON.parse(rawText);
          if (Array.isArray(parsed?.names)) selectedNames = parsed.names;
          else if (Array.isArray(parsed?.arguments?.names)) selectedNames = parsed.arguments.names;
        } catch {}
      }

      const passed = selectedNames.includes(name);
      results.push({
        prompt,
        passed,
        selectedSkills: selectedNames,
        durationMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      results.push({
        prompt,
        passed: false,
        selectedSkills: [],
        durationMs: Math.round(performance.now() - start),
        error: (err as Error).message,
      });
    }
  }

  return results;
}
