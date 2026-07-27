import { CHROME_GLYPHS } from './glyphs.mjs';
import { displayWidth } from './width.mjs';

export const KEY_CLASSES = Object.freeze(['navigation', 'steering', 'destructive', 'view', 'diagnostic']);
export const KEY_RELATIONS = Object.freeze(['single', 'alternatives', 'pair', 'range', 'chord', 'sequence']);

const SCREENS = Object.freeze([
  'dashboard', 'fleet', 'groups', 'group-members', 'sessions', 'providers', 'stats', 'launcher', 'detail'
]);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function scopeMatches(entry, ctx = {}) {
  return entry.scope.includes('global') || entry.scope.includes(ctx.screen);
}

function readOnlyReason(ctx = {}) {
  if (ctx.remoteOnly || ctx.job?.remote) return 'read-only remote';
  if (ctx.job?.transport === 'external') return 'read-only external thread';
  if (ctx.job?.transport === 'claude-agent') return 'read-only Claude Agent stub';
  if (ctx.job?.readOnly || ['direct-mcp', 'direct-cli', 'direct-acp'].includes(ctx.job?.transport)) return 'read-only observed job';
  return null;
}

function jobReason(ctx = {}) {
  return ctx.job ? readOnlyReason(ctx) : 'needs a selected job';
}

function activeReason(ctx = {}) {
  const unavailable = jobReason(ctx);
  if (unavailable) return unavailable;
  return TERMINAL.has(ctx.job.status) ? 'needs a running job' : null;
}

function terminalReason(ctx = {}) {
  const unavailable = jobReason(ctx);
  if (unavailable) return unavailable;
  return TERMINAL.has(ctx.job.status) ? null : 'needs a terminal job';
}

function pausedReason(ctx = {}) {
  const unavailable = activeReason(ctx);
  if (unavailable) return unavailable;
  return ctx.job.startPaused && ctx.job.phase === 'paused' ? null : 'needs a start-paused job';
}

function inputReason(ctx = {}) {
  const unavailable = activeReason(ctx);
  if (unavailable) return unavailable;
  return ctx.job.pendingInput && ctx.job.pendingInput.timedOut !== true
    ? null
    : 'needs a pending worker question';
}

function nudgeReason(ctx = {}) {
  const unavailable = terminalReason(ctx);
  if (unavailable) return unavailable;
  if (!['consult', 'plan', 'review'].includes(ctx.job.mode)) return 'needs a read-mode job';
  return ctx.job.resultSuspect ? null : 'needs a suspect result';
}

function entry(source) {
  const value = {
    keys: Object.freeze([...(source.keys || [])]),
    relation: source.relation || 'single',
    label: source.label,
    action: source.action,
    scope: Object.freeze([...(source.scope || ['global'])]),
    class: source.class || 'navigation',
    when: source.when || (() => true),
    unavailableReason: source.unavailableReason || (() => null),
    footer: source.footer === true,
    menu: source.menu !== false,
    ...source
  };
  value.keys = Object.freeze([...(source.keys || [])]);
  value.scope = Object.freeze([...(source.scope || ['global'])]);
  return Object.freeze(value);
}

const EVERY_SCREEN = SCREENS;

