import { useTuiTestHarness } from './helpers/tui-test-harness.mjs';
await useTuiTestHarness(import.meta.url);

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { filterDiffPaths } from '../bin/lib/control.mjs';
import {
  paneContentRect,
  paintFrame,
  paintLogPane,
  scrollVirtualLog,
  stepVirtualLogSelection,
  virtualLogBottomPosition,
  virtualLogEntryIndexAt,
  virtualLogLayout,
  virtualLogScrollToEntry,
  virtualSearchPosition,
  WrapCache
} from '../bin/lib/tui/components.mjs';
import { uiPalette } from '../bin/lib/tui/palette.mjs';
import { configureGlyphs } from '../bin/lib/tui/glyphs.mjs';
import { LogicalSearchIndex } from '../bin/lib/tui/search.mjs';
import { CellGrid } from '../bin/lib/tui/screen.mjs';
import {
  formatTranscriptBlock,
  TranscriptProjector,
  transcriptToolPaths,
  wrapTranscriptBlock
} from '../bin/lib/tui/transcript.mjs';

const AT = 1_700_000_000_000;

function event(seq, type, data = {}, at = AT + seq * 1000) {
  return { v: 1, seq, at, type, redacted: true, data };
}

test('message deltas concatenate exactly and completed text replaces the accumulation', () => {
  const projector = new TranscriptProjector();
  const streaming = projector.project([
    event(1, 'message.delta', { id: 'm1', delta: 'rema' }),
    event(2, 'message.delta', { id: 'm1', delta: 'in' })
  ], { now: AT + 2000 });
  assert.equal(streaming.length, 1);
  assert.equal(streaming[0].text, 'remain');
  assert.equal(streaming[0].streaming, true);
  assert.doesNotMatch(formatTranscriptBlock(streaming[0]), /message\.delta|\bseq\b/);

  const completed = projector.project([
    event(1, 'message.delta', { id: 'm1', delta: 'rema' }),
    event(2, 'message.delta', { id: 'm1', delta: 'in' }),
    event(3, 'message.completed', { id: 'm1', text: 'Authoritative final text.' })
  ], { now: AT + 3000 });
  assert.equal(completed.length, 1);
  assert.equal(completed[0].text, 'Authoritative final text.');
  assert.equal(completed[0].streaming, false);
  assert.doesNotMatch(formatTranscriptBlock(completed[0]), /remain/);

  const emptyCompletion = projector.project([
    event(1, 'message.delta', { id: 'm1', delta: 'discard me' }),
    event(2, 'message.completed', { id: 'm1', text: '' })
  ], { now: AT + 2000 });
  assert.equal(emptyCompletion[0].text, '', 'even an empty completed payload is authoritative');
});

test('anonymous message blocks close at turn, correction, and completion boundaries', () => {
  const projector = new TranscriptProjector();
  const blocks = projector.project([
    event(1, 'message.delta', { delta: 'turn one' }),
    event(2, 'turn.started'),
    event(3, 'message.delta', { delta: 'turn two' }),
    event(4, 'correction.restarted'),
    event(5, 'message.delta', { delta: 'turn three' }),
    event(6, 'message.completed', { text: 'turn three complete' }),
    event(7, 'message.delta', { delta: 'turn four' })
  ]);
  assert.deepEqual(blocks.filter((block) => block.kind === 'message').map((block) => block.text), [
    'turn one', 'turn two', 'turn three complete', 'turn four'
  ]);
});

test('streaming updates invalidate only the changing block identity', () => {
  const projector = new TranscriptProjector();
  const firstEvents = [
    event(1, 'message.user', { text: 'Question' }),
    event(2, 'message.delta', { id: 'm', delta: 'hel' })
  ];
  const first = projector.project(firstEvents, { now: AT + 2000 });
  const second = projector.project([...firstEvents, event(3, 'message.delta', { id: 'm', delta: 'lo' })], { now: AT + 3000 });
  assert.equal(second[0], first[0], 'unchanged user block keeps its wrap-cache identity');
  assert.notEqual(second[1], first[1], 'streaming content receives a new cache identity');
  assert.equal(second[1].text, 'hello');
  assert.match(formatTranscriptBlock(second[1]), /streaming/);
});

