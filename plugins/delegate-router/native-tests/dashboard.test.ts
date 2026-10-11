import { expect, test, mock } from 'claude-code/testing';

const JOB = {
  id: 'native-job', provider: 'codex', model: 'gpt-6.1-sol', mode: 'review',
  status: 'running', phase: 'running', revision: 4, isOwnSession: true,
  providerEnabled: true, managed: true, isolation: 'shared', acceptance: 'undecided',
  verification: { state: 'unknown' }, changedFiles: 2, countIsLowerBound: true,
  canCancel: true, canSteer: true, canAnswer: false, pendingInput: null
};
const SNAPSHOT = {
  notificationMode: 'native',
  scope: 'session', chip: 'D 1 running · codex ?', jobs: [JOB], omittedCount: 0,
  allowance: [{ provider: 'claude', known: false }, { provider: 'codex', known: false }],
  workState: { runningCount: 1, needsReviewCount: 0, blockedCount: 0 }
};
const PANE = {
  plugin: 'delegate-router', component: 'Pane', requestId: 'delegate-router-jobs',
  viewport: { columns: 100, rows: 40 },
  props: { title: 'Delegate jobs', isFocused: true, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} }
} as const;

function setup(on, values: { question?: string, beforeAnswer?: () => Promise<void>, beforePrompt?: () => Promise<void>, snapshot?: any, job?: any, surfaces?: string[], failAction?: string, failAfter?: number, errorCode?: string, usage?: any, agents?: any[], agentList?: () => Promise<void>, appendDeny?: string, messages?: any[], processResult?: (action: string, payload: any) => any } = {}) {
  const calls: any[] = [];
  const commands: any[] = [];
  const questions: any[] = [];
  const logs: any[] = [];
  const opened: any[] = [];
  const appended: any[] = [];
  const prompts: any[] = [];
  const skills: any[] = [];
  const turns: any[] = [];
  const aborted: any[] = [];
  const steps: any[] = [];
  const clock = mock.clock(on);
  on('session.id', () => ({ value: 'native-session' }));
  on('session.root', () => ({ value: '/tmp/native-project' }));
  on('session.cwd', () => ({ value: '/tmp/native-project/subdir' }));
  on('session.usage', () => ({ value: values.usage || { context: {}, rateLimits: [] } }));
  on('session.surfaces', () => ({ value: values.surfaces || ['terminal'] }));
  on('agent.list', async () => { await values.agentList?.(); return { value: values.agents || [] }; });
  on('session.append', ($, e, next) => { appended.push(e); return values.appendDeny ? { deny: values.appendDeny } : next(e); });
  // Stop at prompt admission: these tests must never call a live model.
  on('prompt.submit', async ($, e) => { await values.beforePrompt?.(); prompts.push(e); return { text: e.text, origin: e.origin }; });
  on('turn.start', ($, e) => { turns.push(e); return { turnId: e.turnId }; });
  on('turn.abort', ($, e) => { aborted.push(e); return { value: undefined }; });
  on('turn.step', async function* ($, e) { steps.push(e); yield { kind: 'stop', stopReason: 'end_turn', usage: null };
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }; });
  on('session.messages', () => ({ value: values.messages || [] }));
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
  on('tool.call', { tool: 'Skill' }, ($, e) => { skills.push(e); return { result: { content: 'armed' } }; });
  on('process.run', ($, e) => {
    calls.push(e);
    const action = e.argv[2];
    if (action === values.failAction && calls.filter((call) => call.argv[2] === action).length > (values.failAfter || 0)) {
      return { value: { exitCode: 1, stdout: JSON.stringify({ ok: false, error: { code: values.errorCode || 'REVISION_CONFLICT' } }), stderr: '' } };
    }
    const result = values.processResult?.(action, JSON.parse(e.init.stdin)) ?? (action === 'snapshot' ? values.snapshot || SNAPSHOT
      : action === 'inspect' ? values.job || JOB
        : action === 'diff' ? { diff: 'diff --git a/a b/a\n+changed', nextOffset: null }
          : action === 'usage' ? { captured: 0 } : { commandId: 'native-command' });
    return { value: { exitCode: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' } };
  });
  return { calls, commands, questions, logs, opened, appended, prompts, skills, turns, aborted, steps, clock };
}

test('status does not wait behind an in-flight host-agent refresh', async ($, on) => {
  let block = false, entered, release;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const { clock, calls, logs } = setup(on, { agentList: async () => { if (block) { entered(); await held; } } });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  block = true;
  const refreshing = clock.advance(5_000);
  await started;
  try {
    const response = await $.command.run({ command: 'delegate-status', args: '' });
    expect(response.text).toContain('native-job');
    expect(calls.filter((call) => call.argv[2] === 'snapshot').length).toBe(2);
    expect(logs.some((line) => line.to === 'debug' && line.text.includes('response ready'))).toBe(true);
  } finally { release(); await refreshing; }
});

test('native notifications append observations without a new turn, then acknowledge delivery', async ($, on) => {
  const { calls, appended, logs, clock } = setup(on, { processResult: (action) => action === 'notifications'
    ? { deliveryId: 'd'.repeat(32), lines: ['delegate[project]: native-job failure (PROVIDER_ERROR)'] } : undefined });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await clock.advance(5_000);
  expect(appended.length).toBe(1);
  expect(appended[0].message.type).toBe('user');
  expect(appended[0].message.content[0].text).toContain('not human approval');
  expect(logs.filter((line) => line.text.includes('native-job failure')).length).toBe(1);
  expect(calls.filter((call) => call.argv[2] === 'notifications-ack').length).toBe(2);
  expect(calls.some((call) => /launch|enqueue|respond|steer/.test(call.argv[2]))).toBe(false);
});

test('failed native observation delivery is not acknowledged and leaves monitor fallback available', async ($, on) => {
  const { calls, logs } = setup(on, { appendDeny: 'diagnostic denial', processResult: (action) => action === 'notifications'
    ? { deliveryId: 'd'.repeat(32), lines: ['delegate[project]: job needs-input'] } : undefined });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  expect(calls.filter((call) => call.argv[2] === 'notifications-ack').length).toBe(0);
  expect(logs.some((line) => line.text.includes('delegate-router:monitor-fallback'))).toBe(true);
});

test('native default never invokes a monitor skill; explicit persistent config arms its qualified trigger', async ($, on) => {
  let mode = 'native';
  const { skills, prompts, clock } = setup(on, { processResult: (action) => action === 'notifications-health' ? { mode } : undefined });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await clock.advance(1);
  expect(skills.length).toBe(0);
  mode = 'legacy-persistent';
  await $.classic.SessionStart({ session_id: 'native-session', source: 'clear', cwd: '/tmp/native-project' });
  await clock.advance(1);
  expect(skills.length).toBe(1);
  expect(skills[0].skill).toBe('delegate-router:legacy-monitor');
  expect(prompts.length).toBe(0);
});

test('ambient notification opt-out prevents even a legacy startup probe', async ($, on) => {
  const { skills, prompts, clock } = setup(on, { processResult: (action) => action === 'notifications-health'
    ? { mode: 'legacy-persistent', ambientEnabled: false } : undefined });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await clock.advance(1);
  expect(skills.length).toBe(0);
  expect(prompts.length).toBe(0);
});

test('observation-only native setting never queues follow-up turns', { options: { native_followups: false } }, async ($, on) => {
  const { prompts, calls, clock } = setup(on, { processResult: (action) => action === 'notifications'
    ? { deliveryId: 'd'.repeat(32), lines: ['delegate[project]: input required'] } : action === 'notifications-wake'
      ? { deliveryId: 'a'.repeat(32) } : undefined });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await clock.advance(1);
  expect(prompts.length).toBe(0);
  expect(calls.some((call) => call.argv[2] === 'notifications-wake')).toBe(false);
  expect(calls.some((call) => call.argv[2] === 'notifications-ack')).toBe(true);
});

test('native follow-up admission preserves plugin attribution and cannot approve or launch work', async ($, on) => {
  const { calls, prompts, clock } = setup(on, { processResult: (action) => action === 'notifications-wake'
    ? { deliveryId: 'a'.repeat(32) } : action === 'notifications-wake-check'
      ? { allowed: true, jobIds: ['native-job'] } : undefined });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await clock.advance(1);
  expect(prompts.length).toBe(1);
  expect(prompts[0].origin).toEqual({ kind: 'plugin', name: 'delegate-router' });
  await $.turn.start({ turnId: 'automatic-turn', text: 'The delegate-router plugin sent a message:\n' + prompts[0].text });
  expect(calls.filter((call) => call.argv[2] === 'notifications-wake-check').length).toBe(1);
  expect(prompts[0].origin.kind).toBe('plugin');
  expect(prompts[0].origin.name).toBe('delegate-router');
  expect(prompts[0].text).toContain('ask the human');
  expect(prompts[0].text).toContain('Completion is not acceptance');
  expect(calls.some((call) => /^(launch|enqueue|respond|cancel|steer)$/.test(call.argv[2]))).toBe(false);
});

test('resolved or quota-ineligible native wake is dropped before model admission', async ($, on) => {
  const { prompts, calls, clock, turns, aborted } = setup(on, { processResult: (action) => action === 'notifications-wake'
    ? { deliveryId: 'a'.repeat(32) } : action === 'notifications-wake-check'
      ? { allowed: false, jobIds: [] } : undefined });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await clock.advance(1);
  await $.turn.start({ turnId: 'automatic-turn', text: 'The delegate-router plugin sent a message:\n' + prompts[0].text });
  expect(calls.filter((call) => call.argv[2] === 'notifications-wake-check').length).toBe(1);
  expect(turns.length).toBe(0);
  expect(aborted.length).toBe(1);
});

async function drainStep(stream) {
  let item;
  do { item = await stream.next(); } while (!item.done);
  return item.value;
}

test('automatic follow-up checks headroom before every request and stops after four requests', async ($, on) => {
  const current = { ...SNAPSHOT, allowance: [{ provider: 'claude', known: true, usedPercent: 20, avoidPercent: 85 }] };
  const { prompts, steps, clock } = setup(on, { snapshot: current, processResult: (action) => action === 'notifications-wake'
    ? { deliveryId: 'c'.repeat(32), jobIds: ['native-job'] } : action === 'notifications-wake-check'
      ? { allowed: true, jobIds: ['native-job'] } : undefined });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await clock.advance(1);
  await $.turn.start({ turnId: 'bounded-follow-up', text: 'The delegate-router plugin sent a message:\n' + prompts[0].text });
  for (let index = 0; index < 5; index++) {
    const result = await drainStep($.turn.step({ turnId: 'bounded-follow-up', index, model: 'claude-opus-5-5', messageCount: 1 }));
    expect(result.stopReason).toBe('end_turn');
  }
  expect(steps.length).toBe(4);
});

for (const reason of ['quota', 'mode', 'clear']) {
  test(`automatic follow-up stops before another request after ${reason} changes`, async ($, on) => {
    const current = { ...SNAPSHOT, allowance: [{ provider: 'claude', known: true, usedPercent: 20, avoidPercent: 85 }] };
    const { prompts, steps, clock } = setup(on, { snapshot: current, processResult: (action) => action === 'notifications-wake'
      ? { deliveryId: 'e'.repeat(32), jobIds: ['native-job'] } : action === 'notifications-wake-check'
        ? { allowed: true, jobIds: ['native-job'] } : undefined });
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
    await clock.advance(1);
    await $.turn.start({ turnId: 'guarded-follow-up', text: 'The delegate-router plugin sent a message:\n' + prompts[0].text });
    await drainStep($.turn.step({ turnId: 'guarded-follow-up', index: 0, model: 'claude-opus-5-5', messageCount: 1 }));
    if (reason === 'quota') current.allowance[0].usedPercent = 99;
    else if (reason === 'mode') current.notificationMode = 'off';
    else await $.classic.SessionStart({ session_id: 'new-session', source: 'clear', cwd: '/tmp/native-project' });
    await drainStep($.turn.step({ turnId: 'guarded-follow-up', index: 1, model: 'claude-opus-5-5', messageCount: 1 }));
    expect(steps.length).toBe(1);
    await $.turn.start({ turnId: 'human-turn', text: 'A normal human request' });
    await drainStep($.turn.step({ turnId: 'human-turn', index: 0, model: 'claude-opus-5-5', messageCount: 1 }));
    expect(steps.length).toBe(2);
  });
}

test('a queued follow-up from before clear is refused even if the host adds its plugin wrapper', async ($, on) => {
  const { prompts, turns, aborted, clock } = setup(on, { processResult: (action) => action === 'notifications-wake'
    ? { deliveryId: 'f'.repeat(32), jobIds: ['native-job'] } : undefined });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await clock.advance(1);
  const oldPrompt = prompts[0].text;
  await $.classic.SessionStart({ session_id: 'new-session', source: 'clear', cwd: '/tmp/native-project' });
  await $.turn.start({ turnId: 'stale-follow-up', text: 'The delegate-router plugin sent a message:\n' + oldPrompt });
  expect(turns.length).toBe(0);
  expect(aborted.length).toBe(1);
});

test('one outstanding native submission does not block polling or accumulate more prompts', async ($, on) => {
  let release;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const { prompts, calls, clock } = setup(on, { beforePrompt: () => held, processResult: (action) => action === 'notifications-wake'
    ? { deliveryId: 'b'.repeat(32) } : action === 'notifications-wake-check'
      ? { allowed: true, jobIds: ['native-job'] } : undefined });
  try {
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
    await clock.advance(15_000);
    expect(calls.filter((call) => call.argv[2] === 'notifications-wake').length).toBe(1);
    expect(calls.filter((call) => call.argv[2] === 'snapshot').length > 1).toBe(true);
    expect(prompts.length).toBe(0);
  } finally { release(); }
});

test('failed native notifications queue model-managed recovery only with live unhealthy work and headroom', async ($, on) => {
  const current = { ...SNAPSHOT, allowance: [{ provider: 'claude', known: true, usedPercent: 30, avoidPercent: 85 }] };
  const { prompts, calls, clock } = setup(on, { snapshot: current, failAction: 'notifications', processResult: (action) => action === 'notifications-health'
    ? { needsFallback: true, native: 'expired', mode: 'native', liveJobCount: 1 } : undefined });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await clock.advance(30_000);
  expect(prompts.length).toBe(1);
  expect(prompts[0].text).toContain('delegate-router:monitor-fallback');
  expect(prompts[0].origin.kind).toBe('plugin');
  expect(calls.some((call) => call.argv[2] === 'launch')).toBe(false);
});

test('native startup registers immediate commands and status requires no model call', async ($, on) => {
  const { commands, calls } = setup(on);
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  const answer = await $.command.run({ command: 'delegate-status', args: '' });
  expect(answer.text).toContain('native-job');
  expect(commands.length).toBe(13);
  expect(commands.every((command) => command.immediate === true)).toBe(true);
  expect(calls.every((call) => call.argv[0] === 'node' && call.argv[1].endsWith('/bin/delegate-native'))).toBe(true);
});

test('human status output uses immediately painted logs without a duplicate delayed result', async ($, on) => {
  const { logs } = setup(on, { snapshot: { ...SNAPSHOT, jobs: [] } });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  const answer = await $.command.run({ command: 'delegate-status', args: '', origin: { kind: 'composer' } });
  expect(answer.text).toBeUndefined();
  expect(logs.filter((entry) => entry.to !== 'debug' && entry.text.includes('No jobs in this scope.')).length).toBe(1);
  expect(logs.filter((entry) => entry.to !== 'debug').every((entry) => !entry.text.includes('\n'))).toBe(true);
  const sdk = await $.command.run({ command: 'delegate-status', args: '', origin: { kind: 'sdk' } });
  expect(sdk.text).toContain('No jobs in this scope.');
});

const PREVIEW = { id: 'preview-1234', provider: 'codex', model: 'gpt-6.1-sol', mode: 'review', isolation: 'shared',
  timeoutSeconds: 3600, maxOutputTokens: 16384, scope: [], packet: 'Exact public packet', verification: null, warnings: [], contextChars: 0 };

test('native tabs expose selection and hotkeys while advanced budgets stay collapsed', async ($, on) => {
  setup(on);
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await $.command.run({ command: 'delegate-new', args: '' });
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await ui.find({ key: 'tab-new', label: '● New task', plain: true, hotkey: 'n' })).toBeDefined();
  expect(await ui.find({ key: 'draft-timeoutSeconds' })).toBeUndefined();
  await ui.press({ key: 'draft-advanced' });
  expect(await ui.find({ key: 'draft-timeoutSeconds' })).toBeDefined();
  await ui.press({ key: 'draft-advanced' });
  expect(await ui.find({ key: 'draft-timeoutSeconds' })).toBeUndefined();
  await ui.unmount();
});

