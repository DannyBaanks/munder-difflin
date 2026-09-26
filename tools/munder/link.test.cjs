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

/** Pair two live offices explicitly, the way a human does: same code on both screens. */
async function pairWith(a, b) {
  const { peer, code } = await L.requestPair(b.address, { dir: a.dir, port: Number(a.address.split(':')[1]) });
  L.trustPeer(peer, a.dir);
  L.acceptPending(code, b.dir);
  return peer;
}

const taskList = (o) => JSON.parse(fs.readFileSync(path.join(o.hive, 'tasks.json'), 'utf8')).tasks;
const inboxCount = (o) => (fs.existsSync(path.join(o.hive, 'agents', 'god', 'inbox')) ? fs.readdirSync(path.join(o.hive, 'agents', 'god', 'inbox')).length : 0);

test('identity is created once, private, and its id is the key fingerprint', () => {
  const o = office('id');
  const again = L.loadIdentity(o.dir);
  assert.equal(again.office_id, o.identity.office_id);
  assert.equal(L.officeIdOf(o.identity.sign.x), o.identity.office_id);
  if (process.platform !== 'win32') assert.equal(fs.statSync(L.files(o.dir).identity).mode & 0o777, 0o600);
});

test('both sides compute the same pairing code; a different nonce or sealing key gives a different code', () => {
  const a = office('sa'); const b = office('sb'); const m = office('sm');
  const [sa, sb, ba, bb] = [a.identity.sign.x, b.identity.sign.x, a.identity.box.x, b.identity.box.x];
  const c1 = L.sas(sa, sb, 'n1', 'n2', ba, bb);
  assert.equal(c1, L.sas(sb, sa, 'n2', 'n1', bb, ba));
  assert.match(c1, /^\d{6}$/);
  assert.notEqual(c1, L.sas(sa, sb, 'n1', 'n3', ba, bb));
  assert.notEqual(c1, L.sas(sa, sb, 'n1', 'n2', ba, m.identity.box.x), 'a swapped sealing key changes the code');
  assert.throws(() => L.sas(sa, sb, 'n1', 'n2'), (e) => e.code === 'bad_args');
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

test('an accepted Link arrival immediately notifies the authenticated local control channel', async (t) => {
  const a = await serve(office('wake-a'));
  const b = office('wake-b');
  let markReady;
  const ready = new Promise((resolve) => { markReady = resolve; });
  const received = new Promise((resolve, reject) => {
    const control = require('node:http').createServer(async (req, res) => {
      try {
        assert.equal(req.method, 'POST');
        assert.equal(req.url, '/hive/wake');
        assert.equal(req.headers.authorization, 'Bearer wake-token');
        let body = '';
        for await (const chunk of req) body += chunk;
        resolve(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (error) {
        reject(error);
        res.writeHead(500);
        res.end();
      }
    });
    control.listen(0, '127.0.0.1', () => {
      const controlFile = path.join(b.dir, 'munder-control.json');
      fs.writeFileSync(controlFile, JSON.stringify({ port: control.address().port, token: 'wake-token' }));
      const { server } = L.createLinkServer({ dir: b.dir, hiveRoot: b.hive, version: 'test', controlFile });
      server.listen(0, '127.0.0.1', () => {
        b.server = server;
        b.address = `127.0.0.1:${server.address().port}`;
        t.after(() => { a.server.close(); b.server.close(); control.close(); });
        markReady();
      });
    });
  });
  await ready;
  const peer = await pairWith(a, b);
  const delegated = await L.call(peer.name, 'submit', { compose: 'Wake Michael now', origin_ref: 'wake-link-1' }, { dir: a.dir });
  const wake = await received;
  assert.equal(wake.message_id, delegated.result.message_id);
});

// ─── hardening ───────────────────────────────────────────────────────────────

/** A man in the middle of pairing: forwards /pair both ways, swapping ONLY the
 *  sealing keys for its own. Signatures still verify, so before sas@2 both
 *  screens showed the same code and the attacker could read every sealed call. */
function mitmProxy(target, mallory) {
  const http = require('node:http');
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');
    if (body.box_pub) body.box_pub = mallory.identity.box.x;
    const up = await fetch(`http://${target}${req.url}`, { method: req.method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    const back = await up.json();
    if (back.box_pub) back.box_pub = mallory.identity.box.x;
    res.writeHead(up.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(back));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

test('a man in the middle who swaps sealing keys cannot make the two codes match', async (t) => {
  const b = await serve(office('mb'));
  const mallory = office('mallory');
  const proxy = await mitmProxy(b.address, mallory);
  t.after(() => { b.server.close(); proxy.close(); });
  const a = office('ma');
  const { peer, code } = await L.requestPair(`127.0.0.1:${proxy.address().port}`, { dir: a.dir });
  assert.equal(peer.box_pub, mallory.identity.box.x, 'the attack really swapped the key A sees');
  const onB = Object.values(L.loadPending(b.dir))[0];
  assert.equal(onB.box_pub, mallory.identity.box.x, 'and the key B sees');
  assert.notEqual(code, onB.code, 'the humans see different codes, so they refuse');
  assert.equal(L.acceptPending(code, b.dir), null, 'typing A\'s code on B pairs nothing');
});

test('a pending request cannot be overwritten with other keys, and /pair is rate limited per address', async (t) => {
  const b = await serve(office('rb'));
  t.after(() => b.server.close());
  const a = office('ra'); const m = office('rm');
  await L.requestPair(b.address, { dir: a.dir });
  const hijack = { ...L.publicCard(a.identity), box_pub: m.identity.box.x, nonce: 'x' };
  const post = (card) => fetch(`http://${b.address}/link/v1/pair`, { method: 'POST', body: JSON.stringify(card), headers: { 'Content-Type': 'application/json' } });
  const r = await post(hijack);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'pending_conflict');
  assert.equal(Object.values(L.loadPending(b.dir))[0].box_pub, a.identity.box.x, 'the real request survives');
  // 2 used so far; the limit is 5 per address per window
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await post({ ...L.publicCard(office(`rx${i}`).identity), nonce: 'n' })).status);
  assert.deepEqual(codes, [200, 200, 200, 429]);
});

test('a reply is bound to the call it answers', async (t) => {
  const a = await serve(office('ba'));
  const b = await serve(office('bb'));
  t.after(() => { a.server.close(); b.server.close(); });
  const { peer, code } = await L.requestPair(b.address, { dir: a.dir });
  L.trustPeer(peer, a.dir); L.acceptPending(code, b.dir);
  // record a genuine sealed reply from B, then serve it to A for a DIFFERENT call
  const aAsPeer = cardAsPeer(a);
  const recorded = L.seal(b.identity, aAsPeer, { ok: true, result: { stale: true }, re: 'someone-elses-nonce' });
  const http = require('node:http');
  const replay = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(recorded)); });
  await new Promise((r) => replay.listen(0, '127.0.0.1', r));
  t.after(() => replay.close());
  const peers = L.loadPeers(a.dir);
  peers[peer.office_id].addresses = [`127.0.0.1:${replay.address().port}`];
  require('node:fs').writeFileSync(L.files(a.dir).peers, JSON.stringify(peers));
  await assert.rejects(L.call(peer.name, 'status', {}, { dir: a.dir }), (e) => e.code === 'bad_reply');
});

test('delegated tasks are marked external and tell Michael to ask before acting outward', async (t) => {
  const o = office('ext');
  const r = new L.Office(o.hive, 'link:x').submit({ compose: 'Manda el correo a todos los clientes', origin: { office_id: 'abcd', name: 'michael-otra' } });
  const task = JSON.parse(fs.readFileSync(path.join(o.hive, 'tasks.json'), 'utf8')).tasks.find((x) => x.id === r.task_id);
  assert.equal(task.link.external, true);
  const inbox = path.join(o.hive, 'agents', 'god', 'inbox');
  const msg = JSON.parse(fs.readFileSync(path.join(inbox, fs.readdirSync(inbox)[0]), 'utf8'));
  assert.match(msg.body, /Petición externa/);
  assert.match(msg.body, /confirmación humana/);
});

test('discovery answers private, loopback and Tailscale sources only', () => {
  for (const a of ['10.1.2.3', '172.16.0.9', '192.168.0.4', '127.0.0.1', '169.254.1.1', '100.100.1.1', '::ffff:192.168.1.5']) assert.equal(L.isPrivateV4(a), true, a);
  for (const a of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '1.1.1.1', 'fe80::1', '']) assert.equal(L.isPrivateV4(a), false, a);
});

