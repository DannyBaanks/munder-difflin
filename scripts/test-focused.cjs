#!/usr/bin/env node
'use strict';
// `npm run test:focused`, the same on every OS. The script used to be
// `node --test test/*.test.cjs`, but npm runs scripts through cmd.exe on
// Windows, which does not expand globs, and Node 20's test runner does not
// either: on Windows the suite never started. List the files here instead.
// Extra args pass through (e.g. `npm run test:focused -- --test-reporter=spec`).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'test'))
  .filter((f) => f.endsWith('.test.cjs'))
  .sort()
  .map((f) => path.join('test', f));
const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('-'));
const only = args.filter((a) => !a.startsWith('-'));
const r = spawnSync(process.execPath, ['--test', ...flags, ...(only.length ? only : files)], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
