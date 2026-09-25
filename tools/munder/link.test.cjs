'use strict';
// node --test tools/munder/link.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('./lib-link.cjs');

function office(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `link-${name}-`));
  const dir = path.join(root, 'state');
  const hive = path.join(root, 'hive');
  fs.mkdirSync(hive, { recursive: true });
  fs.writeFileSync(path.join(hive, 'registry.json'), JSON.stringify({ god: { name: 'Michael', status: 'idle' }, w1: { name: 'Jim', status: 'idle' }, w2: { name: 'Pam', status: 'working' } }));
  const identity = L.loadIdentity(dir, `michael-${name}`);
  return { name, dir, hive, identity };
}

async function serve(o) {
  const { server } = L.createLinkServer({ dir: o.dir, hiveRoot: o.hive, version: 'test' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  o.server = server;
  o.address = `127.0.0.1:${server.address().port}`;
  return o;
}

const cardAsPeer = (o) => ({ office_id: o.identity.office_id, name: o.identity.name, sign_pub: o.identity.sign.x, box_pub: o.identity.box.x, addresses: [] });

test('identity is created once, private, and its id is the key fingerprint', () => {
  const o = office('id');
  const again = L.loadIdentity(o.dir);
  assert.equal(again.office_id, o.identity.office_id);
  assert.equal(L.officeIdOf(o.identity.sign.x), o.identity.office_id);
  if (process.platform !== 'win32') assert.equal(fs.statSync(L.files(o.dir).identity).mode & 0o777, 0o600);
});

test('both sides compute the same pairing code; a different nonce gives a different code', () => {
  const a = office('sa'); const b = office('sb');
  const c1 = L.sas(a.identity.sign.x, b.identity.sign.x, 'n1', 'n2');
  assert.equal(c1, L.sas(b.identity.sign.x, a.identity.sign.x, 'n2', 'n1'));
  assert.match(c1, /^\d{6}$/);
  assert.notEqual(c1, L.sas(a.identity.sign.x, b.identity.sign.x, 'n1', 'n3'));
});

test('a sealed envelope opens only for its paired recipient, once, and only unaltered', () => {
  const a = office('ea'); const b = office('eb');
  const peersOfB = { [a.identity.office_id]: cardAsPeer(a) };
  const env = L.seal(a.identity, cardAsPeer(b), { op: 'status' });
  const seen = new Map();
  assert.deepEqual(L.open(b.identity, peersOfB, env, seen).payload, { op: 'status' });

  const code = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.code; } };
  assert.equal(code(() => L.open(b.identity, peersOfB, env, seen)), 'replay');
  const flip = (s) => s.slice(0, -2) + (s.at(-2) === 'A' ? 'B' : 'A') + s.at(-1);
  assert.equal(code(() => L.open(b.identity, peersOfB, { ...L.seal(a.identity, cardAsPeer(b), { x: 1 }), ct: flip(env.ct) }, new Map())), 'bad_signature');
  assert.equal(code(() => L.open(b.identity, {}, L.seal(a.identity, cardAsPeer(b), {}), new Map())), 'unknown_peer');
  const c = office('ec');
  assert.equal(code(() => L.open(c.identity, { [a.identity.office_id]: cardAsPeer(a) }, L.seal(a.identity, cardAsPeer(b), {}), new Map())), 'wrong_office');
  assert.equal(code(() => L.open(b.identity, peersOfB, L.seal(a.identity, cardAsPeer(b), {}, Date.now() - 10 * 60_000), new Map())), 'stale');
});

