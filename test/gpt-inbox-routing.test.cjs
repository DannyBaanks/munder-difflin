'use strict';

/**
 * Michael → ChatGPT. A hive message `"to": "gpt"` lands in <hive>/gpt/inbox,
 * the mailbox `munder gpt` creates for the operator's ChatGPT principal
 * (tools/munder/lib-gpt.cjs). Without that mailbox, "gpt" is just an unknown
 * recipient: drop logged, bounced to god, exactly like before. It is never an
 * agent: no terminal handoff, no roster entry, no broadcast target.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager, GPT_PRINCIPAL } = loadTs('src/main/hive.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-gpt-inbox-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'claude', cwd: home });
  return { home, hive, root: path.join(home, 'hive') };
}

const files = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')) : []);

test('with the GPT mailbox: "to": "gpt" is delivered there and logged as delivered', async (t) => {
  const { hive, root } = await floor(t);
  assert.equal(GPT_PRINCIPAL, 'gpt');
  fs.mkdirSync(path.join(root, 'gpt', 'inbox', '.done'), { recursive: true });
  const msg = hive.send({ to: 'gpt', act: 'inform', subject: 'PR revisado', body: 'Todo verde' }, 'god');
  const got = files(path.join(root, 'gpt', 'inbox'));
  assert.deepEqual(got, [`${msg.id}.json`]);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'gpt', 'inbox', got[0]), 'utf8'));
  assert.equal(saved.from, 'god');
  assert.equal(saved.to, 'gpt');
  const logged = hive.logTail(50).find((e) => e.kind === 'message' && e.id === msg.id);
  assert.deepEqual(logged.delivered, ['gpt']);
  assert.equal(files(path.join(root, 'agents', 'god', 'inbox')).length, 0, 'nothing bounced');
});

test('without the mailbox: "to": "gpt" bounces to god and is logged as a drop (unchanged behaviour)', async (t) => {
  const { hive, root } = await floor(t);
  const msg = hive.send({ to: 'gpt', act: 'inform', subject: 'hola', body: 'x' }, 'jim');
  const bounced = files(path.join(root, 'agents', 'god', 'inbox'));
  assert.equal(bounced.length, 1);
  assert.match(JSON.parse(fs.readFileSync(path.join(root, 'agents', 'god', 'inbox', bounced[0]), 'utf8')).subject, /GPT gateway is not set up/);
  assert.ok(hive.logTail(50).some((e) => e.kind === 'drop' && e.reason === 'no-inbox' && e.to === 'gpt' && e.id === msg.id));
  assert.equal(fs.existsSync(path.join(root, 'gpt')), false, 'the router never creates the mailbox itself');
});

test('gpt is not an agent: a broadcast never reaches it, and it is not on the roster', async (t) => {
  const { hive, root } = await floor(t);
  fs.mkdirSync(path.join(root, 'gpt', 'inbox'), { recursive: true });
  hive.send({ to: 'broadcast', act: 'inform', subject: 'a todos', body: 'x' }, 'god');
  assert.equal(files(path.join(root, 'gpt', 'inbox')).length, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(hive.registry().agents, 'gpt'), false);
});

test('the hive protocol tells agents how to reach ChatGPT', async (t) => {
  const { root } = await floor(t);
  const protocol = fs.readFileSync(path.join(root, 'PROTOCOL.md'), 'utf8');
  assert.match(protocol, /"to": "gpt"/);
});
