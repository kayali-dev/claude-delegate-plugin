import { performance } from 'node:perf_hooks';
import { cursorTo, sequences } from './ansi.mjs';
import { setGraphemeWidthOverrides } from './width.mjs';

// Included in terminalWidthIdentity so transport/parser changes invalidate
// measurements made by older probe implementations without touching prefs.
export const WIDTH_PROBE_VERSION = 3;

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
// several chunks. The caller retains only the unconsumed suffix, so an ordered
// reply is never reparsed or polled. Non-CPR CSI traffic is dropped as terminal
// chatter. A CPR-shaped but invalid response consumes exactly one ordered probe
// slot so the next valid CPR can resynchronize.
function parseCprWindow(raw, expectedRow, maximum, finalize = false) {
  const outcomes = [];
  let remainder = '';
  let offset = 0;
  while (offset < raw.length && outcomes.length < maximum) {
    const start = raw.indexOf('\u001b[', offset);
    if (start < 0) {
      remainder += raw.slice(offset);
      break;
    }
    remainder += raw.slice(offset, start);
    let final = start + 2;
    while (final < raw.length) {
      const code = raw.charCodeAt(final);
      if (code >= 0x40 && code <= 0x7e) break;
      final += 1;
    }
    if (final >= raw.length) {
      const partial = raw.slice(start);
      if (finalize && /^\u001b\[\d*;\d*$/.test(partial)) outcomes.push({ status: 'parse' });
      else remainder += partial;
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
      if (/^\d+;$/.test(numericPrefix) && terminator >= 0 && (nextEscape < 0 || terminator < nextEscape) && terminator - start <= 64) {
        responseEnd = terminator;
        finalByte = 'R';
      }
    }
    const sequence = raw.slice(start, responseEnd + 1);
    if (finalByte === 'R') {
      const match = /^\u001b\[(\d+);(\d+)R$/.exec(sequence);
      if (!match) {
        outcomes.push({ status: 'parse' });
      } else if (Number(match[1]) === expectedRow) {
        const measured = Number(match[2]) - 1;
        outcomes.push(Number.isInteger(measured) && measured >= 0 && measured <= 2
          ? { status: 'measured', width: measured }
          : { status: 'parse' });
      }
      // A valid CPR for another row is unrelated chatter. It is skipped and
      // does not consume a probe slot.
    }
    // Focus, mouse, paste and other complete CSI sequences are intentionally
    // skipped rather than being mistaken for a failed probe response.
    offset = responseEnd + 1;
  }
  if (offset < raw.length && outcomes.length >= maximum) remainder += raw.slice(offset);
  return { outcomes, remainder };
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

function clampMilliseconds(value, fallback, maximum = 500) {
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
  // timeoutMs is an idle/first-reply deadline, not a fixed whole-batch budget.
  // Some terminals serialize CPR responses across render cycles even though
  // every query was pipelined in one write. The first response and subsequent
  // cadence therefore expand the global batch budget, bounded at 500 ms.
  const timeoutMs = clampMilliseconds(options.timeoutMs, 50);
  const maximumBudgetMs = Math.max(timeoutMs, clampMilliseconds(options.maxBudgetMs, 500));
  const row = Math.max(0, Math.min(screen.rows - 1, Number(options.row ?? screen.rows - 1)));
  let parsed = { outcomes: [], remainder: '' };
  let pendingRaw = '';
  const started = performance.now();
  const packet = probes.map((grapheme) => `${cursorTo(row, 0)}${sequences.clearLine}${grapheme}\u001b[6n`).join('');
  const displacedListeners = rawDataListeners(input);
  const wasPaused = typeof input.isPaused === 'function' ? input.isPaused() : false;
  try { input.pause?.(); } catch {}
  for (const listener of displacedListeners) removeDataListener(input, listener);
  let completion = 'timeout';
  const pending = new Promise((resolve) => {
    let finished = false;
    let firstReplyTimer;
    let idleTimer;
    let budgetTimer;
    let firstReplyMs = null;
    let previousProgressAt = null;
    let observedCadenceMs = 0;
    let observedCount = 0;
    const clearTimers = () => {
      clearTimeout(firstReplyTimer);
      clearTimeout(idleTimer);
      clearTimeout(budgetTimer);
    };
    const restoreInput = () => {
      try { input.pause?.(); } catch {}
      removeDataListener(input, check);
      for (const listener of displacedListeners) input.on('data', listener);
      try {
        if (!wasPaused) input.resume?.();
      } catch {}
    };
    const done = (reason) => {
      if (finished) return;
      finished = true;
      completion = reason;
      clearTimers();
      restoreInput();
      resolve();
    };
    const scheduleProgressDeadlines = (now) => {
      const elapsed = Math.max(0.1, now - started);
      if (firstReplyMs == null) firstReplyMs = elapsed;
      if (previousProgressAt != null) observedCadenceMs = Math.max(observedCadenceMs, now - previousProgressAt);
      previousProgressAt = now;
      const cadence = Math.max(1, firstReplyMs, observedCadenceMs);
      const remaining = Math.max(0, probes.length - observedCount);
      const projectedBudget = Math.ceil(elapsed + cadence * (remaining + 2));
      const idleDelay = Math.min(maximumBudgetMs, Math.max(timeoutMs, Math.ceil(cadence * 3)));
      const budgetMs = Math.min(maximumBudgetMs, Math.max(timeoutMs, projectedBudget, Math.ceil(elapsed + idleDelay + 1)));
      clearTimeout(budgetTimer);
      budgetTimer = setTimeout(() => done('budget'), Math.max(1, budgetMs - elapsed));
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => done('timeout'), idleDelay);
    };
    const check = (chunk) => {
      if (finished || chunk == null) return;
      pendingRaw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      const next = parseCprWindow(pendingRaw, row + 1, probes.length - parsed.outcomes.length);
      parsed = { outcomes: [...parsed.outcomes, ...next.outcomes], remainder: next.remainder };
      pendingRaw = next.remainder;
      if (parsed.outcomes.length > observedCount) {
        observedCount = parsed.outcomes.length;
        clearTimeout(firstReplyTimer);
        if (observedCount >= probes.length) {
          done('complete');
          return;
        }
        scheduleProgressDeadlines(performance.now());
      }
    };
    const drainReadable = () => {
      if (typeof input.read !== 'function') return;
      let chunk;
      while ((chunk = input.read()) != null) check(chunk);
    };
    input.on('data', check);
    // Claim already-readable bytes before the decoder is restored. This also
    // handles an in-memory/synchronous TTY double that buffers its reply before
    // the output write returns.
    drainReadable();
    if (!finished) {
      if (observedCount === 0) firstReplyTimer = setTimeout(() => done('timeout'), timeoutMs);
      try { input.resume?.(); } catch {}
      const pendingPacket = observedCount > 0
        ? probes.slice(observedCount).map((grapheme) => `${cursorTo(row, 0)}${sequences.clearLine}${grapheme}\u001b[6n`).join('')
        : packet;
      if (pendingPacket) screen.writeOutput(pendingPacket, { context: 'probe' });
      drainReadable();
    }
  });
  await pending;
  const elapsedMs = performance.now() - started;
  screen.writeOutput(`${cursorTo(row, 0)}${sequences.clearLine}${sequences.home}`, { context: 'probe' });
  const finalParsed = parseCprWindow(pendingRaw, row + 1, probes.length - parsed.outcomes.length, true);
  parsed = { outcomes: [...parsed.outcomes, ...finalParsed.outcomes], remainder: finalParsed.remainder };
  const outcomes = namedOutcomes(probes, parsed.outcomes, completion === 'budget' ? 'budget' : 'timeout');
  const widths = {};
  for (const outcome of outcomes) if (outcome.status === 'measured') widths[outcome.grapheme] = outcome.width;
  if (Object.keys(widths).length) setGraphemeWidthOverrides(widths);
  return {
    source: Object.keys(widths).length ? 'probe' : 'fallback',
    widths, outcomes, elapsedMs, mode, remainder: parsed.remainder
  };
}

export function formatWidthProbeResult(result) {
  const entries = Object.entries(result?.widths || {}).map(([grapheme, width]) => `${JSON.stringify(grapheme)}=${width}`).join(', ');
  const families = familyProbeSummary(result?.outcomes || []);
  return `width probe ${result?.source || 'unknown'} in ${Number(result?.elapsedMs || 0).toFixed(1)}ms${families ? `: ${families}` : ''}${entries ? `; widths ${entries}` : ''}`;
}
