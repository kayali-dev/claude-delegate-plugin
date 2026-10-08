import { expect, test, mock } from 'claude-code/testing';

const JOB = {
  id: 'native-job', provider: 'codex', model: 'gpt-6.1-sol', mode: 'review',
  status: 'running', phase: 'running', revision: 4, isOwnSession: true,
  providerEnabled: true, managed: true, isolation: 'shared', acceptance: 'undecided',
  verification: { state: 'unknown' }, changedFiles: 2, countIsLowerBound: true,
  canCancel: true, canSteer: true, canAnswer: false, pendingInput: null
};
const SNAPSHOT = {
  scope: 'session', chip: 'D 1 running · codex ?', jobs: [JOB], omittedCount: 0,
  allowance: [{ provider: 'claude', known: false }, { provider: 'codex', known: false }],
  workState: { runningCount: 1, needsReviewCount: 0, blockedCount: 0 }
};
const PANE = {
  plugin: 'delegate-router', component: 'Pane', requestId: 'delegate-router-jobs',
  viewport: { columns: 100, rows: 40 },
  props: { title: 'Delegate jobs', isFocused: true, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} }
} as const;

function setup(on, values: { question?: string, beforeAnswer?: () => Promise<void>, snapshot?: any, job?: any, surfaces?: string[], failAction?: string, failAfter?: number, errorCode?: string, usage?: any } = {}) {
  const calls: any[] = [];
  const commands: any[] = [];
  const questions: any[] = [];
  const logs: any[] = [];
  const opened: any[] = [];
  const clock = mock.clock(on);
  on('session.id', () => ({ value: 'native-session' }));
  on('session.root', () => ({ value: '/tmp/native-project' }));
  on('session.cwd', () => ({ value: '/tmp/native-project/subdir' }));
  on('session.usage', () => ({ value: values.usage || { context: {}, rateLimits: [] } }));
  on('session.surfaces', () => ({ value: values.surfaces || ['terminal'] }));
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('session.end', () => ({ sessionId: 'native-session' }));
  on('session.measure', ($, e) => ({ changed: e.changed }));
  on('classic.SessionStart', () => ({}));
  on('agent.spawn', ($, e) => ({ model: e.model || e.parentModel, agentId: 'stub-agent' }));
  on('command.register', ($, e) => { commands.push(e); return { value: undefined }; });
  on('ui.status', () => ({ value: undefined }));
  on('ui.log', ($, e) => { logs.push(e); return { value: undefined }; });
  on('ui.open', ($, e) => { opened.push(e); return { value: undefined }; });
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e) => {
    questions.push(e.questions[0]);
    await values.beforeAnswer?.();
    return { result: { answers: { [e.questions[0].question]: values.question || 'Keep running' } } };
  });
  on('process.run', ($, e) => {
    calls.push(e);
    const action = e.argv[2];
    if (action === values.failAction && calls.filter((call) => call.argv[2] === action).length > (values.failAfter || 0)) {
      return { value: { exitCode: 1, stdout: JSON.stringify({ ok: false, error: { code: values.errorCode || 'REVISION_CONFLICT' } }), stderr: '' } };
    }
    const result = action === 'snapshot' ? values.snapshot || SNAPSHOT
      : action === 'inspect' ? values.job || JOB
        : action === 'diff' ? { diff: 'diff --git a/a b/a\n+changed', nextOffset: null }
          : action === 'usage' ? { captured: 0 } : { commandId: 'native-command' };
    return { value: { exitCode: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' } };
  });
  return { calls, commands, questions, logs, opened, clock };
}

test('native startup registers immediate commands and status requires no model call', async ($, on) => {
  const { commands, calls } = setup(on);
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  const answer = await $.command.run({ command: 'delegate-status', args: '' });
  expect(answer.text).toContain('native-job');
  expect(commands.length).toBe(7);
  expect(commands.every((command) => command.immediate === true)).toBe(true);
  expect(calls.every((call) => call.argv[0] === 'node' && call.argv[1].endsWith('/bin/delegate-native'))).toBe(true);
});

test('native pane renders and inspects jobs in terminal and desktop', async ($, on) => {
  setup(on);
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface });
    expect(await ui.find({ key: 'job-native-job' })).toBeDefined();
    await ui.press({ key: 'job-native-job' });
    expect(await ui.find({ key: 'cancel' })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: /at least 2/ })).toBeDefined();
    await ui.press({ key: 'tab-jobs' });
    await ui.unmount();
  }
});

