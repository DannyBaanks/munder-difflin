'use strict';

/**
 * PROTOCOL.md and COMMANDS.md are GENERATED — the hive ships both as embedded
 * constants and points every agent at them as the authority. They used to be
 * rewritten inside `ensureHive()`, which is also on the runtime path: one card
 * mutation, one spawned agent, silently replaced the file the floor is reading.
 * Creating them is `ensureHive`'s job; replacing them is an explicit act of
 * bootstrap.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-gen-docs-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  return { hive, root: path.join(home, 'hive') };
}

const LOCAL_EDIT = '# edited by an agent\n';

test('a fresh hive gets both generated docs', (t) => {
  const { hive, root } = floor(t);
  hive.ensureHive();

  for (const name of ['PROTOCOL.md', 'COMMANDS.md']) {
    const file = path.join(root, name);
    assert.ok(fs.existsSync(file), `${name} must exist on a fresh hive`);
    assert.ok(fs.readFileSync(file, 'utf8').length > 0, `${name} must not be empty`);
  }
});

test('writeTasks does not rewrite the generated docs', (t) => {
  const { hive, root } = floor(t);
  hive.ensureHive();
  hive.writeTasks([{
    id: 'card-1', title: 'card-1', status: 'todo', dependsOn: [], priority: 3,
    createdAt: '2026-09-25T00:00:00.000Z'
  }]);
  // Mark both as locally edited, the way an agent working on its own floor would.
  const protocol = path.join(root, 'PROTOCOL.md');
  const commands = path.join(root, 'COMMANDS.md');
  fs.writeFileSync(protocol, LOCAL_EDIT, 'utf8');
  fs.writeFileSync(commands, LOCAL_EDIT, 'utf8');

  hive.writeTasks([{
    id: 'card-2', title: 'card-2', status: 'todo', dependsOn: [], priority: 3,
    createdAt: '2026-09-25T00:01:00.000Z'
  }]);

  assert.equal(fs.readFileSync(protocol, 'utf8'), LOCAL_EDIT);
  assert.equal(fs.readFileSync(commands, 'utf8'), LOCAL_EDIT);
});

test('ensureAgent does not rewrite the generated docs', async (t) => {
  const { hive, root } = floor(t);
  hive.ensureHive();
  const protocol = path.join(root, 'PROTOCOL.md');
  const commands = path.join(root, 'COMMANDS.md');
  fs.writeFileSync(protocol, LOCAL_EDIT, 'utf8');
  fs.writeFileSync(commands, LOCAL_EDIT, 'utf8');

  await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'claude', cwd: root });

  assert.equal(fs.readFileSync(protocol, 'utf8'), LOCAL_EDIT);
  assert.equal(fs.readFileSync(commands, 'utf8'), LOCAL_EDIT);
});

test('the explicit refresh replaces a stale copy', (t) => {
  const { hive, root } = floor(t);
  hive.ensureHive();
  const protocol = path.join(root, 'PROTOCOL.md');
  const commands = path.join(root, 'COMMANDS.md');
  fs.writeFileSync(protocol, LOCAL_EDIT, 'utf8');
  fs.writeFileSync(commands, LOCAL_EDIT, 'utf8');

  hive.refreshGeneratedDocs();

  assert.notEqual(fs.readFileSync(protocol, 'utf8'), LOCAL_EDIT);
  assert.notEqual(fs.readFileSync(commands, 'utf8'), LOCAL_EDIT);
});

test('the refresh is wired to app bootstrap, not to the runtime path', () => {
  // index.ts is Electron-coupled and cannot load here, so its wiring is asserted
  // against the source text — the house pattern.
  const main = fs.readFileSync(
    path.resolve(__dirname, '..', 'src/main/index.ts'), 'utf8'
  );
  const bootstrap = main.slice(main.indexOf('function bootstrapHiveServices'));
  assert.match(bootstrap.slice(0, 600), /hive\.refreshGeneratedDocs\(\)/,
    'app start must still propagate a protocol change to an existing hive');
});
