'use strict';

/**
 * claudeCliVersion(): the probe behind the Opus 5.5 floor (modelCliFloor.ts).
 *
 * It runs on every Claude spawn, so it caches; and it must never block a spawn,
 * so every failure answers null ("unknown"), which modelForCli treats as "keep
 * the model". What would hurt: caching a failure (a busy machine's one timeout
 * would pin "unknown" for the whole session), or missing an update (an owner
 * who upgrades Claude Code keeps getting the fallback model until a restart).
 * Fixtures are small shell scripts standing in for `claude`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { claudeCliVersion } = loadTs('src/main/claudeCliVersion.ts');

const skip = process.platform === 'win32' ? 'shell-script fixtures' : false;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-cli-version-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A fake `claude` that records each run, then prints `out` (or fails). */
function fakeClaude(name, { out, fail = false }) {
  const bin = path.join(tmp, name);
  const log = `${bin}.runs`;
  fs.writeFileSync(bin, `#!/bin/sh\necho run >> "${log}"\n${fail ? 'exit 3' : `echo "${out}"`}\n`, { mode: 0o755 });
  return { bin, runs: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0) };
}

test('no binary, a missing one, or one that prints no version is "unknown", not an error', { skip }, async () => {
  assert.equal(await claudeCliVersion(null), null);
  assert.equal(await claudeCliVersion(path.join(tmp, 'nope', 'claude')), null);
  assert.equal(await claudeCliVersion(fakeClaude('claude-odd', { out: 'Claude Code (beta)' }).bin), null);
});

test('reads the version, asks once per binary, and notices an update without a restart', { skip }, async () => {
  const c = fakeClaude('claude-ok', { out: '2.1.279 (Claude Code)' });
  assert.equal(await claudeCliVersion(c.bin), '2.1.279');
  assert.equal(await claudeCliVersion(c.bin), '2.1.279');
  assert.equal(c.runs(), 1, 'the second spawn reuses the answer');
  // npm rewrites the file in place: new contents, new mtime.
  fs.writeFileSync(c.bin, '#!/bin/sh\necho "2.1.300 (Claude Code)"\n', { mode: 0o755 });
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(c.bin, later, later);
  assert.equal(await claudeCliVersion(c.bin), '2.1.300');
});

test('a failed probe answers null and is asked again next time', { skip }, async () => {
  const c = fakeClaude('claude-bad', { fail: true });
  assert.equal(await claudeCliVersion(c.bin), null);
  assert.equal(await claudeCliVersion(c.bin), null);
  assert.equal(c.runs(), 2, 'a failure is never cached');
});

test('an installer update that repoints the claude link is noticed too', { skip }, async () => {
  // The native installer switches ~/.local/bin/claude to a new versions/<n>
  // file; the cache key follows the link to its target, so this is seen even
  // when the new target's mtime is OLDER than the old one's.
  const v1 = fakeClaude('claude-v1', { out: '2.1.279 (Claude Code)' });
  const v2 = fakeClaude('claude-v2', { out: '2.1.300 (Claude Code)' });
  const older = new Date(Date.now() - 60_000);
  fs.utimesSync(v2.bin, older, older);
  const link = path.join(tmp, 'claude-link');
  fs.symlinkSync(v1.bin, link);
  assert.equal(await claudeCliVersion(link), '2.1.279');
  fs.unlinkSync(link);
  fs.symlinkSync(v2.bin, link);
  assert.equal(await claudeCliVersion(link), '2.1.300');
});
