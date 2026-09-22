'use strict';
/**
 * openTerminal tests. Self-contained, no test framework — run with
 * `node test/open-terminal.test.cjs` (mirrors test/agent-provider.test.cjs).
 * The logic lives in TypeScript (src/main/openTerminal.ts), so we transpile it
 * with the bundled `typescript` compiler into a temp dir and require the result.
 *
 * Covers the 2026-09-21 Linux bug: the old `terminal:openAtFolder` handler ran
 * `spawn('open', ['-a', 'Terminal', cwd])` on EVERY platform. `-a` is macOS-only;
 * on Linux /usr/bin/open is the Debian alternative for xdg-open, which has no
 * -a flag → every click died with "xdg-open: unexpected option '-a'".
 * (Measured on Ubuntu 24.04: /usr/bin/open -> /etc/alternatives/open -> xdg-open.)
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const MAIN = path.join(__dirname, '..', 'src', 'main');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'openterm-'));
const src = fs.readFileSync(path.join(MAIN, 'openTerminal.ts'), 'utf8');
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
fs.writeFileSync(path.join(out, 'openTerminal.js'), js, 'utf8');
const ot = require(path.join(out, 'openTerminal.js'));

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.log(`  ✗ ${name}\n     ${err && err.message}`); }
}

console.log('openTerminal tests');

test('macOS keeps the legacy Terminal.app path (open -a Terminal)', () => {
  const cmd = ot.commandFor('darwin', null, '/tmp/foo');
  assert.deepStrictEqual(cmd, { file: 'open', args: ['-a', 'Terminal', '/tmp/foo'] });
});

test('Windows opens a console with cd /d', () => {
  const cmd = ot.commandFor('win32', null, 'C:\\Users\\danny\\dev');
  assert.strictEqual(cmd.file, 'cmd.exe');
  assert.ok(cmd.args.includes('/k'), 'keeps the console open');
  assert.ok(cmd.args.some((a) => a.includes('C:\\Users\\danny\\dev')), 'carries the folder');
});

test('Linux with no emulator returns a Spanish actionable error', () => {
  const cmd = ot.commandFor('linux', null, '/tmp/foo');
  assert.ok(cmd.error, 'has error');
  assert.match(cmd.error, /gnome-terminal/, 'names an installable emulator');
});

test('every Linux emulator carries the cwd in its argv', () => {
  const cwd = '/home/danny/mi proyecto';
  const kinds = ['gnome-terminal', 'ptyxis', 'konsole', 'xfce4-terminal',
    'mate-terminal', 'alacritty', 'kitty', 'wezterm', 'xterm'];
  for (const kind of kinds) {
    const cmd = ot.commandFor('linux', { bin: `/usr/bin/${kind}`, kind }, cwd);
    assert.ok(!('error' in cmd), `${kind}: no error`);
    assert.strictEqual(cmd.file, `/usr/bin/${kind}`, `${kind}: right binary`);
    assert.ok(cmd.args.join(' ').includes(cwd), `${kind}: cwd present in argv`);
  }
});

test('xterm quotes hostile paths (spaces + single quotes)', () => {
  const cwd = "/tmp/o'brien dir";
  const args = ot.terminalArgsFor('xterm', cwd);
  assert.strictEqual(args[0], '-e');
  const sh = args[args.length - 1];
  assert.ok(sh.includes(`'\\''`), 'single quote is escaped');
  assert.ok(sh.includes('exec'), 'replaces the shell with the user shell');
});

test('resolveLinuxTerminal prefers gnome-terminal over xterm', () => {
  // which-path: gnome-terminal hits first, so xterm is never even probed
  // (correct short-circuit, not a skipped candidate).
  const seen = [];
  const deps = {
    exists: () => false,
    which: (n) => { seen.push(n); return n === 'gnome-terminal' ? `/usr/bin/${n}` : null; },
    homeDir: () => '/home/danny'
  };
  const r = ot.resolveLinuxTerminal(deps);
  assert.deepStrictEqual(r, { bin: '/usr/bin/gnome-terminal', kind: 'gnome-terminal' });
  assert.deepStrictEqual(seen, ['gnome-terminal'], 'stops at the first hit');
  // exists-path: both present on disk, preference order still wins.
  const deps2 = {
    exists: (p) => p === '/usr/bin/gnome-terminal' || p === '/usr/bin/xterm',
    which: () => null,
    homeDir: () => '/home/danny'
  };
  assert.deepStrictEqual(ot.resolveLinuxTerminal(deps2),
    { bin: '/usr/bin/gnome-terminal', kind: 'gnome-terminal' });
});

test('resolveLinuxTerminal falls back to absolute candidates when which misses', () => {
  const deps = {
    exists: (p) => p === '/usr/bin/konsole',
    which: () => null,
    homeDir: () => '/home/danny'
  };
  assert.deepStrictEqual(ot.resolveLinuxTerminal(deps), { bin: '/usr/bin/konsole', kind: 'konsole' });
});

test('resolveLinuxTerminal returns null when nothing is installed', () => {
  const deps = { exists: () => false, which: () => null, homeDir: () => '/home/danny' };
  assert.strictEqual(ot.resolveLinuxTerminal(deps), null);
});

test('openTerminalAtFolder rejects empty cwd without spawning', () => {
  assert.deepStrictEqual(ot.openTerminalAtFolder(''), { ok: false, error: 'invalid cwd' });
  assert.deepStrictEqual(ot.openTerminalAtFolder(undefined), { ok: false, error: 'invalid cwd' });
});

test('functional: stub gnome-terminal on PATH receives the folder (real spawn)', () => {
  if (process.platform !== 'linux') { console.log('    (skipped: needs linux)'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stubterm-'));
  const log = path.join(dir, 'argv.log');
  const stub = path.join(dir, 'gnome-terminal');
  fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
  const deps = {
    exists: () => false,
    which: (n) => {
      if (n !== 'gnome-terminal') return null;
      try {
        const r = require('node:child_process').spawnSync('which', ['gnome-terminal'],
          { encoding: 'utf8', env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` } });
        const line = String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)[0];
        return line || null;
      } catch { return null; }
    },
    homeDir: () => os.homedir()
  };
  const cwd = '/tmp/proyecto munder';
  // Never touches the real spawn path: resolution happens through the stubbed deps,
  // and the spawned binary IS the stub (detached, stdio ignored).
  const here = ot.resolveLinuxTerminal(deps);
  assert.ok(here && here.bin === stub, `stub resolved, got ${here && here.bin}`);
  const cmd = ot.commandFor('linux', here, cwd);
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(cmd.file, cmd.args, { encoding: 'utf8', timeout: 5000 });
  assert.strictEqual(r.status, 0, 'stub exits 0');
  const logged = fs.readFileSync(log, 'utf8');
  assert.ok(logged.includes(cwd), `stub saw the folder, got: ${logged.trim()}`);
});

if (failures > 0) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log('\nopen-terminal: all green');
