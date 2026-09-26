'use strict';

/**
 * A message from the god addressed to "human" resolves to the god itself (the
 * human's proxy on the floor), so the router's self-filter empties the target
 * list. Before this change the mail simply ceased to exist: no drop log, no
 * bounce, and a sender that had been told the channel worked.
 *
 * Same failure class the `no-inbox` drop already documents — "the sender saw a
 * routed message and the mail simply ceased to exist" — this was the remaining
 * instance. The self-filter stays (it prevents a routing loop); the drop becomes
 * observable, and the bounce names the channel that actually reaches the human.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-human-proxy-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'Creed', provider: 'claude', cwd: home });
  return { hive, home };
}

function drop(agent, filename, msg) {
  const outbox = path.join(agent, 'outbox');
  fs.mkdirSync(outbox, { recursive: true });
  fs.writeFileSync(path.join(outbox, filename), JSON.stringify({
    ...msg, requires_reply: false
  }), 'utf8');
}

test('god → "human": the drop is logged and the sender is told the real channel', async (t) => {
  const { hive, home } = await floor(t);
  const godDir = path.join(home, 'hive', 'agents', 'god-1');

  drop(godDir, 'to-human.json', {
    to: 'human', act: 'inform', subject: 'bridge check', body: 'ping'
  });
  hive.routeOnce();

  // The log distinguishes "there was nobody to deliver to" from "this can never
  // be delivered", which is the whole point: before, it looked like the former.
  const drops = hive.logTail(500).filter((e) => e.kind === 'drop' && e.reason === 'human-proxy-is-sender');
  assert.equal(drops.length, 1, 'god → human must leave one drop log');
  assert.equal(drops[0].from, 'god-1');
  assert.equal(drops[0].to, 'human');

  // The routed line still reports what actually took delivery, so the log never
  // claims a delivery that did not happen.
  const routed = hive.logTail(500).find((e) => e.kind === 'message' && e.id === drops[0].id);
  assert.ok(routed, 'the routed line is still logged');
  assert.deepEqual(routed.delivered, [], 'nothing may be reported as delivered');

  // And the sender learns the mail is gone, plus which channel does work.
  const bounce = hive.inbox('god-1').find((m) => String(m.subject).startsWith('[undeliverable'));
  assert.ok(bounce, 'the sender must receive a bounce');
  assert.match(bounce.subject, /blocked/);
  assert.match(bounce.subject, /humanQA/);
  assert.equal(bounce.body, 'ping', 'the original body survives the bounce');
});

test('a worker writing to "human" still reaches the god proxy, unchanged', async (t) => {
  const { hive, home } = await floor(t);
  const workerDir = path.join(home, 'hive', 'agents', 'worker-1');

  drop(workerDir, 'ask.json', {
    to: 'human', act: 'request', subject: 'needs a decision', body: 'which one?'
  });
  assert.equal(hive.routeOnce(), 1);

  const got = hive.inbox('god-1');
  assert.equal(got.length, 1, 'the proxy still receives it');
  assert.equal(got[0].subject, 'needs a decision', 'delivered verbatim, not bounced');
  assert.equal(
    hive.logTail(500).filter((e) => e.kind === 'drop' && e.reason === 'human-proxy-is-sender').length,
    0,
    'no self-target drop for a worker'
  );
});
