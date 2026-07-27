import { useTuiTestHarness } from './helpers/tui-test-harness.mjs';
await useTuiTestHarness(import.meta.url);

import assert from 'node:assert/strict';
import test from 'node:test';
import { paintFrame, renderFrameToString } from '../bin/lib/tui/components.mjs';
import { configureGlyphs } from '../bin/lib/tui/glyphs.mjs';
import { setUiTheme } from '../bin/lib/tui/palette.mjs';
import { WORK_TABS, workViewModel } from '../bin/lib/tui/viewmodels.mjs';

const NOW = 1_700_000_000_000;

function attempt(overrides = {}) {
  return {
    id: 'codex-root-1111111',
    rootJobId: 'codex-root-1111111',
    provider: 'codex',
    model: 'sol',
    resolvedModel: 'gpt-5.4-sol',
    mode: 'implement',
    status: 'completed',
    phase: 'completed',
    revision: 5,
    cwd: '/workspace/project',
    createdAt: NOW / 1000 - 120,
    updatedAt: NOW / 1000,
    completedAt: NOW / 1000,
    durationMs: 120_000,
    baseRevision: 'base-abc123',
    managedBy: 'delegate-control',
    providerSessionId: 'thread-1',
    allowedPaths: ['src/**', 'test/**'],
    workSpec: {
      schemaVersion: 1,
      objective: 'Build the WorkItem cockpit',
      scopeClaim: ['src/**', 'test/**'],
      acceptanceCriteria: ['All cockpit frames remain bounded'],
      verifyRecipe: { schemaVersion: 1, command: 'node --test test/*.test.mjs', timeoutSeconds: 600 },
      budget: { schemaVersion: 1, wallTimeSeconds: 900, maxRounds: 3, maxOutputTokens: 8_000 },
      base: { schemaVersion: 1, revision: 'base-abc123', dirtyHashes: {} }
    },
    specCompilation: {
      confirmed: false,
      unresolved: ['scopeClaim'],
      fields: {
        objective: {
          value: 'Build the WorkItem cockpit',
          confidence: 'high',
          status: 'explicit',
          provenance: [{ kind: 'owner-decision', source: 'task packet', detail: 'The objective is owner-authored.' }]
        },
        scopeClaim: {
          value: null,
          confidence: 'low',
          status: 'unresolved',
          provenance: [{ kind: 'intent:sentence', source: 'task packet', detail: 'No safe write boundary was inferred.' }]
        }
      },
      authority: {
        allowedPaths: {
          value: [],
          confidence: 'low',
          status: 'unresolved'
        }
      }
    },
    changedFiles: {
      count: 2,
      files: ['src/cockpit.mjs', 'test/cockpit.test.mjs'],
      entries: [{ path: 'src/cockpit.mjs' }, { path: 'test/cockpit.test.mjs' }]
    },
    verificationOrigin: 'broker-real-tree',
    verification: { state: 'failed', exitCode: 1, command: 'node --test test/*.test.mjs' },
    acceptance: {
      state: 'blocked',
      blockedBy: ['verification-failed'],
      evidence: { verification: { state: 'failed', exitCode: 1 }, baseRevision: 'base-abc123' },
      evidenceDigest: 'evidence-deadbeef'
    },
    findings: [
      { id: 'finding-open', severity: 'high', criterion: 'frame overflow', status: 'open', evidence: '120x40 overflowed' },
      { id: 'finding-fixed', severity: 'medium', criterion: 'ASCII fallback', status: 'resolved', evidence: 'ASCII frame passes' }
    ],
    usage: { total: { inputTokens: 4_000, outputTokens: 800, totalTokens: 4_800 } },
    ...overrides
  };
}

function cockpitStore(options = {}) {
  const root = attempt(options.root);
  const candidate = attempt({
    id: 'cursor-candidate-2222222',
    parentJobId: root.id,
    rootJobId: root.id,
    provider: 'cursor',
    model: 'composer',
    resolvedModel: 'composer-2.5',
    providerSessionId: 'thread-2',
    createdAt: NOW / 1000 - 60,
    durationMs: 58_000,
    verification: { state: 'passed', exitCode: 0, command: 'node --test test/*.test.mjs' },
    acceptance: { state: 'ready-for-review', blockedBy: [], evidence: { verification: { state: 'passed', exitCode: 0 } }, evidenceDigest: 'evidence-cafe' },
    findings: [
      { id: 'finding-open', severity: 'high', criterion: 'frame overflow', status: 'regressed', evidence: 'narrow frame regressed' },
      { id: 'finding-fixed', severity: 'medium', criterion: 'ASCII fallback', status: 'resolved', evidence: 'ASCII frame passes' }
    ],
    usage: { total: { inputTokens: 2_000, outputTokens: 500, totalTokens: 2_500 } },
    ...options.candidate
  });
  const jobs = options.single ? [root] : [root, candidate];
  return {
    jobs,
    eventsByJob: Object.fromEntries(jobs.map((job) => [job.id, []])),
    hydrationByJob: Object.fromEntries(jobs.map((job) => [job.id, { loaded: true, loading: false, error: null }])),
    diffsByJob: {
      [root.id]: 'diff --git a/src/cockpit.mjs b/src/cockpit.mjs\n--- a/src/cockpit.mjs\n+++ b/src/cockpit.mjs\n@@ -1 +1 @@ workView\n-old\n+new',
      [candidate.id]: 'diff --git a/src/cockpit.mjs b/src/cockpit.mjs\n--- a/src/cockpit.mjs\n+++ b/src/cockpit.mjs\n@@ -1 +1 @@ workView\n-old\n+candidate'
    },
    diffStatsByJob: {
      [root.id]: { files: [{ path: 'src/cockpit.mjs', additions: 1, deletions: 1 }], totalAdditions: 1, totalDeletions: 1 },
      [candidate.id]: { files: [{ path: 'src/cockpit.mjs', additions: 2, deletions: 1 }], totalAdditions: 2, totalDeletions: 1 }
    },
    providers: []
  };
}

