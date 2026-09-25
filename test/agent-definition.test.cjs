'use strict';

/**
 * Agent Definition v2 — the owner-facing contract.
 *
 * Every assertion here stands for a promise the product makes on screen:
 *
 *   - "Off means off"       → a capability absent from `tools` reads as 'off',
 *                             so a missing entry can never mean "allowed".
 *   - "you decide"          → a duplicated capability is rejected rather than
 *                             resolved, because either resolution would show the
 *                             owner one level while the broker enforced another.
 *   - "update the app"      → a record written by a newer build is refused with a
 *                             plain sentence, never half-read by whichever fields
 *                             this build happens to recognize.
 *   - "packs can't grant"   → outward capabilities (send, post, reply, spend) cap
 *                             at 'ask' for anything that arrived from outside.
 *
 * Strictness is the one behavioural difference between manifests: packs reject
 * unknown fields, hires drop them. Both directions are asserted, because the
 * lenient path is what keeps existing hire links importing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  AGENT_DEFINITION_VERSION,
  OUTWARD_CAPABILITIES,
  capOutwardLevels,
  levelFor,
  validateAgentDefinition
} = loadTs('src/shared/agentDefinition.ts');

/** A minimal valid definition; tests spread over it to make one thing wrong. */
const base = (over = {}) => ({
  id: 'pam',
  role: 'Admin',
  summary: 'Reads your inbox, sorts orders, invoices and junk.',
  does: ['Sort new mail'],
  wontDo: ['Delete any email'],
  connections: [{ id: 'gmail', required: true }],
  tools: [
    { capability: 'email.read', level: 'auto' },
    { capability: 'email.send', level: 'ask' }
  ],
  ...over
});

test('a well-formed definition validates and normalizes', () => {
  const res = validateAgentDefinition(base());
  assert.equal(res.ok, true, res.errors.join('; '));
  assert.equal(res.definition.schemaVersion, AGENT_DEFINITION_VERSION);
  assert.equal(res.definition.id, 'pam');
  assert.equal(res.definition.tools.length, 2);
});

test('a capability absent from tools is off, never allowed by omission', () => {
  const res = validateAgentDefinition(base());
  assert.equal(levelFor(res.definition, 'email.read'), 'auto');
  assert.equal(levelFor(res.definition, 'social.post'), 'off');
});

test('a duplicated capability is rejected rather than silently resolved', () => {
  const res = validateAgentDefinition(
    base({
      tools: [
        { capability: 'email.send', level: 'off' },
        { capability: 'email.send', level: 'auto' }
      ]
    })
  );
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /twice/);
});

test('an unknown capability shape is rejected', () => {
  const res = validateAgentDefinition(base({ tools: [{ capability: 'Email Send', level: 'auto' }] }));
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /capability/);
});

test('an unknown level is rejected', () => {
  const res = validateAgentDefinition(base({ tools: [{ capability: 'email.send', level: 'sometimes' }] }));
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /level/);
});

test('a record from a newer build is refused with a plain message', () => {
  const res = validateAgentDefinition(base({ schemaVersion: AGENT_DEFINITION_VERSION + 1 }));
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /update the app/);
});

test('an older record is upgraded on read rather than refused', () => {
  const res = validateAgentDefinition(base({ schemaVersion: 1 }));
  assert.equal(res.ok, true, res.errors.join('; '));
  assert.equal(res.definition.schemaVersion, AGENT_DEFINITION_VERSION);
});

test('strict mode rejects an unknown field; lenient mode drops it', () => {
  const withExtra = base({ futureField: 'whatever this build cannot honour' });
  const strict = validateAgentDefinition(withExtra, 'strict');
  assert.equal(strict.ok, false);
  assert.match(strict.errors.join(' '), /unknown field/);

  const lenient = validateAgentDefinition(withExtra, 'lenient');
  assert.equal(lenient.ok, true, lenient.errors.join('; '));
  assert.equal('futureField' in lenient.definition, false, 'unknown fields must not survive into the record');
});

test('capOutwardLevels forces outward capabilities down to ask, leaving reads alone', () => {
  const res = validateAgentDefinition(
    base({
      tools: [
        { capability: 'email.read', level: 'auto' },
        { capability: 'email.send', level: 'auto' },
        { capability: 'social.post', level: 'auto' }
      ]
    })
  );
  const capped = capOutwardLevels(res.definition);
  assert.equal(levelFor(capped, 'email.read'), 'auto', 'a read stays where the pack set it');
  assert.equal(levelFor(capped, 'email.send'), 'ask');
  assert.equal(levelFor(capped, 'social.post'), 'ask');
});

test('capOutwardLevels leaves a definition untouched when nothing is outward-auto', () => {
  const res = validateAgentDefinition(base());
  const capped = capOutwardLevels(res.definition);
  assert.equal(capped, res.definition, 'no needless copy when there is nothing to cap');
});

test('every outward capability is area.verb shaped, so the map keys match tool ids', () => {
  for (const cap of OUTWARD_CAPABILITIES) {
    assert.match(cap, /^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/, `${cap} must match the capability shape`);
  }
});

