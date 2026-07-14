import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { paintFrame, renderFrameToString } from '../bin/lib/tui/components.mjs';
import {
  classifySession,
  correlateSessions,
  decodeProjectDirectory,
  encodeProjectDirectory,
  parseSessionTail,
  scanClaudeSessions
} from '../bin/lib/tui/sessions.mjs';
import { sessionsViewModel } from '../bin/lib/tui/viewmodels.mjs';

const NOW = Date.parse('2026-07-13T12:00:00.000Z');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-tui-p2b-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeSession(projectsDir, cwd, id, lines, mtimeMs = NOW) {
  const projectDir = path.join(projectsDir, encodeProjectDirectory(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, `${id}.jsonl`);
  fs.writeFileSync(file, Array.isArray(lines) ? `${lines.join('\n')}\n` : lines);
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

test('encoded Claude project directories decode round-trip, including hyphenated path components', (t) => {
  const root = temporaryDirectory(t);
  const cwd = path.join(root, 'project-with-hyphens', 'source-tree');
  fs.mkdirSync(cwd, { recursive: true });
  const encoded = encodeProjectDirectory(cwd);
  assert.equal(encodeProjectDirectory(decodeProjectDirectory(encoded)), encoded);
  assert.equal(decodeProjectDirectory(encoded), cwd);
});

test('tail parsing skips garbage, truncated starts, huge lines, and empty files without throwing', (t) => {
  const root = temporaryDirectory(t);
  const mixed = path.join(root, 'mixed.jsonl');
  fs.writeFileSync(mixed, [
    'not json',
    JSON.stringify({ type: 'user', message: { content: 'older request' } }),
    '{"type":"assistant","message":',
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'newest answer' }] } }),
    '{truncated'
  ].join('\n'));
  assert.equal(parseSessionTail(mixed).lastActivity, 'assistant: newest answer');

  const truncated = path.join(root, 'truncated-start.jsonl');
  fs.writeFileSync(truncated, `${'x'.repeat(70 * 1024)}\n${JSON.stringify({ type: 'user', cwd: root, message: { content: 'tail survives' } })}\n`);
  const truncatedResult = parseSessionTail(truncated);
  assert.equal(truncatedResult.lastActivity, 'user: tail survives');
  assert.ok(truncatedResult.bytesRead <= 64 * 1024);

  const huge = path.join(root, 'huge-line.jsonl');
  fs.writeFileSync(huge, `${JSON.stringify({ type: 'user', message: { content: 'safe previous line' } })}\n${JSON.stringify({ type: 'assistant', message: { content: 'z'.repeat(40 * 1024) } })}\n`);
  const hugeResult = parseSessionTail(huge);
  assert.match(hugeResult.lastActivity, /^assistant: z+…$/);
  assert.ok(hugeResult.lastActivity.length <= 120);

  const empty = path.join(root, 'empty.jsonl');
  fs.writeFileSync(empty, '');
  assert.deepEqual(parseSessionTail(empty), { lastActivity: '(unreadable)', cwd: null, parseableLines: 0, bytesRead: 0 });
});

test('session activity classification and scan ordering use file mtimes', (t) => {
  const root = temporaryDirectory(t);
  const projectsDir = path.join(root, 'projects');
  const activeCwd = path.join(root, 'active-project');
  const idleCwd = path.join(root, 'idle-project');
  fs.mkdirSync(activeCwd);
  fs.mkdirSync(idleCwd);
  writeSession(projectsDir, activeCwd, 'active-session', [JSON.stringify({ type: 'user', cwd: activeCwd, message: { content: 'active' } })], NOW - 30_000);
  writeSession(projectsDir, idleCwd, 'idle-session', [JSON.stringify({ type: 'assistant', cwd: idleCwd, message: { content: 'idle' } })], NOW - 301_000);
  const scan = scanClaudeSessions({ projectsDir, now: NOW, activeSeconds: 300 });
  assert.equal(scan.available, true);
  assert.deepEqual(scan.sessions.map((session) => [session.id, session.active]), [['active-session', true], ['idle-session', false]]);
  assert.deepEqual(classifySession(NOW - 300_000, { now: NOW, activeSeconds: 300 }).active, true);
  assert.deepEqual(classifySession(NOW - 300_001, { now: NOW, activeSeconds: 300 }).active, false);
});

