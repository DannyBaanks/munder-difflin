'use strict';
// node --test tools/munder/panel.test.cjs
//
// Munder Panel: the button page for people who never open a terminal. What
// matters: only this machine can drive it (127.0.0.1, its own Host, a token),
// the page can only press buttons that exist, and the buttons do the same
// thing the CLI does (same pid files, same pending requests).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-test-'));
process.env.MUNDER_LINK_DIR = path.join(root, 'link');
process.env.MUNDER_PANEL_DIR = path.join(root, 'panel');
process.env.MUNDER_USER_DATA = path.join(root, 'userdata');
process.env.MUNDER_REVIVER_DIR = path.join(root, 'reviver');
process.env.MUNDER_GPT_DIR = path.join(root, 'gpt');
fs.mkdirSync(process.env.MUNDER_USER_DATA, { recursive: true });

const P = require('./lib-panel.cjs');
const L = require('./lib-link.cjs');

async function serve(opts = {}) {
  const calls = [];
  const actions = {
    'test.echo': async (args) => { calls.push(args); return { ok: true, text: `eco ${args.x}` }; },
    'test.boom': async () => { throw Object.assign(new Error('nope'), { status: 400 }); },
  };
  const s = P.createPanelServer({ actions, getState: async () => ({ hello: 'world' }), ...opts });
  await new Promise((r) => s.server.listen(0, '127.0.0.1', r));
  const port = s.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return { ...s, port, base, calls, close: () => new Promise((r) => s.server.close(r)) };
}

test('the page and its assets load without a token; the API does not', async () => {
  const s = await serve();
  try {
    const page = await fetch(`${s.base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /MUNDER PANEL/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal((await fetch(`${s.base}/panel.js`)).status, 200);
    assert.equal((await fetch(`${s.base}/api/state`)).status, 401);
    assert.equal((await fetch(`${s.base}/api/state`, { headers: { 'x-munder-panel': 'x'.repeat(48) } })).status, 401);
    const ok = await fetch(`${s.base}/api/state`, { headers: { 'x-munder-panel': s.token } });
    assert.deepEqual(await ok.json(), { hello: 'world' });
    assert.match(s.url(), new RegExp(`^http://127\\.0\\.0\\.1:${s.port}/#t=${s.token}$`), 'the token travels in the fragment only');
  } finally { await s.close(); }
});

test('another Host (DNS rebinding) is refused even with the token', async () => {
  const s = await serve();
  try {
    const http = require('node:http');
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.port, path: '/api/state', headers: { host: `evil.example:${s.port}`, 'x-munder-panel': s.token } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 421);
  } finally { await s.close(); }
});

