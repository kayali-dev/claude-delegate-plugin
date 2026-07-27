import { brokerError } from './errors.mjs';

export const ATTEMPT_DRIVER_LIFECYCLE = Object.freeze([
  'start',
  'resume',
  'prompt',
  'steer',
  'cancel',
  'close'
]);

export const ATTEMPT_CAPABILITIES = Object.freeze([
  'sameTurnSteering',
  'liveShellStdout',
  'midTurnTokenUsage',
  'contextOccupancyUsage',
  'planMode',
  'mcpInjection',
  'worktreeSupport',
  'startBeforePrompt'
]);

const DOCUMENTED = 'declared-from-documentation';

function capability(supported, mode, detail, reference) {
  return Object.freeze({
    supported,
    mode,
    evidence: Object.freeze({
      source: DOCUMENTED,
      detail,
      reference
    })
  });
}

const LANE_DEFINITIONS = Object.freeze({
  'codex-app-server': Object.freeze({
    id: 'codex-app-server',
    provider: 'codex',
    transport: 'app-server',
    capabilities: Object.freeze({
      sameTurnSteering: capability(true, 'same-turn', 'turn/steer targets the active expected turn', 'Codex app-server protocol'),
      liveShellStdout: capability(true, 'delta-events', 'commandExecution outputDelta is delivered during the active turn', 'Codex app-server protocol'),
      midTurnTokenUsage: capability(true, 'usage-events', 'thread token-usage updates arrive before turn completion', 'Codex app-server protocol'),
      contextOccupancyUsage: capability(false, 'unavailable', 'token totals are not a context-window occupancy measurement', 'Codex app-server protocol'),
      planMode: capability(true, 'read-only-turn', 'the broker runs the plan pass as a read-only turn on the same thread', 'Delegate Router P4.6'),
      mcpInjection: capability(true, 'thread-config', 'the back-channel MCP server is injected through thread config', 'Delegate Router P4.5'),
      worktreeSupport: capability(true, 'broker-worktree', 'the provider cwd can be a broker-owned detached worktree', 'Delegate Router P6'),
      startBeforePrompt: capability(true, 'thread-before-turn', 'thread start or resume completes before the first turn', 'Codex app-server protocol')
    })
  }),
  'cursor-acp': Object.freeze({
    id: 'cursor-acp',
    provider: 'cursor',
    transport: 'acp',
    capabilities: Object.freeze({
      sameTurnSteering: capability(false, 'restart-only', 'ACP v1 correction is cancel-and-resume, never same-turn steering', 'Cursor ACP v1'),
      liveShellStdout: capability(false, 'completion-only', 'the production client advertises terminal=false and receives completed tool output only', 'Cursor ACP v1 and Delegate Router adapter'),
      midTurnTokenUsage: capability(false, 'unavailable', 'ACP usage_update reports context occupancy, not billable token totals', 'Cursor ACP v1'),
      contextOccupancyUsage: capability(true, 'usage-update', 'ACP usage_update reports used and total context-window units', 'Cursor ACP v1'),
      planMode: capability(true, 'session-mode', 'the session mode catalog exposes plan mode and the broker selects it', 'Cursor ACP v1'),
      mcpInjection: capability(true, 'session-mcp-servers', 'the back-channel server is supplied to session/new or session/load', 'Delegate Router P4.5'),
      worktreeSupport: capability(true, 'broker-worktree', 'the provider cwd can be a broker-owned detached worktree', 'Delegate Router P6'),
      startBeforePrompt: capability(true, 'session-before-prompt', 'session/new or session/load completes before session/prompt', 'Cursor ACP v1')
    })
  }),
  'cursor-headless': Object.freeze({
    id: 'cursor-headless',
    provider: 'cursor',
    transport: 'headless',
    capabilities: Object.freeze({
      sameTurnSteering: capability(false, 'restart-only', 'correction terminates the process and resumes the chat', 'Cursor headless CLI'),
      liveShellStdout: capability(false, 'completion-only', 'stream-json exposes tool completion records, not live shell stdout', 'Cursor headless CLI'),
      midTurnTokenUsage: capability(false, 'completion-only', 'token usage is present only on the terminal result record', 'Cursor headless CLI'),
      contextOccupancyUsage: capability(false, 'unavailable', 'headless result usage does not expose context-window occupancy', 'Cursor headless CLI'),
      planMode: capability(true, 'cli-mode', 'headless print mode accepts --mode plan', 'Cursor headless CLI'),
      mcpInjection: capability(true, 'launch-plugin', 'the launch-scoped back-channel plugin is passed with MCP approval', 'Delegate Router P4.5'),
      worktreeSupport: capability(true, 'broker-worktree', 'the provider cwd can be a broker-owned detached worktree', 'Delegate Router P6'),
      startBeforePrompt: capability(false, 'unavailable', 'managed startPaused is intentionally unavailable on headless transport', 'Delegate Router control contract')
    })
  })
});

