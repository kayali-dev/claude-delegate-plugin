export const SPACING_SCALE = Object.freeze([0, 1, 2, 3, 4, 6, 8]);

const allowed = new Set(SPACING_SCALE);
function spacing(value) {
  if (!allowed.has(value)) throw new RangeError(`TUI spacing must use the shared scale: ${SPACING_SCALE.join(' ')}`);
  return value;
}

export const SPACE = Object.freeze({
  none: spacing(0),
  railGap: spacing(1),
  paneColumn: spacing(2),
  paneRow: spacing(1),
  section: spacing(1),
  tableColumn: spacing(2),
  indent: spacing(2),
  scrollbarMargin: spacing(1),
  overlayColumn: spacing(2),
  overlayRow: spacing(1),
  screenBoundary: spacing(2)
});

export const HEIGHT_PRESSURE_MAX_ROWS = 30;

export function sectionGapForHeight(rows) {
  return Number(rows) <= HEIGHT_PRESSURE_MAX_ROWS ? SPACE.none : SPACE.section;
}
