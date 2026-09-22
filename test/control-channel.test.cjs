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

const { ControlChannel } = loadTs('src/main/controlChannel.ts');

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
