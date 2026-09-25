/**
 * Settings → Munder Link: the app's side of `munder link`.
 *
 * Deliberately a thin layer over `tools/munder/lib-link.cjs`, the engine the CLI
 * uses, so the app and the terminal can never disagree: the same identity, the
 * same peers file, the same daemon pid file. Turning the link on here starts the
 * same detached server `munder link encender` starts, and `munder link apagar`
 * turns it off again (and vice versa).
 *
 * Trust stays explicit. Pairing from the app is two steps like the CLI: request
 * (shows the 6-digit code) and confirm once the human saw the SAME code on the
 * other screen. The peer's keys are held HERE between those steps, keyed by an
 * opaque token; the renderer only ever sends the token back, so it cannot slip
 * in keys of its own.
 *
 * Phones (Munder Remote, tools/munder/lib-remote.cjs) pair through the same
 * pending list and the same accept step; they land in remotes.json, never among
 * the peers, and are listed and revoked here separately.
 *
 * Electron-free on purpose: the lib and the daemon spawner are injected, so the
 * focused tests drive it against the real lib with temp state dirs.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';

/** The subset of lib-link.cjs this panel uses. */
export interface LinkLib {
  DEFAULT_PORT: number;
  files(): { pid: string; log: string };
  stateDir(): string;
  loadIdentity(): { name: string; office_id: string };
  prettyFingerprint(officeId: string): string;
  localHiveRoot(): string | null;
  hostCapacity(): Record<string, unknown>;
  loadPeers(): Record<string, { office_id: string; name: string; addresses?: string[]; paired_at?: string }>;
  loadPending(): Record<string, { office_id: string; name: string; code: string; kind?: 'remote'; addresses?: string[]; expires_at: number }>;
  call(query: string, op: string, args?: object, opts?: { timeoutMs?: number }): Promise<{ result: { capacity?: Record<string, unknown> }; latency_ms: number; address: string }>;
  discoverLan(): Promise<Array<{ office_id: string; name: string; address: string; via: string }>>;
  discoverTailscale(): Promise<{ available: boolean; offices: Array<{ office_id: string; name: string; address: string; via: string }> }>;
  requestPair(address: string, opts?: { port?: number }): Promise<{ peer: { office_id: string; name: string; sign_pub: string; box_pub: string; addresses: string[] }; code: string }>;
  trustPeer(peer: unknown): { office_id: string; name: string };
  acceptPending(code: string): { office_id: string; name: string } | null;
  forgetPeer(query: string): { office_id: string; name: string } | null;
  /** Munder Remote: paired phones and where they reach this office. */
  loadRemotes(): Record<string, { device_id: string; name: string; paired_at?: string }>;
  forgetRemote(query: string): { office_id: string; name: string } | null;
  appUrls(port?: number): Array<{ url: string; via: 'lan' | 'tailscale'; ifname: string }>;
}

export interface LinkPeerView {
  office_id: string;
  name: string;
  fingerprint: string;
  addresses: string[];
  online: boolean;
  latency_ms?: number;
  address?: string;
  capacity?: Record<string, unknown>;
  /** Why it is not online: waiting for the other side to accept, or unreachable. */
  error?: string;
  waiting?: boolean;
}

export interface LinkStatus {
  self: { name: string; office_id: string; fingerprint: string };
  daemon: { running: boolean; pid: number | null; port: number };
  hive: string | null;
  host: Record<string, unknown>;
  peers: LinkPeerView[];
  pending: Array<{ office_id: string; name: string; fingerprint: string; code: string; from: string[]; expires_at: number; phone: boolean }>;
  /** Phones paired through Munder Remote (the /app served by the link daemon). */
  phones: Array<{ device_id: string; name: string; fingerprint: string; paired_at: string | null }>;
  /** Addresses to open on the phone, Tailscale first. */
  appUrls: Array<{ url: string; via: 'lan' | 'tailscale'; ifname: string }>;
}

const PAIR_TTL_MS = 10 * 60_000;

export class LinkPanel {
  private readonly pairs = new Map<string, { peer: unknown; name: string; expires: number }>();

  constructor(
    private readonly lib: LinkLib,
    /** Start the detached server; returns its pid. */
    private readonly spawnDaemon: (logFile: string) => number,
    private readonly now: () => number = () => Date.now()
  ) {}

  daemonPid(): number | null {
    try {
      const pid = Number(readFileSync(this.lib.files().pid, 'utf8').trim());
      if (pid > 0) { process.kill(pid, 0); return pid; }
    } catch { /* not running */ }
    return null;
  }

