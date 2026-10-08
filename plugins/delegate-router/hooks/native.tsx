import { NATIVE_PANE, nativeOptions, nativeUsagePayload, overviewText, jobDetailText, reviewerGuardDecision } from './native-view.mjs';

let options;
let snapshot;
let detail;
let diff;
let selected;
let scope = 'session';
let tab = 'jobs';
let busy = false;
let error = '';
let timer;
let refreshPending;
let generation = 0;
let active = true;
let usageFingerprint;
let usageCapturedAt;
let usageWarning = false;
let detailRequest = 0;
let sequence = 0;
const commandIds = new Map();

async function registerCommands($) {
  await $.command.register({ name: 'delegate-dashboard', description: 'Open native delegation jobs and controls', immediate: true });
  await $.command.register({ name: 'delegate-status', description: 'Show scoped delegation status without a model turn', immediate: true });
  await $.command.register({ name: 'delegate-inspect', description: 'Inspect bounded job evidence', argumentHint: '<job-id>', immediate: true });
  await $.command.register({ name: 'delegate-diff', description: 'Show a bounded delegated diff', argumentHint: '<job-id>', immediate: true });
  await $.command.register({ name: 'delegate-answer', description: 'Answer your job or explicitly confirm its plan', argumentHint: '<job-id>', immediate: true });
  await $.command.register({ name: 'delegate-cancel', description: 'Confirm a provider-aware cancellation request', argumentHint: '<job-id>', immediate: true });
  await $.command.register({ name: 'delegate-steer', description: 'Correct your running managed job', argumentHint: '<job-id>', immediate: true });
}

async function bridge($, action, args = {}) {
  const sessionId = await $.session.id();
  const projectDir = await $.session.root();
  const result = await $.process.run(['node', `${$.plugin.root}/bin/delegate-native`, action], {
    stdin: JSON.stringify({ sessionId, projectDir, scope, ...args }), timeoutMs: 5_000
  });
  if (result.stdout.length > 160_000) throw new Error('Native response exceeds its size bound');
  const packet = JSON.parse(result.stdout);
  if (!packet.ok || result.exitCode !== 0) throw new Error(/^[A-Z_]{1,64}$/.test(packet.error?.code || '') ? packet.error.code : 'Native broker request failed');
  return packet.result;
}

async function refresh($) {
  if (!active || !options.native_enabled) return;
  if (refreshPending?.epoch === generation) return refreshPending.promise;
  const epoch = generation;
  const pending = { epoch, promise: undefined };
  pending.promise = (async () => {
    try {
      const nextSnapshot = await bridge($, 'snapshot');
      if (epoch !== generation) return;
      snapshot = nextSnapshot;
      error = '';
      if (options.compact_status) {
        const work = snapshot.workState;
        $.ui.status(work.runningCount || work.needsReviewCount || work.blockedCount ? snapshot.chip : undefined);
      }
      $.ui.invalidate('ui.render');
    } catch {
      if (epoch !== generation) return;
      error = 'Refresh failed; displayed data may be stale. CLI/MCP remain available.';
      $.ui.invalidate('ui.render');
    }
  })();
  refreshPending = pending;
  try { return await pending.promise; } finally { if (refreshPending === pending) refreshPending = undefined; }
}

async function captureUsage($, reading) {
  if (options.native_enabled && options.usage_capture) {
    const payload = nativeUsagePayload(reading);
    const fingerprint = JSON.stringify(payload);
    const now = await $.clock.now();
    if (fingerprint === usageFingerprint && now - usageCapturedAt < 60_000) return;
    try {
      await bridge($, 'usage', { usage: payload });
      usageFingerprint = fingerprint;
      usageCapturedAt = now;
    } catch {
      if (!usageWarning) $.ui.log('Native allowance capture unavailable; existing status-line/manual capture remains available.');
      usageWarning = true;
    }
  }
}

async function inspectSelected($, jobId) {
  const epoch = generation;
  const request = ++detailRequest;
  const result = await bridge($, 'inspect', { jobId });
  if (epoch !== generation || request !== detailRequest) return;
  selected = result.id;
  detail = result;
  diff = undefined;
  tab = 'detail';
  $.ui.invalidate('ui.render');
}

async function openDashboard($) {
  await refresh($);
  const surfaces = await $.session.surfaces();
  if (!surfaces.some((surface) => surface === 'terminal' || surface === 'desktop')) return { text: overviewText(snapshot) };
  await $.ui.open({ id: NATIVE_PANE, title: 'Delegate jobs', focus: true, closeOnEscape: true, columns: 56 });
  return {};
}

