'use strict';

/**
 * The hive is coordination only: file-writing tool calls into it are refused,
 * except the protocol files the agent owns. Two failure directions matter
 * equally: too loose and agents scribble over each other's mailboxes and the
 * registry; too strict and an agent can no longer write its memory or send a
 * message, and the floor quietly stops. Adapted from dontbemichael.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { hiveWriteDecision } = loadTs('src/main/hiveGuard.ts');

const HOME = '/home/me/DEVELOPMENT';
const HIVE = `${HOME}/hive`;
const REPO = `${HOME}/isyco-api`;

const decide = (file_path, over = {}) =>
  hiveWriteDecision({
    tool: 'Write', toolInput: { file_path }, cwd: REPO,
    agentId: 'dwight', isGod: false, hiveRoot: HIVE, caseInsensitive: false, ...over
  });

test('work outside the hive is never touched, even inside the harness home', () => {
  assert.equal(decide(`${REPO}/src/app.ts`).deny, false);
  assert.equal(decide('README.md').deny, false, 'relative to its cwd');
  // god runs with the harness home as cwd; the home itself is not the hive.
  assert.equal(decide(`${HOME}/notes.md`, { agentId: 'god', isGod: true, cwd: HOME }).deny, false);
});

test('the protocol files an agent owns are allowed', () => {
  for (const p of [
    `${HIVE}/agents/dwight/memory.md`,
    `${HIVE}/agents/dwight/outbox/msg-1.json`,
    `${HIVE}/agents/dwight/inbox/.done/msg-0.json`,
    `${HIVE}/tasks.json`
  ]) assert.equal(decide(p).deny, false, p);
});

test('another agent\'s mailbox or memory, and the app\'s own files, are refused', () => {
  for (const p of [
    `${HIVE}/agents/jim/inbox/sneaky.json`,
    `${HIVE}/agents/jim/memory.md`,
    `${HIVE}/registry.json`,
    `${HIVE}/fleet.json`,
    `${HIVE}/log.jsonl`,
    `${HIVE}/agents/dwight/invoice.pdf`
  ]) {
    const d = decide(p);
    assert.equal(d.deny, true, p);
    assert.match(d.reason, /only for coordination/);
  }
});

test('board.md and spawn-requests are god\'s alone', () => {
  assert.equal(decide(`${HIVE}/board.md`).deny, true);
  assert.equal(decide(`${HIVE}/spawn-requests/w1.json`).deny, true);
  const god = { agentId: 'god', isGod: true, cwd: HOME };
  assert.equal(decide(`${HIVE}/board.md`, god).deny, false);
  assert.equal(decide(`${HIVE}/spawn-requests/w1.json`, god).deny, false);
});

test('`..` cannot smuggle a write out of an allowed folder', () => {
  assert.equal(decide(`${HIVE}/agents/dwight/outbox/../../jim/inbox/x.json`).deny, true);
  assert.equal(decide('../hive/registry.json').deny, true, 'relative from the repo');
});

test('case-insensitive file systems cannot be bypassed with capitals', () => {
  assert.equal(decide(`${HOME}/HIVE/Registry.json`, { caseInsensitive: true }).deny, true);
  assert.equal(decide(`${HOME}/HIVE/Registry.json`, { caseInsensitive: false }).deny, false,
    'on Linux that is genuinely a different folder');
});

test('read-only and shell tools are not judged here', () => {
  for (const tool of ['Read', 'Bash', 'Glob']) {
    assert.equal(decide(`${HIVE}/registry.json`, { tool }).deny, false, tool);
  }
});

// ─── Through the real hook server ────────────────────────────────────────────

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};
const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

test('the PreToolUse hook turns a refusal into a deny Claude Code obeys', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-guard-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'repo');
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'dwight', name: 'Dwight', provider: 'claude', cwd: repo });
  const server = new HookServer(hive, () => null, () => ({ harnessHome: home }));
  const write = (file_path) => server.handle({
    agent_id: 'dwight', session_id: 's1', hook_event_name: 'PreToolUse',
    tool_name: 'Write', tool_input: { file_path, content: 'x' }, cwd: repo
  });
  const hiveRoot = hive.root();
  const bad = await write(path.join(hiveRoot, 'registry.json'));
  assert.equal(bad.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(bad.hookSpecificOutput.permissionDecisionReason, /only for coordination/);
  const ok = await write(path.join(hiveRoot, 'agents', 'dwight', 'memory.md'));
  assert.notEqual(ok?.hookSpecificOutput?.permissionDecision, 'deny');
  const work = await write(path.join(repo, 'src.ts'));
  assert.notEqual(work?.hookSpecificOutput?.permissionDecision, 'deny');
});
