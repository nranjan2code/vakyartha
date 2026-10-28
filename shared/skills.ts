export interface SkillView {
  name: string; description: string; enabled: boolean; body: string; text: string; builtin?: boolean; required?: boolean;
  update?: { description: string; body: string; compatibility?: string; license?: string; metadata?: Record<string, string>; allowedTools?: string; files?: SkillFile[]; fingerprint: string; currentFingerprint: string };
  source?: { repo: string; path: string; sha: string; addedAt: string };
  /** Reviewed supporting text files stored with the skill; read on demand, never run. */
  files?: SkillFile[];
  /** Files present upstream but outside the current text-only import tier. */
  omitted?: SkillFile[];
  compatibility?: string; license?: string; metadata?: Record<string, string>; allowedTools?: string;
  /** Whether uncommitted working draft edits exist in the studio. */
  hasDraft?: boolean;
}
export type SkillFileStatus = "added" | "script" | "unsupported" | "too-large" | "over-limit" | "not-text";
export interface SkillFile { path: string; bytes: number; status: SkillFileStatus; sha256?: string }
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
  description: string; body: string; compatibility?: string; license?: string; metadata?: Record<string, string>; allowedTools?: string; files: SkillFile[]; fingerprint: string; existing: boolean; blocked?: string;
}

export interface SkillPackageFile {
  path: string;
  text: string;
  bytes: number;
  sha256?: string;
  status: SkillFileStatus;
}

export interface SkillPackageView {
  skill: SkillView;
  files: SkillPackageFile[];
}

export interface SkillDraftResponse {
  package: SkillPackageView;
  hasDraft: boolean;
  draftSavedAt?: string;
}

export interface SkillDraftSaveResponse {
  hasDraft: boolean;
  draftSavedAt: string;
}

export interface SkillGenerateRequest {
  prompt: string;
  provider?: string;
  model?: string;
}

export interface SkillGenerateResponse {
  name: string;
  description: string;
  body: string;
  allowedTools?: string;
  compatibility?: string;
  license?: string;
  metadata?: Record<string, string>;
  files: { path: string; text: string }[];
  rationale?: string;
}

export interface SkillSuggestRequest {
  type: "trigger" | "chart" | "binding" | "tools" | "gist" | "research" | "chaining";
  name?: string;
  description?: string;
  body?: string;
  field?: string;
  query?: string;
}

export interface SkillSuggestResponse {
  suggestion: string;
  rationale: string;
  options?: string[];
}

export interface SkillEvalRequest {
  name: string;
  prompts: string[];
  provider?: string;
  model?: string;
}

export interface SkillEvalResult {
  prompt: string;
  passed: boolean;
  selectedSkills: string[];
  durationMs: number;
  error?: string;
}

export interface SkillSandboxRunRequest {
  scriptSha256: string;
  name: string;
  scriptPath: string;
  args?: string[];
}

export interface SkillSandboxRunResponse {
  scriptPath?: string;
  scriptSha256?: string;
  source?: "saved-draft" | "published";
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}