export const KEYMAP = Object.freeze([
  entry({ keys: ['?'], label: 'keys', action: 'overlay.help', scope: ['global'], class: 'navigation', footer: true, menu: false }),
  entry({ keys: ['Esc'], label: 'back', action: 'navigation.back', scope: ['global'], class: 'navigation', footer: true, menu: false }),
  entry({ keys: ['q'], label: 'quit', action: 'app.quit', scope: ['global'], class: 'diagnostic', menu: false }),
  entry({ keys: ['Ctrl', 'C'], relation: 'chord', label: 'quit', action: 'app.quit', scope: ['global'], class: 'diagnostic', menu: false }),
  entry({ keys: ['Up', 'Down'], relation: 'pair', label: 'previous / next item', action: 'navigation.item', scope: EVERY_SCREEN, class: 'navigation', footer: true, footerLabel: 'select', footerOrder: 10, menu: false }),
  entry({ keys: ['j', 'k'], relation: 'pair', label: 'next / previous item', action: 'navigation.item.vim', scope: EVERY_SCREEN, class: 'navigation', menu: false }),
  entry({ keys: ['Mouse wheel'], label: 'scroll viewport', action: 'navigation.mouse.scroll', scope: EVERY_SCREEN, class: 'navigation', helpSection: 'pointer', menu: false }),
  entry({ keys: ['Mouse click'], label: 'select / open', action: 'navigation.mouse.click', scope: EVERY_SCREEN, class: 'navigation', helpSection: 'pointer', menu: false }),
  entry({ keys: ['PgUp', 'PgDn'], relation: 'pair', label: 'previous / next viewport', action: 'navigation.page', scope: EVERY_SCREEN, class: 'navigation', menu: false }),
  entry({ keys: ['Ctrl', 'U'], relation: 'chord', label: 'previous viewport', action: 'navigation.page.previous', scope: EVERY_SCREEN, class: 'navigation', menu: false }),
  entry({ keys: ['Ctrl', 'D'], relation: 'chord', label: 'next viewport', action: 'navigation.page.next', scope: EVERY_SCREEN, class: 'navigation', menu: false }),
  entry({ keys: ['g', 'G'], relation: 'pair', label: 'top / bottom', action: 'navigation.edge', scope: EVERY_SCREEN, class: 'navigation', footer: true, footerLabel: 'top / bottom', footerOrder: 30, menu: false }),
  entry({ keys: ['Home', 'End'], relation: 'pair', label: 'top / bottom alias', action: 'navigation.edge.alias', scope: EVERY_SCREEN, class: 'diagnostic', menu: false }),
  entry({
    keys: ['Tab'], label: 'next pane', action: 'navigation.focus.next',
    scope: EVERY_SCREEN, class: 'navigation', footer: true, footerOrder: 40, menu: false,
    when: (ctx) => Number(ctx.paneCount || 0) > 1
  }),
  entry({
    keys: ['Shift', 'Tab'], relation: 'chord', label: 'previous pane', action: 'navigation.focus.previous',
    scope: EVERY_SCREEN, class: 'navigation', footer: false, menu: false,
    when: (ctx) => Number(ctx.paneCount || 0) > 1
  }),
  entry({ keys: ['Enter'], label: 'open / edit / expand', action: 'context.open', scope: EVERY_SCREEN, class: 'navigation', footer: true, footerLabel: 'open', footerOrder: 20, menu: false }),
  entry({ keys: ['/'], label: 'filter / search', action: 'search.open', scope: ['fleet', 'group-members', 'stats', 'detail'], class: 'navigation', footer: true, footerLabel: 'search', footerOrder: 15, menu: false }),
  entry({
    keys: ['n', 'N'], relation: 'alternatives', label: 'next / previous match', action: 'search.match',
    scope: ['global'], class: 'navigation', footer: true, menu: false,
    when: (ctx) => Boolean(ctx.searchQuery)
  }),
  entry({ keys: ['[', ']'], relation: 'pair', label: 'previous / next tab', action: 'detail.tab.cycle', scope: ['detail'], class: 'navigation', footer: true, footerLabel: 'tabs', footerOrder: 0, menu: false, when: (ctx) => Number(ctx.tabCount || 0) > 1 }),
  entry({ keys: ['1', '6'], relation: 'range', label: 'open tab by number', action: 'detail.tab.open', scope: ['detail'], class: 'navigation', menu: false }),

  entry({ keys: ['g', 'f'], relation: 'sequence', label: 'go to Fleet', action: 'screen.fleet', scope: ['global'], class: 'navigation', footer: true, footerOrder: 50, menu: false }),
  entry({ keys: ['F'], label: 'open Fleet alias', action: 'screen.fleet.alias', scope: ['global'], class: 'navigation', menu: false }),
  entry({ keys: ['g', 'r'], relation: 'sequence', label: 'go to groups', action: 'screen.groups', scope: ['global'], class: 'navigation', menu: false }),
  entry({ keys: ['g', 's'], relation: 'sequence', label: 'go to sessions', action: 'screen.sessions', scope: ['global'], class: 'navigation', menu: false }),
  entry({ keys: ['g', 'p'], relation: 'sequence', label: 'go to providers', action: 'screen.providers', scope: ['global'], class: 'navigation', menu: false }),
  entry({ keys: ['g', 't'], relation: 'sequence', label: 'go to stats', action: 'screen.stats', scope: ['global'], class: 'navigation', menu: false }),
  entry({
    keys: ['g', 'l'], relation: 'sequence', label: 'go to launcher', action: 'screen.launcher',
    scope: ['global'], class: 'navigation', menu: false,
    when: (ctx) => !ctx.remoteOnly,
    unavailableReason: (ctx) => ctx.remoteOnly ? 'read-only remote' : null
  }),

  entry({
    keys: ['s'], label: 'steer', action: 'detail.steer', scope: ['detail'], class: 'steering', footer: true,
    when: (ctx) => activeReason(ctx) == null, unavailableReason: activeReason
  }),
  entry({
    keys: ['a'], label: 'answer worker question', action: 'detail.answer', scope: ['detail'], class: 'steering', footer: true,
    when: (ctx) => inputReason(ctx) == null, unavailableReason: inputReason
  }),
  entry({
    keys: ['r'], label: 'resume', action: 'detail.resume', scope: ['detail'], class: 'steering', footer: true,
    when: (ctx) => terminalReason(ctx) == null, unavailableReason: terminalReason
  }),
  entry({
    keys: ['R'], label: 'release paused start', action: 'detail.release', scope: ['detail'], class: 'steering', footer: true,
    when: (ctx) => pausedReason(ctx) == null, unavailableReason: pausedReason
  }),
  entry({
    keys: ['w'], label: 'review round', action: 'detail.review', scope: ['detail'], class: 'steering', footer: true,
    when: (ctx) => terminalReason(ctx) == null, unavailableReason: terminalReason
  }),
  entry({
    keys: [], label: 'nudge suspicious result', action: 'detail.nudge', scope: ['detail'], class: 'steering',
    when: (ctx) => nudgeReason(ctx) == null, unavailableReason: nudgeReason, footer: false
  }),
  entry({
    keys: ['c'], label: 'cancel', action: 'detail.cancel', scope: ['detail'], class: 'destructive', footer: true,
    when: (ctx) => activeReason(ctx) == null, unavailableReason: activeReason
  }),
  entry({
    keys: ['v'], label: 'safe revert', action: 'detail.revert', scope: ['detail'], class: 'destructive', footer: true,
    when: (ctx) => terminalReason(ctx) == null, unavailableReason: terminalReason
  }),

  entry({ keys: ['x'], label: 'actions', action: 'overlay.actions', scope: ['global'], class: 'view', footer: true, menu: false }),
  entry({ keys: [], label: 'toggle external threads', action: 'fleet.externals', scope: ['fleet'], class: 'view', footer: false }),
  entry({ keys: ['a'], label: 'active jobs only', action: 'fleet.active', scope: ['fleet'], class: 'view', footer: true, footerLabel: 'active' }),
  entry({ keys: ['o'], label: 'cycle Fleet sort', action: 'fleet.sort', scope: ['fleet'], class: 'view', footer: true, footerLabel: 'sort' }),
  entry({ keys: ['z'], label: 'toggle Fleet density', action: 'fleet.density', scope: ['fleet'], class: 'view', footer: true, footerLabel: 'density' }),
  entry({ keys: ['f'], label: 'toggle follow', action: 'detail.follow', scope: ['detail'], class: 'view', footer: true, footerLabel: 'follow', when: (ctx) => [0, 4].includes(Number(ctx.detailTab)) }),
  entry({ keys: ['E'], label: 'jump to raw Events', action: 'detail.events', scope: ['detail'], class: 'view', footer: false, when: (ctx) => Number(ctx.detailTab) === 0 }),
  entry({ keys: ['d'], label: 'open focused Diff', action: 'detail.diff', scope: ['detail'], class: 'view', footer: false, when: (ctx) => Number(ctx.detailTab) === 0 }),
  entry({ keys: ['Left', 'Right'], relation: 'pair', label: 'previous / next choice or diff page', action: 'context.horizontal', scope: ['launcher', 'detail'], class: 'view', footer: false }),
  entry({ keys: ['e'], label: 'edit packet body', action: 'launcher.editor', scope: ['launcher'], class: 'view', footer: false }),
  entry({ keys: ['d'], label: 'dry run, then confirm launch', action: 'launcher.dry-run', scope: ['launcher'], class: 'view', footer: true, footerLabel: 'preview' }),
  entry({ keys: ['y'], label: 'yank focused value', action: 'view.yank', scope: ['global'], class: 'view', footer: false }),
  entry({ keys: ['t', 'T'], relation: 'alternatives', label: 'toggle timestamp mode', action: 'view.timestamps', scope: ['global'], class: 'view', footer: false }),
  entry({ keys: ['b'], label: 'toggle notifications', action: 'view.notifications', scope: ['global'], class: 'view', footer: false }),

  entry({ keys: ['M'], label: 'status-message history', action: 'diagnostic.status-history', scope: ['global'], class: 'diagnostic', footer: false }),
  entry({ keys: ['Ctrl', 'G'], relation: 'chord', label: 'mark diagnostic frame', action: 'diagnostic.mark', scope: ['global'], class: 'diagnostic', footer: false })
]);

