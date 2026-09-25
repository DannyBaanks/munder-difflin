'use strict';

/**
 * Regression coverage for the silent outbox-stall class (god→Pam dispatch sat
 * ~2h while direct-inject heartbeats kept flowing):
 *
 * The outbox→inbox router is a single setInterval with teardown paths
 * (changeHome/quit/reset) and re-arm only on boot/power-resume. A stop without
 * re-arm stalled delivery indefinitely with zero observability.
 *
 * These tests pin HiveManager.superviseRouter() + routerHealth() +
 * addRoutedObserver():
 *  1. dead loop + backlog → re-arm, immediate drain, degraded-state log;
 *  2. live loop + fresh scan → no re-arm, no duplicated work;
 *  3. stale scan timestamp → rebuild + drain (deterministic via explicit now);
 *  4. observer fan-out with exactly-once delivery;
 *  5. per-delivery receipts in the log;
 *  6. backlog count + oldest age reporting, zeroed after drain;
 *  7. dead loop + empty backlog → quiet re-arm.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-router-supervision-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const hive = new HiveManager(() => home);
  t.after(() => { try { hive.stopRouter(); } catch { /* noop */ } });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'Pam', provider: 'claude', cwd: home });

  const outbox = path.join(home, 'hive', 'agents', 'worker-1', 'outbox');
  return { hive, outbox };
}

function dispatch(outbox, filename, to = 'god-1') {
  fs.writeFileSync(path.join(outbox, filename), JSON.stringify({
    to, act: 'request', subject: 'work', body: 'do it', requires_reply: true
  }), 'utf8');
}

function superviseEvents(hive) {
  return hive.logTail(500).filter((e) => e.kind === 'router-supervise');
}

test('dead loop + backlog → re-arm, drain, degraded log', async (t) => {
  const { hive, outbox } = await floor(t);
  // Timer never started: the silent-stall state.
  dispatch(outbox, 'stalled.json');

  const r = hive.superviseRouter();
  assert.equal(r.rearmed, true);
  assert.equal(r.drained, 1);
  assert.equal(r.backlog, 1);
  assert.equal(hive.inbox('god-1').length, 1);
  assert.equal(fs.existsSync(path.join(outbox, '.sent', 'stalled.json')), true);

  const ev = superviseEvents(hive);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].rearmed, true);
  assert.equal(ev[0].drained, 1);
  assert.equal(ev[0].backlog, 1);
});

test('live loop + fresh scan → no re-arm, no duplicated work', async (t) => {
  const { hive, outbox } = await floor(t);
  hive.startRouter();
  assert.equal(hive.routeOnce(), 0); // stamps a fresh lastRouteAt

  dispatch(outbox, 'fresh.json');
  const r = hive.superviseRouter();
  assert.equal(r.rearmed, false);
  assert.equal(r.drained, 0);
  // Still queued: the supervisor must not duplicate the live router's job.
  assert.equal(fs.existsSync(path.join(outbox, 'fresh.json')), true);
  assert.equal(superviseEvents(hive).length, 0);

  // The normal path is intact.
  assert.equal(hive.routeOnce(), 1);
  assert.equal(hive.inbox('god-1').length, 1);
});

test('stale scan timestamp + backlog → rebuild + drain', async (t) => {
  const { hive, outbox } = await floor(t);
  hive.startRouter();
  assert.equal(hive.routeOnce(), 0); // lastRouteAt = T
  const scannedAt = hive.routerHealth().lastRouteAt;
  assert.ok(scannedAt > 0);

  dispatch(outbox, 'wedged.json');
  // 60s later with no completed scan: the wedged-loop branch (deterministic,
  // no wall-clock wait — superviseRouter accepts an explicit now).
  const r = hive.superviseRouter(scannedAt + 60_000);
  assert.equal(r.rearmed, true);
  assert.equal(r.drained, 1);
  assert.equal(hive.inbox('god-1').length, 1);
});

test('observer fan-out: every observer fires once, delivery happens once', async (t) => {
  const { hive, outbox } = await floor(t);
  const seenA = [];
  const seenB = [];
  const seenLegacy = [];
  const unsubA = hive.addRoutedObserver((msg) => seenA.push(msg.id));
  hive.addRoutedObserver((msg) => seenB.push(msg.id));
  hive.setRoutedObserver((msg) => seenLegacy.push(msg.id)); // legacy slot composes
  t.after(() => unsubA());

  dispatch(outbox, 'fanout.json');
  assert.equal(hive.routeOnce(), 1);
  assert.equal(seenA.length, 1);
  assert.equal(seenB.length, 1);
  assert.equal(seenLegacy.length, 1);
  assert.equal(seenA[0], seenB[0]);
  assert.equal(seenB[0], seenLegacy[0]);
  // Exactly-once delivery: fan-out must never duplicate the actionable mail.
  assert.equal(hive.inbox('god-1').length, 1);
});

test('routed delivery leaves a receipt with targets', async (t) => {
  const { hive, outbox } = await floor(t);
  dispatch(outbox, 'receipt.json');
  assert.equal(hive.routeOnce(), 1);

  const inboxId = hive.inbox('god-1')[0].id;
  const receipts = hive.logTail(500).filter((e) => e.kind === 'message' && e.id === inboxId);
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0].delivered, ['god-1']);
});

test('health reports backlog count + oldest age, zeroed after drain', async (t) => {
  const { hive, outbox } = await floor(t);
  dispatch(outbox, 'aging.json');
  const tenMinAgo = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(path.join(outbox, 'aging.json'), tenMinAgo, tenMinAgo);

  const before = hive.routerHealth();
  assert.equal(before.backlog, 1);
  assert.ok(before.oldestBacklogMs !== null && before.oldestBacklogMs >= 9 * 60_000);

  assert.equal(hive.routeOnce(), 1);
  const after = hive.routerHealth();
  assert.equal(after.backlog, 0);
  assert.equal(after.oldestBacklogMs, null);
});

test('dead loop + empty backlog → quiet re-arm, nothing drained', async (t) => {
  const { hive, outbox } = await floor(t);
  assert.equal(hive.routerHealth().running, false);

  const r = hive.superviseRouter();
  assert.equal(r.rearmed, true);
  assert.equal(r.drained, 0);
  assert.equal(r.backlog, 0);
  assert.equal(hive.routerHealth().running, true);
  void outbox;
});
