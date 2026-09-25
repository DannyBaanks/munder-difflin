'use strict';

/**
 * The pack loader — getting packs off disk without letting one bad file
 * empty the first screen an owner ever sees.
 *
 * `office-pack.test.cjs` covers the FORMAT rules and `office-pack-fixtures.test.cjs`
 * covers the files we ship. This file covers the part in between: reading a
 * directory that may contain a file someone hand-edited, a file that is not a
 * pack at all, or no core pack.
 *
 * The behaviour under test is the failure posture. Onboarding's first screen is
 * a grid of business types. If a single malformed JSON file could throw out of
 * the loader, that grid comes up empty and a restaurant owner's first run is a
 * dead end with nothing to click. So: per-file isolation, every skip reported.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { loadBundledPacks, loadImportedPack, packsResourceDir } = loadTs('src/main/packs.ts');
const { levelFor } = loadTs('src/shared/agentDefinition.ts');

const REAL_PACKS = path.resolve(__dirname, '..', 'resources', 'packs');
const readReal = (file) => JSON.parse(fs.readFileSync(path.join(REAL_PACKS, file), 'utf8'));

/** A throwaway packs dir. Files are written as given, including deliberately broken ones. */
function withDir(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const deps = (dir) => ({ packsDir: () => dir });

test('the real bundled packs load, merged with core, with nothing reported', () => {
  const res = loadBundledPacks(deps(REAL_PACKS));
  assert.deepEqual(res.problems, [], 'the packs we ship must load cleanly');
  assert.ok(res.packs.length >= 1);

  const types = res.packs.map((p) => p.pack.businessType);
  assert.ok(!types.includes('core'), 'core is merged in, never offered as a business type');
  for (const { pack, origin } of res.packs) {
    assert.equal(origin, 'bundled');
    assert.ok(pack.agents.some((a) => a.id === 'oscar'), `${pack.businessType} lost finance`);
  }
});

test('one malformed file is skipped and named, the rest still load', () => {
  withDir(
    {
      'core.json': readReal('core.json'),
      'restaurant-food.json': readReal('restaurant-food.json'),
      'broken.json': '{ this is not json'
    },
    (dir) => {
      const res = loadBundledPacks(deps(dir));
      assert.equal(res.packs.length, 1, 'the good pack survives its broken neighbour');
      assert.equal(res.packs[0].pack.businessType, 'restaurant-food');
      assert.equal(res.problems.length, 1);
      assert.equal(res.problems[0].file, 'broken.json');
      assert.ok(res.problems[0].reason.length > 0, 'a skip without a reason is not debuggable');
    }
  );
});

test('a file that is valid JSON but not a pack is reported, not thrown', () => {
  withDir({ 'core.json': readReal('core.json'), 'notes.json': { hello: 'world' } }, (dir) => {
    const res = loadBundledPacks(deps(dir));
    assert.deepEqual(res.packs, []);
    assert.equal(res.problems.length, 1);
    assert.equal(res.problems[0].file, 'notes.json');
  });
});

test('business packs still load when core is missing, and the gap is reported', () => {
  withDir({ 'restaurant-food.json': readReal('restaurant-food.json') }, (dir) => {
    const res = loadBundledPacks(deps(dir));
    assert.equal(res.packs.length, 1, 'an office without core beats no office at all');
    assert.ok(
      res.problems.some((p) => p.file === 'core.json' && /missing/.test(p.reason)),
      'the missing core pack must be reported'
    );
  });
});

test('a missing packs directory is a reported problem, not a crash', () => {
  const res = loadBundledPacks(deps(path.join(os.tmpdir(), 'no-such-packs-dir-' + Date.now())));
  assert.deepEqual(res.packs, []);
  assert.equal(res.problems.length, 1);
});

test('non-JSON files in the directory are ignored entirely', () => {
  withDir({ 'core.json': readReal('core.json'), 'README.md': '# packs', '.DS_Store': 'junk' }, (dir) => {
    const res = loadBundledPacks(deps(dir));
    assert.deepEqual(res.problems, [], 'a README beside the packs is not a problem to report');
    assert.deepEqual(res.packs, []);
  });
});

test('an imported pack is capped even when it arrives through the loader', () => {
  // Same group-chat scenario as office-pack.test.cjs, but via the entry point
  // the import UI actually calls — the cap must not live only in the validator's
  // unit test.
  const restaurant = readReal('restaurant-food.json');
  const pam = restaurant.agents.find((a) => a.id === 'pam');
  pam.tools = pam.tools.map((t) => (t.capability === 'email.send' ? { ...t, level: 'auto' } : t));

  const res = loadImportedPack(restaurant);
  assert.deepEqual(res.errors, []);
  const loaded = res.pack.agents.find((a) => a.id === 'pam');
  assert.equal(levelFor(loaded, 'email.send'), 'ask', 'an imported pack cannot grant unattended sending');
  assert.equal(levelFor(loaded, 'email.read'), 'auto', 'reading is not capped');
});

test('an invalid imported pack returns errors and no pack', () => {
  const res = loadImportedPack({ spec: 'something/else@1' });
  assert.equal(res.pack, undefined);
  assert.ok(res.errors.length > 0);
});

test('the packs directory resolves the same way skills do', () => {
  const app = { isPackaged: false, getAppPath: () => '/repo' };
  assert.equal(packsResourceDir(app, '/ignored'), path.join('/repo', 'resources', 'packs'));
  assert.equal(
    packsResourceDir({ ...app, isPackaged: true }, '/App/Contents/Resources'),
    path.join('/App/Contents/Resources', 'packs')
  );
});

// ─── Coverage audit additions: the loader's remaining failure branches ────────

test('a broken core pack (malformed or invalid) is reported, and business packs still load', () => {
  withDir(
    { 'core.json': '{ not json', 'restaurant-food.json': readReal('restaurant-food.json') },
    (dir) => {
      const res = loadBundledPacks(deps(dir));
      assert.equal(res.packs.length, 1, 'a broken core must not take the business packs down');
      assert.equal(res.packs[0].pack.businessType, 'restaurant-food');
      assert.equal(res.problems.length, 1);
      assert.equal(res.problems[0].file, 'core.json');
    }
  );

  withDir(
    { 'core.json': { ...readReal('core.json'), futureKnob: true }, 'restaurant-food.json': readReal('restaurant-food.json') },
    (dir) => {
      const res = loadBundledPacks(deps(dir));
      assert.equal(res.packs.length, 1);
      assert.equal(res.problems.length, 1);
      assert.equal(res.problems[0].file, 'core.json');
      assert.match(res.problems[0].reason, /unknown field/);
    }
  );
});

test('an oversized pack file is refused by size, before it is parsed', () => {
  // Valid JSON padded past the 256KB cap: the refusal must come from the size
  // check, not from a parse error or a validation error.
  const huge = JSON.stringify({ pad: 'x'.repeat(300 * 1024) });
  withDir({ 'core.json': readReal('core.json'), 'huge.json': huge }, (dir) => {
    const res = loadBundledPacks(deps(dir));
    assert.deepEqual(res.packs, []);
    assert.equal(res.problems.length, 1);
    assert.equal(res.problems[0].file, 'huge.json');
    assert.match(res.problems[0].reason, /larger than 256KB/);
  });
});

test('a packs path that is a file, not a directory, is reported rather than thrown', () => {
  withDir({ 'not-a-dir.json': '{}' }, (dir) => {
    const file = path.join(dir, 'not-a-dir.json');
    const res = loadBundledPacks(deps(file));
    assert.deepEqual(res.packs, []);
    assert.equal(res.problems.length, 1);
    assert.equal(res.problems[0].file, file);
    assert.ok(res.problems[0].reason.length > 0);
  });
});

test('an imported pack given core gets core merged in, and the cap still holds', () => {
  const core = loadTs('src/shared/officePack.ts').validateOfficePack(readReal('core.json'), 'bundled').pack;
  const restaurant = readReal('restaurant-food.json');
  // Drop the restaurant's own Oscar so the merged one must come from core.
  restaurant.agents = restaurant.agents.filter((a) => a.id !== 'oscar');
  restaurant.defaultPicks = restaurant.defaultPicks.filter((id) => id !== 'oscar');
  restaurant.starterMissions = (restaurant.starterMissions || []).filter((m) => m.agentId !== 'oscar');
  if (!restaurant.starterMissions.length) delete restaurant.starterMissions;
  const pam = restaurant.agents.find((a) => a.id === 'pam');
  pam.tools = pam.tools.map((t) => (t.capability === 'email.send' ? { ...t, level: 'auto' } : t));

  const res = loadImportedPack(restaurant, core);
  assert.deepEqual(res.errors, []);
  assert.ok(res.pack.agents.some((a) => a.id === 'oscar'), 'core finance is merged into an import');
  assert.ok(res.pack.defaultPicks.includes('oscar'));
  assert.equal(levelFor(res.pack.agents.find((a) => a.id === 'pam'), 'email.send'), 'ask');
});
