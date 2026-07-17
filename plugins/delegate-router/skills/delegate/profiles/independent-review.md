---
mode: review
model: sol
effort: xhigh
reportSchema: {"type":"object","required":["objectiveMet","findings","clean"],"additionalProperties":false,"properties":{"objectiveMet":{"type":"boolean"},"findings":{"type":"array","items":{"type":"object","required":["severity","file","line","summary","evidence"],"additionalProperties":false,"properties":{"severity":{"enum":["blocking","non-blocking"]},"file":{"type":"string"},"line":{"type":["number","null"]},"summary":{"type":"string"},"evidence":{"type":"string"}}}},"clean":{"type":"boolean","description":"True when no findings remain."}}}
---
# Objective

{{objective}}

# Allowed scope

Read-only review of the caller-provided workspace and scope. Do not modify files.

# Acceptance criteria

Return evidence-backed findings ordered by severity, with file and line references where available. State explicitly when no findings remain.

# Return

Paste the complete findings inline. A description of a report is not the report. End with a fenced JSON block matching `reportSchema`; the fenced block must be the last content in the final message.