test('native details use collapsible evidence and host diff/report renderers', async ($, on) => {
  setup(on, { job: { ...JOB, resultText: '# Findings\n\nVerified report.', plan: 'Plan body' } });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await $.command.run({ command: 'delegate-inspect', args: 'native-job' });
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' });
  expect(await ui.find({ type: 'Markdown', text: /Verified report/ })).toBeDefined();
  expect(await ui.find({ type: 'Markdown', text: 'Plan body' })).toBeUndefined();
  await ui.press({ key: 'expand-plan' });
  expect(await ui.find({ type: 'Markdown', text: 'Plan body' })).toBeDefined();
  await ui.press({ key: 'tab-diff' });
  expect(await ui.find({ type: 'Code', format: 'diff' })).toBeDefined();
  await ui.press({ key: 'refresh' });
  expect(await ui.find({ key: 'evidence-view' })).toBeDefined();
  await ui.unmount();
});

test('composer previews before launch, refuses dismissal, and invalidates approval on draft edit', async ($, on) => {
  const { calls } = setup(on, { question: 'Leave draft', processResult: (action) => action === 'preview' ? PREVIEW : undefined });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await $.command.run({ command: 'delegate-new', args: '' });
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await ui.find({ key: 'draft-launch' })).toBeUndefined();
  await ui.input({ key: 'draft-objective', text: 'Inspect the parser' });
  await ui.input({ key: 'draft-acceptance', text: 'Report verified findings' });
  await ui.press({ key: 'draft-preview' });
  expect(await ui.find({ key: 'draft-launch' })).toBeDefined();
  expect(await ui.find({ type: 'Code', source: /Exact public packet/ })).toBeDefined();
  await ui.press({ key: 'draft-launch' });
  expect(calls.filter((call) => call.argv[2] === 'launch').length).toBe(0);
  await ui.input({ key: 'draft-objective', text: 'Changed scope' });
  expect(await ui.find({ key: 'draft-launch' })).toBeUndefined();
  const payload = JSON.parse(calls.find((call) => call.argv[2] === 'preview').init.stdin);
  expect(payload.draft.objective).toBe('Inspect the parser');
  expect(payload.draft.context.length).toBe(0);
  await ui.unmount();
});

