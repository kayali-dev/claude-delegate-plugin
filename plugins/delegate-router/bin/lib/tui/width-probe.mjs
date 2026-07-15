import { performance } from 'node:perf_hooks';
import { cursorTo, sequences } from './ansi.mjs';
import { setGraphemeWidthOverrides } from './width.mjs';

// Included in terminalWidthIdentity so transport/parser changes invalidate
// measurements made by older probe implementations without touching prefs.
export const WIDTH_PROBE_VERSION = 3;
export const WIDTH_PROBE_STRAGGLER_GRACE_MS = 10000;

export const WIDTH_PROBE_GRAPHEMES = Object.freeze([
  // UI chrome candidates. Box drawing, blocks, punctuation and symbols are
  // EastAsianWidth=Ambiguous and therefore usable only when CPR says width 1.
  '─', '│', '┌', '┐', '└', '┘', '├', '┤', '╭', '╮', '╰', '╯',
  '┃', '░', '█', '▏', '▎', '▍', '▌', '▋', '▊', '▉',
  '▁', '▂', '▃', '▄', '▅', '▆', '▇', '…', '·', '○',
  // Braille spinner frames are statically safe, but measuring them keeps the
  // cache a complete record of the actual tmux/terminal layer.
  '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧',
  '⚙', '✎', '⇅', '›', '⏳', '🧠', '✍', '▶', '✓', '✗', '—',
  '🙂', '✈️', '👩‍💻', '👍🏽', 'Ω', `a\u0301\u0323`
]);

