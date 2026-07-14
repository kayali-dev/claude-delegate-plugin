import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../state.mjs';

export const DEFAULT_TUI_PREFERENCES = Object.freeze({
  theme: 'dark',
  notifications: true,
  timestampMode: 'absolute',
  fleetDensity: 'wide',
  widthProbeCache: Object.freeze({})
});

export function tuiPreferencesPath(options = {}) {
  return path.join(options.directory || dataDir(), 'tui-prefs.json');
}

function validated(value = {}) {
  const widthProbeCache = {};
  for (const [identity, entry] of Object.entries(value.widthProbeCache || {}).slice(-16)) {
    if (!identity || typeof entry !== 'object' || !entry) continue;
    const widths = {};
    for (const [grapheme, width] of Object.entries(entry.widths || {}).slice(0, 64)) {
      if (grapheme && Number.isInteger(width) && width >= 0 && width <= 2) widths[grapheme] = width;
    }
    if (Object.keys(widths).length) widthProbeCache[String(identity).slice(0, 320)] = { widths, measuredAt: Number(entry.measuredAt) || 0 };
  }
  return {
    theme: value.theme === 'light' ? 'light' : 'dark',
    notifications: value.notifications !== false,
    timestampMode: value.timestampMode === 'relative' ? 'relative' : 'absolute',
    fleetDensity: value.fleetDensity === 'compact' ? 'compact' : 'wide',
    widthProbeCache
  };
}

export function loadTuiPreferences(options = {}) {
  const env = options.env || process.env;
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(tuiPreferencesPath(options), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') stored = {}; }
  const preferences = validated({ ...DEFAULT_TUI_PREFERENCES, ...stored });
  if (env.DELEGATE_TUI_THEME) preferences.theme = String(env.DELEGATE_TUI_THEME).toLowerCase() === 'light' ? 'light' : 'dark';
  if (Object.hasOwn(env, 'DELEGATE_TUI_NOTIFY')) preferences.notifications = String(env.DELEGATE_TUI_NOTIFY) !== '0';
  if (env.DELEGATE_TUI_TIMESTAMP_MODE) preferences.timestampMode = String(env.DELEGATE_TUI_TIMESTAMP_MODE).toLowerCase() === 'relative' ? 'relative' : 'absolute';
  if (env.DELEGATE_TUI_DENSITY) preferences.fleetDensity = String(env.DELEGATE_TUI_DENSITY).toLowerCase() === 'compact' ? 'compact' : 'wide';
  return preferences;
}

export function saveTuiPreferences(preferences, options = {}) {
  const file = tuiPreferencesPath(options);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(validated(preferences), null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch {}
  return file;
}
