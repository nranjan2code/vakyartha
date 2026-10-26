// External metadata extends the app-owned catalog. Projection remains the sole
// owner of installed state, process lifetime, configuration, secrets and policies.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isIP } from "node:net";
import { pinnedFetch } from "@vak/providers";
import { type CatalogEntry } from "@vak/mcp/client";
import { MARKETPLACES, type MarketplaceId, type MarketplaceListing, type MarketplaceOption, type MarketplacePage, type MarketplaceReview } from "../shared/marketplaces.ts";

const ENDPOINTS: Record<MarketplaceId, string> = {
  mcp: "https://registry.modelcontextprotocol.io/v0.1/servers",
  github: "https://api.mcp.github.com/v0.1/servers",
  docker: "https://desktop.docker.com/mcp/catalog/v2/catalog.json",
};
type ObjectData = Record<string, any>;
const obj = (v: unknown): ObjectData => v && typeof v === "object" && !Array.isArray(v) ? v as ObjectData : {};
const str = (v: unknown, max = 2000): string => typeof v === "string" ? v.slice(0, max) : "";
const arr = (v: unknown): ObjectData[] => Array.isArray(v) ? v.slice(0, 200).map(obj) : [];
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const exact = (v: string) => /^\d+\.\d+\.\d+(?:[-.][\w.]+)?$/.test(v);
const packageName = (v: string) => /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(v);
function publicUrl(v: unknown): string {
  try {
    const u = new URL(str(v));
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.port || /[{}\s]/.test(u.href) ||
      isIP(u.hostname.replace(/^\[|\]$/g, "")) || !u.hostname.includes(".") || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(u.hostname)) return "";
    return u.href;
  } catch { return ""; }
}

