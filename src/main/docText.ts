// Portado de agentvivekkumar/dontbemichael (Vivek Kumar, MIT).
/**
 * An owner's documents → plain text the knowledge store can index.
 *
 * WHY THIS EXISTS. kg-core only understands text. Handed a Word, Excel or
 * PowerPoint file, it read the zip container as UTF-8 and indexed the raw bytes:
 * the upload reported success and nothing in the file was ever searchable. PDFs
 * depended on a `pdftotext` binary that a typical owner's Mac does not have. This
 * reads the formats owners actually keep, using pure-JS code that ships inside
 * the app plus what macOS already has (`textutil`, and the Vision OCR for scans
 * and photos, via macOcr.ts) — nothing to install — and says plainly when a file
 * can't be read, instead of storing junk that looks like it worked.
 *
 * Runs in two places, both from inside the app bundle: the main process (the
 * knowledge store's ingest) and `docTextCli.ts`, the `doc-text` command agents
 * use to read Word/Excel/PowerPoint files in their own folders.
 */

import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { extname } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { macOcr, MAX_OCR_PAGES } from './macOcr';

export type DocExtraction =
  /** Converted here; index this text. */
  | { kind: 'text'; text: string; extractor: string; modality: string; mime: string }
  /** A format kg-core already reads well (plain text, code, CSV, images). */
  | { kind: 'passthrough' }
  /** Could not be read. `reason` is shown to the owner as-is, so it is plain English. */
  | { kind: 'unreadable'; reason: string };

/** Anything larger is almost certainly not a document an agent should read whole. */
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
/** Per zip entry, uncompressed. A zip bomb declares a tiny file that inflates hugely. */
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;

const WORD = new Set(['docx', 'docm', 'dotx', 'dotm']);
const SLIDES = new Set(['pptx', 'pptm', 'ppsx', 'potx']);
const SHEETS = new Set(['xlsx', 'xlsm', 'xltx', 'xltm']);
/** Converted by macOS's built-in `textutil` — present on every Mac, nothing to install. */
const TEXTUTIL = new Set(['doc', 'rtf', 'odt', 'wordml', 'webarchive']);
const IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff', 'heic']);

/** True for images, which an agent should open directly (Claude can see them) rather than convert. */
export function isImagePath(path: string): boolean {
  return IMAGES.has(extname(path).slice(1).toLowerCase());
}

const MIME: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  doc: 'application/msword',
  rtf: 'application/rtf',
  odt: 'application/vnd.oasis.opendocument.text'
};

/** Formats we know we can't read yet, with what the owner should do instead. */
const EXPORT_ADVICE: Record<string, string> = {
  pages: 'Apple Pages files can\'t be read yet. In Pages, choose File → Export To → Word or PDF, and add that instead.',
  numbers: 'Apple Numbers files can\'t be read yet. In Numbers, choose File → Export To → Excel, and add that instead.',
  key: 'Apple Keynote files can\'t be read yet. In Keynote, choose File → Export To → PowerPoint or PDF, and add that instead.',
  xls: 'Old Excel (.xls) files can\'t be read yet. Open it and save it as .xlsx, then add that instead.',
  ppt: 'Old PowerPoint (.ppt) files can\'t be read yet. Open it and save it as .pptx or PDF, then add that instead.'
};

export async function extractDocumentText(srcPath: string): Promise<DocExtraction> {
  const ext = extname(srcPath).slice(1).toLowerCase();

  let size: number;
  try {
    size = statSync(srcPath).size;
  } catch {
    return { kind: 'unreadable', reason: 'The file could not be opened. It may have been moved or deleted.' };
  }
  if (size > MAX_SOURCE_BYTES) {
    return { kind: 'unreadable', reason: 'This file is larger than 100 MB, which is too big to read.' };
  }

  if (EXPORT_ADVICE[ext]) return { kind: 'unreadable', reason: EXPORT_ADVICE[ext] };
  if (WORD.has(ext)) return fromOoxml(srcPath, 'docx', readWord);
  if (SLIDES.has(ext)) return fromOoxml(srcPath, 'pptx', readSlides);
  if (SHEETS.has(ext)) return fromOoxml(srcPath, 'xlsx', readSheets);
  if (ext === 'pdf') return readPdf(srcPath);
  if (TEXTUTIL.has(ext)) return await readWithTextutil(srcPath, ext);
  if (IMAGES.has(ext)) return readImage(srcPath, ext);

  // Everything else kg-core reads as UTF-8. Only safe if it really is text: a
  // binary file read that way is exactly the junk this module exists to stop.
  return looksBinary(srcPath)
    ? { kind: 'unreadable', reason: 'This isn\'t a document the app can read. Add it as Word, Excel, PowerPoint, PDF or plain text.' }
    : { kind: 'passthrough' };
}

