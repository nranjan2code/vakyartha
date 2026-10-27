# Sandbox Policy Reference

## Default Policy (deny-all)

When the Sandbox integration is enabled, every stdio MCP server runs with:

- **Filesystem**: Read-only access to system paths (/usr, /bin, /System, /Library, /etc, /opt). Write access only to /tmp. Everything else denied.
- **Network**: Completely disabled. No DNS, no outbound, no inbound.
- **Environment**: Only declared variables (from the integration's config). No PATH inheritance beyond /usr/bin:/bin.
- **Process**: Fork and exec allowed (needed for shell commands).

## Policy Overrides

The sandbox supports fine-grained policy customization:

### Filesystem
- `allow_read`: Paths the process can read
- `allow_write`: Paths the process can write (implies read)
- `deny`: Paths always denied (overrides allow lists)
- `follow_symlinks`: Disabled by default (dangerous)

### Network
- `allow`: Master switch (false by default)
- `allow_outbound`: Outbound connections
- `allow_inbound`: Inbound connections
- `allow_localhost`: Local IPC
- `allow_hosts`: Specific hosts/IPs
- `allow_ports`: Specific ports
- `allow_dns`: DNS resolution

### Environment
- `allow`: Set of variable names permitted
- `set`: Variables to inject

### Resources (defaults)
- CPU: 3600s
- Memory: 2GB
- Wall time: 7200s
- Processes: 256
- File size: 1GB

## Path Confinement

All paths are validated through `confined()`:
- Absolute paths rejected
- `..` traversal rejected
- Symlink escapes detected
- Canonicalization of roots

## Common Failure Modes

| Symptom | Cause | Resolution |
|---------|-------|------------|
| "Permission denied" on file | Path not in allow_read/allow_write | Add path to policy |
| "Couldn't resolve host" | Network disabled | Enable network in policy |
| "Operation not permitted" | Write to denied path | Use /tmp or allowed path |
| Command not found | PATH restricted | Check binary in /usr/bin or /bin |
