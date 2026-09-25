'use strict';

/**
 * Regression for the 2026-08-15 webhook-card loss: ASK ME had read an eight-card
 * ledger, the webhook appended card nine, then ASK ME overwrote tasks.json with
 * its stale eight-card snapshot while recording an answer. Renderer actions must
 * mutate one card against the latest main-process ledger instead of replacing the
 * whole collection they happened to read earlier.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-task-mutate-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return new HiveManager(() => home);
}

function card(id, extra = {}) {
  return {
    id,
    title: id,
    status: 'todo',
    dependsOn: [],
    priority: 3,
    createdAt: '2026-08-15T08:00:00.000Z',
    ...extra
  };
}

function tasks(hive) {
  return hive.tasks().tasks;
}

test('patching a stale UI card preserves a concurrently appended webhook card', (t) => {
  const hive = floor(t);
  const question = card('needs-human', {
    status: 'blocked',
    humanQA: [{ q: 'Which option?', askedAt: '2026-08-15T08:00:00.000Z' }]
  });
  hive.writeTasks([question]);

  // The renderer still holds this one-card snapshot when the webhook arrives.
  const staleQuestion = structuredClone(tasks(hive)[0]);
  const webhook = card('webhook-1', {
    webhook: { tokenHash: 'a'.repeat(64) }
  });
  assert.equal(hive.addTask(webhook), true);

  staleQuestion.humanQA[0].a = 'Option B';
  staleQuestion.humanQA[0].answeredAt = '2026-08-15T08:00:01.000Z';
  assert.equal(hive.patchTask(staleQuestion.id, { humanQA: staleQuestion.humanQA }), true);

  assert.deepEqual(tasks(hive).map((task) => task.id), ['needs-human', 'webhook-1']);
  assert.equal(tasks(hive)[0].humanQA[0].a, 'Option B');
  assert.equal(tasks(hive)[1].webhook.tokenHash, 'a'.repeat(64));
});

test('atomic add is idempotent and delete removes only the named card', (t) => {
  const hive = floor(t);
  hive.writeTasks([card('existing')]);

  assert.equal(hive.addTask(card('new')), true);
  assert.equal(hive.addTask(card('new', { title: 'duplicate' })), false);
  assert.equal(hive.deleteTask('existing'), true);
  assert.equal(hive.deleteTask('missing'), false);

  assert.deepEqual(tasks(hive).map((task) => task.id), ['new']);
  assert.equal(tasks(hive)[0].title, 'new');
});

test('patch refuses an unknown card without rewriting the ledger', (t) => {
  const hive = floor(t);
  hive.writeTasks([card('existing')]);

  assert.equal(hive.patchTask('missing', { status: 'done' }), false);
  assert.deepEqual(tasks(hive), [card('existing')]);
});

test('renderer task actions never send a whole stale ledger back to main', () => {
  const root = path.resolve(__dirname, '..');
  const preload = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  const realtimeActions = fs.readFileSync(path.join(root, 'src/main/realtimeActions.ts'), 'utf8');
  const sources = [
    'src/renderer/src/components/AskMeTab.tsx',
    'src/renderer/src/components/TaskDetailOverlay.tsx',
    'src/renderer/src/components/TasksKanban.tsx',
    'src/renderer/src/hooks/useHive.ts'
  ].map((file) => fs.readFileSync(path.join(root, file), 'utf8'));

  for (const source of sources) {
    assert.doesNotMatch(source, /hiveWriteTasks\s*\(/,
      'renderer code must use atomic task IPC rather than overwrite tasks.json');
  }
  assert.doesNotMatch(preload, /hiveWriteTasks\s*:/,
    'the renderer bridge must not expose the unsafe whole-ledger write primitive');
  assert.doesNotMatch(main, /ipcMain\.handle\('hive:writeTasks'/,
    'main must not accept whole-ledger writes from a stale renderer');
  assert.doesNotMatch(realtimeActions, /hiveWriteTasks\s*\(/,
    'voice actions must use atomic task mutations rather than overwrite tasks.json');
  assert.match(realtimeActions, /hiveAddTask\s*\(/);
  assert.match(realtimeActions, /hivePatchTask\s*\(/);
  assert.match(realtimeActions, /hiveDeleteTask\s*\(/);
  assert.match(sources[0], /hivePatchTask\s*\(/);
  assert.match(sources[1], /hivePatchTask\s*\(/);
  assert.match(sources[2], /hiveDeleteTask\s*\(/);
  assert.match(sources[3], /hiveAddTask\s*\(/);
});

test('webhook dispatch appends via atomic addTask, not a stale whole-ledger rewrite', () => {
  const root = path.resolve(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  const fn = main.slice(main.indexOf('function dispatchWebhookWork'),
    main.indexOf('function handleWebhookMessage'));
  // The card must be appended through hive.addTask(card) — which reads the LATEST
  // on-disk ledger and is idempotent by task id — never through a re-read of a
  // snapshot the caller happened to hold, which would overwrite a concurrently
  // added card (the 2026-08-15 regression this suite guards).
  assert.match(fn, /hive\.addTask\s*\(card\)/,
    'dispatchWebhookWork must add the card via the atomic addTask');
  assert.doesNotMatch(fn, /writeTasks\s*\(\[\s*\.\.\.existing/,
    'dispatchWebhookWork must not rebuild a stale whole-ledger snapshot');
});

// A ledger write that dies halfway must cost the interrupted card, never the
// board. Written in place, the file is truncated between the open and the last
// byte, and `readJson`'s catch-all then hands the app an empty ledger — the
// whole floor silently disappears with nothing in the log pointing at why.
test('an interrupted ledger write leaves the previous tasks.json intact', (t) => {
  const hive = floor(t);
  hive.writeTasks([card('keep-me')]);
  const root = hive.root();
  const tasksPath = path.join(root, 'tasks.json');
  const before = fs.readFileSync(tasksPath, 'utf8');

  // ENOSPC/EIO/a pulled power cord: half the payload lands, then the write
  // throws. load-ts transpiles to CommonJS, so the module reads
  // `node:fs`.writeFileSync at call time and this reaches the real code path.
  const realWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function (target, data, ...rest) {
    if (typeof target === 'string' && target.includes('tasks.json')) {
      const text = String(data);
      realWriteFileSync.call(fs, target, text.slice(0, Math.floor(text.length / 2)), ...rest);
      throw Object.assign(new Error('ENOSPC: simulated interrupted write'), { code: 'ENOSPC' });
    }
    return realWriteFileSync.call(fs, target, data, ...rest);
  };
  t.after(() => { fs.writeFileSync = realWriteFileSync; });

  assert.throws(() => hive.writeTasks([card('never-landed')]), /ENOSPC/);

  assert.equal(fs.readFileSync(tasksPath, 'utf8'), before,
    'the previous ledger must survive byte-for-byte');
  assert.deepEqual(hive.tasks().tasks.map((task) => task.id), ['keep-me']);
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.includes('.tmp-')), [],
    'an interrupted write must leave no temp file in the hive root');
});
