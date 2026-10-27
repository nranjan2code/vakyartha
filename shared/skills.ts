export interface SkillView {
  name: string; description: string; enabled: boolean; body: string; builtin?: boolean; required?: boolean;
  update?: { description: string; body: string; fingerprint: string; currentFingerprint: string };
  source?: { repo: string; path: string; sha: string; addedAt: string };
}
/** Publisher-owned repositories of SKILL.md folders, checked October 2026. Any other owner/name can be searched too. */
export const SKILL_SOURCES = [
  { repo: "anthropics/skills", name: "Anthropic", description: "Documents, design and development." },
  { repo: "openai/skills", name: "OpenAI", description: "Curated skills catalog." },
  { repo: "google/skills", name: "Google", description: "Cloud and Workspace products." },
  { repo: "microsoft/skills", name: "Microsoft", description: "Azure SDKs and AI Foundry." },
  { repo: "huggingface/skills", name: "Hugging Face", description: "Models, datasets and training." },
  { repo: "vercel-labs/agent-skills", name: "Vercel", description: "Web frameworks and deployment." },
];
export interface SkillListing { repo: string; path: string; name: string; sha: string }
export interface SkillReview extends SkillListing {
  description: string; body: string; extraFiles: string[]; fingerprint: string; existing: boolean; blocked?: string;
}