// ─── Office Open XML (Word / PowerPoint / Excel are zips of XML) ──────────────

type OoxmlReader = (files: Record<string, Uint8Array>) => string;

function fromOoxml(srcPath: string, kind: 'docx' | 'pptx' | 'xlsx', read: OoxmlReader): DocExtraction {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(readFileSync(srcPath)), {
      // Only the XML we read — never the embedded images or media — and never
      // an entry that would inflate past the guard. `.rels` too: Excel's map
      // from sheet name to sheet file is `xl/_rels/workbook.xml.rels`, and
      // without it no sheet is found and every workbook reads as empty.
      filter: (f) => /\.(xml|rels)$/.test(f.name) && f.originalSize <= MAX_ENTRY_BYTES
    });
  } catch {
    // A password-protected Office file is not a zip at all (it's an encrypted
    // compound file), so this is what that case looks like too.
    return { kind: 'unreadable', reason: 'This file is protected by a password or damaged. Remove the password (or save it again) and add it again.' };
  }

  const text = tidy(read(files));
  if (!text) {
    return {
      kind: 'unreadable',
      reason: kind === 'pptx'
        ? 'This presentation has no text to read. Its slides are probably images.'
        : 'This file has no text in it to read.'
    };
  }
  return { kind: 'text', text, extractor: `${kind}-xml@1`, modality: MODALITY[kind], mime: MIME[kind] };
}

const MODALITY = { docx: 'doc', pptx: 'slides', xlsx: 'sheet' } as const;

function readWord(files: Record<string, Uint8Array>): string {
  // Body first, then the parts an owner still expects to be searchable: notes,
  // and the letterhead (address, phone) that lives in headers and footers.
  const order = (name: string) =>
    name === 'word/document.xml' ? 0
      : /^word\/(foot|end)notes\.xml$/.test(name) ? 1
        : /^word\/(header|footer)\d*\.xml$/.test(name) ? 2
          : -1;
  return Object.keys(files)
    .filter((n) => order(n) >= 0)
    .sort((a, b) => order(a) - order(b) || a.localeCompare(b))
    .map((n) => wordParagraphs(strFromU8(files[n])))
    .join('\n\n');
}

/** Paragraph text from WordprocessingML, keeping tabs and line breaks. */
function wordParagraphs(xml: string): string {
  return xml
    .split('</w:p>')
    .map((p) => {
      let line = '';
      // `<w:t>` is a run of text. `<w:tbl>`, `<w:tab w:val=...>` (a tab STOP, not
      // a tab character) and `<w:delText>` (tracked deletions) never match.
      for (const m of p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>/g)) {
        if (m[1] !== undefined) line += decodeXml(m[1]);
        else line += m[0].startsWith('<w:tab') ? '\t' : '\n';
      }
      return line;
    })
    .filter((l) => l.trim())
    .join('\n');
}

function readSlides(files: Record<string, Uint8Array>): string {
  const numbered = (re: RegExp) =>
    Object.keys(files)
      .map((n) => ({ n, i: Number(n.match(re)?.[1]) }))
      .filter((x) => Number.isFinite(x.i))
      .sort((a, b) => a.i - b.i); // numeric: slide2 before slide10

  const slides = numbered(/^ppt\/slides\/slide(\d+)\.xml$/)
    .map(({ n, i }) => {
      const t = drawingParagraphs(strFromU8(files[n]));
      return t ? `Slide ${i}\n${t}` : '';
    })
    .filter(Boolean);

  const notes = numbered(/^ppt\/notesSlides\/notesSlide(\d+)\.xml$/)
    .map(({ n }) => drawingParagraphs(strFromU8(files[n])))
    .filter(Boolean);

  return [...slides, ...(notes.length ? [`Speaker notes\n${notes.join('\n\n')}`] : [])].join('\n\n');
}

