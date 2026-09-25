'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { linkWorktreeDeps, unlinkWorktreeDeps, detachWorktreeDepsLink } = loadTs('src/main/worktreeDeps.ts');
const { removeWorktree } = loadTs('src/main/git.ts');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function makeHarness() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-worktree-deps-'));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const wtRoot = path.join(home, 'worktrees');
  fs.mkdirSync(wtRoot);
  return { repo, wtRoot };
}

function addWorktree(repo, wtRoot, name) {
  const wtPath = path.join(wtRoot, name);
  git(repo, 'worktree', 'add', '-q', wtPath, '-b', `agent/${name}`, 'main');
  return wtPath;
}

test('links the base node_modules into an isolated worktree', async () => {
  const { repo, wtRoot } = makeHarness();
  const baseNodeModules = path.join(repo, 'node_modules');
  fs.mkdirSync(baseNodeModules);
  fs.writeFileSync(path.join(baseNodeModules, 'sentinel.txt'), 'base\n');
  const wtPath = addWorktree(repo, wtRoot, 'agent-a');

  const result = await linkWorktreeDeps(repo, wtPath);

  assert.deepEqual(result, { ok: true, skipped: false });
  const worktreeNodeModules = path.join(wtPath, 'node_modules');
  assert.equal(fs.lstatSync(worktreeNodeModules).isSymbolicLink(), true);
  // path.resolve: a Windows junction reads back with a trailing separator.
  assert.equal(path.resolve(fs.readlinkSync(worktreeNodeModules)), baseNodeModules);
  assert.equal(fs.readFileSync(path.join(worktreeNodeModules, 'sentinel.txt'), 'utf8'), 'base\n');
});

test('skips linking when the base checkout has no node_modules', async () => {
  const { repo, wtRoot } = makeHarness();
  const wtPath = addWorktree(repo, wtRoot, 'agent-b');

  const result = await linkWorktreeDeps(repo, wtPath);

  assert.deepEqual(result, { ok: true, skipped: true });
  assert.throws(() => fs.lstatSync(path.join(wtPath, 'node_modules')), /ENOENT/);
});

test('does not replace an existing worktree node_modules entry', async () => {
  const { repo, wtRoot } = makeHarness();
  fs.mkdirSync(path.join(repo, 'node_modules'));
  const wtPath = addWorktree(repo, wtRoot, 'agent-c');
  const worktreeNodeModules = path.join(wtPath, 'node_modules');
  fs.mkdirSync(worktreeNodeModules);
  fs.writeFileSync(path.join(worktreeNodeModules, 'own.txt'), 'own\n');

  const result = await linkWorktreeDeps(repo, wtPath);

  assert.deepEqual(result, { ok: true, skipped: true });
  assert.equal(fs.lstatSync(worktreeNodeModules).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(worktreeNodeModules, 'own.txt'), 'utf8'), 'own\n');
});

test('does not follow the dependency symlink when removing a worktree', async () => {
  const { repo, wtRoot } = makeHarness();
  const baseNodeModules = path.join(repo, 'node_modules');
  fs.mkdirSync(baseNodeModules);
  const sentinel = path.join(baseNodeModules, 'must-survive.txt');
  fs.writeFileSync(sentinel, 'still here\n');
  const wtPath = addWorktree(repo, wtRoot, 'agent-d');

  assert.deepEqual(await linkWorktreeDeps(repo, wtPath), { ok: true, skipped: false });
  const worktreeNodeModules = path.join(wtPath, 'node_modules');
  assert.equal(fs.lstatSync(worktreeNodeModules).isSymbolicLink(), true, 'symlink must exist before removal');
  assert.deepEqual(await removeWorktree(repo, wtPath), { ok: true });

  // The base dependencies first: that is the data a followed link would destroy.
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'still here\n');
  assert.equal(fs.existsSync(wtPath), false);
});

