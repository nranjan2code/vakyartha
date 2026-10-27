# Sandbox Integration

Vakyartha integrates [vak-sandbox](https://github.com/nranjan2code/sandbox) for OS-level process isolation of MCP servers and tool execution.

## Overview

The sandbox provides defense-in-depth protection:
- **Process containment** via OS primitives (macOS Seatbelt, Linux Landlock/seccomp/bubblewrap)
- **Deny-by-default** policies for filesystem, network, and environment
- **Path confinement** preventing traversal and symlink escapes
- **Minimal environment** passed only to what servers declare

## Integration Points

### Framework (Projection)
The `@vak/mcp/client` supports optional vak-sandbox isolation via `McpClientOptions.vakSandbox`. When enabled, stdio MCP servers are launched through the `vaksb` binary for OS-level sandboxing (macOS Seatbelt). Availability is checked at runtime; if `vaksb` is not installed, servers run normally without OS isolation (graceful degradation).

### App (Vakyartha)
- Added to integrations catalog as "Sandbox" (built-in, trust: built-in)
- Enabled globally via `vakSandbox: { enabled: true, binaryPath: "vaksb" }` in createIntegrations
- Settings → Integrations shows sandbox status
- Requires `vaksb` binary on PATH (install from sandbox repo)

## Configuration

Sandbox is enabled globally for all stdio MCP servers. Default policies follow the principle of least privilege:
- Network: disabled by default
- Filesystem: minimal read (system paths), write only to /tmp
- Environment: only declared variables

## Security Model

- Network disabled by default (curl/DNS blocked)
- Filesystem access explicitly allowlisted
- Environment variables filtered (only declared vars)
- All paths validated through confinement checks
- Seatbelt profiles use safe quoting to prevent injection
- Graceful degradation if vaksb unavailable (no silent failures)

## Requirements

- `vaksb` binary installed and on PATH
- macOS 11+ (Seatbelt) or Linux with Landlock support (planned)
- Build from [sandbox repo](https://github.com/nranjan2code/sandbox)

## See Also
- [vak-sandbox Repository](https://github.com/nranjan2code/sandbox)
- [Security Documentation](../SECURITY.md)
- [Sandbox System Design](https://github.com/nranjan2code/sandbox/blob/main/docs/architecture/SYSTEM_DESIGN.md)
