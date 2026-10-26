// What a reply sounds like: the prose of a rendered reply and its interfaces
// said the way a person would say them, cut into pieces a voice provider
// answers quickly. The first piece is short so speech starts almost at once;
// later pieces are fetched while the one before plays.

import { byPriority, lowerSurface, type ResolvedNode, type ResolvedSurface } from "@vak/core";

const FIRST = 160;
const REST = 420;
/** A table is summarised after this many rows: nobody listens to a spreadsheet. */
const TABLE_ROWS = 6;

/** The words a voice needs for numbers and the few phrases this file adds, per reply language. */
interface Words { point?: string; percent: string; plus: string; minus: string; to: string; from: string; up: string; down: string; more: (n: number) => string; warning: string; important: string; currency?: Record<string, string> }
const WORDS: Record<string, Words> = {
  en: { point: "point", percent: "percent", plus: "plus", minus: "minus", to: "to", from: "from", up: "up", down: "down", more: (n) => `And ${n} more ${n === 1 ? "row" : "rows"}.`, warning: "Warning", important: "Important", currency: { $: "dollars", "€": "euros", "£": "pounds", "₹": "rupees", "¥": "yen" } },
  fr: { percent: "pour cent", plus: "plus", minus: "moins", to: "à", from: "de", up: "en hausse de", down: "en baisse de", more: (n) => `Et ${n} autre${n === 1 ? " ligne" : "s lignes"}.`, warning: "Attention", important: "Important" },
  de: { percent: "Prozent", plus: "plus", minus: "minus", to: "bis", from: "von", up: "plus", down: "minus", more: (n) => `Und ${n} weitere ${n === 1 ? "Zeile" : "Zeilen"}.`, warning: "Warnung", important: "Wichtig" },
  es: { percent: "por ciento", plus: "más", minus: "menos", to: "a", from: "de", up: "sube", down: "baja", more: (n) => `Y ${n} ${n === 1 ? "fila más" : "filas más"}.`, warning: "Atención", important: "Importante" },
  it: { percent: "percento", plus: "più", minus: "meno", to: "a", from: "da", up: "in rialzo di", down: "in calo di", more: (n) => `E ${n} ${n === 1 ? "altra riga" : "altre righe"}.`, warning: "Attenzione", important: "Importante" },
  pt: { percent: "por cento", plus: "mais", minus: "menos", to: "a", from: "de", up: "alta de", down: "queda de", more: (n) => `E mais ${n} ${n === 1 ? "linha" : "linhas"}.`, warning: "Atenção", important: "Importante" },
  nl: { percent: "procent", plus: "plus", minus: "min", to: "tot", from: "van", up: "plus", down: "min", more: (n) => `En nog ${n} ${n === 1 ? "rij" : "rijen"}.`, warning: "Waarschuwing", important: "Belangrijk" },
};

/** Common short words that mark a Latin-script language; enough to tell a reply's language apart. */
const MARKERS: Record<string, string[]> = {
  en: ["the", "and", "is", "are", "of", "to", "with", "for", "this", "that", "you", "your", "it", "in", "on"],
  fr: ["le", "la", "les", "des", "est", "et", "une", "pour", "avec", "vous", "dans", "sur", "que", "du", "au"],
  de: ["der", "die", "das", "und", "ist", "nicht", "mit", "für", "sie", "ein", "eine", "auf", "den", "zu", "im"],
  es: ["el", "los", "las", "es", "y", "una", "para", "con", "que", "del", "por", "en", "su", "como", "está"],
  it: ["il", "lo", "gli", "è", "e", "una", "per", "con", "che", "del", "della", "non", "sono", "di", "un"],
  pt: ["o", "os", "as", "é", "e", "uma", "para", "com", "que", "do", "da", "não", "em", "um", "você"],
  nl: ["de", "het", "een", "en", "is", "van", "met", "voor", "niet", "dat", "op", "zijn", "je", "u", "ook"],
};

/**
 * The language a reply is written in, when it can be told with confidence: a
 * non-Latin script names itself; Latin text is scored by its common words.
 * Undefined means "not sure", and only language-neutral clean-up applies.
 */