test('tool pairs collapse output and expand only journaled command, cwd, files, and tail', () => {
  const projector = new TranscriptProjector();
  const events = [
    event(1, 'tool.started', { item: { id: 'cmd', type: 'commandExecution', command: 'bun run checks', cwd: '/work/sub', status: 'inProgress' } }),
    event(2, 'tool.output', { id: 'cmd', delta: 'one\ntwo\n' }),
    event(3, 'tool.output', { id: 'cmd', delta: 'three' }),
    event(4, 'tool.completed', { item: { id: 'cmd', type: 'commandExecution', command: 'bun run checks', cwd: '/work/sub', status: 'completed', exitCode: 0, durationMs: 4200 } })
  ];
  const collapsed = projector.project(events, { now: AT + 4000, jobCwd: '/work' });
  assert.equal(collapsed.length, 1);
  assert.match(formatTranscriptBlock(collapsed[0]), /^\$ bun run checks \| \+ \| 4s \| \.{1,2} output \(3 lines\)$/);
  assert.doesNotMatch(formatTranscriptBlock(collapsed[0]), /one|cwd:/);

  const expanded = projector.project(events, { now: AT + 4000, jobCwd: '/work', expandedTools: new Set(['cmd']) });
  const text = formatTranscriptBlock(expanded[0]);
  assert.match(text, /command: bun run checks/);
  assert.match(text, /cwd: \/work\/sub/);
  assert.match(text, /output tail \(3\/3 lines\):\none\ntwo\nthree/);
});

test('tool one-liners use rich command, file, MCP, Cursor, and fallback fields; d maps file paths into Diff', () => {
  const projector = new TranscriptProjector();
  const events = [
    event(1, 'file.changed', { id: 'files', phase: 'completed', status: 'completed', changes: [
      { path: 'src/a.js', kind: 'update' }, { path: 'src/b.js', kind: 'create' }, { path: 'src/c.js', kind: 'delete' }
    ] }),
    event(2, 'tool.started', { item: { id: 'mcp', type: 'mcpToolCall', server: 'github', tool: 'search', status: 'inProgress' } }),
    event(3, 'tool.completed', { item: { id: 'mcp', type: 'mcpToolCall', server: 'github', tool: 'search', status: 'completed' } }),
    event(4, 'tool.started', { toolCallId: 'cursor', sessionUpdate: 'tool_call', title: 'Edit files', status: 'in_progress', locations: [{ path: '/work/src/a.js' }] }),
    event(5, 'tool.completed', { toolCallId: 'cursor', sessionUpdate: 'tool_call_update', title: 'Edit files', status: 'failed', locations: [{ path: '/work/src/a.js' }] }),
    event(6, 'tool.started', { id: 'fallback' }),
    event(7, 'tool.completed', { id: 'fallback', status: 'completed' })
  ];
  const blocks = projector.project(events, { now: AT + 7000, jobCwd: '/work' });
  const lines = blocks.map(formatTranscriptBlock);
  assert.match(lines[0], /^F a\.js \(\+2 more\) \| edit\/create\/delete \| \+/);
  assert.match(lines[1], /^M github\.search \| \+/);
  assert.match(lines[2], /^[>$›] Edit files \| a\.js \| [x✗]/);
  assert.match(lines[3], /^\$ tool \| \+/);
  const diffPaths = transcriptToolPaths(blocks[2], '/work');
  assert.deepEqual(diffPaths, ['src/a.js']);
  const diff = 'diff --git a/src/a.js b/src/a.js\n+a\ndiff --git a/src/b.js b/src/b.js\n+b';
  assert.match(filterDiffPaths(diff, diffPaths), /a\/src\/a\.js/);
  assert.doesNotMatch(filterDiffPaths(diff, diffPaths), /a\/src\/b\.js/);
});

