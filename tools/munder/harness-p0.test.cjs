'use strict';
// node --test tools/munder/harness-p0.test.cjs
//
// P0: the REAL harnesses (OpenAI Codex CLI, DeepSeek Harness over ACP) driven
// by `munder harness`, against a scripted model (fixtures/scripted-model.cjs)
// so the experiment measures the harness boundary, not model intelligence.
// Needs the two CLIs: HARNESS_P0_BIN=<dir with codex and dsh>; otherwise the
// whole file is skipped (they are not installed in CI).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const BIN = process.env.HARNESS_P0_BIN;
const have = BIN && fs.existsSync(path.join(BIN, 'codex')) && fs.existsSync(path.join(BIN, 'dsh'));
const skip = have ? false : 'set HARNESS_P0_BIN to a directory with the codex and dsh CLIs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-p0-'));
const SECRET_OPENAI = 'sk-p0-openai-SECRET-1234567890';
const SECRET_DEEPSEEK = 'sk-p0-deepseek-SECRET-0987654321';
process.env.MUNDER_HARNESS_DIR = path.join(root, 'harness');
process.env.MUNDER_LINK_HIVE = path.join(root, 'hive');
const H = require('./lib-harness.cjs');
const fake = { dir: path.join(root, 'fake'), proc: null, port: null };
const setFake = (mode, cmd) => {
  fs.writeFileSync(path.join(fake.dir, 'mode'), mode);
  fs.writeFileSync(path.join(fake.dir, 'cmd'), cmd || '');
};

function fixtureRepo(name) {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'README.md'), '# Fixture\nuna\ndos\n');
  spawnSync('git', ['init', '-q'], { cwd: d });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'x', '--allow-empty'], { cwd: d });
  spawnSync('git', ['add', '.'], { cwd: d });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: d });
  return d;
}

const envFor = (openaiKey = SECRET_OPENAI, deepseekKey = SECRET_DEEPSEEK) => ({ ...process.env, FAKE_OPENAI_KEY: openaiKey, DEEPSEEK_API_KEY: deepseekKey });

test.before(async () => {
  if (!have) return;
  fs.mkdirSync(fake.dir, { recursive: true });
  setFake('ok');
  fake.proc = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'scripted-model.cjs')], { env: { ...process.env, FAKE_DIR: fake.dir }, stdio: ['ignore', 'pipe', 'inherit'] });
  fake.port = await new Promise((r) => fake.proc.stdout.on('data', (d) => { const m = String(d).match(/fake model on (\d+)/); if (m) r(Number(m[1])); }));
  const codexHome = path.join(root, 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), `model = "fake-model"\nmodel_provider = "fake"\n[model_providers.fake]\nname = "fake"\nbase_url = "http://127.0.0.1:${fake.port}/v1"\nenv_key = "FAKE_OPENAI_KEY"\nwire_api = "responses"\n`);
  fs.mkdirSync(process.env.MUNDER_HARNESS_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.MUNDER_HARNESS_DIR, 'adapters.json'), JSON.stringify({
    codex: { command: path.join(BIN, 'codex'), env: { CODEX_HOME: codexHome }, credential_env: ['FAKE_OPENAI_KEY'] },
    deepseek: { command: path.join(BIN, 'dsh'), env: { DSH_HOME: path.join(root, 'dsh-home'), DEEPSEEK_BASE_URL: `http://127.0.0.1:${fake.port}` } },
  }));
  fs.mkdirSync(process.env.MUNDER_LINK_HIVE, { recursive: true });
  fs.writeFileSync(path.join(process.env.MUNDER_LINK_HIVE, 'tasks.json'), JSON.stringify({ tasks: [{ id: 't-p0', title: 'P0 harness', status: 'doing', createdAt: '2026-09-25T00:00:00Z' }] }));
});
test.after(() => { if (fake.proc) fake.proc.kill(); });

const P0_TASK = 'Crea MUNDER_P0.txt con "harness-boundary-ok" y cuenta las líneas del README';

for (const adapter of ['codex', 'deepseek']) {
  test(`${adapter}: Munder task → real harness session → artifact measured on disk → normalized receipt + raw evidence`, { skip, timeout: 180_000 }, async () => {
    setFake('ok');
    const cwd = fixtureRepo(`repo-${adapter}`);
    const r = await H.run({ adapter, prompt: P0_TASK, cwd, taskId: 't-p0', env: envFor(), timeoutMs: 120_000 });
    assert.equal(r.status, 'completed', JSON.stringify(r.error));
    assert.ok(r.external_session_id, 'the harness session id is recorded');
    assert.equal(r.events.tools >= 1, true, 'a native tool ran');
    assert.deepEqual(r.artifacts.files.map((f) => [f.path, f.git_status]), [['MUNDER_P0.txt', '??']]);
    assert.equal(fs.readFileSync(path.join(cwd, 'MUNDER_P0.txt'), 'utf8').trim(), 'harness-boundary-ok');
    assert.match(r.final_text, /MUNDER_P0\.txt/);
    assert.ok(r.usage, 'usage recorded');
    assert.ok(fs.statSync(r.evidence.native_events).size > 0, 'raw native events kept next to the receipt');
    const card = JSON.parse(fs.readFileSync(path.join(process.env.MUNDER_LINK_HIVE, 'tasks.json'), 'utf8')).tasks[0];
    assert.ok(card.harness_runs.some((x) => x.receipt_id === r.receipt_id && x.external_session_id === r.external_session_id));
    assert.match(fs.readFileSync(path.join(process.env.MUNDER_LINK_HIVE, 'log.jsonl'), 'utf8'), new RegExp(`"principal":"harness:${adapter}","task_id":"t-p0","run_id":"${r.run_id}"`));
  });

  test(`${adapter}: harness-native continuation — resuming the external session sees the previous turn`, { skip, timeout: 180_000 }, async () => {
    setFake('ok');
    const cwd = fixtureRepo(`repo-${adapter}-resume`);
    const first = await H.run({ adapter, prompt: P0_TASK, cwd, env: envFor() });
    assert.equal(first.status, 'completed', JSON.stringify(first.error));
    const log = path.join(fake.dir, 'requests.jsonl');
    const before = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
    const second = await H.run({ adapter, prompt: '¿Qué hiciste en el turno anterior?', cwd, resume: first.external_session_id, env: envFor() });
    assert.equal(second.status, 'completed', JSON.stringify(second.error));
    assert.equal(second.external_session_id, first.external_session_id, 'same external session');
    const reqs = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).slice(before).map((l) => JSON.parse(l));
    const firstReqs = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).slice(0, before).map((l) => JSON.parse(l));
    assert.ok(Math.max(...reqs.map((x) => x.n_input)) > Math.min(...firstReqs.filter((x) => x.n_input).map((x) => x.n_input)), 'the resumed turn carries the earlier conversation');
  });
}