test('declining cancellation never submits a control', async ($, on) => {
  const { calls } = setup(on);
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  const answer = await $.command.run({ command: 'delegate-cancel', args: 'native-job' });
  expect(answer.text).toContain('No cancellation requested');
  expect(calls.filter((call) => call.argv[2] === 'cancel').length).toBe(0);
});

test('foreign-session rows cannot expose a cancellation button', async ($, on) => {
  const foreign = { ...JOB, isOwnSession: false, canCancel: false, canAnswer: false, canSteer: false };
  const { calls } = setup(on, { snapshot: { ...SNAPSHOT, jobs: [foreign] }, job: foreign, question: 'Request cancellation' });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: /other session/ })).toBeDefined();
  await ui.press({ key: 'job-native-job' });
  expect(await ui.find({ key: 'cancel' })).toBeUndefined();
  const answer = await $.command.run({ command: 'delegate-cancel', args: 'native-job' });
  expect(answer.text).toContain('not controllable');
  expect(calls.filter((call) => call.argv[2] === 'cancel').length).toBe(0);
  await ui.unmount();
});

test('confirmed cancellation uses the fresh revision and is not presented as acknowledged', async ($, on) => {
  const { calls } = setup(on, { question: 'Request cancellation', job: { ...JOB, revision: 9 } });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  const answer = await $.command.run({ command: 'delegate-cancel', args: 'native-job' });
  const controls = calls.filter((call) => call.argv[2] === 'cancel');
  expect(controls.length).toBe(1);
  const payload = JSON.parse(controls[0].init.stdin);
  expect(payload.expectedRevision).toBe(9);
  expect(payload.confirmed).toBe(true);
  expect(payload.sessionId).toBe('native-session');
  expect(payload.commandId).toContain('native-');
  expect(answer.text).toContain('not provider acknowledgement');
});

test('revision conflicts never force or automatically retry a native control', async ($, on) => {
  const { calls } = setup(on, { question: 'Request cancellation', failAction: 'cancel' });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  const answer = await $.command.run({ command: 'delegate-cancel', args: 'native-job' });
  expect(answer.text).toContain('REVISION_CONFLICT');
  expect(answer.text).toContain('no automatic overwrite');
  expect(calls.filter((call) => call.argv[2] === 'cancel').length).toBe(1);
});

test('retries retain the same command identity while the revision and decision match', async ($, on) => {
  const { calls } = setup(on, { question: 'Request cancellation', failAction: 'cancel' });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await $.command.run({ command: 'delegate-cancel', args: 'native-job' });
  await $.command.run({ command: 'delegate-cancel', args: 'native-job' });
  const controls = calls.filter((call) => call.argv[2] === 'cancel').map((call) => JSON.parse(call.init.stdin));
  expect(controls[0].commandId).toBe(controls[1].commandId);
});

test('lost control acknowledgements keep their identity across revision changes and compaction', async ($, on) => {
  const values = { question: 'Request cancellation', failAction: 'cancel', job: { ...JOB } };
  const { calls } = setup(on, values);
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await $.command.run({ command: 'delegate-cancel', args: 'native-job' });
  values.job.revision = 5;
  values.failAction = '';
  await $.classic.SessionStart({ source: 'compact' });
  await $.command.run({ command: 'delegate-cancel', args: 'native-job' });
  const controls = calls.filter((call) => call.argv[2] === 'cancel').map((call) => JSON.parse(call.init.stdin));
  expect(controls[0].expectedRevision).toBe(4);
  expect(controls[1].expectedRevision).toBe(5);
  expect(controls[0].commandId).toBe(controls[1].commandId);
});

