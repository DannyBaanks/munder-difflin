'use strict';
// node --test tools/munder/harness-p0-ci.test.cjs
//
// M3: the credential-hygiene property of the harness boundary, executable in
// CI. harness-p0.test.cjs needs the REAL codex/dsh CLIs and skips entirely
// without HARNESS_P0_BIN, so its 'keys never reach receipts/events/hive/argv'
// assertion never ran in CI. This drives the REAL lib-harness run() path with
// fixtures/stand-in for `codex exec` (built for CI: "the real CLI is not
// installed there") and asserts the canary secret is in the harness env but
// never on Munder's disk.
//
// What it covers: codex-kind adapter end to end (spawn, JSONL events,
// receipt + native/normalized events files, receipts.jsonl), with a canary
// that matches NO known token shape (no sk-/mga_/Bearer prefix), so only the
// exact-value credential_env path (lib-harness.cjs scrub, known list) can
// catch it. The fixture deliberately echoes the secret into agent_message
// text (fake-codex.cjs `hecho (...)`), so final_text exercises the scrub.
// What it does NOT cover: the real codex/dsh CLIs, the ACP adapter
// (fake-acp-agent.cjs needs a permission round-trip harness-acp.cjs drives),
// or the hive write path — which receives only the already-scrubbed receipt
// (lib-harness.cjs: `recordOnTask(opts.taskId, clean)`), cited not executed.
// No taskId is passed here, so no real hive is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CANARY = 'CI_HARNESS_CANARY_9f8e7d6c5b4a';
const PROMPT = 'Escribe CI_P0.txt con "ci-harness-boundary-ok"';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-p0-ci-'));
const HDIR = path.join(root, 'harness');
process.env.MUNDER_HARNESS_DIR = HDIR;
const H = require('./lib-harness.cjs');

function fixtureRepo() {
  const d = path.join(root, 'repo');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'README.md'), '# Fixture\n');
  spawnSync('git', ['init', '-q'], { cwd: d });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'x', '--allow-empty'], { cwd: d });
  return d;
}

function blobs() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { try { out.push(fs.readFileSync(p, 'utf8')); } catch { /* unreadable */ } }
    }
  };
  walk(HDIR);
  return out;
}

test.before(() => {
  fs.mkdirSync(HDIR, { recursive: true });
  fs.writeFileSync(path.join(HDIR, 'adapters.json'), JSON.stringify({
    codex: {
      command: process.execPath,
      prefix: [path.join(__dirname, 'fixtures', 'fake-codex.cjs')],
      credential_env: ['FAKE_OPENAI_KEY'],
    },
  }));
});

test('codex via fixture: completed run, secret in harness env, never on Munder disk', { timeout: 120_000 }, async () => {
  const cwd = fixtureRepo();
  const r = await H.run({
    adapter: 'codex', prompt: PROMPT, cwd,
    env: { ...process.env, FAKE_OPENAI_KEY: CANARY }, timeoutMs: 30_000,
  });
  assert.equal(r.status, 'completed', JSON.stringify(r.error));
  assert.ok(r.external_session_id, 'the harness session id is recorded');
  // Non-vacuity: the secret DID reach the harness process env...
  assert.equal(fs.readFileSync(path.join(cwd, 'OUT.txt'), 'utf8').includes('key=present'), true, 'fixture saw the key in env');
  // ...but no blob Munder wrote contains it.
  const all = blobs();
  assert.ok(all.some((b) => b.includes('receipt_id')), 'receipts were written');
  assert.ok(!all.some((b) => b.includes(CANARY)), 'canary reached Munder disk');
  assert.ok(fs.existsSync(path.join(HDIR, 'receipts.jsonl')), 'receipts.jsonl exists');

  // Self-test hook (mutation proof, never set in CI): plant the canary and
  // assert the walk FINDS it, proving the absence assertion is not vacuous.
  if (process.env.HARNESS_CI_LEAK_CHECK) {
    fs.appendFileSync(path.join(HDIR, 'receipts.jsonl'), `{"planted":"${CANARY}"}\n`);
    assert.ok(blobs().some((b) => b.includes(CANARY)), 'walk must detect a planted canary');
  }
});
