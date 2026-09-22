'use strict';

/**
 * M0 — local control channel (`src/main/controlChannel.ts`).
 *
 * The `munder` CLI needs a way to reach the LIVE app that is not a window
 * and not a PTY: a loopback-only HTTP server with a per-boot token, mirroring
 * the Slack reply endpoint (same shape: start/stop semantics, 0600 token
 * file, 401 without token). M0 serves health only (`GET /salud`); session
 * routes arrive in M1/M2 on this same server and auth.
 *
 * Real HTTP round-trips against an ephemeral 127.0.0.1 port — no Electron,
 * no GUI, no fixture app needed (the module is electron-free on purpose).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { ControlChannel, validateAgentSpec, uniqueAgentId, buildChannelSpawnOpts, buildSessionView } = loadTs('src/main/controlChannel.ts');

async function start() {
  const ch = new ControlChannel({ token: 'test-token-123' });
  const r = await ch.start(0);
  assert.equal(r.ok, true, `start failed: ${r.error}`);
  assert.ok(typeof r.port === 'number' && r.port > 0, 'ephemeral port assigned');
  return { ch, port: r.port };
}

async function get(port, path, token) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: res.status, body: await res.json() };
}

test('health round-trip with the boot token', async () => {
  const { ch, port } = await start();
  try {
    const r = await get(port, '/salud', 'test-token-123');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, service: 'munder-control' });
  } finally {
    ch.stop();
  }
});

test('missing or wrong token is 401 (never 200, never a crash)', async () => {
  const { ch, port } = await start();
  try {
    for (const bad of [undefined, 'wrong', 'bearer test-token-123', '']) {
      const headers = bad === undefined ? {} : { authorization: bad };
      const res = await fetch(`http://127.0.0.1:${port}/salud`, { headers });
      assert.equal(res.status, 401, `token ${JSON.stringify(bad)} must be refused`);
      assert.equal((await res.json()).ok, false);
    }
  } finally {
    ch.stop();
  }
});

test('unknown routes and methods are 404', async () => {
  const { ch, port } = await start();
  try {
    const auth = { authorization: 'Bearer test-token-123' };
    for (const [method, path] of [['POST', '/salud'], ['GET', '/nope'], ['DELETE', '/sesion']]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: auth });
      assert.equal(res.status, 404, `${method} ${path} must be 404 in M0`);
    }
  } finally {
    ch.stop();
  }
});

test('double start is refused, double stop is safe', async () => {
  const ch = new ControlChannel({ token: 'x' });
  const first = await ch.start(0);
  assert.equal(first.ok, true);
  try {
    const second = await ch.start(0);
    assert.equal(second.ok, false);
    assert.match(second.error ?? '', /already running/);
  } finally {
    ch.stop();
    ch.stop(); // must not throw
  }
});

test('port() tracks lifecycle (null when stopped)', async () => {
  const ch = new ControlChannel({ token: 'x' });
  assert.equal(ch.port(), null);
  const r = await ch.start(0);
  assert.equal(ch.port(), r.port);
  ch.stop();
  assert.equal(ch.port(), null);
});

/* ─── M2: session routes (injectable spawner/killer) ─────────────────────── */

async function post(port, path, body, token = 'test-token-123') {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function del(port, path, token = 'test-token-123') {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'DELETE', headers });
  return { status: res.status, body: await res.json() };
}

test('validateAgentSpec mirrors the UI hire checks', () => {
  assert.deepEqual(validateAgentSpec({ name: 'jim', cwd: '/tmp', command: 'claude' }), { ok: true });
  assert.deepEqual(validateAgentSpec({ name: '  ', cwd: '/tmp', command: 'claude' }).ok, false);
  assert.deepEqual(validateAgentSpec({ name: 'jim', cwd: '', command: 'claude' }).ok, false);
  assert.deepEqual(validateAgentSpec({ name: 'jim', cwd: '/tmp', command: '  ' }).ok, false);
  assert.deepEqual(validateAgentSpec(null).ok, false);
  assert.deepEqual(validateAgentSpec({ name: 'jim', cwd: '/tmp', command: 'claude', capabilities: 'x' }).ok, false);
  assert.deepEqual(validateAgentSpec({ name: 'jim', cwd: '/tmp', command: 'claude', capabilities: ['a', 'b'] }).ok, true);
});