for (const queued of [false, true]) {
  test(`human ${queued ? 'queue approval' : 'launch approval'} uses the preview identity without a Claude turn`, async ($, on) => {
    const { calls, questions } = setup(on, { question: queued ? 'Approve pending job' : 'Launch task', processResult: (action) => action === 'preview' ? PREVIEW : action === 'launch' ? { jobId: 'native-job' } : undefined });
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
    await $.command.run({ command: 'delegate-new', args: '' });
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
    await ui.press({ key: 'draft-preview' });
    await ui.press({ key: queued ? 'draft-enqueue' : 'draft-launch' });
    const payload = JSON.parse(calls.find((call) => call.argv[2] === (queued ? 'enqueue' : 'launch')).init.stdin);
    expect(payload.previewId).toBe(PREVIEW.id); expect(payload.confirmed).toBe(true);
    expect(payload.draft).toBeUndefined();
    if (queued) expect(questions[0].question).toContain('eight hours');
    await ui.unmount();
  });
}

test('session clear during task confirmation prevents launch or queue submission', async ($, on) => {
  const { calls } = setup(on, { question: 'Launch task', processResult: (action) => action === 'preview' ? PREVIEW : undefined,
    beforeAnswer: async () => { await $.classic.SessionStart({ source: 'clear' }); } });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await $.command.run({ command: 'delegate-new', args: '' });
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  await ui.press({ key: 'draft-preview' }); await ui.press({ key: 'draft-launch' });
  expect(calls.filter((call) => ['launch', 'enqueue'].includes(call.argv[2])).length).toBe(0);
  await ui.unmount();
});

