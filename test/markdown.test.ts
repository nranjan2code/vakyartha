import assert from "node:assert/strict";
import { test } from "node:test";

// Polyfill DOM globals for testing web modules in Node
class MockElement {
  tag: string;
  attrs: Record<string, string> = {};
  kids: (MockElement | MockText | MockFrag)[] = [];
  className = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  type = "";
  title = "";
  disabled = false;
  checked = false;
  href = "";
  target = "";
  rel = "";
  ownText = "";

  constructor(tag: string) {
    this.tag = tag;
  }

  get tagName(): string {
    return this.tag.toUpperCase();
  }

  get textContent(): string {
    return this.ownText || this.kids.map(textOf).join("");
  }

  set textContent(value: string) {
    this.ownText = value;
    this.kids = [];
  }

  append(...nodes: (MockElement | MockText | MockFrag | string)[]) {
    for (const n of nodes) {
      if (typeof n === "string") this.kids.push(new MockText(n));
      else if (n instanceof MockFrag) this.kids.push(...n.kids);
      else this.kids.push(n);
    }
  }

  addEventListener(_name: string, _handler: unknown): void {}

  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
    if (name === "href") this.href = value;
    if (name === "target") this.target = value;
    if (name === "rel") this.rel = value;
    if (name === "class") this.className = value;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  removeAttribute(name: string) {
    delete this.attrs[name];
  }

  get classList() {
    return {
      add: (...names: string[]) => {
        const set = new Set(this.className.split(" ").filter(Boolean));
        for (const n of names) set.add(n);
        this.className = [...set].join(" ");
      },
      remove: (...names: string[]) => {
        const set = new Set(this.className.split(" ").filter(Boolean));
        for (const n of names) set.delete(n);
        this.className = [...set].join(" ");
      },
      contains: (name: string) => this.className.split(" ").includes(name),
    };
  }

  querySelector(selector: string): MockElement | null {
    return findAll(this, selector)[0] ?? null;
  }

  querySelectorAll(selector: string): MockElement[] {
    return findAll(this, selector);
  }

  get firstElementChild(): MockElement | null {
    for (const k of this.kids) if (k instanceof MockElement) return k;
    return null;
  }

  get childNodes(): (MockElement | MockText)[] {
    return this.kids.filter((k): k is MockElement | MockText => !(k instanceof MockFrag));
  }
}

class MockText {
  data: string;
  constructor(data: string) {
    this.data = data;
  }
  get textContent(): string {
    return this.data;
  }
}

class MockFrag {
  kids: (MockElement | MockText | MockFrag)[] = [];
  append(...nodes: (MockElement | MockText | MockFrag | string)[]) {
    for (const n of nodes) {
      if (typeof n === "string") this.kids.push(new MockText(n));
      else if (n instanceof MockFrag) this.kids.push(...n.kids);
      else this.kids.push(n);
    }
  }
}

function fakeDoc(): Document {
  return {
    createElement: (tag: string) => new MockElement(tag),
    createElementNS: (_ns: string, tag: string) => new MockElement(tag),
    createTextNode: (text: string) => new MockText(text),
    createDocumentFragment: () => new MockFrag(),
  } as unknown as Document;
}

function findAll(root: unknown, selector: string): MockElement[] {
  const out: MockElement[] = [];
  const tag = selector.toLowerCase();
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const el = n as MockElement;
    const classes = (el.className || "").split(" ");
    if (el.tag === tag || (selector.startsWith(".") && classes.includes(selector.slice(1)))) {
      out.push(el);
    }
    for (const k of (el.kids ?? [])) walk(k);
  };
  walk(root);
  return out;
}

function textOf(root: unknown): string {
  if (!root || typeof root !== "object") return "";
  if (root instanceof MockText) return root.data;
  const el = root as MockElement;
  if (el.ownText) return el.ownText;
  return (el.kids ?? []).map(textOf).join("");
}

// Global setup so import of web components succeeds in Node
(globalThis as unknown as { HTMLElement: unknown }).HTMLElement = MockElement;
(globalThis as unknown as { customElements: unknown }).customElements = { define() {} };

const { renderMarkdown } = await import("../src/markdown.ts");

