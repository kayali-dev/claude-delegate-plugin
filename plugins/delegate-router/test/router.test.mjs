import assert from 'node:assert/strict';
import test from 'node:test';
import { routeTask } from '../bin/lib/router.mjs';

const available = { claude: true, codex: true, cursor: true };
const clear = {
  claude: { known: false }, codex: { known: false }, cursor: { known: false }
};

test('routes clear implementation work to Composer', () => {
  const route = routeTask({ task: 'Implement the multi-file refactor and update tests', usage: clear, availability: available });
  assert.deepEqual([route.primary.provider, route.primary.model], ['cursor', 'composer']);
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