test('acknowledged identical steering can be a new explicit intent', async ($, on) => {
  const { calls } = setup(on, { question: 'Stay in src' });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await $.command.run({ command: 'delegate-steer', args: 'native-job' });
  await $.command.run({ command: 'delegate-steer', args: 'native-job' });
  const controls = calls.filter((call) => call.argv[2] === 'steer').map((call) => JSON.parse(call.init.stdin));
  expect(controls[0].commandId).not.toBe(controls[1].commandId);
});

for (const [choice, expected] of [['Leave pending', null], ['Accept plan', true], ['Decline plan', false]] as const) {
  test(`plan confirmation preserves the explicit human choice: ${choice}`, async ($, on) => {
    const { calls, logs } = setup(on, {
      question: choice,
      job: { ...JOB, canAnswer: true, plan: '{"paths":["src/a.ts"]}', pendingInput: { kind: 'plan-confirmation', requestId: 'plan-request' } }
    });
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
    const answer = await $.command.run({ command: 'delegate-answer', args: 'native-job' });
    const controls = calls.filter((call) => call.argv[2] === 'respond');
    expect(logs.length).toBe(1);
    expect(controls.length).toBe(expected == null ? 0 : 1);
    if (expected == null) expect(answer.text).toContain('left pending');
    else {
      const payload = JSON.parse(controls[0].init.stdin);
      expect(payload.accept).toBe(expected);
      expect(payload.requestId).toBe('plan-request');
      expect(payload.answer).toBeUndefined();
    }
  });
}

test('truncated plan evidence cannot be accepted through the native panel', async ($, on) => {
  const { calls, questions } = setup(on, {
    question: 'Accept plan', job: { ...JOB, canAnswer: true, plan: 'partial plan', evidenceTruncated: true, pendingInput: { kind: 'plan-confirmation', requestId: 'plan-request' } }
  });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  const answer = await $.command.run({ command: 'delegate-answer', args: 'native-job' });
  expect(answer.text).toContain('full evidence');
  expect(questions[0].options.some((option) => option.label === 'Accept plan')).toBe(false);
  expect(calls.filter((call) => call.argv[2] === 'respond').length).toBe(0);
});

test('ordinary questions take bounded text instead of a plan approval boolean', async ($, on) => {
  const { calls, questions } = setup(on, {
    question: 'Use the existing API', job: { ...JOB, canAnswer: true, question: 'q'.repeat(8_000), pendingInput: { kind: 'question', requestId: 'question-request' } }
  });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await $.command.run({ command: 'delegate-answer', args: 'native-job' });
  const payload = JSON.parse(calls.find((call) => call.argv[2] === 'respond').init.stdin);
  expect(payload.answer).toBe('Use the existing API');
  expect(payload.accept).toBeUndefined();
  expect(questions[0].question.length < 2_200).toBe(true);
});

test('Cursor corrections explain the restart and preserve correction text', async ($, on) => {
  const { calls, questions } = setup(on, { question: 'Stay within src', job: { ...JOB, provider: 'cursor' } });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await $.command.run({ command: 'delegate-steer', args: 'native-job' });
  expect(questions[0].question).toContain('cancels and resumes');
  expect(JSON.parse(calls.find((call) => call.argv[2] === 'steer').init.stdin).text).toBe('Stay within src');
});

test('plugin-origin invocations cannot impersonate human controls', async ($, on) => {
  const { calls, questions } = setup(on, { question: 'Request cancellation' });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  const answer = await $.command.run({ command: 'delegate-cancel', args: 'native-job', origin: { kind: 'plugin', plugin: 'delegate-router', tier: 'user' } });
  expect(answer.text).toContain('person must confirm');
  expect(questions.length).toBe(0);
  expect(calls.filter((call) => call.argv[2] === 'cancel').length).toBe(0);
});

test('plugin-origin dashboard requests cannot steal focus', async ($, on) => {
  const { opened } = setup(on);
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await $.command.run({ command: 'delegate-dashboard', args: '', origin: { kind: 'plugin', plugin: 'delegate-router', tier: 'user' } });
  expect(opened.length).toBe(0);
  await $.command.run({ command: 'delegate-dashboard', args: '' });
  expect(opened.length).toBe(1);
});

