import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelPanel } from '@/components/PixelPanel';
import { PixelButton } from '@/components/PixelButton';
import { MARKETPLACE_CATEGORIES, MARKETPLACE_CATALOG_CONNECTED } from '@/components/globalNav';

/**
 * Marketplace — the global surface for extending Munder (MCPs, harness
 * adapters, providers, skills, Office Packs, themes).
 *
 * V1 is the shell only. There is no catalog backend and no contribution
 * pipeline yet, so nothing here installs, searches or submits anything: the
 * inputs are disabled and the view says so. The intent box reserves the spot
 * where "describe what you want to add" will feed Michael → ContributionPlan
 * → human approval → workers → PR; it is NOT a chat with Michael.
 *
 * It paints over the floor instead of replacing it: App keeps the office, the
 * terminals and every agent mounted underneath, so switching back is instant
 * and nothing restarts.
 */
export function MarketplaceView() {
  const { t } = useTranslation();
  const [intent, setIntent] = useState('');
  const connected = MARKETPLACE_CATALOG_CONNECTED;

  const label = {
    fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
    color: 'var(--cth-ink-500)', margin: 0
  } as const;

  return (
    <div
      role="region"
      aria-label={t('shell.nav.marketplace')}
      style={{
        // Above the floor's own overlays (memory panel: 40), below every modal
        // and fixed overlay (200+).
        position: 'absolute', inset: 0, zIndex: 100,
        display: 'flex', flexDirection: 'column',
        padding: 16, overflowY: 'auto',
        background: 'var(--cth-paper-100)'
      }}
    >
      <PixelPanel variant="default" noPadding style={{ maxWidth: 880, width: '100%', margin: '0 auto' }}>
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <header style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <h1 style={{
              fontFamily: 'var(--cth-font-display)', fontSize: 14, lineHeight: '20px',
              color: 'var(--cth-ink-900)', margin: 0
            }}>
              {t('shell.marketplace.title')}
            </h1>
            <p style={{ margin: 0, fontSize: 14, color: 'var(--cth-ink-700)' }}>
              {t('shell.marketplace.tagline')}
            </p>
          </header>

          <input
            type="search"
            disabled={!connected}
            placeholder={t('shell.marketplace.searchPlaceholder')}
            aria-label={t('shell.marketplace.searchPlaceholder')}
            style={{
              height: 32, padding: '0 10px',
              fontFamily: 'var(--cth-font-ui)', fontSize: 13,
              background: 'var(--cth-cream-200)', color: 'var(--cth-ink-900)',
              border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', borderRadius: 0,
              cursor: connected ? 'text' : 'not-allowed'
            }}
          />

          <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h2 style={label}>{t('shell.marketplace.categories')}</h2>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {MARKETPLACE_CATEGORIES.map((c) => (
                <li
                  key={c}
                  style={{
                    padding: '5px 10px 4px',
                    fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                    color: 'var(--cth-ink-700)', background: 'var(--cth-cream-200)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
                  }}
                >
                  {t(`shell.marketplace.category.${c}`)}
                </li>
              ))}
            </ul>
          </section>

          <div style={{ height: 2, background: 'var(--cth-ink-300)' }} />

          <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h2 style={label}>{t('shell.marketplace.createTitle')}</h2>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--cth-ink-700)' }}>
              {t('shell.marketplace.createBlurb')}
            </p>
            <textarea
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              rows={4}
              placeholder={t('shell.marketplace.intentPlaceholder')}
              aria-label={t('shell.marketplace.createTitle')}
              style={{
                resize: 'vertical', padding: 10,
                fontFamily: 'var(--cth-font-ui)', fontSize: 13, lineHeight: '19px',
                background: 'var(--cth-cream-50)', color: 'var(--cth-ink-900)',
                border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', borderRadius: 0
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                {t('shell.marketplace.pipelineSoon')}
              </span>
              <PixelButton variant="primary" size="md" disabled>
                {t('shell.marketplace.prepare')}
              </PixelButton>
            </div>
          </section>

          <div style={{ height: 2, background: 'var(--cth-ink-300)' }} />

          <p role="status" style={{ margin: 0, fontSize: 13, color: 'var(--cth-ink-500)' }}>
            {t('shell.marketplace.noCatalog')}
          </p>
        </div>
      </PixelPanel>
    </div>
  );
}
