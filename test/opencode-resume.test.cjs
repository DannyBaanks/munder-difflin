'use strict';

// OpenCode/OpenISy agents used to open a NEW conversation every time Munder
// started: the bridge plugin never reported a session id, the preset had no
// resume flag, and each spawn rewrote the agent's opencode.json/tui.json with
// only a theme. Now:
//   - the plugin reports the agent's ROOT session id (never a subagent's child
//     session) on every hook payload, so hive.recordSession keeps it;
//   - opencode/openisy resume with `--session <id>` (verified on 1.18.32);
//   - the id is attached only if OpenCode's own store still has it (an unknown
//     id makes OpenCode exit 1 with "Session not found");
//   - the theme is merged into the agent's config, keeping everything else.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const loadTs = require('./load-ts.cjs');

const { HiveManager, mergeJsonFile } = loadTs('src/main/hive.ts');
const { opencodeSessionExists, opencodeDataDirs } = loadTs('src/main/opencodeSession.ts');
const ap = loadTs('src/shared/agentProvider.ts');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('opencode and openisy resume with --session', () => {
  assert.equal(ap.providerPreset('opencode').resumeFlag, '--session');
  assert.equal(ap.providerPreset('openisy').resumeFlag, '--session');
});

test('the bridge plugin reports the root session id, never a subagent child session', async (t) => {
  const home = tmp('md-oc-plugin-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  const injection = await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'opencode', cwd: home }, { theme: 'dark' });
  const pluginFile = path.join(injection.env.OPENCODE_CONFIG_DIR, 'plugins', 'hive-bridge.js');
  // The file OpenCode loads, run as the ESM it is.
  const mjs = path.join(home, 'hive-bridge.mjs');
  fs.copyFileSync(pluginFile, mjs);

  const sock = process.platform === 'win32' ? `\\\\.\\pipe\\md-oc-${process.pid}-${Date.now()}` : path.join(home, 'hive.sock');
  const got = [];
  const server = net.createServer((c) => {
    let b = '';
    c.on('data', (d) => { b += d; });
    c.on('end', () => { for (const l of b.split('\n').filter(Boolean)) got.push(JSON.parse(l)); });
  });
  await new Promise((r) => server.listen(sock, r));
  t.after(() => server.close());
  process.env.HIVE_SOCK = sock;
  process.env.AGENT_ID = 'jim';
  t.after(() => { delete process.env.HIVE_SOCK; delete process.env.AGENT_ID; });

  const mod = await import(pathToFileURL(mjs).href);
  const hooks = await mod.HiveBridge();
  const ev = (type, properties) => hooks.event({ event: { type, properties } });
  await ev('session.created', { info: { id: 'ses_rootAAAAAAAA', projectID: 'p', directory: home } });
  await ev('session.created', { info: { id: 'ses_childBBBBBBB', projectID: 'p', directory: home, parentID: 'ses_rootAAAAAAAA' } });
  await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'ses_rootAAAAAAAA', callID: 'c1' });
  await hooks['tool.execute.after']({ tool: 'task', sessionID: 'ses_childBBBBBBB', callID: 'c2' });
  await ev('session.idle', { sessionID: 'ses_childBBBBBBB' });
  await ev('session.idle', { sessionID: 'ses_rootAAAAAAAA' });

  const t0 = Date.now();
  while (got.length < 4 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
  const by = (name, sid) => got.find((g) => g.hook_event_name === name && g.session_id === sid);
  assert.ok(by('PreToolUse', 'ses_rootAAAAAAAA'), 'a root tool call carries the root session');
  assert.ok(by('Stop', 'ses_rootAAAAAAAA'), 'the root idle carries the root session');
  assert.ok(!got.some((g) => g.session_id === 'ses_childBBBBBBB'), 'a child session is never reported');
  assert.equal(got.filter((g) => g.hook_event_name === 'Stop').length, 2, 'the child idle still posts Stop, without a session id');
  assert.ok(got.every((g) => g.agent_id === 'jim'));
});