test('latest plan replaces earlier plans and provider noise never enters Transcript', () => {
  const projector = new TranscriptProjector();
  const blocks = projector.project([
    event(1, 'provider.event', { providerEvent: 'stderr', text: 'noise' }),
    event(2, 'plan.updated', { plan: [{ step: 'old step', status: 'pending' }] }),
    event(3, 'plan.updated', { plan: [{ step: 'done step', status: 'completed' }, { step: 'next step', status: 'inProgress' }] }),
    event(4, 'scope.violation', { count: 2 })
  ]);
  assert.equal(blocks.filter((block) => block.kind === 'plan').length, 1);
  const rendered = blocks.map(formatTranscriptBlock).join('\n');
  assert.doesNotMatch(rendered, /old step|noise|provider\.event/);
  assert.match(rendered, /\+ done step/);
  assert.match(rendered, /~ next step/);
  assert.match(rendered, /scope violation/);
});

test('search indexes coalesced blocks without wrapping history and maps one hit lazily', () => {
  const projector = new TranscriptProjector();
  const events = [];
  for (let index = 0; index < 5000; index += 1) events.push(event(index + 1, 'message.completed', { id: `m${index}`, text: index === 4321 ? 'find the needle here' : `message ${index}` }));
  const entries = projector.project(events);
  const index = new LogicalSearchIndex(entries, formatTranscriptBlock);
  const cache = new WrapCache();
  const hits = index.find('needle');
  assert.equal(hits.length, 1);
  assert.equal(cache.wrapCalls, 0);
  const log = { virtual: true, entries, formatEntry: formatTranscriptBlock, wrapEntry: wrapTranscriptBlock, follow: false, searchQuery: 'needle' };
  const position = virtualSearchPosition(log, hits[0], 60, cache);
  assert.equal(cache.wrapCalls, 1);
  paintLogPane(new CellGrid(60, 18), { x: 0, y: 0, width: 60, height: 18 }, { ...log, scroll: position }, { wrapCache: cache });
  assert.ok(cache.wrapCalls <= 20, `only viewport blocks should wrap, got ${cache.wrapCalls}`);
});

test('coalesced transcript snapshot keeps one blank line between logical blocks', (t) => {
  t.after(() => configureGlyphs({ env: process.env, widths: {} }));
  configureGlyphs({ env: { TERM: 'xterm', LANG: 'C', DELEGATE_TUI_ASCII: '1' }, widths: {} });
  const projector = new TranscriptProjector();
  const blocks = projector.project([
    event(1, 'message.user', { text: 'Please keep the words intact.' }),
    event(2, 'message.delta', { id: 'm', delta: 'Now load' }),
    event(3, 'message.delta', { id: 'm', delta: 'ing the remaining files.' }),
    event(4, 'tool.started', { item: { id: 'cmd', type: 'commandExecution', command: 'node --test test/unit.test.mjs', status: 'inProgress' } }),
    event(5, 'tool.completed', { item: { id: 'cmd', type: 'commandExecution', command: 'node --test test/unit.test.mjs', status: 'completed', exitCode: 0, durationMs: 2200 } }),
    event(6, 'plan.updated', { plan: [{ step: 'Verify the focused behavior', status: 'completed' }] })
  ], { now: AT + 6000 });
  const rendered = blocks.flatMap((block) => wrapTranscriptBlock(block, 52).lines).join('\n');
  const snapshot = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'snapshots', 'tui-transcript-coalesced.txt'), 'utf8').trimEnd();
  assert.equal(rendered, snapshot);
  assert.doesNotMatch(rendered, /load\ning|load ing|\n\n\n/);
  assert.equal(rendered.split('\n').filter((line) => line === '').length, blocks.length - 1);
});

test('expanded output distinguishes real line breaks from literal backslash-n text', () => {
  const projector = new TranscriptProjector();
  const blocks = projector.project([
    event(1, 'tool.started', { item: { id: 'lines', type: 'commandExecution', command: ['node', '-e', 'work()'], status: 'inProgress' } }),
    event(2, 'tool.output', { id: 'lines', delta: 'first\r\nsecond\tcolumn\n' }),
    event(3, 'tool.output', { id: 'lines', delta: 'literal\\nkept\u0007\nlast' }),
    event(4, 'tool.completed', { item: { id: 'lines', type: 'commandExecution', command: ['node', '-e', 'work()'], status: 'completed', exitCode: 0 } })
  ], { expandedTools: new Set(['lines']), now: AT + 4000 });
  const rendered = wrapTranscriptBlock(blocks[0], 80).lines.join('\n');
  assert.match(rendered, /    first\n    second    column\n    literal\\nkept\n    last/);
  assert.doesNotMatch(rendered, /first\\nsecond/);
  assert.doesNotMatch(rendered, /\u0007/);
});

