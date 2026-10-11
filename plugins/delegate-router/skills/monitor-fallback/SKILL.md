---
name: monitor-fallback
description: Recover Delegate Router notifications when native delivery is unhealthy and live delegated work remains. Claude should invoke this itself after delegate_notification_health reports needsFallback, not ask the user to remember a monitor command.
user-invocable: false
---

Check `delegate_notification_health` immediately before recovery. Do nothing if
`needsFallback` is false, the notification mode is off or legacy-persistent,
native delivery was explicitly disabled, or there are no current-session live
jobs. A quiet provider is not evidence of failed native delivery or timeout.

If recovery is needed, check `/tasks` (TaskList where available) for an already
running Delegate Router fallback. Do not create duplicate watches. Use the host
`Monitor` tool with this exact bounded read-only command (normal Bash permissions
and Auto-review still apply):

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/delegate-monitor" --fallback
```

Set `timeout_ms: 1800000` in an interactive session (600000 in a single-prompt
headless session). The process self-stops when native delivery recovers, the
last live job finishes, or notifications are turned off. If its host deadline
expires, recheck health and start another only when still needed. If Monitor is
unavailable or refused, report that push recovery is unavailable; retain bounded
MCP inspection and durable finishedPath. Never bypass permissions or launch a
detached watcher as a substitute: its stdout would not reach Claude.

The watch reads broker observations; it cannot launch, steer, approve, cancel,
resume, or mutate jobs. Reinspect revisions before acting on its messages.
Plan/permission decisions remain human-only. Do not change provider configuration,
scope, sandbox, quota or budgets to recover notifications. Complete Mod unload
while Claude is idle has no instant recovery in native mode; the next Claude
turn can invoke this skill. Persistent legacy is an explicit user choice via
`delegate-config notifications legacy-persistent`, never an automatic opt-in.