test('a recorded opencode session survives the restart path: recordSession → lastSession', async (t) => {
  const home = tmp('md-oc-record-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'opencode', cwd: home }, {});
  hive.recordSession('jim', 'ses_rootAAAAAAAA');
  assert.equal(new HiveManager(() => home).lastSession('jim'), 'ses_rootAAAAAAAA', 'read back by a fresh manager, as after an app restart');
});

test('session existence: found in opencode.db or in the old JSON storage; anything else is not found', (t) => {
  const data = tmp('md-oc-data-');
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const oc = path.join(data, 'opencode');
  fs.mkdirSync(oc, { recursive: true });
  fs.writeFileSync(path.join(oc, 'opencode.db'), '');
  const rows = new Set(['ses_inTheDatabase1']);
  let closed = 0;
  const openDb = (file) => {
    assert.equal(file, path.join(oc, 'opencode.db'));
    return { prepare: (sql) => { assert.match(sql, /FROM session WHERE id = \?/); return { get: (id) => (rows.has(id) ? { 1: 1 } : undefined) }; }, close: () => { closed++; } };
  };
  const dirs = [oc, path.join(data, 'openisy')];
  assert.equal(opencodeSessionExists('ses_inTheDatabase1', { dirs, openDb }), true);
  assert.ok(closed >= 1, 'the database is closed');

  const legacy = path.join(data, 'openisy', 'storage', 'session', 'proj123');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'ses_inTheJsonStore1.json'), '{}');
  assert.equal(opencodeSessionExists('ses_inTheJsonStore1', { dirs, openDb }), true);

  assert.equal(opencodeSessionExists('ses_neverExisted01', { dirs, openDb }), false);
  assert.equal(opencodeSessionExists('../../etc/passwd', { dirs, openDb }), false, 'not a session id at all');
  assert.equal(opencodeSessionExists('ses_inTheDatabase1', { dirs, openDb: () => { throw new Error('locked'); } }), false, 'unreadable counts as not found');
});

test('data dirs follow XDG_DATA_HOME, else ~/.local/share, on every OS', () => {
  assert.deepEqual(opencodeDataDirs({ XDG_DATA_HOME: '/x' }, '/home/u'), [path.join('/x', 'opencode'), path.join('/x', 'openisy')]);
  assert.deepEqual(opencodeDataDirs({}, '/home/u'), [path.join('/home/u', '.local', 'share', 'opencode'), path.join('/home/u', '.local', 'share', 'openisy')]);
});

test('the per-agent opencode config keeps what was set in it across spawns', async (t) => {
  const home = tmp('md-oc-merge-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  const first = await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'opencode', cwd: home }, { theme: 'light' });
  const cfg = path.join(first.env.OPENCODE_CONFIG_DIR, 'opencode.json');
  const tui = path.join(first.env.OPENCODE_CONFIG_DIR, 'tui.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), model: 'openai/gpt-5', mcp: { docs: { type: 'local' } } }));
  fs.writeFileSync(tui, JSON.stringify({ ...JSON.parse(fs.readFileSync(tui, 'utf8')), keybinds: { leader: 'ctrl+x' } }));

  await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'opencode', cwd: home }, { theme: 'dark' });
  const after = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.equal(after.model, 'openai/gpt-5', 'the model survived the respawn');
  assert.deepEqual(after.mcp, { docs: { type: 'local' } });
  assert.equal(after.theme, 'system');
  assert.deepEqual(JSON.parse(fs.readFileSync(tui, 'utf8')).keybinds, { leader: 'ctrl+x' });
});

test('mergeJsonFile: creates, merges, and never clobbers a file it cannot parse', (t) => {
  const dir = tmp('md-merge-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'a.json');
  mergeJsonFile(f, { theme: 'system' });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { theme: 'system' });
  fs.writeFileSync(f, '﻿{"model":"x","theme":"old"}');
  mergeJsonFile(f, { theme: 'system' });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { model: 'x', theme: 'system' });
  fs.writeFileSync(f, '{ "model": "x", // a comment someone typed\n}');
  mergeJsonFile(f, { theme: 'system' });
  assert.equal(fs.readFileSync(f, 'utf8'), '{ "model": "x", // a comment someone typed\n}', 'left alone');
  fs.writeFileSync(f, '[1,2]');
  mergeJsonFile(f, { theme: 'system' });
  assert.equal(fs.readFileSync(f, 'utf8'), '[1,2]');
});