  async status(): Promise<LinkStatus> {
    const me = this.lib.loadIdentity();
    const pid = this.daemonPid();
    const peers = Object.values(this.lib.loadPeers());
    const live = await Promise.all(peers.map(async (p): Promise<LinkPeerView> => {
      const base = { office_id: p.office_id, name: p.name, fingerprint: this.lib.prettyFingerprint(p.office_id), addresses: p.addresses ?? [] };
      try {
        const r = await this.lib.call(p.office_id, 'status', {}, { timeoutMs: 3000 });
        return { ...base, online: true, latency_ms: r.latency_ms, address: r.address, capacity: r.result.capacity };
      } catch (e) {
        const code = (e as { code?: string }).code;
        return { ...base, online: false, waiting: code === 'unknown_peer', error: e instanceof Error ? e.message : String(e) };
      }
    }));
    const pending = Object.values(this.lib.loadPending()).map((p) => ({
      office_id: p.office_id, name: p.name, fingerprint: this.lib.prettyFingerprint(p.office_id),
      code: p.code, from: p.addresses ?? [], expires_at: p.expires_at, phone: p.kind === 'remote'
    }));
    const phones = Object.values(this.lib.loadRemotes()).map((r) => ({
      device_id: r.device_id, name: r.name, fingerprint: this.lib.prettyFingerprint(r.device_id), paired_at: r.paired_at ?? null
    }));
    return {
      self: { name: me.name, office_id: me.office_id, fingerprint: this.lib.prettyFingerprint(me.office_id) },
      daemon: { running: pid !== null, pid, port: this.lib.DEFAULT_PORT },
      hive: this.lib.localHiveRoot(),
      host: this.lib.hostCapacity(),
      peers: live,
      pending,
      phones,
      appUrls: this.lib.appUrls(this.lib.DEFAULT_PORT)
    };
  }

  /** Same contract as `munder link encender`: idempotent, pid file shared with the CLI. */
  start(): { ok: true; pid: number; already: boolean } {
    const running = this.daemonPid();
    if (running) return { ok: true, pid: running, already: true };
    mkdirSync(this.lib.stateDir(), { recursive: true, mode: 0o700 });
    const pid = this.spawnDaemon(this.lib.files().log);
    writeFileSync(this.lib.files().pid, String(pid));
    return { ok: true, pid, already: false };
  }

  stop(): { ok: true; pid: number | null } {
    const pid = this.daemonPid();
    if (pid) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    try { unlinkSync(this.lib.files().pid); } catch { /* none */ }
    return { ok: true, pid };
  }

  /** Offices on the LAN and on Tailscale. Lists only; never trusts. */
  async discover(): Promise<{ offices: Array<{ office_id: string; name: string; fingerprint: string; address: string; via: string; paired: boolean }>; tailscale: boolean }> {
    const me = this.lib.loadIdentity().office_id;
    const [lan, ts] = await Promise.all([this.lib.discoverLan(), this.lib.discoverTailscale()]);
    const peers = this.lib.loadPeers();
    const seen = new Map<string, { office_id: string; name: string; fingerprint: string; address: string; via: string; paired: boolean }>();
    for (const o of [...lan, ...ts.offices]) {
      if (o.office_id === me || seen.has(o.office_id)) continue;
      seen.set(o.office_id, { office_id: o.office_id, name: o.name, fingerprint: this.lib.prettyFingerprint(o.office_id), address: o.address, via: o.via, paired: !!peers[o.office_id] });
    }
    return { offices: [...seen.values()], tailscale: ts.available };
  }

  /** Step 1: ask the other office. Returns the code both screens must show. */
  async pairRequest(address: string): Promise<{ token: string; name: string; fingerprint: string; code: string }> {
    const target = String(address ?? '').trim();
    if (!target || target.length > 200) throw new Error('dirección inválida');
    for (const [k, v] of this.pairs) if (v.expires < this.now()) this.pairs.delete(k);
    const { peer, code } = await this.lib.requestPair(target, { port: this.lib.DEFAULT_PORT });
    const token = randomBytes(16).toString('hex');
    this.pairs.set(token, { peer, name: peer.name, expires: this.now() + PAIR_TTL_MS });
    return { token, name: peer.name, fingerprint: this.lib.prettyFingerprint(peer.office_id), code };
  }

  /** Step 2: the human confirmed the codes match. Only a token issued above works. */
  pairConfirm(token: string): { office_id: string; name: string } {
    const hit = this.pairs.get(String(token));
    if (!hit || hit.expires < this.now()) throw new Error('esa solicitud ya no existe; vuelve a emparejar');
    this.pairs.delete(String(token));
    return this.lib.trustPeer(hit.peer);
  }

  /** The other office asked us; the human saw this same code on its screen. */
  accept(code: string): { office_id: string; name: string } {
    const clean = String(code ?? '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(clean)) throw new Error('el código son 6 dígitos');
    const peer = this.lib.acceptPending(clean);
    if (!peer) throw new Error('ninguna solicitud pendiente tiene ese código');
    return peer;
  }

  forget(officeId: string): { office_id: string; name: string } {
    const p = this.lib.forgetPeer(String(officeId ?? ''));
    if (!p) throw new Error('esa oficina no está enlazada');
    return p;
  }

  /** Revoke a phone. It stops working on its next call; the phone itself can't undo this. */
  forgetPhone(deviceId: string): { office_id: string; name: string } {
    const id = String(deviceId ?? '');
    if (!this.lib.loadRemotes()[id]) throw new Error('ese celular no está emparejado');
    const p = this.lib.forgetRemote(id);
    if (!p) throw new Error('ese celular no está emparejado');
    return p;
  }
}
