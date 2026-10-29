# Command Recipes for Folder Workspaces

This reference contains safe, reliable command invocation patterns for common developer tasks in Vakyartha folder workspaces.

---

## 1. Inspecting the Workspace

Always inspect before modifying:

### List directory contents
```json
{
  "command": "/bin/ls",
  "args": ["-la"]
}
```

### Find files by pattern
```json
{
  "command": "/usr/bin/find",
  "args": [".", "-maxdepth", "3", "-not", "-path", "*/.*", "-name", "*.ts"]
}
```

### Read file contents
```json
{
  "command": "/bin/cat",
  "args": ["package.json"]
}
```

---

## 2. Git Operations (Direct Mode)

In `direct` mode, the `.git` repository and worktrees are intact and fully functional:

### Check status
```json
{
  "command": "/usr/bin/git",
  "args": ["status", "--short"]
}
```

### Inspect diffs
```json
{
  "command": "/usr/bin/git",
  "args": ["diff", "src/"]
}
```

### Git worktrees
```json
{
  "command": "/usr/bin/git",
  "args": ["worktree", "list"]
}
```

### Non-interactive commit
```json
{
  "command": "/usr/bin/git",
  "args": ["commit", "-m", "refactor: optimize parser"]
}
```

---

## 3. Long Builds & Test Runs

Always specify `timeout_seconds` when running build tools or test suites to prevent premature termination at 30 seconds:

### Node.js / Vite / TypeScript build
```json
{
  "command": "/bin/sh",
  "args": ["-c", "npm run build 2>&1"],
  "timeout_seconds": 120
}
```

### Node test runner
```json
{
  "command": "/bin/sh",
  "args": ["-c", "npm test"],
  "timeout_seconds": 180
}
```

### Rust Cargo build
```json
{
  "command": "/bin/sh",
  "args": ["-c", "cargo build --all-targets 2>&1"],
  "timeout_seconds": 240
}
```

### Python test suite
```json
{
  "command": "/bin/sh",
  "args": ["-c", "pytest -q"],
  "timeout_seconds": 90
}
```

---

## 4. File Modifications

### Write or update a file cleanly using a heredoc
```json
{
  "command": "/bin/sh",
  "args": [
    "-c",
    "cat << 'EOF' > src/config.ts\nexport const PORT = 3000;\nexport const HOST = 'localhost';\nEOF"
  ]
}
```

### Append content
```json
{
  "command": "/bin/sh",
  "args": [
    "-c",
    "printf '\n# Added rule\n*.log\n' >> .gitignore"
  ]
}
```

### Create nested directories safely
```json
{
  "command": "/bin/mkdir",
  "args": ["-p", "src/components/buttons"]
}
```

