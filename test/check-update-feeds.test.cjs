'use strict';
// scripts/check-update-feeds.mjs: the Community and Pro update feeds never
// cross. Positive control first (Darryl's rule): the September 2026 crossover,
// Pro files on the GitHub release, must make the check fail.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { writeFileSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const community = `version: 0.5.3
files:
  - url: Munder-Difflin-Community-0.5.3-mac-universal.zip
    sha512: aaa
    size: 1
path: Munder-Difflin-Community-0.5.3-mac-universal.zip
sha512: aaa
releaseDate: '2026-09-25T00:00:00.000Z'
`;
const pro = community.replaceAll('Munder-Difflin-Community-', 'Munder-Difflin-');

async function load() { return import('../scripts/check-update-feeds.mjs'); }

test('positive control: the v0.5.2 crossover (Pro yml on the GitHub release) fails', async () => {
  const { crossFeedProblems } = await load();
  const problems = crossFeedProblems(pro, pro);
  assert.ok(problems.some((p) => p.startsWith('community feed points at a non Community file')), problems.join('; '));
  assert.ok(problems.some((p) => p.startsWith('the same file is on both feeds')), problems.join('; '));
});

test('a clean pair passes, and each direction of crossover is named', async () => {
  const { crossFeedProblems } = await load();
  assert.deepEqual(crossFeedProblems(community, pro), []);
  assert.ok(crossFeedProblems(community, community).some((p) => p.startsWith('pro feed points at a Community file')));
  assert.ok(crossFeedProblems('', pro).includes('community yml names no files'));
});

test('the script exits 1 on the crossover fixture and 0 on the clean pair', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feeds-'));
  const c = join(dir, 'community.yml'); const p = join(dir, 'pro.yml');
  writeFileSync(c, community); writeFileSync(p, pro);
  const script = join(__dirname, '..', 'scripts', 'check-update-feeds.mjs');
  const bad = spawnSync(process.execPath, [script, p, p], { encoding: 'utf8' });
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  const good = spawnSync(process.execPath, [script, c, p], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /no crossover/);
});