export const WIDTH_PROBE_FAMILIES = Object.freeze({
  borders: Object.freeze(['─', '│', '┌', '┐', '└', '┘', '├', '┤', '╭', '╮', '╰', '╯']),
  scrollbar: Object.freeze(['┃', '░']),
  meters: Object.freeze(['█', '▏', '▎', '▍', '▌', '▋', '▊', '▉']),
  sparkline: Object.freeze(['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']),
  punctuation: Object.freeze(['…', '·', '○']),
  spinner: Object.freeze(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧']),
  tools: Object.freeze(['⚙', '✎', '⇅', '›']),
  statuses: Object.freeze(['⏳', '🧠', '✍', '▶', '✓', '✗', '—']),
  content: Object.freeze(['🙂', '✈️', '👩‍💻', '👍🏽', 'Ω', `a\u0301\u0323`])
});

function identityPart(value, maximum = 80) {
  return String(value || '').replace(/[\u0000-\u001f\u007f|]/g, '').slice(0, maximum) || '-';
}

export function terminalWidthIdentity(env = process.env) {
  const term = identityPart(env.TERM);
  const tmux = env.TMUX || /^(?:screen|tmux)/i.test(term) ? 'tmux' : 'direct';
  return `term=${term}|program=${identityPart(env.TERM_PROGRAM)}|version=${identityPart(env.TERM_PROGRAM_VERSION)}|mux=${tmux}|probeVersion=${WIDTH_PROBE_VERSION}`;
}

export function widthProbeMode(env = process.env) {
  const mode = String(env.DELEGATE_TUI_WIDTH_PROBE || '').toLowerCase();
  if (mode === 'off') return 'off';
  if (mode === 'verbose') return 'verbose';
  return 'auto';
}

// Parse one streaming probe window without assuming one CPR per chunk:
// Ghostty commonly coalesces replies, while SSH/tmux may split one reply over
// several chunks. Only CPRs addressed to the probe row are consumed. Everything
// else is returned in order for the real input decoder; this distinction is
// essential once the patient continuation overlaps ordinary TUI input.
function parseCprWindow(raw, expectedRow, maximum, finalize = false) {
  const outcomes = [];
  let passthrough = '';
  let remainder = '';
  let offset = 0;
  while (offset < raw.length) {
    const start = raw.indexOf('\u001b[', offset);
    if (start < 0) {
      passthrough += raw.slice(offset);
      break;
    }
    passthrough += raw.slice(offset, start);
    let final = start + 2;
    while (final < raw.length) {
      const code = raw.charCodeAt(final);
      if (code >= 0x40 && code <= 0x7e) break;
      final += 1;
    }
    if (final >= raw.length) {
      const partial = raw.slice(start);
      if (finalize) passthrough += partial;
      else remainder = partial;
      break;
    }
    let responseEnd = final;
    let finalByte = raw[final];
    if (finalByte !== 'R') {
      // A malformed CPR can contain an illegal final byte in its numeric
      // parameter field. If it began like row/column data and reaches R before
      // the next escape, consume it as one failed ordered response; ordinary
      // focus/mouse CSI never has this shape and remains ignorable chatter.
      const nextEscape = raw.indexOf('\u001b[', final + 1);
      const terminator = raw.indexOf('R', final + 1);
      const numericPrefix = raw.slice(start + 2, final);
      if (numericPrefix === `${expectedRow};` && terminator >= 0 && (nextEscape < 0 || terminator < nextEscape) && terminator - start <= 64) {
        responseEnd = terminator;
        finalByte = 'R';
      }
    }
    const sequence = raw.slice(start, responseEnd + 1);
    if (finalByte === 'R') {
      const match = /^\u001b\[(\d+);(\d+)R$/.exec(sequence);
      if (!match) {
        if (sequence.startsWith(`\u001b[${expectedRow};`)) {
          if (outcomes.length < maximum) outcomes.push({ status: 'parse' });
        } else passthrough += sequence;
      } else if (Number(match[1]) === expectedRow) {
        const measured = Number(match[2]) - 1;
        if (outcomes.length < maximum) {
          outcomes.push(Number.isInteger(measured) && measured >= 0 && measured <= 2
            ? { status: 'measured', width: measured }
            : { status: 'parse' });
        }
      } else passthrough += sequence;
    } else passthrough += sequence;
    offset = responseEnd + 1;
  }
  return { outcomes, passthrough, remainder };
}

function namedOutcomes(probes, parsed, incompleteStatus = 'timeout') {
  return probes.map((grapheme, index) => Object.freeze({
    grapheme,
    ...(parsed[index] || { status: incompleteStatus })
  }));
}

function cachedOutcomes(widths) {
  return Object.entries(widths).map(([grapheme, width]) => Object.freeze({ grapheme, status: 'measured', width }));
}

function familyProbeSummary(outcomes = []) {
  const byGrapheme = new Map(outcomes.map((entry) => [entry.grapheme, entry]));
  const summaries = [];
  for (const [family, graphemes] of Object.entries(WIDTH_PROBE_FAMILIES)) {
    const entries = graphemes.map((grapheme) => byGrapheme.get(grapheme)).filter(Boolean);
    if (!entries.length) continue;
    if (entries.some((entry) => entry.status === 'parse')) {
      summaries.push(`${family}=unproven(parse)`);
      continue;
    }
    if (entries.some((entry) => entry.status === 'no-raw-mode')) {
      summaries.push(`${family}=unproven(no-raw-mode)`);
      continue;
    }
    if (entries.some((entry) => entry.status === 'budget')) {
      summaries.push(`${family}=unproven(budget)`);
      continue;
    }
    if (entries.some((entry) => entry.status !== 'measured')) {
      summaries.push(`${family}=unproven(timeout)`);
      continue;
    }
    const widths = [...new Set(entries.map((entry) => entry.width))].sort((left, right) => left - right);
    summaries.push(`${family}=measured-width(${widths.join('/')})`);
  }
  return summaries.join(', ');
}

function establishRawMode(input) {
  if (input?.isRaw === true) return true;
  if (input?.isTTY !== true || typeof input.setRawMode !== 'function') return false;
  try {
    input.setRawMode(true);
  } catch {
    return false;
  }
  // Node's tty.ReadStream exposes isRaw. Test doubles and compatible streams
  // may not, so a successful setRawMode call is the strongest available
  // assertion unless the stream explicitly reports that it remained false.
  return input.isRaw !== false;
}

function rawDataListeners(input) {
  if (typeof input.rawListeners === 'function') return input.rawListeners('data');
  if (typeof input.listeners === 'function') return input.listeners('data');
  return [];
}

function removeDataListener(input, listener) {
  if (typeof input.off === 'function') input.off('data', listener);
  else if (typeof input.removeListener === 'function') input.removeListener('data', listener);
}

function clampMilliseconds(value, fallback, maximum = 5000) {
  return Math.max(1, Math.min(maximum, Number.isFinite(Number(value)) ? Number(value) : fallback));
}

export async function probeTerminalWidths(options = {}) {
  const env = options.env || process.env;
  const mode = options.mode || widthProbeMode(env);
  const cached = options.cached?.widths || options.cached || null;
  if (cached && Object.keys(cached).length) {
    setGraphemeWidthOverrides(cached);
    return { source: 'cache', widths: { ...cached }, outcomes: cachedOutcomes(cached), elapsedMs: 0, mode, remainder: '' };
  }
  if (mode === 'off') return { source: 'off', widths: {}, outcomes: [], elapsedMs: 0, mode, remainder: '' };
  const screen = options.screen;
  const input = options.input || screen?.input;
  if (!screen || !input || typeof input.on !== 'function') return { source: 'unsupported', widths: {}, outcomes: [], elapsedMs: 0, mode, remainder: '' };
  const probes = options.probes || WIDTH_PROBE_GRAPHEMES;
  if (!establishRawMode(input)) {
    return {
      source: 'fallback', widths: {}, elapsedMs: 0, mode, remainder: '',
      outcomes: namedOutcomes(probes, [], 'no-raw-mode')
    };
  }
  const foregroundMs = clampMilliseconds(options.foregroundMs ?? options.timeoutMs, 50, 500);
  const backgroundIdleMs = clampMilliseconds(options.backgroundIdleMs, 2000);
  const backgroundBudgetMs = Math.max(foregroundMs + 1,
    clampMilliseconds(options.backgroundBudgetMs ?? options.maxBudgetMs, 5000));
  const row = Math.max(0, Math.min(screen.rows - 1, Number(options.row ?? screen.rows - 1)));
  let parsedOutcomes = [];
  let pendingRaw = '';
  let foregroundPassthrough = '';
  let queuedPassthrough = [];
  const started = performance.now();
  const packet = probes.map((grapheme) => `${cursorTo(row, 0)}${sequences.clearLine}${grapheme}\u001b[6n`).join('');
  const displacedListeners = rawDataListeners(input);
  const wasPaused = typeof input.isPaused === 'function' ? input.isPaused() : false;
  try { input.pause?.(); } catch {}
  for (const listener of displacedListeners) removeDataListener(input, listener);
  let state = 'foreground';
  let foregroundTimer;
  let idleTimer;
  let budgetTimer;
  let stragglerTimer;
  let stragglerRaw = Buffer.alloc(0);
  let stragglerActive = false;
  let foregroundResolve;
  let backgroundResolve;
  let releasedResolve;
  const targets = [...displacedListeners];
  const foreground = new Promise((resolve) => { foregroundResolve = resolve; });
  const backgroundDone = new Promise((resolve) => { backgroundResolve = resolve; });
  const released = new Promise((resolve) => { releasedResolve = resolve; });

  const clearTimers = () => {
    clearTimeout(foregroundTimer);
    clearTimeout(idleTimer);
    clearTimeout(budgetTimer);
    clearTimeout(stragglerTimer);
  };
  const deliverPassthrough = (value) => {
    if (!value || value.length === 0) return;
    if (targets.length) {
      for (const listener of [...targets]) listener(value);
    } else queuedPassthrough.push(value);
  };
  const emitPassthrough = (value) => {
    if (!value) return;
    if (state === 'foreground') {
      foregroundPassthrough += value;
      return;
    }
    deliverPassthrough(value);
  };
  const finishStragglerStage = () => {
    if (!stragglerActive) return false;
    clearTimeout(stragglerTimer);
    const finalParsed = parseCprWindow(stragglerRaw.toString('latin1'), row + 1, Number.MAX_SAFE_INTEGER, true);
    stragglerRaw = Buffer.alloc(0);
    deliverPassthrough(Buffer.from(finalParsed.passthrough, 'latin1'));
    try { input.pause?.(); } catch {}
    removeDataListener(input, swallowStragglers);
    for (const listener of targets) input.on('data', listener);
    stragglerActive = false;
    try {
      if (!wasPaused) input.resume?.();
    } catch {}
    releasedResolve();
    return true;
  };
  const swallowStragglers = (chunk) => {
    if (!stragglerActive || chunk == null) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ''), 'utf8');
    stragglerRaw = stragglerRaw.length ? Buffer.concat([stragglerRaw, bytes]) : bytes;
    const parsed = parseCprWindow(stragglerRaw.toString('latin1'), row + 1, Number.MAX_SAFE_INTEGER);
    stragglerRaw = Buffer.from(parsed.remainder, 'latin1');
    deliverPassthrough(Buffer.from(parsed.passthrough, 'latin1'));
  };
  const restoreInput = (swallowLateCprs = false) => {
    try { input.pause?.(); } catch {}
    removeDataListener(input, check);
    if (swallowLateCprs) {
      stragglerActive = true;
      input.on('data', swallowStragglers);
      const graceMs = clampMilliseconds(options.stragglerGraceMs, WIDTH_PROBE_STRAGGLER_GRACE_MS, WIDTH_PROBE_STRAGGLER_GRACE_MS);
      stragglerTimer = setTimeout(finishStragglerStage, graceMs);
      stragglerTimer.unref?.();
    } else {
      for (const listener of targets) input.on('data', listener);
      releasedResolve();
    }
    try {
      if (!wasPaused) input.resume?.();
    } catch {}
  };
  const snapshot = (reason, phase, apply) => {
    const outcomes = namedOutcomes(probes, parsedOutcomes, reason === 'budget' ? 'budget' : 'timeout');
    const widths = {};
    for (const outcome of outcomes) if (outcome.status === 'measured') widths[outcome.grapheme] = outcome.width;
    if (apply && Object.keys(widths).length) setGraphemeWidthOverrides(widths);
    return {
      source: apply && Object.keys(widths).length ? 'probe' : 'fallback',
      widths: apply ? widths : {}, outcomes, elapsedMs: performance.now() - started,
      mode, phase, completion: reason, remainder: foregroundPassthrough
    };
  };
  const finalize = (reason, apply = true) => {
    if (state === 'done') return;
    const finishingPhase = state;
    const finalParsed = parseCprWindow(pendingRaw, row + 1, probes.length - parsedOutcomes.length, true);
    parsedOutcomes = [...parsedOutcomes, ...finalParsed.outcomes];
    pendingRaw = '';
    emitPassthrough(finalParsed.passthrough);
    clearTimers();
    state = 'done';
    restoreInput(finishingPhase === 'background' && reason !== 'complete');
    const result = snapshot(reason, finishingPhase, apply);
    if (finishingPhase === 'foreground') foregroundResolve(result);
    else {
      backgroundResolve(result);
      if (typeof options.onBackgroundComplete === 'function') {
        try { options.onBackgroundComplete(result); } catch {}
      }
    }
    if (finishingPhase === 'foreground') backgroundResolve(result);
  };
  const scheduleBackgroundIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => finalize('timeout'), backgroundIdleMs);
    idleTimer.unref?.();
  };
  const enterBackground = () => {
    if (state !== 'foreground') return;
    state = 'background';
    clearTimeout(foregroundTimer);
    const initial = snapshot('timeout', 'foreground', false);
    foregroundResolve({ ...initial, background });
    scheduleBackgroundIdle();
    const remainingBudget = Math.max(1, backgroundBudgetMs - (performance.now() - started));
    budgetTimer = setTimeout(() => finalize('budget'), remainingBudget);
    budgetTimer.unref?.();
  };
  const check = (chunk) => {
    if (state === 'done' || chunk == null) return;
    pendingRaw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    const before = parsedOutcomes.length;
    const next = parseCprWindow(pendingRaw, row + 1, probes.length - parsedOutcomes.length);
    parsedOutcomes = [...parsedOutcomes, ...next.outcomes];
    pendingRaw = next.remainder;
    emitPassthrough(next.passthrough);
    if (state === 'background' && parsedOutcomes.length > before) scheduleBackgroundIdle();
    if (parsedOutcomes.length >= probes.length) finalize('complete');
  };
  const drainReadable = () => {
    if (typeof input.read !== 'function') return;
    let chunk;
    while ((chunk = input.read()) != null) check(chunk);
  };
  const background = Object.freeze({
    get active() { return state === 'background'; },
    get passive() { return stragglerActive; },
    done: backgroundDone,
    released,
    attach(listener) {
      if (typeof listener !== 'function' || targets.includes(listener)) return false;
      targets.push(listener);
      if (state === 'done' && !stragglerActive) input.on('data', listener);
      if (queuedPassthrough.length) {
        const queued = queuedPassthrough;
        queuedPassthrough = [];
        for (const chunk of queued) listener(chunk);
      }
      return true;
    },
    detach(listener) {
      const index = targets.indexOf(listener);
      if (index >= 0) targets.splice(index, 1);
      if (state === 'done' && !stragglerActive) removeDataListener(input, listener);
      return index >= 0;
    },
    teardown() {
      if (state !== 'background') return false;
      finalize('cancelled', false);
      return true;
    }
  });

  input.on('data', check);
  drainReadable();
  if (state !== 'done') {
    try { input.resume?.(); } catch {}
    const pendingPacket = parsedOutcomes.length > 0
      ? probes.slice(parsedOutcomes.length).map((grapheme) => `${cursorTo(row, 0)}${sequences.clearLine}${grapheme}\u001b[6n`).join('')
      : packet;
    if (pendingPacket) screen.writeOutput(pendingPacket, { context: 'probe' });
    drainReadable();
  }
  if (state !== 'done') {
    foregroundTimer = setTimeout(enterBackground, foregroundMs);
    foregroundTimer.unref?.();
  }
  const result = await foreground;
  screen.writeOutput(`${cursorTo(row, 0)}${sequences.clearLine}${sequences.home}`, { context: 'probe' });
  return result;
}

export function formatWidthProbeResult(result) {
  const entries = Object.entries(result?.widths || {}).map(([grapheme, width]) => `${JSON.stringify(grapheme)}=${width}`).join(', ');
  const families = familyProbeSummary(result?.outcomes || []);
  const phase = result?.phase ? ` (${result.phase})` : '';
  return `width probe ${result?.source || 'unknown'}${phase} in ${Number(result?.elapsedMs || 0).toFixed(1)}ms${families ? `: ${families}` : ''}${entries ? `; widths ${entries}` : ''}`;
}
