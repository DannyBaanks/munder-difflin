'use strict';

/**
 * "Buscar actualizaciones" on the fork.
 *
 * Three things kept the button from ever finding anything:
 *  1. every non-native path (the release poll, release notes, manual download
 *     links, the openRelease guard) pointed at the UPSTREAM repo while
 *     electron-builder's `publish` pointed at the fork;
 *  2. the fork tags every release -ISyCo.N, the release workflow published those
 *     as pre-releases, and the poll asked /releases/latest, which skips them;
 *  3. run from source (./start.sh, munder start) the handler answered an error
 *     that no screen rendered, so the click did nothing at all.
 * And isNewer ignores the suffix, so ISyCo.2 never read as newer than ISyCo.1.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const { REPO, isNewerBuild, pendingVersion } = loadTs('src/shared/updateState.ts');

test('the updater polls the same repo electron-builder publishes to', () => {
  const yml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  const block = yml.slice(yml.indexOf('\npublish:'), yml.indexOf('\npublish:') + 200);
  const owner = /owner:\s*(\S+)/.exec(block)[1];
  const repo = /repo:\s*(\S+)/.exec(block)[1];
  assert.equal(REPO, `${owner}/${repo}`);
  const updater = fs.readFileSync(path.join(root, 'src/main/updater.ts'), 'utf8');
  assert.ok(!/const REPO = /.test(updater), 'updater.ts uses the shared REPO, no second copy');
});

test('isNewerBuild: the fork counter counts, an -rc does not, and upstream order still holds', () => {
  assert.equal(isNewerBuild('v0.5.2-ISyCo.2', '0.5.2-ISyCo.1'), true);
  assert.equal(isNewerBuild('0.5.2-ISyCo.10', '0.5.2-ISyCo.9'), true);
  assert.equal(isNewerBuild('0.5.2-ISyCo.1', '0.5.2-ISyCo.1'), false);
  assert.equal(isNewerBuild('0.5.2-ISyCo.1', '0.5.2-ISyCo.2'), false);
  assert.equal(isNewerBuild('0.5.3-ISyCo.1', '0.5.2-ISyCo.7'), true);
  assert.equal(isNewerBuild('0.5.1-ISyCo.9', '0.5.2-ISyCo.1'), false);
  assert.equal(isNewerBuild('0.4.7-rc.2', '0.4.7-rc.1'), false, 'rc behaviour unchanged');
  assert.equal(pendingVersion({ state: 'available-manual', version: '0.5.2-ISyCo.2', url: 'u' }, '0.5.2-ISyCo.1'), '0.5.2-ISyCo.2');
});

// ─── updater.ts with a fake electron and a fake GitHub ──────────────────────
const handlers = new Map();
const sent = [];
let releases = [];
let httpStatus = 200;
const fakeElectron = {
  app: { isPackaged: false, getVersion: () => '0.5.2-ISyCo.1', getPath: () => fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'upd-')) },
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
  shell: { openExternal: async () => {} },
};
const fakeHttps = {
  request: (opts, onRes) => {
    const req = new EventEmitter();
    req.end = () => setImmediate(() => {
      const res = new EventEmitter();
      res.statusCode = httpStatus;
      res.setEncoding = () => {};
      onRes(res);
      res.emit('data', JSON.stringify(releases));
      res.emit('end');
      req.lastPath = opts.path;
    });
    req.destroy = () => {};
    fakeHttps.last = opts;
    return req;
  },
};
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return fakeElectron;
  if (request === 'node:https') return fakeHttps;
  return realLoad.call(this, request, ...rest);
};
const U = loadTs('src/main/updater.ts');
Module._load = realLoad;
U.initAutoUpdater(() => ({ send: (_ch, status) => sent.push(status) }));
const release = (tag, extra = {}) => ({ tag_name: tag, html_url: `https://github.com/${REPO}/releases/tag/${tag}`, draft: false, prerelease: true, assets: [], ...extra });

test('pickLatestRelease reads the list (fork builds are pre-releases), skips drafts and test builds', () => {
  const pick = U.pickLatestRelease([
    release('v0.5.3-rc.1'),
    release('v0.5.2-ISyCo.3', { draft: true }),
    release('v0.5.2-ISyCo.2'),
    release('v0.5.2-ISyCo.1'),
  ]);
  assert.equal(pick.tag_name, 'v0.5.2-ISyCo.2');
  assert.equal(U.pickLatestRelease({ message: 'Not Found' }), null);
  assert.equal(U.pickLatestRelease([]), null);
});

// Order matters: the status reducer keeps a found newer build on screen, so the
// quiet cases run before the one that finds something.
test('run from source: up to date says so', async () => {
  releases = [release('v0.5.2-ISyCo.1')];
  sent.length = 0;
  await handlers.get('update:checkNow')();
  assert.equal(sent[sent.length - 1].state, 'not-available');
});

test('run from source: a failed poll shows the error instead of doing nothing', async () => {
  httpStatus = 403;
  sent.length = 0;
  const r = await handlers.get('update:checkNow')();
  httpStatus = 200;
  assert.equal(r.ok, false);
  assert.equal(sent[sent.length - 1].state, 'error');
  assert.match(sent[sent.length - 1].message, /HTTP 403/);
});

test('run from source, "Buscar actualizaciones" always answers: a newer fork build', async () => {
  releases = [release('v0.5.2-ISyCo.2'), release('v0.5.2-ISyCo.1')];
  sent.length = 0;
  const r = await handlers.get('update:checkNow')();
  assert.equal(r.ok, true);
  assert.match(fakeHttps.last.path, new RegExp(`^/repos/${REPO}/releases\\?`), 'the list, not /releases/latest');
  assert.equal(sent[0].state, 'checking');
  const last = sent[sent.length - 1];
  assert.equal(last.state, 'available-manual');
  assert.equal(last.version, '0.5.2-ISyCo.2');
  assert.match(last.reason, /git pull/);
});

test('the release page of the fork opens; anything else is still refused', async () => {
  assert.deepEqual(await handlers.get('update:openRelease')(null, `https://github.com/${REPO}/releases/tag/v0.5.2-ISyCo.2`), { ok: true });
  assert.deepEqual(await handlers.get('update:openRelease')(null, 'https://evil.example/releases'), { ok: false });
});

test('the release workflow only marks -rc/-beta/-alpha as pre-releases, not the fork builds', () => {
  const wf = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  const line = wf.split('\n').find((l) => /^\s*prerelease:/.test(l));
  assert.ok(line, 'prerelease flag present');
  assert.doesNotMatch(line, /contains\(github\.ref_name, '-'\)/, 'a bare "-" would catch -ISyCo.N');
  for (const k of ['-rc', '-beta', '-alpha']) assert.ok(line.includes(k), k);
});
