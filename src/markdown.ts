// High-craft, safe markdown → DOM renderer for app prose.
// Builds DOM nodes directly (never innerHTML for untrusted content), so model
// text cannot inject markup. Covers everything models emit: headings (h1-h6),
// paragraphs, bold, italic, strikethrough, links, inline code, fenced code blocks
// with language badges, copy buttons & token syntax highlighting, GFM pipe tables,
// blockquotes, GitHub-style alerts/callouts, task lists, and MathML math.

import { texToMathML } from "@vak/web";
import { icon } from "./icons.ts";

const SAFE_URL = /^(https?:|mailto:|\/|#|\.\/)/i;

const LANG_LABELS: Record<string, string> = {
  ts: "TypeScript",
  typescript: "TypeScript",
  tsx: "TypeScript (TSX)",
  js: "JavaScript",
  javascript: "JavaScript",
  jsx: "JavaScript (JSX)",
  py: "Python",
  python: "Python",
  rust: "Rust",
  rs: "Rust",
  sh: "Bash",
  bash: "Bash",
  zsh: "Zsh",
  shell: "Shell",
  json: "JSON",
  jsonc: "JSON",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  html: "HTML",
  xml: "XML",
  css: "CSS",
  scss: "SCSS",
  sql: "SQL",
  md: "Markdown",
  markdown: "Markdown",
  diff: "Diff",
  dockerfile: "Dockerfile",
  c: "C",
  cpp: "C++",
  go: "Go",
  java: "Java",
  swift: "Swift",
  kotlin: "Kotlin",
};

type CalloutKind = "note" | "tip" | "important" | "warning" | "caution";

const CALLOUT_TITLES: Record<CalloutKind, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};

const CALLOUT_ICONS: Record<CalloutKind, string> = {
  note: "info",
  tip: "tip",
  important: "important",
  warning: "warning",
  caution: "caution",
};

