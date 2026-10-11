---
name: legacy-monitor
description: Arm the explicitly configured persistent legacy Delegate Router monitor. Use only when notification mode is legacy-persistent. Claude should invoke it once during setup if native startup could not arm it; never select persistent mode on the user's behalf.
user-invocable: false
---

First check `delegate_notification_health`: do nothing unless mode is
`legacy-persistent` and `ambientEnabled` is true. Respect environment opt-outs.
An unnecessary skill trigger can itself produce a host monitor-end notification.

This skill's first invocation arms the plugin's persistent legacy monitor through
the host's on-skill-invoke trigger. The command independently checks
`delegate-config notifications` and exits unless the mode is legacy-persistent.
Do not run another Monitor-tool watch or background command. Inspect normal
managed tools; observations are not human approval. The configured monitor may
keep Claude's normal background-work exit confirmation visible, even when idle.
Use `delegate-config notifications native` to return to the native default; never
change the mode yourself without a user request.
