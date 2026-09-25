'use strict';
// node --test tools/munder/remote.test.cjs
//
// Munder Remote end to end: the phone side is the SAME remote-crypto.js the
// browser loads, talking HTTP to a real link server with a temp hive.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('./lib-link.cjs');
const R = require('./lib-remote.cjs');
const C = require('./remote-app/remote-crypto.js');

function office(name, { hive = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `remote-${name}-`));
  const dir = path.join(root, 'state');
  const hiveRoot = hive ? path.join(root, 'hive') : null;
  if (hiveRoot) {
    fs.mkdirSync(hiveRoot, { recursive: true });
    fs.writeFileSync(path.join(hiveRoot, 'registry.json'), JSON.stringify({ godId: 'god', agents: {
      god: { name: 'Michael', status: 'working' },
      w1: { name: 'Jim', status: 'idle', role: 'Frontend' },
      w2: { name: 'Pam', status: 'blocked' },
      old: { name: 'Ryan', status: 'gone', archived: true },
    } }));
    fs.writeFileSync(path.join(hiveRoot, 'tasks.json'), JSON.stringify({ tasks: [
      { id: 't-old', title: 'Older ask', status: 'blocked', createdAt: '2026-01-01T00:00:00Z', humanQA: [{ q: 'old?', askedAt: '2026-01-01T00:00:00Z' }] },
      { id: 't-new', title: 'Newer ask', status: 'blocked', createdAt: '2026-01-02T00:00:00Z', humanQA: [{ q: 'first?', a: 'yes', askedAt: '2026-01-02T00:00:00Z' }, { q: '**new?**', askedAt: '2026-01-03T00:00:00Z' }] },
      { id: 't-doing', title: 'Working', status: 'doing', createdAt: '2026-01-02T00:00:00Z', humanQA: [{ q: 'not blocked, not on the board', askedAt: '2026-01-04T00:00:00Z' }] },
      { id: 't-done', title: 'Done', status: 'done', createdAt: '2026-01-01T00:00:00Z', result: 'ok' },
    ], extra: 'kept' }));
  }
  const identity = L.loadIdentity(dir, `michael-${name}`);
  return { dir, hive: hiveRoot, identity };
}

async function serve(o) {
  const { server } = L.createLinkServer({ dir: o.dir, hiveRoot: o.hive, version: 'test' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  o.server = server;
  o.base = `http://127.0.0.1:${server.address().port}`;
  return o;
}

async function post(base, route, body) {
  const r = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

/** The phone: exactly the steps app.js takes. */
async function pairPhone(o, name = 'iPhone') {
  const kp = C.x25519Keypair();
  const pub = C.b64u(kp.pub);
  const nonce = C.random(16);
  const r1 = await post(o.base, '/remote/v1/pair', { name, pub, commit: C.b64u(C.sha256(nonce)) });
  assert.equal(r1.status, 200);
  const deviceId = C.deviceIdOf(kp.pub);
  assert.equal(r1.body.device_id, deviceId);
  const r2 = await post(o.base, '/remote/v1/reveal', { device_id: deviceId, nonce: C.b64u(nonce) });
  assert.equal(r2.status, 200);
  const phone = {
    deviceId, officeId: r1.body.office_id,
    key: C.sessionKey(kp.priv, r1.body.box_pub, r1.body.office_id, deviceId),
    code: C.sas(r1.body.box_pub, pub, r1.body.nonce, C.b64u(nonce)),
  };
  phone.envelope = (op, args = {}, ts = Date.now()) => C.sealRequest(phone.key, deviceId, phone.officeId, { ts, op, args });
  phone.send = async (env) => {
    const r = await post(o.base, '/remote/v1/call', env);
    if (r.status !== 200) return { http: r.status, ...r.body };
    const msg = C.openResponse(phone.key, deviceId, phone.officeId, r.body);
    assert.equal(msg.re, env.iv, 'the answer is bound to this request');
    return msg;
  };
  phone.call = (op, args) => phone.send(phone.envelope(op, args));
  return phone;
}

async function pairedPhone(o, name) {
  const phone = await pairPhone(o, name);
  assert.ok(L.acceptPending(phone.code, o.dir));
  return phone;
}

const readTasks = (o) => JSON.parse(fs.readFileSync(path.join(o.hive, 'tasks.json'), 'utf8'));
const inbox = (o) => {
  const d = path.join(o.hive, 'agents', 'god', 'inbox');
  return fs.existsSync(d) ? fs.readdirSync(d).sort().map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))) : [];
};

