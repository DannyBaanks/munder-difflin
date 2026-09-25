'use strict';

/**
 * The packs we actually ship.
 *
 * `office-pack.test.cjs` proves the validator's rules with hand-built objects.
 * This file proves the REAL files in `resources/packs/` satisfy them, because a
 * malformed bundled pack is not a unit-test failure — it is a restaurant owner
 * reaching an empty team screen on their first run, with no way to recover.
 *
 * It also locks two product promises that live in the fixture data rather than
 * in code:
 *
 *   - Oscar is in every pack (the core pack supplies him; a business pack may
 *     tune him but the merged result must always contain finance).
 *   - Nothing that leaves the building ships pre-set to "On its own". Bundled
 *     packs are ALLOWED to do that by Decision 7, so only a test keeps the
 *     shipped defaults conservative: an owner turns sending on deliberately,
 *     never by accepting a default they never read.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { mergeWithCore, validateOfficePack } = loadTs('src/shared/officePack.ts');
const { OUTWARD_CAPABILITIES, levelFor } = loadTs('src/shared/agentDefinition.ts');

const PACKS_DIR = path.resolve(__dirname, '..', 'resources', 'packs');
const readPack = (file) => JSON.parse(fs.readFileSync(path.join(PACKS_DIR, file), 'utf8'));

const packFiles = () =>
  fs.existsSync(PACKS_DIR) ? fs.readdirSync(PACKS_DIR).filter((f) => f.endsWith('.json')) : [];

test('every shipped pack validates as bundled', () => {
  const files = packFiles();
  assert.ok(files.length >= 2, `expected bundled packs in resources/packs, found ${files.length}`);
  for (const file of files) {
    const res = validateOfficePack(readPack(file), 'bundled');
    assert.equal(res.ok, true, `${file}: ${res.errors.join('; ')}`);
  }
});

test('the core pack exists, defines finance, and extends nothing', () => {
  const res = validateOfficePack(readPack('core.json'), 'bundled');
  assert.equal(res.ok, true, res.errors.join('; '));
  assert.equal(res.pack.businessType, 'core');
  assert.equal(res.pack.extends, undefined, 'the core pack cannot extend itself');
  assert.ok(
    res.pack.agents.some((a) => a.id === 'oscar'),
    'core supplies Oscar, which is what puts finance in every pack'
  );
});

test('a business pack merged with core always carries finance', () => {
  const core = validateOfficePack(readPack('core.json'), 'bundled').pack;
  for (const file of packFiles().filter((f) => f !== 'core.json')) {
    const business = validateOfficePack(readPack(file), 'bundled').pack;
    const merged = mergeWithCore(business, core);
    assert.ok(
      merged.agents.some((a) => a.id === 'oscar'),
      `${file}: merged pack lost finance`
    );
    assert.ok(merged.defaultPicks.includes('oscar'), `${file}: finance is not pre-checked`);
  }
});

test('the restaurant pack tunes Oscar for the industry rather than inheriting the generic one', () => {
  const core = validateOfficePack(readPack('core.json'), 'bundled').pack;
  const restaurant = validateOfficePack(readPack('restaurant-food.json'), 'bundled').pack;
  const merged = mergeWithCore(restaurant, core);
  const oscar = merged.agents.filter((a) => a.id === 'oscar');
  assert.equal(oscar.length, 1, 'exactly one Oscar survives the merge');
  assert.match(oscar[0].summary, /food cost/, 'the restaurant version is the one that survives');
});

test('the restaurant pack ships the full starter cast', () => {
  const core = validateOfficePack(readPack('core.json'), 'bundled').pack;
  const restaurant = validateOfficePack(readPack('restaurant-food.json'), 'bundled').pack;
  const ids = mergeWithCore(restaurant, core).agents.map((a) => a.id).sort();
  assert.deepEqual(ids, ['creed', 'kelly', 'meredith', 'oscar', 'pam', 'ryan', 'toby']);
});

test('no shipped pack pre-sets an outward capability to on-its-own', () => {
  for (const file of packFiles()) {
    const res = validateOfficePack(readPack(file), 'bundled');
    for (const agent of res.pack.agents) {
      for (const cap of OUTWARD_CAPABILITIES) {
        assert.notEqual(
          levelFor(agent, cap),
          'auto',
          `${file}: ${agent.id} ships with ${cap} on its own — an owner must turn that on deliberately`
        );
      }
    }
  }
});

test('every agent states a first action, so the floor is never blank on day one', () => {
  for (const file of packFiles()) {
    const res = validateOfficePack(readPack(file), 'bundled');
    for (const agent of res.pack.agents) {
      assert.ok(
        agent.firstAction && agent.firstAction.length > 0,
        `${file}: ${agent.id} has no firstAction, so its card would show nothing on first run`
      );
    }
  }
});

test('every connection an agent needs is named, so the needs-chips can be rendered', () => {
  for (const file of packFiles()) {
    const res = validateOfficePack(readPack(file), 'bundled');
    for (const agent of res.pack.agents) {
      for (const conn of agent.connections) {
        assert.match(conn.id, /^[a-z0-9][a-z0-9-]*$/, `${file}: ${agent.id} has a malformed connection id`);
      }
    }
  }
});

test('every shipped agent names the folder it will work in (Decision 47)', () => {
  const { FOLDER_NAME_RE } = loadTs('src/shared/agentDefinition.ts');
  for (const file of packFiles()) {
    const res = validateOfficePack(readPack(file), 'bundled');
    for (const agent of res.pack.agents) {
      assert.ok(agent.folder, `${file}: ${agent.id} has no folder, so onboarding has nothing to suggest`);
      assert.match(agent.folder, FOLDER_NAME_RE, `${file}: ${agent.id} folder is not a safe name`);
    }
  }
});

test('every character keeps the same job in every business type (the owner\'s rule)', () => {
  // Oscar is always finance, Dwight always sales, Kelly always customer support…
  // A business type picks WHICH characters join and how each job reads for that
  // trade; it never gives a character a different job. The folder follows the job.
  const { OFFICE_ROLES } = loadTs('src/shared/officeRoles.ts');
  for (const file of packFiles()) {
    for (const agent of validateOfficePack(readPack(file), 'bundled').pack.agents) {
      const canon = OFFICE_ROLES[agent.character];
      assert.ok(canon, `${file}: ${agent.character} is not in the Office role map`);
      assert.equal(agent.id, agent.character, `${file}: ${agent.id} must be named after its character`);
      assert.equal(agent.role, canon.role, `${file}: ${agent.character} must be ${canon.role}, not ${agent.role}`);
      assert.equal(agent.folder, canon.folder, `${file}: ${agent.character}'s folder must be ${canon.folder}`);
    }
  }
});
