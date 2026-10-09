import { appendJobEventsAndUpdate, redact } from './control.mjs';
import { createClaudeAgentStub } from './agent-stubs.mjs';
import { listJobs } from './state.mjs';
import { brokerError } from './errors.mjs';

const STATUSES = new Set(['pending', 'running', 'waiting', 'idle', 'completed', 'failed', 'killed']);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;
const safe = (value, max = 256) => String(redact(String(value || ''))).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max);

// Only closed host metadata crosses this boundary. No transcript, prompt,
// reasoning, credentials, or user-supplied provider payload is accepted.
export function observeClaudeAgents(input) {
  if (!ID.test(input.sessionId || '') || !Array.isArray(input.agents) || input.agents.length > 128) {
    throw brokerError('INVALID_REQUEST', 'a session and at most 128 host agent rows are required');
  }
  const now = Date.now();
  const existing = listJobs().filter((job) => job.managedBy === 'delegate-agent-hook'
    && job.coordinatorSessionId === input.sessionId);
  const results = [];
  for (const agent of input.agents) {
    if (!ID.test(agent?.id || '') || !STATUSES.has(agent.status)) continue;
    let job = existing.find((row) => row.hostAgentId === agent.id || row.agentId === agent.id
      || row.transcriptAgentId === agent.id);
    if (!job) {
      job = createClaudeAgentStub({ sessionId: input.sessionId, toolUseId: `host-${agent.id}`,
        agentId: agent.id, agentType: safe(agent.type, 128), agentName: safe(agent.description, 128),
        cwd: input.projectDir, projectDir: input.projectDir });
      existing.push(job);
    }
    const terminal = ['completed', 'failed', 'killed'].includes(agent.status);
    const status = terminal ? agent.status === 'killed' ? 'cancelled' : agent.status : 'running';
    const changed = job.hostAgent?.status !== agent.status;
    const entries = changed ? [{ type: 'agent.status', data: { agentId: agent.id, status: agent.status, source: 'claude-host' } }] : [];
    appendJobEventsAndUpdate(job.id, entries, (current) => {
      current.hostAgentId = agent.id;
      current.parentAgentId = ID.test(agent.parentId || '') ? agent.parentId : null;
      current.hostAgent = { status: agent.status, observedAt: now, source: 'claude-host' };
      current.agentName ||= safe(agent.description, 128) || null;
      // A real terminal hook wins over an older nonterminal catalog read. A
      // false legacy quiet-window failure can be repaired by positive evidence.
      const alreadyTerminal = ['completed', 'failed', 'cancelled'].includes(current.status)
        && current.agentLifecycle !== 'ended-unknown';
      if (alreadyTerminal) return;
      if (current.agentLifecycle === 'ended-unknown') {
        delete current.error; delete current.errorCode; delete current.stoppedReason;
        delete current.agentEndedReason; delete current.completedAt; delete current.completedAtMs;
      }
      current.status = status;
      current.phase = terminal ? status : agent.status;
      current.agentLifecycle = terminal ? status : 'host-observed';
      if (terminal) {
        current.completedAtMs = now;
        current.completedAt = Math.floor(now / 1000);
        current.durationMs = Math.max(0, now - Number(current.createdAtMs || current.createdAt * 1000));
        if (status === 'failed') current.errorCode = 'AGENT_HOST_FAILED';
      }
      if (changed) current.revision = (current.revision || 0) + 1;
    });
    results.push({ jobId: job.id, agentId: agent.id, status: agent.status });
  }
  // Absence from a snapshot is deliberately not a completion signal.
  return { observed: results.length, agents: results };
}

export function bindClaudeAgent(input) {
  const spawn = input.spawn;
  if (!spawn || !ID.test(spawn.toolUseId || '') || !ID.test(input.sessionId || '')) {
    throw brokerError('INVALID_REQUEST', 'correlatable native agent spawn required');
  }
  const job = createClaudeAgentStub({ sessionId: input.sessionId, toolUseId: spawn.toolUseId,
    agentType: safe(spawn.type, 128), agentName: safe(spawn.description, 128),
    model: safe(spawn.model, 128) || 'inherited', cwd: input.projectDir, projectDir: input.projectDir });
  if (ID.test(spawn.agentId || '')) appendJobEventsAndUpdate(job.id, [], (current) => {
    current.hostAgentId = spawn.agentId;
    current.parentAgentId = ID.test(spawn.parentId || '') ? spawn.parentId : null;
    if (!['completed', 'failed', 'cancelled'].includes(current.status)) current.agentLifecycle = 'host-observed';
  });
  return { jobId: job.id };
}