/** Lightweight tokenizer for syntax highlighting within pre blocks. */
function highlightCode(code: string, lang: string, doc: Document): Node[] {
  const norm = lang.toLowerCase();
  if (!norm || norm === "text" || norm === "plain" || norm === "txt") {
    return [doc.createTextNode(code)];
  }

  // Keywords by language category
  let kw = "";
  if (/^(js|javascript|ts|typescript|jsx|tsx)$/.test(norm)) {
    kw = "async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|false|finally|for|function|if|implements|import|in|instanceof|interface|let|new|null|package|private|protected|public|return|static|super|switch|this|throw|true|try|typeof|var|void|while|with|yield|type|as|from|readonly|of";
  } else if (/^(py|python)$/.test(norm)) {
    kw = "and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield";
  } else if (/^(rs|rust)$/.test(norm)) {
    kw = "as|async|await|break|const|continue|crate|dyn|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|unsafe|use|where|while";
  } else if (/^(sh|bash|zsh|shell)$/.test(norm)) {
    kw = "if|then|else|elif|fi|case|esac|for|select|while|until|do|done|in|function|time|return|exit|export|local|echo|set|unset|source";
  } else if (norm === "sql") {
    kw = "SELECT|FROM|WHERE|INSERT|INTO|UPDATE|DELETE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|AS|AND|OR|NOT|IN|IS|NULL|CREATE|TABLE|DROP|ALTER|PRIMARY|KEY|DEFAULT|UNION|ALL|CASE|WHEN|THEN|ELSE|END";
  } else if (/^(json|jsonc)$/.test(norm)) {
    kw = "true|false|null";
  }

  // Token definition regex
  // 1: comment, 2: string, 3: number, 4: keyword, 5: function, 6: type
  const patterns: string[] = [
    // Comments
    norm === "html" || norm === "xml"
      ? "(<!--[\\s\\S]*?-->)"
      : /^(py|python|sh|bash|zsh|yaml|yml)$/.test(norm)
      ? "(#.*)"
      : norm === "sql"
      ? "(--.*|/\\*[\\s\\S]*?\\*/)"
      : "(//.*|/\\*[\\s\\S]*?\\*/)",
    // Strings
    norm === "sql"
      ? "('(?:[^'\\\\]|\\\\.)*')|(\"(?:[^\"\\\\]|\\\\.)*\")"
      : "(\"(?:[^\"\\\\]|\\\\.)*\")|('(?:[^'\\\\]|\\\\.)*')|(`(?:[^`\\\\]|\\\\.)*`)",
    // Numbers
    "\\b(0x[0-9a-fA-F]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b",
  ];

  if (kw) patterns.push(`\\b(${kw})\\b`);
  patterns.push("([a-zA-Z_$][a-zA-Z0-9_$]*)(?=\\s*\\()");
  patterns.push("\\b([A-Z][a-zA-Z0-9_$]*)\\b");

  const combined = new RegExp(patterns.join("|"), norm === "sql" ? "gi" : "g");
  const nodes: Node[] = [];
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = combined.exec(code))) {
    if (m.index > last) {
      nodes.push(doc.createTextNode(code.slice(last, m.index)));
    }
    const text = m[0];
    const span = doc.createElement("span");
    span.textContent = text;

    if (text.startsWith("//") || text.startsWith("/*") || text.startsWith("#") || text.startsWith("--") || text.startsWith("<!--")) {
      span.className = "tok-cmt";
    } else if (text.startsWith('"') || text.startsWith("'") || text.startsWith("`")) {
      span.className = "tok-str";
    } else if (/^(0x[0-9a-fA-F]+|\d)/.test(text)) {
      span.className = "tok-num";
    } else if (kw && new RegExp(`^(?:${kw})$`, norm === "sql" ? "i" : "").test(text)) {
      span.className = "tok-kw";
    } else if (code[m.index + text.length] === "(" || /^\s*\(/.test(code.slice(m.index + text.length))) {
      span.className = "tok-fn";
    } else if (/^[A-Z]/.test(text)) {
      span.className = "tok-type";
    }
    nodes.push(span);
    last = combined.lastIndex;
  }

  if (last < code.length) {
    nodes.push(doc.createTextNode(code.slice(last)));
  }
  return nodes;
}

