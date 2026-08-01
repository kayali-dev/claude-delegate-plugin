import { useTuiTestHarness } from './helpers/tui-test-harness.mjs';
await useTuiTestHarness(import.meta.url);

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { paintFrame, renderFrameToString } from '../bin/lib/tui/components.mjs';
import { configureGlyphs } from '../bin/lib/tui/glyphs.mjs';
import {
  actionMenuForContext,
  dispatchKeymapBinding,
  footerForContext,
  formatKeyNotation,
  helpPagesForContext,
  KEYMAP,
  KEY_CLASSES,
  KEY_RELATIONS,
  renderKeysMarkdown,
  validateKeymap
} from '../bin/lib/tui/keymap.mjs';
import { createPalette, setUiTheme, uiPalette } from '../bin/lib/tui/palette.mjs';

const plugin = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const docsPath = path.join(plugin, 'skills', 'delegate', 'references', 'tui.md');

function runningContext() {
  return {
    screen: 'detail',
    detailTab: 0,
    tabCount: 6,
    paneCount: 1,
    searchQuery: '',
    remoteOnly: false,
    job: { id: 'running-job', status: 'running', phase: 'working', mode: 'review' }
  };
}

function overlayFrame(overlay, width = 100, height = 30) {
  return {
    width,
    height,
    screen: 'detail',
    title: { text: 'job detail behind modal' },
    panes: [],
    status: { text: 'background footer' },
    overlay
  };
}

function footerLine(ctx, width) {
  const footer = footerForContext(ctx, width);
  const frame = overlayFrame(null, width, 8);
  frame.status = { text: '', hints: footer.groups, rightHints: footer.right };
  return renderFrameToString(frame, { trimEnd: true }).split('\n').at(-1);
}

test('KEYMAP structure makes ambiguous notation unrepresentable', () => {
  assert.ok(KEYMAP.length >= 40);
  for (const item of KEYMAP) {
    assert.ok(Array.isArray(item.keys), item.action);
    assert.ok(KEY_RELATIONS.includes(item.relation), `${item.action}: ${item.relation}`);
    assert.ok(KEY_CLASSES.includes(item.class), `${item.action}: ${item.class}`);
    assert.equal(typeof item.when, 'function', item.action);
    assert.equal(typeof item.unavailableReason, 'function', item.action);
    const notation = formatKeyNotation(item, { ellipsis: '…' });
    if (notation.includes('/')) assert.equal(notation, '/', `${item.action} leaked / into the key column`);
    if (notation.includes('-')) assert.equal(item.relation, 'chord', `${item.action} used - outside a chord`);
    if (item.relation === 'range') assert.match(notation, / … /);
  }
  assert.equal(formatKeyNotation(KEYMAP.find((item) => item.action === 'detail.tab.cycle')), '[ ]');
  assert.equal(formatKeyNotation(KEYMAP.find((item) => item.action === 'diagnostic.mark')), 'Ctrl-G');
});

test('every destructive KEYMAP entry is forced through its declared confirmation gate', () => {
  assert.equal(validateKeymap(KEYMAP), true);
  const destructive = KEYMAP.filter((item) => item.class === 'destructive');
  assert.ok(destructive.length >= 3);
  for (const item of destructive) {
    const calls = [];
    assert.equal(dispatchKeymapBinding(item, {
      perform: () => calls.push('performed'),
      confirm: (gate, binding) => calls.push(`confirmed:${gate}:${binding.action}`),
      missingConfirmation: () => calls.push('missing')
    }), true);
    assert.deepEqual(calls, [`confirmed:job-id-suffix:${item.action}`], item.action);
  }

  const synthetic = Object.freeze({
    keys: Object.freeze(['!']),
    relation: 'single',
    label: 'synthetic destructive action',
    action: 'synthetic.unsafe',
    scope: Object.freeze(['global']),
    class: 'destructive',
    confirmationGate: null
  });
  assert.throws(
    () => validateKeymap([...KEYMAP, synthetic]),
    /synthetic\.unsafe requires confirmationGate/
  );
  const calls = [];
  assert.equal(dispatchKeymapBinding(synthetic, {
    perform: () => calls.push('performed'),
    confirm: () => calls.push('confirmed'),
    missingConfirmation: (binding) => calls.push(`blocked:${binding.action}`)
  }), false);
  assert.deepEqual(calls, ['blocked:synthetic.unsafe'], 'the synthetic mutation cannot reach perform');

  const controller = fs.readFileSync(path.join(plugin, 'bin', 'delegate-tui'), 'utf8');
  assert.match(controller, /binding\?\.class === 'destructive'[\s\S]*dispatchRegisteredBinding\(binding\)/);
  assert.match(controller, /selected\.class === 'destructive'\) dispatchRegisteredBinding\(selected\)/);
});