const WORKFLOW_REQUIREMENTS = Object.freeze({
  'plan-first': Object.freeze(['planMode']),
  'same-turn-steering': Object.freeze(['sameTurnSteering']),
  'live-shell-checkpoint': Object.freeze(['liveShellStdout']),
  'mid-turn-output-budget': Object.freeze(['midTurnTokenUsage']),
  'context-occupancy-checkpoint': Object.freeze(['contextOccupancyUsage']),
  backchannel: Object.freeze(['mcpInjection']),
  'contained-worktree': Object.freeze(['worktreeSupport']),
  'pre-prompt-pause': Object.freeze(['startBeforePrompt'])
});

export function attemptLane(providerOrJob, transport = null) {
  const provider = typeof providerOrJob === 'object' ? providerOrJob?.provider : providerOrJob;
  const selectedTransport = typeof providerOrJob === 'object' ? providerOrJob?.transport : transport;
  if (provider === 'codex' && (!selectedTransport || selectedTransport === 'app-server')) return 'codex-app-server';
  if (provider === 'cursor' && selectedTransport === 'headless') return 'cursor-headless';
  if (provider === 'cursor' && (!selectedTransport || selectedTransport === 'acp')) return 'cursor-acp';
  throw brokerError('INVALID_REQUEST', `Unsupported managed provider transport: ${provider || 'unknown'}/${selectedTransport || 'default'}`, {
    provider: provider || undefined
  });
}

export function attemptDriverDefinition(providerOrLane, transport = null) {
  const lane = LANE_DEFINITIONS[providerOrLane] ? providerOrLane : attemptLane(providerOrLane, transport);
  return LANE_DEFINITIONS[lane];
}

function probedCapability(entry, supported, mode, detail, probe) {
  return {
    ...entry,
    supported,
    mode: mode || entry.mode,
    evidence: {
      source: 'probed',
      detail,
      probe
    }
  };
}

function resolvedLane(definition, probe = null) {
  const capabilities = Object.fromEntries(Object.entries(definition.capabilities)
    .map(([name, entry]) => [name, { ...entry, evidence: { ...entry.evidence } }]));
  const installation = probe
    ? {
        available: probe.ok === true,
        source: 'probed',
        noTurn: probe.noTurn === true,
        version: probe.version || probe.observedVersion || null,
        errorCode: probe.ok === true ? null : probe.errorCode || 'PROBE_FAILED'
      }
    : {
        available: null,
        source: DOCUMENTED,
        noTurn: null,
        version: null,
        errorCode: null
      };

  if (definition.id === 'cursor-acp' && probe?.ok === true && typeof probe.planMode === 'boolean') {
    capabilities.planMode = probedCapability(
      capabilities.planMode,
      probe.planMode,
      probe.planMode ? 'session-mode' : 'unavailable',
      probe.planMode ? 'the installed ACP session advertised plan mode' : 'the installed ACP session did not advertise plan mode',
      'initialize plus session/new; no turn'
    );
  }
  if (definition.id === 'cursor-headless' && probe?.ok === true) {
    if (typeof probe.planMode === 'boolean') {
      capabilities.planMode = probedCapability(
        capabilities.planMode,
        probe.planMode,
        probe.planMode ? 'cli-mode' : 'unavailable',
        probe.planMode ? 'the installed headless help advertises --mode plan' : 'the installed headless help does not advertise --mode plan',
        '--help; no turn'
      );
    }
    if (typeof probe.mcpInjection === 'boolean') {
      capabilities.mcpInjection = probedCapability(
        capabilities.mcpInjection,
        probe.mcpInjection,
        probe.mcpInjection ? 'launch-plugin' : 'unavailable',
        probe.mcpInjection ? 'the installed headless help advertises plugin and MCP approval flags' : 'the installed headless help lacks plugin or MCP approval flags',
        '--help; no turn'
      );
    }
  }
  if (definition.id === 'codex-app-server' && probe?.ok === true && probe.protocolSchema?.generated === true) {
    for (const [name, detail] of [
      ['sameTurnSteering', 'the installed app-server schema includes turn/steer'],
      ['liveShellStdout', 'the installed app-server schema includes command-execution output deltas'],
      ['midTurnTokenUsage', 'the installed app-server schema includes thread token-usage updates'],
      ['mcpInjection', 'the installed app-server schema includes MCP server configuration']
    ]) {
      const supported = probe.protocolSchema[name] === true;
      capabilities[name] = probedCapability(
        capabilities[name],
        supported,
        supported ? capabilities[name].mode : 'unavailable',
        supported ? detail : `the installed app-server schema lacks ${name}`,
        'generated protocol schema; no turn'
      );
    }
  }
  return {
    id: definition.id,
    provider: definition.provider,
    transport: definition.transport,
    installation,
    capabilities,
    scheduling: schedulingProfile({ ...definition, capabilities })
  };
}

