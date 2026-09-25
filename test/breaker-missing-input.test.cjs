'use strict';
/**
 * Breaker loop-arm: missing tool_input must not count as "identical".
 *
 * The Pi bridge and the OpenCode plugin post PostToolUse WITHOUT tool_input,
 * so every call through them keys identically and any N consecutive same-tool
 * calls read as an N× "identical" loop (observed: boot sequences and standby
 * inbox polling tripping the loop arm on bridged agents). Absence of evidence
 * is not evidence of a loop — input-less events skip repeat accounting while
 * the velocity / error-storm / no-progress arms still apply unchanged.
 *
 * Run with `node test/breaker-missing-input.test.cjs` (mirrors
 * test/breaker.test.cjs).
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const SRC = path.join(__dirname, '..', 'src', 'main', 'breaker.ts');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-missing-input-'));
const js = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
fs.writeFileSync(path.join(out, 'breaker.js'), js, 'utf8');
const { CircuitBreaker } = require(path.join(out, 'breaker.js'));

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

function makeBreaker(over = {}) {
  return new CircuitBreaker(() => ({
    enabled: true, hardStop: false, repeatedToolLimit: 8, errorStormLimit: 5,
    tokenVelocityPerMin: 60000, ...over
  }));
}

function sample(agentId, ts, output, input = 1000) {
  return { agentId, sessionId: 's1', ts, input, output, cacheRead: 0, cacheCreation: 0, model: 'm', usd: 0 };
}

const T0 = 1_000_000_000_000;
const BEAT = 30_000;

function beat(b, id, s, progressing, now, lastWorkAt) {
  return b.tick([{ agentId: id, sample: s, progressing, lastWorkAt }], now)[0];
}

test('20 input-less Bash calls do not trip the loop arm', () => {
  const b = makeBreaker();
  for (let i = 0; i < 20; i++) b.recordToolUse('a', 'Bash', undefined);
  const d = beat(b, 'a', null, true, T0);
  assert.equal(d.state.level, 'healthy', `reason: ${d.state.reason}`);
});

test('null input is treated like missing input', () => {
  const b = makeBreaker();
  for (let i = 0; i < 20; i++) b.recordToolUse('a', 'Bash', i % 2 ? null : undefined);
  const d = beat(b, 'a', null, true, T0);
  assert.equal(d.state.level, 'healthy', `reason: ${d.state.reason}`);
});

test('missing input neither advances nor resets an in-progress count', () => {
  const b = makeBreaker();
  for (let i = 0; i < 7; i++) b.recordToolUse('a', 'Bash', { cmd: 'same' });
  b.recordToolUse('a', 'Bash', undefined); // ignored, not a reset
  b.recordToolUse('a', 'Bash', { cmd: 'same' }); // 8th identical → trips
  const d = beat(b, 'a', null, true, T0);
  assert.equal(d.state.level, 'steering');
  assert.match(d.state.reason, /looping/);
});

test('8 identical calls WITH input still trip', () => {
  const b = makeBreaker();
  for (let i = 0; i < 8; i++) b.recordToolUse('a', 'Bash', { cmd: 'same' });
  const d = beat(b, 'a', null, true, T0);
  assert.equal(d.state.level, 'steering');
  assert.match(d.state.reason, /looping/);
});

test('8 distinct calls WITH input stay healthy', () => {
  const b = makeBreaker();
  for (let i = 0; i < 8; i++) b.recordToolUse('a', 'Bash', { cmd: `different-${i}` });
  const d = beat(b, 'a', null, true, T0);
  assert.equal(d.state.level, 'healthy', `reason: ${d.state.reason}`);
});

process.exit(failures ? 1 : 0);
