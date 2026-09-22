import { useEffect, useState } from 'react';

/**
 * Repaint generation for 2D canvases that paint once and are then assumed
 * to stay painted (SpritePortrait).
 *
 * WHY. Measured 2026-09-22: the GPU process died mid-session
 * (`gpu_process_host.cc: GPU process exited unexpectedly: exit_code=512`)
 * and every avatar went permanently invisible — process alive, DOM dialogs
 * fine. A 2D canvas whose backing store was GPU-resident loses its bitmap
 * with the process, and unlike WebGL it fires NO recovery event
 * (`webglcontextlost` is WebGL-only; scene/office/glRecovery.ts covers the
 * pixi floor, not these). The paint effect depends only on
 * [character, scale, background], none of which change, so nothing ever
 * repaints: the portraits stay blank until restart.
 *
 * There is also no main-process signal to listen for: Electron 32 exposes
 * no `gpu-process-crashed` event on `app` (verified against electron.d.ts —
 * only renderer/plugin crash events exist), so detection has to live here.
 *
 * WHAT BUMPS THE GENERATION (all cheap — a portrait repaint is one tiny
 * offscreen blit, microseconds; see portraitArt.paintPortrait):
 *   1. visibilitychange → visible (sleep/wake, workspace switch, and any GPU
 *      restart that happened while the window was hidden),
 *   2. window focus (alt-tab back and anything similar),
 *   3. a 30s heartbeat while visible (the stare-through case: GPU dies while
 *      the user watches, with no visibility transition to ride on).
 * Ticks while hidden are skipped — painting an invisible canvas is pure cost,
 * and the visibility bump covers the return.
 *
 * Pass the return value into the paint effect's deps. Missing preload, old
 * main, no GPU at all: the hook degrades to mount-once painting (today's
 * behavior) and never breaks anything.
 */
export function useCanvasRepaint(intervalMs = 30_000): number {
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let live = true;
    const bump = () => { if (live) setGeneration((g) => g + 1); };
    const onVisibility = () => { if (!document.hidden) bump(); };
    const onTick = () => { if (!document.hidden) bump(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', bump);
    const timer = setInterval(onTick, intervalMs);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', bump);
      clearInterval(timer);
    };
  }, [intervalMs]);

  return generation;
}