function imageUrl(v: unknown): string {
  try {
    const u = new URL(str(v));
    if (u.protocol !== "https:" || u.username || u.password || u.hash || u.port || isIP(u.hostname.replace(/^\[|\]$/g, "")) || !u.hostname.includes(".") || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(u.hostname)) return "";
    return u.href;
  } catch { return ""; }
}
function fields(headers: ObjectData[]): { fields: MarketplaceOption["fields"]; blocked?: string } {
  const out: MarketplaceOption["fields"] = [];
  if (headers.length > 16) return { fields: [], blocked: "This connection declares too many headers." };
  for (const h of headers) {
    const name = str(h.name, 80);
    // Routing/framing headers must never be supplied by catalog metadata.
    if (!/^(?:authorization|x-[a-z0-9-]+|[a-z0-9-]*(?:api-key|apikey|token))$/i.test(name)) return { fields: [], blocked: "This connection requires a header we cannot safely configure yet." };
    const value = str(h.value, 1000);
    let format = name.toLowerCase() === "authorization" ? "Bearer {value}" : "{value}";
    if (value) {
      if (!/^(?:Bearer )?\$?\{[\w-]+\}$/i.test(value)) return { fields: [], blocked: "Fixed or compound header values require manual configuration." };
      format = value.replace(/\$?\{[\w-]+\}/, "{value}");
    }
    out.push({ key: `credential${out.length}`, label: name.toLowerCase() === "authorization" ? "Authorization header" : name, required: h.isRequired === true, help: `${str(h.description, 400)}${name.toLowerCase() === "authorization" && format === "Bearer {value}" ? " Enter only the token; the Bearer prefix is added for you." : ""}`, header: { name, format } });
  }
  if (new Set(out.map(f => f.header!.name.toLowerCase())).size !== out.length) return { fields: [], blocked: "Duplicate credential headers require manual configuration." };
  return { fields: out };
}
export function normalizeListings(source: MarketplaceId, data: unknown): MarketplaceListing[] {
  const root = obj(data);
  if (source !== "docker" && !Array.isArray(root.servers)) throw new Error("The catalog returned an unsupported response. Try again later.");
  if (source === "docker" && (!root.registry || typeof root.registry !== "object" || Array.isArray(root.registry))) throw new Error("The catalog returned an unsupported response. Try again later.");
  const entries = source === "docker" ? Object.entries(obj(root.registry)).slice(0, 3000).map(([name, v]) => {
    const d = obj(v), remote = obj(d.remote);
    return { server: { name, title: d.title, description: d.description, version: str(d.image) || "hosted", repository: { url: d.upstream || d.source }, publisher: obj(d.metadata).owner,
      remotes: remote.url ? [{ type: remote.transport_type, url: remote.url, headers: Object.entries(obj(remote.headers)).map(([name, value]) => ({ name, value, isRequired: true })) }] : [],
      icons: d.icon ? [{ src: d.icon }] : [], container: d.image, oauth: Object.keys(obj(d.oauth)).length > 0 }, _meta: {} };
  }) : arr(root.servers);
  const seen = new Set<string>();
  return entries.flatMap((e) => {
    const s = obj(e.server), name = str(s.name, 240), version = str(s.version, 240);
    const meta = obj(obj(e._meta)["io.modelcontextprotocol.registry/official"]);
    if (!name || meta.status && meta.status !== "active" || seen.has(name)) return [];
    seen.add(name);
    const options: MarketplaceOption[] = [];
    for (const [index, r] of arr(s.remotes).entries()) {
      const url = publicUrl(r.url), auth = fields(arr(r.headers));
      let blocked = r.type !== "streamable-http" ? "This transport is not supported yet." : !url ? "This endpoint needs manual setup; only fixed public HTTPS URLs are supported." : auth.blocked;
      if (/\b(?:server\.smithery\.ai|[\w.-]+\.run\.tools)\b/.test(url)) blocked = "This proxy is being retired. Use the publisher's direct endpoint.";
      if (s.oauth) blocked = "This connection requires browser sign-in, which is not supported yet.";
      options.push({ key: `remote-${index}`, label: "Hosted connection", kind: "http", url, ...auth, blocked });
    }
    for (const [index, p] of arr(s.packages).entries()) {
      const pkg = str(p.identifier, 200), pv = str(p.version, 100);
      if (p.registryType !== "npm") { options.push({ key: `package-${index}`, label: `${str(p.registryType, 30) || "Other"} package`, kind: "unsupported", fields: [], blocked: "This package runtime is not supported. Check for a hosted connection or an entry in our catalog." }); continue; }
      let blocked = !packageName(pkg) || !exact(pv) || p.registryBaseUrl && p.registryBaseUrl !== "https://registry.npmjs.org" ? "A package from the public npm registry with an exact version is required." : undefined;
      if (obj(p.transport).type !== "stdio" || arr(p.packageArguments).length || arr(p.runtimeArguments).length) blocked = "This package needs custom launch arguments. Use a reviewed entry in our catalog.";
      const fs: MarketplaceOption["fields"] = [];
      for (const env of arr(p.environmentVariables)) {
        const en = str(env.name, 100);
        if (!/^[A-Z][A-Z0-9_]*$/.test(en) || /^(?:PATH|HOME|TMPDIR|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*)$/.test(en) || env.value || env.variables) { blocked = "This package needs environment configuration we cannot safely import yet."; break; }
        fs.push({ key: `credential${fs.length}`, label: en, env: en, required: env.isRequired === true, help: str(env.description, 400) });
      }
      options.push({ key: `package-${index}`, label: "Local npm package", kind: "npm", package: pkg, version: pv, fields: fs, blocked });
    }
    if (s.container) options.push({ key: "container", label: "Container", kind: "unsupported", fields: [], blocked: "Requires a separately managed container runtime. Configure it there, then connect its HTTP gateway using Add your own server." });
    if (!options.length) options.push({ key: "unavailable", label: "Manual setup", kind: "unsupported", fields: [], blocked: "No supported connection details were published." });
    return [{ key: hash([source, name, version]).slice(0, 32), source, name, title: str(s.title, 120) || name, description: str(s.description), version, publisher: str(s.publisher, 100) || name.split("/")[0]!, homepage: publicUrl(s.websiteUrl) || publicUrl(obj(s.repository).url) || MARKETPLACES.find(x => x.id === source)!.homepage, repository: publicUrl(obj(s.repository).url), publishedAt: str(meta.publishedAt, 80) || undefined, iconUrl: arr(s.icons).map(i => imageUrl(i.src)).find(Boolean) || imageUrl(obj(obj(obj(s._meta)["io.modelcontextprotocol.registry/publisher-provided"]).github).ownerAvatarUrl) || undefined, options }];
  });
}

