'use strict';
/**
 * bridge-opencode-privado.sh tests. Self-contained, no test framework — run with
 * `node test/bridge-opencode.test.cjs`. Exercises the bridge script against
 * sandbox STORE/TARGET dirs (via OPENCODE_PRIVATE_STORE / OPENCODE_TARGET_HOME),
 * so the real ~/.config/opencode is never touched.
 *
 * The bridge links the private store (DEVELOPMENT level, outside all repos)
 * into the global config dir (~/.config/opencode), which OpenISy reads on EVERY
 * launch — direct and munder-spawned — because Global.Path.config is constant
 * and never isolated (unlike cwd-dependent project .opencode/, which stops at
 * the repo root: `afs.up stop: worktree`).
 */

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'tools', 'bridge-opencode-privado.sh');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.log(`  ✗ ${name}\n     ${err && err.message}`); }
}

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
  const store = path.join(base, 'store');
  const home = path.join(base, 'home');
  for (const d of ['agent', 'command', 'mode', 'plugin']) fs.mkdirSync(path.join(store, d), { recursive: true });
  fs.writeFileSync(path.join(store, 'agent', 'mi-revisor.md'), '---\nmode: primary\n---\nRevisa.\n');
  fs.writeFileSync(path.join(store, 'command', 'mi-cmd.md'), 'Haz X.\n');
  fs.writeFileSync(path.join(store, 'mode', 'modo-auditor.md'), 'Audita.\n');
  fs.writeFileSync(path.join(store, 'plugin', 'mi-hook.js'), 'module.exports = {};\n');
  const env = { ...process.env, OPENCODE_PRIVATE_STORE: store, OPENCODE_TARGET_HOME: home };
  return { base, store, home, env };
}

function run(args, env) {
  return spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env, timeout: 15000 });
}

console.log('bridge-opencode-privado tests');

test('links every store file into the global config dir (plugin -> plugins)', () => {
  const { home, env } = sandbox();
  const r = run([], env);
  assert.strictEqual(r.status, 0, `exit 0, stderr: ${r.stderr}`);
  const pairs = [
    ['agent/mi-revisor.md', 'agent/mi-revisor.md'],
    ['command/mi-cmd.md', 'command/mi-cmd.md'],
    ['mode/modo-auditor.md', 'mode/modo-auditor.md'],
    ['plugin/mi-hook.js', 'plugins/mi-hook.js'],
  ];
  for (const [src, dest] of pairs) {
    const link = path.join(home, '.config', 'opencode', dest);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), `${dest} is a symlink`);
    assert.ok(fs.readFileSync(link, 'utf8').length > 0, `${dest} resolves to content`);
  }
});

test('second run is idempotent (exit 0, same links)', () => {
  const { home, env } = sandbox();
  assert.strictEqual(run([], env).status, 0, 'first run');
  const r = run([], env);
  assert.strictEqual(r.status, 0, `second run exit 0, stderr: ${r.stderr}`);
  assert.match(r.stdout, /enlazados=4/, 'all four still linked');
});

test('never overwrites a real foreign file (warns, exit nonzero)', () => {
  const { home, env } = sandbox();
  const destDir = path.join(home, '.config', 'opencode', 'agent');
  fs.mkdirSync(destDir, { recursive: true });
  const blocker = path.join(destDir, 'mi-revisor.md');
  fs.writeFileSync(blocker, 'contenido ajeno real');
  const r = run([], env);
  assert.notStrictEqual(r.status, 0, 'exit nonzero on conflict');
  assert.match(r.stderr, /AVISO/, 'warns on stderr');
  assert.strictEqual(fs.readFileSync(blocker, 'utf8'), 'contenido ajeno real', 'foreign file untouched');
  assert.ok(!fs.lstatSync(blocker).isSymbolicLink(), 'not converted to symlink');
});

test('--check reports pending before linking and OK after', () => {
  const { env } = sandbox();
  const before = run(['--check'], env);
  assert.notStrictEqual(before.status, 0, 'pending -> nonzero');
  assert.match(before.stdout, /PENDIENTE/, 'names pending files');
  assert.strictEqual(run([], env).status, 0, 'link pass');
  const after = run(['--check'], env);
  assert.strictEqual(after.status, 0, `all linked -> 0, stdout: ${after.stdout}`);
  assert.match(after.stdout, /fuera de todo repo git/, 'reports store git status');
});

test('--unlink removes bridge links and keeps foreign files', () => {
  const { home, env } = sandbox();
  assert.strictEqual(run([], env).status, 0, 'link pass');
  const foreignDir = path.join(home, '.config', 'opencode', 'command');
  const foreign = path.join(foreignDir, 'ajeno.md');
  fs.writeFileSync(foreign, 'no es del puente');
  const r = run(['--unlink'], env);
  assert.strictEqual(r.status, 0, 'unlink exit 0');
  assert.ok(!fs.existsSync(path.join(home, '.config', 'opencode', 'agent', 'mi-revisor.md')), 'bridge link gone');
  assert.strictEqual(fs.readFileSync(foreign, 'utf8'), 'no es del puente', 'foreign file kept');
});

test('--unlink also works when the store sits under a symlinked dir (macOS /var -> /private/var)', () => {
  const { base, home } = sandbox();
  const alias = path.join(base, 'alias');
  fs.symlinkSync(base, alias);
  const env = { ...process.env, OPENCODE_PRIVATE_STORE: path.join(alias, 'store'), OPENCODE_TARGET_HOME: home };
  assert.strictEqual(run([], env).status, 0, 'link pass');
  const linked = path.join(home, '.config', 'opencode', 'agent', 'mi-revisor.md');
  assert.ok(fs.lstatSync(linked).isSymbolicLink(), 'linked through the alias');
  assert.strictEqual(run(['--unlink'], env).status, 0, 'unlink exit 0');
  assert.ok(!fs.existsSync(linked) && !isLink(linked), 'bridge link gone');
});

function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }

if (failures > 0) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log('\nbridge-opencode: all green');
