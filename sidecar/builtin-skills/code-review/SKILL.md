---
name: code-review
description: Review, improve, and audit source code for correctness, security vulnerabilities, performance, and maintainability with prioritized actionable findings.
license: MIT
compatibility: Language-agnostic code review across TypeScript, Rust, Python, Go, C/C++, Swift, shell, and web technologies.
metadata:
  author: nranjan2code
  version: "1.2"
---

# Code Review & Quality Inspection

Actionable, evidence-backed code review focusing on correctness, security, performance and software engineering hygiene.

## Overview

Use this skill when the user asks to review, critique, audit or improve source code, pull requests, diffs or architectural patterns. Provide structured, prioritized feedback rather than superficial commentary.

## Skill Chaining

- Load `decision-eval` to classify finding severities (`Critical`, `Major`, `Minor`, `Nit`) against discrete criteria without subjective guessing.
- Load `decision-chain` when conducting multi-stage security audits (Domain Triage -> Vulnerability Inspection -> Exploitation Risk Gate).

## Review Priorities

1. **Correctness & Logic**:
   - Check algorithmic logic, state transitions, boundary conditions and off-by-one errors.
   - Inspect error handling, exception boundaries, asynchronous flows (race conditions, unhandled rejections, deadlocks).
   - Verify null/undefined/optional handling and type conversions.
2. **Security & Data Safety**:
   - Check for injection vulnerabilities (SQL, shell, command, prompt, template).
   - Inspect authorization, authentication, directory traversal, prototype pollution and unsanitized inputs.
   - Guard against secret leakage, hardcoded keys, improper credentials and insecure deserialization.
3. **Performance & Resource Hygiene**:
   - Identify unindexed queries, $O(N^2)$ loops, excessive object allocation, memory leaks and unclosed file/socket descriptors.
   - Check caching strategies, network round-trips and unnecessary re-renders.
4. **Maintainability & Architectural Cleanliness**:
   - Evaluate modularity, single responsibility, clear naming and adherence to established repository idioms.
   - Avoid over-engineering; recommend simpler standard-library solutions where third-party bloat exists.

## Structuring Findings

Group and prioritize observations clearly:
- **Severity**: Categorize as `Critical` (immediate bug/vulnerability), `Major` (correctness risk/performance regression), `Minor` (hygiene/edge case), or `Nit` (minor style/convention).
- **Location**: Name the exact file, function and line numbers.
- **Evidence & Impact**: Explain specifically *why* this is a problem and what adverse behavior could result.
- **Actionable Correction**: Provide a concise code snippet or diff showing the recommended fix.

## Boundaries & Professional Restraint

- **Substance over style**: Focus on verifiable issues rather than personal formatting preferences, unless repo conventions are explicitly violated.
- **Preserve scope**: Do not rewrite working, unrelated code or turn a scoped review into a wholesale rewrite.
- **Disclose limits**: State clearly what could not be verified (e.g. untested runtime behavior, external library internals, deployment infrastructure).
