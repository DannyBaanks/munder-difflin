/**
 * The app's real entry point. It only decides WHICH app to be, before any of
 * the office loads:
 *
 *   Munder Difflin            → the office (index.js, exactly as before)
 *   Munder Difflin --panel    → Munder Panel, the small button window
 *
 * The panel lives in this same executable on purpose: no second download, and
 * an AppImage stays mounted for as long as the panel window is open (a panel
 * spawned from here and left behind would lose its files when we exit).
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { runPanel } from './panelMode';

if (process.argv.includes('--panel')) {
  runPanel();
} else {
  // A plain require by path: the office is its own bundle, loaded untouched.
  createRequire(__filename)(join(__dirname, 'index.js'));
}