test('phone crypto matches Node byte for byte (SHA-256, HKDF, X25519, ChaCha20-Poly1305)', () => {
  for (const s of ['', 'abc', 'x'.repeat(55), 'y'.repeat(64), 'z'.repeat(1000)]) {
    assert.deepEqual(Buffer.from(C.sha256(s)), crypto.createHash('sha256').update(s).digest());
  }
  assert.deepEqual(Buffer.from(C.hmac('k'.repeat(100), 'data')), crypto.createHmac('sha256', 'k'.repeat(100)).update('data').digest());
  assert.deepEqual(Buffer.from(C.hkdf(Buffer.from('ikm'), 'salt', 'info', 42)), Buffer.from(crypto.hkdfSync('sha256', 'ikm', 'salt', 'info', 42)));

  const phone = C.x25519Keypair();
  const node = crypto.generateKeyPairSync('x25519');
  const nodePub = Buffer.from(node.publicKey.export({ format: 'jwk' }).x, 'base64url');
  const phonePubKey = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: C.b64u(phone.pub) }, format: 'jwk' });
  assert.deepEqual(Buffer.from(C.x25519(phone.priv, nodePub)), crypto.diffieHellman({ privateKey: node.privateKey, publicKey: phonePubKey }));

  for (const n of [0, 1, 63, 64, 65, 1000]) {
    const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), pt = crypto.randomBytes(n), aad = Buffer.from(`aad-${n}`);
    const c = crypto.createCipheriv('chacha20-poly1305', key, iv, { authTagLength: 16 });
    c.setAAD(aad, { plaintextLength: n });
    const ref = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
    assert.deepEqual(Buffer.from(C.aeadSeal(key, iv, pt, aad)), ref);
    assert.deepEqual(Buffer.from(C.aeadOpen(key, iv, ref, aad)), pt);
    const bad = Buffer.from(ref); bad[bad.length - 1] ^= 1;
    assert.throws(() => C.aeadOpen(key, iv, bad, aad));
  }
  const raw = crypto.randomBytes(37);
  assert.equal(C.b64u(raw), raw.toString('base64url'));
  assert.deepEqual(Buffer.from(C.fromB64u(C.b64u(raw))), raw);
});

test('pairing: both screens show the same code, nothing works until a human accepts it here, and a phone is never a peer', async (t) => {
  const o = await serve(office('victus'));
  t.after(() => o.server.close());
  const phone = await pairPhone(o, 'iPhone de Danny');
  const pending = L.loadPending(o.dir)[phone.deviceId];
  assert.equal(pending.kind, 'remote');
  assert.equal(pending.code, phone.code, 'office and phone computed the same 6 digits');

  const before = await phone.call('hello');
  assert.equal(before.http, 401);
  assert.equal(before.code, 'waiting');

  const accepted = L.acceptPending(phone.code, o.dir);
  assert.equal(accepted.kind, 'remote');
  assert.ok(L.loadRemotes(o.dir)[phone.deviceId]);
  assert.deepEqual(L.loadPeers(o.dir), {}, 'a phone never lands among the peers');
  await assert.rejects(L.call(phone.deviceId, 'status', {}, { dir: o.dir }), { code: 'unknown_peer' });

  const hi = await phone.call('hello');
  assert.equal(hi.ok, true);
  assert.equal(hi.result.name, 'michael-victus');
  assert.equal(hi.result.device, 'iPhone de Danny');
});

test('pairing: a reveal that breaks the commitment is refused, and each commitment gets one reveal', async (t) => {
  const o = await serve(office('commit'));
  t.after(() => o.server.close());
  const kp = C.x25519Keypair();
  const nonce = C.random(16);
  const r1 = await post(o.base, '/remote/v1/pair', { name: 'x', pub: C.b64u(kp.pub), commit: C.b64u(C.sha256(nonce)) });
  const cheat = await post(o.base, '/remote/v1/reveal', { device_id: r1.body.device_id, nonce: C.b64u(C.random(16)) });
  assert.equal(cheat.status, 400);
  assert.equal(cheat.body.code, 'bad_commit');
  assert.equal(L.loadPending(o.dir)[r1.body.device_id], undefined);
  const again = await post(o.base, '/remote/v1/reveal', { device_id: r1.body.device_id, nonce: C.b64u(nonce) });
  assert.equal(again.status, 404);

  const junk = await post(o.base, '/remote/v1/pair', { name: 'x', pub: 'short', commit: C.b64u(C.sha256(nonce)) });
  assert.equal(junk.status, 400);
});