function keyParts(entry, options = {}) {
  const ellipsis = options.ellipsis || CHROME_GLYPHS.truncation;
  if (!entry.keys.length) return [{ text: 'x menu', kind: 'key' }];
  if (entry.relation === 'range') return [
    { text: entry.keys[0], kind: 'key' },
    { text: ` ${ellipsis} `, kind: 'separator' },
    { text: entry.keys.at(-1), kind: 'key' }
  ];
  const separator = entry.relation === 'chord' ? '-' : ' ';
  return entry.keys.flatMap((key, index) => [
    ...(index ? [{ text: separator, kind: 'separator' }] : []),
    { text: key, kind: 'key' }
  ]);
}

export function keyNotationSegments(entry, options = {}) {
  return keyParts(entry, options);
}

export function formatKeyNotation(entry, options = {}) {
  return keyParts(entry, options).map((part) => part.text).join('');
}

function footerHint(entry, options = {}) {
  const keys = entry.relation === 'sequence' ? [{ text: 'g', kind: 'key' }, { text: ` ${options.ellipsis || CHROME_GLYPHS.truncation}`, kind: 'separator' }]
    : keyParts(entry, options);
  return Object.freeze({
    action: entry.action,
    class: entry.class,
    keys: Object.freeze(keys),
    label: entry.relation === 'sequence' ? 'go to' : entry.footerLabel || entry.label,
    marker: entry.class === 'destructive'
  });
}