test("markdown: security sanitization strips HTML tags and bad protocols", () => {
  const doc = fakeDoc();
  const frag = renderMarkdown('<script>alert("xss")</script>\n\n<img src=x onerror="alert(1)">\n\n[bad link](javascript:alert(1)) [safe link](https://example.com)', doc);
  assert.equal(findAll(frag, "script").length, 0);
  assert.equal(findAll(frag, "img").length, 0);
  const links = findAll(frag, "a");
  assert.equal(links.length, 1);
  assert.equal(links[0]!.href, "https://example.com");
  assert.equal(links[0]!.rel, "noopener noreferrer");
  assert.equal(links[0]!.target, "_blank");
  assert.match(textOf(frag), /bad link/);
  assert.doesNotMatch(textOf(frag), /javascript:/);
});

test("markdown: headings hierarchy h1 through h6 with inline formatting", () => {
  const doc = fakeDoc();
  const src = "# Heading 1\n## Heading 2 with **bold**\n### Heading 3\n#### Heading 4\n##### Heading 5\n###### Heading 6";
  const frag = renderMarkdown(src, doc);
  assert.equal(findAll(frag, "h1").length, 1);
  assert.equal(findAll(frag, "h2").length, 1);
  assert.equal(findAll(frag, "h3").length, 1);
  assert.equal(findAll(frag, "h4").length, 1);
  assert.equal(findAll(frag, "h5").length, 1);
  assert.equal(findAll(frag, "h6").length, 1);
  const boldInH2 = findAll(findAll(frag, "h2")[0]!, "strong");
  assert.equal(boldInH2.length, 1);
  assert.equal(textOf(boldInH2[0]!), "bold");
});

test("markdown: inline formatting (code, bold, italic, strikethrough, links)", () => {
  const doc = fakeDoc();
  const frag = renderMarkdown("Normal `inline code` and **bold** and *italic* and ~~deleted~~ text.", doc);
  assert.equal(findAll(frag, "code").length, 1);
  assert.equal(findAll(frag, "strong").length, 1);
  assert.equal(findAll(frag, "em").length, 1);
  assert.equal(findAll(frag, "del").length, 1);
  assert.equal(textOf(findAll(frag, "code")[0]!), "inline code");
  assert.equal(textOf(findAll(frag, "strong")[0]!), "bold");
  assert.equal(textOf(findAll(frag, "em")[0]!), "italic");
  assert.equal(textOf(findAll(frag, "del")[0]!), "deleted");
});

test("markdown: fenced code block with language badge, copy action and token highlighting", () => {
  const doc = fakeDoc();
  const code = "```typescript\nasync function hello(name: string): Promise<string> {\n  // greeting\n  const msg = \"Hello \" + name;\n  return msg;\n}\n```";
  const frag = renderMarkdown(code, doc);
  const codeBlock = findAll(frag, ".code-block");
  assert.equal(codeBlock.length, 1);
  assert.equal(codeBlock[0]!.dataset.lang, "typescript");

  const header = findAll(codeBlock[0]!, ".code-header");
  assert.equal(header.length, 1);
  const langSpan = findAll(header[0]!, ".code-lang");
  assert.equal(textOf(langSpan[0]!), "TypeScript");

  const copyBtn = findAll(header[0]!, ".code-copy-btn");
  assert.equal(copyBtn.length, 1);
  assert.equal(copyBtn[0]!.title, "Copy code");

  // Check syntax tokens
  const kw = findAll(codeBlock[0]!, ".tok-kw");
  assert.ok(kw.length >= 3, "Keywords identified");
  const comments = findAll(codeBlock[0]!, ".tok-cmt");
  assert.equal(comments.length, 1);
  assert.match(textOf(comments[0]!), /greeting/);
  const strings = findAll(codeBlock[0]!, ".tok-str");
  assert.equal(strings.length, 1);
  assert.match(textOf(strings[0]!), /Hello/);
});

test("markdown: unclosed code block handles streaming cleanly without error", () => {
  const doc = fakeDoc();
  const partial = "Here is some code:\n```python\ndef compute(x):\n    return x * 2";
  const frag = renderMarkdown(partial, doc);
  const codeBlock = findAll(frag, ".code-block");
  assert.equal(codeBlock.length, 1);
  assert.equal(codeBlock[0]!.dataset.lang, "python");
  assert.match(textOf(codeBlock[0]!), /def compute/);
});

