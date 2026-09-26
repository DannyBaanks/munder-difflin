'use strict';
// node --test tools/munder/panel-remote.test.cjs
//
// The phone as a frontend of the Panel stratum: the same buttons the desktop
// panel has, over the same `munder-remote@1` seal, with the authority each op
// needs. The pairing code grants the office; the machine needs a separate,
// deliberate grant, because these are the buttons that take the host down.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('./lib-link.cjs');
const R = require('./lib-remote.cjs');
const C = require('./remote-app/remote-crypto.js');

// These buttons talk to the HOST: link.on/off signal a real process, app.open
// spawns one, gpt.* runs a script. Running them against the developer's real
// state dir killed the live link daemon once already, so the test pins both
// state dirs to its own temp tree before anything is required. This is the
// only reason these env vars exist.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'panelremote-home-'));
process.env.MUNDER_LINK_DIR = path.join(SANDBOX, 'link');
process.env.MUNDER_USER_DATA = path.join(SANDBOX, 'userdata');
process.env.XDG_STATE_HOME = path.join(SANDBOX, 'state');
fs.mkdirSync(process.env.MUNDER_LINK_DIR, { recursive: true });

function office(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `panelremote-${name}-`));
  const dir = path.join(root, 'state');
  const hiveRoot = path.join(root, 'hive');
  fs.mkdirSync(hiveRoot, { recursive: true });
  fs.writeFileSync(path.join(hiveRoot, 'registry.json'), JSON.stringify({ godId: 'god', agents: { god: { name: 'Michael', status: 'working' } } }));
  fs.writeFileSync(path.join(hiveRoot, 'tasks.json'), JSON.stringify({ tasks: [] }));
  // One dir for the whole test office. The link server is handed `dir`
  // explicitly, but lib-panel resolves the DEFAULT dir, and two different ones
  // is how a test ends up asserting against a file nobody wrote.
  process.env.MUNDER_LINK_DIR = dir;
  return { dir, hive: hiveRoot, identity: L.loadIdentity(dir, `michael-${name}`) };
}

