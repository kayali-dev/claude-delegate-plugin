export function securityPreamble(allowSensitive) {
  const sensitiveRule = allowSensitive
    ? '- Sensitive-path access is explicitly authorized for this task; touch only the sensitive paths the task names.'
    : '- Do not read, print, transmit, or modify credentials, private keys, tokens, or .env files unless the task explicitly authorizes the exact path. Running project tooling that consumes them internally (builds, tests, dev servers reading .env) is allowed and expected; never echo, copy, or relocate their contents yourself.';
  return `Security boundary:
${sensitiveRule}
- Preserve pre-existing changes and never revert unrelated work.
- Stay inside the task's allowed scope. Stop and report if required work falls outside it.

`;
}

export function assembleProviderPrompt(job, packet) {
  const scope = job.allowedPaths?.length
    ? `Allowed write scope (hard fence): create or modify files only under: ${job.allowedPaths.join(', ')}. If required work falls outside this set, stop and report instead of editing.\n\n`
    : '';
  const ingested = job.stagingDir
    ? `Ingested files are staged under ${job.stagingDir}; work on those staged copies.\n\n`
    : '';
  const structured = job.reportSchema
    ? `\n\nStructured report contract: End the final message with a fenced \`\`\`json block matching this schema and containing objectiveMet (true, false, or "partial").\n${JSON.stringify(job.reportSchema, null, 2)}`
    : '';
  return `${securityPreamble(job.allowSensitive)}${scope}${ingested}${packet}${structured}`;
}
