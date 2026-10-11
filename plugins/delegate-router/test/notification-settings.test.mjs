import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { notificationMode, setNotificationMode, notificationSettingsPath } from '../bin/lib/notification-settings.mjs';
import { notificationHealth } from '../bin/lib/notification-health.mjs';
import { NotificationHandoff } from '../bin/lib/notification-handoff.mjs';
import { DelegateMonitor } from '../bin/lib/monitor-runtime.mjs';

const plugin = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-notification-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const job = (extra = {}) => ({ id: 'live-job', provider: 'codex', status: 'running', revision: 1,
  origin: { sessionId: 'owner', workspaceId: '/tmp/project' }, ...extra });

test('notification configuration defaults to native, persists privately and never changes providers', (t) => {
  const root = fixture(t);
  assert.equal(notificationMode(root), 'native');
  for (const mode of ['legacy-persistent', 'off', 'native']) {
    assert.equal(setNotificationMode(mode, root), mode);
    assert.equal(notificationMode(root), mode);
  }
  assert.equal(fs.statSync(notificationSettingsPath(root)).mode & 0o777, 0o600);
  assert.throws(() => setNotificationMode('both', root), /INVALID_REQUEST/);
  assert.throws(() => setNotificationMode('native; echo unsafe', root), /INVALID_REQUEST/);
  const env = { ...process.env, DELEGATE_STATE_FILE: path.join(root, 'usage.json'), DELEGATE_ENABLED_PROVIDERS: 'codex' };
  const result = spawnSync(process.execPath, [path.join(plugin, 'bin/delegate-config'), 'notifications', 'legacy-persistent'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mode, 'legacy-persistent');
  assert.ok(!fs.existsSync(path.join(root, 'providers.json')));
});

test('configured legacy launcher exits in native/off mode without inventory, timers, correlation or state writes', (t) => {
  const root = fixture(t);
  const env = { ...process.env, DELEGATE_STATE_FILE: path.join(root, 'usage.json') };
  const result = spawnSync(process.execPath, [path.join(plugin, 'bin/delegate-monitor'), '--configured'], { env, encoding: 'utf8', timeout: 2000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(fs.readdirSync(root), []);
  setNotificationMode('off', root);
  const off = spawnSync(process.execPath, [path.join(plugin, 'bin/delegate-monitor'), '--configured'], { env, encoding: 'utf8', timeout: 2000 });
  assert.equal(off.status, 0);
  assert.equal(off.stdout, '');
});

test('missing coordinator identity cannot claim unbound jobs as fallback work', (t) => {
  const root = fixture(t), previous = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  try {
    const health = notificationHealth({ projectDir: '/tmp/project' }, { stateDirectory: root, enabled: ['codex'], jobs: [job({ origin: {} })] });
    assert.equal(health.liveJobCount, 0);
    assert.equal(health.needsFallback, false);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = previous;
  }
});

test('invalid or unsafe notification settings never silently enable a persistent monitor', (t) => {
  const root = fixture(t), file = notificationSettingsPath(root), target = path.join(root, 'target');
  fs.writeFileSync(target, JSON.stringify({ version: 1, mode: 'legacy-persistent' }), { mode: 0o600 });
  fs.symlinkSync(target, file);
  assert.throws(() => notificationMode(root), /STATE_ERROR/);
  fs.unlinkSync(file);
  fs.writeFileSync(file, 'x'.repeat(2048), { mode: 0o600 });
  assert.throws(() => notificationMode(root), /STATE_ERROR/);
  fs.writeFileSync(file, JSON.stringify({ version: 1, mode: 'legacy-persistent' }));
  fs.chmodSync(file, 0o644);
  assert.throws(() => notificationMode(root), /STATE_ERROR/);
});

test('delivery health distinguishes live ownership, disabled providers, explicit opt-outs and a healthy lease', (t) => {
  const root = fixture(t), input = { sessionId: 'owner', projectDir: '/tmp/project' };
  const options = { stateDirectory: root, enabled: ['codex'], jobs: [job(), job({ id: 'foreign', origin: { sessionId: 'other' } }), job({ id: 'disabled', provider: 'cursor' })] };
  assert.equal(notificationHealth(input, options).liveJobCount, 1);
  assert.equal(notificationHealth(input, options).needsFallback, true);
  assert.equal(notificationHealth({ ...input, scope: 'off' }, options).ambientEnabled, false);
  assert.equal(notificationHealth({ ...input, scope: 'off' }, options).needsFallback, false);
  assert.equal(notificationHealth(input, { ...options, jobs: [job({ status: 'completed' })] }).needsFallback, false);
  const handoff = new NotificationHandoff({ ...input, stateDirectory: root });
  handoff.scan('native', () => []);
  assert.equal(notificationHealth(input, options).native, 'healthy');
  assert.equal(notificationHealth(input, options).needsFallback, false);
  handoff.setDeliveryEnabled(false);
  assert.equal(notificationHealth(input, options).native, 'disabled');
  assert.equal(notificationHealth(input, options).needsFallback, false);
  handoff.setDeliveryEnabled(true);
  assert.equal(notificationHealth(input, options).needsFallback, true);
  setNotificationMode('off', root);
  assert.equal(notificationHealth(input, options).needsFallback, false);
  setNotificationMode('legacy-persistent', root);
  assert.equal(notificationHealth(input, options).needsFallback, false);
});

test('fallback drains terminal edges and stops with no live work or when native delivery recovers', (t) => {
  const root = fixture(t), emitted = [];
  let observations = [{ job: job(), events: [] }];
  const store = { stateDirectory: root, directory: root, scan: () => observations, readPreference: () => ({}) };
  const options = { store, sessionId: 'owner', projectDir: '/tmp/project', env: {}, lifetime: 'fallback', emit: (line) => emitted.push(line) };
  const monitor = new DelegateMonitor(options);
  monitor.start();
  t.after(() => monitor.stop());
  assert.equal(monitor.closed, false, 'quiet investigation is still live work');
  observations = [{ job: job({ status: 'failed', errorCode: 'PROVIDER_ERROR' }), events: [] }];
  monitor.scan();
  assert.ok(emitted.some((line) => line.includes('failure')));
  assert.equal(monitor.closed, true);
  assert.equal(monitor.watchers.size, 0);
  observations = [{ job: job(), events: [] }];
  new NotificationHandoff({ stateDirectory: root, sessionId: 'owner', projectDir: '/tmp/project' }).scan('native', () => []);
  const recovered = new DelegateMonitor(options);
  recovered.start();
  assert.equal(recovered.closed, true);
  assert.equal(recovered.pollTimer, null);
});

test('explicit persistent mode stays alive when idle and stops after configuration changes', (t) => {
  const root = fixture(t);
  setNotificationMode('legacy-persistent', root);
  const store = { stateDirectory: root, directory: root, scan: () => [], readPreference: () => ({}) };
  const monitor = new DelegateMonitor({ store, sessionId: 'owner', projectDir: '/tmp/project', env: {}, configured: true, lifetime: 'persistent', emit: () => {} });
  t.after(() => monitor.stop());
  monitor.start();
  assert.equal(monitor.closed, false);
  setNotificationMode('native', root);
  monitor.scan();
  assert.equal(monitor.closed, true);
});