test('anomaly drill-down is one KEYMAP binding shared by footer, help, menu, and docs', () => {
  const ctx = { ...runningContext(), anomalyCount: 3 };
  const binding = KEYMAP.find((item) => item.action === 'detail.anomalies');
  assert.equal(formatKeyNotation(binding), 'A');
  assert.ok(footerForContext(ctx, 180).groups.flat().some((item) => item.action === binding.action));
  assert.ok(helpPagesForContext(ctx).flatMap((page) => page.rows).some((item) => item.action === binding.action));
  assert.equal(actionMenuForContext(ctx).find((item) => item.action === binding.action).unavailable, null);
  const controller = fs.readFileSync(path.join(plugin, 'bin', 'delegate-tui'), 'utf8');
  assert.match(controller, /action === 'detail\.anomalies'\) return toggleTranscriptAnomalies\(\)/);
  assert.match(controller, /key === 'A' && ui\.detailTab === 0\) \{ toggleTranscriptAnomalies\(\)/);
});

test('the appended Plan tab has one registry binding across footer, help, menu, docs, and dispatch', () => {
  const ctx = { ...runningContext(), tabCount: 7, hasPlanning: true };
  const binding = KEYMAP.find((item) => item.action === 'detail.plan');
  assert.equal(formatKeyNotation(binding), 'P');
  assert.ok(footerForContext(ctx, 220).groups.flat().some((item) => item.action === binding.action));
  assert.ok(helpPagesForContext(ctx).flatMap((page) => page.rows).some((item) => item.action === binding.action));
  assert.equal(actionMenuForContext(ctx).find((item) => item.action === binding.action).unavailable, null);
  assert.equal(formatKeyNotation(KEYMAP.find((item) => item.action === 'detail.tab.open'), { ellipsis: '…' }), '1 … 6');
  const docs = fs.readFileSync(docsPath, 'utf8');
  assert.match(docs, /\| `P` \| open live Plan \| detail \|/);
  const controller = fs.readFileSync(path.join(plugin, 'bin', 'delegate-tui'), 'utf8');
  assert.match(controller, /action === 'detail\.plan'\) return openPlanTab\(\)/);
  assert.match(controller, /binding\?\.action === 'detail\.plan'/);
});

test('tool, subagent, error, and warning drill-downs each flow through KEYMAP', () => {
  const cases = [
    { action: 'detail.tools', key: 'O', ctx: { ...runningContext(), toolCount: 2 }, dispatch: /action === 'detail\.tools'\) return toggleTranscriptKind\('tools'\)/, direct: /key === 'O' && ui\.detailTab === 0/ },
    { action: 'detail.subagents', key: 'U', ctx: { ...runningContext(), subagentCount: 1 }, dispatch: /action === 'detail\.subagents'\) return toggleTranscriptKind\('subagents'\)/, direct: /key === 'U' && ui\.detailTab === 0/ },
    { action: 'detail.event-errors', key: 'A', ctx: { ...runningContext(), detailTab: 4, errorCount: 2 }, dispatch: /action === 'detail\.event-errors'\) return toggleEventCategory\('error'\)/, direct: /key === 'A' && ui\.detailTab === 4/ },
    { action: 'detail.event-warnings', key: 'W', ctx: { ...runningContext(), detailTab: 4, warningCount: 1 }, dispatch: /action === 'detail\.event-warnings'\) return toggleEventCategory\('warning'\)/, direct: /key === 'W' && ui\.detailTab === 4/ }
  ];
  const controller = fs.readFileSync(path.join(plugin, 'bin', 'delegate-tui'), 'utf8');
  for (const item of cases) {
    const binding = KEYMAP.find((entry) => entry.action === item.action);
    assert.equal(formatKeyNotation(binding), item.key);
    assert.ok(footerForContext(item.ctx, 220).groups.flat().some((entry) => entry.action === item.action), item.action);
    assert.ok(helpPagesForContext(item.ctx).flatMap((page) => page.rows).some((entry) => entry.action === item.action), item.action);
    assert.equal(actionMenuForContext(item.ctx).find((entry) => entry.action === item.action).unavailable, null);
    assert.match(controller, item.dispatch);
    assert.match(controller, item.direct);
  }
});

