'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// ensureClaudePermissionsAccepted() writes below os.homedir(). Redirect both
// home variables before loading config.ts so this test can never touch the
// user's real Claude configuration.
const realHome = process.env.HOME;
const realUserProfile = process.env.USERPROFILE;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claude-config-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
assert.equal(os.homedir(), home, 'home redirect failed; refusing to run against the real home');

const userData = path.join(home, 'user-data');
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => userData } }
};

const { ensureClaudePermissionsAccepted } = loadTs('src/main/config.ts');
const settingsDir = path.join(home, '.claude');
const settingsPath = path.join(settingsDir, 'settings.json');
const projectConfigPath = path.join(home, '.claude.json');
const cwd = path.join(home, 'workspace', 'project');
// On Windows the trust flag is ALSO written under the forward-slash spelling
// Claude Code reads (C:/Users/...); on POSIX there is only the one key.
const cwdForward = /^[A-Za-z]:[\\/]/.test(cwd) ? cwd.replace(/\\/g, '/') : null;
const withForwardTrust = (projects) =>
  cwdForward && cwdForward !== cwd ? { ...projects, [cwdForward]: { hasTrustDialogAccepted: true } } : projects;
// A Windows drive-letter cwd. Claude Code looks the trust entry up under the
// forward-slash spelling, so both spellings have to end up trusted.
const winCwd = 'C:\\Users\\danny\\workspace\\project';
const winCwdSlashed = 'C:/Users/danny/workspace/project';
// Backslash is a legal POSIX filename character, so this must stay ONE key.
const posixBackslashCwd = path.join(home, 'weird', 'a\\b');

function writeSettings(contents) {
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(settingsPath, contents, 'utf8');
}

function resetConfigs() {
  fs.rmSync(settingsDir, { recursive: true, force: true });
  fs.rmSync(projectConfigPath, { force: true });
}

test.beforeEach(resetConfigs);
test.after(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = realUserProfile;
  fs.rmSync(home, { recursive: true, force: true });
});

test('preserves malformed Claude config files byte-for-byte', () => {
  const malformedSettings = '{\n  "env": {\n    "CUSTOM_VALUE": "preserve-me"\n  },\n';
  const malformedProjectConfig = '{\n  "projects": {\n';
  const warnings = [];
  const originalWarn = console.warn;
  writeSettings(malformedSettings);
  fs.writeFileSync(projectConfigPath, malformedProjectConfig, 'utf8');

  console.warn = (...args) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    ensureClaudePermissionsAccepted(cwd);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(fs.readFileSync(settingsPath, 'utf8'), malformedSettings);
  assert.equal(fs.readFileSync(projectConfigPath, 'utf8'), malformedProjectConfig);
  assert.ok(warnings.some((line) => line.includes(settingsPath)));
  assert.ok(warnings.some((line) => line.includes(projectConfigPath)));
});

test('merges required fields into valid configs without losing unrelated data', () => {
  writeSettings(JSON.stringify({
    env: { CUSTOM_VALUE: 'preserve-me' },
    hooks: { example: true }
  }, null, 2));
  fs.writeFileSync(projectConfigPath, JSON.stringify({
    numStartups: 7,
    projects: {
      [cwd]: { allowedTools: ['Read'], custom: 'keep' },
      '/another/project': { hasTrustDialogAccepted: false }
    }
  }, null, 2));

  ensureClaudePermissionsAccepted(cwd);

  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), {
    env: { CUSTOM_VALUE: 'preserve-me' },
    hooks: { example: true },
    skipDangerousModePermissionPrompt: true,
    skipAutoPermissionPrompt: true
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(projectConfigPath, 'utf8')), {
    numStartups: 7,
    projects: withForwardTrust({
      [cwd]: {
        allowedTools: ['Read'],
        custom: 'keep',
        hasTrustDialogAccepted: true
      },
      '/another/project': { hasTrustDialogAccepted: false }
    })
  });
});

test('creates minimal config files when they are missing', () => {
  ensureClaudePermissionsAccepted(cwd);

  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), {
    skipDangerousModePermissionPrompt: true,
    skipAutoPermissionPrompt: true
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(projectConfigPath, 'utf8')), {
    projects: withForwardTrust({ [cwd]: { hasTrustDialogAccepted: true } })
  });
});