test('uniqueAgentId slugifies like the UI (pty- prefix added by builder)', () => {
  const id = uniqueAgentId('Jim Halpert');
  assert.match(id, /^jim-halpert-[0-9a-z]+$/);
  assert.match(uniqueAgentId('  '), /^agent-[0-9a-z]+$/);
});

test('POST /sesion/agentes spawns through the injected delegate', async () => {
  const seen = [];
  const ch = new ControlChannel({
    token: 'test-token-123',
    spawn: async (opts) => { seen.push(opts); return { ok: true, cwd: '/tmp/wt', worktreePath: '/tmp/wt' }; },
  });
  const { port } = await ch.start(0);
  try {
    const r = await post(port, '/sesion/agentes', {
      name: 'Pam Beesly', cwd: '/tmp', command: 'claude --model opus', provider: 'claude', role: 'reception',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.match(r.body.id, /^pam-beesly-[0-9a-z]+$/);
    assert.equal(r.body.ptyId, `pty-${r.body.id}`);
    assert.equal(seen.length, 1);
    const o = seen[0];
    assert.equal(o.id, r.body.ptyId);
    assert.equal(o.command, 'claude');
    assert.deepEqual(o.args, ['--model', 'opus']);
    assert.equal(o.hive.name, 'Pam Beesly');
    assert.equal(o.hive.role, 'reception');
    assert.equal(o.cols, 100);
  } finally {
    ch.stop();
  }
});

test('POST rejects invalid specs without touching the spawner', async () => {
  let calls = 0;
  const ch = new ControlChannel({
    token: 'test-token-123',
    spawn: async () => { calls++; return { ok: true }; },
  });
  const { port } = await ch.start(0);
  try {
    for (const bad of [
      {},
      { name: '', cwd: '/tmp', command: 'claude' },
      { name: 'jim', cwd: '/tmp', command: '' },
      { name: 'jim', command: 'claude' },
    ]) {
      const r = await post(port, '/sesion/agentes', bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal(r.body.ok, false);
    }
    const r2 = await post(port, '/sesion/agentes', 'no-json{{{', 'test-token-123');
    assert.equal(r2.status, 400);
    assert.equal(calls, 0, 'spawner never invoked on invalid input');
  } finally {
    ch.stop();
  }
});

test('POST surfaces spawner failure with the pty:spawn contract (200 + ok:false)', async () => {
  const ch = new ControlChannel({
    token: 'test-token-123',
    spawn: async () => ({ ok: false, error: 'cwd missing' }),
  });
  const { port } = await ch.start(0);
  try {
    const r = await post(port, '/sesion/agentes', { name: 'jim', cwd: '/nope', command: 'claude' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: false, error: 'cwd missing' });
  } finally {
    ch.stop();
  }
});

test('DELETE kills by id; unknown id is 404', async () => {
  const killed = [];
  const ch = new ControlChannel({
    token: 'test-token-123',
    kill: (id) => {
      if (id === 'jim-abc' || id === 'pty-jim-abc') { killed.push(id); return { ok: true }; }
      return { ok: false, error: `no pty: ${id}` };
    },
  });
  const { port } = await ch.start(0);
  try {
    const r = await del(port, '/sesion/agentes/jim-abc');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, id: 'jim-abc' });
    assert.deepEqual(killed, ['jim-abc']);
    const r2 = await del(port, '/sesion/agentes/nadie');
    assert.equal(r2.status, 404);
    assert.equal(r2.body.ok, false);
    const r3 = await del(port, '/sesion/agentes/%2F');
    assert.equal(r3.status, 400);
  } finally {
    ch.stop();
  }
});

test('session routes without delegates answer 501 (M0 builds stay valid)', async () => {
  const ch = new ControlChannel({ token: 'test-token-123' });
  const { port } = await ch.start(0);
  try {
    const r = await post(port, '/sesion/agentes', { name: 'jim', cwd: '/tmp', command: 'claude' });
    assert.equal(r.status, 501);
    const r2 = await del(port, '/sesion/agentes/jim');
    assert.equal(r2.status, 501);
  } finally {
    ch.stop();
  }
});

/* ─── M3: repaint broadcast ──────────────────────────────────────────────── */

test('POST /repaint broadcasts and reports windows reached', async () => {
  let calls = 0;
  const ch = new ControlChannel({ token: 'test-token-123', repaint: () => { calls++; return 3; } });
  const { port } = await ch.start(0);
  try {
    const r = await post(port, '/repaint', {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, windows: 3 });
    assert.equal(calls, 1);
  } finally {
    ch.stop();
  }
});

test('POST /repaint without auth is 401 and never broadcasts', async () => {
  let calls = 0;
  const ch = new ControlChannel({ token: 'test-token-123', repaint: () => { calls++; return 1; } });
  const { port } = await ch.start(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/repaint`, { method: 'POST' });
    assert.equal(res.status, 401);
    assert.equal(calls, 0);
  } finally {
    ch.stop();
  }
});

test('POST /repaint without delegate is 501', async () => {
  const ch = new ControlChannel({ token: 'test-token-123' });
  const { port } = await ch.start(0);
  try {
    const r = await post(port, '/repaint', {});
    assert.equal(r.status, 501);
  } finally {
    ch.stop();
  }
});

/* ─── M1: session read ───────────────────────────────────────────────────── */

test('buildSessionView joins registry identity with PTY liveness', () => {
  const view = buildSessionView(
    [{ id: 'pty-jim-1', cwd: '/tmp', command: 'claude', pid: 111 }],
    {
      'jim-1': { id: 'jim-1', name: 'Jim', provider: 'claude', role: 'ventas', cwd: '/tmp' },
      'pam-1': { id: 'pam-1', name: 'Pam', provider: 'codex', cwd: '/tmp' },
    }
  );
  assert.deepEqual(view, [
    { id: 'jim-1', name: 'Jim', provider: 'claude', role: 'ventas', cwd: '/tmp', live: true, pid: 111 },
    { id: 'pam-1', name: 'Pam', provider: 'codex', role: undefined, cwd: '/tmp', live: false, pid: undefined },
  ]);
});

test('buildSessionView surfaces orphan PTYs as live unknowns (never drops)', () => {
  const view = buildSessionView(
    [{ id: 'pty-huerfano', cwd: '/tmp', command: 'bash', pid: 222 }],
    {}
  );
  assert.deepEqual(view, [
    { id: 'pty-huerfano', name: 'pty-huerfano', provider: undefined, role: undefined, cwd: '/tmp', live: true, pid: 222 },
  ]);
  assert.deepEqual(buildSessionView([], {}), []);
});

test('GET /sesion returns the reader snapshot with count', async () => {
  const ch = new ControlChannel({
    token: 'test-token-123',
    read: () => ({ agents: [{ id: 'jim-1', name: 'Jim', live: true, pid: 111 }] }),
  });
  const { port } = await ch.start(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/sesion`, {
      headers: { authorization: 'Bearer test-token-123' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      agents: [{ id: 'jim-1', name: 'Jim', live: true, pid: 111 }],
      count: 1,
    });
  } finally {
    ch.stop();
  }
});

test('GET /sesion without reader is 501, without auth is 401', async () => {
  const ch = new ControlChannel({ token: 'test-token-123' });
  const { port } = await ch.start(0);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/sesion`, {
      headers: { authorization: 'Bearer test-token-123' },
    });
    assert.equal(r.status, 501);
    const r2 = await fetch(`http://127.0.0.1:${port}/sesion`);
    assert.equal(r2.status, 401);
  } finally {
    ch.stop();
  }
});