test('conversation inspector exports only explicitly selected redacted public text', async ($, on) => {
  const { calls } = setup(on, { messages: [{ role: 'assistant', text: 'Useful public context API_KEY=sk-12345678901234567890', reasoning: 'hidden', toolUses: [{ input: 'private-tool' }] }] });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await $.command.run({ command: 'delegate-context', args: '' });
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  await ui.press({ key: 'context-excerpt-0' }); await ui.press({ key: 'tab-new' }); await ui.press({ key: 'draft-preview' });
  const payload = JSON.parse(calls.find((call) => call.argv[2] === 'preview').init.stdin);
  expect(payload.draft.context.length).toBe(1);
  expect(payload.draft.context[0].text).toContain('Useful public context');
  expect(JSON.stringify(payload)).not.toContain('sk-12345678901234567890');
  expect(JSON.stringify(payload)).not.toContain('private-tool'); expect(JSON.stringify(payload)).not.toContain('hidden');
  await ui.unmount();
});

test('native catalog observation keeps status metadata but not prompts or reasoning', async ($, on) => {
  const { calls, opened } = setup(on, { agents: [{ id: 'native-agent', status: 'waiting', type: 'Explore', description: 'Inspect', prompt: 'private-prompt', reasoning: 'hidden' }] });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  const payload = JSON.parse(calls.find((call) => call.argv[2] === 'agents').init.stdin);
  expect(payload.agents[0].status).toBe('waiting'); expect(payload.agents[0].id).toBe('native-agent');
  expect(JSON.stringify(payload)).not.toContain('private-prompt'); expect(JSON.stringify(payload)).not.toContain('hidden');
  expect(opened.length).toBe(0);
});

