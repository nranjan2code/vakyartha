---
name: create-skill
description: Create, audit or revise a Vakyartha instruction skill for a repeated workflow, grounded in the tools and surface capabilities actually available here.
license: MIT
compatibility: Designed for Vakyartha desktop and web runtimes; compliant with the Agent Skills specification.
metadata:
  author: nranjan2code
  version: "1.2"
allowed-tools: read_skill_file use_skill
---

# Authoring Agent Skills

Comprehensive authoring guide for creating, auditing and maintaining high-quality instruction packages compliant with the Agent Skills specification (`agentskills.io/specification`) and Vakyartha's extensions.

## Overview & Scope Boundary

- **Purpose**: Use this skill when asked to author a new skill, revise an existing skill package, or audit skill instructions against Vakyartha's runtime capabilities.
- **Skill scope**: Each skill must have a distinct boundary and recurring trigger. Do not create redundant skills when an existing workflow already covers the domain.
- **Progressive disclosure**: Keep the system prompt lightweight: only the name and description are in the system index; detailed instructions are loaded on demand via `use_skill`, and heavy references via `read_skill_file`.

## Package Layout & Frontmatter Specification

Every skill package lives in a directory matching its name: `<skill-name>/` containing `SKILL.md` and optional resource directories.

### Frontmatter Fields

```yaml
---
name: my-skill
description: Concise, third-person trigger explaining what the skill does and when to activate it (max 1024 chars).
license: MIT
compatibility: Runtime requirements, operating systems, or required tool dependencies.
metadata:
  author: your-name
  version: "1.0"
allowed-tools: run_command read_skill_file
---
```

- **`name`**: Lowercase letters, numbers and single hyphens (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`), up to 64 characters. Must match its parent directory name.
- **`description`**: Non-empty, up to 1024 characters. Clear third-person description of capabilities and activation conditions.
- **`license`**: Standard SPDX identifier (e.g. `MIT`, `Apache-2.0`).
- **`compatibility`**: Plain-text description of runtime or platform requirements (up to 500 characters).
- **`metadata`**: String-valued map (2 or 4-space indentation) for author, version and custom tags. Nested objects and lists are not supported.
- **`allowed-tools`**: Space-separated list of recommended tools (experimental; guides selection without granting ambient authority).
- **Body**: Instructions written in structured GitHub-flavored Markdown, up to 32,768 characters.

## Progressive Disclosure & Resource Folders

Place supporting files beside `SKILL.md` under standard subdirectories:
- **`references/`**: Reference manuals, API schemas, layout templates, domain tables.
- **`scripts/`**: Automation or utility scripts, stored as reviewable UTF-8 source text and inspected as inert reference data.
- **`assets/`**: Static configuration skeletons, mock payloads, or template files.

### File Limits & Constraints

- Files must be valid UTF-8 text without NUL bytes (`\0`).
- Individual file size: maximum 256 KiB.
- Package total: maximum 50 files and 2 MiB total across all supporting files.
- Files are paged on demand via `read_skill_file` (16,000 characters per page). Skills never execute scripts automatically.

## Surface & Runtime Chaining

- **Surface design**: The `surface-design` skill is required and always on. Visual and spoken composition must adhere to its layout and chart rules.
- **Data & interaction**: When surfaces require data bindings, maps or forms, chain to enabled `interactive-ui`.
- **Single canonical projection**: Design one surface that serves both the screen and voice synthesis. Key findings, metrics, dates and caveats must appear in visible prose so speech carries full meaning.

## Safety & Security Invariants

- **No embedded secrets**: Never put API keys, passwords or authentication tokens in skill instructions or references.
- **No ambient authority**: Skills provide procedural guidance, not execution permissions. Tools retain their own authorization policies and approval gates.
- **No parallel runtime**: Do not invent parallel databases, custom memory stores or unmanaged execution engines.

## Verification & Testing

1. Validate frontmatter and syntax against `parseSkill`.
2. Check that skill selection is discriminating and does not trigger on unrelated user prompts.
3. Verify that all supporting file paths referenced in instructions exist and load cleanly via `read_skill_file`.
4. Run `npm test` and `node scripts/skills-check.ts` to verify catalog and UI compatibility.