test('one virtual mapping owns transcript highlight, click, and scroll after block height changes', () => {
  const projector = new TranscriptProjector();
  let events = [
    event(1, 'message.user', { text: 'short user block' }),
    event(2, 'tool.started', { item: { id: 'tool', type: 'commandExecution', command: 'printf assistant', status: 'inProgress' } }),
    event(3, 'tool.output', { id: 'tool', delta: 'one\ntwo\nthree\nfour' }),
    event(4, 'tool.completed', { item: { id: 'tool', type: 'commandExecution', command: 'printf assistant', status: 'completed', exitCode: 0 } }),
    event(5, 'message.delta', { id: 'stream', delta: 'function assistant starts here ' }),
    event(6, 'plan.updated', { plan: [{ step: 'first plan', status: 'pending' }] })
  ];
  const cache = new WrapCache();
  const width = 42;
  const height = 9;

  const verify = (blocks, label) => {
    let scroll = { entry: 0, line: 0 };
    const order = [...blocks.keys(), ...[...blocks.keys()].reverse()];
    for (const selectedEntry of order) {
      const base = { virtual: true, entries: blocks, formatEntry: formatTranscriptBlock, wrapEntry: wrapTranscriptBlock, follow: false, selectedEntry, scroll };
      scroll = virtualLogScrollToEntry(base, selectedEntry, width, height, cache);
      const log = { ...base, scroll };
      const layout = virtualLogLayout(log, width, height, cache);
      const expected = layout.ranges.get(selectedEntry);
      assert.ok(expected, `${label}: selected block ${selectedEntry} is visible`);
      const grid = new CellGrid(width, height);
      paintLogPane(grid, { x: 0, y: 0, width, height }, log, { wrapCache: cache });
      const selectedRows = [];
      for (let row = 0; row < height; row += 1) {
        const selected = Array.from({ length: width }, (_, column) => grid.get(column, row).style)
          .some((style) => Object.entries(uiPalette.selection).every(([key, value]) => style[key] === value));
        if (selected) selectedRows.push(row);
      }
      assert.deepEqual(selectedRows, Array.from({ length: expected.end - expected.start + 1 }, (_, index) => expected.start + index), `${label}: highlight equals painted block lines`);
      for (let row = expected.start; row <= expected.end; row += 1) {
        assert.equal(virtualLogEntryIndexAt(log, row, width, height, cache), selectedEntry, `${label}: click row maps to selected block`);
      }
    }
  };

  let blocks = projector.project(events, { expandedTools: new Set(), now: AT + 6000 });
  verify(blocks, 'collapsed');
  blocks = projector.project(events, { expandedTools: new Set(['tool']), now: AT + 6000 });
  verify(blocks, 'expanded tool');
  events = [...events, event(7, 'message.delta', { id: 'stream', delta: 'and grows across several wrapped display lines without stale spans '.repeat(3) })];
  blocks = projector.project(events, { expandedTools: new Set(['tool']), now: AT + 7000 });
  verify(blocks, 'streaming growth');
  events = [...events, event(8, 'plan.updated', { plan: [
    { step: 'replacement one', status: 'completed' }, { step: 'replacement two', status: 'inProgress' }, { step: 'replacement three', status: 'pending' }
  ] })];
  blocks = projector.project(events, { expandedTools: new Set(['tool']), now: AT + 8000 });
  verify(blocks, 'plan replacement');

  const wrapped = cache.wrap(blocks[0], width, formatTranscriptBlock, wrapTranscriptBlock);
  assert.throws(() => wrapped.lines.push('mutation'), TypeError, 'cached wrapped-line arrays are immutable');
  assert.throws(() => { wrapped.fragments[0].text = 'mutation'; }, TypeError, 'cached fragments are immutable');
});

