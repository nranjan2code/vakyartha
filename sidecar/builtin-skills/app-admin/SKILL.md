---
name: app-admin
description: Administrate, monitor, and audit sandboxed applications, worker pool allocation, resource quotas, and security boundaries.
license: MIT
metadata:
  author: Vakyartha Team
  version: "1.0"
---

# Administrating Hosted Applications

Use this procedure when monitoring worker runtimes, managing storage volumes, and auditing security isolation.

## Fleet Observability
1. **List Installed Applications:**
   `GET /api/apps`
   Returns summaries including storage footprint, active worker status, and last executed timestamp.

2. **Fleet Snapshot:**
   `GET /api/fleet`
   Reports all slots in the Sandbox Pool Manager:
   - Total slots available and leased
   - Tenant IDs bound to slots
   - Memory and CPU limits per slot

3. **Fleet Console:**
   Accessible via UI shortcut `⌘⇧A` or the `Fleet Console` button in the Apps toolbar.

## Security & Resource Boundaries
- **Process Isolation:** Worker runtimes execute in dedicated child processes with seatbelt profiles.
- **Airgap Policy:** Applications default to airgap (`allowedDomains: []`). External network calls are blocked unless explicitly configured in entitlements.
- **Volume Boundaries:** Data writes are confined to `<dataDir>/apps/<id>/data/`. Disk consumption is tracked and bounded to `maxStorageMb`.
- **Termination:** Inactive slots hibernate automatically. To manually terminate or delete an application and its storage volume:
  `DELETE /api/apps/:id`

