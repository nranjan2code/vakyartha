---
name: commit-message
description: Author standard Git commit messages, pull request descriptions, and changelog entries that accurately capture changes, motivation, and verification.
license: MIT
compatibility: Compatible with Git version control systems, GitHub, GitLab, and changelog tools.
metadata:
  author: nranjan2code
  version: "1.2"
---

# Git Commit Messages & Pull Request Descriptions

Guidance for writing clear, concise, conventional Git commit messages and comprehensive pull request descriptions grounded strictly in actual changes.

## Overview

Use this skill when asked to draft a Git commit message, summarize staged diffs, write a pull request description, or prepare release notes / changelog entries.

## Conventional Commits Structure

Follow the repository's established convention or standard Conventional Commits:

```
<type>(<scope>): <short imperative description>

<longer description explaining the motivation, context, and what changed>

<footer references, breaking changes, issue numbers>
```

### Commit Components

1. **Header**:
   - Limit to 50–72 characters.
   - Use the imperative present tense: "Add feature", "Fix race condition", not "Added" or "Fixes".
   - Do not end the header with a period.
   - Types:
     - `feat`: A new user-facing feature or capability.
     - `fix`: A bug fix.
     - `refactor`: Code restructuring without behavioral changes.
     - `perf`: Performance improvement.
     - `test`: Adding or correcting tests.
     - `docs`: Documentation updates.
     - `chore` / `build` / `ci`: Tooling, dependency, or pipeline maintenance.
2. **Body**:
   - Wrap at ~72 characters.
   - Answer **why** this change is needed and **how** it solves the problem, rather than merely repeating the code diff.
   - Explain non-obvious side effects or technical tradeoffs.
3. **Footer**:
   - Declare breaking changes: `BREAKING CHANGE: <explanation>`.
   - Link tracking issues: `Fixes #123`, `Closes #456`.

## Pull Request Descriptions

When drafting a PR description, organize with clear sections:
- **Summary**: Concise overview of what problem this PR addresses.
- **Key Changes**: Bulleted list of notable architectural or functional modifications.
- **Verification & Testing**: Commands run, tests added or passing, manual verification steps.
- **Screenshots / Evidence**: Mention where visual diffs or receipts are provided.

## Factual Integrity Rules

- **Reflect true diffs**: Only describe modifications that actually exist in the diff. Never claim a test was added, a benchmark performed, or an edge case handled if it is not present in the code.
- **No unauthorized commits**: Generating message text does not imply authorization to execute `git commit` or `git push`.
