import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brokerError } from './errors.mjs';

const PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const DEFAULT_KEYS = new Set(['mode', 'model', 'effort', 'allowedPaths', 'reportSchema']);

export function profilesDir() {
  return process.env.DELEGATE_PROFILES_DIR || path.join(os.homedir(), '.delegate', 'profiles');
}

function bundledProfilePath(name) {
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  return path.join(pluginRoot, 'skills', 'delegate', 'profiles', `${name}.md`);
}

function parseAllowedPaths(value) {
  const text = String(value || '').trim();
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {}
  }
  return text.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseReportSchema(value, name) {
  try {
    const parsed = JSON.parse(String(value || '').trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  throw brokerError('INVALID_REQUEST', `profile '${name}' reportSchema must be a JSON object on one line`);
}

export function parseProfile(text, name = 'profile') {
  const match = String(text).match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/);
  if (!match) throw brokerError('INVALID_REQUEST', `profile '${name}' must begin with simple --- frontmatter`);
  const defaults = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const field = line.match(/^([^:]+):\s*(.*)$/);
    if (!field) throw brokerError('INVALID_REQUEST', `invalid frontmatter line in profile '${name}': ${rawLine}`);
    const key = field[1].trim();
    if (!DEFAULT_KEYS.has(key)) continue;
    defaults[key] = key === 'allowedPaths'
      ? parseAllowedPaths(field[2])
      : key === 'reportSchema' ? parseReportSchema(field[2], name) : field[2].trim();
  }
  const body = match[2].trim();
  if (!body.includes('{{objective}}')) throw brokerError('INVALID_REQUEST', `profile '${name}' must contain {{objective}} in its body`);
  return { defaults, body };
}

export function loadProfile(name) {
  if (typeof name !== 'string' || !PROFILE_NAME.test(name)) {
    throw brokerError('INVALID_REQUEST', 'profile must be 1-64 characters using letters, numbers, _, ., or -');
  }
  const local = path.join(profilesDir(), `${name}.md`);
  let file = local;
  if (!fs.existsSync(file) && name === 'independent-review') file = bundledProfilePath(name);
  if (!fs.existsSync(file)) throw brokerError('NOT_FOUND', `profile not found: ${name}`);
  return { name, path: file, local: file === local, ...parseProfile(fs.readFileSync(file, 'utf8'), name) };
}

export function applyProfile(options) {
  if (!options.profile) return { ...options };
  const profile = loadProfile(options.profile);
  const objective = String(options.prompt || '').trim();
  if (!objective) throw brokerError('INVALID_REQUEST', 'prompt objective is required when profile is set');
  const merged = { ...profile.defaults, ...options };
  for (const key of DEFAULT_KEYS) if (options[key] == null && profile.defaults[key] != null) merged[key] = profile.defaults[key];
  merged.prompt = profile.body.replaceAll('{{objective}}', objective);
  merged.profile = profile.name;
  merged.profilePath = profile.path;
  return merged;
}

const REQUIRED_SECTIONS = ['Objective', 'Allowed scope', 'Acceptance criteria', 'Return'];

export function lintPacket(packet) {
  const text = String(packet || '');
  return REQUIRED_SECTIONS.filter((section) => {
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(`^(?:#{1,6}\\s*)?${escaped}(?:\\s*:|\\s*$)`, 'im').test(text);
  });
}