test('leaves a dangling worktree dependency symlink untouched', async () => {
  const { repo, wtRoot } = makeHarness();
  fs.mkdirSync(path.join(repo, 'node_modules'));
  const wtPath = addWorktree(repo, wtRoot, 'agent-e');
  const worktreeNodeModules = path.join(wtPath, 'node_modules');
  // An absolute path that exists nowhere, spelled for this OS ('/does-not-exist'
  // reads back as 'D:\\does-not-exist' on Windows).
  const dangling = path.resolve('/does-not-exist');
  fs.symlinkSync(dangling, worktreeNodeModules);

  const result = await linkWorktreeDeps(repo, wtPath);

  assert.deepEqual(result, { ok: true, skipped: true });
  assert.equal(fs.readlinkSync(worktreeNodeModules), dangling);
});

test('reports a failed link without throwing', async () => {
  const { repo } = makeHarness();
  fs.mkdirSync(path.join(repo, 'node_modules'));
  const notADirectory = path.join(repo, 'not-a-directory');
  fs.writeFileSync(notADirectory, 'file\n');

  const result = await linkWorktreeDeps(repo, notADirectory);

  assert.equal(result.ok, false);
  // POSIX: EEXIST/ENOTDIR. Windows: creating a junction under a file is ENOENT.
  assert.match(result.error, /EEXIST|ENOTDIR|ENOENT/);
});

test('removes only the linked dependencies before checking worktree status', async () => {
  const { repo, wtRoot } = makeHarness();
  const baseNodeModules = path.join(repo, 'node_modules');
  fs.mkdirSync(baseNodeModules);
  const wtPath = addWorktree(repo, wtRoot, 'agent-f');
  const worktreeNodeModules = path.join(wtPath, 'node_modules');

  assert.deepEqual(await linkWorktreeDeps(repo, wtPath), { ok: true, skipped: false });
  // POSIX git lists the symlink as untracked; Git for Windows does not list a
  // junction at all, so the precondition only holds off Windows. What matters on
  // every OS is the rest: the link goes, the tree is clean, the base stays.
  if (process.platform !== 'win32') {
    assert.notEqual(git(wtPath, 'status', '--porcelain'), '', 'the unignored link makes the worktree dirty');
  }

  assert.deepEqual(await unlinkWorktreeDeps(repo, wtPath), { ok: true, removed: true });
  assert.throws(() => fs.lstatSync(worktreeNodeModules), /ENOENT/);
  assert.equal(git(wtPath, 'status', '--porcelain'), '', 'removing the link restores a clean worktree');
  assert.equal(fs.existsSync(baseNodeModules), true, 'the base dependencies must remain');
});

test('does not remove a real worktree node_modules directory', async () => {
  const { repo, wtRoot } = makeHarness();
  fs.mkdirSync(path.join(repo, 'node_modules'));
  const wtPath = addWorktree(repo, wtRoot, 'agent-g');
  const worktreeNodeModules = path.join(wtPath, 'node_modules');
  fs.mkdirSync(worktreeNodeModules);
  const sentinel = path.join(worktreeNodeModules, 'must-survive.txt');
  fs.writeFileSync(sentinel, 'worktree dependencies\n');

  const result = await unlinkWorktreeDeps(repo, wtPath);
  assert.equal(fs.lstatSync(worktreeNodeModules).isDirectory(), true);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'worktree dependencies\n');
  assert.deepEqual(result, { ok: true, removed: false });
});

test('does not remove a worktree node_modules link to another directory', async () => {
  const { repo, wtRoot } = makeHarness();
  fs.mkdirSync(path.join(repo, 'node_modules'));
  const foreignNodeModules = path.join(repo, 'foreign-node-modules');
  fs.mkdirSync(foreignNodeModules);
  const sentinel = path.join(foreignNodeModules, 'must-survive.txt');
  fs.writeFileSync(sentinel, 'foreign dependencies\n');
  const wtPath = addWorktree(repo, wtRoot, 'agent-h');
  const worktreeNodeModules = path.join(wtPath, 'node_modules');
  fs.symlinkSync(foreignNodeModules, worktreeNodeModules);

  const result = await unlinkWorktreeDeps(repo, wtPath);
  assert.equal(fs.lstatSync(worktreeNodeModules).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(worktreeNodeModules), foreignNodeModules);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'foreign dependencies\n');
  assert.deepEqual(result, { ok: true, removed: false });
});

