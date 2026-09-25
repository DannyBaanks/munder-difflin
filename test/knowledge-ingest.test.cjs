'use strict';

/**
 * KnowledgeManager.ingestFile, the door the Settings "add documents" button and
 * the kg:ingestFiles IPC both go through. doc-text.test.cjs proves the
 * converter; this proves the manager USES it: a Word file is stored as its
 * words (with the converter recorded), and a file that can't be read is refused
 * with the owner-readable reason instead of being stored as bytes, which is
 * what used to report success on a .docx and index nothing.
 *
 * ingestFile became async in this change, so every assertion awaits it: a
 * caller that forgot to would get a pending promise, not a docId.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { zipSync, strToU8 } = require('fflate');
const loadTs = require('./load-ts.cjs');

// knowledge.ts and config.ts reach for Electron's app; point both at a
// throwaway userData (same seam as business-onboarding.test.cjs).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-kg-ingest-'));
const userData = path.join(tmp, 'userData');
fs.mkdirSync(userData);
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => userData, isPackaged: false, getAppPath: () => path.resolve(__dirname, '..') } }
};
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { writeConfig } = loadTs('src/main/config.ts');
const { KnowledgeManager } = loadTs('src/main/knowledge.ts');

const kgRoot = path.join(tmp, 'kg');
writeConfig({ knowledgeGraph: { enabled: true, rootPath: kgRoot } });
const km = new KnowledgeManager();

const write = (name, data) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, data);
  return p;
};

test('a Word file is stored as its words, with the converter recorded', async () => {
  assert.equal(km.root(), kgRoot, 'the store lives where the owner pointed it');
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const src = write('allergens.docx', Buffer.from(zipSync({
    'word/document.xml': strToU8(`<w:document ${W}><w:body><w:p><w:r><w:t>Peanut oil is used in the satay sauce.</w:t></w:r></w:p></w:body></w:document>`)
  })));
  const r = await km.ingestFile(src, { tags: ['menu'] });
  assert.ok(r.docId, 'ingestFile resolves to the stored document');
  assert.equal(r.meta.extractor, 'docx-xml@1');
  assert.equal(r.meta.mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'the converter\'s mime wins over kg-core\'s guess for inline text');
  assert.deepEqual(r.meta.tags, ['menu']);
  const hits = km.search('satay peanut');
  assert.equal(hits[0]?.docId, r.docId, 'an agent\'s search finds the words inside the file');
});

test('a file that can\'t be read is refused with the plain reason, and nothing is stored', async () => {
  const before = km.status().docCount;
  const src = write('menu.pages', 'PK\u0003\u0004');
  await assert.rejects(km.ingestFile(src), /Export To/);
  const locked = write('locked.xlsx', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  await assert.rejects(km.ingestFile(locked), /protected by a password or damaged/);
  assert.equal(km.status().docCount, before);
});

test('plain text is left to kg-core, which reads it itself', async () => {
  const r = await km.ingestFile(write('hours.md', '# Hours\nOpen 11 to 9, closed Mondays.\n'));
  assert.notEqual(r.meta.extractor, 'docx-xml@1');
  assert.ok(r.chunkCount >= 1);
});

test('the app can swap in an out-of-process extractor and ingest uses it', async () => {
  const other = new KnowledgeManager();
  const seen = [];
  other.setExtractor(async (p) => {
    seen.push(p);
    return { kind: 'text', text: 'Converted elsewhere: invoice 1042', extractor: 'child@1', modality: 'doc', mime: 'application/pdf' };
  });
  const src = write('scan.pdf', '%PDF-1.4 not really parsed here');
  const r = await other.ingestFile(src);
  assert.deepEqual(seen, [src], 'the injected extractor ran, not the in-process one');
  assert.equal(r.meta.extractor, 'child@1');
  other.setExtractor(async () => ({ kind: 'unreadable', reason: 'The reader stopped.' }));
  await assert.rejects(other.ingestFile(src), /The reader stopped\./);
});