test('missing control IDs give actionable usage without asking or invoking the broker', async ($, on) => {
  const { calls, questions } = setup(on);
  const answer = await $.command.run({ command: 'delegate-answer', args: '' });
  expect(answer.text).toContain('Usage: /delegate-answer <job-id>');
  expect(calls.length).toBe(0);
  expect(questions.length).toBe(0);
});

test('the native renderer leaves other pane IDs untouched', async ($, on) => {
  setup(on);
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['Other plugin panel'] }));
  const ui = await $.ui.mount({ ...PANE, plugin: 'other-plugin', requestId: 'other-plugin-jobs', surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: 'Other plugin panel' })).toBeDefined();
  expect(await ui.find({ key: 'scope' })).toBeUndefined();
  await ui.unmount();
});

test('a clear during confirmation prevents submitting the old session action', async ($, on) => {
  const { calls } = setup(on, { question: 'Request cancellation', beforeAnswer: async () => { await $.classic.SessionStart({ source: 'clear' }); } });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  const answer = await $.command.run({ command: 'delegate-cancel', args: 'native-job' });
  expect(answer.text).toContain('changed while awaiting');
  expect(calls.filter((call) => call.argv[2] === 'cancel').length).toBe(0);
});

test('unsupported surfaces use text status and never open a pane', async ($, on) => {
  const { opened } = setup(on, { surfaces: ['vscode'] });
  await $.session.start({ surface: 'vscode', isInteractive: true, cwd: '/tmp/native-project' });
  const answer = await $.command.run({ command: 'delegate-dashboard', args: '' });
  expect(answer.text).toContain('native-job');
  expect(opened.length).toBe(0);
});

test('failed refresh keeps prior evidence visibly stale', async ($, on) => {
  setup(on, { failAction: 'snapshot', failAfter: 1 });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  const answer = await $.command.run({ command: 'delegate-status', args: '' });
  expect(answer.text).toContain('native-job');
  expect(answer.text).toContain('may be stale');
});

test('native usage forwards only official allowance windows, not cost, context or credentials', async ($, on) => {
  const { calls } = setup(on, { usage: { rateLimits: [{ kind: 'five_hour', percentUsed: 40, credential: 'secret-nested' }, { kind: 'context', percentUsed: 90 }], cost: { totalUsd: 99 }, context: { used: 5000 }, credential: 'secret' } });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  const payload = JSON.parse(calls.find((call) => call.argv[2] === 'usage').init.stdin);
  expect(Object.keys(payload.usage).join(',')).toBe('rateLimits');
  expect(JSON.stringify(payload)).not.toContain('secret');
  expect(payload.usage.rateLimits.length).toBe(1);
});

test('reviewer quota guard refuses only this plugin agent and never changes an explicit model', async ($, on) => {
  setup(on, { snapshot: { ...SNAPSHOT, allowance: [{ provider: 'claude', known: true, usedPercent: 95, avoidPercent: 90 }] } });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  const input = { prompt: 'Review src', description: 'Review', subagentType: 'delegate-router:reviewer', model: 'opus', parentModel: 'sonnet', provider: { plugin: 'delegate-router', tier: 'user' }, background: false, fork: false } as const;
  const denied = await $.agent.spawn(input);
  expect(denied.deny).toContain('avoid threshold');
  const allowed = await $.agent.spawn({ ...input, subagentType: 'Explore' });
  expect(allowed.model).toBe('opus');
});

test('clear rehydrates scoped state without preserving a selected job', async ($, on) => {
  setup(on);
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  await ui.press({ key: 'job-native-job' });
  await $.classic.SessionStart({ source: 'clear' });
  await ui.press({ key: 'tab-detail' });
  expect(await ui.find({ type: 'Text', text: /Select a job/ })).toBeDefined();
  expect(await ui.find({ key: 'cancel' })).toBeUndefined();
  await ui.unmount();
});

