'use strict';
// node --test tools/munder/harness.test.cjs
//
// The harness boundary in CI, on every OS: the core (lib-harness) and both
// adapters against stand-ins (fixtures/fake-codex.cjs speaks `codex exec
// --experimental-json`, fixtures/fake-acp-agent.cjs speaks ACP v1). The real
// harnesses are exercised by harness-p0.test.cjs where they are installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ci-'));
process.env.MUNDER_HARNESS_DIR = path.join(root, 'harness');
process.env.MUNDER_LINK_HIVE = path.join(root, 'hive');
fs.mkdirSync(process.env.MUNDER_HARNESS_DIR, { recursive: true });
fs.mkdirSync(process.env.MUNDER_LINK_HIVE, { recursive: true });
fs.writeFileSync(path.join(process.env.MUNDER_HARNESS_DIR, 'adapters.json'), JSON.stringify({
  codex: { command: process.execPath, prefix: [path.join(__dirname, 'fixtures', 'fake-codex.cjs')], credential_env: ['FAKE_OPENAI_KEY'] },
  deepseek: { command: process.execPath, args: [path.join(__dirname, 'fixtures', 'fake-acp-agent.cjs')] },
}));
const H = require('./lib-harness.cjs');

let seq = 0;
function repo() {
  const d = path.join(root, `repo-${++seq}`);
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'README.md'), 'x\n');
  const git = (...a) => spawnSync('git', a, { cwd: d });
  git('init', '-q'); git('add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i');
  return d;
}
const SECRET = 'ci-SECRET-without-a-known-prefix-123';
const env = (extra = {}) => ({ ...process.env, FAKE_OPENAI_KEY: SECRET, ...extra });

test('codex adapter: settles completed; artifact measured by git; session id; the key reaches the harness but not the receipt', async () => {
  const cwd = repo();
  const r = await H.run({ adapter: 'codex', prompt: 'escribe OUT.txt', cwd, env: env() });
  assert.equal(r.status, 'completed', JSON.stringify(r.error));
  assert.equal(r.external_session_id, 'thread-fake-1');
  assert.deepEqual(r.artifacts.files.map((f) => f.path), ['OUT.txt']);
  assert.match(fs.readFileSync(path.join(cwd, 'OUT.txt'), 'utf8'), /key=present chain=set/);
  assert.equal(r.harness.version, 'fake-codex 0.0.0');
  assert.equal(r.final_text, 'hecho ([REDACTED])', 'a secret echoed by the harness is scrubbed from the receipt');
  const disk = fs.readFileSync(path.join(process.env.MUNDER_HARNESS_DIR, 'receipts.jsonl'), 'utf8') + fs.readFileSync(r.evidence.native_events, 'utf8');
  assert.ok(!disk.includes(SECRET));
});

test('codex adapter: exit without settling, malformed output and turn.failed are all failures', async () => {
  for (const [mode, code] of [['no_settle', 'no_settle'], ['malformed', 'malformed_result'], ['fail', 'turn_failed']]) {
    const r = await H.run({ adapter: 'codex', prompt: 'x', cwd: repo(), env: env({ FAKE_CODEX: mode }) });
    assert.equal(r.status, 'failed', mode);
    assert.equal(r.error.code, code, mode);
    assert.equal(r.ok, false);
  }
  const missing = JSON.parse(fs.readFileSync(path.join(process.env.MUNDER_HARNESS_DIR, 'adapters.json'), 'utf8'));
  missing.ghost = { kind: 'codex', command: path.join(root, 'no-such-codex') };
  fs.writeFileSync(path.join(process.env.MUNDER_HARNESS_DIR, 'adapters.json'), JSON.stringify(missing));
  const r = await H.run({ adapter: 'ghost', prompt: 'x', cwd: repo(), env: env() });
  assert.equal(r.error.code, 'harness_not_installed');
});

test('ACP adapter: Munder policy answers permission requests (reject by default, allow only when asked)', async () => {
  const denied = await H.run({ adapter: 'deepseek', prompt: 'escribe', cwd: repo(), env: env() });
  assert.equal(denied.status, 'completed');
  assert.deepEqual(denied.events.permissions.map((p) => p.decision), ['reject_once']);
  assert.deepEqual(denied.artifacts.files, [], 'rejected: nothing written');
  const cwd = repo();
  const allowed = await H.run({ adapter: 'deepseek', prompt: 'escribe', cwd, approvals: 'allow', env: env() });
  assert.deepEqual(allowed.events.permissions.map((p) => p.decision), ['allow_once']);
  assert.deepEqual(allowed.artifacts.files.map((f) => f.path), ['ACP_OUT.txt']);
  assert.equal(allowed.harness.protocol, 'acp/1');
  const again = await H.run({ adapter: 'deepseek', prompt: 'otra vez', cwd, approvals: 'allow', resume: allowed.external_session_id, env: env() });
  assert.equal(again.external_session_id, allowed.external_session_id, 'session/resume');
});

