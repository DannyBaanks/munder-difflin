'use strict';

/**
 * Settings → Munder Link (src/main/linkPanel.ts) against the REAL lib-link.cjs:
 * real identities in temp state dirs, a real paired office served over HTTP,
 * and a real detached server started the way the tab starts it. What matters:
 * the app and the CLI share one identity/peers/pid file; pairing needs the human
 * to confirm the code, and the renderer can only confirm a token main issued.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const L = require('../tools/munder/lib-link.cjs');
const { LinkPanel } = loadTs('src/main/linkPanel.ts');

function office(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `link-panel-${name}-`));
  const hive = path.join(root, 'hive');
  fs.mkdirSync(hive, { recursive: true });
  fs.writeFileSync(path.join(hive, 'registry.json'), JSON.stringify({ godId: 'god', agents: { god: { status: 'working' }, w1: { status: 'idle' } } }));
  const dir = path.join(root, 'state');
  return { root, dir, hive, identity: L.loadIdentity(dir, `michael-${name}`) };
}
async function serve(o) {
  const { server } = L.createLinkServer({ dir: o.dir, hiveRoot: o.hive, version: 'test' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  o.server = server;
  o.address = `127.0.0.1:${server.address().port}`;
  return o;
}

// The panel calls lib-link with no dir, exactly like the app: point it at A.
const a = office('victus');
process.env.MUNDER_LINK_DIR = a.dir;
process.env.MUNDER_LINK_HIVE = a.hive;
const noSpawn = () => { throw new Error('should not spawn'); };

test('status shows this office, the link off, and no peers yet', async () => {
  const panel = new LinkPanel(L, noSpawn);
  const st = await panel.status();
  assert.equal(st.self.name, 'michael-victus');
  assert.equal(st.self.office_id, a.identity.office_id);
  assert.equal(st.daemon.running, false);
  assert.equal(st.hive, a.hive);
  assert.ok(st.host.cpus > 0);
  assert.deepEqual(st.peers, []);
});

test('pairing: request shows the same code the other office holds; confirm trusts; the peer then shows live', async (t) => {
  const b = await serve(office('xeon'));
  t.after(() => b.server.close());
  const panel = new LinkPanel(L, noSpawn);
  const req = await panel.pairRequest(b.address);
  assert.equal(req.name, 'michael-xeon');
  assert.equal(Object.values(L.loadPending(b.dir))[0].code, req.code, 'both screens show one code');
  assert.equal(req.token.length, 32);
  assert.equal(JSON.stringify(req).includes(b.identity.box.x), false, 'no key material reaches the renderer');

  const trusted = panel.pairConfirm(req.token);
  assert.equal(trusted.office_id, b.identity.office_id);
  assert.throws(() => panel.pairConfirm(req.token), /ya no existe/, 'a token works once');

  let st = await panel.status();
  assert.equal(st.peers[0].online, false);
  assert.equal(st.peers[0].waiting, true, 'until the other side accepts');

  L.acceptPending(req.code, b.dir);
  st = await panel.status();
  assert.equal(st.peers[0].online, true);
  assert.equal(st.peers[0].capacity.michael_state, 'working');
  assert.equal(st.peers[0].capacity.workers_total, 1);

  assert.equal(panel.forget(b.identity.office_id).name, 'michael-xeon');
  assert.deepEqual((await panel.status()).peers, []);
  assert.throws(() => panel.forget(b.identity.office_id), /no está enlazada/);
});

test('a token the panel never issued confirms nothing', () => {
  const panel = new LinkPanel(L, noSpawn);
  assert.throws(() => panel.pairConfirm('0'.repeat(32)), /ya no existe/);
  assert.deepEqual(L.loadPeers(a.dir), {});
});

test('accepting an incoming request: only a pending 6-digit code', async (t) => {
  await serve(a);
  t.after(() => a.server.close());
  const c = office('laptop');
  const { code } = await L.requestPair(a.address, { dir: c.dir });
  const panel = new LinkPanel(L, noSpawn);
  const st = await panel.status();
  assert.equal(st.pending.length, 1);
  assert.equal(st.pending[0].name, 'michael-laptop');
  assert.throws(() => panel.accept('12345'), /6 dígitos/);
  assert.throws(() => panel.accept(code === '000000' ? '111111' : '000000'), /ninguna solicitud/);
  assert.equal(panel.accept(code.replace(/(\d{3})(\d{3})/, '$1 $2')).name, 'michael-laptop', 'spaces as shown on screen are fine');
  assert.ok(L.loadPeers(a.dir)[c.identity.office_id]);
  panel.forget(c.identity.office_id);
});

test('turning the link on/off shares the pid file with `munder link`', async (t) => {
  let spawned = 0;
  const panel = new LinkPanel(L, () => {
    spawned++;
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
    child.unref();
    return child.pid;
  });
  const on = panel.start();
  t.after(() => { try { process.kill(on.pid, 'SIGKILL'); } catch { /* gone */ } });
  assert.equal(on.already, false);
  assert.equal(fs.readFileSync(L.files(a.dir).pid, 'utf8'), String(on.pid), 'the same pid file the CLI reads');
  assert.equal(panel.start().already, true, 'idempotent');
  assert.equal(spawned, 1);
  assert.equal((await panel.status()).daemon.pid, on.pid);
  assert.equal(panel.stop().pid, on.pid);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fs.existsSync(L.files(a.dir).pid), false);
  assert.equal((await panel.status()).daemon.running, false);
});

