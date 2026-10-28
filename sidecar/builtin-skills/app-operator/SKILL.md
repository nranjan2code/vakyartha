---
name: app-operator
description: Operate running hosted applications, invoke background triggers, poll external data, and dispatch interactive surface actions.
license: MIT
metadata:
  author: Vakyartha Team
  version: "1.0"
---

# Operating Hosted Applications

Use this procedure when interacting with, querying, or polling live hosted applications.

## Launching Applications in Full View
- Applications run in the dedicated runner view inside the `Apps` tab.
- Navigating to `Apps` keeps execution isolated from active conversation threads.
- Clicking "Back to apps" returns to the catalog without tearing down background daemons.

## Running Background Triggers & Polls
To manually trigger a background cron job or data refresh:
```http
POST /api/apps/:id/triggers/:triggerId/run
```
The response reports execution status, duration in milliseconds, and the action executed:
```json
{
  "ok": true,
  "action": "recalculateMetrics",
  "durationMs": 4
}
```

## Dispatching Interactive Actions
When a user interacts with a control or clicks an action button:
```http
POST /api/apps/:id/action
Content-Type: application/json

{
  "controlId": "select-risk-profile",
  "value": "aggressive",
  "action": "change"
}
```
The sandboxed runtime evaluates the action in pure code (sub-millisecond latency, zero LLM tokens) and returns patch operations applied directly to the surface store.

