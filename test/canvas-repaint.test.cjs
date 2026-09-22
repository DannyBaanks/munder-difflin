'use strict';
/**
 * canvas-repaint tests. Self-contained, no test framework — run with
 * `node test/canvas-repaint.test.cjs`.
 *
 * The bug (measured 2026-09-22): the GPU process died mid-session
 * (`gpu_process_host.cc: GPU process exited unexpectedly: exit_code=512`)
 * and every SpritePortrait avatar went permanently invisible — process
 * alive, DOM dialogs fine. A 2D canvas whose backing store was GPU-resident
 * loses its bitmap, fires NO recovery event (`webglcontextlost` is
 * WebGL-only; scene/office/glRecovery.ts covers the pixi floor, not these),
 * and the paint effect depends only on [character, scale, background], so
 * nothing ever repaints. Electron 32 exposes no `gpu-process-crashed`
 * event on `app` (verified against electron.d.ts), so detection lives in
 * the renderer: hooks/useCanvasRepaint.ts.
 *
 * Like release-drop.test.cjs and update-badge-acknowledgement.test.cjs,
 * these are source-string checks — there is no jsdom harness in this repo,
 * and deleting the repaint wiring must not pass silently.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const read = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8');
const HOOK = read('src/renderer/src/hooks/useCanvasRepaint.ts');
const PORTRAIT = read('src/renderer/src/components/SpritePortrait.tsx');

test('the hook listens to all three repaint triggers with cleanup', () => {
  assert.ok(/addEventListener\('visibilitychange'/.test(HOOK), 'visibilitychange subscription');
  assert.ok(/addEventListener\('focus'/.test(HOOK), 'window focus subscription');
  assert.ok(/setInterval\(/.test(HOOK), 'heartbeat interval');
  assert.ok(/removeEventListener\('visibilitychange'/.test(HOOK), 'visibility cleanup');
  assert.ok(/removeEventListener\('focus'/.test(HOOK), 'focus cleanup');
  assert.ok(/clearInterval\(/.test(HOOK), 'interval cleanup');
});

test('hidden ticks are skipped (no painting invisible canvases)', () => {
  assert.ok(/document\.hidden/.test(HOOK), 'visibility gate present');
});

test('SpritePortrait repaints on the shared generation', () => {
  assert.ok(/useCanvasRepaint/.test(PORTRAIT), 'portrait consumes the hook');
  assert.ok(/repaintGen/.test(PORTRAIT), 'generation is threaded into the paint effect');
  assert.ok(/\[character, scale, background, repaintGen\]/.test(PORTRAIT),
    'effect deps include the generation alongside the paint inputs');
});

test('the hook degrades gracefully (no preload/main dependency)', () => {
  assert.ok(!/window\.cth/.test(HOOK), 'no preload coupling — works in dev and build');
  assert.ok(!/ipcRenderer|webContents/.test(HOOK), 'no Electron imports — renderer-only');
});
