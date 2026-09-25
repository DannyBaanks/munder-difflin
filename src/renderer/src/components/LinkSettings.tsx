/**
 * Settings → Munder Link: the same things `munder link` does, without a
 * terminal. This office, the offices linked to it (live), requests waiting for
 * us, pairing with a new one, and the phones that run this office through
 * Munder Remote (tools/munder/lib-remote.cjs).
 *
 * Trust stays a human act. Pairing shows the 6-digit code and only proceeds
 * when the person confirms the other screen shows the same code; an incoming
 * request is accepted the same way. The main process holds the peer's keys
 * between the two steps (see src/main/linkPanel.ts), so this view never
 * handles key material.
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { useStore } from '@/store/store';
import { DEFAULT_GOD_NAME } from '@shared/godIdentity';
import type { LinkStatus, LinkDiscovery } from '../../../preload/index';

const label: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 8
};
const muted: CSSProperties = { fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' };
const mono: CSSProperties = { fontFamily: 'var(--cth-font-mono)', fontSize: 12 };
const card: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
  padding: '8px 10px', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', background: 'var(--cth-paper-100)'
};
const input: CSSProperties = {
  flex: 1, minWidth: 160, padding: '6px 8px 4px', background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontFamily: 'var(--cth-font-ui)', fontSize: 13,
  color: 'var(--cth-ink-900)', outline: 'none'
};
const dot = (on: boolean): CSSProperties => ({
  width: 8, height: 8, flexShrink: 0, background: on ? 'var(--cth-mint)' : 'var(--cth-ink-300)'
});
const bigCode = (code: string): string => code.replace(/(\d{3})(\d{3})/, '$1 $2');
const num = (v: unknown): string => (typeof v === 'number' ? String(v) : '?');

export function LinkSettings() {
  const { t } = useTranslation();
  const godName = useStore((st) => st.agents.find((a) => a.isGod)?.name) ?? DEFAULT_GOD_NAME;
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<LinkDiscovery | null>(null);
  const [searching, setSearching] = useState(false);
  const [address, setAddress] = useState('');
  const [pairing, setPairing] = useState<{ token: string; name: string; fingerprint: string; code: string } | null>(null);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const flash = (msg: string): void => { setNote(msg); setTimeout(() => setNote(''), 3000); };

  const refresh = useCallback(async () => {
    const r = await window.cth.link.status();
    if (r.ok) { setStatus(r.data); setError(''); } else setError(r.error);
  }, []);

  // Live while the tab is open: peers go on/offline, requests arrive.
  useEffect(() => {
    void refresh();
    const id = setInterval(() => { void refresh(); }, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  const run = async <T,>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, ok?: (d: T) => void): Promise<void> => {
    setBusy(true);
    try {
      const r = await fn();
      if (r.ok) { ok?.(r.data); setError(''); } else setError(r.error);
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const search = async (): Promise<void> => {
    setSearching(true);
    try {
      const r = await window.cth.link.discover();
      if (r.ok) setFound(r.data); else setError(r.error);
    } finally { setSearching(false); }
  };

  const startPair = (target: string): Promise<void> =>
    run(() => window.cth.link.pairRequest(target), (d) => setPairing(d));

  if (!status && error) {
    return <div style={muted}>{t('link.unavailable', { error })}</div>;
  }
  if (!status) return <div style={muted}>{t('link.loading')}</div>;

  const host = status.host as { ram_total_gb?: number; ram_free_gb?: number; cpus?: number };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <div style={label}>{t('link.title')}</div>
        <span style={muted}>{t('link.desc', { godName })}</span>
      </div>

      {error && <div style={{ ...muted, color: 'var(--cth-coral)' }}>{error}</div>}
      {note && <div style={{ ...muted, color: 'var(--cth-ink-900)' }}>{note}</div>}

      {/* THIS OFFICE */}
      <section>
        <div style={label}>{t('link.thisOffice')}</div>
        <div style={card}>
          <span style={dot(status.daemon.running)} />
          <strong style={{ fontSize: 13 }}>{status.self.name}</strong>
          <span style={{ ...mono, color: 'var(--cth-ink-500)' }}>{status.self.fingerprint}</span>
          <span style={{ flex: 1 }} />
          {status.daemon.running ? (
            <PixelButton size="sm" variant="secondary" disabled={busy} onClick={() => run(() => window.cth.link.stop())}>
              {t('link.turnOff')}
            </PixelButton>
          ) : (
            <PixelButton size="sm" disabled={busy} onClick={() => run(() => window.cth.link.start())}>
              {t('link.turnOn')}
            </PixelButton>
          )}
        </div>
        <div style={{ ...muted, marginTop: 6 }}>
          {status.daemon.running
            ? t('link.onDetail', { pid: status.daemon.pid, port: status.daemon.port })
            : t('link.offDetail')}
          {' · '}
          {t('link.host', { ram: num(host.ram_total_gb), free: num(host.ram_free_gb), cpus: num(host.cpus) })}
        </div>
        <div style={{ ...muted, marginTop: 2 }}>
          {status.hive ? t('link.hive', { path: status.hive }) : t('link.noHive')}
        </div>
      </section>

      {/* INCOMING REQUESTS */}
      {status.pending.length > 0 && (
        <section>
          <div style={label}>{t('link.pending')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {status.pending.map((p) => (
              <div key={p.office_id} style={card}>
                <strong style={{ fontSize: 13 }}>{p.name}</strong>
                {p.phone && <span style={muted}>{t('link.phoneBadge')}</span>}
                <span style={{ ...mono, color: 'var(--cth-ink-500)' }}>{p.fingerprint}</span>
                {p.from.length > 0 && <span style={muted}>{t('link.from', { from: p.from.join(' ') })}</span>}
                <span style={{ flex: 1 }} />
                <span style={{ ...mono, fontSize: 18, fontWeight: 700, letterSpacing: 2 }}>{bigCode(p.code)}</span>
                <PixelButton size="sm" disabled={busy}
                  onClick={() => run(() => window.cth.link.accept(p.code), (d) => flash(t('link.accepted', { name: d.name })))}>
                  {t('link.accept')}
                </PixelButton>
              </div>
            ))}
            <span style={muted}>{t('link.pendingHint', { godName })}</span>
            {status.pending.some((p) => p.phone) && <span style={muted}>{t('link.pendingPhoneHint', { godName })}</span>}
          </div>
        </section>
      )}

      {/* LINKED OFFICES */}
      <section>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <div style={{ ...label, marginBottom: 0 }}>{t('link.linked')}</div>
          <span style={{ flex: 1 }} />
          <PixelButton size="sm" variant="ghost" disabled={busy} onClick={() => { void refresh(); }}>{t('link.refresh')}</PixelButton>
        </div>
        {status.peers.length === 0 && <span style={muted}>{t('link.noPeers')}</span>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {status.peers.map((p) => {
            const c = (p.capacity ?? {}) as { workers_idle?: number; workers_total?: number; ram_free_gb?: number; ram_total_gb?: number; michael_state?: string };
            return (
              <div key={p.office_id} style={card}>
                <span style={dot(p.online)} />
                <strong style={{ fontSize: 13 }}>{p.name}</strong>
                <span style={{ ...mono, color: 'var(--cth-ink-500)' }}>{p.fingerprint}</span>
                <span style={muted}>
                  {p.online
                    ? t('link.peerOnline', {
                      idle: num(c.workers_idle), total: num(c.workers_total),
                      free: num(c.ram_free_gb), ram: num(c.ram_total_gb),
                      state: c.michael_state ?? '?', ms: p.latency_ms, address: p.address
                    })
                    : p.waiting ? t('link.peerWaiting') : t('link.peerOffline', { error: p.error ?? '' })}
                </span>
                <span style={{ flex: 1 }} />
                {forgetting === p.office_id ? (
                  <>
                    <PixelButton size="sm" variant="destructive" disabled={busy}
                      onClick={() => run(() => window.cth.link.forget(p.office_id), () => setForgetting(null))}>
                      {t('link.forgetConfirm')}
                    </PixelButton>
                    <PixelButton size="sm" variant="ghost" onClick={() => setForgetting(null)}>{t('link.cancel')}</PixelButton>
                  </>
                ) : (
                  <PixelButton size="sm" variant="ghost" onClick={() => setForgetting(p.office_id)}>{t('link.forget')}</PixelButton>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* PHONES (Munder Remote) */}
      <section>
        <div style={label}>{t('link.phones')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={muted}>{t('link.phonesDesc', { godName })}</span>
          {!status.daemon.running && <span style={muted}>{t('link.turnOnFirst')}</span>}
          {status.appUrls.map((u) => (
            <div key={u.url} style={card}>
              <span style={{ ...mono, userSelect: 'text' }}>{u.url}</span>
              <span style={muted}>{u.via === 'tailscale' ? t('link.viaTailscale') : t('link.viaLan', { ifname: u.ifname })}</span>
            </div>
          ))}
          {status.appUrls.length === 0 && <span style={muted}>{t('link.noAppUrls')}</span>}
          {status.phones.length === 0 && <span style={muted}>{t('link.noPhones')}</span>}
          {status.phones.map((ph) => (
            <div key={ph.device_id} style={card}>
              <strong style={{ fontSize: 13 }}>{ph.name}</strong>
              <span style={{ ...mono, color: 'var(--cth-ink-500)' }}>{ph.fingerprint}</span>
              <span style={{ flex: 1 }} />
              {forgetting === ph.device_id ? (
                <>
                  <PixelButton size="sm" variant="destructive" disabled={busy}
                    onClick={() => run(() => window.cth.link.forgetPhone(ph.device_id), () => setForgetting(null))}>
                    {t('link.forgetConfirm')}
                  </PixelButton>
                  <PixelButton size="sm" variant="ghost" onClick={() => setForgetting(null)}>{t('link.cancel')}</PixelButton>
                </>
              ) : (
                <PixelButton size="sm" variant="ghost" onClick={() => setForgetting(ph.device_id)}>{t('link.forget')}</PixelButton>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* PAIR A NEW OFFICE */}
      <section>
        <div style={label}>{t('link.connect')}</div>
        {pairing ? (
          <div style={{ ...card, flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
            <span style={{ fontSize: 13 }}>{t('link.pairingWith', { name: pairing.name, fingerprint: pairing.fingerprint })}</span>
            <span style={{ ...mono, fontSize: 28, fontWeight: 700, letterSpacing: 4 }}>{bigCode(pairing.code)}</span>
            <span style={muted}>{t('link.pairingHint', { name: pairing.name })}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <PixelButton size="sm" disabled={busy}
                onClick={() => run(() => window.cth.link.pairConfirm(pairing.token), (d) => { setPairing(null); flash(t('link.paired', { name: d.name })); })}>
                {t('link.codesMatch')}
              </PixelButton>
              <PixelButton size="sm" variant="ghost" onClick={() => setPairing(null)}>{t('link.codesDiffer')}</PixelButton>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {!status.daemon.running && <span style={muted}>{t('link.turnOnFirst')}</span>}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <PixelButton size="sm" variant="secondary" disabled={searching || busy} onClick={() => { void search(); }}>
                {searching ? t('link.searching') : t('link.search')}
              </PixelButton>
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder={t('link.addressPlaceholder')}
                style={input}
              />
              <PixelButton size="sm" disabled={busy || !address.trim()} onClick={() => { void startPair(address.trim()); }}>
                {t('link.pair')}
              </PixelButton>
            </div>
            {found && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {found.offices.length === 0 && <span style={muted}>{t('link.nothingFound')}</span>}
                {found.offices.map((o) => (
                  <div key={o.office_id} style={card}>
                    <strong style={{ fontSize: 13 }}>{o.name}</strong>
                    <span style={{ ...mono, color: 'var(--cth-ink-500)' }}>{o.fingerprint}</span>
                    <span style={muted}>{o.address} · {o.via}</span>
                    <span style={{ flex: 1 }} />
                    {o.paired
                      ? <span style={muted}>{t('link.alreadyLinked')}</span>
                      : <PixelButton size="sm" disabled={busy} onClick={() => { void startPair(o.address); }}>{t('link.pair')}</PixelButton>}
                  </div>
                ))}
                {!found.tailscale && <span style={muted}>{t('link.noTailscale')}</span>}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
