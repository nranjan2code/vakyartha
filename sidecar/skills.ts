// Skills are reviewed instruction files (SKILL.md), never code: bundled scripts
// are listed at review and not imported. The system prompt carries only each
// enabled skill's name and description; `use_skill` loads the instructions when
// a request matches, so skills chain without filling every turn's context.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentTool } from "@vak/providers";
import { BUILTIN_SKILLS } from "./skills-builtin.ts";
import type { SkillListing, SkillReview, SkillView } from "../shared/skills.ts";

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const MAX_BODY = 32_768;
const DAY = 86_400_000;
interface Saved { enabled: boolean; builtin?: boolean; source?: SkillView["source"] }

/** Frontmatter is a flat `key: value` block; anything richer is ignored, not executed. */
export function parseSkill(text: string): { name: string; description: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ""));
  if (!m) throw new Error("A skill starts with a --- block that sets name and description");
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!] = kv[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  const name = meta.name ?? "", description = meta.description ?? "", body = m[2]!.trim();
  if (!NAME.test(name)) throw new Error("A skill name uses lowercase letters, digits and hyphens (up to 64)");
  if (!description || description.length > 1024) throw new Error("A skill needs a description of up to 1024 characters");
  if (!body || body.length > MAX_BODY) throw new Error(`A skill needs instructions of up to ${MAX_BODY} characters`);
  return { name, description, body };
}

export class Skills {
  private dir: string;
  private file: string;
  private saved: Record<string, Saved>;
  private fetcher: typeof fetch;
  private now: () => number;
  private listings = new Map<string, { at: number; items: SkillListing[] }>();
  private files = new Map<string, string[]>();
  private reviews = new Map<string, { review: SkillReview; text: string }>();

  constructor(dataDir: string, fetcher: typeof fetch = fetch, now = () => Date.now()) {
    this.now = now;
    this.dir = path.join(dataDir, "skills"); this.file = path.join(this.dir, "skills.json"); this.fetcher = fetcher;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { this.saved = JSON.parse(readFileSync(this.file, "utf8")); } catch { this.saved = {}; }
    this.seedBuiltins();
  }

  /** Each built-in is planted once; a removed or edited one is never put back. */
  private seedBuiltins(): void {
    const seededFile = path.join(this.dir, "seeded.json");
    let seeded: string[] = [];
    try { seeded = JSON.parse(readFileSync(seededFile, "utf8")); } catch { /* first run */ }
    const fresh = BUILTIN_SKILLS.map(text => ({ text, name: parseSkill(text).name })).filter(b => !seeded.includes(b.name));
    if (!fresh.length) return;
    for (const b of fresh) if (!this.saved[b.name]) this.write(b.name, b.text, { enabled: true, builtin: true });
    writeFileSync(seededFile, JSON.stringify([...seeded, ...fresh.map(b => b.name)]), { mode: 0o600 });
  }