function frame(tab, options = {}) {
  return workViewModel(cockpitStore(options), {
    screen: 'work',
    workTab: tab,
    workIndex: 0,
    workScroll: 0,
    now: NOW,
    version: 'test'
  }, { width: 120, height: 40 });
}

test('Compose is the structured P5 card and unresolved fields visibly block dispatch', () => {
  const compose = frame(0);
  assert.equal(compose.tabs.active, 0);
  assert.deepEqual(compose.tabs.items, WORK_TABS);
  assert.equal(compose.meta.workItemCount, 1);
  const rendered = renderFrameToString(compose, { trimEnd: true });
  assert.match(rendered, /Structured WorkSpec card/);
  assert.match(rendered, /OBJECTIVE \[HIGH/);
  assert.match(rendered, /SCOPE CLAIM \[LOW/);
  assert.match(rendered, /WRITE DISPATCH BLOCKED/);
  assert.match(rendered, /owner-decision/);
});

test('Review keeps diff, verification, scope drift, findings, and base revision on one surface', () => {
  const review = frame(1);
  assert.equal(review.panes.length, 3);
  assert.match(review.panes[0].title, /Changed files/);
  assert.match(review.panes[1].title, /Verification.*scope.*base revision/i);
  assert.match(review.panes[2].title, /Findings checklist/);
  const rendered = renderFrameToString(review, { trimEnd: true });
  assert.match(rendered, /broker-real-tree/);
  assert.match(rendered, /base-abc123/);
  assert.match(rendered, /regressed/);
  assert.match(rendered, /src\/cockpit\.mjs/);
});

test('Approve exposes only backed actions and never implies owner-tree application', () => {
  const shared = frame(2);
  assert.equal(shared.meta.acceptJobId, 'cursor-candidate-2222222');
  assert.equal(shared.meta.rejectJobId, 'cursor-candidate-2222222');
  assert.deepEqual(shared.meta.integrationJobIds, []);
  const sharedText = renderFrameToString(shared, { trimEnd: true });
  assert.match(sharedText, /available: a/);
  assert.match(sharedText, /owner tree apply.*DISABLED/i);

  const isolated = frame(2, {
    candidate: {
      isolation: 'worktree',
      changeSet: { id: 'changes-2', files: [{ path: 'src/cockpit.mjs' }] }
    }
  });
  assert.equal(isolated.meta.acceptJobId, null);
  assert.deepEqual(isolated.meta.integrationJobIds, ['cursor-candidate-2222222']);
  const isolatedText = renderFrameToString(isolated, { trimEnd: true });
  assert.match(isolatedText, /owner-tree apply is deferred/);
  assert.match(isolatedText, /available: i/);
  assert.doesNotMatch(isolatedText, /available: a/);
});

test('Compare renders the latest two candidates side by side against identical criteria', () => {
  const compare = frame(3);
  assert.equal(compare.panes.length, 2);
  assert.ok(compare.panes.every((pane) => pane.content.sections[0].label === 'Same criteria'));
  const rendered = renderFrameToString(compare, { trimEnd: true });
  assert.match(rendered, /Candidate 1/);
  assert.match(rendered, /Candidate 2/);
  for (const criterion of ['diff shape', 'checks', 'findings', 'duration', 'usage', 'unresolved risks']) {
    assert.equal(rendered.match(new RegExp(criterion, 'g'))?.length, 2, criterion);
  }
});

test('Replay is honestly disabled and Converge shows states plus bounded policy before launch', () => {
  const replay = renderFrameToString(frame(4), { trimEnd: true });
  assert.match(replay, /Replay disabled/);
  assert.match(replay, /projection checkpoints or reversible reducer/);
  assert.match(replay, /O\(viewport\)/);

  const converge = frame(5);
  assert.equal(converge.meta.findingCounts.regressed, 1);
  assert.equal(converge.meta.findingCounts.resolved, 1);
  assert.equal(converge.meta.nextRoundJobId, 'cursor-candidate-2222222');
  const rendered = renderFrameToString(converge, { trimEnd: true });
  assert.match(rendered, /Finding convergence/);
  assert.match(rendered, /regressed/);
  assert.match(rendered, /resolved/);
  assert.match(rendered, /maximum rounds/);
  assert.match(rendered, /available: w after this policy is visible/);
});

test('all cockpit modes fit 120x40 dark, ASCII, and NO_COLOR without losing structural labels', (t) => {
  t.after(() => {
    setUiTheme('dark');
    configureGlyphs({ env: process.env, widths: {} });
  });
  for (const environment of [
    { TERM: 'xterm-256color', LANG: 'C.UTF-8' },
    { TERM: 'dumb', LANG: 'C', DELEGATE_TUI_ASCII: '1' },
    { TERM: 'xterm-256color', LANG: 'C.UTF-8', NO_COLOR: '1' }
  ]) {
    setUiTheme('dark', environment);
    configureGlyphs({ env: environment, widths: {} });
    for (let tab = 0; tab < WORK_TABS.length; tab += 1) {
      const current = frame(tab);
      const grid = paintFrame(current);
      assert.equal(grid.columns, 120);
      assert.equal(grid.rows, 40);
      const lines = renderFrameToString(current, { trimEnd: false }).split('\n');
      assert.equal(lines.length, 40);
      assert.ok(lines.every((line) => line.length <= 120), `${environment.TERM} tab ${tab} overflow`);
      assert.match(lines.join('\n'), new RegExp(WORK_TABS[tab]));
    }
  }
});
