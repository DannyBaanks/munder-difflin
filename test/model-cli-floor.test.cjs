'use strict';

/**
 * Opus 5.5 needs Claude Code 2.1.280 or later. On an older CLI the id is
 * rejected and the agent never starts, which for Michael means an office with
 * no manager. Every Claude spawn swaps such a model for its fallback instead.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { CLAUDE_MODEL_CLI_FLOOR, modelForCli, parseCliVersion } = loadTs('src/shared/modelCliFloor.ts');
const catalog = require('../src/shared/modelCatalog.json');

test('Opus 5.5 has a version floor', () => {
  assert.deepEqual(CLAUDE_MODEL_CLI_FLOOR['claude-opus-5-5'], { min: '2.1.280', fallback: 'claude-opus-5' });
});

test('a new enough Claude Code runs Opus 5.5 as asked', () => {
  assert.deepEqual(modelForCli('claude-opus-5-5', '2.1.280'), { model: 'claude-opus-5-5' });
  assert.deepEqual(modelForCli('claude-opus-5-5', '2.2.0'), { model: 'claude-opus-5-5' });
  assert.deepEqual(modelForCli('claude-opus-5-5', '3.0.0'), { model: 'claude-opus-5-5' });
});

test('an older Claude Code runs Opus 5 instead, and says why', () => {
  assert.deepEqual(modelForCli('claude-opus-5-5', '2.1.279'), {
    model: 'claude-opus-5',
    downgraded: { from: 'claude-opus-5-5', need: '2.1.280', have: '2.1.279' }
  });
  assert.equal(modelForCli('claude-opus-5-5[1m]', '2.0.14').model, 'claude-opus-5');
});

test('an unknown version never takes a model away', () => {
  assert.deepEqual(modelForCli('claude-opus-5-5', null), { model: 'claude-opus-5-5' });
  assert.deepEqual(modelForCli('claude-opus-5-5', 'garbage'), { model: 'claude-opus-5-5' });
});

test('models without a floor pass through untouched', () => {
  for (const id of ['claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-opus-4-8[1m]']) {
    assert.deepEqual(modelForCli(id, '1.0.0'), { model: id });
  }
});

test('every fallback is a model the pickers offer', () => {
  const ids = catalog.providers.claude.map((m) => m.id);
  for (const [model, { fallback }] of Object.entries(CLAUDE_MODEL_CLI_FLOOR)) {
    assert.ok(ids.includes(fallback), `${model} falls back to ${fallback}, which is not in the catalog`);
    assert.equal(CLAUDE_MODEL_CLI_FLOOR[fallback], undefined, `${fallback} must not itself need a newer CLI`);
  }
});

test('reads the version out of claude --version', () => {
  assert.equal(parseCliVersion('2.1.280 (Claude Code)\n'), '2.1.280');
  assert.equal(parseCliVersion('no version here'), null);
});

test('every Claude hive spawn applies the floor after choosing the model', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/main/index.ts'), 'utf8');
  const pushed = src.indexOf("if (m) args.push('--model', m);");
  const floor = src.indexOf('modelForCli(requested, await claudeCliVersion(');
  assert.ok(pushed > 0 && floor > pushed, 'the floor must run after the model is resolved');
  assert.ok(floor - pushed < 1500, 'and in the same spawn block');
});
