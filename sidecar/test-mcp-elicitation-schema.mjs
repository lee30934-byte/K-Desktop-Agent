import assert from 'node:assert/strict';
import { parseElicitationSchema as parse, validateElicitationContent as valid } from './src/mcp-elicitation-schema.mjs';
const schema = (field, required = true) => ({ type: 'object', properties: { answer: field }, required: required ? ['answer'] : [] });
let checks = 0;
function check(field, value, expected) { assert.equal(valid(schema(field), { answer: value }), expected); checks++; }
check({ type: 'boolean', default: true }, true, true);
check({ type: 'boolean' }, false, true);
check({ type: 'boolean' }, 'true', false);
assert.equal(valid(schema({ type: 'boolean', default: true }), {}), false);
assert.equal(parse(schema({ type: 'boolean', default: true }))[0].default, undefined);
check({ type: 'integer', minimum: 1, maximum: 3 }, 2, true);
for (const x of [0, 4, 1.5, '2', Infinity, NaN, null]) check({ type: 'integer', minimum: 1, maximum: 3 }, x, false);
check({ type: 'string', minLength: 2, maxLength: 3 }, 'ab', true);
check({ type: 'string', minLength: 2, maxLength: 3 }, 'a', false);
check({ type: 'string', maxLength: 1 }, '😀', true);
check({ type: 'string', enum: ['yes', 'no'], enumNames: ['Yes', 'No'] }, 'yes', true);
check({ type: 'string', oneOf: [{ const: 'once', title: 'One time' }] }, 'always', false);
check({ type: 'array', items: { type: 'string', enum: ['a', 'b'] }, minItems: 1 }, ['a'], true);
check({ type: 'array', items: { anyOf: [{ const: 'a', title: 'A' }] } }, ['a', 'a'], false);
for (const [format, good, bad] of [['date', '2024-02-29', '2023-02-29'], ['date-time', '2024-02-29T10:00:00Z', 'yesterday'], ['email', 'a@b.test', 'a@'], ['uri', 'https://example.test', '/relative']]) {
  check({ type: 'string', format }, good, true); check({ type: 'string', format }, bad, false);
}
for (const field of [{ type: 'object' }, { type: 'string', pattern: '.*' }, { type: 'string', format: 'password' },
  { type: 'array', items: { type: 'string' } }, { type: 'number', minimum: 5, maximum: 1 },
  { type: 'string', enum: ['a'], oneOf: [{ const: 'b', title: 'B' }] }]) assert.equal(parse(schema(field)), null);
assert.equal(parse({ type: 'object', properties: JSON.parse('{"__proto__":{"type":"string"}}') }), null);
assert.equal(valid(schema({ type: 'boolean' }), { answer: true, extra: true }), false);
assert.equal(valid(schema({ type: 'boolean' }), null), false);
assert.equal(valid(schema({ type: 'boolean' }, false), {}), true);
assert.deepEqual(parse({ type: 'object', properties: {} }), []);
assert.equal(valid({ type: 'object', properties: {} }, {}), true);
assert.equal(parse({ type: 'object', properties: {}, allOf: [] }), null);
console.log(`MCP form schema: ${checks} value cases and fail-closed constraints PASS`);