function hintWidth(hint) {
  return hint.keys.reduce((total, part) => total + displayWidth(part.text), 0) + 2 + displayWidth(hint.label);
}

function groupWidth(group) {
  return group.reduce((total, hint, index) => total + hintWidth(hint) + (index ? 2 : 0), 0)
    + (group[0]?.class === 'destructive' ? displayWidth(CHROME_GLYPHS.destructiveMarker) + 1 : 0);
}

function footerWidth(groups, right) {
  const left = groups.reduce((total, group, index) => total + groupWidth(group) + (index ? displayWidth(CHROME_GLYPHS.separator) : 0), 0);
  return 2 + left + (left ? 2 : 0) + groupWidth(right) + 1;
}

function uniqueFooterEntries(ctx) {
  const actions = new Set();
  const entries = [];
  for (const candidate of KEYMAP) {
    if (!candidate.footer || candidate.class === 'diagnostic' || !scopeMatches(candidate, ctx)) continue;
    if (!candidate.when(ctx) || candidate.unavailableReason(ctx)) continue;
    if (actions.has(candidate.action)) continue;
    actions.add(candidate.action);
    entries.push(candidate);
  }
  return entries.sort((left, right) => Number(left.footerOrder ?? 100) - Number(right.footerOrder ?? 100));
}

export function footerForContext(ctx = {}, width = 80) {
  const valid = uniqueFooterEntries(ctx);
  const pinnedActions = new Set(['overlay.help', 'navigation.back']);
  const pinned = ['overlay.help', 'navigation.back']
    .map((action) => valid.find((entry) => entry.action === action) || KEYMAP.find((entry) => entry.action === action))
    .filter(Boolean)
    .map((entry) => footerHint(entry));
  const availableSlots = Math.max(0, 10 - pinned.length);
  const byClass = new Map(KEY_CLASSES.map((kind) => [kind, []]));
  for (const candidate of valid) {
    if (pinnedActions.has(candidate.action)) continue;
    byClass.get(candidate.class)?.push(candidate);
  }

  const destructive = byClass.get('destructive').slice(0, availableSlots);
  const steering = byClass.get('steering').slice(0, Math.max(0, availableSlots - destructive.length));
  let remaining = Math.max(0, availableSlots - destructive.length - steering.length);
  const view = remaining >= 3 ? byClass.get('view').slice(0, remaining) : [];
  remaining -= view.length;
  const navigation = byClass.get('navigation').slice(0, Math.min(3, remaining));
  let groups = [
    navigation.map((item) => footerHint(item)),
    steering.map((item) => footerHint(item)),
    view.map((item) => footerHint(item)),
    destructive.map((item) => footerHint(item))
  ].filter((group) => group.length);

  const dropClass = (kind) => {
    const index = groups.findIndex((group) => group[0]?.class === kind);
    if (index >= 0) groups.splice(index, 1);
  };
  for (const kind of ['navigation', 'view', 'steering', 'destructive']) {
    if (footerWidth(groups, pinned) <= Math.max(1, Number(width) || 1)) break;
    dropClass(kind);
  }
  return Object.freeze({ groups: Object.freeze(groups.map((group) => Object.freeze(group))), right: Object.freeze(pinned) });
}

