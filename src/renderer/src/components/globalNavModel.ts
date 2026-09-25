/**
 * Global navigation — the title bar's product-level tabs (Office, Settings ▾,
 * Marketplace). Pure data + logic, no React, so the node tests load it as is.
 *
 * Two levels of navigation live in the app and must not blur together:
 *   title bar       = the product  (this file)
 *   Command Center  = the current office (Terminal, Monitor, Tasks, …)
 *
 * Settings stays ONE surface: the dropdown deep-links into the existing
 * SettingsModal through the same `cth:open-settings` event every other entry
 * point uses. SETTINGS_SECTIONS is the single list both the modal's left nav
 * and the dropdown render, so the two can never drift apart.
 */

/** Which global surface fills the main area. Switching is visual only: the
 *  floor, the terminals and every agent process stay mounted underneath. */
export type GlobalView = 'office' | 'marketplace';

export type SettingsSection =
  | 'General' | 'Prerequisites' | 'Agents & Models' | 'Autonomy & Budgets'
  | 'Connections' | 'Munder Link' | 'Voice' | 'Memory & Knowledge';

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'General', 'Prerequisites', 'Agents & Models', 'Autonomy & Budgets',
  'Connections', 'Munder Link', 'Voice', 'Memory & Knowledge'
];

/** i18n key for each section's label — the Section values themselves stay as
 *  stable identifiers (tab state, deep links). */
export const SETTINGS_SECTION_KEYS: Record<SettingsSection, string> = {
  'General': 'settings.nav.general',
  'Prerequisites': 'settings.nav.prerequisites',
  'Agents & Models': 'settings.nav.agentsModels',
  'Autonomy & Budgets': 'settings.nav.autonomyBudgets',
  'Connections': 'settings.nav.connections',
  'Munder Link': 'settings.nav.link',
  'Voice': 'settings.nav.voice',
  'Memory & Knowledge': 'settings.nav.memoryKnowledge'
};

/** The deep link every Settings entry point fires; App owns the modal. */
export const OPEN_SETTINGS_EVENT = 'cth:open-settings';

export function openSettingsDetail(section?: SettingsSection): { section?: SettingsSection } {
  return section ? { section } : {};
}

/**
 * How much of the tab row fits. Measured against the window width because the
 * title bar is a fixed row: identity on the left, window controls on the right.
 *   full     labels + the auto-mode text
 *   compact  labels, auto mode shrinks to a badge
 *   narrow   Settings shortens to its short label; Marketplace never hides
 */
export type NavDensity = 'full' | 'compact' | 'narrow';

export function navDensity(width: number): NavDensity {
  if (width >= 1180) return 'full';
  if (width >= 900) return 'compact';
  return 'narrow';
}

/**
 * Keyboard handling for the Settings menu (a WAI-ARIA menu button).
 * Returns what the key does given the focused item index.
 */
export type MenuAction =
  | { type: 'focus'; index: number }
  | { type: 'select'; index: number }
  | { type: 'close'; restoreFocus: boolean }
  | { type: 'none' };

export function menuKey(key: string, index: number, count: number): MenuAction {
  if (count <= 0) return key === 'Escape' ? { type: 'close', restoreFocus: true } : { type: 'none' };
  switch (key) {
    case 'ArrowDown': return { type: 'focus', index: (index + 1 + count) % count };
    case 'ArrowUp': return { type: 'focus', index: (index - 1 + count) % count };
    case 'Home': return { type: 'focus', index: 0 };
    case 'End': return { type: 'focus', index: count - 1 };
    case 'Enter':
    case ' ': return index >= 0 && index < count ? { type: 'select', index } : { type: 'none' };
    case 'Escape': return { type: 'close', restoreFocus: true };
    case 'Tab': return { type: 'close', restoreFocus: false };
    default: return { type: 'none' };
  }
}

/** Keys on the closed menu button that open the menu, and where focus lands. */
export function buttonKey(key: string, count: number): { open: true; index: number } | null {
  if (key === 'ArrowDown' || key === 'Enter' || key === ' ') return { open: true, index: 0 };
  if (key === 'ArrowUp') return { open: true, index: Math.max(0, count - 1) };
  return null;
}

/**
 * Marketplace categories the shell reserves room for. Labels only: there is no
 * catalog behind them yet, and the view says so instead of pretending.
 */
export const MARKETPLACE_CATEGORIES = ['mcp', 'harness', 'provider', 'skill', 'pack', 'theme'] as const;
export type MarketplaceCategory = (typeof MARKETPLACE_CATEGORIES)[number];

/** Nothing is installable yet. The view reads this instead of hardcoding it,
 *  so the next iteration flips it when a catalog backend exists. */
export const MARKETPLACE_CATALOG_CONNECTED = false;
