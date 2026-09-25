'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CMD = path.join(ROOT, 'munder.cmd');
const PS1 = path.join(ROOT, 'munder.ps1');

function linkEnv(stateDir) {
  return {
    ...process.env,
    MUNDER_STATE_DIR: stateDir,
    MUNDER_LINK_HIVE: path.join(stateDir, 'hive'),
    NO_COLOR: '1'
  };
}

function runWindowsCommand(args, stateDir) {
  const command = ['munder.cmd', ...args]
    .map((arg) => {
      const value = String(arg);
      if (/[\s"&|<>^%]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
      return value;
    })
    .join(' ');
  return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
    cwd: ROOT,
    env: linkEnv(stateDir),
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true
  });
}

function runPowerShellLink(args, stateDir) {
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, ...args], {
    cwd: ROOT,
    env: linkEnv(stateDir),
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true
  });
}

test('Windows launcher routes Munder Link to the Node CLI with UTF-8 enabled', () => {
  const source = fs.readFileSync(PS1, 'utf8');
  assert.match(source, /\[Console\]::OutputEncoding = \$Utf8/);
  assert.match(source, /\$OutputEncoding = \$Utf8/);
  assert.match(source, /& node \$MUNDER_CLI 'link' @rest/);
  assert.match(source, /'link' \{ Invoke-Link \$rest \}/);
  assert.match(fs.readFileSync(CMD, 'utf8'), /%\*\s*$/);
});

test('munder.cmd preserves Link arguments and Unicode output', { skip: process.platform !== 'win32' }, (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'munder-link-cli-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  const estado = runWindowsCommand(['link', 'estado'], stateDir);
  assert.ifError(estado.error);
  assert.equal(estado.status, 0, estado.stderr);
  assert.match(estado.stdout, /ESTA OFICINA/);
  assert.doesNotMatch(estado.stdout, /CLI de Munder Difflin/);

  const identityPath = path.join(stateDir, 'link', 'identity.json');
  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
  identity.name = 'Mía 東京 ñ—';
  fs.writeFileSync(identityPath, JSON.stringify(identity), 'utf8');
  const unicodeEstado = runWindowsCommand(['link', 'estado'], stateDir);
  assert.ifError(unicodeEstado.error);
  assert.equal(unicodeEstado.status, 0, unicodeEstado.stderr);
  assert.match(unicodeEstado.stdout, /Mía 東京 ñ—/);
  assert.doesNotMatch(unicodeEstado.stdout, /\uFFFD/);

  const unicodeArg = 'Mía 東京 ñ—';
  const enviar = runPowerShellLink(['link', 'enviar', unicodeArg, 'tarea'], stateDir);
  assert.ifError(enviar.error);
  assert.equal(enviar.status, 1, enviar.stderr);
  const output = `${enviar.stdout}\n${enviar.stderr}`;
  assert.match(output, new RegExp(unicodeArg));
  assert.doesNotMatch(output, /\uFFFD/);
});