export function textLanguage(text: string): string | undefined {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  if (!letters) return undefined;
  const scripts: [RegExp, string][] = [[/\p{Script=Devanagari}/gu, "hi"], [/\p{Script=Han}/gu, "zh"], [/[\p{Script=Hiragana}\p{Script=Katakana}]/gu, "ja"], [/\p{Script=Arabic}/gu, "ar"], [/\p{Script=Cyrillic}/gu, "ru"], [/\p{Script=Hangul}/gu, "ko"]];
  for (const [re, lang] of scripts) if ((text.match(re)?.length ?? 0) / letters > 0.3) return lang;
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const score = Object.entries(MARKERS).map(([lang, list]) => [lang, words.filter((w) => list.includes(w)).length] as const).sort((a, b) => b[1] - a[1]);
  const [best, second] = score;
  // Three marker words and twice the runner-up: short or mixed text stays unknown.
  return best && best[1] >= 3 && best[1] >= 2 * (second?.[1] ?? 0) ? best[0] : undefined;
}
const ABBREVIATIONS: [RegExp, string][] = [
  [/\be\.g\.,?/gi, "for example,"],
  [/\bi\.e\.,?/gi, "that is,"],
  [/\betc\./gi, "et cetera."],
  [/\bapprox\./gi, "about"],
  [/\bvs\.?(?=\s)/gi, "versus"],
  [/\b([ap])\.m\./gi, (_: string, x: string) => `${x.toUpperCase()}M`] as unknown as [RegExp, string],
  [/\bno\.\s*(?=\d)/gi, "number "],
];

/** "0.39" as a person reads it: "0 point 3 9". Voices pause at a bare dot and read the two halves as separate numbers. */
const decimal = (int: string, frac: string) => `${int} point ${frac.split("").join(" ")}`;

/**
 * Numbers, signs and symbols in the reply's own words, so a voice neither
 * spells nor splits them. Decimals and currency are only rewritten in English:
 * elsewhere a comma is the decimal mark and the voice reads its own format.
 */
