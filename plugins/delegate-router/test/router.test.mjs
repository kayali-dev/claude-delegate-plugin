import assert from 'node:assert/strict';
import test from 'node:test';
import { CODEX_MODEL_ALIASES, resolveCodexModel } from '../bin/lib/models.mjs';
import { routeTask } from '../bin/lib/router.mjs';

const available = { claude: true, codex: true, cursor: true };
const clear = {
  claude: { known: false }, codex: { known: false }, cursor: { known: false }
};

test('Codex alias resolution preserves full pins and never resolves inherited object keys', () => {
  for (const [alias, model] of Object.entries(CODEX_MODEL_ALIASES)) {
    assert.equal(resolveCodexModel(alias), model);
  }
  for (const model of ['gpt-6-sol', 'gpt-5.6-sol', 'constructor', 'toString', '__proto__']) {
    assert.equal(resolveCodexModel(model), model);
  }
  assert.equal(resolveCodexModel('auto'), null);
});

test('routes clear implementation work to Cursor Auto when no model is named', () => {
  const route = routeTask({ task: 'Implement the multi-file refactor and update tests', usage: clear, availability: available });
  assert.deepEqual([route.primary.provider, route.primary.model], ['cursor', 'auto']);
  assert.match(route.primary.reason, /Auto mode/);
});

test('an explicit composer request still pins Composer', () => {
  const route = routeTask({ task: 'Implement the multi-file refactor and update tests', model: 'composer', usage: clear, availability: available });
  assert.deepEqual([route.primary.provider, route.primary.model], ['cursor', 'composer']);
});

test('complex kinds keep pinned Cursor models instead of Auto', () => {
  const route = routeTask({ task: 'Research the legal and financial implications with sources', mode: 'consult', usage: clear, availability: available });
  assert.ok(![route.primary, ...route.fallbacks].some((item) => item.provider === 'cursor' && item.model === 'auto'));
});

test('current full model IDs infer their native provider without rewriting the pin', () => {
  const cases = [
    ['astra', 'codex'], ['gpt-6-astra', 'codex'], ['gpt-6.1-sol', 'codex'],
    ['gpt-6-sol', 'codex'], ['gpt-6-luna', 'codex'], ['gpt-5.6-terra', 'codex'],
    ['claude-opus-5-5', 'claude'], ['claude-sonnet-5-5', 'claude'],
    ['claude-haiku-5-5', 'claude'], ['claude-fable-5-1', 'claude'],
    ['grok-4.7-high', 'cursor'], ['cursor-grok-4.7-xhigh', 'cursor'],
    ['grok-4.7[effort=high,fast=false]', 'cursor'], ['composer-2.5', 'cursor']
  ];
  for (const [model, provider] of cases) {
    const route = routeTask({ task: 'Review this change', model, usage: clear, availability: available });
    assert.deepEqual([route.primary?.provider, route.primary?.model], [provider, model]);
    assert.equal(Boolean(route.primary.requiresAuthorization), model === 'claude-fable-5-1');
  }
});

test('current explicit models still respect provider disablement and quota', () => {
  for (const model of ['astra', 'gpt-6.1-sol', 'gpt-6-luna']) {
    assert.equal(routeTask({ task: 'Review', model, usage: clear, availability: { ...available, codex: false } }).primary, null);
    assert.equal(routeTask({ task: 'Review', model, usage: { ...clear, codex: { known: true, usedPercent: 95 } }, availability: available }).primary, null);
  }
  const explicitLane = routeTask({ task: 'Review', provider: 'cursor', model: 'gpt-6.1-sol', usage: clear, availability: available });
  assert.equal(explicitLane.primary.provider, 'cursor', 'explicit provider choice remains authoritative; broker lane admission is separate');
});

test('routes hard debugging and review work to Sol', () => {
  const route = routeTask({ task: 'Debug the flaky terminal integration test', mode: 'verify', usage: clear, availability: available });
  assert.deepEqual([route.primary.provider, route.primary.model], ['codex', 'sol']);
});

test('routes broad cross-domain research to Grok', () => {
  const route = routeTask({ task: 'Research the legal and financial implications with sources', mode: 'consult', usage: clear, availability: available });
  assert.deepEqual([route.primary.provider, route.primary.model], ['cursor', 'grok']);
});

test('routes vision-heavy architecture judgment to Claude Opus, never auto-selecting Fable', () => {
  const route = routeTask({ task: 'Assess the architecture tradeoffs in these screenshots and pick a migration strategy', usage: clear, availability: available });
  assert.deepEqual([route.primary.provider, route.primary.model], ['claude', 'opus']);
  assert.ok(![route.primary, ...route.fallbacks].some((item) => item.model === 'fable'));
});

test('explicit fable requests route but require per-task authorization', () => {
  const route = routeTask({ task: 'Hardest ambiguous migration', model: 'fable', usage: clear, availability: available });
  assert.deepEqual([route.primary.provider, route.primary.model], ['claude', 'fable']);
  assert.equal(route.primary.requiresAuthorization, true);
  assert.match(route.primary.reason, /authorization/);
});

test('removes a provider at the avoid threshold and selects a fallback', () => {
  const usage = { ...clear, cursor: { known: true, usedPercent: 95 } };
  const route = routeTask({ task: 'Implement the multi-file refactor and tests', usage, availability: available });
  assert.notEqual(route.primary.provider, 'cursor');
  assert.ok(route.excluded.some((item) => item.provider === 'cursor'));
});

test('keeps small contextual work in Claude', () => {
  const route = routeTask({ task: 'Rename this local variable', usage: clear, availability: available });
  assert.equal(route.primary.provider, 'claude');
  assert.equal(route.delegate, false);
});

test('per-provider avoid map excludes cursor at its stricter band while codex stays eligible', () => {
  const route = routeTask({
    task: 'Implement the multi-file refactor and update tests',
    usage: {
      claude: { known: false, usedPercent: null },
      codex: { known: true, usedPercent: 85 },
      cursor: { known: true, usedPercent: 85 }
    },
    availability: { claude: true, codex: true, cursor: true },
    avoidPercent: { claude: 90, codex: 90, cursor: 80 },
    warningPercent: { claude: 80, codex: 80, cursor: 70 }
  });
  const excludedProviders = route.excluded.map((item) => item.provider);
  assert.ok(excludedProviders.includes('cursor'));
  assert.ok(route.excluded.find((item) => item.provider === 'cursor').excluded.includes('avoid 80%'));
  assert.ok([route.primary, ...route.fallbacks].some((item) => item.provider === 'codex'));
});