test('ACP adapter: cancel and timeout go through session/cancel; a crashing agent is a failure', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const c = await H.run({ adapter: 'deepseek', prompt: 'x', cwd: repo(), env: env({ FAKE_ACP: 'hang' }), signal: ac.signal });
  assert.equal(c.status, 'cancelled');
  assert.equal(c.error.code, 'cancelled');
  assert.equal(c.stop_reason, 'cancelled', 'the agent itself acknowledged the cancel');
  const t = await H.run({ adapter: 'deepseek', prompt: 'x', cwd: repo(), env: env({ FAKE_ACP: 'hang' }), timeoutMs: 400 });
  assert.equal(t.status, 'timed_out');
  const x = await H.run({ adapter: 'deepseek', prompt: 'x', cwd: repo(), env: env({ FAKE_ACP: 'crash' }) });
  assert.equal(x.status, 'failed');
});

test('recursion guard: nested only when asked, bounded, never the same harness twice', () => {
  const c1 = [{ adapter: 'deepseek', run_id: 'a' }];
  assert.equal(H.checkRecursion([], 'codex', false), null);
  assert.match(H.checkRecursion(c1, 'codex', false), /--anidado/);
  assert.equal(H.checkRecursion(c1, 'codex', true), null);
  assert.match(H.checkRecursion(c1, 'deepseek', true), /no se re-delega a sí mismo/);
  assert.match(H.checkRecursion([...c1, { adapter: 'codex', run_id: 'b' }], 'other', true), /profundidad máxima/);
});

test('recursion through the environment: a run started inside another is rejected and says by whom', async () => {
  const chain = JSON.stringify([{ adapter: 'deepseek', run_id: 'hr_outer' }]);
  const r = await H.run({ adapter: 'codex', prompt: 'x', cwd: repo(), env: env({ [H.CHAIN_ENV]: chain }) });
  assert.equal(r.status, 'rejected');
  assert.equal(r.error.code, 'recursion');
  assert.equal(r.requested_by, 'harness:deepseek');
  const nested = await H.run({ adapter: 'codex', prompt: 'x', cwd: repo(), nested: true, env: env({ [H.CHAIN_ENV]: chain }) });
  assert.equal(nested.status, 'completed', 'an explicit, bounded transition is allowed');
});

test('capabilities are declared, not faked; asking for a missing one is refused before running', async () => {
  assert.equal(require('./harness-codex.cjs').capabilities().approvals, false);
  assert.equal(require('./harness-acp.cjs').capabilities().approvals, true);
  const r = await H.run({ adapter: 'codex', prompt: 'x', cwd: repo(), requires: ['approvals'], env: env() });
  assert.equal(r.error.code, 'unsupported_capability');
  assert.equal((await H.run({ adapter: 'nope', prompt: 'x', cwd: repo() })).error.code, 'unknown_adapter');
  assert.equal((await H.run({ adapter: 'codex', prompt: 'x', cwd: path.join(root, 'missing') })).error.code, 'bad_cwd');
});

test('the task card and the hive log record the run under principal harness:<adapter>', async () => {
  fs.writeFileSync(path.join(process.env.MUNDER_LINK_HIVE, 'tasks.json'), JSON.stringify({ tasks: [{ id: 't1', title: 'x', status: 'doing' }] }));
  const r = await H.run({ adapter: 'codex', prompt: 'x', cwd: repo(), taskId: 't1', env: env() });
  const card = JSON.parse(fs.readFileSync(path.join(process.env.MUNDER_LINK_HIVE, 'tasks.json'), 'utf8')).tasks[0];
  assert.deepEqual(card.harness_runs.map((x) => [x.receipt_id, x.status]), [[r.receipt_id, 'completed']]);
  assert.match(fs.readFileSync(path.join(process.env.MUNDER_LINK_HIVE, 'log.jsonl'), 'utf8'), /"principal":"harness:codex","task_id":"t1"/);
});

test('munder harness is reachable from the munder CLI', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'munder'), 'harness', 'adaptadores'], { encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /codex +codex/);
  assert.match(r.stdout, /deepseek +acp/);
});
