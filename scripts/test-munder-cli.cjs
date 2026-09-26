#!/usr/bin/env node
'use strict';
// `node scripts/test-munder-cli.cjs`, the same on every OS. The munder CLI
// suites used to be listed file by file in ci.yml, and that manual list
// silently skipped panel-remote for a whole release cycle (#39 -> #40): a new
// tools/munder/*.test.cjs ran zero times in CI unless someone remembered to
// edit the YAML. This discovers the files instead, so omission is impossible
// by construction (same reason scripts/test-focused.cjs lists test/ instead
// of relying on shell globs, which Windows does not expand).
// Exclusions, if ever needed again, go in EXCLUDE below with reason + date —
// never by deleting a file from a list.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
// No exclusions today (2026-09-26): every tools/munder/*.test.cjs runs,
// including proveedor (M1: sandboxed, re-admitted 2026-09-26) and harness-p0
// (self-skips without HARNESS_P0_BIN but stays load-checked).
const EXCLUDE = [];
const files = fs.readdirSync(path.join(root, 'tools', 'munder'))
  .filter((f) => f.endsWith('.test.cjs') && !EXCLUDE.includes(f))
  .sort()
  .map((f) => path.join('tools', 'munder', f));
console.log(`munder CLI suites (${files.length}): ${files.join(' ')}`);
const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