test('frame-level transcript selection highlights the selected block after wheel, expansion, and streaming growth', () => {
  const projector = new TranscriptProjector();
  let events = [
    event(1, 'message.user', { text: 'BLOCK-USER short' }),
    event(2, 'tool.started', { item: { id: 'tool-frame', type: 'commandExecution', command: 'printf BLOCK-TOOL', status: 'inProgress' } }),
    event(3, 'tool.output', { id: 'tool-frame', delta: 'BLOCK-TOOL one\nBLOCK-TOOL two' }),
    event(4, 'tool.completed', { item: { id: 'tool-frame', type: 'commandExecution', command: 'printf BLOCK-TOOL', status: 'completed', exitCode: 0 } }),
    event(5, 'message.delta', { id: 'stream-frame', delta: 'BLOCK-STREAM initial words ' }),
    event(6, 'plan.updated', { plan: [{ step: 'BLOCK-PLAN first', status: 'pending' }] }),
    event(7, 'message.completed', { id: 'tail', text: 'BLOCK-TAIL final' })
  ];
  const cache = new WrapCache();
  const pane = { rect: { x: 0, y: 2, width: 46, height: 12 }, title: 'Transcript' };
  const contentRect = paneContentRect({ ...pane, content: { kind: 'log' } }, { scrollbar: true });
  assert.equal(contentRect.width, 42, 'bordered pane reserves one inner-padding column on both sides');
  let scroll = { entry: 0, line: 0 };
  let selectedEntry = 0;

  const verifyFrame = (blocks, label) => {
    const content = {
      kind: 'log', virtual: true, entries: blocks, formatEntry: formatTranscriptBlock, wrapEntry: wrapTranscriptBlock,
      follow: false, scroll, selectedEntry, measureKey: 'frame-selection'
    };
    scroll = virtualLogScrollToEntry(content, selectedEntry, contentRect.width, contentRect.height, cache);
    content.scroll = scroll;
    const frame = {
      width: 46, height: 15, title: { text: 'Selection proof' },
      panes: [{ ...pane, content }], status: { text: 'ready' }
    };
    const grid = paintFrame(frame, { wrapCache: cache });
    const highlighted = [];
    for (let row = contentRect.y; row < contentRect.y + contentRect.height; row += 1) {
      const selected = Array.from({ length: contentRect.width }, (_, offset) => grid.get(contentRect.x + offset, row))
        .some((cell) => Object.entries(uiPalette.selection).every(([key, value]) => cell.style[key] === value));
      if (selected) highlighted.push(grid.cells[row].slice(contentRect.x, contentRect.x + contentRect.width).map((cell) => cell.continuation ? '' : cell.char).join('').trimEnd());
    }
    assert.ok(highlighted.length, `${label}: selected block paints highlighted frame cells`);
    const marker = ['BLOCK-USER', 'BLOCK-TOOL', 'BLOCK-STREAM', 'BLOCK-PLAN', 'BLOCK-TAIL'][selectedEntry];
    assert.match(highlighted.join('\n'), new RegExp(marker), `${label}: highlighted cells contain selected block text ${marker}`);
    for (const other of ['BLOCK-USER', 'BLOCK-TOOL', 'BLOCK-STREAM', 'BLOCK-PLAN', 'BLOCK-TAIL'].filter((value) => value !== marker)) {
      assert.doesNotMatch(highlighted.join('\n'), new RegExp(other), `${label}: neighboring block ${other} is not highlighted`);
    }
    return content;
  };

  let blocks = projector.project(events, { expandedTools: new Set(), now: AT + 9000 });
  for (selectedEntry = 0; selectedEntry < blocks.length; selectedEntry += 1) verifyFrame(blocks, `arrow down ${selectedEntry}`);
  for (selectedEntry = blocks.length - 1; selectedEntry >= 0; selectedEntry -= 1) verifyFrame(blocks, `arrow up ${selectedEntry}`);

  blocks = projector.project(events, { expandedTools: new Set(['tool-frame']), now: AT + 10_000 });
  selectedEntry = 1;
  verifyFrame(blocks, 'expanded tool');
  events = [...events, event(8, 'message.delta', { id: 'stream-frame', delta: 'BLOCK-STREAM grows BLOCK-STREAM across wrapped lines '.repeat(4) })];
  blocks = projector.project(events, { expandedTools: new Set(['tool-frame']), now: AT + 11_000 });
  selectedEntry = 2;
  const beforeWheel = verifyFrame(blocks, 'streaming growth');

  // Reproduce the controller path: wheel changes the display-line position,
  // then selection anchors to that visible block before the next arrow.
  scroll = scrollVirtualLog(beforeWheel, scroll, 3, contentRect.width, cache);
  selectedEntry = Number(scroll.entry || 0);
  selectedEntry = Math.min(blocks.length - 1, selectedEntry + 1);
  verifyFrame(blocks, 'wheel then arrow select');

  events = [...events, event(9, 'plan.updated', { plan: [
    { step: 'BLOCK-PLAN replacement', status: 'inProgress' }, { step: 'BLOCK-PLAN second', status: 'pending' }
  ] })];
  blocks = projector.project(events, { expandedTools: new Set(['tool-frame']), now: AT + 12_000 });
  selectedEntry = 3;
  verifyFrame(blocks, 'plan replacement after scrollbar metrics');
});

