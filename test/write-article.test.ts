import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { basicCatalog, prepareSubmission } from "@vak/core";
import { BUILTIN_PACKAGES } from "../sidecar/skills-builtin.ts";
import { parseSkill } from "../sidecar/skills.ts";

const skillPkg = BUILTIN_PACKAGES.find(p => p.name === "write-article");
const templatesJson = JSON.parse(readFileSync(new URL("../sidecar/builtin-skills/write-article/references/article-surface-templates.json", import.meta.url), "utf8"));
const archetypesMd = readFileSync(new URL("../sidecar/builtin-skills/write-article/references/article-archetypes.md", import.meta.url), "utf8");

test("write-article is registered as a built-in package with references", () => {
  assert.ok(skillPkg, "write-article package must exist in BUILTIN_PACKAGES");
  const parsed = parseSkill(skillPkg.text);
  assert.equal(parsed.name, "write-article");
  assert.ok(parsed.description.includes("long-form articles"));
  assert.deepEqual(Array.from(skillPkg.files.keys()).sort(), [
    "references/article-archetypes.md",
    "references/article-surface-templates.json",
  ]);
  assert.match(archetypesMd, /News Analysis & Investigative Explainer/);
  assert.match(archetypesMd, /Academic \/ Analytical Journal Article/);
  assert.match(archetypesMd, /Feature Story & Narrative Journalism/);
});

test("write-article surface templates validate cleanly with prepareSubmission", () => {
  const admitted = prepareSubmission(basicCatalog, [], templatesJson);
  assert.deepEqual(admitted.issues, []);
  assert.ok(admitted.store);

  // Check Feature & News Analysis template
  const featureSurface = admitted.store.resolve("article-feature-template");
  assert.ok(featureSurface, "article-feature-template must resolve");
  assert.equal(featureSurface.title, "Feature & News Analysis Template");
  assert.equal(featureSurface.root?.type, "stack");
  assert.equal(featureSurface.root?.props.maxWidth, "lg");

  // Flatten nodes to verify components
  const featureNodes = [
    featureSurface.root!,
    ...(featureSurface.root?.children ?? []).flatMap(function visit(node): unknown[] {
      return [node, ...(node.children ?? []).flatMap(visit)];
    }),
  ] as { type: string; props: Record<string, unknown> }[];

  assert.ok(featureNodes.some(n => n.type === "image"), "Must have hero image node");
  assert.ok(featureNodes.some(n => n.type === "alert" && n.props.tone === "info"), "Must have takeaways alert");
  assert.ok(featureNodes.some(n => n.type === "stat"), "Must have quantitative stat anchors");
  assert.ok(featureNodes.some(n => n.type === "section" && String(n.props.title).includes("Sources")), "Must have sources section");

  // Check Split Editorial template
  const splitSurface = admitted.store.resolve("article-split-template");
  assert.ok(splitSurface, "article-split-template must resolve");
  assert.equal(splitSurface.root?.type, "split");
  assert.equal(splitSurface.root?.props.ratio, "2:1");
});