/** Paragraph text from DrawingML (PowerPoint shapes). */
function drawingParagraphs(xml: string): string {
  return xml
    .split('</a:p>')
    .map((p) => {
      let line = '';
      for (const m of p.matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>|<a:br(?:\s[^>]*)?\/>/g)) {
        line += m[1] !== undefined ? decodeXml(m[1]) : '\n';
      }
      return line;
    })
    .filter((l) => l.trim())
    .join('\n');
}

function readSheets(files: Record<string, Uint8Array>): string {
  const xml = (name: string) => (files[name] ? strFromU8(files[name]) : '');

  // Shared strings: most text cells hold an index into this table. Phonetic
  // guides (<rPh>) are furigana, not content.
  const shared = [...xml('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)]
      .map((t) => decodeXml(t[1]))
      .join('')
  );

  // Sheet names live in workbook.xml; which file each one is lives in its rels.
  const targets = new Map<string, string>();
  for (const m of xml('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1], 'Id');
    const target = attr(m[1], 'Target');
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }

  const out: string[] = [];
  for (const m of xml('xl/workbook.xml').matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = decodeXml(attr(m[1], 'name') ?? 'Sheet');
    const path = targets.get(attr(m[1], 'r:id') ?? '');
    if (!path || !files[path]) continue;
    const rows = sheetRows(strFromU8(files[path]), shared);
    if (rows.length) out.push(`Sheet: ${name}\n${rows.join('\n')}`);
  }
  return out.join('\n\n');
}

/** Rows as tab-separated values, with empty cells kept so columns stay aligned. */
function sheetRows(xml: string, shared: string[]): string[] {
  const rows: string[] = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    // `<c\b` does not match `<col` or `<cols`: the letter after `c` breaks the boundary.
    for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = columnIndex(attr(c[1], 'r'));
      const value = cellValue(attr(c[1], 't'), c[2] ?? '', shared);
      if (col === null) cells.push(value);
      else cells[col] = value;
    }
    const line = Array.from(cells, (v) => v ?? '').join('\t');
    if (line.trim()) rows.push(line.replace(/\t+$/, ''));
  }
  return rows;
}

function cellValue(type: string | null, inner: string, shared: string[]): string {
  if (type === 'inlineStr') {
    return [...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => decodeXml(t[1])).join('');
  }
  const v = inner.match(/<v>([^<]*)<\/v>/)?.[1];
  if (v === undefined) return '';
  if (type === 's') return shared[Number(v)] ?? '';
  if (type === 'b') return v === '1' ? 'TRUE' : 'FALSE';
  // 'str' (a formula's text result), 'e' (an error like #DIV/0!), numbers.
  // Dates are stored as serial numbers; telling them apart needs styles.xml,
  // which isn't worth it for search.
  return decodeXml(v);
}

