// What a reply sounds like: the prose of a rendered reply, cut into pieces a
// voice provider answers quickly. The first piece is short so speech starts
// almost at once; later pieces are fetched while the one before plays.

const FIRST = 160;
const REST = 420;

/** Text to speak: links and bare addresses are named, not spelled out. */
export function speakable(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/[*_`#>|~]+/g, " ")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

function hardSplit(s: string, max: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > max) {
    const cut = rest.lastIndexOf(" ", max);
    const at = cut > max / 2 ? cut : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Sentence-aligned pieces: the first at most FIRST characters, the rest at most REST. */
export function speechChunks(text: string): string[] {
  const sentences = speakable(text)
    .split(/(?<=[.!?…।])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    const max = out.length ? REST : FIRST;
    if (cur && cur.length + 1 + s.length > max) {
      out.push(cur);
      cur = "";
    }
    const limit = out.length ? REST : FIRST;
    if (s.length > limit) {
      const parts = hardSplit(s, limit);
      out.push(...parts.slice(0, -1));
      cur = parts.at(-1) ?? "";
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}