test('native evidence pages preserve the content version and changed-file selection', async ($, on) => {
  const { calls } = setup(on, { processResult: (action, input) => action === 'diff' ? { diff: input.offset ? 'second page' : 'first page', offset: input.offset || 0, nextOffset: input.offset ? null : 32000, evidenceVersion: 'digest', files: [{ path: 'src/a.ts' }] } : undefined });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await $.command.run({ command: 'delegate-review', args: 'native-job' });
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  await ui.press({ key: 'evidence-next' });
  const pages = calls.filter((call) => call.argv[2] === 'diff').map((call) => JSON.parse(call.init.stdin));
  expect(pages[1].offset).toBe(32000); expect(pages[1].evidenceVersion).toBe('digest');
  await ui.select({ key: 'evidence-file', value: 'src/a.ts' });
  const last = JSON.parse(calls.filter((call) => call.argv[2] === 'diff').at(-1).init.stdin);
  expect(last.offset).toBe(0); expect(last.file).toBe('src/a.ts');
  await ui.unmount();
});

test('same-workspace supervision claim needs a human answer and fresh revision', async ($, on) => {
  const { calls } = setup(on, { question: 'Claim supervision', job: { ...JOB, isOwnSession: false, canClaim: true, revision: 8 }, processResult: (action) => action === 'claim' ? { revision: 9 } : undefined });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await $.command.run({ command: 'delegate-claim', args: 'native-job' });
  const payload = JSON.parse(calls.find((call) => call.argv[2] === 'claim').init.stdin);
  expect(payload.expectedRevision).toBe(8); expect(payload.confirmed).toBe(true);
  expect(payload.commandId).toContain('native-');
});

