'use strict';

/**
 * Title-bar global navigation (Office · Settings ▾ · Marketplace).
 * The logic is pure (components/globalNavModel.ts); the wiring checks read the
 * source, the way the other renderer tests here do, because what matters is
 * structural: one Settings, nothing unmounted when the view changes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const N = loadTs('src/renderer/src/components/globalNavModel.ts');
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const app = src('src/renderer/src/App.tsx');
const modal = src('src/renderer/src/components/SettingsModal.tsx');
const nav = src('src/renderer/src/components/GlobalNav.tsx');

test('Settings has one section list: the modal and the title-bar menu both render SETTINGS_SECTIONS', () => {
  assert.deepEqual([...N.SETTINGS_SECTIONS], [
    'General', 'Prerequisites', 'Agents & Models', 'Autonomy & Budgets',
    'Connections', 'Munder Link', 'Voice', 'Memory & Knowledge'
  ]);
  for (const s of N.SETTINGS_SECTIONS) assert.ok(N.SETTINGS_SECTION_KEYS[s], s);
  assert.match(modal, /const NAV_SECTIONS = SETTINGS_SECTIONS;/);
  assert.doesNotMatch(modal, /const NAV_SECTIONS: Section\[\] = \[/, 'no second hardcoded list in the modal');
  assert.match(nav, /SETTINGS_SECTIONS\.map/);
});

test('the Settings menu opens the ONE existing SettingsModal on the chosen section', () => {
  // App owns a single settingsOpen/settingsSection pair; the nav only calls back into it.
  assert.equal((app.match(/<SettingsModal\b/g) || []).length, 1);
  assert.equal((app.match(/useState<SettingsSection/g) || []).length, 1);
  assert.match(app, /onOpenSettings=\{\(section\) => \{ setSettingsSection\(section\); setSettingsOpen\(true\); \}\}/);
  // The deep-link event every other entry point uses still lands in the same place.
  assert.match(app, /addEventListener\('cth:open-settings'/);
  assert.equal(N.OPEN_SETTINGS_EVENT, 'cth:open-settings');
  assert.deepEqual(N.openSettingsDetail('Munder Link'), { section: 'Munder Link' });
  assert.deepEqual(N.openSettingsDetail(), {});
});

test('Marketplace paints over the office, it never unmounts it', () => {
  // The floor, the sidebar (terminals) and the agent strip render unconditionally;
  // only the Marketplace overlay depends on the view.
  assert.match(app, /\{globalView === 'marketplace' && <MarketplaceView \/>\}/);
  assert.match(app, /\n\s+<OfficeFloor \/>\n/);
  assert.doesNotMatch(app, /globalView === 'office' &&/);
  assert.doesNotMatch(app, /globalView !== 'marketplace' &&/);
  assert.match(app, /<AgentStrip config=\{config\} \/>/);
});

test('Marketplace does not pretend: no catalog, nothing installs, the prepare button is disabled', () => {
  assert.equal(N.MARKETPLACE_CATALOG_CONNECTED, false);
  const mv = src('src/renderer/src/components/MarketplaceView.tsx');
  assert.match(mv, /<PixelButton variant="primary" size="md" disabled>/);
  assert.doesNotMatch(mv, /window\.cth\./, 'the shell calls nothing in main');
  assert.deepEqual([...N.MARKETPLACE_CATEGORIES], ['mcp', 'harness', 'provider', 'skill', 'pack', 'theme']);
});

test('density: labels at laptop widths, Marketplace never hidden', () => {
  assert.equal(N.navDensity(1440), 'full');
  assert.equal(N.navDensity(1180), 'full');
  assert.equal(N.navDensity(1024), 'compact');
  assert.equal(N.navDensity(900), 'compact');
  assert.equal(N.navDensity(800), 'narrow');
  assert.doesNotMatch(nav, /density === 'narrow' \? null/);
});

test('menu keyboard: arrows wrap, Home/End, Enter/Space select, Escape closes and returns focus, Tab closes', () => {
  const n = N.SETTINGS_SECTIONS.length;
  assert.deepEqual(N.menuKey('ArrowDown', 0, n), { type: 'focus', index: 1 });
  assert.deepEqual(N.menuKey('ArrowDown', n - 1, n), { type: 'focus', index: 0 });
  assert.deepEqual(N.menuKey('ArrowUp', 0, n), { type: 'focus', index: n - 1 });
  assert.deepEqual(N.menuKey('ArrowDown', -1, n), { type: 'focus', index: 0 });
  assert.deepEqual(N.menuKey('Home', 4, n), { type: 'focus', index: 0 });
  assert.deepEqual(N.menuKey('End', 0, n), { type: 'focus', index: n - 1 });
  assert.deepEqual(N.menuKey('Enter', 5, n), { type: 'select', index: 5 });
  assert.deepEqual(N.menuKey(' ', 2, n), { type: 'select', index: 2 });
  assert.deepEqual(N.menuKey('Enter', -1, n), { type: 'none' });
  assert.deepEqual(N.menuKey('Escape', 3, n), { type: 'close', restoreFocus: true });
  assert.deepEqual(N.menuKey('Tab', 3, n), { type: 'close', restoreFocus: false });
  assert.deepEqual(N.menuKey('a', 3, n), { type: 'none' });
  assert.deepEqual(N.buttonKey('ArrowDown', n), { open: true, index: 0 });
  assert.deepEqual(N.buttonKey('ArrowUp', n), { open: true, index: n - 1 });
  assert.equal(N.buttonKey('x', n), null);
});

test('the menu is a real ARIA menu button and closes on outside click', () => {
  assert.match(nav, /aria-haspopup="menu"/);
  assert.match(nav, /aria-expanded=\{menuOpen\}/);
  assert.match(nav, /role="menuitem"/);
  assert.match(nav, /addEventListener\('mousedown', onDown\)/);
  assert.match(nav, /className="cth-titlebar-nodrag cth-globalnav"/, 'clickable inside the drag region');
});

test('title bar keeps version, auto mode, theme and focus-mode controls', () => {
  assert.match(app, /<UpdateBadge \/>/);
  assert.match(app, /'auto mode on' : 'auto mode off'/);
  assert.match(app, /'AUTO ON' : 'AUTO OFF'/);
  assert.match(app, /aria-label="Toggle dark mode"/);
  assert.match(app, /aria-label="Toggle focus mode"/);
});

test('every locale carries the shell strings', () => {
  const dir = path.join(__dirname, '..', 'src/renderer/src/i18n/locales');
  const keys = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
  const en = keys(JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8')).shell);
  for (const code of ['es', 'zh-CN', 'ar']) {
    assert.deepEqual(keys(JSON.parse(fs.readFileSync(path.join(dir, `${code}.json`), 'utf8')).shell), en, code);
  }
  for (const c of N.MARKETPLACE_CATEGORIES) assert.ok(en.includes(`marketplace.category.${c}`), c);
});