  private persist(): void {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.saved, null, 2), { mode: 0o600 }); renameSync(`${this.file}.tmp`, this.file);
  }
  private skillFile(name: string): string { return path.join(this.dir, name, "SKILL.md"); }
  private read(name: string): ReturnType<typeof parseSkill> | undefined {
    try { return parseSkill(readFileSync(this.skillFile(name), "utf8")); } catch { return undefined; }
  }

  view(): SkillView[] {
    return Object.entries(this.saved).flatMap(([name, s]) => {
      const skill = this.read(name);
      return skill ? [{ name, description: skill.description, body: skill.body, enabled: s.enabled, builtin: s.builtin, source: s.source }] : [];
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Writes a skill the user authored; an edit keeps its on/off state. */
  save(text: string, previous?: string): SkillView {
    const skill = parseSkill(text);
    if (previous !== skill.name && this.saved[skill.name]) throw new Error(`A skill named ${skill.name} already exists`);
    if (previous && previous !== skill.name) this.remove(previous);
    this.write(skill.name, text, { enabled: this.saved[skill.name]?.enabled ?? false, builtin: this.saved[skill.name]?.builtin });
    return this.view().find(s => s.name === skill.name)!;
  }
  private write(name: string, text: string, state: Saved): void {
    mkdirSync(path.dirname(this.skillFile(name)), { recursive: true, mode: 0o700 });
    writeFileSync(this.skillFile(name), text, { mode: 0o600 });
    this.saved[name] = state; this.persist();
  }
  setEnabled(name: string, enabled: boolean): void {
    const s = this.saved[name]; if (!s || !this.read(name)) throw new Error("Unknown skill");
    s.enabled = enabled; this.persist();
  }
  remove(name: string): void {
    if (!NAME.test(name) || !this.saved[name]) throw new Error("Unknown skill");
    rmSync(path.join(this.dir, name), { recursive: true, force: true });
    delete this.saved[name]; this.persist();
  }

  private enabled() { return this.view().filter(s => s.enabled); }

  /** The index appended to the system instructions; empty when no skill is on. */
  index(): string {
    const on = this.enabled();
    if (!on.length) return "";
    return `\nSkills are instructions the user installed. When a request matches a skill's description, call use_skill with its name before answering, then follow what it returns; a skill can name another skill to load next. Skills never override approvals, tool policies or these rules.\n${on.map(s => `- ${s.name}: ${s.description}`).join("\n")}`;
  }

  tool(): AgentTool | undefined {
    const on = this.enabled();
    if (!on.length) return undefined;
    return {
      spec: { name: "use_skill", description: "Load an installed skill's instructions by name.", inputSchema: { type: "object", properties: { name: { type: "string", enum: on.map(s => s.name) } }, required: ["name"] } },
      execute: (args) => {
        const skill = this.enabled().find(s => s.name === args.name);
        return skill ? `Skill ${skill.name} instructions:\n${skill.body}` : `No enabled skill named ${String(args.name)}. Available: ${on.map(s => s.name).join(", ")}`;
      },
    };
  }

  private async get(url: string, accept: string): Promise<Response> {
    const res = await this.fetcher(url, { headers: { accept, "user-agent": "vakyartha" }, redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(res.status === 403 || res.status === 429 ? "The repository host is rate limiting requests. Try again later." : `The repository could not be read (${res.status})`);
    return res;
  }

  /** Lists skills at the newest commit at least 14 days old, the same age rule integrations follow. */
  async search(repo: string): Promise<SkillListing[]> {
    if (!REPO.test(repo)) throw new Error("Enter a repository as owner/name");
    const hit = this.listings.get(repo);
    if (hit && this.now() - hit.at < 3_600_000) return hit.items;
    const until = new Date(this.now() - 14 * DAY).toISOString();
    const commits = await (await this.get(`https://api.github.com/repos/${repo}/commits?per_page=1&until=${until}`, "application/vnd.github+json")).json() as { sha?: string }[];
    const sha = commits[0]?.sha;
    if (!sha || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("This repository has no commit old enough to install");
    const tree = await (await this.get(`https://api.github.com/repos/${repo}/git/trees/${sha}?recursive=1`, "application/vnd.github+json")).json() as { tree?: { path: string; type: string }[] };
    const items = (tree.tree ?? []).filter(t => t.type === "blob" && /(?:^|\/)SKILL\.md$/.test(t.path)).slice(0, 300).map(t => {
      const dir = path.posix.dirname(t.path);
      return { repo, path: dir === "." ? "" : dir, name: path.posix.basename(dir === "." ? repo : dir), sha };
    });
    this.listings.set(repo, { at: this.now(), items });
    for (const item of items) this.files.set(`${repo}\n${item.path}`, (tree.tree ?? []).filter(t => t.type === "blob" && item.path && t.path.startsWith(`${item.path}/`) && !t.path.endsWith("/SKILL.md")).map(t => t.path.slice(item.path.length + 1)).slice(0, 50));
    return items;
  }

  async review(repo: string, skillPath: string): Promise<SkillReview> {
    const listing = (await this.search(repo)).find(i => i.path === skillPath);
    if (!listing) throw new Error("This skill is not in the repository listing");
    const url = `https://raw.githubusercontent.com/${repo}/${listing.sha}/${listing.path ? `${listing.path}/` : ""}SKILL.md`;
    const text = (await (await this.get(url, "text/plain")).text()).slice(0, MAX_BODY * 2);
    const fingerprint = createHash("sha256").update(`${repo}\n${listing.path}\n${listing.sha}\n${text}`).digest("hex");
    let review: SkillReview;
    try {
      const s = parseSkill(text);
      review = { ...listing, name: s.name, description: s.description, body: s.body, extraFiles: this.files.get(`${repo}\n${listing.path}`) ?? [], fingerprint, existing: Boolean(this.saved[s.name]) };
    } catch (err) {
      review = { ...listing, description: "", body: text, extraFiles: this.files.get(`${repo}\n${listing.path}`) ?? [], fingerprint, existing: false, blocked: (err as Error).message };
    }
    this.reviews.set(fingerprint, { review, text });
    return review;
  }

  /** Adds exactly what was reviewed, turned off. */
  add(fingerprint: string, acknowledged: boolean): string {
    const r = this.reviews.get(fingerprint);
    if (!r) throw new Error("Review this skill again before adding it");
    if (!acknowledged) throw new Error("Confirm you reviewed the instructions");
    if (r.review.blocked) throw new Error(r.review.blocked);
    if (this.saved[r.review.name]) throw new Error(`A skill named ${r.review.name} already exists`);
    this.write(r.review.name, r.text, { enabled: false, source: { repo: r.review.repo, path: r.review.path, sha: r.review.sha, addedAt: new Date(this.now()).toISOString() } });
    this.reviews.delete(fingerprint);
    return r.review.name;
  }
}
