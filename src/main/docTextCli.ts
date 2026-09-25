// Portado de agentvivekkumar/dontbemichael (Vivek Kumar, MIT).
/**
 * `doc-text <file>` — print a document's text, for agents (Decision 44, F6).
 *
 * An agent's folder holds the owner's real files. Claude reads PDFs and images
 * itself, but a Word, Excel or PowerPoint file is a zip archive to it. This is
 * the same converter the knowledge store uses (docText.ts), built as a second
 * entry of the main-process bundle so it ships inside the app with the same
 * libraries: nothing for the owner to install. Agents run it with the app's
 * bundled Node; the exact command is written into their prompt.
 *
 * Exit codes: 0 = text on stdout; 1 = couldn't read it (reason on stderr, in
 * plain English, so the agent can tell the owner); 2 = no file given.
 *
 * `doc-text --json <file>` is the app's own door: the knowledge store runs it in
 * a child process (index.ts) so untrusted PDF and zip parsing never happens in
 * the main process. It prints the DocExtraction as one JSON line and exits 0.
 */

import { readFileSync } from 'node:fs';
import { extractDocumentText, isImagePath } from './docText';

async function main(): Promise<number> {
  const json = process.argv[2] === '--json';
  const file = process.argv[json ? 3 : 2];
  if (json && file) {
    process.stdout.write(`${JSON.stringify(await extractDocumentText(file))}\n`);
    return 0;
  }
  if (!file) {
    process.stderr.write('usage: doc-text <file>\n');
    return 2;
  }
  if (isImagePath(file)) {
    process.stderr.write('This is an image. Open it directly with your Read tool. You can see images.\n');
    return 1;
  }
  const r = await extractDocumentText(file);
  if (r.kind === 'unreadable') {
    process.stderr.write(`${r.reason}\n`);
    return 1;
  }
  const text = r.kind === 'text' ? r.text : readFileSync(file, 'utf8');
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  return 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (e) => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; }
);