interface Imported { listing: MarketplaceListing; option: MarketplaceOption; bin?: string; id: string; addedAt: string }
export class Marketplaces {
  readonly catalog: CatalogEntry[];
  private imports: Imported[] = [];
  private file: string;
  private cacheDir: string;
  private pages = new Map<string, MarketplacePage>();
  private pending = new Map<string, Promise<MarketplacePage>>();
  private reviews = new Map<string, { review: MarketplaceReview; expires: number }>();
  private fetcher: typeof fetch;
  private loadError?: string;
  private imageFetcher: typeof pinnedFetch;
  private iconCache = new Map<string, { bytes: Buffer; type: string }>();
  private iconPending = new Map<string, Promise<{ bytes: Buffer; type: string }>>();
  constructor(dataDir: string, catalog: CatalogEntry[], fetcher: typeof fetch = fetch, imageFetcher = pinnedFetch) {
    this.catalog = [...catalog]; this.fetcher = fetcher; this.imageFetcher = imageFetcher;
    this.file = path.join(dataDir, "external-catalog.json"); this.cacheDir = path.join(dataDir, "catalog-cache");
    mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
    if (existsSync(this.file)) try {
      // Imported definitions are app catalog data, never framework installed state.
      const stored: Imported[] = JSON.parse(readFileSync(this.file, "utf8"));
      if (!Array.isArray(stored) || stored.length > 300) throw new Error("Invalid external catalog file");
      const entries = stored.map(record => this.toEntry(record));
      const ids = [...this.catalog, ...entries].map(e => e.id);
      if (new Set(ids).size !== ids.length) throw new Error("Duplicate external catalog entry");
      this.imports = stored; this.catalog.push(...entries);
    } catch {
      // Keep the rest of the app usable, and never overwrite damaged definitions.
      this.loadError = "Saved external catalog definitions could not be read. Restore external-catalog.json from a backup before adding servers. Other integrations remain available.";
    }
  }