test('id, role and summary are required — a nameless agent cannot reach a card', () => {
  const res = validateAgentDefinition({ does: [], wontDo: [], tools: [], connections: [] });
  assert.equal(res.ok, false);
  const joined = res.errors.join(' ');
  for (const field of ['id', 'role', 'summary']) {
    assert.match(joined, new RegExp(`"${field}"`), `expected an error naming ${field}`);
  }
});

// ─── Coverage audit additions: the remaining validator branches ────────────────

test('a definition that is not an object, or has a malformed version, is refused', () => {
  for (const raw of [null, 'pam', 7, [base()]]) {
    const res = validateAgentDefinition(raw);
    assert.equal(res.ok, false);
    assert.match(res.errors.join(' '), /JSON object/);
  }
  for (const schemaVersion of [0, 2.5, '1']) {
    const res = validateAgentDefinition(base({ schemaVersion }));
    assert.equal(res.ok, false, `schemaVersion ${JSON.stringify(schemaVersion)} must be refused`);
    assert.match(res.errors.join(' '), /positive integer/);
  }
});

test('optional fields are normalized when valid and refused when not', () => {
  const ok = validateAgentDefinition(
    base({ character: '  Pam ', modelTier: 'fast', tokenCap: 1000, firstAction: 'Sorts the morning mail' })
  );
  assert.equal(ok.ok, true, ok.errors.join('; '));
  assert.equal(ok.definition.character, 'pam', 'sprite ids are trimmed and lowercased');
  assert.equal(ok.definition.modelTier, 'fast');
  assert.equal(ok.definition.tokenCap, 1000);
  assert.equal(ok.definition.firstAction, 'Sorts the morning mail');

  const plain = validateAgentDefinition(base()).definition;
  for (const k of ['character', 'modelTier', 'tokenCap', 'firstAction']) {
    assert.equal(k in plain, false, `absent ${k} must not be written as an empty key`);
  }

  for (const [over, re] of [
    [{ modelTier: 'smartest' }, /modelTier/],
    [{ tokenCap: 0 }, /tokenCap/],
    [{ tokenCap: 1.5 }, /tokenCap/],
    [{ id: '../etc' }, /"id" contains disallowed characters/],
    [{ does: 'Sort new mail' }, /"does" must be an array/],
    [{ wontDo: ['x'.repeat(201)] }, /wontDo\[0\].*exceeds 200/]
  ]) {
    const res = validateAgentDefinition(base(over));
    assert.equal(res.ok, false, `${JSON.stringify(over)} must be refused`);
    assert.match(res.errors.join(' '), re);
  }
});

test('connections must be objects with a shaped id and a boolean required flag', () => {
  const dflt = validateAgentDefinition(base({ connections: [{ id: 'gmail' }] }));
  assert.equal(dflt.ok, true, dflt.errors.join('; '));
  assert.deepEqual(dflt.definition.connections, [{ id: 'gmail', required: false }], 'required defaults to false');

  for (const [connections, re] of [
    [['gmail'], /connections\[0\]" must be an object/],
    [[{ id: 'Gmail Account' }], /connections\[0\]\.id/],
    [[{ id: 'gmail', required: 'yes' }], /connections\[0\]\.required" must be a boolean/]
  ]) {
    const res = validateAgentDefinition(base({ connections }));
    assert.equal(res.ok, false);
    assert.match(res.errors.join(' '), re);
  }

  const notObjTool = validateAgentDefinition(base({ tools: ['email.read'] }));
  assert.equal(notObjTool.ok, false);
  assert.match(notObjTool.errors.join(' '), /tools\[0\]" must be an object/);
});

// ─── The folder an agent works in (Decisions 44, 47) ─────────────────────────
// A pack's folder name becomes a real path on the owner's disk, and packs can be
// imported from anywhere. The validator is the first line against a name that
// would escape the business folder.

test('a plain folder name is accepted, including spaces and ampersands', () => {
  for (const folder of ['Finance', 'Client Records', 'Brand & Marketing', 'IT']) {
    const res = validateAgentDefinition({ ...base(), folder });
    assert.equal(res.ok, true, `${folder}: ${res.errors.join('; ')}`);
    assert.equal(res.definition.folder, folder);
  }
});

test('a folder name that could escape the business folder is refused', () => {
  const bad = [
    '../../.ssh',          // traversal
    'Finance/Private',     // a nested path, not a name
    'C:\\Windows',         // a drive and a backslash
    '.hidden',             // hidden folder
    '..',
    'Finance.',            // Windows strips a trailing dot, so two names collide
    'Finance ',            // (trimmed) — still a valid "Finance"; see next line
    'What?',               // characters Windows forbids
    'a'.repeat(41)
  ];
  for (const folder of bad) {
    const res = validateAgentDefinition({ ...base(), folder });
    if (folder === 'Finance ') {
      // Surrounding whitespace is trimmed before the check, which is the right outcome.
      assert.equal(res.definition?.folder, 'Finance');
      continue;
    }
    assert.equal(res.ok, false, `should refuse ${JSON.stringify(folder)}`);
    assert.match(res.errors.join(' '), /folder/, JSON.stringify(folder));
  }
});

test('folder is optional: an agent without one still validates', () => {
  const res = validateAgentDefinition(base());
  assert.equal(res.ok, true, res.errors.join('; '));
  assert.equal(res.definition.folder, undefined);
});