test('a fresh clear or compact hook restores commands without a native start event', async ($, on) => {
  const { commands, calls } = setup(on);
  await $.classic.SessionStart({ source: 'compact' });
  expect(commands.length).toBe(7);
  expect(calls.some((call) => call.argv[2] === 'snapshot')).toBe(true);
  const answer = await $.command.run({ command: 'delegate-status', args: '' });
  expect(answer.text).toContain('native-job');
});

test('scope changes clear the selected job and request an explicit broader read', async ($, on) => {
  const { calls } = setup(on);
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  await ui.press({ key: 'job-native-job' });
  await ui.select({ key: 'scope', value: 'workspace' });
  const snapshots = calls.filter((call) => call.argv[2] === 'snapshot');
  expect(JSON.parse(snapshots[snapshots.length - 1].init.stdin).scope).toBe('workspace');
  await ui.press({ key: 'tab-detail' });
  expect(await ui.find({ key: 'cancel' })).toBeUndefined();
  await ui.unmount();
});

test('metadata polling stops at session end and restarts after clear', async ($, on) => {
  const { calls, clock } = setup(on);
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await clock.advance(5_000);
  expect(calls.filter((call) => call.argv[2] === 'snapshot').length).toBe(2);
  await $.session.end({ reason: 'clear' });
  await clock.advance(10_000);
  expect(calls.filter((call) => call.argv[2] === 'snapshot').length).toBe(2);
  await $.classic.SessionStart({ source: 'clear' });
  await clock.advance(5_000);
  expect(calls.filter((call) => call.argv[2] === 'snapshot').length).toBe(4);
});

test('unchanged allowance readings are deduplicated briefly, then refreshed', async ($, on) => {
  const { calls, clock } = setup(on, { usage: { context: {}, rateLimits: [{ kind: 'five_hour', percentUsed: 40 }] } });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  const measure = { context: {}, rateLimits: [{ kind: 'five_hour', percentUsed: 40 }], changed: ['context'] } as const;
  await $.session.measure(measure);
  expect(calls.filter((call) => call.argv[2] === 'usage').length).toBe(1);
  await clock.advance(60_000);
  await $.session.measure(measure);
  expect(calls.filter((call) => call.argv[2] === 'usage').length).toBe(2);
});

test('repeated allowance capture failures produce one fallback notice', async ($, on) => {
  const { logs } = setup(on, { failAction: 'usage' });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await $.session.measure({ context: {}, rateLimits: [], changed: ['context'] });
  await $.session.measure({ context: {}, rateLimits: [], changed: ['context'] });
  expect(logs.length).toBe(1);
});

test('managed MCP starts stamp the live coordinator instead of a stale MCP session', async ($, on) => {
  setup(on);
  const starts: any[] = [];
  on('tool.call', ($, e) => { starts.push(e); return { result: { id: 'stub-job' } }; });
  await $.classic.SessionStart({ source: 'clear' });
  const original = { provider: 'codex', prompt: 'Review src', cwd: '/tmp/worker-tree', sandbox: 'auto', network: false,
    origin: { projectDir: '/stale', sessionId: 'stale' }, originSessionId: 'stale' };
  for (const name of ['delegate_start', 'delegate_start_trivial']) {
    await $.tool.call({ tool: `mcp__harness__plugin_delegate-router_delegate_control__${name}`, ...original });
  }
  expect(starts.length).toBe(2);
  for (const args of starts) {
    expect(args.origin).toBeUndefined();
    expect(args.originSessionId).toBe('native-session');
    expect(args.originProjectDir).toBe('/tmp/native-project');
    expect(args.originCwd).toBe('/tmp/native-project/subdir');
    expect(args.cwd).toBe('/tmp/worker-tree');
    expect(args.sandbox).toBe('auto');
    expect(args.network).toBe(false);
    expect(args.prompt).toBe('Review src');
  }
  await $.tool.call({ tool: 'mcp__other_provider__delegate_start', ...original });
  expect(starts[2].originSessionId).toBe('stale');
});