test('full flow: pair explicitly, delegate, follow, message, cancel — with receipts on both sides', async (t) => {
  const a = await serve(office('linux'));
  const b = await serve(office('xeon'));
  t.after(() => { a.server.close(); b.server.close(); });

  // A asks B; both screens show the same code
  const { peer, code } = await L.requestPair(b.address, { dir: a.dir, port: Number(a.address.split(':')[1]) });
  assert.equal(peer.office_id, b.identity.office_id);
  const pendingOnB = Object.values(L.loadPending(b.dir));
  assert.equal(pendingOnB.length, 1);
  assert.equal(pendingOnB[0].code, code);

  // A confirms on its side, but B has not accepted yet: nothing works
  L.trustPeer(peer, a.dir);
  await assert.rejects(L.call('michael-xeon', 'status', {}, { dir: a.dir }), (e) => e.code === 'unknown_peer');

  // a wrong code accepts nothing; the right one pairs
  assert.equal(L.acceptPending('000000' === code ? '111111' : '000000', b.dir), null);
  assert.equal(L.acceptPending(code, b.dir).office_id, a.identity.office_id);

  const st = await L.call('xeon', 'status', {}, { dir: a.dir });
  assert.equal(st.result.name, 'michael-xeon');
  assert.equal(st.result.capacity.workers_total, 2);
  assert.equal(st.result.capacity.workers_idle, 1);
  assert.equal(st.result.capacity.michael_state, 'idle');

  const d = await L.delegate('xeon', 'Audita PITON', { dir: a.dir, hiveRoot: a.hive, title: 'Auditoría PITON' });
  const inbox = fs.readdirSync(path.join(b.hive, 'agents', 'god', 'inbox'));
  assert.equal(inbox.length, 1);
  const msg = JSON.parse(fs.readFileSync(path.join(b.hive, 'agents', 'god', 'inbox', inbox[0]), 'utf8'));
  assert.match(msg.body, /Munder Link — tarea delegada/);
  assert.match(msg.body, /michael-linux/);
  assert.equal(msg.from, 'link:michael-linux');
  const taskOnB = JSON.parse(fs.readFileSync(path.join(b.hive, 'tasks.json'), 'utf8')).tasks[0];
  assert.equal(taskOnB.id, d.result.task_id);
  assert.equal(taskOnB.link.from_office, a.identity.office_id);
  assert.equal(taskOnB.link.origin_ref, d.origin_ref);

  // provenance on both sides
  const logA = fs.readFileSync(path.join(a.hive, 'log.jsonl'), 'utf8');
  assert.match(logA, /"event":"link_delegated"/);
  assert.match(fs.readFileSync(path.join(b.hive, 'log.jsonl'), 'utf8'), /"event":"link_received"/);
  assert.match(fs.readFileSync(L.files(a.dir).receipts, 'utf8'), /"event":"delegated"/);
  assert.match(fs.readFileSync(L.files(b.dir).receipts, 'utf8'), /"event":"received"/);

  const g = await L.call('xeon', 'get', { task_id: d.result.task_id }, { dir: a.dir });
  assert.equal(g.result.status, 'queued');
  await L.call('xeon', 'message', { task_id: d.result.task_id, message: 'usa 4 workers' }, { dir: a.dir });
  const c = await L.call('xeon', 'cancel', { task_id: d.result.task_id, reason: 'ya no' }, { dir: a.dir });
  assert.equal(c.result.cancellation_requested, true);
  assert.equal(fs.readdirSync(path.join(b.hive, 'agents', 'god', 'inbox')).length, 3);
});

test('a peer can only see the tasks it delegated, not the rest of the board', async (t) => {
  const a = await serve(office('pa'));
  const b = await serve(office('pb'));
  t.after(() => { a.server.close(); b.server.close(); });
  const { peer, code } = await L.requestPair(b.address, { dir: a.dir });
  L.trustPeer(peer, a.dir);
  L.acceptPending(code, b.dir);
  fs.writeFileSync(path.join(b.hive, 'tasks.json'), JSON.stringify({ tasks: [{ id: 'task-private', title: 'secreto', status: 'todo' }] }));
  await assert.rejects(L.call(peer.name, 'get', { task_id: 'task-private' }, { dir: a.dir }), (e) => e.code === 'no_task');
  await assert.rejects(L.call(peer.name, 'cancel', { task_id: 'task-private' }, { dir: a.dir }), (e) => e.code === 'no_task');
});

test('pairing refuses keys that do not match the claimed office id', async (t) => {
  const b = await serve(office('kb'));
  t.after(() => b.server.close());
  const a = office('ka');
  const liar = { ...L.publicCard(a.identity), office_id: '0000000000000000', nonce: 'x' };
  const res = await fetch(`http://${b.address}/link/v1/pair`, { method: 'POST', body: JSON.stringify(liar), headers: { 'Content-Type': 'application/json' } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'bad_identity');
});

test('LAN discovery lists offices without trusting them', async (t) => {
  const b = office('db');
  const udpPort = 40000 + Math.floor(Math.random() * 20000);
  const sock = L.createDiscoveryResponder({ dir: b.dir, port: 47831, udpPort });
  t.after(() => sock.close());
  await new Promise((r) => sock.once('listening', r));
  const a = office('da');
  const found = await L.discoverLan({ dir: a.dir, targets: ['127.0.0.1'], udpPort, timeoutMs: 400 });
  assert.equal(found.length, 1);
  assert.equal(found[0].office_id, b.identity.office_id);
  assert.equal(found[0].via, 'lan');
  assert.deepEqual(L.loadPeers(a.dir), {});
});

test('messages keep the Office Bridge format, so Michael reads them like any other', () => {
  const o = office('fmt');
  new L.Office(o.hive, 'link:x').message('s', 'b');
  const inbox = path.join(o.hive, 'agents', 'god', 'inbox');
  const msg = JSON.parse(fs.readFileSync(path.join(inbox, fs.readdirSync(inbox)[0]), 'utf8'));
  // field list of HiveMessage in src/mcp/office-bridge/hiveAdapter.ts
  assert.deepEqual(Object.keys(msg).sort(), ['act', 'body', 'conversation', 'created_at', 'from', 'hops', 'id', 'in_reply_to', 'needs_human', 'requires_reply', 'subject', 'to'].sort());
});
