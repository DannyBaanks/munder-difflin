'use strict';

/**
 * Reading an owner's real documents into the knowledge store.
 *
 * The bug this guards: a Word file was indexed as its zip bytes, the upload
 * reported success, and nothing in it was ever searchable. PDFs silently needed
 * a `pdftotext` binary most owners don't have. Every fixture here is a REAL
 * file in its real format, built at test time, and the end-to-end cases go
 * extract → ingest → search: a pass means an agent's search finds the words.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { zipSync, strToU8 } = require('fflate');
const loadTs = require('./load-ts.cjs');

const { extractDocumentText } = loadTs('src/main/docText.ts');
const kg = require('../src/main/kg-core.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-text-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const write = (name, data) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, data);
  return p;
};
const zip = (name, files) =>
  write(name, Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))));

// ─── Fixture builders: genuine Office Open XML and PDF ───────────────────────

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (...runs) => `<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>${runs.join('')}</w:p>`;
const run = (t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;

function docx(name, bodyParas, extra = {}) {
  return zip(name, {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'word/document.xml': `<?xml version="1.0"?><w:document ${W}><w:body>${bodyParas.join('')}</w:body></w:document>`,
    ...extra
  });
}

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const slideXml = (...lines) =>
  `<?xml version="1.0"?><p:sld ${A}><p:txBody>${lines.map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sld>`;

function pdf(name, contentStream) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return write(name, Buffer.from(out, 'latin1'));
}

// ─── Word ────────────────────────────────────────────────────────────────────

test('Word: paragraphs, tabs and escaped characters come through as text', async () => {
  const p = docx('policy.docx', [
    para(run('Returns &amp; Refunds')),
    para(run('Item'), '<w:r><w:tab/></w:r>', run('Window')),
    para(run('Refunds within 30 days with a receipt.'))
  ]);
  const r = await extractDocumentText(p);
  assert.equal(r.kind, 'text');
  assert.equal(r.text, 'Returns & Refunds\nItem\tWindow\nRefunds within 30 days with a receipt.');
  assert.equal(r.extractor, 'docx-xml@1');
});

test('Word: a tab STOP definition is not mistaken for a tab character', async () => {
  // Every paragraph above carries <w:tab w:val=.../> in its properties. Only a
  // bare <w:tab/> inside a run is a real tab.
  const r = await extractDocumentText(docx('stops.docx', [para(run('No tab here'))]));
  assert.equal(r.text, 'No tab here');
});

test('Word: tracked deletions are not indexed as if they were still there', async () => {
  const r = await extractDocumentText(docx('tracked.docx', [
    para(run('Kept'), '<w:del><w:r><w:delText>Deleted words</w:delText></w:r></w:del>')
  ]));
  assert.equal(r.text, 'Kept');
});

test('Word: footnotes and letterhead headers are searchable too, after the body', async () => {
  const r = await extractDocumentText(docx('letter.docx', [para(run('Body text'))], {
    'word/footnotes.xml': `<w:footnotes ${W}>${para(run('A footnote'))}</w:footnotes>`,
    'word/header1.xml': `<w:hdr ${W}>${para(run('123 Main St, Austin TX'))}</w:hdr>`
  }));
  assert.equal(r.text, 'Body text\n\nA footnote\n\n123 Main St, Austin TX');
});

// ─── PowerPoint ──────────────────────────────────────────────────────────────

test('PowerPoint: slides in numeric order (2 before 10), then speaker notes', async () => {
  const r = await extractDocumentText(zip('deck.pptx', {
    'ppt/slides/slide10.xml': slideXml('Ten'),
    'ppt/slides/slide2.xml': slideXml('Two'),
    'ppt/slides/slide1.xml': slideXml('Summer menu', 'Launching June 1'),
    'ppt/notesSlides/notesSlide1.xml': slideXml('Mention the patio')
  }));
  assert.equal(r.kind, 'text');
  assert.equal(r.text, 'Slide 1\nSummer menu\nLaunching June 1\n\nSlide 2\nTwo\n\nSlide 10\nTen\n\nSpeaker notes\nMention the patio');
});

test('PowerPoint: a deck of pictures is refused with a reason, not stored empty', async () => {
  const r = await extractDocumentText(zip('photos.pptx', { 'ppt/slides/slide1.xml': `<p:sld ${A}/>` }));
  assert.equal(r.kind, 'unreadable');
  assert.match(r.reason, /slides are probably images/);
});

// ─── Excel ───────────────────────────────────────────────────────────────────

function xlsx(name) {
  const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  return zip(name, {
    'xl/workbook.xml': `<workbook ${S} xmlns:r="r"><sheets>
      <sheet name="Prices &amp; Costs" sheetId="1" r:id="rId1"/>
      <sheet name="Suppliers" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships>
      <Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>
      <Relationship Id="rId2" Type="worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
    'xl/sharedStrings.xml': `<sst ${S}><si><t>Item</t></si><si><t>Price</t></si>
      <si><r><t>Pho </t></r><r><t>Bo</t></r></si><si><t>Spring rolls</t></si></sst>`,
    'xl/worksheets/sheet1.xml': `<worksheet ${S}><cols><col min="1" max="3"/></cols><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>14.5</v></c></row>
      <row r="3"><c r="A3" t="s"><v>3</v></c><c r="C3" t="b"><v>1</v></c></row>
      <row r="4"><c r="A4" s="1"/></row></sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': `<worksheet ${S}><sheetData>
      <row r="1"><c r="A1" t="inlineStr"><is><t>Saigon Produce</t></is></c><c r="B1" t="str"><f>A1</f><v>weekly</v></c></row>
      </sheetData></worksheet>`
  });
}

test('Excel: every sheet by name, columns kept aligned, all cell kinds read', async () => {
  const r = await extractDocumentText(xlsx('prices.xlsx'));
  assert.equal(r.kind, 'text');
  assert.equal(r.modality, 'sheet');
  assert.equal(
    r.text,
    'Sheet: Prices & Costs\nItem\tPrice\nPho Bo\t14.5\nSpring rolls\t\tTRUE\n\n' +
    'Sheet: Suppliers\nSaigon Produce\tweekly'
  );
});

// ─── PDF ─────────────────────────────────────────────────────────────────────

test('PDF: text is read with the bundled reader — no pdftotext needed', async () => {
  const r = await extractDocumentText(pdf('contract.pdf', 'BT /F1 12 Tf 72 720 Td (Catering deposit is 50 percent.) Tj ET'));
  assert.equal(r.kind, 'text');
  assert.equal(r.text, 'Catering deposit is 50 percent.');
  assert.equal(r.extractor, 'pdfjs@1');
});

test('PDF: a scan with no text layer is refused with a reason an owner understands', async () => {
  const r = await extractDocumentText(pdf('scan.pdf', '0 0 1 rg 72 72 200 200 re f'));
  assert.equal(r.kind, 'unreadable');
  // On a Mac the pages are OCR'd first (F7); a blank shape still has nothing to read.
  assert.match(r.reason, /scan or a photo/);
});

// ─── Older formats and refusals ──────────────────────────────────────────────

test('RTF: read through macOS\'s built-in converter', { skip: process.platform !== 'darwin' }, async () => {
  const r = await extractDocumentText(write('menu.rtf', '{\\rtf1\\ansi Weekend brunch from 10am.}'));
  assert.equal(r.kind, 'text');
  assert.equal(r.text, 'Weekend brunch from 10am.');
  assert.equal(r.extractor, 'textutil@1');
});

test('Apple Pages / Numbers / Keynote are refused with how to export them', async () => {
  for (const [ext, hint] of [['pages', /Word or PDF/], ['numbers', /Excel/], ['key', /PowerPoint or PDF/]]) {
    const r = await extractDocumentText(write(`x.${ext}`, 'PK\u0003\u0004'));
    assert.equal(r.kind, 'unreadable', ext);
    assert.match(r.reason, hint, ext);
  }
});

test('a password-protected (not-a-zip) Office file is refused, not indexed as bytes', async () => {
  // An encrypted .docx is an OLE compound file, not a zip. This is its magic number.
  const r = await extractDocumentText(write('locked.docx', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])));
  assert.equal(r.kind, 'unreadable');
  assert.match(r.reason, /protected by a password or damaged/);
});

test('an unknown binary file is refused rather than read as text', async () => {
  const r = await extractDocumentText(write('thing.bin', Buffer.from([1, 2, 0, 3, 4])));
  assert.equal(r.kind, 'unreadable');
});

test('plain text, markdown and CSV are left to the store, which already reads them', async () => {
  for (const f of ['notes.md', 'notes.txt', 'list.csv']) {
    assert.equal((await extractDocumentText(write(f, 'hello, world\n'))).kind, 'passthrough', f);
  }
});

test('a missing file gets a plain reason, not a stack trace', async () => {
  const r = await extractDocumentText(path.join(tmp, 'gone.docx'));
  assert.equal(r.kind, 'unreadable');
  assert.match(r.reason, /moved or deleted/);
});

// ─── End to end: what an agent's search actually finds ───────────────────────

test('end to end: a Word document is searchable after ingest, and the original is kept', async () => {
  const root = path.join(tmp, 'kg');
  const src = docx('returns.docx', [para(run('Our return policy: refunds within 30 days with a receipt.'))]);
  const ex = await extractDocumentText(src);
  const { docId, meta } = kg.ingest(root, { srcPath: src, text: ex.text, modality: ex.modality, extractor: ex.extractor, mime: ex.mime });

  const hits = kg.search(root, 'refunds receipt', { limit: 3 });
  assert.equal(hits.length, 1, 'the words inside the Word file must be findable');
  assert.equal(hits[0].docId, docId);
  assert.equal(meta.extractor, 'docx-xml@1', 'the store records how the text was produced');
  assert.equal(meta.modality, 'doc');
  assert.ok(fs.existsSync(path.join(root, 'docs', docId, 'original.docx')), 'the original is kept alongside');
});

// ─── OCR for scans and photos (F7), macOS only ───────────────────────────────
// Fixtures are real images with text drawn into them by AppKit, then read back
// by the Mac's own OCR — the same path an owner's scanned receipt takes.

const { execFileSync } = require('node:child_process');
const onMac = process.platform === 'darwin';

function drawTextPng(name, text) {
  const out = path.join(tmp, name);
  const script = `
ObjC.import('AppKit');
function run(argv) {
  const out = argv[0], text = argv[1];
  const w = 1000, h = 220;
  const img = $.NSImage.alloc.initWithSize($.NSMakeSize(w, h));
  img.lockFocus;
  $.NSColor.whiteColor.setFill; $.NSRectFill($.NSMakeRect(0, 0, w, h));
  const attrs = $.NSDictionary.dictionaryWithObjectForKey($.NSFont.systemFontOfSize(44), $.NSFontAttributeName);
  $(text).drawAtPointWithAttributes($.NSMakePoint(30, 90), attrs);
  img.unlockFocus;
  const rep = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation);
  return rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).writeToFileAtomically(out, true) ? 'ok' : 'fail';
}`;
  const res = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-', out, text], { input: script, encoding: 'utf8' }).trim();
  assert.equal(res, 'ok', 'fixture image written');
  return out;
}

function imagesToPdf(name, pngs) {
  const out = path.join(tmp, name);
  const script = `
ObjC.import('PDFKit'); ObjC.import('AppKit');
function run(argv) {
  const doc = $.PDFDocument.alloc.init;
  for (let i = 1; i < argv.length; i++) {
    doc.insertPageAtIndex($.PDFPage.alloc.initWithImage($.NSImage.alloc.initWithContentsOfFile(argv[i])), doc.pageCount);
  }
  return doc.writeToFile(argv[0]) ? 'ok' : 'fail';
}`;
  assert.equal(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-', out, ...pngs], { input: script, encoding: 'utf8' }).trim(), 'ok');
  return out;
}

test('a photo of a sign or receipt: its words become searchable text', { skip: !onMac }, async () => {
  const r = await extractDocumentText(drawTextPng('receipt.png', 'Catering deposit is 50 percent'));
  assert.equal(r.kind, 'text');
  assert.equal(r.extractor, 'vision-ocr@1');
  assert.match(r.text, /Catering deposit is 50 percent/);
});

test('a photo with no writing is still stored, not refused', { skip: !onMac }, async () => {
  const r = await extractDocumentText(drawTextPng('blank.png', ''));
  assert.equal(r.kind, 'passthrough', 'kg-core keeps the file and indexes its name');
});

test('a scanned PDF (pages are pictures, no text layer) is read page by page', { skip: !onMac }, async () => {
  const scan = imagesToPdf('signed-contract.pdf', [
    drawTextPng('p1.png', 'Deposit due 7 days before the event'),
    drawTextPng('p2.png', 'We deliver within 15 miles')
  ]);
  const r = await extractDocumentText(scan);
  assert.equal(r.kind, 'text');
  assert.equal(r.extractor, 'vision-ocr@1', 'read by OCR, not a text layer');
  assert.match(r.text, /^Page 1\n.*Deposit due 7 days before the event/s);
  assert.match(r.text, /Page 2\n.*We deliver within 15 miles/s);
});

test('end to end: a scanned document is findable after ingest', { skip: !onMac }, async () => {
  const root = path.join(tmp, 'kg-ocr');
  const src = imagesToPdf('scan.pdf', [drawTextPng('s.png', 'Health inspection passed in March')]);
  const ex = await extractDocumentText(src);
  const { docId } = kg.ingest(root, { srcPath: src, text: ex.text, modality: ex.modality, extractor: ex.extractor, mime: ex.mime });
  const hits = kg.search(root, 'health inspection', { limit: 3 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].docId, docId);
});