test('overview: the operator view of this office (agents, open questions newest first, board)', async (t) => {
  const o = await serve(office('overview'));
  t.after(() => o.server.close());
  const phone = await pairedPhone(o);
  const { result: d } = await phone.call('overview');
  assert.equal(d.office.name, 'michael-overview');
  assert.equal(d.hive, true);
  assert.equal(d.capacity.michael_state, 'working');
  assert.deepEqual(d.agents.map((a) => a.id).sort(), ['god', 'w1', 'w2'], 'archived agents are left out');
  assert.equal(d.agents.find((a) => a.id === 'god').god, true);
  assert.deepEqual(d.questions.map((q) => q.id), ['t-new', 't-old'], 'only blocked cards, newest ask first');
  assert.equal(d.questions[0].question.q, '**new?**', 'the open ask, not an answered one');
  assert.deepEqual(d.tasks.map((x) => x.id).sort(), ['t-doing', 't-done', 't-new', 't-old']);
});

test('overview without a hive still answers (Michael offline)', async (t) => {
  const o = await serve(office('nohive', { hive: false }));
  t.after(() => o.server.close());
  const phone = await pairedPhone(o);
  const { result: d } = await phone.call('overview');
  assert.equal(d.hive, false);
  assert.equal(d.capacity.michael_state, 'offline');
  assert.deepEqual(d.questions, []);
});

test('answer: lands on the card like the ASK ME board, tells Michael, and never answers a question that changed', async (t) => {
  const o = await serve(office('answer'));
  t.after(() => o.server.close());
  const phone = await pairedPhone(o, 'iPhone');

  const stale = await phone.call('answer', { task_id: 't-new', q: 'first?', text: 'no' });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'question_changed');

  const r = await phone.call('answer', { task_id: 't-new', q: '**new?**', text: 'sí, dale' });
  assert.equal(r.ok, true);
  const doc = readTasks(o);
  assert.equal(doc.extra, 'kept', 'the rest of tasks.json survives');
  const qa = doc.tasks.find((x) => x.id === 't-new').humanQA;
  assert.equal(qa[0].a, 'yes', 'history untouched');
  assert.equal(qa[1].a, 'sí, dale');
  assert.ok(qa[1].answeredAt);
  const [msg] = inbox(o);
  assert.equal(msg.from, 'human');
  assert.equal(msg.act, 'inform');
  assert.match(msg.subject, /^HUMAN ANSWER on task "Newer ask"/);
  assert.match(msg.body, /Q: \*\*new\?\*\*\nA: sí, dale/);

  const twice = await phone.call('answer', { task_id: 't-new', q: '**new?**', text: 'otra vez' });
  assert.equal(twice.code, 'question_changed');
  const missing = await phone.call('answer', { task_id: 'nope', q: 'x', text: 'y' });
  assert.equal(missing.code, 'no_task');
});

test('ask: a message for Michael from the human', async (t) => {
  const o = await serve(office('ask'));
  t.after(() => o.server.close());
  const phone = await pairedPhone(o, 'iPhone');
  assert.equal((await phone.call('ask', { text: '   ' })).code, 'bad_args');
  const r = await phone.call('ask', { text: 'Revisa el PR de Windows\ncuando puedas' });
  assert.equal(r.ok, true);
  const [msg] = inbox(o);
  assert.equal(msg.from, 'human');
  assert.equal(msg.act, 'request');
  assert.match(msg.subject, /Revisa el PR de Windows$/);
  assert.match(msg.body, /iPhone/);
});