  private save(): void {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.imports, null, 2), { mode: 0o600 }); renameSync(`${this.file}.tmp`, this.file);
  }
  private async json(url: string): Promise<unknown> {
    const response = await this.fetcher(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15_000) }).catch((err: Error) => {
      throw err.name === "TimeoutError" ? new Error("This catalog took too long to answer. Its search can be slow; try again, or search another catalog.") : err;
    });
    if (!response.ok) throw new Error(`Catalog request failed (${response.status}). Try again later.`);
    const reader = response.body?.getReader(); if (!reader) throw new Error("Empty catalog response");
    let bytes = 0; const chunks: Uint8Array[] = [];
    try { while (true) { const { value, done } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 8_000_000) throw new Error("Catalog response is too large"); chunks.push(value); } }
    finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  async search(source: MarketplaceId, query = "", cursor = ""): Promise<MarketplacePage> {
    if (!MARKETPLACES.some(s => s.id === source)) throw new Error("Unknown marketplace");
    if (this.loadError) throw new Error(this.loadError);
    if (query.length > 120 || cursor.length > 1000) throw new Error("Search is too long");
    const cacheKey = hash(["icons-v1", source, source === "docker" ? "" : query, source === "docker" ? "" : cursor]);
    const cacheFile = path.join(this.cacheDir, `${cacheKey}.json`);
    let cached = this.pages.get(cacheKey);
    if (!cached && existsSync(cacheFile)) try { cached = JSON.parse(readFileSync(cacheFile, "utf8")); } catch { /* refetch damaged metadata */ }
    let page: MarketplacePage;
    if (cached && Date.now() - Date.parse(cached.fetchedAt) < 3_600_000) page = cached;
    else {
      let pending = this.pending.get(cacheKey);
      if (!pending) {
        pending = (async () => {
          const u = new URL(ENDPOINTS[source]);
          if (source !== "docker") { u.searchParams.set("limit", "24"); u.searchParams.set("version", "latest"); if (query) u.searchParams.set("search", query.split(/\s+/).reduce((a, b) => b.length > a.length ? b : a, "")); if (cursor) u.searchParams.set("cursor", cursor); }
          const data = await this.json(u.href);
          const next = str(obj(obj(data).metadata).nextCursor, 1000);
          const result: MarketplacePage = { source, items: normalizeListings(source, data), nextCursor: next || undefined, fetchedAt: new Date().toISOString(), stale: false };
          this.pages.set(cacheKey, result);
          if (this.pages.size > 64) this.pages.delete(this.pages.keys().next().value!);
          // Cache is disposable metadata; a full disk must not break discovery.
          try {
            writeFileSync(`${cacheFile}.tmp`, JSON.stringify(result), { mode: 0o600 }); renameSync(`${cacheFile}.tmp`, cacheFile);
            const files = readdirSync(this.cacheDir).filter(f => /^[a-f0-9]{64}\.json$/.test(f)).map(f => ({ file: path.join(this.cacheDir, f), at: statSync(path.join(this.cacheDir, f)).mtimeMs })).sort((a,b) => b.at-a.at);
            for (const old of files.slice(64)) unlinkSync(old.file);
          } catch { /* retain the in-memory page */ }
          return result;
        })();
        this.pending.set(cacheKey, pending);
      }
      try { page = await pending; }
      catch (err) { if (!cached) throw err; page = { ...cached, stale: true, warning: "This catalog is unavailable. Showing saved results; adding is disabled until it reconnects." }; }
      finally { this.pending.delete(cacheKey); }
    }
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (i: MarketplaceListing) => { const text = `${i.name} ${i.title} ${i.description} ${i.publisher}`.toLowerCase(); return words.every(w => text.includes(w)) || text.replace(/[\s_-]+/g, "").includes(words.join("")); };
    if (source !== "docker") return words.length > 1 ? { ...page, items: page.items.filter(matches) } : page;
    const filtered = page.items.filter(matches);
    const start = Number(cursor || 0); if (!Number.isSafeInteger(start) || start < 0 || start > 3000) throw new Error("Invalid page");
    return { ...page, items: filtered.slice(start, start + 24), nextCursor: start + 24 < filtered.length ? String(start + 24) : undefined };
  }

  /** Only a source-provided listing icon can be fetched, never a caller's URL. */
  async icon(source: MarketplaceId, query: string, cursor: string, key: string, fetchImage = this.imageFetcher): Promise<{ bytes: Buffer; type: string }> {
    const page = await this.search(source, query, cursor);
    const listing = page.items.find(i => i.key === key);
    if (!listing?.iconUrl) throw new Error("No publisher icon is available");
    return this.loadIcon(listing.iconUrl, fetchImage);
  }
  async importedIcon(id: string): Promise<{ bytes: Buffer; type: string }> {
    const record = this.imports.find(r => r.id === id);
    if (!record?.listing.iconUrl) throw new Error("No publisher icon is available");
    return this.loadIcon(record.listing.iconUrl);
  }
  private async loadIcon(iconUrl: string, fetchImage = this.imageFetcher): Promise<{ bytes: Buffer; type: string }> {
    const cacheKey = hash(iconUrl);
    const cached = this.iconCache.get(cacheKey); if (cached) return cached;
    const pending = this.iconPending.get(cacheKey); if (pending) return pending;
    const load = (async () => {
      let url = iconUrl;
      for (let redirects = 0; redirects < 3; redirects++) {
        if (!imageUrl(url)) throw new Error("Unsupported icon URL");
        const response = await fetchImage(url, { maxBytes: 262_144, signal: AbortSignal.timeout(8000), headers: { accept: "image/png,image/jpeg,image/webp,image/svg+xml" } });
        if ([301,302,303,307,308].includes(response.status)) {
          const location = response.headers.get("location"); if (!location) throw new Error("Missing icon redirect");
          url = new URL(location, url).href; continue;
        }
        if (!response.ok) throw new Error("Publisher icon is unavailable");
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 262_144) throw new Error("Publisher icon is too large");
        const mime = response.headers.get("content-type")?.split(";")[0]?.trim();
        const type = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png"
          : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
          : bytes.subarray(0,4).toString() === "RIFF" && bytes.subarray(8,12).toString() === "WEBP" ? "image/webp"
          : mime === "image/svg+xml" && /<svg[\s>]/i.test(bytes.toString("utf8").slice(0,2000)) ? "image/svg+xml" : "";
        if (!type) throw new Error("Unsupported publisher icon format");
        const result = { bytes, type }; this.iconCache.set(cacheKey, result);
        if (this.iconCache.size > 128) this.iconCache.delete(this.iconCache.keys().next().value!);
        return result;
      }
      throw new Error("Too many icon redirects");
    })();
    this.iconPending.set(cacheKey, load);
    try { return await load; } finally { this.iconPending.delete(cacheKey); }
  }
  private existing(option: MarketplaceOption): string | undefined {
    return this.catalog.find(e => option.kind === "npm" && e.source.kind === "npm" && e.source.package === option.package || option.kind === "http" && e.source.kind === "http" && typeof e.source.url === "string" && e.source.url.replace(/\/$/, "") === option.url?.replace(/\/$/, ""))?.id;
  }
  async review(source: MarketplaceId, query: string, cursor: string, key: string, optionKey: string): Promise<MarketplaceReview> {
    const page = await this.search(source, query, cursor);
    if (page.stale) throw new Error("Reconnect to the catalog before adding a server.");
    const listing = page.items.find(x => x.key === key); const option = listing?.options.find(x => x.key === optionKey);
    if (!listing || !option) throw new Error("This listing changed. Search again.");
    const result: MarketplaceReview = { listing, option, existingId: this.existing(option), blocked: option.blocked, fingerprint: "" };
    if (!result.blocked && !result.existingId && option.kind === "npm") {
      if (!listing.repository) result.blocked = "A source repository is required before this package can be reviewed.";
      else {
        const doc = obj(await this.json(`https://registry.npmjs.org/${encodeURIComponent(option.package!)}`));
        const version = obj(obj(doc.versions)[option.version!]);
        result.publishedAt = str(obj(doc.time)[option.version!], 80);
        if (version.name !== option.package || version.version !== option.version || !result.publishedAt || !Number.isFinite(Date.parse(result.publishedAt)) || Date.now() - Date.parse(result.publishedAt) < 14 * 86_400_000) result.blocked = "This exact package version has not been verified as at least 14 days old. Choose a reviewed entry or check back later.";
        const bins = typeof version.bin === "string" ? [version.bin] : Object.values(obj(version.bin));
        const bin = bins.length === 1 ? str(bins[0], 240).replace(/^\.\//, "") : "";
        if (!bin || bin.split("/").some(p => !p || p === "." || p === "..") || !/^[\w./-]+\.(?:[cm]?js)$/.test(bin)) result.blocked = "This package does not declare one supported JavaScript entry point.";
        result.bin = bin;
        result.dependencies = Object.fromEntries(Object.entries(obj(version.dependencies)).slice(0, 150).map(([k,v]) => [str(k,200), str(v,100)]));
        result.scripts = Object.keys(obj(version.scripts)).slice(0, 50);
      }
    }
    result.fingerprint = hash(result);
    this.reviews.set(result.fingerprint, { review: result, expires: Date.now() + 10 * 60_000 });
    if (this.reviews.size > 100) this.reviews.delete(this.reviews.keys().next().value!);
    return result;
  }
  add(fingerprint: string, acknowledged: boolean): string {
    if (this.loadError) throw new Error(this.loadError);
    const saved = this.reviews.get(fingerprint);
    if (!saved || saved.expires < Date.now()) throw new Error("This review expired. Review the connection again.");
    const r = saved.review;
    if (r.existingId) return r.existingId;
    const existing = this.existing(r.option); if (existing) return existing;
    if (r.blocked || r.option.blocked || r.option.kind === "unsupported") throw new Error(r.blocked || r.option.blocked || "Unsupported connection");
    if (acknowledged !== true) throw new Error("Review and acknowledge access and possible costs first.");
    if (this.imports.length >= 300) throw new Error("Remove unused external integrations before adding more.");
    const id = `external-${hash([r.option.kind, r.option.url || r.option.package]).slice(0, 24)}`;
    const record: Imported = { listing: r.listing, option: r.option, bin: r.bin, id, addedAt: new Date().toISOString() };
    const entry = this.toEntry(record);
    this.imports.push(record);
    try { this.save(); } catch (err) { this.imports.pop(); throw err; }
    this.catalog.push(entry);
    return id;
  }
  remove(id: string): void {
    if (!this.imports.some(r => r.id === id)) return;
    const previous = this.imports; this.imports = this.imports.filter(r => r.id !== id);
    try { this.save(); } catch(err) { this.imports = previous; throw err; }
    const index = this.catalog.findIndex(e => e.id === id); if (index >= 0) this.catalog.splice(index, 1);
  }
  provenance(id: string): { source: string; name: string; version: string; addedAt: string; icon: boolean } | undefined {
    const r = this.imports.find(r => r.id === id);
    return r ? { source: MARKETPLACES.find(s => s.id === r.listing.source)!.name, name: r.listing.name, version: r.listing.version, addedAt: r.addedAt, icon: Boolean(r.listing.iconUrl) } : undefined;
  }
  private toEntry(r: Imported): CatalogEntry {
    const { listing: l, option: o } = r;
    if (!/^external-[a-f0-9]{24}$/.test(r.id) || !MARKETPLACES.some(s => s.id === l.source) || o.blocked || o.fields.length > 32) throw new Error("Invalid imported catalog entry");
    let source: CatalogEntry["source"];
    if (o.kind === "http" && publicUrl(o.url)) source = { kind: "http", url: o.url! };
    else if (o.kind === "npm" && packageName(o.package!) && exact(o.version!) && r.bin && /^[\w./-]+\.[cm]?js$/.test(r.bin) && !r.bin.split("/").includes("..")) source = { kind: "npm", package: o.package!, version: o.version!, bin: r.bin };
    else throw new Error("Invalid imported connection");
    return { id: r.id, name: l.title, publisher: l.publisher, trust: "custom", icon: "plug", summary: l.description.slice(0, 200),
      description: `${l.description}\nAdded from ${MARKETPLACES.find(s => s.id === l.source)!.name} (${l.name}, ${l.version}). Vakyartha has not reviewed this server. Remote services may require an account or paid plan; browser sign-in is not supported.`,
      homepage: publicUrl(l.repository) || publicUrl(l.homepage), access: [source.kind === "http" ? `Tool inputs go to ${new URL(o.url!).host}. Hosted behavior may change without a version update.` : `Runs ${o.package}@${o.version} locally with its declared environment only. This is not an operating-system sandbox.`, "Service costs are unknown; check the publisher's terms.", "Every tool asks until you change its policy."], source,
      config: o.fields.map(f => ({ ...f, kind: "secret" as const })),
    };
  }
}
