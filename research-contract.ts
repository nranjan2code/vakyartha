export type ResearchRead = { text: string; retrievedAt: string };
export type ResearchReceipt = { url: string; retrievedAt: string };
export type ResearchSummary = { answer: string; limitations: string };

/** Bounded correction evidence: a source span already present in the attempted
 * quote. This suggests no new claim and never edits the authored output. */
export function matchingExcerpt(quote: string, source: string): string | undefined {
  const attempt = quote.slice(0, 800), text = source.slice(0, 16000), lengths = new Uint16Array(text.length + 1);
  let longest = 0, end = 0;
  for (let i = 0; i < attempt.length; i++) for (let j = text.length; j > 0; j--) {
    lengths[j] = attempt[i] === text[j - 1] ? lengths[j - 1]! + 1 : 0;
    if (lengths[j]! > longest) { longest = lengths[j]!; end = j; }
  }
  const excerpt = text.slice(end - longest, end).trim().slice(0, 240);
  return excerpt.length >= 24 ? excerpt : undefined;
}

/** Explicit authored fields, checked structurally; their meaning still needs review. */
export function parseResearchSummary(value: unknown): ResearchSummary {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2 || !("answer" in value) || !("limitations" in value)) throw new Error("Research data needs answer and limitations fields");
  const { answer, limitations } = value;
  if (typeof answer !== "string" || answer.trim().length < 24 || answer.length > 4000 || typeof limitations !== "string" || limitations.trim().length < 24 || limitations.length > 2000) throw new Error("Research answer and limitations must be substantive bounded text");
  return { answer, limitations };
}

export function parseResearchReceipt(value: unknown): ResearchReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "url" && key !== "retrievedAt") || !("url" in value) || !("retrievedAt" in value) || typeof value.url !== "string" || value.url.length > 2000 || typeof value.retrievedAt !== "string") throw new Error("Invalid research receipt");
  const url = new URL(value.url);
  if (url.protocol !== "https:" || url.username || url.password || !Number.isFinite(Date.parse(value.retrievedAt)) || new Date(value.retrievedAt).toISOString() !== value.retrievedAt) throw new Error("Invalid research receipt URL or timestamp");
  return { url: url.href, retrievedAt: value.retrievedAt };
}