test('submit is idempotent per peer+origin_ref, and it survives a restart', async (t) => {
  const a = await serve(office('idem-a'));
  const b = await serve(office('idem-b'));
  t.after(() => { a.server.close(); b.server.close(); });
  const peer = await pairWith(a, b);
  const ref = 'link-1790320263790-ab12cd';
  const args = { compose: 'Audita PITON', title: 'Auditoría PITON', origin_ref: ref };

  const first = await L.call(peer.name, 'submit', args, { dir: a.dir });
  assert.equal(first.result.duplicate, false);
  const retried = await L.call(peer.name, 'submit', args, { dir: a.dir });
  assert.equal(retried.result.task_id, first.result.task_id);
  assert.equal(retried.result.duplicate, true);
  assert.equal(taskList(b).length, 1);
  assert.equal(inboxCount(b), 1);

  // Durable, not in-memory: a fresh server (as after `munder link encender`)
  // on the same state dir still recognises the ref.
  const b2 = await serve({ ...b, server: undefined });
  t.after(() => b2.server.close());
  const afterRestart = await L.call(peer.name, 'submit', args, { dir: a.dir });
  assert.equal(afterRestart.result.task_id, first.result.task_id);
  assert.equal(taskList(b).length, 1);
  assert.equal(inboxCount(b), 1);
  await assert.rejects(L.call(peer.name, 'submit', { ...args, compose: 'otra cosa' }, { dir: a.dir }), (e) => e.code === 'origin_conflict');
  assert.equal(taskList(b).length, 1);
  assert.equal(inboxCount(b), 1);

  // The record is peer-scoped: the same ref from another office is a different key.
  const onB = L.loadOrigins(b.dir);
  assert.equal(onB[L.originKey(a.identity.office_id, ref)].task_id, first.result.task_id);
  assert.equal(onB[L.originKey(b.identity.office_id, ref)], undefined);
  assert.deepEqual(Object.keys(onB), [L.originKey(a.identity.office_id, ref)]);
  assert.match(fs.readFileSync(path.join(b.hive, 'log.jsonl'), 'utf8'), /"event":"link_submit_duplicate"/);
});