async function act($, action, jobId) {
  if (!jobId) return { text: `Usage: /delegate-${action === 'respond' ? 'answer' : action} <job-id>. Find IDs with /delegate-status.` };
  if (busy) return { text: 'Another native action is still pending.' };
  busy = true;
  const epoch = generation;
  $.ui.invalidate('ui.render');
  try {
    const job = await bridge($, 'inspect', { jobId });
    if (!job.isOwnSession || !job.providerEnabled) return { text: 'This job is not controllable from this session. Inspect it through CLI/MCP to coordinate explicitly.' };
    const args = { jobId, expectedRevision: job.revision, confirmed: true };
    if (action === 'cancel') {
      if (!job.canCancel) return { text: 'The job is not an active managed job.' };
      const choice = await $.ui.ask(`Request provider cancellation for ${job.id} at revision ${job.revision}?`, ['Keep running', 'Request cancellation']);
      if (choice !== 'Request cancellation') return { text: 'No cancellation requested.' };
    } else if (action === 'respond') {
      if (!job.canAnswer || !job.pendingInput) return { text: 'There is no live answerable input gate.' };
      args.requestId = job.pendingInput.requestId;
      detail = job;
      selected = jobId;
      tab = 'detail';
      $.ui.log(jobDetailText(job));
      $.ui.invalidate('ui.render');
      if (job.pendingInput.kind === 'plan-confirmation') {
        const complete = job.plan && job.plan !== 'null' && !job.evidenceTruncated;
        const choices = complete ? ['Leave pending', 'Accept plan', 'Decline plan'] : ['Leave pending', 'Decline plan'];
        const choice = await $.ui.ask(complete
          ? `After reviewing the plan evidence for ${job.id}, may it enter write mode within the recorded scope?`
          : `The plan evidence for ${job.id} is missing or truncated. Use CLI/MCP for full review; leave pending or decline?`, choices);
        if (choice === 'Accept plan' && !complete) return { text: 'Inspect the full evidence via CLI/MCP before accepting.' };
        if (!['Accept plan', 'Decline plan'].includes(choice)) return { text: 'Plan left pending; its original expiry still applies.' };
        args.accept = choice === 'Accept plan';
      } else {
        const question = (job.question || 'The worker needs your input.').slice(0, 2_000);
        const answer = await $.ui.ask(`${question}\nWhat should ${job.id} do within its existing scope?`, ['Leave pending', 'Cancel answer']);
        if (!answer.trim() || ['Leave pending', 'Cancel answer'].includes(answer)) return { text: 'Question left pending.' };
        args.answer = answer;
      }
    } else if (action === 'steer') {
      if (!job.canSteer) return { text: 'The job is not currently steerable.' };
      const answer = await $.ui.ask(`What correction should ${job.id} receive within its existing scope${job.provider === 'cursor' ? ' (Cursor cancels and resumes)' : ''}?`, ['Leave unchanged', 'Cancel correction']);
      if (!answer.trim() || ['Leave unchanged', 'Cancel correction'].includes(answer)) return { text: 'No correction submitted.' };
      args.text = answer;
    }
    if (epoch !== generation) return { text: 'Session or view scope changed while awaiting your answer. Reinspect before submitting a control.' };
    // Revision is a precondition, not intent identity: a lost intake response
    // can leave the broker at a newer revision with this command already queued.
    const key = JSON.stringify([action, jobId, args.requestId || '', args.accept ?? args.answer ?? args.text ?? '']);
    if (!commandIds.has(key)) {
      if (commandIds.size >= 64) {
        const settled = [...commandIds].find(([, entry]) => !entry.uncertain);
        if (!settled) return { text: 'Native retry memory is full of unconfirmed controls. Inspect their broker outcomes through CLI/MCP before submitting more.' };
        commandIds.delete(settled[0]);
      }
      const now = await $.clock.now();
      commandIds.set(key, { id: `native-${now}-${++sequence}`, uncertain: true });
    }
    const identity = commandIds.get(key);
    identity.uncertain = true;
    args.commandId = identity.id;
    const result = await bridge($, action, args);
    await refresh($);
    await inspectSelected($, jobId);
    identity.uncertain = false;
    // A later acknowledged correction is a new intent, even with the same text.
    // Cancellation and one request's answer remain naturally idempotent.
    if (action === 'steer') commandIds.delete(key);
    return { text: `${action} queued as ${result.commandId}. Queued is not provider acknowledgement; inspect the refreshed lifecycle.` };
  } catch (value) {
    await refresh($);
    const reason = /^[A-Z_]{1,64}$/.test(value?.message || '') ? value.message : 'request unavailable or dismissed';
    return { text: `Native action not confirmed: ${reason}. Reinspect before retrying; no automatic overwrite.` };
  } finally {
    busy = false;
    $.ui.invalidate('ui.render');
  }
}