test('footer, contextual help, action menu, and generated docs all derive from KEYMAP', () => {
  const ctx = runningContext();
  const actions = new Set(KEYMAP.map((item) => item.action));
  const footer = footerForContext(ctx, 120);
  const footerItems = [...footer.groups.flat(), ...footer.right];
  assert.ok(footerItems.length <= 10);
  assert.ok(footerItems.every((item) => actions.has(item.action)));
  assert.deepEqual(footer.right.map((item) => item.action), ['overlay.help', 'navigation.back']);

  const help = helpPagesForContext(ctx);
  const helpActions = help.flatMap((page) => page.rows.map((row) => row.action));
  assert.equal(helpActions.length, KEYMAP.length);
  assert.deepEqual(helpActions.sort(), KEYMAP.map((item) => item.action).sort());
  assert.ok(help[0].rows.every((row) => row.contextual));
  assert.ok(help.some((page) => page.divider));
  const pointer = help.find((page) => page.label === 'pointer');
  assert.deepEqual(pointer.rows.map((row) => row.action), ['navigation.mouse.scroll', 'navigation.mouse.click']);
  assert.ok(help.filter((page) => page.label === 'navigation').every((page) => page.rows.every((row) => !row.action.startsWith('navigation.mouse.'))));
  assert.ok(help.every((page) => !/\d+\/\d+/.test(page.label)), 'global paging owns the only page counter');

  const menu = actionMenuForContext(ctx);
  assert.ok(menu.every((item) => actions.has(item.action)));
  assert.equal(menu.find((item) => item.action === 'detail.nudge').unavailable, 'needs a terminal job');

  const docs = fs.readFileSync(docsPath, 'utf8');
  const generated = docs.match(/<!-- BEGIN GENERATED KEYMAP -->\n([\s\S]*?)\n<!-- END GENERATED KEYMAP -->/);
  assert.ok(generated, 'generated keymap markers exist');
  assert.equal(generated[1], renderKeysMarkdown());

  const viewmodels = fs.readFileSync(path.join(plugin, 'bin', 'lib', 'tui', 'viewmodels.mjs'), 'utf8');
  assert.doesNotMatch(viewmodels, /function footerHints|export const HELP_ITEMS = Object\.freeze\(\[/);
});

test('footer degrades by whole class and keeps help/back right-anchored at every owner width', () => {
  const ctx = runningContext();
  const outputs = [120, 100, 80, 64].map((width) => [width, footerForContext(ctx, width), footerLine(ctx, width)]);
  for (const [width, footer, line] of outputs) {
    assert.ok([...footer.groups.flat(), ...footer.right].length <= 10, `${width} exceeds slot budget`);
    assert.ok(line.endsWith('?  keys  Esc  back'), `${width}: ${line}`);
    assert.ok(line.length <= width, `${width}: footer overflow`);
    assert.doesNotMatch(line, /\.\.$/, `${width}: footer must not truncate a label`);
    const classes = footer.groups.map((group) => group[0].class);
    if (classes.includes('destructive')) assert.equal(classes.at(-1), 'destructive');
  }
  assert.ok(outputs[0][1].groups.some((group) => group[0].class === 'navigation'));
  assert.ok(!outputs.at(-1)[1].groups.some((group) => group[0].class === 'navigation'));
  assert.ok(outputs.at(-1)[1].groups.some((group) => group[0].class === 'destructive'));
});

test('help is a raised centred dialog with theme-tuned scrims and structural key caps', (t) => {
  t.after(() => {
    setUiTheme('dark');
    configureGlyphs({ env: process.env, widths: {} });
  });
  const pages = helpPagesForContext(runningContext());
  for (const theme of ['dark', 'light']) {
    setUiTheme(theme);
    configureGlyphs({ env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' }, widths: {} });
    const frame = overlayFrame({ kind: 'help', pages, page: 0 });
    const grid = paintFrame(frame);
    const expected = createPalette(process.env, theme);
    assert.equal(grid.get(10, 4).char, '+', 'content-sized card remains centred');
    assert.deepEqual(grid.get(11, 10).style, expected.surfaceOverlay, `${theme} modal body owns surfaceOverlay`);
    assert.equal(grid.get(0, 10).style.bg.index, expected.scrim.bg.index, `${theme} scrim owns its tuned background`);
    assert.equal(grid.get(12, 7).style.fg.index, expected.dim.fg.index, `${theme} section typography stays quiet`);
    assert.equal(grid.get(12, 9).style.bg.index, expected.keyCap.bg.index, `${theme} key cap owns surfaceRaised`);
    assert.ok(grid.get(12, 9).style.bold);
    const rendered = renderFrameToString(frame, { trimEnd: true });
    assert.match(rendered, /DELEGATE KEYS/);
    assert.doesNotMatch(rendered, /[┃#]\|/, `${theme} help has no border-adjacent scrollbar`);
    assert.doesNotMatch(rendered, /NAVIGATION \d/);
  }

  for (const width of [99, 101]) {
    const grid = paintFrame(overlayFrame({ kind: 'help', pages, page: 0 }, width, 30));
    const corners = [];
    for (let x = 0; x < width; x += 1) if (grid.get(x, 4).char === '+') corners.push(x);
    assert.deepEqual(corners, width === 99 ? [10, 88] : [11, 89]);
    assert.equal(corners[0], width - corners[1] - 1, `${width} has symmetric margins`);
  }

  const pointerPage = pages.findIndex((page) => page.label === 'pointer');
  const pointerGrid = paintFrame(overlayFrame({ kind: 'help', pages, page: pointerPage }, 100, 30));
  assert.equal(pointerGrid.get(10, 10).char, '+', 'two-row pointer page shrinks to content height');
  assert.equal(pointerGrid.get(10, 19).char, '+', 'content-sized pointer card keeps one quiet row before utilities');

  setUiTheme('light');
  const surfaceFrame = overlayFrame({ kind: 'help', pages, page: 0 });
  surfaceFrame.panes = [{
    rect: { x: 0, y: 1, width: 100, height: 28 },
    title: 'background surface',
    content: { kind: 'log', lines: ['underlay'], follow: false }
  }];
  const lightSurfaceBefore = paintFrame({ ...surfaceFrame, overlay: null }).get(5, 10).style;
  const lightSurface = paintFrame(surfaceFrame).get(5, 10).style;
  const lightPalette = createPalette(process.env, 'light');
  assert.equal(lightSurface.bg.index, lightSurfaceBefore.bg.index, 'light scrim preserves the authored surface ramp');
  assert.equal(lightSurface.fg.index, lightPalette.scrim.fg.index, 'light scrim mutes content instead of washing its surface');
  assert.equal(lightSurface.dim, true);

  setUiTheme('dark', { TERM: 'dumb', LANG: 'C', NO_COLOR: '1' });
  configureGlyphs({ env: { TERM: 'dumb', LANG: 'C', DELEGATE_TUI_ASCII: '1' }, widths: {} });
  const noColor = paintFrame(overlayFrame({ kind: 'help', pages, page: 0 }));
  assert.equal(noColor.get(10, 4).char, '+');
  assert.equal(noColor.get(0, 10).style.dim, true);
  assert.equal(noColor.get(12, 9).style.underline, true);
  assert.equal(noColor.get(12, 9).style.bold, true);
});

test('action menu keeps running and terminal unavailable actions visible with reasons', () => {
  const running = actionMenuForContext(runningContext());
  assert.equal(running.find((item) => item.action === 'detail.answer').unavailable, 'needs a pending worker question');
  assert.equal(running.find((item) => item.action === 'detail.nudge').unavailable, 'needs a terminal job');
  assert.equal(running.find((item) => item.action === 'detail.resume').unavailable, 'needs a terminal job');
  assert.equal(running.find((item) => item.action === 'detail.cancel').unavailable, null);

  const terminal = actionMenuForContext({
    ...runningContext(),
    job: { id: 'terminal-job', status: 'completed', phase: 'completed', mode: 'implement', resultSuspect: false }
  });
  assert.equal(terminal.find((item) => item.action === 'detail.nudge').unavailable, 'needs a read-mode job');
  assert.equal(terminal.find((item) => item.action === 'detail.cancel').unavailable, 'needs a running job');
  assert.equal(terminal.find((item) => item.action === 'detail.revert').unavailable, null);

  const waiting = actionMenuForContext({
    ...runningContext(),
    job: {
      ...runningContext().job,
      phase: 'user-input-required',
      pendingInput: { requestId: 'question-1' }
    }
  });
  assert.equal(waiting.find((item) => item.action === 'detail.answer').unavailable, null);
});

test('every moved binding has a first-press migration hint in the controller', () => {
  const controller = fs.readFileSync(path.join(plugin, 'bin', 'delegate-tui'), 'utf8');
  for (const hint of [
    'G now goes to bottom; Groups moved to g r',
    'Sessions moved to g s',
    'Providers moved to g p',
    'Stats moved to g t',
    'N is previous match; no active search. Launcher moved to g l',
    'n is next match; no active search. Nudge moved to x actions',
    'x now opens actions; external-thread visibility lives here',
    'launch moved to d dry-run confirmation'
  ]) {
    assert.ok(controller.includes(hint), hint);
  }
});
