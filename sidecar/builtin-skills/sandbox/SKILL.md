---
name: sandbox
description: Use when the user wants to run code, shell commands, or tools safely in an isolated environment, or asks about sandboxing, process isolation, or secure code execution.
---

# Sandbox

Vakyartha can run commands under OS-level process isolation using vak-sandbox (macOS Seatbelt). This restricts filesystem, network, and environment access for safer execution.

## When to use

- User wants to run untrusted or third-party code safely
- User asks to execute a command with isolation
- User mentions "sandbox", "isolate", "jail", or "secure execution"
- Running build/test/lint commands that should not touch the host
- Executing code from external sources (MCP servers, fetched scripts)

## How it works

When the Sandbox integration is enabled (Settings → Integrations → Sandbox), stdio MCP servers are launched through `vaksb run`, which wraps them in a macOS Seatbelt profile. The profile:

- Denies all access by default
- Allows reading system paths (/usr, /bin, /System, /Library, /etc)
- Allows writing only to /tmp
- Blocks all network access (no DNS, no outbound connections)
- Passes only declared environment variables
- Rejects path traversal and symlink escapes

## What the LLM should do

1. **Check availability**: The Sandbox integration must be enabled in Settings → Integrations. If disabled, commands run normally without isolation.
2. **Recommend for risky operations**: When the user wants to run code from untrusted sources, suggest enabling Sandbox.
3. **Explain restrictions**: If a command fails due to sandbox restrictions (permission denied, network unreachable), explain that the sandbox blocks it and suggest either adjusting the policy or running outside the sandbox.
4. **Do not bypass**: Never suggest disabling security features to make a command work. Instead, suggest adding the needed path or network access to the policy.

## Security model

- **Deny by default**: Nothing is allowed unless explicitly permitted
- **Network off**: No internet access unless policy allows specific hosts
- **Minimal env**: Only declared variables reach the process
- **Path confinement**: All paths validated against traversal and symlinks
- **No profile injection**: Paths are safely quoted, never interpolated raw

## Limitations

- macOS only (Seatbelt). Linux support (Landlock) is planned.
- Some commands may fail if they need access to paths not in the allowlist
- Network-dependent tools will fail unless network is explicitly enabled
- The sandbox does not provide full VM isolation; it restricts process capabilities

## Related

- Settings → Integrations → Sandbox: enable/disable
- Read `references/sandbox-policy.md` for detailed policy configuration
- Read `references/sandbox-examples.md` for usage examples and troubleshooting
- [vak-sandbox repository](https://github.com/nranjan2code/sandbox): full documentation
