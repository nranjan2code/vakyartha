---
name: shell-command
description: Compose, explain, and safely execute terminal, shell, and command-line operations with clear arguments, safety boundaries, and OS awareness.
license: MIT
compatibility: Operates with macOS, Linux, and Windows shells (zsh, bash, sh, PowerShell).
metadata:
  author: nranjan2code
  version: "1.2"
allowed-tools: run_command
---

# Shell & Terminal Commands

Guidance for authoring, reviewing, explaining and executing command-line operations safely across modern operating systems.

## Overview & Safety First

- **Target environment**: Detect and respect the user's operating system (macOS, Linux, Windows) and active shell (zsh, bash, PowerShell).
- **Skill chaining**:
  - Load `sandbox` when the user requests or requires isolated execution, build testing or multi-step workspace modifications.
  - Load `debug-error` when a command fails with unexpected stderr, non-zero exit codes or dependency failures.
- **Ambient authority**: Providing a command string in chat does not authorize unprompted execution. Destructive operations require explicit confirmation or user approval.

## Command Authoring Guidelines

1. **Use explicit flags**: Prefer readable long-form flags where clarity matters, or standard idiomatic flags for common tools (`git`, `tar`, `find`, `grep`, `docker`).
2. **Proper quoting and escaping**:
   - Always quote paths and arguments containing spaces, wildcards or shell variables (`"$VAR"`, `"${DIR}/file.txt"`).
   - Use POSIX-compliant syntax when authoring portable scripts; use shell-specific builtins only when the target shell is known.
3. **Pipes and subshells**: Keep command pipelines linear and understandable. Use `set -eu` where appropriate; enable pipefail only in a shell that supports it. Inspect pipeline exit behavior rather than assuming portable pipefail support.
4. **Destructive operations**:
   - For commands that remove files (`rm`, `git clean`, `find -delete`), make the affected scope unmistakably clear.
   - Recommend a dry-run or inspection preview first (e.g. `ls -la <path>`, `git status`, `--dry-run`).
   - Never run `rm -rf /` or broadly wildcarded deletions.

## Explaining Commands

When asked to explain a command:
- Break down each component: executable, subcommands, options/flags and their arguments, redirects (`>`, `>>`, `2>&1`), and pipes (`|`).
- Explain any environment variables, subshell evaluations (`$(...)`), and side effects on disk, memory or network.
- Highlight any potential risks, version dependencies or OS-specific idiosyncrasies (e.g. BSD `sed` vs GNU `sed`).

## Execution & Output Verification

- When executing via `run_command`, inspect stdout, stderr and the exit code.
- A non-zero exit code indicates failure even if stdout contains informative text.
- Do not claim a command completed successfully without verifying its execution receipt and output.