test('a reply is routed by the origin_ref, and only by the office that owns it', async (t) => {
  const a = await serve(office('rep-a'));
  const b = await serve(office('rep-b'));
  const c = await serve(office('rep-c'));
  t.after(() => { a.server.close(); b.server.close(); c.server.close(); });
  await pairWith(a, b);
  await pairWith(a, c);

  const d = await L.delegate('rep-b', 'Audita PITON', { dir: a.dir, hiveRoot: a.hive });
  const before = inboxCount(a);
  const r = await L.reply('rep-a', d.origin_ref, { text: 'hecho', result: '3 hallazgos', dir: b.dir });
  assert.equal(r.result.origin_ref, d.origin_ref);
  assert.equal(r.result.task_id, d.result.task_id);

  // A's own Michael hears about it, tagged with the ref that delegated the work.
  const said = (n) => JSON.parse(fs.readFileSync(path.join(a.hive, 'agents', 'god', 'inbox', fs.readdirSync(path.join(a.hive, 'agents', 'god', 'inbox'))[n]), 'utf8'));
  assert.equal(inboxCount(a), before + 1);
  assert.equal(said(0).act, 'inform');
  assert.match(said(0).body, /hecho/);
  assert.match(said(0).body, new RegExp(d.origin_ref));
  assert.match(said(0).body, /3 hallazgos/);
  assert.match(fs.readFileSync(path.join(a.hive, 'log.jsonl'), 'utf8'), /"event":"link_reply_received"/);
  assert.match(fs.readFileSync(L.files(a.dir).receipts, 'utf8'), /"event":"reply_received"/);

  // A card on our own board carrying that ref is brought up to date too.
  fs.writeFileSync(path.join(a.hive, 'tasks.json'), JSON.stringify({ tasks: [{ id: d.result.task_id, title: 'Auditoría', status: 'todo', link: { from_office: b.identity.office_id, origin_ref: d.origin_ref } }] }));
  const again = await L.reply('rep-a', d.origin_ref, { result: '6 hallazgos', dir: b.dir });
  assert.equal(again.result.status, 'done');
  const mine = taskList(a)[0];
  assert.equal(mine.result, '6 hallazgos');
  assert.equal(mine.status, 'done');

  // The office that never got that ref cannot answer it, even though it is paired.
  await assert.rejects(L.reply('rep-a', d.origin_ref, { text: 'me colé', result: 'malo', dir: c.dir }), (e) => e.code === 'unknown_origin');
  // …and a ref nobody minted is refused, without touching the board.
  await assert.rejects(L.reply('rep-a', 'link-1-ffffff', { text: 'inventada', dir: b.dir }), (e) => e.code === 'unknown_origin');
  await assert.rejects(L.reply('rep-a', 'no vale esta ref', { text: 'x', dir: b.dir }), (e) => e.code === 'bad_args');
  assert.equal(inboxCount(a), before + 2);
  assert.equal(taskList(a)[0].result, '6 hallazgos');
  assert.match(fs.readFileSync(path.join(a.hive, 'log.jsonl'), 'utf8'), /"event":"link_reply_rejected"/);
});