/** Parses inline markdown elements into DOM nodes. */
function inline(text: string, doc: Document): Node[] {
  const out: Node[] = [];
  // Order: code first, then math, then bold/italic/del, then links
  const re = /`([^`]+)`|\$\$([^\$]+)\$\$|\$([^\$\n]+?)\$|\*\*\*([^*]+)\*\*\*|___([^_]+)___|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text))) {
    if (m.index > last) out.push(doc.createTextNode(text.slice(last, m.index)));

    if (m[1] !== undefined) {
      // Inline code
      const el = doc.createElement("code");
      el.textContent = m[1];
      out.push(el);
    } else if (m[2] !== undefined || m[3] !== undefined) {
      // Math: $math$ or $$math$$
      const formula = m[2] ?? m[3]!;
      // Guard against pure currency like $10 or $24.50
      if (/^\s*\d+(?:\.\d+)?\s*$/.test(formula)) {
        out.push(doc.createTextNode(`$${formula}$`));
      } else {
        try {
          const math = texToMathML(formula, Boolean(m[2]), doc);
          out.push(math);
        } catch {
          const code = doc.createElement("code");
          code.className = "math-inline";
          code.textContent = formula;
          out.push(code);
        }
      }
    } else if (m[4] !== undefined || m[5] !== undefined) {
      // Bold + Italic
      const strong = doc.createElement("strong");
      const em = doc.createElement("em");
      em.append(...inline(m[4] ?? m[5]!, doc));
      strong.append(em);
      out.push(strong);
    } else if (m[6] !== undefined || m[7] !== undefined) {
      // Bold
      const el = doc.createElement("strong");
      el.append(...inline(m[6] ?? m[7]!, doc));
      out.push(el);
    } else if (m[8] !== undefined) {
      // Strikethrough
      const el = doc.createElement("del");
      el.append(...inline(m[8], doc));
      out.push(el);
    } else if (m[9] !== undefined || m[10] !== undefined) {
      // Italic
      const el = doc.createElement("em");
      el.append(...inline(m[9] ?? m[10]!, doc));
      out.push(el);
    } else if (m[11] !== undefined) {
      // Link
      const href = m[12]!;
      if (SAFE_URL.test(href)) {
        const a = doc.createElement("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.append(...inline(m[11], doc));
        out.push(a);
      } else {
        out.push(doc.createTextNode(m[11]));
      }
    }
    last = re.lastIndex;
  }

  if (last < text.length) out.push(doc.createTextNode(text.slice(last)));
  return out;
}

/** Parses pipe table lines into a styled table container. */
function parseTable(lines: string[], startIndex: number, doc: Document): { element: HTMLElement; nextIndex: number } | null {
  const headerLine = lines[startIndex]?.trim();
  const delimiterLine = lines[startIndex + 1]?.trim();
  if (!headerLine || !delimiterLine) return null;

  // Header must start and end with pipe or contain at least one pipe
  if (!headerLine.includes("|") || !delimiterLine.includes("|")) return null;

  // Delimiter must consist of :---, :---:, ---:, or --- separated by pipes
  const delimiterCells = delimiterLine.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  if (!delimiterCells.length || !delimiterCells.every((c) => /^:?-+:?$/.test(c))) return null;

  const headerCells = headerLine.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  if (headerCells.length !== delimiterCells.length) return null;

  const alignments = delimiterCells.map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });

  const wrap = doc.createElement("div");
  wrap.className = "table-wrap";
  const table = doc.createElement("table");
  const thead = doc.createElement("thead");
  const trHead = doc.createElement("tr");

  headerCells.forEach((cellText, idx) => {
    const th = doc.createElement("th");
    const align = alignments[idx] ?? "left";
    th.style.textAlign = align;
    th.append(...inline(cellText, doc));
    trHead.append(th);
  });
  thead.append(trHead);
  table.append(thead);

  const tbody = doc.createElement("tbody");
  let i = startIndex + 2;
  for (; i < lines.length; i++) {
    const rowLine = lines[i]?.trim();
    if (!rowLine || !rowLine.includes("|")) break;
    const cells = rowLine.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    const tr = doc.createElement("tr");
    for (let c = 0; c < headerCells.length; c++) {
      const td = doc.createElement("td");
      const align = alignments[c] ?? "left";
      td.style.textAlign = align;
      td.append(...inline(cells[c] ?? "", doc));
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);
  return { element: wrap, nextIndex: i - 1 };
}

/** Builds an interactive code block with language badge and copy action. */
function createCodeBlock(codeText: string, lang: string, doc: Document): HTMLElement {
  const container = doc.createElement("div");
  container.className = "code-block";
  if (lang) container.dataset.lang = lang;

  const header = doc.createElement("div");
  header.className = "code-header";

  const langSpan = doc.createElement("span");
  langSpan.className = "code-lang";
  langSpan.textContent = LANG_LABELS[lang.toLowerCase()] ?? (lang ? lang.toUpperCase() : "CODE");
  header.append(langSpan);

  const copyBtn = doc.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "code-copy-btn";
  copyBtn.title = "Copy code";
  copyBtn.setAttribute("aria-label", "Copy code");

  try {
    copyBtn.append(icon("copy", 13, doc));
  } catch {
    // If icons are unavailable in headless test environment
  }
  const label = doc.createElement("span");
  label.className = "copy-label";
  label.textContent = "Copy";
  copyBtn.append(label);

  copyBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(codeText);
      }
      copyBtn.classList.add("copied");
      label.textContent = "Copied!";
      setTimeout(() => {
        copyBtn.classList.remove("copied");
        label.textContent = "Copy";
      }, 1800);
    } catch {
      // Graceful fallback
    }
  });

  header.append(copyBtn);
  container.append(header);

  const pre = doc.createElement("pre");
  const codeEl = doc.createElement("code");
  if (lang) codeEl.className = `language-${lang}`;
  codeEl.append(...highlightCode(codeText, lang, doc));
  pre.append(codeEl);
  container.append(pre);

  return container;
}

/** Builds a GitHub-style alert callout container. */
function createCallout(kind: CalloutKind, lines: string[], doc: Document): HTMLElement {
  const box = doc.createElement("div");
  box.className = `callout callout-${kind}`;
  box.setAttribute("role", "region");
  box.setAttribute("aria-label", CALLOUT_TITLES[kind]);

  const header = doc.createElement("div");
  header.className = "callout-header";

  try {
    const iconEl = icon(CALLOUT_ICONS[kind], 14, doc);
    header.append(iconEl);
  } catch {
    // Headless test fallback
  }

  const title = doc.createElement("span");
  title.className = "callout-title";
  title.textContent = CALLOUT_TITLES[kind];
  header.append(title);
  box.append(header);

  const body = doc.createElement("div");
  body.className = "callout-body";

  let para: string[] = [];
  const flush = () => {
    if (!para.length) return;
    const p = doc.createElement("p");
    para.forEach((line, i) => {
      if (i) p.append(doc.createElement("br"));
      p.append(...inline(line, doc));
    });
    body.append(p);
    para = [];
  };

  for (const l of lines) {
    if (!l.trim()) {
      flush();
    } else {
      para.push(l);
    }
  }
  flush();
  box.append(body);
  return box;
}

/** Primary markdown-to-DOM parser for the application. */
export function renderMarkdown(src: string, doc: Document = typeof document !== "undefined" ? document : (globalThis as unknown as { document: Document }).document): DocumentFragment {
  const frag = doc.createDocumentFragment();
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  let list: HTMLElement | null = null;

  const flushPara = () => {
    if (!para.length) return;
    const p = doc.createElement("p");
    para.forEach((line, i) => {
      if (i) p.append(doc.createElement("br"));
      p.append(...inline(line, doc));
    });
    frag.append(p);
    para = [];
  };

  const closeList = () => {
    if (list) frag.append(list);
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Fenced code block or display math block
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      flushPara();
      closeList();
      const lang = fence[1] ?? "";
      const codeLines: string[] = [];
      while (++i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        codeLines.push(lines[i]!);
      }
      const rawCode = codeLines.join("\n");

      if (lang.toLowerCase() === "math") {
        try {
          const mathBlock = doc.createElement("div");
          mathBlock.className = "math-block";
          mathBlock.append(texToMathML(rawCode, true, doc));
          frag.append(mathBlock);
        } catch {
          frag.append(createCodeBlock(rawCode, "math", doc));
        }
      } else {
        frag.append(createCodeBlock(rawCode, lang, doc));
      }
      continue;
    }

    // Display math block: $$ ... $$
    const mathDisplayStart = /^\$\$\s*(.*)$/.exec(line);
    if (mathDisplayStart) {
      flushPara();
      closeList();
      const mathLines: string[] = [];
      if (mathDisplayStart[1]?.endsWith("$$") && mathDisplayStart[1].length > 2) {
        mathLines.push(mathDisplayStart[1].slice(0, -2).trim());
      } else {
        if (mathDisplayStart[1]) mathLines.push(mathDisplayStart[1]);
        while (++i < lines.length && !/^\$\$\s*$/.test(lines[i]!)) {
          mathLines.push(lines[i]!);
        }
      }
      const rawMath = mathLines.join("\n");
      try {
        const mathBlock = doc.createElement("div");
        mathBlock.className = "math-block";
        mathBlock.append(texToMathML(rawMath, true, doc));
        frag.append(mathBlock);
      } catch {
        const pre = doc.createElement("pre");
        pre.className = "math-block";
        pre.textContent = rawMath;
        frag.append(pre);
      }
      continue;
    }

    // Headings: # through ######
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      closeList();
      const level = heading[1]!.length;
      const h = doc.createElement(`h${level}`);
      h.append(...inline(heading[2]!, doc));
      frag.append(h);
      continue;
    }

    // Horizontal Rule: ---, ***, ___
    if (/^(?:[-*_]\s*){3,}$/.test(line.trim())) {
      flushPara();
      closeList();
      frag.append(doc.createElement("hr"));
      continue;
    }

    // GitHub alert or blockquote
    const alertMatch = /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(line);
    if (alertMatch) {
      flushPara();
      closeList();
      const kind = alertMatch[1]!.toLowerCase() as CalloutKind;
      const alertLines: string[] = [];
      if (alertMatch[2]?.trim()) alertLines.push(alertMatch[2].trim());

      while (i + 1 < lines.length && /^>\s*(.*)$/.test(lines[i + 1]!)) {
        i++;
        const content = /^>\s*(.*)$/.exec(lines[i]!)?.[1] ?? "";
        alertLines.push(content);
      }
      frag.append(createCallout(kind, alertLines, doc));
      continue;
    }

    // Standard blockquote
    const quoteMatch = /^>\s?(.*)$/.exec(line);
    if (quoteMatch) {
      flushPara();
      closeList();
      const quoteLines: string[] = [quoteMatch[1]!];
      while (i + 1 < lines.length && /^>\s?(.*)$/.test(lines[i + 1]!)) {
        i++;
        quoteLines.push(/^>\s?(.*)$/.exec(lines[i]!)?.[1] ?? "");
      }
      const bq = doc.createElement("blockquote");
      let bqPara: string[] = [];
      const flushBq = () => {
        if (!bqPara.length) return;
        const p = doc.createElement("p");
        bqPara.forEach((l, idx) => {
          if (idx) p.append(doc.createElement("br"));
          p.append(...inline(l, doc));
        });
        bq.append(p);
        bqPara = [];
      };
      for (const ql of quoteLines) {
        if (!ql.trim()) flushBq();
        else bqPara.push(ql);
      }
      flushBq();
      frag.append(bq);
      continue;
    }

    // GFM Pipe Table check
    if (line.includes("|") && i + 1 < lines.length && lines[i + 1]?.includes("|")) {
      const tableResult = parseTable(lines, i, doc);
      if (tableResult) {
        flushPara();
        closeList();
        frag.append(tableResult.element);
        i = tableResult.nextIndex;
        continue;
      }
    }

    // List item (ordered, unordered, and task lists)
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      const tag = item[2] ? "ol" : "ul";
      if (!list || (list.tagName?.toLowerCase() ?? (list as unknown as { tag?: string }).tag?.toLowerCase()) !== tag) {
        closeList();
        list = doc.createElement(tag);
      }
      const rawText = item[3]!;
      const li = doc.createElement("li");

      // Task list check: - [ ] or - [x]
      const task = /^\[([ xX])\]\s*(.*)$/.exec(rawText);
      if (task) {
        li.className = "task-item";
        list.classList.add("contains-task-list");
        const checkbox = doc.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "task-checkbox";
        checkbox.disabled = true;
        if (task[1]?.toLowerCase() === "x") checkbox.checked = true;
        li.append(checkbox);
        const span = doc.createElement("span");
        span.append(...inline(task[2]!, doc));
        li.append(span);
      } else {
        li.append(...inline(rawText, doc));
      }
      list.append(li);
      continue;
    }

    // Blank line
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }

    // Regular paragraph continuation
    closeList();
    para.push(line);
  }

  flushPara();
  closeList();
  return frag;
}