test('attention band exposes inspection without automatically opening a panel', async ($, on) => {
  const { opened } = setup(on, { snapshot: { ...SNAPSHOT, jobs: [{ ...JOB, pendingInput: { requestId: 'q1' } }] } });
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', props: {}, children: ['Another plugin status'] }));
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  const ui = await $.ui.mount({ plugin: 'delegate-router', component: 'AbovePrompt', requestId: 'AbovePrompt', surface: 'terminal', viewport: PANE.viewport,
    props: { hasSurvey: false, isWorking: true, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 8 }, view: {} } });
  expect(await ui.find({ key: 'inspect-native-job' })).toBeDefined(); expect(opened.length).toBe(0);
  expect(await ui.find({ type: 'Text', text: 'Another plugin status' })).toBeDefined();
  await ui.press({ key: 'inspect-native-job' }); expect(opened.length).toBe(1);
  await ui.unmount();
});

test('inline managed-tool cards preserve core output and open only on user inspection', async ($, on) => {
  const { opened } = setup(on);
  on('tool.call', { tool: 'mcp__plugin_delegate-router_delegate_control__delegate_start' }, () => ({ result: { id: 'native-job' } }));
  on('ui.render', { component: 'ToolResult' }, () => ({ type: 'Text', props: {}, children: ['Original tool evidence'] }));
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await $.tool.call({ tool: 'mcp__plugin_delegate-router_delegate_control__delegate_start', tool_use_id: 'tool-card-1', prompt: 'Review' });
  const ui = await $.ui.mount({ plugin: 'delegate-router', component: 'ToolResult', requestId: 'tool-card-1', surface: 'terminal', viewport: PANE.viewport,
    props: { tool_use_id: 'tool-card-1', tool: 'mcp__plugin_delegate-router_delegate_control__delegate_start', output: { id: 'native-job' }, isErrored: false } });
  expect(await ui.find({ type: 'Text', text: 'Original tool evidence' })).toBeDefined();
  expect(await ui.find({ key: 'inspect-native-job' })).toBeDefined(); expect(opened.length).toBe(0);
  await ui.press({ key: 'inspect-native-job' }); expect(opened.length).toBe(1);
  await ui.unmount();
});

