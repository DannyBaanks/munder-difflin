'use strict';

/**
 * A message id is not a label — it is the inbox FILENAME. `deliver()` writes
 * `<id>.json` into the recipient's inbox, so an id that an agent (or a buggy
 * caller) got to choose is a write primitive aimed at the rest of the hive:
 * `../../registry` climbs out of the inbox, and any name that already exists
 * overwrites a message that was never read.
 *
 * The hive mints the id server-side. PROTOCOL.md already promises the harness
 * fills it in, so this is the contract being enforced, not a new restriction.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-msg-id-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'claude', cwd: home });
  return { home, hive, root: path.join(home, 'hive') };
}

const inbox = (root, id) => path.join(root, 'agents', id, 'inbox');
const files = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')) : []);
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('an authored id never becomes the inbox filename', async (t) => {
  const { hive, root } = await floor(t);

  const msg = hive.send({ id: '../../../../escape', to: 'jim', act: 'inform', body: 'x' }, 'god');

  assert.notEqual(msg.id, '../../../../escape');
  assert.deepEqual(files(inbox(root, 'jim')), [`${msg.id}.json`]);
  assert.equal(read(path.join(inbox(root, 'jim'), `${msg.id}.json`)).id, msg.id);
  // Nothing landed above the inbox: the traversal target does not exist.
  assert.equal(fs.existsSync(path.join(root, 'agents', 'escape.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'escape.json')), false);
});

test('a path separator in an authored id cannot reach another agent folder', async (t) => {
  const { hive, root } = await floor(t);

  const msg = hive.send({ id: '../god/overwrite-me', to: 'jim', act: 'inform', body: 'x' }, 'god');

  assert.deepEqual(files(inbox(root, 'jim')), [`${msg.id}.json`]);
  assert.deepEqual(files(inbox(root, 'god')), [], "god's inbox must stay empty");
  assert.equal(fs.existsSync(path.join(inbox(root, 'god'), 'overwrite-me.json')), false);
});

test('two messages carrying the same authored id are both delivered', async (t) => {
  const { hive, root } = await floor(t);

  const first = hive.send({ id: 'progress-canvas-v4', to: 'jim', act: 'inform', body: 'one' }, 'god');
  const second = hive.send({ id: 'progress-canvas-v4', to: 'jim', act: 'inform', body: 'two' }, 'god');

  assert.notEqual(first.id, second.id);
  assert.deepEqual(files(inbox(root, 'jim')).sort(), [`${first.id}.json`, `${second.id}.json`].sort());
  const bodies = files(inbox(root, 'jim'))
    .map((f) => read(path.join(inbox(root, 'jim'), f)).body)
    .sort();
  assert.deepEqual(bodies, ['one', 'two'], 'the second delivery must not overwrite the first');
});

test('an authored id cannot overwrite a message that is already waiting', async (t) => {
  const { hive, root } = await floor(t);

  const first = hive.send({ to: 'jim', act: 'request', body: 'original' }, 'god');
  // Jim's agent guesses the filename of the message waiting for him.
  const second = hive.send({ id: first.id, to: 'jim', act: 'inform', body: 'tampered' }, 'god');

  // Server-side minting means the guess lands beside the original, never on it.
  assert.notEqual(second.id, first.id);
  assert.deepEqual(files(inbox(root, 'jim')).sort(), [`${first.id}.json`, `${second.id}.json`].sort());
  assert.equal(read(path.join(inbox(root, 'jim'), `${first.id}.json`)).body, 'original');
});

test('the GPT mailbox is filed under a minted id too', async (t) => {
  const { hive, root } = await floor(t);
  fs.mkdirSync(path.join(root, 'gpt', 'inbox'), { recursive: true });

  const msg = hive.send({ id: '../../../gpt/own-the-mailbox', to: 'gpt', act: 'inform', body: 'hola' }, 'god');

  assert.deepEqual(files(path.join(root, 'gpt', 'inbox')), [`${msg.id}.json`]);
  assert.equal(read(path.join(root, 'gpt', 'inbox', `${msg.id}.json`)).id, msg.id);
});

test('a minted id keeps the documented <timestamp>-<rand> shape', async (t) => {
  const { hive } = await floor(t);

  const msg = hive.send({ to: 'jim', act: 'inform', body: 'x' }, 'god');

  assert.match(msg.id, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}$/,
    'ids are compared as strings where they stand in for creation order');
});
