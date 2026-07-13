import assert from 'node:assert/strict';
import test from 'node:test';
import { displayWidth, padToWidth, stripAnsi, truncateToWidth } from '../bin/lib/tui/width.mjs';

test('displayWidth ignores ANSI escapes and counts combining text once', () => {
  assert.equal(displayWidth('\u001b[31mred\u001b[0m'), 3);
  assert.equal(displayWidth('e\u0301'), 1);
  assert.equal(displayWidth('\u001b]0;title\u0007ok'), 2);
});

test('displayWidth treats East Asian glyphs, flags, and common emoji as double width', () => {
  assert.equal(displayWidth('界'), 2);
  assert.equal(displayWidth('🙂'), 2);
  assert.equal(displayWidth('👩‍💻'), 2);
  assert.equal(displayWidth('🇦🇪'), 2);
  assert.equal(displayWidth('A界🙂'), 5);
});

test('truncateToWidth preserves whole graphemes and ANSI state', () => {
  assert.equal(truncateToWidth('A界B', 3), 'A界');
  assert.equal(truncateToWidth('🙂x', 1), '');
  const colored = truncateToWidth('\u001b[31m界red\u001b[0m', 3);
  assert.equal(stripAnsi(colored), '界r');
  assert.equal(displayWidth(colored), 3);
  assert.match(colored, /\u001b\[0m$/);
});

test('padToWidth aligns ANSI and double-width content by display columns', () => {
  assert.equal(displayWidth(padToWidth('界', 5)), 5);
  assert.equal(padToWidth('x', 4, 'right'), '   x');
  assert.equal(padToWidth('x', 4, 'center'), ' x  ');
  assert.equal(displayWidth(padToWidth('\u001b[32mgo\u001b[0m', 5)), 5);
});

