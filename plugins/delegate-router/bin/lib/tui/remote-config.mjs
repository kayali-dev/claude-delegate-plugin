import fs from 'node:fs';
import path from 'node:path';
import { redact } from '../control.mjs';
import { dataDir } from '../state.mjs';

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_REMOTES = 16;

export function redactedRemoteLabel(value, fallback = 'remote') {
  const label = String(redact(String(value || ''))).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  const safeFallback = String(redact(String(fallback || 'remote'))).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return label || safeFallback || 'remote';
}

export function normalizeRemoteUrl(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('remote URL must use http or https');
  if (url.username || url.password || url.search || url.hash) throw new Error('remote URL must not contain credentials, query, or fragment');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

export function readRemotesConfig(options = {}) {
  const stateDirectory = path.resolve(String(options.stateDir || dataDir()));
  const file = path.resolve(String(options.file || path.join(stateDirectory, 'remotes.json')));
  let text;
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_CONFIG_BYTES) throw new Error(`${file} exceeds 64 KiB`);
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { file, remotes: [] };
    throw error;
  }
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error(`${file} must contain a JSON array`);
  if (parsed.length > MAX_REMOTES) throw new Error(`${file} may contain at most ${MAX_REMOTES} remotes`);
  const remotes = parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${file} entry ${index + 1} must be an object`);
    const unknown = Object.keys(entry).filter((key) => !['url', 'tokenFile', 'label'].includes(key));
    if (unknown.length) throw new Error(`${file} entry ${index + 1} has unknown fields: ${unknown.join(', ')}`);
    const url = normalizeRemoteUrl(entry.url);
    const tokenFile = entry.tokenFile == null ? null : path.resolve(stateDirectory, String(entry.tokenFile));
    return { url: url.href, label: redactedRemoteLabel(entry.label, url.host), tokenFile, source: 'config' };
  });
  return { file, remotes };
}

function readToken(file, fallback, sourceLabel) {
  let token = '';
  if (file) token = fs.readFileSync(file, 'utf8').trim();
  else token = String(fallback || '').trim();
  if (!token || /\s/.test(token)) throw new Error(file
    ? `${sourceLabel} token file must contain one non-empty token without whitespace`
    : `DELEGATE_CONNECT_TOKEN is required for ${sourceLabel} when --token-file is omitted`);
  return token;
}

export function resolveRemoteTargets(options = {}) {
  const connects = options.connects || [];
  const tokenFiles = options.tokenFiles || [];
  if (tokenFiles.length > connects.length) throw new Error('each --token-file must pair by order with a --connect target');
  const configured = options.includeConfig === false ? [] : readRemotesConfig(options).remotes;
  const merged = new Map();
  for (const target of configured) merged.set(normalizeRemoteUrl(target.url).href, target);
  connects.forEach((value, index) => {
    const url = normalizeRemoteUrl(value);
    merged.set(url.href, {
      url: url.href,
      label: redactedRemoteLabel(url.host),
      tokenFile: tokenFiles[index] ? path.resolve(String(tokenFiles[index])) : null,
      source: 'cli'
    });
  });
  if (merged.size > MAX_REMOTES) throw new Error(`at most ${MAX_REMOTES} remote targets are supported`);
  return [...merged.values()].map((target) => ({
    ...target,
    token: readToken(target.tokenFile, options.env?.DELEGATE_CONNECT_TOKEN ?? process.env.DELEGATE_CONNECT_TOKEN, target.label)
  }));
}