async function serve(o) {
  const { server } = L.createLinkServer({ dir: o.dir, hiveRoot: o.hive, version: 'test' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  o.server = server;
  o.base = `http://127.0.0.1:${server.address().port}`;
  return o;
}
const post = async (base, route, body) => {
  const r = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

/** The phone, through the same four steps the browser app takes. */
async function pairedPhone(o, name = 'iPhone') {
  const kp = C.x25519Keypair();
  const pub = C.b64u(kp.pub);
  const nonce = C.random(16);
  const r1 = await post(o.base, '/remote/v1/pair', { name, pub, commit: C.b64u(C.sha256(nonce)) });
  const r2 = await post(o.base, '/remote/v1/reveal', { device_id: C.deviceIdOf(kp.pub), nonce: C.b64u(nonce) });
  assert.equal(r2.status, 200);
  assert.ok(L.acceptPending(L.loadPending(o.dir)[C.deviceIdOf(kp.pub)].code, o.dir));
  return {
    deviceId: C.deviceIdOf(kp.pub),
    call: async (op, args = {}) => {
      const env = C.sealRequest(C.sessionKey(kp.priv, r1.body.box_pub, r1.body.office_id, C.deviceIdOf(kp.pub)), C.deviceIdOf(kp.pub), r1.body.office_id, { ts: Date.now(), op, args });
      const r = await post(o.base, '/remote/v1/call', env);
      if (r.status !== 200) return { http: r.status, ...r.body };
      return C.openResponse(C.sessionKey(kp.priv, r1.body.box_pub, r1.body.office_id, C.deviceIdOf(kp.pub)), C.deviceIdOf(kp.pub), r1.body.office_id, r.body);
    },
  };
}

test('the pairing code alone does not open the machine stratum', async (t) => {
  const o = await serve(office('pair'));
  t.after(() => o.server.close());
  const phone = await pairedPhone(o);

  const office1 = await phone.call('overview');
  assert.equal(office1.ok, true, 'the office is reachable with just the pairing code');

  for (const op of ['panel.state', 'panel.action']) {
    const r = await phone.call(op, op === 'panel.action' ? { action: 'link.on' } : {});
    assert.equal(r.ok, false, `${op} must be refused`);
    assert.equal(r.code, 'no_authority');
    assert.equal(typeof r.result, 'undefined', 'the answer carries no result at all');
  }
});

test('munder link panel grants the machine stratum, and --quitar takes it back', async (t) => {
  const o = await serve(office('grant'));
  t.after(() => o.server.close());
  const phone = await pairedPhone(o);

  assert.equal(L.remoteAuthority(L.loadRemotes(o.dir)[phone.deviceId]), 'office', 'the default grants nothing new');

  const up = L.setRemoteAuthority(phone.deviceId.slice(0, 6), L.REMOTE_AUTHORITY.MACHINE, o.dir);
  assert.ok(up, 'a fragment of the id identifies the phone, like olvidar does');
  assert.equal(up.authority, 'machine');

  const st = await phone.call('panel.state');
  assert.equal(st.ok, true, 'now the panel state comes back');
  assert.equal(typeof st.result.app, 'object');
  assert.equal(st.result.platform, process.platform);
  assert.ok(Array.isArray(st.result.link.phones));
  assert.equal(st.result.link.phones[0].authority, 'machine', 'the panel says which phone is elevated');

  const back = L.setRemoteAuthority(phone.deviceId, L.REMOTE_AUTHORITY.OFFICE, o.dir);
  assert.equal(back.authority, 'office', 'revoking leaves no stale field behind');
  assert.equal('authority' in L.loadRemotes(o.dir)[phone.deviceId], false);
  assert.equal((await phone.call('panel.state')).code, 'no_authority');
});

test('panel.action runs the SAME engine the desktop button runs, with its own text', async (t) => {
  const o = await serve(office('action'));
  t.after(() => o.server.close());
  const phone = await pairedPhone(o);
  L.setRemoteAuthority(phone.deviceId, L.REMOTE_AUTHORITY.MACHINE, o.dir);

  const off = await phone.call('panel.action', { action: 'link.off' });
  assert.equal(off.ok, true);
  assert.equal(off.result.ok, true);
  assert.equal(off.result.text, 'El enlace ya estaba apagado.', 'the sandbox has no link running');

  const bad = await phone.call('panel.action', { action: 'link.accept', args: { code: 'nope' } });
  assert.equal(bad.ok, false, 'the panel’s own validation is not bypassed by going through the seal');
  assert.equal(bad.code, 'bad_args');
  assert.match(bad.error, /6 números/);

  const missing = await phone.call('panel.action', { action: 'link.nope' });
  assert.equal(missing.code, 'bad_args');
  assert.match(missing.error, /no existe/);
});

test('the ops a phone must not reach, and why, are refused by name', async (t) => {
  const o = await serve(office('deny'));
  t.after(() => o.server.close());
  const phone = await pairedPhone(o);
  L.setRemoteAuthority(phone.deviceId, L.REMOTE_AUTHORITY.MACHINE, o.dir);

  for (const action of R.PANEL_OFF) {
    const r = await phone.call('panel.action', { action });
    assert.equal(r.ok, false, `${action} must not be reachable from a phone`);
    assert.equal(r.code, 'not_remote');
  }
  // The one that matters: a phone cannot widen its own authority.
  assert.ok(R.PANEL_OFF.includes('link.phoneAuthority'));

  // And the phone's action set is exactly the desktop set minus those two.
  const desktop = Object.keys(require('./lib-panel.cjs').ACTIONS);
  assert.deepEqual(R.opCatalog().find((o) => o.op === 'panel.action').actions, desktop.filter((a) => !R.PANEL_OFF.includes(a)));
});

test('an op nobody declared is treated as machine, not as free', async (t) => {
  const o = await serve(office('undeclared'));
  t.after(() => o.server.close());
  const phone = await pairedPhone(o);
  assert.equal(Object.prototype.hasOwnProperty.call(R.OP_AUTHORITY, 'panel.ejecutar'), false, 'not declared');

  // Not elevated: the gate must cut it, so an undeclared op is not a way to probe the surface.
  assert.equal((await phone.call('panel.ejecutar', { cmd: 'rm -rf /' })).code, 'no_authority');

  // Elevated: now it reaches the dispatch, which refuses it as unknown. Either
  // way it never runs, and the two answers differ only in what they reveal.
  L.setRemoteAuthority(phone.deviceId, L.REMOTE_AUTHORITY.MACHINE, o.dir);
  const r = await phone.call('panel.ejecutar', { cmd: 'rm -rf /' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_op');
});

test('argument ceilings are declared and enforced on the phone path', async (t) => {
  const o = await serve(office('args'));
  t.after(() => o.server.close());
  const phone = await pairedPhone(o);
  L.setRemoteAuthority(phone.deviceId, L.REMOTE_AUTHORITY.MACHINE, o.dir);

  const long = await phone.call('panel.action', { action: 'link.accept', args: { code: '1'.repeat(7) } });
  assert.equal(long.code, 'bad_args');
  const nonText = await phone.call('panel.action', { action: 'link.forgetPhone', args: { id: { evil: true } } });
  assert.equal(nonText.code, 'bad_args');
  assert.match(nonText.error, /debe ser texto/);

  // Every declared ceiling is a number a test can hold, and every one of them
  // is a ceiling the desktop panel has too — the two paths do not drift apart.
  for (const [k, v] of Object.entries(R.ARG_MAX)) assert.equal(typeof v, 'number', `${k} has no ceiling`);
});

test('panel.state stays small: measured headroom, not an assumption', async (t) => {
  const o = await serve(office('size'));
  t.after(() => o.server.close());
  const phone = await pairedPhone(o);
  L.setRemoteAuthority(phone.deviceId, L.REMOTE_AUTHORITY.MACHINE, o.dir);

  const st = await phone.call('panel.state');
  const text = Buffer.byteLength(JSON.stringify(st.result));
  const sealed = Buffer.byteLength(JSON.stringify(st));
  assert.ok(text < 8 * 1024, `panel.state is ${text}B; a single op should never need paging`);
  assert.ok(sealed < 0.05 * 256 * 1024, `${sealed}B is more than 5% of the body ceiling`);
  t.diagnostic(`panel.state = ${text}B de texto, ${sealed}B sellado, ${((sealed / (256 * 1024)) * 100).toFixed(2)}% del techo`);
});
