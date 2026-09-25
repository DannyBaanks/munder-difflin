'use strict';

/**
 * Office Packs — the three rules that protect an owner from a file they didn't write.
 *
 * A pack decides which agents exist, what they may reach, and how far they may go
 * without asking. It can arrive from a group chat. So:
 *
 *   1. CORE SURVIVES     — a business pack cannot drop Oscar. Finance applies to
 *                          every business, so the core agents merge in whether or
 *                          not the pack author remembered them.
 *   2. IMPORTS ARE CAPPED — anything that did not ship inside the app has every
 *                          outward capability forced to 'ask' AT LOAD TIME. The
 *                          scenario under test is literal: a "free restaurant
 *                          pack" link that sets Pam's send to 'auto'.
 *   3. UNKNOWN IS FATAL  — a field this build cannot honour is an error, because
 *                          the owner would otherwise believe a setting applied.
 *
 * Override semantics are asserted too: an id collision REPLACES the core agent
 * rather than deep-merging it, because a half-merged permission set is exactly
 * the ambiguity that ends with an owner believing a capability is off when it is on.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  OFFICE_PACK_SPEC_V1,
  OFFICE_PACK_VERSION,
  mergeWithCore,
  validateOfficePack
} = loadTs('src/shared/officePack.ts');
const { levelFor } = loadTs('src/shared/agentDefinition.ts');

const agent = (id, over = {}) => ({
  id,
  role: 'Admin',
  summary: `${id} does a job an owner understands.`,
  does: ['Something useful'],
  wontDo: ['Something risky'],
  connections: [],
  tools: [{ capability: 'email.read', level: 'auto' }],
  ...over
});

const hours = () => ({
  days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
  work: { start: '09:00', end: '22:00' },
  pauses: [{ start: '11:30', end: '13:30', label: 'rush hours' }]
});

const pack = (over = {}) => ({
  spec: OFFICE_PACK_SPEC_V1,
  businessType: 'restaurant-food',
  displayName: 'Restaurant & Food',
  tagline: 'cafe, catering, food truck',
  glyph: 'bowl',
  extends: 'core',
  agents: [agent('pam')],
  defaultPicks: ['pam'],
  officeHours: hours(),
  ...over
});

const corePack = (over = {}) => ({
  spec: OFFICE_PACK_SPEC_V1,
  businessType: 'core',
  displayName: 'Core',
  tagline: 'every business needs these',
  agents: [agent('oscar', { role: 'Finance' })],
  defaultPicks: ['oscar'],
  officeHours: hours(),
  ...over
});

test('a bundled pack validates and keeps the levels it declares', () => {
  const res = validateOfficePack(
    pack({ agents: [agent('ryan', { tools: [{ capability: 'social.post', level: 'auto' }] })], defaultPicks: ['ryan'] }),
    'bundled'
  );
  assert.equal(res.ok, true, res.errors.join('; '));
  assert.equal(levelFor(res.pack.agents[0], 'social.post'), 'auto');
});

test('an imported pack cannot grant unattended outward access', () => {
  // The group-chat scenario: a shared link that sets sending to "on its own".
  const res = validateOfficePack(
    pack({
      agents: [
        agent('pam', {
          tools: [
            { capability: 'email.read', level: 'auto' },
            { capability: 'email.send', level: 'auto' }
          ]
        })
      ]
    }),
    'imported'
  );
  assert.equal(res.ok, true, res.errors.join('; '));
  assert.equal(levelFor(res.pack.agents[0], 'email.send'), 'ask', 'sending must drop to ask on import');
  assert.equal(levelFor(res.pack.agents[0], 'email.read'), 'auto', 'reads are not capped');
});

test('a pack with the wrong spec is refused', () => {
  const res = validateOfficePack(pack({ spec: 'munder-difflin/hire@1' }), 'bundled');
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /unsupported spec/);
});

test('a pack from a newer build is refused with a plain message', () => {
  const res = validateOfficePack(pack({ schemaVersion: OFFICE_PACK_VERSION + 1 }), 'bundled');
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /update the app/);
});

test('strict validation rejects an unknown top-level field', () => {
  const res = validateOfficePack(pack({ futureKnob: true }), 'bundled');
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /unknown field/);
});

test('a defaultPick naming an agent the pack does not define is an error', () => {
  const res = validateOfficePack(pack({ defaultPicks: ['pam', 'kelly'] }), 'bundled');
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /kelly/);
});

test('a starter mission for an undefined agent is an error', () => {
  const res = validateOfficePack(
    pack({ starterMissions: [{ agentId: 'creed', title: 'Opening checklist', schedule: 'mon 09:00' }] }),
    'bundled'
  );
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /creed/);
});

test('office hours must carry real times and at least one day', () => {
  const badTime = validateOfficePack(pack({ officeHours: { ...hours(), work: { start: '9am', end: '22:00' } } }), 'bundled');
  assert.equal(badTime.ok, false);
  assert.match(badTime.errors.join(' '), /HH:MM/);

  const noDays = validateOfficePack(pack({ officeHours: { ...hours(), days: [] } }), 'bundled');
  assert.equal(noDays.ok, false);
  assert.match(noDays.errors.join(' '), /at least one day/);
});

test('core agents merge into a business pack that never mentions them', () => {
  const business = validateOfficePack(pack(), 'bundled').pack;
  const core = validateOfficePack(corePack(), 'bundled').pack;
  const merged = mergeWithCore(business, core);

  const ids = merged.agents.map((a) => a.id);
  assert.deepEqual(ids.sort(), ['oscar', 'pam'], 'Oscar arrives without the pack asking');
  assert.ok(merged.defaultPicks.includes('oscar'), 'and is pre-checked on the team screen');
});

test('a business pack may tune a core agent by id, replacing it wholesale', () => {
  const business = validateOfficePack(
    pack({
      agents: [
        agent('pam'),
        agent('oscar', {
          role: 'Finance',
          summary: 'Watches food cost and supplier invoices.',
          tools: [{ capability: 'books.write', level: 'ask' }]
        })
      ],
      defaultPicks: ['pam', 'oscar']
    }),
    'bundled'
  ).pack;
  const core = validateOfficePack(corePack(), 'bundled').pack;
  const merged = mergeWithCore(business, core);

  const oscar = merged.agents.filter((a) => a.id === 'oscar');
  assert.equal(oscar.length, 1, 'one Oscar, not two');
  assert.match(oscar[0].summary, /food cost/, 'the industry version wins');
  assert.equal(levelFor(oscar[0], 'email.read'), 'off', 'no deep merge: the core levels do not leak through');
});

test('merging the core pack with itself changes nothing', () => {
  const core = validateOfficePack(corePack(), 'bundled').pack;
  assert.equal(mergeWithCore(core, core), core);
});

test('a pack with no agents is refused', () => {
  const res = validateOfficePack(pack({ agents: [], defaultPicks: [] }), 'bundled');
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /at least one agent/);
});

// ─── Coverage audit additions: validator branches the rules above don't reach ──

test('a pack that is not a JSON object is refused before anything else is read', () => {
  for (const raw of [null, undefined, 'pack', 42, [pack()]]) {
    const res = validateOfficePack(raw, 'bundled');
    assert.equal(res.ok, false);
    assert.match(res.errors.join(' '), /JSON object/);
  }
});

test('a malformed schemaVersion is refused with a plain message', () => {
  for (const schemaVersion of [0, -1, 1.5, '1', null]) {
    const res = validateOfficePack(pack({ schemaVersion }), 'bundled');
    assert.equal(res.ok, false, `schemaVersion ${JSON.stringify(schemaVersion)} must be refused`);
    assert.match(res.errors.join(' '), /positive integer/);
  }
});

test('identity fields: businessType, displayName and tagline are required and shaped', () => {
  const cases = [
    [{ businessType: undefined }, /"businessType" is required/],
    [{ businessType: 'Restaurant Food' }, /businessType/],
    [{ displayName: undefined }, /"displayName" is required/],
    [{ displayName: 'x'.repeat(41) }, /displayName.*exceeds 40/],
    [{ tagline: '   ' }, /"tagline" must not be empty/],
    [{ glyph: 'Bowl!' }, /glyph/],
    [{ extends: 'restaurant' }, /"extends" must be "core"/]
  ];
  for (const [over, re] of cases) {
    const res = validateOfficePack(pack(over), 'bundled');
    assert.equal(res.ok, false, `${JSON.stringify(over)} must be refused`);
    assert.match(res.errors.join(' '), re);
  }
});

test('agent problems are refused and point at the offending agent', () => {
  const bad = validateOfficePack(pack({ agents: [agent('pam'), { id: 'kelly' }] }), 'bundled');
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /agents\[1\]:/, 'the error must say which agent is broken');

  const dup = validateOfficePack(pack({ agents: [agent('pam'), agent('pam')] }), 'bundled');
  assert.equal(dup.ok, false);
  assert.match(dup.errors.join(' '), /duplicate ids/);

  const many = Array.from({ length: 13 }, (_, i) => agent(`a${i}`));
  const tooMany = validateOfficePack(pack({ agents: many, defaultPicks: [] }), 'bundled');
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.errors.join(' '), /at most 12/);
});

test('office hours reject a non-object, an unknown day and a malformed pause', () => {
  const notObj = validateOfficePack(pack({ officeHours: 'always' }), 'bundled');
  assert.equal(notObj.ok, false);
  assert.match(notObj.errors.join(' '), /"officeHours" must be an object/);

  const badDay = validateOfficePack(pack({ officeHours: { ...hours(), days: ['mon', 'funday'] } }), 'bundled');
  assert.equal(badDay.ok, false);
  assert.match(badDay.errors.join(' '), /officeHours\.days\[1\]/);

  const badPause = validateOfficePack(
    pack({ officeHours: { ...hours(), pauses: [{ start: '11:30', end: '25:00' }] } }),
    'bundled'
  );
  assert.equal(badPause.ok, false);
  assert.match(badPause.errors.join(' '), /officeHours\.pauses\[0\]\.end/);

  const noWork = validateOfficePack(pack({ officeHours: { ...hours(), work: undefined } }), 'bundled');
  assert.equal(noWork.ok, false);
  assert.match(noWork.errors.join(' '), /officeHours\.work/);
});

test('valid starter missions survive validation; a non-object mission is refused', () => {
  const ok = validateOfficePack(
    pack({ starterMissions: [{ agentId: 'pam', title: 'Sort the inbox', schedule: 'mon 09:00' }] }),
    'bundled'
  );
  assert.equal(ok.ok, true, ok.errors.join('; '));
  assert.deepEqual(ok.pack.starterMissions, [{ agentId: 'pam', title: 'Sort the inbox', schedule: 'mon 09:00' }]);
  assert.equal(ok.pack.glyph, 'bowl');
  assert.equal(ok.pack.extends, 'core');

  const bad = validateOfficePack(pack({ starterMissions: ['sort the inbox'] }), 'bundled');
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /starterMissions\[0\]" must be an object/);
});

test('lenient strictness lets an unknown pack field through without carrying it', () => {
  const res = validateOfficePack(pack({ futureKnob: true }), 'bundled', 'lenient');
  assert.equal(res.ok, true, res.errors.join('; '));
  assert.equal('futureKnob' in res.pack, false);
});

test('mergeWithCore does not force-pick an overridden core agent, and does not mutate inputs', () => {
  // The business pack restates Oscar but leaves him unpicked: that is the pack
  // author's call, and only INHERITED core agents are auto-picked.
  const business = validateOfficePack(
    pack({ agents: [agent('pam'), agent('oscar', { role: 'Finance' })], defaultPicks: ['pam'] }),
    'bundled'
  ).pack;
  const core = validateOfficePack(corePack(), 'bundled').pack;
  const businessBefore = JSON.stringify(business);
  const coreBefore = JSON.stringify(core);

  const merged = mergeWithCore(business, core);
  assert.deepEqual(merged.defaultPicks, ['pam']);
  assert.equal(JSON.stringify(business), businessBefore, 'the business pack is not mutated');
  assert.equal(JSON.stringify(core), coreBefore, 'the core pack is not mutated');
});