// ─── failures: a normal adapter exit is never a success ─────────────────────
for (const adapter of ['codex', 'deepseek']) {
  test(`${adapter}: revoked credential, provider 500 and malformed stream all settle as failed`, { skip, timeout: 300_000 }, async () => {
    const cwd = fixtureRepo(`repo-${adapter}-fail`);
    setFake('ok');
    const revoked = await H.run({ adapter, prompt: P0_TASK, cwd, env: envFor('sk-revoked-openai-000000', 'sk-revoked-deepseek-00000'), timeoutMs: 90_000 });
    assert.notEqual(revoked.status, 'completed');
    setFake('error500');
    const down = await H.run({ adapter, prompt: P0_TASK, cwd, env: envFor(), timeoutMs: 90_000 });
    assert.notEqual(down.status, 'completed');
    setFake('malformed');
    const bad = await H.run({ adapter, prompt: P0_TASK, cwd, env: envFor(), timeoutMs: 90_000 });
    assert.notEqual(bad.status, 'completed');
    setFake('ok');
    for (const r of [revoked, down, bad]) {
      assert.equal(r.ok, false);
      assert.ok(r.error && r.error.code && r.error.code !== 'malformed_result' || r === bad, JSON.stringify(r.error));
      assert.ok(r.error.message.length > 0);
      assert.deepEqual(r.artifacts.files, [], 'nothing written');
    }
  });

  test(`${adapter}: timeout and cancellation stop the harness and say so`, { skip, timeout: 180_000 }, async () => {
    const cwd = fixtureRepo(`repo-${adapter}-slow`);
    setFake('slow');
    const t0 = Date.now();
    const timed = await H.run({ adapter, prompt: P0_TASK, cwd, env: envFor(), timeoutMs: 6_000 });
    assert.equal(timed.status, 'timed_out');
    assert.equal(timed.error.code, 'timeout');
    assert.ok(Date.now() - t0 < 30_000);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 4_000);
    const cancelled = await H.run({ adapter, prompt: P0_TASK, cwd, env: envFor(), timeoutMs: 60_000, signal: ac.signal });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.error.code, 'cancelled');
    setFake('ok');
  });
}

test('unsupported capability is refused before anything runs (codex exec has no protocol approvals)', { skip }, async () => {
  const cwd = fixtureRepo('repo-caps');
  const r = await H.run({ adapter: 'codex', prompt: P0_TASK, cwd, requires: ['approvals'], env: envFor() });
  assert.equal(r.status, 'rejected');
  assert.equal(r.error.code, 'unsupported_capability');
  const ok = await H.run({ adapter: 'deepseek', prompt: 'x', cwd: path.join(root, 'no-such-dir'), requires: ['approvals'], env: envFor() });
  assert.equal(ok.error.code, 'bad_cwd', 'deepseek HAS approvals (ACP request_permission); it fails later, on the cwd');
});

test('recursion: a harness that calls `munder harness run` from inside its own tool is refused; the outer run still completes', { skip, timeout: 240_000 }, async () => {
  const cwd = fixtureRepo('repo-recursion');
  const inner = `${process.execPath} ${path.join(__dirname, 'harness.cjs')} run codex "otra vez" --cwd . --json > INNER.json; echo "inner exit $?"`;
  setFake('ok', inner);
  const outer = await H.run({ adapter: 'deepseek', prompt: 'delega esto de vuelta a Munder', cwd, env: { ...envFor(), MUNDER_HARNESS_DIR: process.env.MUNDER_HARNESS_DIR } });
  setFake('ok');
  assert.equal(outer.status, 'completed', JSON.stringify(outer.error));
  const innerReceipt = JSON.parse(fs.readFileSync(path.join(cwd, 'INNER.json'), 'utf8'));
  assert.equal(innerReceipt.status, 'rejected');
  assert.equal(innerReceipt.error.code, 'recursion');
  assert.deepEqual(innerReceipt.chain.map((c) => c.run_id), [outer.run_id], 'the chain names the outer run');
  assert.equal(innerReceipt.requested_by, 'harness:deepseek');
});

test('credentials: the key values never reach receipts, events, the hive or argv', { skip }, () => {
  const blobs = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) blobs.push(fs.readFileSync(p, 'utf8')); } };
  walk(process.env.MUNDER_HARNESS_DIR);
  walk(process.env.MUNDER_LINK_HIVE);
  const all = blobs.join('\n');
  assert.ok(all.includes('receipt_id'), 'receipts were written');
  for (const s of [SECRET_OPENAI, SECRET_DEEPSEEK]) assert.ok(!all.includes(s), 'a secret reached disk');
});
