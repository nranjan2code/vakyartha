---
name: debug-error
description: Diagnose error messages, stack traces, test failures, and broken code to isolate root causes and provide minimal, verifiable corrections.
license: MIT
compatibility: Universal debugging across language runtimes, compilers, test suites, and operating systems.
metadata:
  author: nranjan2code
  version: "1.2"
---

# Error Debugging & Root Cause Analysis

Systematic methodology for diagnosing software failures, interpreting error traces, isolating root causes and verifying targeted fixes.

## Overview & Chaining

- Use this skill when presented with a runtime exception, compiler error, broken build, test failure, silent bug or unexpected application state.
- **Skill chaining**:
  - Load `sandbox` if reproducible reproduction, compilation or test execution in isolation is needed.
  - Load `shell-command` for running specific diagnostic, git bisect or profiling commands.
  - Load `code-review` when evaluating the broader impact of a fix on surrounding code.

## Systematic Debugging Process

1. **Deconstruct the error signal**:
   - Parse the exact error name, message, exit code and stack trace.
   - Trace backwards from the point of failure to the earliest application boundary where invalid state originated.
   - Beware of cascading errors: focus on the *first* failure in a multi-error trace.
2. **Isolate facts from assumptions**:
   - Document what is definitively proven by the logs versus what is merely suspected.
   - Identify recent changes (commits, dependency updates, environment shifts) that could have triggered the regression.
3. **Reproduce and formulate hypotheses**:
   - Construct the minimal test case or conditions required to reproduce the fault reliably.
   - Evaluate hypotheses against confirmed evidence: discard theories contradicted by the stack trace.
4. **Design the minimal surgical correction**:
   - Fix the root cause rather than patching over symptoms (e.g. avoid wrapping failing code in blanket `try/catch` or adding arbitrary timeouts without understanding why a race occurred).
   - Keep the diff small, focused and readable.
5. **Establish verification**:
   - Provide the exact command, unit test or manual step to confirm that the error is resolved.
   - Verify that the fix does not introduce regressions in adjacent functionality.

## Common Failure Patterns

- **Environment & Dependency**: Node/Python/Rust version mismatches, missing lockfile sync, uninstalled native binaries, missing environment variables.
- **Asynchronous & Concurrency**: Unhandled promise rejections, missing `await`, race conditions on shared memory/state, event loop stalls.
- **Type & State Invariants**: Passing `undefined`/`null` where non-null objects are required, uninitialized variables, mutated immutable state.
- **Permissions & Boundaries**: Sandbox constraints, missing file permissions, blocked ports, proxy/firewall interference.

## Boundaries & Restraint

- **Respect requested scope**: Distinguish whether the user wants an explanation of what the error means, advice on how to investigate, or an actual code change.
- **No speculative rewrites**: Do not refactor unrelated subsystems or swap architectural frameworks under the guise of debugging a localized bug.
