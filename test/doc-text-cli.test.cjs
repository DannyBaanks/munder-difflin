'use strict';

/**
 * `doc-text <file>`: the command agents run to read Word, Excel and PowerPoint
 * files in their folders (F6). Its prompt line promises "it prints the text (a
 * reason instead, if the file can't be read)", so the contract an agent relies
 * on is the exit code plus which stream carries what:
 *   0 = the text on stdout, 1 = a plain reason on stderr, 2 = no file given.
 *
 * Also the refusals doc-text.test.cjs leaves out: old binary Office formats,
 * an Office file with nothing in it, and a file too big to read whole.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { zipSync, strToU8 } = require('fflate');
const loadTs = require('./load-ts.cjs');

const { extractDocumentText, isImagePath } = loadTs('src/main/docText.ts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-doc-text-cli-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (name, data) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, data);
  return p;
};
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docx = (name, body) => write(name, Buffer.from(zipSync({
  'word/document.xml': strToU8(`<w:document ${W}><w:body>${body}</w:body></w:document>`)
})));

/** Run the CLI exactly as an agent would, with the file as its only argument. */
function docText(...args) {
  const script = `process.argv = [process.argv[0], 'doc-text', ...${JSON.stringify(args)}];
    require(${JSON.stringify(path.join(__dirname, 'load-ts.cjs'))})('src/main/docTextCli.ts');`;
  const r = spawnSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// ─── The CLI ─────────────────────────────────────────────────────────────────

test('text on stdout, newline-terminated, exit 0: Word converted, plain text passed through', () => {
  const r = docText(docx('quote.docx', '<w:p><w:r><w:t>Catering for 40, delivered.</w:t></w:r></w:p>'));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'Catering for 40, delivered.\n');
  assert.equal(r.err, '');
  const txt = docText(write('notes.txt', 'Deliveries on Tuesdays'));
  assert.equal(txt.code, 0);
  assert.equal(txt.out, 'Deliveries on Tuesdays\n');
});

test('a file it can\'t read, or an image: a plain reason on stderr, nothing on stdout, exit 1', () => {
  const r = docText(write('menu.numbers', 'PK\u0003\u0004'));
  assert.equal(r.code, 1);
  assert.equal(r.out, '', 'nothing on stdout an agent could mistake for the document');
  assert.match(r.err, /Export To/);
  // Claude can see images itself, so it is sent to open them directly.
  const img = docText(path.join(tmp, 'receipt.JPG'));
  assert.equal(img.code, 1);
  assert.match(img.err, /image/i);
});

test('no file given: usage on stderr, exit 2', () => {
  const r = docText();
  assert.equal(r.code, 2);
  assert.match(r.err, /usage: doc-text <file>/);
});

// ─── Refusals doc-text.test.cjs does not cover ───────────────────────────────

test('old Excel and PowerPoint files, and an empty Word file, are refused with a reason', async () => {
  const xls = await extractDocumentText(write('prices.xls', 'x'));
  assert.equal(xls.kind, 'unreadable');
  assert.match(xls.reason, /\.xlsx/);
  const ppt = await extractDocumentText(write('deck.ppt', 'x'));
  assert.equal(ppt.kind, 'unreadable');
  assert.match(ppt.reason, /\.pptx or PDF/);
  const blank = await extractDocumentText(docx('blank.docx', '<w:p/>'));
  assert.equal(blank.kind, 'unreadable', 'not stored empty');
  assert.match(blank.reason, /no text in it/);
});

test('a file over 100 MB is refused before it is read; images are known by extension', async () => {
  const big = path.join(tmp, 'huge.docx');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, 100 * 1024 * 1024 + 1); // sparse: no real disk used
  const r = await extractDocumentText(big);
  assert.equal(r.kind, 'unreadable');
  assert.match(r.reason, /larger than 100 MB/);
  for (const p of ['a.png', 'b.JPG', 'c.jpeg', 'd.heic', 'e.tiff']) assert.equal(isImagePath(p), true, p);
  for (const p of ['a.pdf', 'b.docx', 'c', 'png']) assert.equal(isImagePath(p), false, p);
});
