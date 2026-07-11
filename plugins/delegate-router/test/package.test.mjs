import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const plugin = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('plugin metadata and MCP registrations stay portable and version-aligned', () => {
  const runtime = JSON.parse(fs.readFileSync(path.join(plugin, 'package.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'));
  const mcp = JSON.parse(fs.readFileSync(path.join(plugin, '.mcp.json'), 'utf8'));
  assert.equal(runtime.version, manifest.version);
  assert.equal(manifest.version, '0.8.2');
  assert.equal(mcp.mcpServers.delegate_control.command, 'node');
  assert.match(mcp.mcpServers.delegate_control.args[0], /^\$\{CLAUDE_PLUGIN_ROOT\}/);
  assert.equal(mcp.mcpServers.delegate_codex.command, 'node');
  assert.match(mcp.mcpServers.delegate_codex.args[0], /delegate-codex-mcp$/);
  for (const executable of ['delegate-config', 'delegate-codex-mcp', 'delegate-control-mcp', 'delegate-worker', 'delegate-jobs']) {
    assert.match(fs.readFileSync(path.join(plugin, 'bin', executable), 'utf8'), /^#!\/usr\/bin\/env node/);
  }
});