test('link-serve.cjs is a working server, the one the tab starts', async (t) => {
  const o = office('served');
  const port = 40000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'munder', 'link-serve.cjs')], {
    env: { ...process.env, MUNDER_LINK_DIR: o.dir, MUNDER_LINK_HIVE: o.hive, MUNDER_LINK_PORT: String(port), MUNDER_LINK_DISCOVERY_PORT: String(port + 1) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('escuchando')) resolve(); });
    child.on('exit', (code) => reject(new Error(`exited ${code}`)));
    setTimeout(() => reject(new Error('timeout')), 5000);
  });
  const card = await L.hello(`127.0.0.1:${port}`);
  assert.equal(card.name, 'michael-served');
  // The same daemon serves the phone app (Munder Remote).
  const app = await fetch(`http://127.0.0.1:${port}/app/`);
  assert.equal(app.status, 200);
  assert.match(await app.text(), /Munder Remote/);
  child.kill('SIGTERM');
  const [code, signal] = await new Promise((r) => child.on('exit', (c, s) => r([c, s])));
  if (process.platform === 'win32') {
    // Windows has no catchable SIGTERM: kill() terminates the process outright,
    // which is also what `munder link apagar` does there.
    assert.equal(signal, 'SIGTERM');
  } else {
    assert.equal(code, 0, 'SIGTERM closes it cleanly');
  }
});

test('phones: a pending phone is marked, accepting it lists it apart from the peers, and forgetPhone revokes it', async (t) => {
  const o = await serve(office('phones'));
  t.after(() => o.server.close());
  const C = require('../tools/munder/remote-app/remote-crypto.js');
  const post = async (route, body) => (await fetch(`http://${o.address}${route}`, { method: 'POST', body: JSON.stringify(body) })).json();
  const kp = C.x25519Keypair();
  const nonce = C.random(16);
  const r1 = await post('/remote/v1/pair', { name: 'iPhone', pub: C.b64u(kp.pub), commit: C.b64u(C.sha256(nonce)) });
  await post('/remote/v1/reveal', { device_id: r1.device_id, nonce: C.b64u(nonce) });

  // The panel reads A's state dir; this office is another one, so point it there for this test.
  const prev = process.env.MUNDER_LINK_DIR;
  process.env.MUNDER_LINK_DIR = o.dir;
  t.after(() => { process.env.MUNDER_LINK_DIR = prev; });
  const panel = new LinkPanel(L, noSpawn);
  let st = await panel.status();
  assert.equal(st.pending.length, 1);
  assert.equal(st.pending[0].phone, true);
  assert.ok(Array.isArray(st.appUrls));
  const accepted = panel.accept(st.pending[0].code);
  assert.equal(accepted.name, 'iPhone');

  st = await panel.status();
  assert.deepEqual(st.peers, []);
  assert.equal(st.phones.length, 1);
  assert.equal(st.phones[0].device_id, r1.device_id);
  assert.throws(() => panel.forget(r1.device_id), /no está enlazada/, 'a phone is not forgotten as an office');
  assert.equal(panel.forgetPhone(r1.device_id).name, 'iPhone');
  assert.equal((await panel.status()).phones.length, 0);
  assert.throws(() => panel.forgetPhone(r1.device_id), /no está emparejado/);
});
