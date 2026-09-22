'use strict';
/**
 * harness-create tests. Self-contained, no test framework — run with
 * `node test/harness-create.test.cjs` (mirrors test/agent-provider.test.cjs).
 *
 * Covers the "create new harness" button path that the HivePicker drives:
 * - isValidHarnessFolderName (src/main/fs.ts, pure): the typed folder name is
 *   validated the same way by the picker and the `config:createHome` IPC.
 * - normalizeHiveHome: the created home lands first in recents (the
 *   registration the button relies on via changeHome 'fresh').
 * - start.sh arg parsing (headless --check/--stop paths only — never launches
 *   the GUI): --user-data-dir (both forms) is accepted for parallel sessions.
 *
 * The main-process module is transpiled with the bundled `typescript` compiler
 * into a temp dir and required (fs.ts only needs node builtins + the
 * dependency-free shared/imageTypes, transpiled alongside like the
 * agent-provider test does with its siblings).
 */

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-'));
// Mirror the repo layout (src/main + src/shared) so the transpiled
// `require('../shared/imageTypes')` resolves exactly like the real one.
for (const [src, dest] of [
  [path.join(ROOT, 'src', 'main', 'fs.ts'), path.join(out, 'main', 'fs.js')],
  [path.join(ROOT, 'src', 'shared', 'imageTypes.ts'), path.join(out, 'shared', 'imageTypes.js')],
]) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const js = ts.transpileModule(fs.readFileSync(src, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  fs.writeFileSync(dest, js, 'utf8');
}
const fsmod = require(path.join(out, 'main', 'fs.js'));

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.log(`  ✗ ${name}\n     ${err && err.message}`); }
}

console.log('harness-create tests');

test('accepts normal names, trimmed', () => {
  assert.deepStrictEqual(fsmod.isValidHarnessFolderName('harness-isYco'), { ok: true, name: 'harness-isYco' });
  assert.deepStrictEqual(fsmod.isValidHarnessFolderName('  mi harness  '), { ok: true, name: 'mi harness' });
});

test('rejects empty / non-string names', () => {
  assert.strictEqual(fsmod.isValidHarnessFolderName('').ok, false);
  assert.strictEqual(fsmod.isValidHarnessFolderName('   ').ok, false);
  assert.strictEqual(fsmod.isValidHarnessFolderName(undefined).ok, false);
  assert.strictEqual(fsmod.isValidHarnessFolderName(42).ok, false);
});

test('rejects path separators, dot-dirs and null bytes (no escape from parent)', () => {
  for (const bad of ['a/b', 'a\\b', '.', '..', 'a\0b', '../otro', 'sub/dir']) {
    const r = fsmod.isValidHarnessFolderName(bad);
    assert.strictEqual(r.ok, false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test('rejects Windows device names and absurd lengths', () => {
  for (const bad of ['CON', 'nul.txt', 'COM1', 'lpt9.bak']) {
    assert.strictEqual(fsmod.isValidHarnessFolderName(bad).ok, false, `${bad} reserved`);
  }
  assert.strictEqual(fsmod.isValidHarnessFolderName('h'.repeat(129)).ok, false, '129 chars rejected');
  assert.strictEqual(fsmod.isValidHarnessFolderName('h'.repeat(128)).ok, true, '128 chars accepted');
});

test('normalizeHiveHome puts the created home first in recents', () => {
  const r = fsmod.normalizeHiveHome('/home/danny/harness2', ['/home/danny/Development']);
  assert.strictEqual(r.home, '/home/danny/harness2');
  assert.deepStrictEqual(r.recentHives.slice(0, 2), ['/home/danny/harness2', '/home/danny/Development']);
});

test('ensureHarnessGitignore writes runtime ignores into a fresh home', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-'));
  assert.strictEqual(fsmod.ensureHarnessGitignore(dir), true);
  const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  for (const e of ['hive/', 'palace/', 'roster.json', 'roster-backups/']) {
    assert.ok(content.split('\n').some((l) => l.trim() === e), `${e} ignored`);
  }
});

test('ensureHarnessGitignore appends without clobbering and is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-'));
  fs.writeFileSync(path.join(dir, '.gitignore'), '# mis notas\n*.key\n');
  assert.strictEqual(fsmod.ensureHarnessGitignore(dir), true);
  const once = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.ok(once.includes('# mis notas'), 'user lines kept');
  assert.ok(once.includes('*.key'), 'user rules kept');
  assert.ok(once.includes('hive/'), 'harness entries added');
  assert.strictEqual(fsmod.ensureHarnessGitignore(dir), true);
  const twice = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.strictEqual(twice, once, 'second run changes nothing');
});

test('ensureHarnessGitignore treats user `hive` as covering `hive/`', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-'));
  fs.writeFileSync(path.join(dir, '.gitignore'), 'hive\npalace/\nroster.json\nroster-backups/\n');
  assert.strictEqual(fsmod.ensureHarnessGitignore(dir), true);
  const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.ok(!content.includes('auto-generated'), 'nothing added when covered');
});

test('start.sh --check passes and accepts --user-data-dir (both forms)', () => {
  const sh = path.join(ROOT, 'start.sh');
  const check = spawnSync('bash', [sh, '--check'], { encoding: 'utf8', timeout: 15000 });
  assert.strictEqual(check.status, 0, `--check exit 0: ${check.stderr}`);
  assert.match(check.stdout, /start\.sh: OK/, 'preflight OK');
  for (const args of [['--user-data-dir=/tmp/hb-data', '--check'], ['--user-data-dir', '/tmp/hb-data', '--check']]) {
    const r = spawnSync('bash', [sh, ...args], { encoding: 'utf8', timeout: 15000 });
    assert.strictEqual(r.status, 0, `${args.join(' ')} exit 0: ${r.stderr}`);
  }
});

test('start.sh rejects a bare --user-data-dir without launching', () => {
  const sh = path.join(ROOT, 'start.sh');
  const r = spawnSync('bash', [sh, '--user-data-dir'], { encoding: 'utf8', timeout: 15000 });
  assert.notStrictEqual(r.status, 0, 'exit nonzero');
  assert.match(r.stderr, /necesita un directorio/, 'explains the missing dir');
});

if (failures > 0) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log('\nharness-create: all green');
