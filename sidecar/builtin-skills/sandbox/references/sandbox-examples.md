# Sandbox Usage Examples

## Example 1: Running a build command

User: "Run npm test in the project"

With sandbox enabled, the command runs under Seatbelt with:
- Read access to /usr, /bin, /System, /Library, /etc, /opt, /tmp
- Write access to /tmp only
- No network access
- Minimal environment (PATH, HOME, TMPDIR)

If npm needs network (to download dependencies), it will fail. Suggest running outside sandbox or enabling network.

## Example 2: Running untrusted code

User: "Run this Python script I found online"

With sandbox enabled:
- Script can read system libraries
- Script can write to /tmp
- Script cannot access user files, network, or sensitive paths
- Script cannot install packages (no network)

## Example 3: MCP server with sandbox

When Sandbox integration is enabled, all stdio MCP servers are launched through `vaksb run`. This means:
- The MCP server process is sandboxed
- It can only access its declared folders
- It cannot leak the app's environment variables
- Network is blocked unless the integration declares it needs network

## Example 4: Debugging sandbox failures

If a command fails in the sandbox:
1. Check if the error is "Permission denied" (filesystem) or "Couldn't resolve host" (network)
2. Identify the missing permission
3. Either adjust the sandbox policy or run outside the sandbox
4. Never disable security features to work around restrictions

## Troubleshooting

### Command works outside sandbox but fails inside
- Check if the command needs network access
- Check if the command writes to a path outside /tmp
- Check if the command needs environment variables not declared

### MCP server fails to start
- Check if the server binary is in /usr/bin or /bin
- Check if the server needs network (declare in integration config)
- Check if the server needs specific folders (add to folders config)
