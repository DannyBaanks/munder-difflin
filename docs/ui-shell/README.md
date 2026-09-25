# UI Shell V1: global tabs in the title bar and the Marketplace shell

Base: `main` @ `5fcc3081`. Screenshots are from the real Electron build running
under Xvfb (Linux, 1440×900 unless noted), Spanish UI, with a fresh profile.
Michael can't start in that container, so the floor stays on "Fichando".

## Phase 1: audit

| What | Where | Notes |
|---|---|---|
| Title bar | `src/renderer/src/App.tsx` | `.cth-titlebar-drag` row, 36 px, 96 px left inset for the macOS traffic lights; buttons use `cth-titlebar-nodrag` |
| Settings | `components/SettingsModal.tsx` | One modal. `initialSection` already deep-links. App owns `settingsOpen` and `settingsSection` |
| Settings deep link | `cth:open-settings` window event | Used by FullscreenTerminal and the Voice tab. App listens and opens the same modal |
| Theme | `design/theme.ts` `toggleAppTheme` | Tokens in `tokens.css` with a dark block |
| Focus mode (fullscreen) | store `fullscreenAgentId` and `FullscreenTerminal` | Unchanged |
| Tabs pattern | `CommandCenterPanel.tsx` | Filled with the accent colour, UI font 13 px: the office level |
| Navigation state | Local `useState` and conditional rendering | No router. None was added |

Risks found: the drag region, which the tabs sit on with `cth-titlebar-nodrag`, and z-index against the floor's own overlays (the memory panel sits at 40).

## Decisions

- **Settings → option B: a menu over the existing modal.** `Configuración ▾` lists `SETTINGS_SECTIONS`. Picking an item opens the same `SettingsModal` on that section.
  - The section list moved to `components/globalNav.ts`, and the modal and the menu both render it, so there is one source of truth.
  - The title-bar gear went away because the tab replaces it. Focus mode's gear stays and fires the same event.
- **Marketplace → an overlay.** It paints over the main row (`zIndex 100`: above the floor's overlays, below every modal at 200 and up). The floor, the terminals and the agents stay mounted underneath.
  - Verified with the flow: the canvas tagged before opening Marketplace is still the same node afterwards (`1 1`).
- **Global-tab style.** They copy the Settings left nav (display font, ink fill, lemon rule), not the Command Center tabs, so the product level and the office level don't get confused.
- **Density.**
  - ≥1180 px: full.
  - 900–1179 px: `auto mode` becomes the `AUTO ON` badge, with a tooltip and aria-label.
  - <900 px: `Configuración` shortens to `Config`.
  - Marketplace never hides.
- **Accessibility.** The menu is an ARIA menu button:
  - arrows, Home and End move; Enter or Space picks; Escape closes and returns focus; Tab closes;
  - a click outside closes it;
  - the keys also work when the menu was opened with the mouse.
- **Marketplace is honest.** There is no catalog (`MARKETPLACE_CATALOG_CONNECTED = false`): search and «Preparar contribución» are disabled, and the view says so. It calls nothing in main.

## Evidence

| Capture | File |
|---|---|
| Before: version on the left, empty space, gear on the right | `before-office.png` |
| After: Office | `after-office.png` |
| Configuración menu | `after-config-menu.png` |
| Keyboard (↓×6, Enter) → Settings on Munder Link | `after-config-link-deeplink.png` |
| Marketplace | `after-marketplace.png` |
| Dark: office, marketplace, menu | `after-office-dark.png`, `after-marketplace-dark.png`, `after-config-menu-dark.png` |
| 1024 px (badge) | `after-width-1024.png` |
| 860 px (short label, menu open) | `after-width-860.png`, `after-width-860-menu.png` |

## Classification

- **DEMONSTRATED (Linux/Electron):**
  - the Office, Configuración and Marketplace tabs;
  - keyboard deep-link to Settings;
  - one modal; the office is not unmounted;
  - dark and light; 1440, 1024 and 860 px;
  - the menu above the canvas.
- **INFERRED:**
  - macOS: the 96 px inset is unchanged, and the tabs are `nodrag`;
  - Windows at 125–150 % scaling: CSS pixels, same breakpoints;
  - RTL/Arabic: the menu uses `insetInlineStart`.
- **NOT_DEMONSTRATED:** real macOS and Windows; a live agent terminal keeping focus across the switch (no Claude CLI in the container).

## Tests

- `test/global-nav.test.cjs` covers:
  - one section list and one modal;
  - the Marketplace overlay never unmounting the office;
  - keyboard behaviour; density; locale parity.
- `node --test test/*.test.cjs`: 1032 pass, 1 fail. `proc-kill` fails in this container, as it does on `main`.
- `npm run typecheck`: clean.

## Rollback

Revert the PR. The only data change is the new `shell.*` i18n keys. Config, hive, sessions, Link, GPT, Reviver and Mobile are untouched.