/** "C7" → 2. Null when the cell carries no reference (then it's appended in order). */
function columnIndex(ref: string | null): number | null {
  const letters = ref?.match(/^([A-Z]+)/)?.[1];
  if (!letters) return null;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ─── PDF ─────────────────────────────────────────────────────────────────────

async function readPdf(srcPath: string): Promise<DocExtraction> {
  let pages: string[];
  try {
    // unpdf is ESM-only; main already loads ESM packages this way (tunnelmole,
    // electron-updater). It bundles a Node-ready PDF.js — no pdftotext needed.
    const { getDocumentProxy, extractText } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(readFileSync(srcPath)));
    const res = await extractText(pdf, { mergePages: false });
    pages = Array.isArray(res.text) ? res.text : [String(res.text)];
  } catch (e) {
    const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
    return {
      kind: 'unreadable',
      reason: /password/i.test(msg)
        ? 'This PDF is protected by a password. Remove the password and add it again.'
        : 'This PDF could not be read. It may be damaged.'
    };
  }

  const text = tidy(
    pages
      .map((p, i) => (p.trim() ? (pages.length > 1 ? `Page ${i + 1}\n${p}` : p) : ''))
      .filter(Boolean)
      .join('\n\n')
  );
  if (text) return { kind: 'text', text, extractor: 'pdfjs@1', modality: 'pdf', mime: MIME.pdf };

  // No text layer: common for a small business — a scanned receipt, a signed
  // contract. Read the page images with the Mac's built-in OCR (macOcr.ts).
  const ocr = await macOcr(srcPath, 'pdf');
  if (ocr.ok) {
    const read = tidy(
      ocr.pages
        .map((p, i) => (p.trim() ? (ocr.pages.length > 1 ? `Page ${i + 1}\n${p}` : p) : ''))
        .filter(Boolean)
        .join('\n\n')
    );
    if (read) {
      const note = ocr.truncated ? `\n\n[Only the first ${MAX_OCR_PAGES} pages of this scan were read.]` : '';
      return { kind: 'text', text: read + note, extractor: 'vision-ocr@1', modality: 'pdf', mime: MIME.pdf };
    }
  }
  return {
    kind: 'unreadable',
    reason: ocr.ok
      ? 'This PDF is a scan or a photo, and no writing could be read from it. It may be too faint or blurry.'
      : ocr.reason === 'timeout'
        ? 'This scanned PDF took too long to read. Try a shorter one, or split it.'
        : 'This PDF has no text in it. It\'s probably a scan or a photo, and scans can only be read on a Mac.'
  };
}

// ─── Images, via the Mac's built-in OCR ──────────────────────────────────────

/**
 * A photo of a menu or a receipt has text worth finding. One without writing
 * (a product photo) is still stored — kg-core keeps the file and indexes its
 * name and caption — so it falls back to passthrough rather than a refusal.
 */
async function readImage(srcPath: string, ext: string): Promise<DocExtraction> {
  const ocr = await macOcr(srcPath, 'image');
  const text = ocr.ok ? tidy(ocr.pages.join('\n')) : '';
  return text
    ? { kind: 'text', text, extractor: 'vision-ocr@1', modality: 'image', mime: `image/${ext === 'jpg' ? 'jpeg' : ext}` }
    : { kind: 'passthrough' };
}

// ─── Older formats, via macOS's built-in converter ───────────────────────────

async function readWithTextutil(srcPath: string, ext: string): Promise<DocExtraction> {
  if (process.platform !== 'darwin') {
    return {
      kind: 'unreadable',
      reason: `.${ext} files can only be read on a Mac for now. Save it as Word (.docx) or PDF, and add that instead.`
    };
  }
  // Async: this runs in the main process during knowledge ingest, and a sync
  // call would freeze every window for as long as textutil takes (up to 30s).
  let out: string;
  try {
    out = await new Promise<string>((resolve, reject) => {
      execFile('/usr/bin/textutil', ['-convert', 'txt', '-stdout', srcPath], {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024
      }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
  } catch {
    return { kind: 'unreadable', reason: 'This file could not be read. It may be damaged or protected by a password.' };
  }
  const text = tidy(out);
  if (!text) return { kind: 'unreadable', reason: 'This file has no text in it to read.' };
  return { kind: 'text', text, extractor: 'textutil@1', modality: 'doc', mime: MIME[ext] ?? 'text/plain' };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** A NUL byte in the first 8 KB means binary. Real text files never contain one. */
function looksBinary(srcPath: string): boolean {
  try {
    // Read only the first 8 KB: a text file here can be up to 100 MB.
    const fd = openSync(srcPath, 'r');
    try {
      const head = Buffer.alloc(8192);
      const n = readSync(fd, head, 0, 8192, 0);
      return head.subarray(0, n).includes(0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return true;
  }
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`(?:^|\\s)${name.replace(':', '\\:')}="([^"]*)"`));
  return m ? m[1] : null;
}

function decodeXml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (whole, e: string) => {
    switch (e) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return '\'';
    }
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function tidy(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
