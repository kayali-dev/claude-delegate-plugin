import { brokerError } from './errors.mjs';
import { isDeepStrictEqual } from 'node:util';

const TYPES = new Set(['null', 'array', 'object', 'integer', 'number', 'string', 'boolean']);
const KEYS = new Set(['type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'anyOf', 'oneOf', 'allOf', 'not', 'description', 'title', '$schema']);

// This is an intentionally bounded JSON-schema subset, not a permissive
// validator that silently ignores an unsupported constraint.
export function validateReportSchema(schema) {
  let nodes = 0;
  const fail = message => { throw brokerError('INVALID_REQUEST', `reportSchema: ${message}`); };
  const visit = (node, depth = 0) => {
    if (depth > 12 || ++nodes > 256) fail('schema exceeds nesting/node limits');
    if (!node || typeof node !== 'object' || Array.isArray(node)) fail('each schema must be an object');
    for (const key of Object.keys(node)) if (!KEYS.has(key)) fail(`unsupported keyword '${key}'`);
    const types = node.type == null ? [] : Array.isArray(node.type) ? node.type : [node.type];
    if (!types.every(type => TYPES.has(type)) || Object.hasOwn(node, 'type') && (!types.length || new Set(types).size !== types.length)) fail('invalid type');
    if (Object.hasOwn(node, 'properties')) {
      if (!node.properties || typeof node.properties !== 'object' || Array.isArray(node.properties)) fail('properties must be an object');
      for (const child of Object.values(node.properties)) visit(child, depth + 1);
    }
    if (Object.hasOwn(node, 'required') && (!Array.isArray(node.required) || !node.required.every(key => typeof key === 'string') || new Set(node.required).size !== node.required.length)) fail('required must contain unique property names');
    if (Object.hasOwn(node, 'enum') && (!Array.isArray(node.enum) || !node.enum.length)) fail('enum must be a nonempty array');
    if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') fail('additionalProperties must be boolean');
    if (Object.hasOwn(node, 'items')) visit(node.items, depth + 1);
    for (const key of ['anyOf', 'oneOf', 'allOf']) if (Object.hasOwn(node, key)) {
      if (!Array.isArray(node[key]) || !node[key].length) fail(`${key} must be a nonempty array`);
      for (const child of node[key]) visit(child, depth + 1);
    }
    if (Object.hasOwn(node, 'not')) visit(node.not, depth + 1);
    for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength']) if (Object.hasOwn(node, key) && (!Number.isSafeInteger(node[key]) || node[key] < 0)) fail(`${key} must be a nonnegative integer`);
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) if (Object.hasOwn(node, key) && !Number.isFinite(node[key])) fail(`${key} must be finite`);
    for (const key of ['title', 'description', '$schema']) if (Object.hasOwn(node, key) && typeof node[key] !== 'string') fail(`${key} must be a string`);
  };
  let serialized;
  try { serialized = JSON.stringify(schema); } catch { fail('schema must be JSON-serializable'); }
  if (!serialized || Buffer.byteLength(serialized) > 32768) fail('schema exceeds 32 KiB');
  visit(schema);
  return schema;
}

function typeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value != null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

export function structuredResultMatchesSchema(value, schema, depth = 0) {
  if (depth > 16) return false;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some(type => typeMatches(value, type))) return false;
  if (schema.enum && !schema.enum.some(item => isDeepStrictEqual(item, value))) return false;
  if (Object.hasOwn(schema, 'const') && !isDeepStrictEqual(schema.const, value)) return false;
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (schema[key]) {
    const matches = schema[key].filter(child => structuredResultMatchesSchema(value, child, depth + 1)).length;
    if (key === 'anyOf' && !matches || key === 'oneOf' && matches !== 1 || key === 'allOf' && matches !== schema[key].length) return false;
  }
  if (schema.not && structuredResultMatchesSchema(value, schema.not, depth + 1)) return false;
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum || schema.maximum != null && value > schema.maximum
      || schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum || schema.exclusiveMaximum != null && value >= schema.exclusiveMaximum) return false;
  }
  if (typeof value === 'string' && (schema.minLength != null && [...value].length < schema.minLength || schema.maxLength != null && [...value].length > schema.maxLength)) return false;
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems || schema.maxItems != null && value.length > schema.maxItems) return false;
    if (schema.items && !value.every(item => structuredResultMatchesSchema(item, schema.items, depth + 1))) return false;
  }
  if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    const properties = schema.properties || {};
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(properties, key))) return false;
    for (const [key, child] of Object.entries(properties)) if (Object.hasOwn(value, key) && !structuredResultMatchesSchema(value[key], child, depth + 1)) return false;
  }
  return true;
}

export function parseLastStructuredResult(text, schema) {
  const source = String(text || '').trim();
  if (Buffer.byteLength(source) > 131072) return null;
  const blocks = [...source.matchAll(/```json\s*([\s\S]*?)```/gi)];
  // A malformed last report is not replaced with an earlier, stale report.
  const candidate = blocks.length ? blocks.at(-1)[1].trim() : source;
  try {
    const value = JSON.parse(candidate);
    return value && typeof value === 'object' && !Array.isArray(value) && structuredResultMatchesSchema(value, schema) ? value : null;
  } catch { return null; }
}

export function nativeOutputSchema(schema) {
  if (!schema) return null;
  const visit = node => {
    if (node.anyOf || node.oneOf || node.allOf || node.not || node.$schema) return false;
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (!types.length || types.some(type => !TYPES.has(type))) return false;
    if (types.includes('object')) {
      const properties = node.properties || {};
      if (node.additionalProperties !== false || !Array.isArray(node.required)
        || node.required.length !== Object.keys(properties).length
        || Object.keys(properties).some(key => !node.required.includes(key))) return false;
      return Object.values(properties).every(visit);
    }
    if (types.includes('array') && !node.items) return false;
    return node.items ? visit(node.items) : true;
  };
  return schema.type === 'object' && visit(schema) ? schema : null;
}