test('native queue controls hide foreign entries and preserve fresh revisions', async ($, on) => {
  const { calls } = setup(on, { question: 'Cancel pending job', snapshot: { ...SNAPSHOT, queue: [
    { id: 'own', provider: 'codex', model: 'sol', state: 'pending', priority: 0, revision: 3, isOwnSession: true },
    { id: 'foreign', provider: 'cursor', model: 'composer', state: 'pending', revision: 1, isOwnSession: false } ] } });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await $.command.run({ command: 'delegate-queue', args: '' });
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await ui.find({ key: 'queue-cancel-foreign' })).toBeUndefined();
  await ui.press({ key: 'queue-cancel-own' });
  const payload = JSON.parse(calls.find((call) => call.argv[2] === 'queue-control').init.stdin);
  expect(payload.queueId).toBe('own'); expect(payload.expectedRevision).toBe(3); expect(payload.confirmed).toBe(true);
  await ui.unmount();
});

test('native agent-spawn binding observes the exact tool id without copying the prompt', async ($, on) => {
  const { calls } = setup(on);
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await $.agent.spawn({ prompt: 'Do not retain this private prompt', description: 'Inspect', subagentType: 'Explore', parentModel: 'sonnet', background: true, fork: false, tool_use_id: 'toolu-exact-1' });
  const payload = JSON.parse(calls.find((call) => call.argv[2] === 'agent-bind').init.stdin);
  expect(payload.spawn.toolUseId).toBe('toolu-exact-1'); expect(payload.spawn.agentId).toBe('stub-agent');
  expect(JSON.stringify(payload)).not.toContain('Do not retain');
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
  const { clock } = setup(on, { failAction: 'snapshot', failAfter: 1 });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/tmp/native-project' });
  await clock.advance(5_000);
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
  expect(commands.length).toBe(13);
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