test('cwd correlation counts only active delegate jobs and attaches managed writer ownership', () => {
  const sessions = [{ id: 'alpha', cwd: '/work/alpha' }, { id: 'beta', cwd: '/work/beta' }];
  const jobs = [
    { id: 'active-a', cwd: '/work/alpha', status: 'running' },
    { id: 'queued-a', cwd: '/work/alpha', status: 'queued' },
    { id: 'done-a', cwd: '/work/alpha', status: 'completed' },
    { id: 'active-b', cwd: '/work/beta', status: 'running' }
  ];
  const correlated = correlateSessions(sessions, jobs, [{ cwd: '/work/alpha', jobId: 'active-a', mode: 'implement' }]);
  assert.deepEqual(correlated.map((session) => [session.id, session.activeDelegateJobs, session.writerJobId]), [
    ['alpha', 2, 'active-a'],
    ['beta', 1, null]
  ]);
});

test('session snippets use shared redaction before display', (t) => {
  const root = temporaryDirectory(t);
  const file = path.join(root, 'secret.jsonl');
  const secret = 'sk-1234567890abcdef';
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { content: `please use ${secret}` } })}\n`);
  const result = parseSessionTail(file, { snippetWidth: 80 });
  assert.match(result.lastActivity, /\[REDACTED\]/);
  assert.doesNotMatch(result.lastActivity, new RegExp(secret));
});

test('missing projects directory degrades to an explanatory absent panel', (t) => {
  const root = temporaryDirectory(t);
  const projectsDir = path.join(root, 'missing-projects');
  const scan = scanClaudeSessions({ projectsDir });
  assert.equal(scan.available, false);
  assert.deepEqual(scan.sessions, []);
  assert.match(scan.error, /missing or unreadable/);
  const frame = sessionsViewModel({ jobs: [], writerLocks: [], sessions: [], sessionScan: { status: 'unavailable', ...scan } }, {}, { width: 80, height: 20 });
  assert.equal(frame.screen, 'sessions');
  assert.match(frame.panes[0].content.lines[0], /missing or unreadable/);
  assert.equal(paintFrame(frame).rows, 20);
});

test('session scan parses only the newest capped set', (t) => {
  const root = temporaryDirectory(t);
  const projectsDir = path.join(root, 'projects');
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  for (let index = 0; index < 5; index += 1) {
    writeSession(projectsDir, cwd, `session-${index}`, [JSON.stringify({ type: 'user', cwd, message: { content: `message ${index}` } })], NOW - index * 1000);
  }
  const scan = scanClaudeSessions({ projectsDir, now: NOW, maxSessions: 2 });
  assert.equal(scan.scanned, 2);
  assert.equal(scan.totalFiles, 5);
  assert.equal(scan.capped, true);
  assert.deepEqual(scan.sessions.map((session) => session.id), ['session-0', 'session-1']);
});

test('fixed Sessions viewmodel snapshot is deterministic and exposes cwd filter metadata', () => {
  const store = {
    sessions: [
      { id: '11111111-aaaa-bbbb', cwd: '/work/alpha', mtimeMs: NOW - 20_000, size: 12_500, lastActivity: 'assistant: implementation complete', activeSeconds: 300 },
      { id: '22222222-aaaa-bbbb', cwd: '/work/beta', mtimeMs: NOW - 600_000, size: 900, lastActivity: 'user: review the result', activeSeconds: 300 }
    ],
    sessionScan: { status: 'ready', available: true, scanned: 2, totalFiles: 2, capped: false, error: null },
    jobs: [
      { id: 'codex-active-123456', cwd: '/work/alpha', status: 'running' },
      { id: 'cursor-done-123456', cwd: '/work/alpha', status: 'completed' }
    ],
    writerLocks: [{ cwd: '/work/alpha', jobId: 'codex-active-123456', mode: 'implement', status: 'running' }]
  };
  const frame = sessionsViewModel(store, { now: NOW, sessionSelection: 0, notifyEnabled: true }, { width: 100, height: 22 });
  assert.equal(frame.meta.selectedSessionCwd, '/work/alpha');
  assert.equal(frame.panes[0].content.rowAt(0).cells[4].text, '1');
  const rendered = renderFrameToString(frame, { trimEnd: true });
  const snapshot = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'snapshots', 'tui-sessions-100x22.txt'), 'utf8').trimEnd();
  assert.equal(rendered, snapshot);
});
