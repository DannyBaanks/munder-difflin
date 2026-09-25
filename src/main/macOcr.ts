// Portado de agentvivekkumar/dontbemichael (Vivek Kumar, MIT).
/**
 * Reading text out of scans and photos, with the OCR built into macOS (F7).
 *
 * WHY THIS WAY. The usual answer is to bundle Tesseract: tens of MB of
 * WebAssembly and language data, plus a native canvas library to turn PDF pages
 * into images. macOS already ships Apple's own OCR (the Vision framework behind
 * Live Text) and PDFKit to render pages. `osascript`'s JavaScript bridge reaches
 * both, so there is nothing to download, bundle or install, the same way
 * docText uses the built-in `textutil`.
 *
 * Measured on a real Mac: the very first call loads Vision's models (~30 s,
 * once per machine); after that a page takes well under a second. Hence the
 * generous timeout, and why this is async and never blocks the caller.
 *
 * SAFETY. The script goes in over stdin and the file path as a separate
 * argument, so a filename is only ever a string: `$(…)` or `;` in a name does
 * nothing. Only macOS; everywhere else reports `unsupported`.
 */

import { execFile } from 'node:child_process';

/** Pages OCR'd from one PDF. A 300-page scan would take minutes; the rest is reported as skipped. */
export const MAX_OCR_PAGES = 50;
/** Covers the one-time cold model load; a warm page is well under a second. */
const OCR_TIMEOUT_MS = 180_000;

export type OcrResult =
  | { ok: true; pages: string[]; truncated: boolean }
  | { ok: false; reason: 'unsupported' | 'timeout' | 'failed' };

/**
 * JXA run(argv): argv = [kind, path, maxPages]. Prints JSON:
 * { pages: string[], truncated: boolean } or { error: string }.
 */
const SCRIPT = String.raw`
ObjC.import('Foundation'); ObjC.import('Vision'); ObjC.import('PDFKit'); ObjC.import('AppKit');
function recognize(handler) {
  const req = $.VNRecognizeTextRequest.alloc.init;
  req.recognitionLevel = 0;              // accurate
  req.usesLanguageCorrection = true;
  try { req.automaticallyDetectsLanguage = true; } catch (e) {}
  if (!handler.performRequestsError($([req]), $())) return '';
  const out = []; const r = req.results;
  for (let i = 0; i < r.count; i++) {
    const c = r.objectAtIndex(i).topCandidates(1);
    if (c.count) out.push(ObjC.unwrap(c.objectAtIndex(0).string));
  }
  return out.join('\n');
}
function run(argv) {
  const kind = argv[0], path = argv[1], max = parseInt(argv[2], 10) || 50;
  const url = $.NSURL.fileURLWithPath(path);
  if (kind === 'image') {
    return JSON.stringify({ pages: [recognize($.VNImageRequestHandler.alloc.initWithURLOptions(url, $()))], truncated: false });
  }
  const doc = $.PDFDocument.alloc.initWithURL(url);
  if (!doc || doc.isNil()) return JSON.stringify({ error: 'not a pdf' });
  const n = doc.pageCount, pages = [];
  for (let i = 0; i < Math.min(n, max); i++) {
    const page = doc.pageAtIndex(i);
    const b = page.boundsForBox(1);        // crop box, in points
    const scale = 2;                        // ~144 dpi: enough for small print
    const img = page.thumbnailOfSizeForBox($.NSMakeSize(b.size.width * scale, b.size.height * scale), 1);
    // $() is a true nil. JXA's null becomes NSNull, which AppKit rejects here.
    const cg = img.CGImageForProposedRectContextHints($(), $(), $());
    pages.push(recognize($.VNImageRequestHandler.alloc.initWithCGImageOptions(cg, $())));
  }
  return JSON.stringify({ pages, truncated: n > max });
}`;

export function macOcr(path: string, kind: 'image' | 'pdf', maxPages = MAX_OCR_PAGES): Promise<OcrResult> {
  if (process.platform !== 'darwin') return Promise.resolve({ ok: false, reason: 'unsupported' });
  return new Promise((resolve) => {
    const child = execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-', kind, path, String(maxPages)],
      { timeout: OCR_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, reason: (err as NodeJS.ErrnoException & { killed?: boolean }).killed ? 'timeout' : 'failed' });
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout)) as { pages?: unknown; truncated?: unknown; error?: unknown };
          if (!Array.isArray(parsed.pages)) { resolve({ ok: false, reason: 'failed' }); return; }
          resolve({ ok: true, pages: parsed.pages.map(String), truncated: parsed.truncated === true });
        } catch {
          resolve({ ok: false, reason: 'failed' });
        }
      }
    );
    child.stdin?.end(SCRIPT);
  });
}
