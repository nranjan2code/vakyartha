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
- Shown as a top-level Settings → Sandbox page
- Controlled in Settings → Sandbox; the switch is saved and applies after app restart
- Enabled by default via `vakSandbox: { enabled: true, binaryPath: "vaksb" }` in createIntegrations
- Requires `vaksb` binary on PATH (install from sandbox repo)

## Configuration

Sandbox is enabled globally for all stdio MCP servers by default. Its app-level switch enables or disables OS containment as a whole; individual filesystem and network policy controls are not exposed by the current framework API. Default policies follow the principle of least privilege:
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

## Bundling

`vaksb` is built and bundled with vakyartha during `npm run desktop:build`. The binary is placed at `src-tauri/binaries/vaksb-<triple>` and shipped as a Tauri external binary. At runtime, the Tauri shell sets `VAK_SANDBOX_BIN` to the bundled path, and the sidecar passes it to the framework.

In dev mode (`npm run desktop`), the sidecar looks for `vaksb` at `../sandbox/target/release/vaksb` or on PATH.

If `vaksb` is not available, the framework gracefully degrades: MCP servers run without OS-level isolation (no crash, no silent failure).

## See Also
- [vak-sandbox Repository](https://github.com/nranjan2code/sandbox)
- [Security Documentation](../SECURITY.md)
- [Sandbox System Design](https://github.com/nranjan2code/sandbox/blob/main/docs/architecture/SYSTEM_DESIGN.md)