export function resolveAttemptDriverMatrix(probes = {}) {
  return Object.fromEntries(Object.values(LANE_DEFINITIONS).map((definition) => [
    definition.id,
    resolvedLane(definition, probes[definition.id] || null)
  ]));
}

export function schedulingProfile(providerOrDefinition, transport = null) {
  const definition = providerOrDefinition?.capabilities
    ? providerOrDefinition
    : attemptDriverDefinition(providerOrDefinition, transport);
  const capabilities = definition.capabilities;
  return {
    workflows: {
      planFirst: capabilities.planMode.supported,
      sameTurnSteering: capabilities.sameTurnSteering.supported,
      coordinatorBackchannel: capabilities.mcpInjection.supported
    },
    budgets: {
      outputTokens: capabilities.midTurnTokenUsage.supported ? 'mid-turn'
        : capabilities.midTurnTokenUsage.mode === 'completion-only' ? 'completion-only' : 'unavailable',
      contextOccupancy: capabilities.contextOccupancyUsage.supported ? 'observable' : 'unavailable'
    },
    checkpoints: {
      liveShellStdout: capabilities.liveShellStdout.supported,
      contextOccupancy: capabilities.contextOccupancyUsage.supported
    },
    containment: {
      brokerWorktree: capabilities.worktreeSupport.supported,
      mode: capabilities.worktreeSupport.mode
    }
  };
}

export function scheduleAttemptWorkflow(providerOrJob, workflow, options = {}) {
  const definition = attemptDriverDefinition(
    typeof providerOrJob === 'object' ? attemptLane(providerOrJob) : providerOrJob,
    options.transport
  );
  const required = options.requiredCapabilities || WORKFLOW_REQUIREMENTS[workflow];
  if (!required) throw brokerError('INVALID_REQUEST', `Unknown attempt workflow: ${workflow}`, { provider: definition.provider });
  for (const name of required) {
    if (!ATTEMPT_CAPABILITIES.includes(name)) {
      throw brokerError('INVALID_REQUEST', `Unknown attempt-driver capability: ${name}`, { provider: definition.provider });
    }
    const entry = definition.capabilities[name];
    if (!entry.supported) {
      const reason = `lane ${definition.id} lacks required capability '${name}' for workflow '${workflow}' (${entry.mode}: ${entry.evidence.detail})`;
      if (options.preserveError) {
        throw brokerError(options.preserveError.code, options.preserveError.message, {
          provider: definition.provider,
          capability: name,
          lane: definition.id,
          workflow,
          capabilityReason: reason
        });
      }
      throw brokerError('UNSUPPORTED_STRATEGY', reason, {
        provider: definition.provider,
        capability: name,
        lane: definition.id,
        workflow
      });
    }
  }
  return {
    ok: true,
    lane: definition.id,
    workflow,
    requiredCapabilities: [...required],
    scheduling: schedulingProfile(definition)
  };
}

export function legacyProviderCapabilities(providerOrJob, transport = null) {
  const definition = attemptDriverDefinition(
    typeof providerOrJob === 'object' ? attemptLane(providerOrJob) : providerOrJob,
    transport
  );
  const codex = definition.id === 'codex-app-server';
  return {
    events: true,
    transcript: 'live',
    diff: codex ? 'provider' : 'best-effort',
    files: codex ? 'provider' : 'best-effort',
    correction: definition.capabilities.sameTurnSteering.supported ? 'same-turn' : 'cancel-resume',
    cancel: true,
    resume: true,
    usage: true,
    selfEnforcesProjectHooks: codex
  };
}

export function createAttemptDriver(providerOrLane, lifecycle) {
  const definition = attemptDriverDefinition(providerOrLane);
  for (const method of ATTEMPT_DRIVER_LIFECYCLE) {
    if (typeof lifecycle?.[method] !== 'function') {
      throw new TypeError(`attempt driver ${definition.id} lifecycle method '${method}' is required`);
    }
  }
  const driver = {
    id: definition.id,
    provider: definition.provider,
    transport: definition.transport,
    capabilities: definition.capabilities,
    scheduling: schedulingProfile(definition),
    negotiate() {
      return {
        lane: definition.id,
        provider: definition.provider,
        transport: definition.transport,
        capabilities: definition.capabilities,
        scheduling: schedulingProfile(definition)
      };
    }
  };
  for (const method of ATTEMPT_DRIVER_LIFECYCLE) {
    driver[method] = (...args) => lifecycle[method](...args);
  }
  return Object.freeze(driver);
}