test('capacity reads a nested roster and an old flat one the same way', () => {
  const o = office('cap');
  const flat = { god: { name: 'Michael', status: 'idle' }, w1: { name: 'Jim', status: 'idle' }, w2: { name: 'Pam', status: 'working' } };
  const nested = { godId: 'god', agents: flat, version: 2 };
  const officeFields = (value) => ({ workers_total: value.workers_total, workers_idle: value.workers_idle, michael_state: value.michael_state, tasks_open: value.tasks_open });
  const reg = path.join(o.hive, 'registry.json');
  fs.writeFileSync(path.join(o.hive, 'tasks.json'), JSON.stringify({ tasks: [{ id: 't1', status: 'todo' }, { id: 't2', status: 'done' }] }));

  fs.writeFileSync(reg, JSON.stringify(flat));
  const legacy = L.capacity(new L.Office(o.hive, 'link:x'));
  fs.writeFileSync(reg, JSON.stringify(nested));
  const current = L.capacity(new L.Office(o.hive, 'link:x'));

  assert.deepEqual(officeFields(current), officeFields(legacy));
  assert.equal(current.workers_total, 2);
  assert.equal(current.workers_idle, 1);
  assert.equal(current.michael_state, 'idle');
  assert.equal(current.tasks_open, 1);
  // the wrapper keys are not agents
  assert.notEqual(current.workers_total, 2 + 1);
  const custom = { godId: 'boss', agents: { boss: { status: 'idle' }, w1: { status: 'idle' }, w2: { status: 'working' } } };
  fs.writeFileSync(reg, JSON.stringify(custom));
  const customCapacity = L.capacity(new L.Office(o.hive, 'link:x'));
  assert.equal(customCapacity.workers_total, 2);
  assert.equal(customCapacity.workers_idle, 1);
  assert.equal(customCapacity.michael_state, 'idle');
  // missing roster: offline, not a crash
  fs.writeFileSync(reg, '{}');
  assert.equal(L.capacity(new L.Office(o.hive, 'link:x')).michael_state, 'offline');
  // a roster saved with a BOM (Windows editors do that) is not an empty roster
  fs.writeFileSync(reg, `\uFEFF${JSON.stringify(nested)}`);
  assert.deepEqual(officeFields(L.capacity(new L.Office(o.hive, 'link:x'))), officeFields(legacy));
});