test('arrow selection is independent of viewport limits for variable-height blocks', () => {
  const entries = [
    { id: 'BLOCK-0', text: 'BLOCK-0 short' },
    { id: 'BLOCK-1', text: 'BLOCK-1 wraps across enough words to occupy more than one display line' },
    { id: 'BLOCK-2', text: 'BLOCK-2 short' },
    { id: 'BLOCK-3', text: 'BLOCK-3 short' },
    {
      id: 'BLOCK-TOOL', expanded: true,
      text: 'BLOCK-TOOL expanded command\n  output first\n  output second'
    },
    { id: 'BLOCK-5', text: 'BLOCK-5 short' },
    { id: 'BLOCK-6', text: 'BLOCK-6 trailing words that wrap at the viewport edge' },
    { id: 'BLOCK-7', text: 'BLOCK-7 last' }
  ];
  const formatEntry = (entry) => entry.text;
  const width = 24;
  const height = 9;

  const makeLog = (scroll, selectedEntry, source = entries) => ({
    virtual: true,
    entries: source,
    formatEntry,
    follow: false,
    scroll,
    selectedEntry,
    measureKey: source === entries ? 'selection-boundaries' : 'selection-fits'
  });

  const assertFrameSelection = (state, label, source = entries, viewportHeight = height, cache = new WrapCache()) => {
    const log = makeLog(state.scroll, state.selectedEntry, source);
    const grid = new CellGrid(width, viewportHeight);
    paintLogPane(grid, { x: 0, y: 0, width, height: viewportHeight }, log, { wrapCache: cache });
    const highlighted = [];
    for (let row = 0; row < viewportHeight; row += 1) {
      const selected = grid.cells[row].some((cell) => Object.entries(uiPalette.selection).every(([key, value]) => cell.style[key] === value));
      if (selected) highlighted.push(grid.cells[row].map((cell) => cell.continuation ? '' : cell.char).join('').trimEnd());
    }
    assert.ok(highlighted.length, `${label}: selected block has highlighted frame cells`);
    assert.match(highlighted.join('\n'), new RegExp(source[state.selectedEntry].id), `${label}: highlight contains the selected block text`);
  };

  const fullyVisible = (log, entryIndex, cache, viewportHeight = height) => {
    const layout = virtualLogLayout(log, width, viewportHeight, cache);
    const range = layout.ranges.get(entryIndex);
    const blockHeight = cache.lines(log.entries[entryIndex], width, log.formatEntry, log.wrapEntry).length;
    return Boolean(range && range.end - range.start + 1 >= Math.min(viewportHeight, blockHeight));
  };

  // Bottom boundary: the expanded tool is the first fully-visible block at
  // this bottom-pinned viewport. Selection must still walk to the final block
  // without trying (and failing) to scroll farther.
  {
    const cache = new WrapCache();
    const bottom = virtualLogBottomPosition(makeLog({ entry: 0, line: 0 }, 0), width, height, cache);
    const layout = virtualLogLayout(makeLog(bottom, 0), width, height, cache);
    const visible = [...layout.ranges.keys()].filter((index) => fullyVisible(makeLog(bottom, index), index, cache));
    let state = { selectedEntry: Math.min(...visible), scroll: bottom };
    assert.ok(entries[state.selectedEntry].expanded, 'expanded tool is on the bottom viewport boundary');
    while (state.selectedEntry < entries.length - 1) {
      const previousScroll = state.scroll;
      state = stepVirtualLogSelection(makeLog(state.scroll, state.selectedEntry), state.selectedEntry, 1, width, height, cache);
      assert.deepEqual(state.scroll, previousScroll, 'bottom-pinned viewport stays fixed while selection advances through visible blocks');
      assertFrameSelection(state, `bottom step ${state.selectedEntry}`, entries, height, cache);
    }
    const stopped = stepVirtualLogSelection(makeLog(state.scroll, state.selectedEntry), state.selectedEntry, 1, width, height, cache);
    assert.deepEqual(stopped, state, 'selection and viewport stop only at the final block');
  }

  // Top boundary mirrors the behavior: viewport offset zero is not a
  // selection boundary.
  {
    const cache = new WrapCache();
    const top = { entry: 0, line: 0 };
    const layout = virtualLogLayout(makeLog(top, 0), width, height, cache);
    const visible = [...layout.ranges.keys()].filter((index) => fullyVisible(makeLog(top, index), index, cache));
    let state = { selectedEntry: Math.max(...visible), scroll: top };
    while (state.selectedEntry > 0) {
      const previousScroll = state.scroll;
      state = stepVirtualLogSelection(makeLog(state.scroll, state.selectedEntry), state.selectedEntry, -1, width, height, cache);
      assert.deepEqual(state.scroll, previousScroll, 'top-pinned viewport stays fixed while selection retreats through visible blocks');
      assertFrameSelection(state, `top step ${state.selectedEntry}`, entries, height, cache);
    }
    const stopped = stepVirtualLogSelection(makeLog(state.scroll, state.selectedEntry), state.selectedEntry, -1, width, height, cache);
    assert.deepEqual(stopped, state, 'selection and viewport stop only at the first block');
  }

  // With no scroll range at all, every logical block remains selectable.
  {
    const cache = new WrapCache();
    const fitting = [entries[0], entries[4], entries[7]];
    const fittingHeight = fitting.reduce((sum, entry) => sum + cache.lines(entry, width, formatEntry).length, 0) + 1;
    let state = { selectedEntry: 0, scroll: { entry: 0, line: 0 } };
    while (state.selectedEntry < fitting.length - 1) {
      state = stepVirtualLogSelection(makeLog(state.scroll, state.selectedEntry, fitting), state.selectedEntry, 1, width, fittingHeight, cache);
      assert.deepEqual(state.scroll, { entry: 0, line: 0 });
      assertFrameSelection(state, `fitting step ${state.selectedEntry}`, fitting, fittingHeight, cache);
    }
  }

  // Mixed motion: one block per key. Scroll changes only when the next block
  // is not fully visible, then both clamp exactly at the last block.
  {
    const cache = new WrapCache();
    let state = { selectedEntry: 2, scroll: { entry: 1, line: 0 } };
    while (state.selectedEntry < entries.length - 1) {
      const target = state.selectedEntry + 1;
      const before = makeLog(state.scroll, state.selectedEntry);
      const targetWasVisible = fullyVisible(before, target, cache);
      const previousScroll = state.scroll;
      state = stepVirtualLogSelection(before, state.selectedEntry, 1, width, height, cache);
      assert.equal(state.selectedEntry, target, 'each Down press advances exactly one logical block');
      if (targetWasVisible) assert.deepEqual(state.scroll, previousScroll, 'visible selection does not move the viewport');
      else assert.notDeepEqual(state.scroll, previousScroll, 'viewport follows only after selection would leave view');
      assertFrameSelection(state, `mixed step ${state.selectedEntry}`, entries, height, cache);
    }
    const atEnd = stepVirtualLogSelection(makeLog(state.scroll, state.selectedEntry), state.selectedEntry, 1, width, height, cache);
    assert.deepEqual(atEnd, state);
  }

  // Wheel scrolling is viewport-only: it never rewrites the independent
  // selection index, even when it moves across block boundaries.
  {
    const cache = new WrapCache();
    const state = { selectedEntry: 4, scroll: { entry: 2, line: 0 } };
    const wheelScroll = scrollVirtualLog(makeLog(state.scroll, state.selectedEntry), state.scroll, 3, width, cache);
    assert.equal(state.selectedEntry, 4);
    assert.notDeepEqual(wheelScroll, state.scroll);
  }
});