export function register(on, values = {}) {
  options = nativeOptions(values);
  on('session.start', async ($, e, next) => {
    if (!options.native_enabled) return next(e);
    active = true;
    await registerCommands($);
    await captureUsage($, await $.session.usage());
    await refresh($);
    timer?.cancel();
    timer = $.clock.every(options.refresh_seconds * 1_000, async () => { await refresh($); });
    return next(e);
  });
  on('classic.SessionStart', async ($, e, next) => {
    generation += 1;
    active = true;
    detail = undefined;
    diff = undefined;
    selected = undefined;
    snapshot = undefined;
    error = '';
    usageFingerprint = undefined;
    usageWarning = false;
    detailRequest += 1;
    if (e.source !== 'compact') commandIds.clear();
    if (options.native_enabled) {
      scope = 'session';
      tab = 'jobs';
      await registerCommands($);
      timer?.cancel();
      timer = $.clock.every(options.refresh_seconds * 1_000, async () => { await refresh($); });
      await refresh($);
    }
    return next(e);
  }).catch(($, e, next) => next.called ? {} : next(e));
  on('session.measure', async ($, e, next) => {
    await captureUsage($, e);
    await refresh($);
    return next(e);
  });
  on('session.end', async ($, e, next) => {
    active = false;
    generation += 1;
    timer?.cancel();
    return next(e);
  });
  on('tool.call', async ($, e, next) => {
    const managedStart = e.tool.includes('__plugin_delegate-router_delegate_control__')
      && (e.tool.endsWith('__delegate_start') || e.tool.endsWith('__delegate_start_trivial'));
    if (!options.native_enabled || !managedStart) return next(e);
    // A persistent MCP process keeps its startup session ID across /clear.
    // Stamp only current coordinator metadata; never change task/permission args.
    const sessionId = await $.session.id();
    const projectDir = await $.session.root();
    const cwd = await $.session.cwd();
    return next({ ...e, origin: undefined, originSessionId: sessionId, originProjectDir: projectDir,
      originWorkspaceId: projectDir, originCwd: cwd, originLaunchedAtMs: undefined });
  });
  on('agent.spawn', { subagentType: 'delegate-router:reviewer' }, async ($, e, next) => {
    if (!options.native_enabled || !options.reviewer_guard || e.subagentType !== 'delegate-router:reviewer') return next(e);
    await captureUsage($, await $.session.usage());
    await refresh($);
    if (error) return { deny: 'Reviewer allowance guard could not refresh. Inspect usage and route explicitly; no model substitution.' };
    const reason = reviewerGuardDecision(e, snapshot, options.reviewer_guard);
    return reason ? { deny: reason } : next(e);
  }).catch(($, e, next) => ({ deny: 'Reviewer allowance guard unavailable. Inspect usage and route explicitly; no model substitution.' }));
  on('command.run', { command: 'delegate-dashboard' }, async ($, e) => e.origin?.kind === 'plugin'
    ? { text: 'Open /delegate-dashboard yourself to focus the native panel.' } : openDashboard($));
  on('command.run', { command: 'delegate-status' }, async ($) => { await refresh($); return { text: overviewText(snapshot) + (error ? `\n${error}` : '') }; });
  on('command.run', { command: 'delegate-inspect' }, async ($, e) => {
    try { await inspectSelected($, e.args.trim()); return { text: jobDetailText(detail) }; } catch { return { text: 'Job inspection unavailable; check the job ID or use CLI/MCP.' }; }
  });
  on('command.run', { command: 'delegate-diff' }, async ($, e) => {
    try { const result = await bridge($, 'diff', { jobId: e.args.trim() }); return { text: (result.diff || 'No recorded diff.') + (result.nextOffset != null ? '\nDiff truncated; use delegate-jobs diff for windowed inspection.' : '') }; } catch { return { text: 'Diff unavailable; use delegate-jobs diff for windowed inspection.' }; }
  });
  on('command.run', { command: 'delegate-answer' }, async ($, e) => e.origin?.kind === 'plugin' ? { text: 'A person must answer the pending decision.' } : act($, 'respond', e.args.trim()));
  on('command.run', { command: 'delegate-cancel' }, async ($, e) => e.origin?.kind === 'plugin' ? { text: 'A person must confirm cancellation.' } : act($, 'cancel', e.args.trim()));
  on('command.run', { command: 'delegate-steer' }, async ($, e) => e.origin?.kind === 'plugin' ? { text: 'A person must supply the correction.' } : act($, 'steer', e.args.trim()));
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== NATIVE_PANE || !options.native_enabled) return next(e);
    const { Box, Text, Button, Select, Code } = $.ui.resolve(e);
    return <Box flexDirection="column" gap={1}>
      <Box gap={1}>
        <Button key="tab-jobs" label="Jobs" onPress={() => {}} />
        <Button key="tab-detail" label="Details" onPress={() => {}} />
        <Button key="tab-diff" label="Diff" onPress={() => {}} />
        <Button key="refresh" label="Refresh" onPress={() => {}} />
      </Box>
      <Select key="scope" label="View scope" value={scope} options={[{ label: 'This session', value: 'session' }, { label: 'Workspace (read-only for other sessions)', value: 'workspace' }, { label: 'All jobs (read-only for other sessions)', value: 'all' }]} onSelect={() => {}} />
      <Text dimColor>{snapshot?.chip || 'Loading local job state…'}</Text>
      {error ? <Text color="yellow">{error}</Text> : null}
      {busy ? <Text dimColor>Waiting for your answer or broker intake…</Text> : null}
      {tab === 'jobs' ? <Box flexDirection="column" gap={1}>
        <Text dimColor>{snapshot?.allowance?.map((entry) => `${entry.provider} ${entry.known ? `${entry.usedPercent}%` : '?'}`).join(' · ') || 'Allowance unknown'}</Text>
        {snapshot?.jobs?.length ? snapshot.jobs.map((job) => <Box key={job.id} flexDirection="column">
          <Button key={`job-${job.id}`} label={`${job.provider} · ${job.phase}${job.pendingInput ? ' · input needed' : ''}${job.acceptance === 'ready-for-review' ? ' · review ready' : ''}`} onPress={() => {}} />
          <Text dimColor>{job.id} · {job.model} · {job.isOwnSession ? 'this session' : 'other session'}</Text>
        </Box>) : <Text>No jobs in this scope. Delegate bounded work with /delegate-router:delegate.</Text>}
        {snapshot?.omittedCount ? <Text dimColor>{snapshot.omittedCount} older jobs omitted; CLI/MCP expose the full store.</Text> : null}
      </Box> : tab === 'diff' ? <Box flexDirection="column"><Code source={diff?.diff || 'Select a job, then open Diff.'} language="diff" />{diff?.nextOffset != null ? <Text dimColor>Diff truncated; use delegate-jobs diff for windowed inspection.</Text> : null}</Box> : <Box flexDirection="column" gap={1}>
        <Text>{jobDetailText(detail)}</Text>
        {detail?.canAnswer ? <Button key="answer" label={detail.pendingInput.kind === 'plan-confirmation' ? 'Review and decide plan' : 'Answer worker'} onPress={() => {}} /> : null}
        {detail?.canSteer ? <Button key="steer" label={detail.provider === 'cursor' ? 'Correct (cancel and resume)' : 'Correct running turn'} onPress={() => {}} /> : null}
        {detail?.canCancel ? <Button key="cancel" label="Request cancellation…" onPress={() => {}} /> : null}
      </Box>}
      <Text dimColor>Completion is not acceptance. Controls always re-inspect and require a human answer.</Text>
    </Box>;
  });
  on('ui.press', async ($, e, next) => {
    if (e.plugin !== $.plugin.name || e.requestId !== NATIVE_PANE) return next(e);
    const key = e.element;
    try {
      if (key === 'refresh') { await refresh($); if (selected) await inspectSelected($, selected); }
      else if (key.startsWith('job-')) await inspectSelected($, key.slice(4));
      else if (key === 'tab-jobs') tab = 'jobs';
      else if (key === 'tab-detail') { if (selected) await inspectSelected($, selected); else tab = 'detail'; }
      else if (key === 'tab-diff') { if (selected) { diff = await bridge($, 'diff', { jobId: selected }); tab = 'diff'; } }
      else if (['answer', 'cancel', 'steer'].includes(key) && selected) {
        const result = await act($, key === 'answer' ? 'respond' : key, selected);
        $.ui.log(result.text);
      } else return next(e);
    } catch { error = 'Native action unavailable; use the CLI/MCP fallback.'; }
    $.ui.invalidate('ui.render');
    return { element: e.element };
  });
  on('ui.select', async ($, e, next) => {
    if (e.plugin !== $.plugin.name || e.requestId !== NATIVE_PANE || e.element !== 'scope') return next(e);
    scope = ['session', 'workspace', 'all'].includes(e.value) ? e.value : 'session';
    generation += 1;
    snapshot = undefined;
    selected = undefined;
    detail = undefined;
    diff = undefined;
    tab = 'jobs';
    await refresh($);
    return { element: e.element, value: scope };
  });
}