test("markdown: GitHub-style alert callouts (NOTE, TIP, IMPORTANT, WARNING, CAUTION)", () => {
  const doc = fakeDoc();
  const src = `> [!NOTE]
> This is a helpful note with **bold**.

> [!WARNING]
> Proceed with caution!`;

  const frag = renderMarkdown(src, doc);
  const notes = findAll(frag, ".callout-note");
  assert.equal(notes.length, 1);
  assert.match(textOf(notes[0]!), /Note/);
  assert.match(textOf(notes[0]!), /helpful note/);
  assert.equal(findAll(notes[0]!, "strong").length, 1);

  const warnings = findAll(frag, ".callout-warning");
  assert.equal(warnings.length, 1);
  assert.match(textOf(warnings[0]!), /Warning/);
  assert.match(textOf(warnings[0]!), /Proceed with caution/);
});

test("markdown: standard blockquotes", () => {
  const doc = fakeDoc();
  const frag = renderMarkdown("> Simple quote line 1\n> Simple quote line 2", doc);
  const bqs = findAll(frag, "blockquote");
  assert.equal(bqs.length, 1);
  assert.match(textOf(bqs[0]!), /Simple quote line 1/);
  assert.match(textOf(bqs[0]!), /Simple quote line 2/);
});

test("markdown: GFM pipe tables with alignments and cell formatting", () => {
  const doc = fakeDoc();
  const tableMd = `| Method | Path | Status |
| :--- | :---: | ---: |
| GET | \`/api/users\` | **200** |
| POST | \`/api/login\` | 201 |`;

  const frag = renderMarkdown(tableMd, doc);
  const wraps = findAll(frag, ".table-wrap");
  assert.equal(wraps.length, 1);

  const tables = findAll(wraps[0]!, "table");
  assert.equal(tables.length, 1);

  const ths = findAll(tables[0]!, "th");
  assert.equal(ths.length, 3);
  assert.equal(ths[0]!.style.textAlign, "left");
  assert.equal(ths[1]!.style.textAlign, "center");
  assert.equal(ths[2]!.style.textAlign, "right");

  const trs = findAll(tables[0]!, "tr");
  // 1 header row + 2 data rows = 3
  assert.equal(trs.length, 3);

  const strong = findAll(tables[0]!, "strong");
  assert.equal(strong.length, 1);
  assert.equal(textOf(strong[0]!), "200");

  const code = findAll(tables[0]!, "code");
  assert.equal(code.length, 2);
});

test("markdown: task lists with interactive checkboxes and standard lists", () => {
  const doc = fakeDoc();
  const src = `- [ ] Open task
- [x] Completed task
- Normal item`;

  const frag = renderMarkdown(src, doc);
  const ul = findAll(frag, "ul");
  assert.equal(ul.length, 1);
  assert.ok(ul[0]!.className.includes("contains-task-list"));

  const items = findAll(ul[0]!, "li");
  assert.equal(items.length, 3);

  const taskItems = findAll(ul[0]!, ".task-item");
  assert.equal(taskItems.length, 2);

  const checkboxes = findAll(ul[0]!, "input");
  assert.equal(checkboxes.length, 2);
  assert.equal(checkboxes[0]!.checked, false);
  assert.equal(checkboxes[1]!.checked, true);
  assert.equal(checkboxes[0]!.disabled, true);
});

test("markdown: horizontal rules", () => {
  const doc = fakeDoc();
  const frag = renderMarkdown("Paragraph before\n\n---\n\nParagraph after", doc);
  assert.equal(findAll(frag, "hr").length, 1);
  assert.equal(findAll(frag, "p").length, 2);
});

test("markdown: math formatting supports TeX MathML", () => {
  const doc = fakeDoc();
  const frag = renderMarkdown("Euler's formula: $e^{i\\pi} + 1 = 0$", doc);
  const math = findAll(frag, "math");
  assert.ok(math.length >= 1, "Inline math rendered into MathML");
});
