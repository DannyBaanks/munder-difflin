'use strict';
// node --test test/conpty-patch.test.cjs
//
// Fail-closed guard for tools/patch-node-pty-conpty.cjs. That postinstall
// patch no-ops SILENTLY when node-pty changes the exact line it guards
// (`if (!src.includes(...)) process.exit(0)`): the whole-app exit-255 crash
// protection can evaporate on upgrade with every suite green. This test fails
// closed on any unknown state of the vendored file instead.
// Windows-only strong assertion: the patch applies solely on win32 (the
// script exits early elsewhere, so the vendored file stays pristine there by
// design). Other platforms skip explicitly with reason — never silently.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ORIGINAL = 'var consoleProcessList = getConsoleProcessList(shellPid);';
const MARKER = 'PATCHED: AttachConsole can fail';

function assess(source) {
  if (source.includes(ORIGINAL)) {
    return { ok: false, reason: 'unguarded upstream line present: patch did not apply (run npm ci) or node-pty changed and the patch silently no-ops' };
  }
  if (source.includes(MARKER)) return { ok: true, reason: 'conpty patch applied' };
  return { ok: false, reason: 'unrecognized agent file: upstream changed it — update tools/patch-node-pty-conpty.cjs and this test' };
}

// Classifier checks (run everywhere, no node_modules needed): the mutation
// proof. Altering a fixture copy of the upstream line goes red; only the
// patched form passes.
test('assess: original -> fail, patched -> pass, unknown -> fail', () => {
  assert.equal(assess(`head\n${ORIGINAL}\ntail`).ok, false);
  assert.match(assess(ORIGINAL).reason, /did not apply/);
  assert.equal(assess(`head\ntry { consoleProcessList = getConsoleProcessList(shellPid); } catch (e) {}\n// ${MARKER}\ntail`).ok, true);
  const unknown = assess('something entirely different');
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /update tools\/patch-node-pty-conpty\.cjs/);
});

test('vendored conpty agent carries the guard', { skip: process.platform !== 'win32' && 'patch applies on win32 only; nothing to assess here' }, () => {
  const file = path.join(__dirname, '..', 'node_modules', 'node-pty', 'lib', 'conpty_console_list_agent.js');
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch {
    assert.fail(`node-pty agent file missing at ${file}: run npm ci first`);
  }
  const r = assess(src);
  assert.equal(r.ok, true, `${r.reason} [${file}]`);
});