function sayNumbers(text: string, w: Words): string {
  let out = text;
  if (w.currency) out = out.replace(/([$€£₹¥])\s?(\d[\d,]*)(?:\.(\d{2}))?\b/g, (_, c: string, n: string, cents?: string) => `${n} ${w.currency![c]}${cents && cents !== "00" ? ` ${cents}` : ""}`);
  out = out
    .replace(/(^|[\s(:])([+−-])(?=\d)/g, (_, pre: string, sign: string) => `${pre}${sign === "+" ? w.plus : w.minus} `)
    .replace(/(\d)\s?[–-]\s?(?=\d)/g, `$1 ${w.to} `)
    .replace(/(\d)\s?%/g, `$1 ${w.percent}`);
  if (w.point) out = out.replace(/(\d[\d,]*)\.(\d+)/g, (_, i: string, f: string) => decimal(i, f));
  return out;
}

/** Text to speak: links named, not spelled; markup and emoji dropped; numbers and symbols said in `lang` when known. */
export function speakable(text: string, lang = textLanguage(text)): string {
  let out = text.normalize("NFC").replace(/https?:\/\/\S+/g, lang === "en" || !lang ? "link" : "");
  const w = lang ? WORDS[lang] : undefined;
  if (lang === "en") for (const [re, to] of ABBREVIATIONS) out = out.replace(re, to as string);
  if (w) out = sayNumbers(out, w);
  return out
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/\s*(?:→|⟶|->)\s*/g, w ? ` ${w.to} ` : ", ")
    .replace(/\s+[—–]\s+|—/g, ", ")
    .replace(/\s&\s/g, lang === "en" ? " and " : " & ")
    .replace(/\s\/\s/g, ", ")
    .replace(/[*_`#>|~[\]]+/g, " ")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/ ([,.;:!?])/g, "$1")
    .trim();
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
/** A line said as one sentence, so the voice pauses where a person would. */
const sentence = (s: string) => (s && !/[.!?…।:]$/.test(s) ? `${s}.` : s);

/** A stat's change, said as a direction when the language is known. */
function delta(d: string, w?: Words): string {
  if (w && /^\+/.test(d)) return `${w.up} ${d.slice(1)}`;
  if (w && /^[-−]/.test(d)) return `${w.down} ${d.slice(1)}`;
  return d;
}

const CONTROLS = new Set(["button", "input", "textarea", "select", "checkbox", "date", "divider", "image"]);

function say(node: ResolvedNode, out: string[], w?: Words): void {
  const p = node.props;
  const put = (...parts: unknown[]) => {
    const s = parts.map(str).filter(Boolean).join(", ");
    if (s) out.push(sentence(s));
  };
  const kids = () => byPriority(node.children).forEach((c) => say(c, out, w));
  // Controls are for the hands, not the ears; a form's own text is still said.
  if (CONTROLS.has(node.type) || node.type.startsWith("$")) return;
  switch (node.type) {
    case "section":
      put(p.title);
      put(p.description);
      return kids();
    case "tabs":
      for (const c of node.children) {
        put(c.props.title ?? c.props.label);
        say(c, out, w);
      }
      return;
    case "card":
      put(p.title, p.subtitle, p.badge);
      put(p.body);
      return kids();
    case "text":
      return put(p.content);
    case "stat":
      return put(p.label, p.value, p.delta ? delta(str(p.delta), w) : "");
    case "table": {
      const cols = (Array.isArray(p.columns) ? p.columns : []) as Record<string, unknown>[];
      const rows = Array.isArray(p.rows) ? p.rows : [];
      const cell = (r: unknown, c: Record<string, unknown>, i: number) => str(Array.isArray(r) ? r[i] : r && typeof r === "object" ? (r as Record<string, unknown>)[str(c.key)] : r);
      for (const r of rows.slice(0, TABLE_ROWS)) {
        const [first, ...rest] = cols.map((c, i) => [str(c.label ?? c.key), cell(r, c, i)] as const);
        if (!first) continue;
        const pairs = rest.filter(([, v]) => v).map(([k, v]) => (k ? `${k} ${v}` : v));
        out.push(sentence(`${first[1]}${pairs.length ? `: ${pairs.join(", ")}` : ""}`));
      }
      if (rows.length > TABLE_ROWS && w) out.push(w.more(rows.length - TABLE_ROWS));
      return;
    }
    case "list":
      (Array.isArray(p.items) ? p.items : []).forEach((item) => put(item));
      return;
    case "chart": {
      const labels = (Array.isArray(p.labels) ? p.labels : []).map(str).filter(Boolean);
      const to = w ? ` ${w.to} ` : " – ";
      const span = labels.length > 1 ? `, ${labels[0]}${to}${labels.at(-1)}` : "";
      for (const s of (Array.isArray(p.series) ? p.series : []) as Record<string, unknown>[]) {
        const values = (Array.isArray(s.values) ? s.values : []).map(str).filter(Boolean);
        if (!values.length) continue;
        const range = values.length > 1 ? `${w ? `${w.from} ` : ""}${values[0]}${to}${values.at(-1)}` : values[0];
        const name = str(s.name) || str(p.title);
        if (name) out.push(sentence(`${name}${span}: ${range}`));
      }
      return;
    }
    case "alert": {
      const tone = str(p.tone);
      const lead = !w ? "" : tone === "warning" ? w.warning : tone === "error" || tone === "danger" ? w.important : "";
      put([lead, str(p.title)].filter(Boolean).join(": "));
      return put(p.body);
    }
    default:
      return kids();
  }
}

/** An interface as speech in `lang`: what it says, not what kind of component it is or which controls it has. */
export function spokenSurface(surface: ResolvedSurface, lang?: string): string {
  const lowered = lowerSurface(surface);
  const out: string[] = [];
  if (lowered.title) out.push(sentence(lowered.title));
  if (lowered.root) say(lowered.root, out, lang ? WORDS[lang] : undefined);
  return out.join("\n");
}

/**
 * The tag a voice is told: the reply's language with this person's region when
 * their Mac uses that language (en → en-GB on a British Mac), else the bare language.
 */
export function speechLocale(lang: string | undefined, preferred: readonly string[] = globalThis.navigator?.languages ?? []): string | undefined {
  if (!lang) return undefined;
  return preferred.find((t) => t.toLowerCase().split("-")[0] === lang && t.includes("-")) ?? lang;
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
export function speechChunks(text: string, lang = textLanguage(text)): string[] {
  const sentences = speakable(text, lang)
    // A dot ends a sentence only before a space, never inside a number.
    .split(/(?<=[.!?…।])\s+|\n+/)
    .map((s) => sentence(s.trim().replace(/[,;]$/, "")))
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
