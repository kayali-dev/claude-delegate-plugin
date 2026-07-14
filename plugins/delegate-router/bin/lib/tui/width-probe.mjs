import { performance } from 'node:perf_hooks';
import { cursorTo, sequences } from './ansi.mjs';
import { setGraphemeWidthOverrides } from './width.mjs';

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

function identityPart(value, maximum = 80) {
  return String(value || '').replace(/[\u0000-\u001f\u007f|]/g, '').slice(0, maximum) || '-';
}

export function terminalWidthIdentity(env = process.env) {
  const term = identityPart(env.TERM);
  const tmux = env.TMUX || /^(?:screen|tmux)/i.test(term) ? 'tmux' : 'direct';
  return `term=${term}|program=${identityPart(env.TERM_PROGRAM)}|version=${identityPart(env.TERM_PROGRAM_VERSION)}|mux=${tmux}`;
}

export function widthProbeMode(env = process.env) {
  const mode = String(env.DELEGATE_TUI_WIDTH_PROBE || '').toLowerCase();
  if (mode === 'off') return 'off';
  if (mode === 'verbose') return 'verbose';
  return 'auto';
}

function stripCpr(value) {
  return value.replace(/\u001b\[\d+;\d+R/g, '');
}

export async function probeTerminalWidths(options = {}) {
  const env = options.env || process.env;
  const mode = options.mode || widthProbeMode(env);
  const cached = options.cached?.widths || options.cached || null;
  if (cached && Object.keys(cached).length) {
    setGraphemeWidthOverrides(cached);
    return { source: 'cache', widths: { ...cached }, elapsedMs: 0, mode, remainder: '' };
  }
  if (mode === 'off') return { source: 'off', widths: {}, elapsedMs: 0, mode, remainder: '' };
  const screen = options.screen;
  const input = options.input || screen?.input;
  if (!screen || !input || typeof input.on !== 'function') return { source: 'unsupported', widths: {}, elapsedMs: 0, mode, remainder: '' };
  const probes = options.probes || WIDTH_PROBE_GRAPHEMES;
  // The normal budget is deliberately below one 60 Hz frame triplet. The
  // hard cap remains below the documented 100 ms no-response fallback.
  const timeoutMs = Math.max(1, Math.min(99, Number(options.timeoutMs ?? 45)));
  const row = Math.max(0, Math.min(screen.rows - 1, Number(options.row ?? screen.rows - 1)));
  let raw = '';
  let responses = [];
  const started = performance.now();
  const packet = probes.map((grapheme) => `${cursorTo(row, 0)}${sequences.clearLine}${grapheme}\u001b[6n`).join('');
  const pending = new Promise((resolve) => {
    let finished = false;
    let timer;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.off('data', check);
      resolve();
    };
    const check = (chunk) => {
      raw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      responses = [...raw.matchAll(/\u001b\[(\d+);(\d+)R/g)];
      if (responses.length >= probes.length) done();
    };
    input.on('data', check);
    timer = setTimeout(done, timeoutMs);
  });
  screen.writeOutput(packet, { context: 'probe' });
  await pending;
  const elapsedMs = performance.now() - started;
  screen.writeOutput(`${cursorTo(row, 0)}${sequences.clearLine}${sequences.home}`, { context: 'probe' });
  const widths = {};
  for (let index = 0; index < Math.min(probes.length, responses.length); index += 1) {
    const measured = Number(responses[index][2]) - 1;
    if (Number.isInteger(measured) && measured >= 0 && measured <= 2) widths[probes[index]] = measured;
  }
  if (Object.keys(widths).length) setGraphemeWidthOverrides(widths);
  return { source: Object.keys(widths).length ? 'probe' : 'fallback', widths, elapsedMs, mode, remainder: stripCpr(raw) };
}

export function formatWidthProbeResult(result) {
  const entries = Object.entries(result?.widths || {}).map(([grapheme, width]) => `${JSON.stringify(grapheme)}=${width}`).join(', ');
  return `width probe ${result?.source || 'unknown'} in ${Number(result?.elapsedMs || 0).toFixed(1)}ms${entries ? `: ${entries}` : ''}`;
}
