'use strict';

/**
 * Shared manifest field validators (design review Decision 13).
 *
 * Office Packs and Agent Definitions both lean on these. The pack/agent tests
 * exercise them indirectly; this file pins the contract each helper promises
 * callers directly, so a change here cannot quietly loosen both formats at once.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  boolField,
  boundedArray,
  cappedString,
  checkUnknownKeys,
  enumField,
  intInRange,
  isPlainObject,
  shapedString
} = loadTs('src/shared/manifestFields.ts');

const errs = () => ({ errors: [] });

test('scalar validators trim and cap, and reject rather than coerce', () => {
  let out = errs();
  assert.equal(cappedString('  hi  ', 10, 'f', out), 'hi');
  assert.equal(cappedString('   ', 10, 'f', out), undefined, 'blank optional value is not written as ""');
  assert.equal(cappedString(undefined, 10, 'f', out), undefined);
  assert.deepEqual(out.errors, []);

  out = errs();
  assert.equal(cappedString(undefined, 10, 'f', out, true), undefined);
  assert.equal(cappedString(' ', 10, 'g', out, true), undefined);
  assert.equal(cappedString(5, 10, 'h', out), undefined);
  assert.equal(cappedString('x'.repeat(11), 10, 'i', out), undefined);
  assert.deepEqual(out.errors, [
    '"f" is required',
    '"g" must not be empty',
    '"h" must be a string',
    '"i" exceeds 10 chars'
  ]);

  out = errs();
  assert.equal(shapedString(' ab ', /^[a-z]+$/, 's', out), 'ab');
  assert.equal(shapedString('a&b', /^[a-z]+$/, 's2', out, 'letters'), undefined);
  assert.equal(shapedString(1, /^[a-z]+$/, 's3', out), undefined);
  assert.equal(enumField('ask', ['off', 'ask'], 'e', out), 'ask');
  assert.equal(enumField('ASK', ['off', 'ask'], 'e2', out), undefined, 'wire values are case-sensitive');
  assert.equal(intInRange(5, 1, 10, 'n', out), 5);
  assert.equal(intInRange('5', 1, 10, 'n2', out), undefined);
  assert.equal(intInRange(11, 1, 10, 'n3', out), undefined);
  assert.equal(boolField(false, 'b', out), false);
  assert.equal(boolField('true', 'b2', out), undefined);
  assert.equal(out.errors.length, 6);
  assert.match(out.errors[0], /s2.*disallowed characters \(letters\)/);
  // Absent values are not errors for optional helpers.
  const quiet = errs();
  for (const fn of [
    () => shapedString(null, /x/, 'a', quiet),
    () => enumField(undefined, ['x'], 'a', quiet),
    () => intInRange(null, 1, 2, 'a', quiet),
    () => boolField(undefined, 'a', quiet)
  ]) assert.equal(fn(), undefined);
  assert.deepEqual(quiet.errors, []);
});

test('boundedArray keeps good items and caps length; unknown keys error only when strict', () => {
  const pick = (v, i, o) => (typeof v === 'number' ? v : (o.errors.push(`bad ${i}`), undefined));
  let out = errs();
  assert.deepEqual(boundedArray([1, 'x', 3], 5, 'arr', out, pick), [1, 3], 'one bad item never discards the list');
  assert.deepEqual(out.errors, ['bad 1']);

  out = errs();
  assert.equal(boundedArray([], 5, 'arr', out, pick), undefined, 'an empty result is undefined, not []');
  assert.equal(boundedArray('nope', 5, 'arr', out, pick), undefined);
  assert.equal(boundedArray([1, 2, 3], 2, 'arr', out, pick), undefined);
  assert.deepEqual(out.errors, ['"arr" must be an array', '"arr" must have at most 2 items']);

  const strict = errs();
  checkUnknownKeys({ a: 1, extra: 2 }, ['a'], 'strict', strict, 'pack');
  assert.equal(strict.errors.length, 1);
  assert.match(strict.errors[0], /pack has unknown field "extra"/);

  const lenient = errs();
  checkUnknownKeys({ a: 1, extra: 2 }, ['a'], 'lenient', lenient);
  assert.deepEqual(lenient.errors, []);

  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject('x'), false);
});