test('a malformed settings file does not prevent safe project trust updates', () => {
  const malformedSettings = '{ "preserve": true,';
  writeSettings(malformedSettings);
  fs.writeFileSync(projectConfigPath, JSON.stringify({ custom: 'keep' }), 'utf8');

  ensureClaudePermissionsAccepted(cwd);

  assert.equal(fs.readFileSync(settingsPath, 'utf8'), malformedSettings);
  assert.deepEqual(JSON.parse(fs.readFileSync(projectConfigPath, 'utf8')), {
    custom: 'keep',
    projects: withForwardTrust({ [cwd]: { hasTrustDialogAccepted: true } })
  });
});

test('does not rewrite configs that already contain every required field', () => {
  const settings = '{"skipDangerousModePermissionPrompt":true,"skipAutoPermissionPrompt":true}\n';
  // "Every required field" includes the forward-slash key on Windows.
  const projectConfig = JSON.stringify({
    projects: withForwardTrust({ [cwd]: { hasTrustDialogAccepted: true } })
  }) + '\n';
  writeSettings(settings);
  fs.writeFileSync(projectConfigPath, projectConfig, 'utf8');

  ensureClaudePermissionsAccepted(cwd);
  ensureClaudePermissionsAccepted(cwd);

  assert.equal(fs.readFileSync(settingsPath, 'utf8'), settings);
  assert.equal(fs.readFileSync(projectConfigPath, 'utf8'), projectConfig);
});

test('preserves existing config files with unsafe JSON root shapes', () => {
  writeSettings('null\n');
  fs.writeFileSync(projectConfigPath, '["keep"]\n', 'utf8');

  ensureClaudePermissionsAccepted(cwd);

  assert.equal(fs.readFileSync(settingsPath, 'utf8'), 'null\n');
  assert.equal(fs.readFileSync(projectConfigPath, 'utf8'), '["keep"]\n');
});

test('trusts a Windows folder under the forward-slash spelling Claude reads', () => {
  ensureClaudePermissionsAccepted(winCwd);

  assert.deepEqual(JSON.parse(fs.readFileSync(projectConfigPath, 'utf8')), {
    projects: {
      [winCwdSlashed]: { hasTrustDialogAccepted: true },
      [winCwd]: { hasTrustDialogAccepted: true }
    }
  });
});

test('repairs a Windows folder declined under the raw spelling only', () => {
  fs.writeFileSync(projectConfigPath, JSON.stringify({
    projects: { [winCwd]: { hasTrustDialogAccepted: false, custom: 'keep' } }
  }, null, 2), 'utf8');

  ensureClaudePermissionsAccepted(winCwd);

  const { projects } = JSON.parse(fs.readFileSync(projectConfigPath, 'utf8'));
  assert.equal(projects[winCwdSlashed].hasTrustDialogAccepted, true);
  assert.deepEqual(projects[winCwd], { hasTrustDialogAccepted: true, custom: 'keep' });
});

test('does not rewrite configs already trusted under both Windows spellings', () => {
  const projectConfig = JSON.stringify({
    projects: {
      [winCwdSlashed]: { hasTrustDialogAccepted: true },
      [winCwd]: { hasTrustDialogAccepted: true }
    }
  }) + '\n';
  writeSettings('{"skipDangerousModePermissionPrompt":true,"skipAutoPermissionPrompt":true}\n');
  fs.writeFileSync(projectConfigPath, projectConfig, 'utf8');

  ensureClaudePermissionsAccepted(winCwd);

  assert.equal(fs.readFileSync(projectConfigPath, 'utf8'), projectConfig);
});

// Only meaningful on POSIX: on Windows path.join turns 'a\\b' into an ordinary
// drive path, where the backslash IS the separator and both keys are correct.
test('keeps a POSIX path containing a backslash as a single key', { skip: process.platform === 'win32' && 'backslash is the separator on Windows' }, () => {
  ensureClaudePermissionsAccepted(posixBackslashCwd);

  const { projects } = JSON.parse(fs.readFileSync(projectConfigPath, 'utf8'));
  assert.deepEqual(Object.keys(projects), [posixBackslashCwd]);
  assert.equal(projects[posixBackslashCwd].hasTrustDialogAccepted, true);
});