test('the public hello carries host numbers only, never the office roster or board', async (t) => {
  const o = await serve(office('hello'));
  t.after(() => o.server.close());
  fs.writeFileSync(path.join(o.hive, 'registry.json'), JSON.stringify({ godId: 'god', agents: { god: { status: 'idle' }, w1: { status: 'idle' } } }));
  fs.writeFileSync(path.join(o.hive, 'tasks.json'), JSON.stringify({ tasks: [{ id: 't1', status: 'todo', title: 'secreto' }] }));
  const card = await (await fetch(`http://${o.address}/link/v1/hello`)).json();
  assert.equal(card.protocol, L.PROTOCOL);
  assert.ok(card.capacity.ram_total_gb > 0, 'the CLI shows RAM while discovering');
  for (const secret of ['workers_total', 'workers_idle', 'michael_state', 'tasks_open']) {
    assert.equal(card.capacity[secret], undefined, `${secret} must stay behind the sealed status call`);
  }
  // the same split on the UDP discovery answer
  const udpPort = 40000 + Math.floor(Math.random() * 20000);
  const sock = L.createDiscoveryResponder({ dir: o.dir, port: 47831, udpPort });
  t.after(() => sock.close());
  const found = await L.discoverLan({ dir: office('hello2').dir, targets: ['127.0.0.1'], udpPort, timeoutMs: 500 });
  assert.equal(found.length, 1);
  assert.equal(found[0].capacity, undefined);
});

test('LAN discovery re-probes a losy target and stays inside its caps', async (t) => {
  const b = office('retry');
  const udpPort = 40000 + Math.floor(Math.random() * 20000);
  // A target that drops the first two probes, like a busy Wi-Fi or a firewall
  // that has not learned the subnet yet.
  const probes = { seen: 0 };
  const lossy = require('node:dgram').createSocket({ type: 'udp4', reuseAddr: true });
  lossy.on('message', (msg, rinfo) => {
    if (msg.toString('utf8') !== 'MUNDER-LINK?v1') return;
    probes.seen += 1;
    if (probes.seen < 3) return;
    lossy.send(Buffer.from(JSON.stringify({ ...L.publicCard(b.identity), port: 47831, protocol: L.PROTOCOL })), rinfo.port, rinfo.address);
  });
  await new Promise((r) => lossy.bind(udpPort, r));
  t.after(() => lossy.close());

  const a = office('retry-a');
  const one = await L.discoverLan({ dir: a.dir, targets: ['127.0.0.1'], udpPort, timeoutMs: 500, attempts: 1 });
  assert.equal(one.length, 0, 'a single probe is not enough for a lossy target');
  probes.seen = 0;
  const many = await L.discoverLan({ dir: a.dir, targets: ['127.0.0.1'], udpPort, timeoutMs: 500 });
  assert.equal(many.length, 1);
  assert.equal(many[0].office_id, b.identity.office_id);

  // attempts and target count are capped, and the call returns on its deadline
  probes.seen = 0;
  const started = Date.now();
  const targets = Array.from({ length: 200 }, (_, i) => `127.0.0.${1 + (i % 250)}.1`);
  await L.discoverLan({ dir: a.dir, targets, udpPort: 1, timeoutMs: 400, attempts: 999 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 380 && elapsed < 3000, `bounded deadline, took ${elapsed}ms`);
  assert.ok(probes.seen <= L.MAX_DISCOVERY_ATTEMPTS, `at most ${L.MAX_DISCOVERY_ATTEMPTS} rounds, saw ${probes.seen}`);
  assert.deepEqual(L.loadPeers(a.dir), {}, 'discovery still trusts nobody');
});

test('a peer address list is capped, and a call gives up on its budget', async (t) => {
  const a = office('addr');
  const peer = { office_id: 'ab12cd34ef567890', name: 'michael-xeon', sign_pub: a.identity.sign.x, box_pub: a.identity.box.x, addresses: Array.from({ length: 40 }, (_, i) => `127.0.0.1:${5000 + i}`) };
  const saved = L.trustPeer(peer, a.dir);
  assert.equal(saved.addresses.length, L.MAX_PEER_ADDRESSES);
  assert.equal(L.loadPeers(a.dir)[peer.office_id].addresses.length, L.MAX_PEER_ADDRESSES);

  // every address is dead: one budget, not timeoutMs × addresses
  const started = Date.now();
  await assert.rejects(L.call(peer.office_id, 'status', {}, { dir: a.dir, timeoutMs: 300 }), (e) => e.code === 'unreachable');
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3000, `bounded by the budget, took ${elapsed}ms`);
});
