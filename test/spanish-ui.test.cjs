'use strict';

// The Spanish locale is generated through IntentLang's inventory/materializer
// pipeline. These tests enforce the safe part of the contract: registration,
// complete key/array shape, interpolation, markup, and no review markers.
// They do not claim that a Spanish reader has reviewed every sentence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const locale = (code) => JSON.parse(read(`src/renderer/src/i18n/locales/${code}.json`));

function leaves(node, prefix = '') {
  if (Array.isArray(node)) return node.flatMap((v, i) => leaves(v, `${prefix}.${i}`));
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) =>
      leaves(v, prefix ? `${prefix}.${k}` : k));
  }
  return [[prefix, node]];
}

const en = locale('en');
const es = locale('es');
const pathsOf = (value) => new Map(leaves(value));
const text = (value) => (Array.isArray(value) ? value.join(' ') : String(value));

test('Spanish is registered as an LTR language with bundled resources', () => {
  const src = read('src/renderer/src/i18n/index.ts');
  assert.match(src, /import es from '\.\/locales\/es\.json';/);
  assert.match(src, /es: \{ translation: es \}/);
  assert.match(src, /supportedLngs: \[[^\]]*'es'[^\]]*\]/);
  assert.match(src, /code: 'es'[^}]*dir: 'ltr'/);
});

test('Spanish has exactly the English key tree and array lengths', () => {
  const e = pathsOf(en);
  const s = pathsOf(es);
  assert.deepEqual([...e.keys()].filter((k) => !s.has(k)), []);
  assert.deepEqual([...s.keys()].filter((k) => !e.has(k)), []);
  const at = (value, path) => path.split('.').reduce((next, part) => next[part], value);
  for (const p of ['office.errand.smoke', 'office.suckUp', 'office.gossip', 'office.cheer']) {
    assert.equal(at(es, p).length, at(en, p).length, `${p} changed length`);
  }
});

test('Spanish preserves placeholders, inline markup, and hotkeys', () => {
  const e = pathsOf(en);
  const s = pathsOf(es);
  const vars = (value) => [...text(value).matchAll(/\{\{\s*[\w.]+\s*\}\}/g)]
    .map((m) => m[0]).sort().join('|');
  const tags = (value) => [...text(value).matchAll(/<\/?[a-z]+>/g)]
    .map((m) => m[0]).sort().join('|');
  const hotkeys = (value) => [...text(value).matchAll(/\b(?:Ctrl|Cmd|Alt|Shift)\+[A-Za-z0-9]+/g)]
    .map((m) => m[0]).sort().join('|');
  const bad = [];
  for (const [key, value] of e) {
    if (vars(value) !== vars(s.get(key))) bad.push(`${key}: placeholder`);
    if (tags(value) !== tags(s.get(key))) bad.push(`${key}: markup`);
    if (hotkeys(value) !== hotkeys(s.get(key))) bad.push(`${key}: hotkey`);
  }
  assert.deepEqual(bad, []);
});

test('Spanish contains no IntentLang review markers or hardcoded Michael', () => {
  const bad = [...pathsOf(es)].filter(([, value]) =>
    /\[NEEDS_REVIEW\]|Michael|XQZPROTECTED|PROTECTED\d/i.test(text(value)));
  assert.deepEqual(bad, []);
});