test('the wire: replays, tampering, a wrong clock and unknown ops are refused', async (t) => {
  const o = await serve(office('wire'));
  t.after(() => o.server.close());
  const phone = await pairedPhone(o);

  const env = phone.envelope('hello');
  assert.equal((await phone.send(env)).ok, true);
  const replay = await phone.send(env);
  assert.equal(replay.http, 401);
  assert.equal(replay.code, 'replay');

  const tampered = phone.envelope('hello');
  const ct = Buffer.from(tampered.ct, 'base64url'); ct[0] ^= 1;
  const bad = await phone.send({ ...tampered, ct: ct.toString('base64url') });
  assert.equal(bad.http, 401);
  assert.equal(bad.code, 'bad_seal');

  const old = await phone.send(phone.envelope('hello', {}, Date.now() - 10 * 60_000));
  assert.equal(old.code, 'stale');

  assert.equal((await phone.call('delete_everything')).code, 'bad_op');

  // Someone else's key can't speak for this phone.
  const other = await pairedPhone(o, 'otro');
  const forged = C.sealRequest(other.key, phone.deviceId, phone.officeId, { ts: Date.now(), op: 'hello' });
  assert.equal((await post(o.base, '/remote/v1/call', forged)).body.code, 'bad_seal');
});

test('forgetting a phone locks it out on its next call', async (t) => {
  const o = await serve(office('forget'));
  t.after(() => o.server.close());
  const phone = await pairedPhone(o, 'iPhone viejo');
  assert.equal((await phone.call('hello')).ok, true);
  assert.equal(L.forgetRemote('viejo', o.dir).name, 'iPhone viejo');
  const r = await phone.call('hello');
  assert.equal(r.http, 401);
  assert.equal(r.code, 'unknown_device');
});

test('delegate: the phone hands work to a paired office through this one', async (t) => {
  const a = await serve(office('a'));
  const b = await serve(office('b'));
  t.after(() => { a.server.close(); b.server.close(); });
  const { peer, code } = await L.requestPair(b.base.replace('http://', ''), { dir: a.dir, port: 1 });
  L.trustPeer(peer, a.dir);
  L.acceptPending(code, b.dir);

  const phone = await pairedPhone(a);
  const peers = await phone.call('peers');
  assert.equal(peers.result.peers.length, 1);
  assert.equal(peers.result.peers[0].online, true);
  const r = await phone.call('delegate', { office: 'b', text: 'Corre las pruebas de Windows', title: 'Pruebas' });
  assert.equal(r.ok, true);
  assert.equal(r.result.office, 'michael-b');
  const onB = readTasks(b).tasks.find((x) => x.id === r.result.task_id);
  assert.equal(onB.title, 'Pruebas');
  assert.equal(onB.link.from_name, 'michael-a', 'B sees office A delegating, never the phone');
});

test('the app: served from /app with a strict CSP; nothing else in the folder leaks', async (t) => {
  const o = await serve(office('static'));
  t.after(() => o.server.close());
  const redirect = await fetch(`${o.base}/app`, { redirect: 'manual' });
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get('location'), '/app/');
  const page = await fetch(`${o.base}/app/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await page.text(), /remote-crypto\.js/);
  for (const f of Object.keys(R.STATIC)) assert.ok(fs.existsSync(path.join(R.APP_DIR, f)), `${f} ships`);
  for (const p of ['/app/%2e%2e%2flib-link.cjs', '/app/..%2flib-link.cjs', '/app/nope.js']) {
    assert.equal((await fetch(o.base + p)).status, 404, p);
  }
});

test('the app draws the cast with the same engine as the app: avatar-engine.js is served from avatar-engine.cjs and runs', async (t) => {
  const o = await serve(office('cast'));
  t.after(() => o.server.close());
  const r = await fetch(`${o.base}/app/avatar-engine.js`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
  const self = {};
  new Function('self', await r.text())(self);
  const A = self.MunderAvatar;
  const engine = require('./avatar-engine.cjs');
  assert.deepEqual(Object.keys(A.AVATAR_RECIPES), Object.keys(engine.AVATAR_RECIPES));
  assert.deepEqual(Buffer.from(A.composeAvatar(A.AVATAR_RECIPES.pam)), Buffer.from(engine.composeAvatar(engine.AVATAR_RECIPES.pam)), 'same pixels as the CLI and the app');
  const font = await fetch(`${o.base}/app/press-start-2p.woff2`);
  assert.equal(font.status, 200);
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  for (const p of ['/app/constructor', '/app/__proto__', '/app/avatar-engine.cjs']) assert.equal((await fetch(o.base + p)).status, 404, p);
});
