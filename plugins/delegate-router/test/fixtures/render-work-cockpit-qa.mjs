import fs from 'node:fs';
import { jobDiff, diffStat } from '../../bin/lib/control.mjs';
import { listJobs } from '../../bin/lib/state.mjs';
import { renderFrameToString } from '../../bin/lib/tui/components.mjs';
import { configureGlyphs } from '../../bin/lib/tui/glyphs.mjs';
import { setUiTheme } from '../../bin/lib/tui/palette.mjs';
import { projectJobsAsWorkItems } from '../../bin/lib/work-projection.mjs';
import { workViewModel } from '../../bin/lib/tui/viewmodels.mjs';

const NOW = 1_700_000_000_000;
const ENVIRONMENT = { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'C.UTF-8' };
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

function attempt(overrides = {}) {
  return {
    id: 'codex-qa-root-111111',
    provider: 'codex',
    model: 'sol',
    resolvedModel: 'gpt-5.4-sol',
    mode: 'implement',
    status: 'completed',
    phase: 'completed',
    revision: 5,
    cwd: '/workspace/cockpit',
    createdAt: NOW / 1000 - 120,
    updatedAt: NOW / 1000,
    completedAt: NOW / 1000,
    durationMs: 120_000,
    baseRevision: 'base-qa-abc123',
    managedBy: 'delegate-control',
    providerSessionId: 'thread-qa-1',
    allowedPaths: ['bin/lib/tui/**', 'test/**'],
    workSpec: {
      schemaVersion: 1,
      objective: 'Build the WorkItem cockpit',
      scopeClaim: ['bin/lib/tui/**', 'test/**'],
      acceptanceCriteria: ['Every cockpit frame stays inside 120x40'],
      verifyRecipe: { schemaVersion: 1, command: 'node --test test/*.test.mjs', timeoutSeconds: 600 },
      budget: { schemaVersion: 1, wallTimeSeconds: 900, maxRounds: 3, maxOutputTokens: 8_000 },
      base: { schemaVersion: 1, revision: 'base-qa-abc123', dirtyHashes: {} }
    },
    specCompilation: {
      confirmed: false,
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
      files: ['bin/lib/tui/viewmodels.mjs', 'test/tui-work-cockpit.test.mjs'],
      entries: [{ path: 'bin/lib/tui/viewmodels.mjs' }, { path: 'test/tui-work-cockpit.test.mjs' }]
    },
    verificationOrigin: 'broker-real-tree',
    verification: { state: 'failed', exitCode: 1, command: 'node --test test/*.test.mjs' },
    acceptance: {
      state: 'blocked',
      blockedBy: ['verification-failed'],
      evidence: { verification: { state: 'failed', exitCode: 1 }, baseRevision: 'base-qa-abc123' },
      evidenceDigest: 'evidence-qa-deadbeef'
    },
    findings: [
      { id: 'finding-open', severity: 'high', criterion: 'Frame overflow', status: 'open', evidence: '120x40 overflowed' },
      { id: 'finding-resolved', severity: 'medium', criterion: 'ASCII fallback', status: 'resolved', evidence: 'ASCII frame passes' }
    ],
    usage: { total: { inputTokens: 4_000, outputTokens: 800, totalTokens: 4_800 } },
    ...overrides
  };
}

function syntheticStore() {
  const root = attempt();
  const candidate = attempt({
    id: 'cursor-qa-candidate-222222',
    parentJobId: root.id,
    rootJobId: root.id,
    provider: 'cursor',
    model: 'composer',
    resolvedModel: 'composer-2.5',
    providerSessionId: 'thread-qa-2',
    createdAt: NOW / 1000 - 60,
    durationMs: 58_000,
    verification: { state: 'passed', exitCode: 0, command: 'node --test test/*.test.mjs' },
    acceptance: {
      state: 'ready-for-review',
      blockedBy: [],
      evidence: { verification: { state: 'passed', exitCode: 0 } },
      evidenceDigest: 'evidence-qa-cafe'
    },
    findings: [
      { id: 'finding-open', severity: 'high', criterion: 'Frame overflow', status: 'open', evidence: 'One narrow case remains' },
      { id: 'finding-resolved', severity: 'medium', criterion: 'ASCII fallback', status: 'resolved', evidence: 'ASCII frame passes' }
    ],
    usage: { total: { inputTokens: 2_000, outputTokens: 500, totalTokens: 2_500 } }
  });
  return {
    jobs: [root, candidate],
    eventsByJob: { [root.id]: [], [candidate.id]: [] },
    diffsByJob: {
      [root.id]: 'diff --git a/bin/lib/tui/viewmodels.mjs b/bin/lib/tui/viewmodels.mjs\n@@ -1 +1 @@ cockpit\n-old\n+new',
      [candidate.id]: 'diff --git a/bin/lib/tui/viewmodels.mjs b/bin/lib/tui/viewmodels.mjs\n@@ -1 +1 @@ cockpit\n-old\n+candidate'
    },
    diffStatsByJob: {
      [root.id]: { files: [{ path: 'bin/lib/tui/viewmodels.mjs', additions: 1, deletions: 1 }], totalAdditions: 1, totalDeletions: 1 },
      [candidate.id]: { files: [{ path: 'bin/lib/tui/viewmodels.mjs', additions: 2, deletions: 1 }], totalAdditions: 2, totalDeletions: 1 }
    },
    providers: []
  };
}

function liveBlockedReview() {
  const jobs = listJobs();
  const items = projectJobsAsWorkItems(jobs);
  const workIndex = items.findIndex((work) => {
    const latestId = work.runs.at(-1)?.attempt?.id;
    const latest = jobs.find((job) => job.id === latestId);
    return latest?.status === 'completed'
      && latest?.acceptance?.state === 'blocked'
      && latest?.acceptance?.evidence
      && latest?.verification;
  });
  if (workIndex < 0) throw new Error('live store has no completed blocked job with acceptance and verification evidence');
  const latestId = items[workIndex].runs.at(-1).attempt.id;
  const diff = jobDiff(latestId);
  return workViewModel({
    jobs,
    eventsByJob: {},
    diffsByJob: { [latestId]: diff },
    diffStatsByJob: { [latestId]: diffStat(diff) },
    providers: []
  }, {
    screen: 'work',
    workTab: 1,
    workIndex,
    workScroll: 0,
    now: Date.now(),
    version: PACKAGE_VERSION
  }, { width: 120, height: 40 });
}

function syntheticFrame(workTab) {
  return workViewModel(syntheticStore(), {
    screen: 'work',
    workTab,
    workIndex: 0,
    workScroll: 0,
    now: NOW,
    version: PACKAGE_VERSION
  }, { width: 120, height: 40 });
}

setUiTheme('dark', ENVIRONMENT);
configureGlyphs({ env: ENVIRONMENT, widths: {} });

for (const [label, frame] of [
  ['COMPOSE — unresolved field', syntheticFrame(0)],
  ['REVIEW — real blocked live-store job', liveBlockedReview()],
  ['COMPARE — two candidates', syntheticFrame(3)],
  ['CONVERGE — open and resolved findings', syntheticFrame(5)]
]) {
  process.stdout.write(`===== ${label} | 120x40 dark =====\n`);
  process.stdout.write(`${renderFrameToString(frame, { trimEnd: false })}\n`);
}
