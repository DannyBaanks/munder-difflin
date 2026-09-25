import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SETTINGS_SECTIONS, SETTINGS_SECTION_KEYS, buttonKey, menuKey,
  type GlobalView, type NavDensity, type SettingsSection
} from '@/components/globalNavModel';

/**
 * The title bar's product-level tabs: OFICINA · CONFIGURACIÓN ▾ · MARKETPLACE.
 *
 * Styled after the Settings modal's left nav (display font, ink fill, lemon
 * rule on the active item), not after the Command Center's tabs, so the two
 * levels read as different things: these are the product, the Command
 * Center's are the office you are looking at.
 *
 * Settings is a menu, not a view: picking an entry opens the one existing
 * SettingsModal on that section (App owns it). The tab never holds settings
 * state of its own.
 */
export function GlobalNav({
  view, onView, onOpenSettings, settingsOpen, density
}: {
  view: GlobalView;
  onView: (v: GlobalView) => void;
  onOpenSettings: (section?: SettingsSection) => void;
  settingsOpen: boolean;
  density: NavDensity;
}) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const count = SETTINGS_SECTIONS.length;

  // Click outside closes. mousedown, so a click that lands on the floor canvas
  // (which stops propagation of click in places) still closes the menu.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  // Focus follows the keyboard index only while the menu is open; closing it
  // never grabs focus unless the user closed it from the keyboard (Escape).
  useEffect(() => {
    if (menuOpen && focusIdx >= 0) itemRefs.current[focusIdx]?.focus();
  }, [menuOpen, focusIdx]);

  const open = (index: number): void => { setFocusIdx(index); setMenuOpen(true); };
  const close = (restoreFocus: boolean): void => {
    setMenuOpen(false);
    setFocusIdx(-1);
    if (restoreFocus) buttonRef.current?.focus();
  };
  const pick = (section?: SettingsSection): void => {
    close(false);
    onOpenSettings(section);
  };

  const onMenuKey = (e: React.KeyboardEvent): void => {
    const a = menuKey(e.key, focusIdx, count);
    if (a.type === 'none') return;
    e.preventDefault();
    e.stopPropagation();
    if (a.type === 'focus') setFocusIdx(a.index);
    else if (a.type === 'select') pick(SETTINGS_SECTIONS[a.index]);
    else close(a.restoreFocus);
  };

  const tabStyle = (active: boolean): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 6,
    height: 28, padding: density === 'narrow' ? '3px 8px 0' : '3px 12px 0',
    border: 'none',
    borderBottom: active ? '3px solid var(--cth-lemon)' : '3px solid transparent',
    background: active ? 'var(--cth-ink-900)' : 'transparent',
    color: active ? 'var(--cth-cream-50)' : 'var(--cth-ink-700)',
    fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
    letterSpacing: 0, whiteSpace: 'nowrap', cursor: 'pointer',
    borderRadius: 0
  });

  const settingsLabel = density === 'narrow' ? t('shell.nav.settingsShort') : t('shell.nav.settings');

  return (
    <nav
      aria-label={t('shell.nav.label')}
      className="cth-titlebar-nodrag cth-globalnav"
      style={{ display: 'flex', alignItems: 'stretch', gap: 2, minWidth: 0 }}
    >
      <button
        type="button"
        className="cth-globalnav-tab"
        aria-current={view === 'office' ? 'page' : undefined}
        onClick={() => onView('office')}
        style={tabStyle(view === 'office')}
      >
        {t('shell.nav.office')}
      </button>

      <div ref={wrapRef} style={{ position: 'relative', display: 'flex' }}>
        <button
          ref={buttonRef}
          type="button"
          className="cth-globalnav-tab"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls="cth-settings-menu"
          onClick={() => (menuOpen ? close(false) : open(-1))}
          onKeyDown={(e) => {
            // Opened with the mouse, focus is still on the button: the same
            // keys drive the menu from here.
            if (menuOpen) return onMenuKey(e);
            const r = buttonKey(e.key, count);
            if (r) { e.preventDefault(); open(r.index); }
          }}
          style={tabStyle(menuOpen || settingsOpen)}
        >
          {settingsLabel}
          {/* The pixel display font has no ▾; draw the caret. */}
          <svg aria-hidden="true" focusable="false" width="8" height="8" viewBox="0 0 8 8" style={{ display: 'block' }}>
            <path d="M1 2h6v1H6v1H5v1H3V4H2V3H1z" fill="currentColor" />
          </svg>
        </button>
        {menuOpen && (
          <div
            id="cth-settings-menu"
            role="menu"
            aria-label={t('shell.nav.settings')}
            onKeyDown={onMenuKey}
            style={{
              position: 'absolute', top: '100%', insetInlineStart: 0, marginTop: 4,
              // Above the floor canvas, the sidebar and the Command Center, and
              // below the Settings modal it opens (which mounts after the menu
              // closes, so they never overlap anyway).
              zIndex: 900,
              minWidth: 230,
              display: 'flex', flexDirection: 'column',
              padding: '6px 0',
              background: 'var(--cth-cream-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300), 3px 3px 0 0 var(--cth-ink-900)'
            }}
          >
            {SETTINGS_SECTIONS.map((section, i) => {
              const focused = focusIdx === i;
              return (
                <button
                  key={section}
                  ref={(el) => { itemRefs.current[i] = el; }}
                  type="button"
                  role="menuitem"
                  tabIndex={focused ? 0 : -1}
                  onClick={() => pick(section)}
                  onMouseEnter={() => setFocusIdx(i)}
                  className="cth-globalnav-item"
                  style={{
                    display: 'block', width: '100%', textAlign: 'start',
                    padding: '9px 14px 7px', border: 'none',
                    borderInlineStart: focused ? '3px solid var(--cth-lemon)' : '3px solid transparent',
                    background: focused ? 'var(--cth-ink-900)' : 'transparent',
                    color: focused ? 'var(--cth-cream-50)' : 'var(--cth-ink-700)',
                    fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                    cursor: 'pointer', whiteSpace: 'nowrap'
                  }}
                >
                  {t(SETTINGS_SECTION_KEYS[section])}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <button
        type="button"
        className="cth-globalnav-tab"
        aria-current={view === 'marketplace' ? 'page' : undefined}
        onClick={() => onView('marketplace')}
        style={tabStyle(view === 'marketplace')}
      >
        {t('shell.nav.marketplace')}
      </button>
    </nav>
  );
}
