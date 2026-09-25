'use strict';

/**
 * Office Packs through the control channel (`munder sesion packs` /
 * `munder sesion armar --pack`). Real HTTP against 127.0.0.1, the REAL bundled
 * packs from resources/packs, and a recording spawn delegate: what is proven is
 * that each chosen agent goes through the same spawn door as a manual hire,
 * gets its job brief from god, and that a pack from a file is capped at "ask".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { ControlChannel, planPackSession } = loadTs('src/main/controlChannel.ts');
const { loadBundledPacks, loadImportedPack } = loadTs('src/main/packs.ts');

const packsDir = () => path.resolve(__dirname, '..', 'resources', 'packs');
const bundled = () => ({ packs: loadBundledPacks({ packsDir }).packs.map((l) => l.pack) });
const importPack = (raw) => loadImportedPack(raw, loadBundledPacks({ packsDir }).core);
const TOKEN = 'pack-token';

async function channel(t, spawnResult = () => ({ ok: true })) {
  const spawned = []; const briefs = [];
  const ch = new ControlChannel({
    token: TOKEN,
    spawn: (opts) => { spawned.push(opts); return spawnResult(opts); },
    packs: bundled, importPack,
    brief: (id, subject, body) => briefs.push({ id, subject, body })
  });
  const r = await ch.start(0);
  t.after(() => ch.stop());
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${r.port}${p}`, {
      method, headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: res.status, body: await res.json() };
  };
  return { call, spawned, briefs, port: r.port };
}

test('GET /packs lists every bundled business pack with core merged in', async (t) => {
  const { call } = await channel(t);
  const r = await call('GET', '/packs');
  assert.equal(r.status, 200);
  const ids = r.body.packs.map((p) => p.id).sort();
  assert.deepEqual(ids, ['home-services', 'pro-services', 'restaurant-food', 'retail-shop', 'saas-consulting']);
  const rest = r.body.packs.find((p) => p.id === 'restaurant-food');
  assert.ok(rest.agents.some((a) => a.id === 'oscar' && a.default), 'core finance agent is in every pack');
});

test('pack routes need the token', async (t) => {
  const { port } = await channel(t);
  assert.equal((await fetch(`http://127.0.0.1:${port}/packs`)).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${port}/sesion/pack`, { method: 'POST', body: '{}' })).status, 401);
});

test('armar --pack spawns the default team through the normal door and briefs each one', async (t) => {
  const { call, spawned, briefs } = await channel(t);
  const r = await call('POST', '/sesion/pack', { pack: 'restaurant-food', cwd: '/tmp/cafe', command: 'claude --model opus' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.imported, false);
  const expected = bundled().packs.find((p) => p.businessType === 'restaurant-food').defaultPicks.length;
  assert.equal(spawned.length, expected);
  const oscar = spawned.find((o) => o.hive.name === 'Oscar');
  assert.equal(oscar.command, 'claude');
  assert.deepEqual(oscar.args, ['--model', 'opus']);
  assert.equal(oscar.cwd, '/tmp/cafe');
  assert.equal(oscar.hive.role, 'Finance');
  assert.equal(briefs.length, expected);
  const b = briefs.find((x) => x.id === oscar.hive.id);
  assert.match(b.body, /You are the Finance on this team/);
  assert.match(b.body, /Ask the human before using: books\.write/);
});

test('--solo picks exactly those agents; an unknown id is refused before spawning anything', async (t) => {
  const { call, spawned } = await channel(t);
  const r = await call('POST', '/sesion/pack', { pack: 'restaurant-food', cwd: '/tmp/cafe', command: 'claude', picks: ['oscar'] });
  assert.equal(r.status, 200);
  assert.deepEqual(spawned.map((o) => o.hive.name), ['Oscar']);
  const bad = await call('POST', '/sesion/pack', { pack: 'restaurant-food', cwd: '/tmp/cafe', command: 'claude', picks: ['oscar', 'nadie'] });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /nadie/);
  assert.equal(spawned.length, 1);
});

test('a pack from a file is imported: every outward capability is capped at ask', async (t) => {
  const { call, briefs } = await channel(t);
  const raw = JSON.parse(fs.readFileSync(path.join(packsDir(), 'restaurant-food.json'), 'utf8'));
  // A "free pack" that grants itself unattended posting.
  const ryan = raw.agents.find((a) => a.id === 'ryan') || raw.agents[0];
  ryan.tools = [...ryan.tools.filter((x) => x.capability !== 'social.post'), { capability: 'social.post', level: 'auto' }];
  const r = await call('POST', '/sesion/pack', { packJson: raw, cwd: '/tmp/cafe', command: 'claude', picks: [ryan.id] });
  assert.equal(r.status, 200);
  assert.equal(r.body.imported, true);
  assert.match(briefs[0].body, /Ask the human before using: [^\n]*social\.post/);
  assert.match(briefs[0].body, /came from outside the app/);
});

test('one failed spawn is reported by name and the rest still start', async (t) => {
  const { call, spawned } = await channel(t, (o) => (o.hive.name === 'Pam' ? { ok: false, error: 'CLI missing' } : { ok: true }));
  const r = await call('POST', '/sesion/pack', { pack: 'restaurant-food', cwd: '/tmp/cafe', command: 'claude', picks: ['oscar', 'pam'] });
  assert.equal(r.body.ok, false);
  assert.deepEqual(r.body.agents.map((a) => [a.name, a.ok]), [['Oscar', true], ['Pam', false]]);
  assert.equal(spawned.length, 2);
});

test('planPackSession validates before anything spawns', () => {
  const deps = { packs: bundled, importPack };
  assert.match(planPackSession({ pack: 'x', command: 'claude' }, deps).error, /cwd/);
  assert.match(planPackSession({ pack: 'x', cwd: '/a' }, deps).error, /comando/);
  assert.match(planPackSession({ pack: 'no-existe', cwd: '/a', command: 'c' }, deps).error, /no existe/);
  assert.match(planPackSession({ packJson: { spec: 'nope' }, cwd: '/a', command: 'c' }, deps).error, /pack inválido/);
});