function helpRow(entry, contextual) {
  return Object.freeze({
    action: entry.action,
    class: entry.class,
    scope: entry.scope,
    keys: Object.freeze(keyParts(entry, { ellipsis: '\u2026' })),
    notation: formatKeyNotation(entry, { ellipsis: '\u2026' }),
    relation: entry.relation,
    label: entry.label,
    contextual
  });
}

function groupedHelpPages(entries, contextual) {
  const pages = [];
  const sections = ['navigation', 'pointer', ...KEY_CLASSES.filter((kind) => kind !== 'navigation')];
  for (const kind of sections) {
    const rows = entries
      .filter((entry) => (entry.helpSection || entry.class) === kind)
      .map((entry) => helpRow(entry, contextual));
    if (!rows.length) continue;
    for (let offset = 0; offset < rows.length; offset += 14) {
      const chunk = rows.slice(offset, offset + 14);
      pages.push(Object.freeze({
        label: kind,
        scope: contextual ? 'CURRENT SCREEN' : 'ALL SCREENS',
        destructive: kind === 'destructive',
        rows: Object.freeze(chunk)
      }));
    }
  }
  return pages;
}

export function helpPagesForContext(ctx = {}) {
  const contextual = KEYMAP.filter((candidate) => scopeMatches(candidate, ctx));
  const contextualSet = new Set(contextual);
  const remaining = KEYMAP.filter((candidate) => !contextualSet.has(candidate));
  return Object.freeze([
    ...groupedHelpPages(contextual, true),
    ...groupedHelpPages(remaining, false).map((page, index) => Object.freeze({ ...page, divider: index === 0 }))
  ]);
}

export function actionMenuForContext(ctx = {}, query = '') {
  const needle = String(query || '').trim().toLowerCase();
  return Object.freeze(KEYMAP
    .filter((candidate) => candidate.menu && scopeMatches(candidate, ctx))
    .filter((candidate) => !['navigation', 'diagnostic'].includes(candidate.class) || candidate.action === 'diagnostic.status-history')
    .map((candidate) => {
      const unavailable = candidate.unavailableReason(ctx) || (!candidate.when(ctx) ? 'not available on this view' : null);
      return Object.freeze({
        action: candidate.action,
        class: candidate.class,
        keys: Object.freeze(keyParts(candidate, { ellipsis: '\u2026' })),
        notation: formatKeyNotation(candidate, { ellipsis: '\u2026' }),
        label: candidate.label,
        unavailable
      });
    })
    .filter((item) => !needle || `${item.notation} ${item.label} ${item.unavailable || ''}`.toLowerCase().includes(needle)));
}

function inputNames(entry) {
  if (entry.relation === 'chord') return [entry.keys.join('-').toLowerCase()];
  if (entry.relation === 'sequence' || entry.relation === 'range' || !entry.keys.length) return [];
  return entry.keys.map((key) => ({
    Esc: 'escape', Enter: 'enter', Up: 'up', Down: 'down', Left: 'left', Right: 'right',
    PgUp: 'page-up', PgDn: 'page-down', Home: 'home', End: 'end', 'Shift-Tab': 'shift-tab'
  })[key] || key);
}

export function resolveKeymapAction(key, ctx = {}) {
  const matches = KEYMAP.filter((candidate) => scopeMatches(candidate, ctx) && inputNames(candidate).includes(key));
  return matches.find((candidate) => candidate.when(ctx)) || matches[0] || null;
}

function escapeTable(value) {
  return String(value || '').replaceAll('|', '\\|');
}

export function renderKeysMarkdown() {
  const rows = KEYMAP.map((item) => `| \`${escapeTable(formatKeyNotation(item, { ellipsis: '\u2026' }))}\` | ${escapeTable(item.label)} | ${escapeTable(item.scope.join(', '))} |`);
  return [
    '| Key | Action | Scope |',
    '| --- | --- | --- |',
    ...rows
  ].join('\n');
}

export function keymapContext(frame = {}, ui = {}, store = {}) {
  const jobId = frame.meta?.jobId || ui.jobId;
  const job = (store.jobs || []).find((candidate) => candidate.id === jobId) || null;
  return Object.freeze({
    screen: frame.screen || ui.screen || 'dashboard',
    detailTab: Number(frame.meta?.tab ?? ui.detailTab ?? 0),
    tabCount: Number(frame.meta?.tabs?.length || 0),
    paneCount: (frame.panes || []).filter((pane) => pane.focusable !== false).length,
    searchQuery: ui.search?.query || '',
    remoteOnly: Boolean(ui.remote?.enabled && !ui.remote?.includeLocal),
    job
  });
}