test('only buttons that exist can be pressed; errors come back as text', async () => {
  const s = await serve();
  const post = (body) => fetch(`${s.base}/api/action`, { method: 'POST', headers: { 'x-munder-panel': s.token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const r = await (await post({ action: 'test.echo', args: { x: 7 } })).json();
    assert.deepEqual(r, { ok: true, text: 'eco 7' });
    assert.deepEqual(s.calls, [{ x: 7 }]);
    for (const action of ['rm -rf /', '__proto__', 'constructor', 'toString']) {
      const res = await post({ action });
      assert.equal(res.status, 400, action);
    }
    const boom = await post({ action: 'test.boom' });
    assert.equal(boom.status, 400);
    assert.deepEqual(await boom.json(), { ok: false, text: 'nope' });
    const big = await fetch(`${s.base}/api/action`, { method: 'POST', headers: { 'x-munder-panel': s.token }, body: 'x'.repeat(10_000) });
    assert.equal(big.status, 413);
  } finally { await s.close(); }
});

test('it closes itself once the page stops asking', async () => {
  let idle = false;
  const s = await serve({ idleMs: 150, onIdle: () => { idle = true; } });
  try {
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(idle, true);
  } finally { await s.close(); }
});

test('the real buttons are a closed list, and codes are 6 digits', async () => {
  assert.deepEqual(Object.keys(P.ACTIONS).sort(), [
    'app.close', 'app.open', 'app.restart', 'gpt.approve', 'gpt.deny', 'gpt.off', 'gpt.on',
    'link.accept', 'link.forgetPhone', 'link.off', 'link.on', 'link.phoneAuthority',
    'reviver.disable', 'reviver.enable', 'shortcut.install',
  ]);
  for (const bad of [undefined, '12345', '1234567', '12a456', '123 456']) {
    await assert.rejects(P.ACTIONS['link.accept']({ code: bad }), /6 números/);
    await assert.rejects(P.ACTIONS['gpt.approve']({ code: bad }), /6 números/);
  }
});

test('Munder closed reads as closed, not as an error', async () => {
  assert.deepEqual(await P.appStatus(), { running: false });
  fs.writeFileSync(path.join(process.env.MUNDER_USER_DATA, 'munder-control.json'), JSON.stringify({ port: 1, token: 'x' }));
  assert.deepEqual(await P.appStatus({ timeoutMs: 500 }), { running: false });
});

test('Munder running is read from its own /salud, with its token', async () => {
  const http = require('node:http');
  const srv = http.createServer((req, res) => {
    const ok = req.headers.authorization === 'Bearer tok' && req.url === '/salud';
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { ok: true, instance: { pid: 4242, version: '9.9.9' } } : { ok: false }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    fs.writeFileSync(path.join(process.env.MUNDER_USER_DATA, 'munder-control.json'), JSON.stringify({ port: srv.address().port, token: 'tok' }));
    assert.deepEqual(await P.appStatus(), { running: true, pid: 4242, version: '9.9.9' });
  } finally { await new Promise((r) => srv.close(r)); }
});

test('Link buttons share the CLI state: accept a phone, see it, forget it', async () => {
  const st0 = await P.linkState();
  assert.equal(st0.on, false);
  assert.deepEqual(st0.pending, []);
  // A phone asked to pair (what /remote/v1/pair leaves behind).
  const pending = L.loadPending();
  pending['dev-1'] = { office_id: 'dev-1', device_id: 'dev-1', name: 'iPhone de prueba', kind: 'remote', code: '123456', addresses: [], expires_at: Date.now() + 60_000 };
  fs.writeFileSync(L.files().pending, JSON.stringify(pending));
  const st1 = await P.linkState();
  assert.deepEqual(st1.pending.map((q) => [q.name, q.kind, q.code]), [['iPhone de prueba', 'celular', '123456']]);
  await assert.rejects(P.ACTIONS['link.accept']({ code: '999999' }), /no coincide/);
  const acc = await P.ACTIONS['link.accept']({ code: '123456' });
  assert.equal(acc.ok, true);
  assert.match(acc.text, /iPhone de prueba/);
  const st2 = await P.linkState();
  assert.deepEqual(st2.pending, []);
  assert.deepEqual(st2.phones.map((p) => [p.id, p.name]), [['dev-1', 'iPhone de prueba']]);
  const gone = await P.ACTIONS['link.forgetPhone']({ id: 'dev-1' });
  assert.match(gone.text, /olvidado/);
  assert.deepEqual((await P.linkState()).phones, []);
  await assert.rejects(P.ACTIONS['link.forgetPhone']({ id: 'dev-1' }), /ya no estaba/);
});

test('the menu entry opens the panel, with paths quoted', () => {
  const d = P.desktopEntry({ cmd: '/opt/Munder Difflin/munder-difflin', args: ['--panel'] });
  assert.match(d, /^Exec="\/opt\/Munder Difflin\/munder-difflin" --panel$/m);
  assert.match(d, /^Name=Munder Panel$/m);
  process.env.APPIMAGE = '/home/x/Munder.AppImage';
  try { assert.deepEqual(P.panelCommand(), { cmd: '/home/x/Munder.AppImage', args: ['--panel'] }); } finally { delete process.env.APPIMAGE; }
});

test('scripts run as node inside the packaged (Electron) panel', () => {
  const env = P.nodeEnv({ A: '1' });
  assert.equal(env.A, '1');
  assert.equal(env.ELECTRON_RUN_AS_NODE, process.versions.electron ? '1' : process.env.ELECTRON_RUN_AS_NODE);
});

test('the packaged app ships every panel file it loads', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', '..', 'electron-builder.yml'), 'utf8');
  for (const f of ['lib-panel.cjs', 'panel.cjs', 'panel-app', 'lib-link.cjs', 'link-serve.cjs', 'gpt.cjs', 'reviver.cjs', 'lib-reviver.cjs', 'remote-app']) {
    assert.match(yml, new RegExp(`from: tools/munder/${f.replace('.', '\\.')}\\n`), f);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  assert.equal(pkg.main, 'out/main/boot.js', 'boot decides between the office and --panel');
  const boot = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'boot.ts'), 'utf8');
  assert.match(boot, /process\.argv\.includes\('--panel'\)/);
  assert.match(boot, /join\(__dirname, 'index\.js'\)/);
});

test('munder panel is reachable from the CLI help', () => {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'munder'), 'help'], { encoding: 'utf8' });
  assert.match(r.stdout, /panel +Munder Panel/);
});