test('wires dependency linking into successful isolated worktree creation', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const activeSource = indexSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

  assert.match(activeSource, /from ['"]\.\/worktreeDeps['"]/);
  const successBranch = activeSource.slice(
    activeSource.indexOf('if (wt.ok)'),
    activeSource.indexOf('} else {', activeSource.indexOf('if (wt.ok)'))
  );
  assert.match(successBranch, /await linkWorktreeDeps\(origCwd, wtPath\)/);
});

test('removes linked dependencies before worker retention checks', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const activeSource = indexSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

  const beforeRetention = activeSource.slice(0, activeSource.indexOf('const work = await worktreeHasUnintegratedWork'));
  assert.match(beforeRetention, /await unlinkWorktreeDeps\(origCwd, wtPath\)/);
  const beforeGc = activeSource.slice(0, activeSource.indexOf('safe = await worktreeIsGcSafe'));
  assert.match(beforeGc, /await unlinkWorktreeDeps\(e\.origCwd, e\.wtPath\)/);
});

test('uses a Windows junction for the directory link', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/main/worktreeDeps.ts'), 'utf8');

  assert.match(source, /process\.platform === ['"]win32['"] \? ['"]junction['"] :/);
});

test('detaching removes only the dependency link, never the base it points at', async () => {
  const { repo, wtRoot } = makeHarness();
  const baseNodeModules = path.join(repo, 'node_modules');
  fs.mkdirSync(baseNodeModules);
  const sentinel = path.join(baseNodeModules, 'must-survive.txt');
  fs.writeFileSync(sentinel, 'still here\n');
  const wtPath = addWorktree(repo, wtRoot, 'agent-h');
  assert.deepEqual(await linkWorktreeDeps(repo, wtPath), { ok: true, skipped: false });

  assert.deepEqual(await detachWorktreeDepsLink(wtPath), { ok: true, removed: true });
  assert.throws(() => fs.lstatSync(path.join(wtPath, 'node_modules')), /ENOENT/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'still here\n');
  assert.deepEqual(await detachWorktreeDepsLink(wtPath), { ok: true, removed: false }, 'idempotent');
});

test('detaching leaves a real node_modules directory for git to handle', async () => {
  const { repo, wtRoot } = makeHarness();
  const wtPath = addWorktree(repo, wtRoot, 'agent-i');
  const own = path.join(wtPath, 'node_modules');
  fs.mkdirSync(own);
  fs.writeFileSync(path.join(own, 'own.txt'), 'own\n');
  assert.deepEqual(await detachWorktreeDepsLink(wtPath), { ok: true, removed: false });
  assert.equal(fs.readFileSync(path.join(own, 'own.txt'), 'utf8'), 'own\n');
});

test('removeWorktree drops the dependency link before git deletes the tree', async () => {
  // End to end through the real git: the base keeps every file and the
  // worktree is gone. On Windows this is the junction case that used to leave
  // the worktree behind with no proof the base survived.
  const { repo, wtRoot } = makeHarness();
  const baseNodeModules = path.join(repo, 'node_modules');
  fs.mkdirSync(baseNodeModules);
  fs.writeFileSync(path.join(baseNodeModules, 'a.txt'), 'a\n');
  const wtPath = addWorktree(repo, wtRoot, 'agent-j');
  await linkWorktreeDeps(repo, wtPath);
  assert.deepEqual(await removeWorktree(repo, wtPath), { ok: true });
  assert.deepEqual(fs.readdirSync(baseNodeModules), ['a.txt']);
  assert.equal(fs.existsSync(wtPath), false);
});
