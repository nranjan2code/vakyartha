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
The `@vak/mcp/client` supports optional vak-sandbox isolation via `McpClientOptions.vakSandbox`. When enabled, stdio MCP servers can be launched through `vaksb` for OS-level sandboxing.

### App (Vakyartha)
- Added to integrations catalog as "Sandbox" (built-in)
- Tauri dependencies include vak-sandbox crates for native integration
- Settings → Integrations shows sandbox configuration

## Configuration

Sandbox is enabled per-integration or globally. Default policies follow the principle of least privilege.

## Security Model

- Network disabled by default
- Filesystem access explicitly allowlisted
- Environment variables filtered (only declared vars)
- All paths validated through confinement checks
- Seatbelt profiles use safe quoting to prevent injection

## See Also
- [vak-sandbox Repository](https://github.com/nranjan2code/sandbox)
- [Security Documentation](../SECURITY.md)
