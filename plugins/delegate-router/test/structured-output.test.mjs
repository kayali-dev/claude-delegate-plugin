import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeOutputSchema, parseLastStructuredResult, structuredResultMatchesSchema, validateReportSchema } from '../bin/lib/structured-output.mjs';
import { STRUCTURAL_PLAN_SCHEMA } from '../bin/lib/planning.mjs';

const report = {
  type: 'object', additionalProperties: false, required: ['objectiveMet', 'count'],
  properties: { objectiveMet: { type: 'boolean' }, count: { type: 'integer', minimum: 1, maximum: 3 } }
};

test('native and fenced reports are equally validated, never replaced with stale earlier reports', () => {
  validateReportSchema(report);
  const answer = { objectiveMet: true, count: 2 };
  assert.deepEqual(parseLastStructuredResult(JSON.stringify(answer), report), answer);
  assert.deepEqual(parseLastStructuredResult('```json\n' + JSON.stringify(answer) + '\n```', report), answer);
  for (const value of [{ ...answer, count: 0 }, { ...answer, count: 4 }, { ...answer, extra: true }, { objectiveMet: true }]) {
    assert.equal(parseLastStructuredResult(JSON.stringify(value), report), null);
  }
  assert.equal(parseLastStructuredResult('```json\n' + JSON.stringify(answer) + '\n```\n```json\ninvalid\n```', report), null);
  assert.equal(parseLastStructuredResult('x'.repeat(131073), report), null);
});

test('bounded schema subset refuses ignored constraints and supports logical, numeric, and length checks', () => {
  for (const schema of [{ pattern: '(a+)+$' }, { $ref: 'remote' }, { type: 'unknown' }, { required: [12] }, { maxItems: -1 }, { items: true }, { description: 'x'.repeat(32769) }]) {
    assert.throws(() => validateReportSchema(schema), { code: 'INVALID_REQUEST' });
  }
  const cyclic = {}; cyclic.items = cyclic;
  assert.throws(() => validateReportSchema(cyclic), { code: 'INVALID_REQUEST' });
  const bounded = { anyOf: [{ type: 'string', minLength: 2, maxLength: 4 }, { type: 'number', exclusiveMinimum: 1, exclusiveMaximum: 3 }] };
  validateReportSchema(bounded);
  assert.equal(structuredResultMatchesSchema('ok', bounded), true);
  assert.equal(structuredResultMatchesSchema('x', bounded), false);
  assert.equal(structuredResultMatchesSchema(2, bounded), true);
  assert.equal(structuredResultMatchesSchema(3, bounded), false);
  assert.equal(structuredResultMatchesSchema(true, bounded), false);
  assert.equal(structuredResultMatchesSchema({ b: 2, a: 1 }, { const: { a: 1, b: 2 } }), true);
  assert.throws(() => validateReportSchema({ type: [] }), { code: 'INVALID_REQUEST' });
  for (const key of ['type', 'properties', 'required', 'enum', 'additionalProperties', 'items', 'anyOf', 'not', 'minimum', 'minLength', 'description']) assert.throws(() => validateReportSchema({ [key]: null }), { code: 'INVALID_REQUEST' });
});

test('native schemas preserve semantics instead of making optional properties required', () => {
  assert.equal(nativeOutputSchema(report), report);
  assert.equal(nativeOutputSchema({ type: 'object', properties: { answer: { type: 'string' } } }), null);
  assert.equal(nativeOutputSchema({ ...report, anyOf: [{}] }), null);
  assert.equal(nativeOutputSchema({ ...report, properties: { ...report.properties, count: { type: ['object', 'null'], properties: { optional: { type: 'string' } } } } }), null);
  validateReportSchema(STRUCTURAL_PLAN_SCHEMA);
  assert.equal(nativeOutputSchema(STRUCTURAL_PLAN_SCHEMA), STRUCTURAL_PLAN_SCHEMA);
});
