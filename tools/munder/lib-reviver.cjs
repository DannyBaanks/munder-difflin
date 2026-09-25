'use strict';
/**
 * Munder Reviver: the maintenance plane.
 *
 *   Munder may die. Its ability to be started must not die with it.
 *
 * A small daemon that lives next to Munder (systemd --user on Linux, a logon
 * scheduled task on Windows) and can do exactly four things to ONE configured
 * Munder instance: status, start, restart, stop. Nothing else. There is no
 * exec, no path, no argument the caller can choose: the launch target lives in
 * config.json, which only the local user can edit.
 *
 * Independent on purpose: only node builtins, its own key, its own authorized
 * clients, its own state dir. It never needs Munder, Link, the hive or
 * Electron to be alive. The only things it reads from Munder are files on disk
 * (the control channel's munder-control.json) and Munder's own `GET /salud`.
 *
 * Healthy is not "a PID exists". Healthy means ALL of:
 *   - a process runs the configured executable with the configured arguments;
 *   - the control channel written into the configured userData answers /salud
 *     with that file's per-boot token;
 *   - /salud names that same pid;
 *   - /salud names the pinned office id.
 *
 * Wire protocol (munder-reviver@1, see REVIVER.md): every request is a JSON
 * body signed with an authorized client's Ed25519 key, bound to this reviver
 * and this office, with a timestamp and a single-use nonce. Every answer is
 * signed with the reviver's own key and echoes the nonce.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const PROTOCOL = 'munder-reviver@1';
const DEFAULT_PORT = Number(process.env.MUNDER_REVIVER_PORT) || 47833;
const OPS = ['status', 'receipts', 'start', 'restart', 'stop'];
const MUTATING = new Set(['start', 'restart', 'stop']);
const MAX_BODY = 8 * 1024;
const SKEW_MS = 60_000;
const MAX_RECEIPTS = 400;
const POLITE_SIGNALS = new Set(['SIGTERM', 'SIGINT', 'SIGHUP']);

class ReviverError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ─── files ───────────────────────────────────────────────────────────────────
function stateDir() {
  const base = process.env.MUNDER_STATE_DIR
    || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'munder');
  return process.env.MUNDER_REVIVER_DIR || path.join(base, 'reviver');
}

const files = (dir = stateDir()) => ({
  config: path.join(dir, 'config.json'),
  identity: path.join(dir, 'identity.json'),
  clients: path.join(dir, 'clients.json'),
  local: path.join(dir, 'local-client.json'),
  state: path.join(dir, 'state.json'),
  receipts: path.join(dir, 'receipts.jsonl'),
  pid: path.join(dir, 'reviver.pid'),
  log: path.join(dir, 'reviver.log'),
  runs: path.join(dir, 'runs'),
});

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return fallback; }
}

function writePrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* windows */ }
}

// ─── keys ────────────────────────────────────────────────────────────────────
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const idOf = (pub) => crypto.createHash('sha256').update(Buffer.from(String(pub), 'base64url')).digest('hex').slice(0, 16);
const privKey = (k) => crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x: k.x, d: k.d }, format: 'jwk' });
const pubKey = (x) => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });

function newKeyPair() {
  const jwk = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  return { x: jwk.x, d: jwk.d };
}

function loadIdentity(dir = stateDir()) {
  const f = files(dir).identity;
  const existing = readJson(f, null);
  if (existing && existing.x && existing.d) return existing;
  const k = newKeyPair();
  const identity = { protocol: PROTOCOL, reviver_id: idOf(k.x), name: `reviver-${os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 24)}`, x: k.x, d: k.d, created_at: new Date().toISOString() };
  writePrivate(f, identity);
  return identity;
}

const sign = (key, domain, raw) => b64u(crypto.sign(null, Buffer.concat([Buffer.from(`${PROTOCOL}|${domain}\n`), Buffer.from(raw)]), privKey(key)));
function verify(x, domain, raw, sig) {
  try {
    return crypto.verify(null, Buffer.concat([Buffer.from(`${PROTOCOL}|${domain}\n`), Buffer.from(raw)]), pubKey(x), Buffer.from(String(sig), 'base64url'));
  } catch { return false; }
}

// ─── clients (who may call) ──────────────────────────────────────────────────
function loadClients(dir = stateDir()) {
  const c = readJson(files(dir).clients, null);
  return c && typeof c.clients === 'object' && c.clients ? c.clients : {};
}

function authorizeClient(dir, name, x, extra = {}) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(x))) throw new ReviverError('bad_key', 'la llave pública no es Ed25519 (43 caracteres base64url)');
  try { pubKey(x); } catch { throw new ReviverError('bad_key', 'la llave pública no es Ed25519'); }
  const clients = loadClients(dir);
  const client_id = idOf(x);
  clients[client_id] = { name: String(name || client_id).slice(0, 64), x, added_at: new Date().toISOString(), ...extra };
  writePrivate(files(dir).clients, { clients });
  return { client_id, name: clients[client_id].name };
}

function revokeClient(dir, query) {
  const clients = loadClients(dir);
  const hit = Object.entries(clients).find(([id, c]) => id === query || c.name === query);
  if (!hit) return null;
  delete clients[hit[0]];
  writePrivate(files(dir).clients, { clients });
  return { client_id: hit[0], name: hit[1].name };
}

/** A new client key for someone else (an MCP adapter, another machine). Only the public half stays here. */
function newClientCredential(dir, name, address) {
  const identity = loadIdentity(dir);
  const config = loadConfig(dir);
  const k = newKeyPair();
  const { client_id } = authorizeClient(dir, name, k.x);
  return {
    protocol: PROTOCOL, client_id, name,
    key: { x: k.x, d: k.d },
    reviver: { reviver_id: identity.reviver_id, x: identity.x, office_id: config.office_id, address: address || `127.0.0.1:${config.port}` },
  };
}

/** The local CLI's own credential (loopback use by the same OS user). */
function localCredential(dir = stateDir()) {
  const f = files(dir).local;
  const existing = readJson(f, null);
  const identity = loadIdentity(dir);
  const config = loadConfig(dir);
  if (existing && existing.key && loadClients(dir)[existing.client_id]) {
    existing.reviver = { reviver_id: identity.reviver_id, x: identity.x, office_id: config.office_id, address: `${loopbackHost(config.bind)}:${config.port}` };
    return existing;
  }
  const k = newKeyPair();
  const { client_id } = authorizeClient(dir, 'local', k.x, { local: true });
  const cred = { protocol: PROTOCOL, client_id, name: 'local', key: k, reviver: { reviver_id: identity.reviver_id, x: identity.x, office_id: config.office_id, address: `${loopbackHost(config.bind)}:${config.port}` } };
  writePrivate(f, cred);
  return cred;
}

function loopbackHost(bind) {
  if (!bind || bind === '0.0.0.0' || bind === '::' || bind === '127.0.0.1' || bind === 'localhost') return '127.0.0.1';
  return bind;
}

// ─── config (the launch target is ONLY here) ─────────────────────────────────
const DEFAULT_WATCHDOG = { enabled: true, interval_ms: 15_000, max_attempts: 3, window_ms: 10 * 60_000, backoff_ms: [5_000, 30_000, 120_000] };

function validateConfig(c) {
  const errors = [];
  if (!c || typeof c !== 'object') return ['config.json no es un objeto'];
  if (typeof c.office_id !== 'string' || !/^[0-9a-f]{16}$/.test(c.office_id)) errors.push('office_id: se esperan 16 hex (la huella de la oficina)');
  const t = c.target;
  if (!t || typeof t !== 'object') errors.push('target: falta');
  else {
    if (typeof t.exe !== 'string' || !path.isAbsolute(t.exe)) errors.push('target.exe: ruta absoluta');
    if (!Array.isArray(t.args) || !t.args.every((a) => typeof a === 'string')) errors.push('target.args: lista de textos');
    if (typeof t.cwd !== 'string' || !path.isAbsolute(t.cwd)) errors.push('target.cwd: ruta absoluta');
    if (t.env !== undefined && (typeof t.env !== 'object' || !Object.values(t.env).every((v) => typeof v === 'string'))) errors.push('target.env: objeto de textos');
  }
  if (typeof c.user_data !== 'string' || !path.isAbsolute(c.user_data)) errors.push('user_data: ruta absoluta (el userData de Munder)');
  if (typeof c.port !== 'number' || !(c.port >= 0 && c.port < 65536)) errors.push('port: número');
  if (typeof c.bind !== 'string' || !c.bind) errors.push('bind: dirección');
  return errors;
}

function loadConfig(dir = stateDir()) {
  const raw = readJson(files(dir).config, null);
  if (!raw) throw new ReviverError('no_config', `sin configuración en ${files(dir).config}: corre munder-reviver init`, 503);
  const c = {
    bind: '127.0.0.1', port: DEFAULT_PORT, autostart: false,
    health_timeout_ms: 90_000, stop_timeout_ms: 10_000, probe_timeout_ms: 3_000,
    ...raw,
    watchdog: { ...DEFAULT_WATCHDOG, ...(raw.watchdog || {}) },
  };
  const errors = validateConfig(c);
  if (errors.length) throw new ReviverError('bad_config', `config.json inválido: ${errors.join('; ')}`, 503);
  return c;
}

function saveConfig(dir, c) {
  const errors = validateConfig({ bind: '127.0.0.1', port: DEFAULT_PORT, ...c });
  if (errors.length) throw new ReviverError('bad_config', errors.join('; '));
  writePrivate(files(dir).config, c);
}

// ─── the process table ───────────────────────────────────────────────────────
// { pid, ppid, exe, cmd, start } per process. `start` is an opaque stamp that
// changes if a pid is reused, so a kill never lands on a recycled pid.
function procsLinux() {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      let exe = null;
      try { exe = fs.readlinkSync(`/proc/${d}/exe`).replace(/ \(deleted\)$/, ''); } catch { /* not ours */ }
      const cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').filter(Boolean);
      out.push({ pid: Number(d), ppid: Number(rest[1]), start: rest[19], exe, argv: cmd, cmd: cmd.join(' ') });
    } catch { /* exited while reading */ }
  }
  return out;
}

function procsWindows() {
  const ps = 'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p = $_.ProcessId; pp = $_.ParentProcessId; e = $_.ExecutablePath; c = $_.CommandLine; s = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 } } } | ConvertTo-Json -Compress';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
  if (r.status !== 0) throw new ReviverError('proc_table', `no pude leer los procesos: ${(r.stderr || r.error || '').toString().slice(0, 200)}`, 500);
  let list = JSON.parse(r.stdout || '[]');
  if (!Array.isArray(list)) list = [list];
  return list.map((x) => ({ pid: x.p, ppid: x.pp, start: String(x.s), exe: x.e || null, argv: x.c ? splitWindowsCmd(x.c) : null, cmd: x.c || '' }));
}

/** CommandLineToArgvW's rules, so args compare exactly (C:\a\munder is not C:\a\munder2). */
function splitWindowsCmd(cmd) {
  const out = [];
  let cur = '';
  let quoted = false;
  let any = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '\\') {
      let n = 0;
      while (cmd[i] === '\\') { n++; i++; }
      if (cmd[i] === '"') { cur += '\\'.repeat(Math.floor(n / 2)); if (n % 2) { cur += '"'; any = true; continue; } i--; continue; }
      cur += '\\'.repeat(n); any = true; i--; continue;
    }
    if (c === '"') { quoted = !quoted; any = true; continue; }
    if ((c === ' ' || c === '\t') && !quoted) { if (any) out.push(cur); cur = ''; any = false; continue; }
    cur += c; any = true;
  }
  if (any) out.push(cur);
  return out;
}

function procsDarwin() {
  const run = (fmt) => spawnSync('ps', ['-axww', '-o', fmt], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout || '';
  const byPid = new Map();
  for (const line of run('pid=,ppid=,lstart=').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (m) byPid.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), start: m[3].trim(), exe: null, argv: null, cmd: '' });
  }
  for (const line of run('pid=,comm=').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (m && byPid.has(Number(m[1]))) byPid.get(Number(m[1])).exe = m[2];
  }
  for (const line of run('pid=,args=').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (m && byPid.has(Number(m[1]))) byPid.get(Number(m[1])).cmd = m[2];
  }
  return [...byPid.values()];
}

function systemProcs() {
  if (process.platform === 'linux') return procsLinux();
  if (process.platform === 'win32') return procsWindows();
  if (process.platform === 'darwin') return procsDarwin();
  throw new ReviverError('unsupported', `plataforma no soportada: ${process.platform}`, 501);
}

const samePath = (a, b) => {
  if (!a || !b) return false;
  const norm = (p) => { let r = p; try { r = fs.realpathSync(p); } catch { /* gone */ } return process.platform === 'win32' ? r.toLowerCase() : r; };
  return norm(a) === norm(b);
};

/** Main processes of the configured target: its exe, every configured arg, and not an Electron helper (--type=). */
function candidates(table, target) {
  return table.filter((p) => {
    if (!samePath(p.exe, target.exe)) return false;
    const words = p.argv || null;
    if (/(^|\s)--type=/.test(p.cmd)) return false;
    return target.args.every((a) => (words ? words.includes(a) : p.cmd.includes(a)));
  });
}

function descendants(table, rootPid) {
  const out = [];
  const seen = new Set([rootPid]);
  let frontier = [rootPid];
  while (frontier.length) {
    const next = [];
    for (const p of table) {
      if (!seen.has(p.pid) && frontier.includes(p.ppid)) { seen.add(p.pid); out.push(p); next.push(p.pid); }
    }
    frontier = next;
  }
  return out;
}

// ─── health: Munder's own control channel ────────────────────────────────────
async function probeHealth(config, timeoutMs = config.probe_timeout_ms) {
  const file = path.join(config.user_data, 'munder-control.json');
  const cfg = readJson(file, null);
  if (!cfg) return { channel: 'absent', reachable: false, ok: false };
  if (typeof cfg.port !== 'number' || typeof cfg.token !== 'string') return { channel: 'corrupt', reachable: false, ok: false };
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/salud`, {
      headers: { authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status !== 200 || body.ok !== true) return { channel: 'present', reachable: true, ok: false, detail: `respondió ${res.status}` };
    const inst = body.instance && typeof body.instance === 'object' ? body.instance : null;
    return {
      channel: 'present', reachable: true, ok: true,
      pid: inst && Number.isInteger(inst.pid) ? inst.pid : null,
      office_id: inst && typeof inst.office_id === 'string' ? inst.office_id : null,
      version: inst && typeof inst.version === 'string' ? inst.version : null,
      started_at: inst && typeof inst.started_at === 'string' ? inst.started_at : null,
    };
  } catch (e) {
    return { channel: 'present', reachable: false, ok: false, detail: (e && e.cause && e.cause.code) || (e && e.name) || String(e) };
  }
}

/**
 * One look at the world. `state` is the whole verdict:
 *   healthy        our process + /salud ok + same pid + pinned office id
 *   down           no process of the target, nothing answering
 *   starting       our process exists, /salud not (yet) answering
 *   wrong_identity /salud answers for a different office
 *   foreign        /salud answers from a pid that is not the configured target
 *   ambiguous      more than one process matches the target
 */
async function observe(config, deps) {
  const table = deps.procs();
  const mains = candidates(table, config.target);
  const health = await deps.probe(config);
  const pids = mains.map((p) => p.pid);
  let state;
  if (health.ok && health.office_id && health.office_id !== config.office_id) state = 'wrong_identity';
  else if (health.ok && health.pid && !pids.includes(health.pid)) state = 'foreign';
  else if (mains.length > 1) state = 'ambiguous';
  else if (mains.length === 1 && health.ok && health.pid === mains[0].pid && health.office_id === config.office_id) state = 'healthy';
  else if (mains.length === 1 && health.ok && !health.office_id) state = 'unverified';
  else if (mains.length === 1) state = 'starting';
  else if (health.ok) state = 'foreign';
  else state = 'down';
  return {
    at: new Date().toISOString(),
    state,
    running: mains.length > 0,
    pids,
    main: mains.length === 1 ? { pid: mains[0].pid, start: mains[0].start } : null,
    health: { channel: health.channel, reachable: health.reachable, ok: health.ok, detail: health.detail },
    health_ok: health.ok,
    identity_verified: health.ok && health.office_id === config.office_id,
    office_seen: health.office_id || null,
    health_pid: health.pid || null,
    version: health.version || null,
    table,
  };
}

const publicObs = (o) => { const { table, ...rest } = o; return rest; };

// ─── receipts ────────────────────────────────────────────────────────────────
function appendReceipt(dir, receipt) {
  const f = files(dir).receipts;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(f, JSON.stringify(receipt) + '\n', { mode: 0o600 });
  try {
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    if (lines.length > MAX_RECEIPTS) fs.writeFileSync(f, lines.slice(-MAX_RECEIPTS / 2).join('\n') + '\n', { mode: 0o600 });
  } catch { /* best effort */ }
}

function readReceipts(dir, n = 10) {
  try {
    return fs.readFileSync(files(dir).receipts, 'utf8').split('\n').filter(Boolean).slice(-n).map((l) => JSON.parse(l));
  } catch { return []; }
}

// ─── the engine ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function defaultDeps() {
  return {
    procs: systemProcs,
    probe: (config) => probeHealth(config),
    now: () => Date.now(),
    sleep,
    alive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } },
    terminate: (pid) => {
      // Ask first. Windows: taskkill without /F closes the window (Electron quits cleanly).
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid)], { windowsHide: true, timeout: 10_000 });
      else { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    },
    forceKill: (pid) => {
      if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true, timeout: 10_000 });
      else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    },
  };
}

/**
 * The Reviver. `dir` holds config/identity/clients/state/receipts; `deps`
 * swaps the OS for tests (process table, probe, clock, signals).
 */
class Reviver {
  constructor({ dir = stateDir(), deps = {}, log = () => {} } = {}) {
    this.dir = dir;
    this.deps = { ...defaultDeps(), ...deps };
    this.log = log;
    this.busy = null;
    this.children = new Map(); // pid → { exit: {code, signal} | null } for processes we spawned
    const st = readJson(files(dir).state, {});
    this.state = {
      desired: st.desired === 'running' || st.desired === 'stopped' ? st.desired : null,
      last: st.last || null,
      launched: st.launched || null,
    };
    // Watchdog memory is per daemon lifetime: it arms on an observed healthy
    // Munder or an operator start/restart, never on a stale file.
    this.watchdog = { state: 'idle', attempts: [], next_at: 0, last: null };
  }

  config() { return loadConfig(this.dir); }

  saveState() {
    try { writePrivate(files(this.dir).state, this.state); } catch (e) { this.log(`state: ${e.message}`); }
  }

  async status() {
    const config = this.config();
    const identity = loadIdentity(this.dir);
    const o = await observe(config, this.deps);
    if (o.state === 'healthy' && this.watchdog.state === 'idle' && this.state.desired !== 'stopped') this.watchdog.state = 'armed';
    return {
      protocol: PROTOCOL,
      reviver: { reviver_id: identity.reviver_id, name: identity.name, host: os.hostname(), platform: process.platform },
      office: { expected: config.office_id, seen: o.office_seen },
      target: { exe: config.target.exe, args: config.target.args, cwd: config.target.cwd, exists: fs.existsSync(config.target.exe), user_data: config.user_data },
      munder: publicObs(o),
      healthy: o.state === 'healthy',
      desired: this.state.desired,
      busy: this.busy,
      watchdog: { enabled: !!config.watchdog.enabled, state: this.watchdog.state, recent_attempts: this.watchdog.attempts.length, last: this.watchdog.last },
      last: this.state.last,
    };
  }

  /** One mutating operation at a time; the second caller gets `busy`, not a queue. */
  async exclusive(action, fn) {
    if (this.busy) throw new ReviverError('busy', `ya estoy haciendo ${this.busy}`, 409);
    this.busy = action;
    try { return await fn(); } finally { this.busy = null; }
  }

  newReceipt(action, caller, config) {
    return {
      receipt_id: crypto.randomBytes(8).toString('hex'),
      action,
      caller,
      requested_at: new Date().toISOString(),
      accepted: true,
      target_office: config.office_id,
      target: { exe: config.target.exe, args: config.target.args },
      steps: [],
    };
  }

  finish(r, verdict, reason) {
    r.verdict = verdict;
    if (reason) r.reason = reason;
    r.completed_at = new Date().toISOString();
    r.ok = verdict === 'healthy' || verdict === 'noop_healthy' || verdict === 'stopped' || verdict === 'noop_stopped';
    this.state.last = { action: r.action, receipt_id: r.receipt_id, at: r.completed_at, verdict, reason: reason || null, caller: r.caller };
    this.saveState();
    appendReceipt(this.dir, r);
    this.log(`${r.action} por ${r.caller}: ${verdict}${reason ? ` (${reason})` : ''}`);
    return r;
  }

  start(caller = 'local') {
    return this.exclusive('start', () => this.doStart(caller, 'start'));
  }

  restart(caller = 'local') {
    return this.exclusive('restart', () => this.doRestart(caller));
  }

  stop(caller = 'local') {
    return this.exclusive('stop', () => this.doStop(caller));
  }

  async doStart(caller, action) {
    const config = this.config();
    const r = this.newReceipt(action, caller, config);
    const before = await observe(config, this.deps);
    r.before = publicObs(before);
    if (caller !== 'watchdog') this.resetWatchdog();
    if (before.state === 'healthy') {
      this.state.desired = 'running';
      this.watchdog.state = 'armed';
      r.after = r.before;
      return this.finish(r, 'noop_healthy', 'ya estaba sano: no lancé otro');
    }
    if (before.state === 'wrong_identity') return this.finish(r, 'failed', `contesta otra oficina (${before.office_seen}), no ${config.office_id}`);
    if (before.state === 'foreign') return this.finish(r, 'failed', 'otro proceso contesta con este userData y no es el destino configurado: no lanzo encima');
    if (before.state === 'ambiguous') return this.finish(r, 'failed', `hay ${before.pids.length} procesos del destino (${before.pids.join(', ')}): no adivino`);
    if (before.state === 'starting' || before.state === 'unverified') {
      // A process of ours exists but is not answering yet: maybe it is booting. Never launch a twin.
      r.steps.push({ step: 'wait_existing', pid: before.main.pid });
      const after = await this.waitHealthy(config, before.main.pid);
      r.after = publicObs(after);
      if (after.state === 'healthy') { this.state.desired = 'running'; this.watchdog.state = 'armed'; return this.finish(r, 'noop_healthy', 'ya estaba arrancando: esperé a que contestara'); }
      return this.finish(r, 'failed', `ya hay un Munder (pid ${before.main.pid}) que no contesta sano (${after.state}): usa restart`);
    }
    return this.launchAndVerify(config, r);
  }

  async launchAndVerify(config, r) {
    const t = config.target;
    if (!fs.existsSync(t.exe)) return this.finish(r, 'failed', `no existe el ejecutable configurado: ${t.exe}`);
    if (!fs.existsSync(t.cwd)) return this.finish(r, 'failed', `no existe la carpeta configurada: ${t.cwd}`);
    fs.mkdirSync(files(this.dir).runs, { recursive: true, mode: 0o700 });
    const logFile = path.join(files(this.dir).runs, `munder-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    pruneRuns(files(this.dir).runs, 10);
    let child;
    try {
      const out = fs.openSync(logFile, 'a');
      child = spawn(t.exe, t.args, {
        cwd: t.cwd, detached: true, stdio: ['ignore', out, out], windowsHide: false,
        env: launchEnv(t.env),
      });
      fs.closeSync(out);
    } catch (e) {
      return this.finish(r, 'failed', `no pude lanzar: ${e.message}`);
    }
    const spawnError = await new Promise((resolve) => {
      child.once('error', (e) => resolve(e));
      child.once('spawn', () => resolve(null));
    });
    if (spawnError) {
      r.start = { spawned: false, error: spawnError.code || spawnError.message, log_file: logFile };
      return this.finish(r, 'failed', `no pude lanzar: ${spawnError.code || spawnError.message}`);
    }
    const rec = { exit: null };
    this.children.set(child.pid, rec);
    child.once('exit', (code, signal) => { rec.exit = { code, signal }; });
    child.unref();
    r.start = { spawned: true, pid: child.pid, log_file: logFile };
    this.state.launched = { pid: child.pid, at: new Date().toISOString() };
    this.state.desired = 'running';
    this.saveState();
    const after = await this.waitHealthy(config, child.pid, rec);
    r.after = publicObs(after);
    if (after.state === 'healthy') {
      this.watchdog.state = 'armed';
      return this.finish(r, 'healthy');
    }
    if (rec.exit) {
      r.start.exit = rec.exit;
      return this.finish(r, 'failed', `Munder terminó al arrancar (código ${rec.exit.code ?? '—'}${rec.exit.signal ? `, señal ${rec.exit.signal}` : ''}); log: ${logFile}`);
    }
    if (after.state === 'wrong_identity') return this.finish(r, 'failed', `arrancó, pero contesta otra oficina (${after.office_seen}), no ${config.office_id}`);
    if (after.state === 'unverified') return this.finish(r, 'failed', 'arrancó y contesta, pero no dice qué oficina es (build viejo sin identidad en /salud)');
    return this.finish(r, 'failed', `no contestó sano en ${Math.round(config.health_timeout_ms / 1000)} s (${after.state}); log: ${logFile}`);
  }

  /** Poll until healthy, a terminal state, the child's exit, or the deadline. Always bounded. */
  async waitHealthy(config, pid, rec) {
    const deadline = this.deps.now() + config.health_timeout_ms;
    let o;
    for (;;) {
      o = await observe(config, this.deps);
      if (o.state === 'healthy' || o.state === 'wrong_identity' || o.state === 'ambiguous') return o;
      if (rec && rec.exit) return o;
      if (pid && !this.deps.alive(pid) && !o.running) return o;
      if (this.deps.now() >= deadline) return o;
      await this.deps.sleep(Math.min(500, Math.max(50, config.health_timeout_ms / 20)));
    }
  }

  /**
   * Stop exactly the verified Munder. The target must be proven: /salud naming
   * our pid and office, or (Munder hung) the single process running the
   * configured exe with the configured args. Anything else (two candidates,
   * another office, a stranger answering) fails closed.
   *
   * What gets forced, if the polite ask is not enough: the main process and
   * its Chromium helpers (same exe, `--type=`), nothing else. Munder also
   * starts things that must outlive it on purpose (the Link daemon, a human's
   * terminal) and agents in their own PTY sessions: the app closes its agents
   * itself on a clean quit, and whatever of its tree is still alive is listed
   * in the receipt, never killed by a guess.
   */
  async stopVerified(config, before, r) {
    if (before.state === 'ambiguous') return { ok: false, reason: `hay ${before.pids.length} procesos del destino (${before.pids.join(', ')}): no mato a ninguno adivinando` };
    if (before.state === 'wrong_identity') return { ok: false, reason: `el que contesta es otra oficina (${before.office_seen}): no lo toco` };
    if (before.state === 'foreign') return { ok: false, reason: 'el que contesta no es el destino configurado: no lo toco' };
    if (!before.main) return { ok: true, skipped: 'no_running' };
    const verifiedBy = before.state === 'healthy' ? 'salud+pid+oficina' : 'exe+args (un solo candidato)';
    const desc = descendants(before.table, before.main.pid);
    const helpers = desc.filter((p) => samePath(p.exe, config.target.exe) && /(^|\s)--type=/.test(p.cmd));
    const others = desc.filter((p) => !helpers.includes(p));
    const tree = [before.main, ...helpers.map((p) => ({ pid: p.pid, start: p.start }))];
    r.stop = { verified_target: true, verified_by: verifiedBy, pid: before.main.pid, tree: tree.map((p) => p.pid) };
    this.deps.terminate(before.main.pid);
    const gone = await this.waitGone(before.main.pid, config.stop_timeout_ms);
    r.stop.graceful = gone;
    // Whatever of that set is still there (same pid AND same start stamp) is forced.
    let table = this.deps.procs();
    const still = tree.filter((p) => table.some((q) => q.pid === p.pid && q.start === p.start));
    if (still.length) {
      r.stop.forced = still.map((p) => p.pid);
      for (const p of still) this.deps.forceKill(p.pid);
      await this.waitGone(before.main.pid, 5_000);
    }
    table = this.deps.procs();
    const exited = !table.some((q) => q.pid === before.main.pid && q.start === before.main.start);
    r.stop.exit_confirmed = exited;
    r.stop.left_running = others
      .filter((p) => table.some((q) => q.pid === p.pid && q.start === p.start))
      .map((p) => ({ pid: p.pid, name: path.basename(p.exe || (p.cmd || '').split(' ')[0] || '?') }));
    if (!exited) return { ok: false, reason: `el proceso ${before.main.pid} no terminó` };
    return { ok: true };
  }

  async waitGone(pid, ms) {
    const deadline = this.deps.now() + ms;
    while (this.deps.now() < deadline) {
      if (!this.deps.alive(pid)) return true;
      await this.deps.sleep(100);
    }
    return !this.deps.alive(pid);
  }

  async doRestart(caller) {
    const config = this.config();
    const r = this.newReceipt('restart', caller, config);
    this.resetWatchdog();
    const before = await observe(config, this.deps);
    r.before = publicObs(before);
    const prev = this.state.desired;
    this.state.desired = 'stopping';
    const s = await this.stopVerified(config, before, r);
    if (!s.ok) { this.state.desired = prev; return this.finish(r, 'failed', s.reason); }
    if (s.skipped) r.stop = { skipped: 'no estaba corriendo' };
    return this.launchAndVerify(config, r);
  }

  async doStop(caller) {
    const config = this.config();
    const r = this.newReceipt('stop', caller, config);
    const before = await observe(config, this.deps);
    r.before = publicObs(before);
    // Intentional: the watchdog must not bring it back.
    const prev = this.state.desired;
    this.state.desired = 'stopped';
    this.watchdog.state = 'idle';
    this.saveState();
    const s = await this.stopVerified(config, before, r);
    if (!s.ok) { this.state.desired = prev; return this.finish(r, 'failed', s.reason); }
    if (s.skipped) return this.finish(r, 'noop_stopped', 'ya estaba parado');
    const after = await observe(config, this.deps);
    r.after = publicObs(after);
    return this.finish(r, after.running ? 'failed' : 'stopped', after.running ? 'sigue corriendo' : null);
  }

  resetWatchdog() {
    this.watchdog.attempts = [];
    this.watchdog.next_at = 0;
    if (this.watchdog.state === 'failed') this.watchdog.state = 'idle';
  }

  /**
   * One watchdog tick. Acts only when armed (Munder was seen healthy, or an
   * operator started it, in this daemon's lifetime) and the operator wants it
   * running. A hung-but-alive Munder is reported, never killed automatically.
   * A clean quit (our child exited 0 or on SIGTERM/SIGINT/SIGHUP; for an
   * adopted Munder, munder-control.json removed on quit) is someone closing
   * it: left down. Bounded: at most
   * `max_attempts` launches per `window_ms`, then a terminal `failed` state
   * that only an operator start/restart clears.
   */
  async tick() {
    const config = this.config();
    const wd = config.watchdog;
    if (!wd.enabled || this.busy) return { acted: false, why: this.busy ? 'busy' : 'disabled' };
    if (this.watchdog.state === 'failed') return { acted: false, why: 'failed' };
    const o = await observe(config, this.deps);
    if (o.state === 'healthy') {
      if (this.state.desired !== 'stopped') this.watchdog.state = 'armed';
      return { acted: false, why: 'healthy' };
    }
    if (this.watchdog.state !== 'armed' || this.state.desired !== 'running') return { acted: false, why: 'not_armed' };
    if (o.running) return { acted: false, why: `alive_but_${o.state}` };
    if (o.state !== 'down') return { acted: false, why: o.state };
    const launched = this.state.launched && this.children.get(this.state.launched.pid);
    // Ours: the exit says it. 0, or a polite signal (start.sh --stop, logout,
    // shutdown) is someone closing it; SIGKILL/SIGSEGV/a non-zero code is a
    // crash. Adopted: only the file says it (the app removes it on a clean quit).
    const cleanExit = launched && launched.exit
      ? launched.exit.code === 0 || POLITE_SIGNALS.has(launched.exit.signal)
      : o.health.channel === 'absent';
    if (cleanExit) {
      this.state.desired = 'stopped';
      this.watchdog.state = 'idle';
      const r = this.newReceipt('watchdog', 'watchdog', config);
      r.before = publicObs(o);
      this.finish(r, 'noop_stopped', 'Munder se cerró limpio (lo cerró alguien): lo dejo cerrado');
      return { acted: false, why: 'clean_exit' };
    }
    const now = this.deps.now();
    this.watchdog.attempts = this.watchdog.attempts.filter((t) => now - t < wd.window_ms);
    if (this.watchdog.attempts.length >= wd.max_attempts) {
      this.watchdog.state = 'failed';
      const r = this.newReceipt('watchdog', 'watchdog', config);
      r.before = publicObs(o);
      this.finish(r, 'failed', `se cayó ${wd.max_attempts} veces en ${Math.round(wd.window_ms / 60000)} min: me detengo (start o restart para reintentar)`);
      this.watchdog.last = { at: new Date().toISOString(), verdict: 'gave_up' };
      return { acted: false, why: 'gave_up' };
    }
    if (now < this.watchdog.next_at) return { acted: false, why: 'backoff' };
    this.watchdog.attempts.push(now);
    const n = this.watchdog.attempts.length;
    this.watchdog.next_at = now + wd.backoff_ms[Math.min(n - 1, wd.backoff_ms.length - 1)];
    const r = await this.exclusive('start', () => this.doStart('watchdog', 'watchdog_start'));
    this.watchdog.last = { at: r.completed_at, verdict: r.verdict, receipt_id: r.receipt_id };
    if (r.verdict === 'healthy') this.watchdog.state = 'armed';
    return { acted: true, verdict: r.verdict, receipt: r };
  }

  /** What autostart does at daemon boot: a normal start, attributed. */
  async autostart() {
    const config = this.config();
    if (!config.autostart || this.state.desired === 'stopped') return null;
    return this.exclusive('start', () => this.doStart('autostart', 'start'));
  }
}

function pruneRuns(dir, keep) {
  try {
    const runs = fs.readdirSync(dir).filter((f) => /^munder-.*\.log$/.test(f)).sort();
    for (const f of runs.slice(0, Math.max(0, runs.length - keep + 1))) fs.unlinkSync(path.join(dir, f));
  } catch { /* best effort */ }
}

function launchEnv(extra) {
  const env = { ...process.env, ...(extra || {}) };
  // The reviver may itself run as Electron-as-node (packaged installs): the
  // app it launches must be the app, not another node.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MUNDER_REVIVER_DIR;
  return env;
}

// ─── the wire ────────────────────────────────────────────────────────────────
function checkRequest({ identity, config, clients, seen, bootAt, now = Date.now() }, op, raw, sig) {
  let body;
  try { body = JSON.parse(raw); } catch { throw new ReviverError('bad_json', 'cuerpo inválido'); }
  if (!body || body.v !== 1) throw new ReviverError('bad_version', 'se espera v: 1');
  if (body.op !== op) throw new ReviverError('op_mismatch', 'la operación firmada no es la de la ruta', 401);
  if (body.reviver_id !== identity.reviver_id) throw new ReviverError('wrong_reviver', 'la petición es para otro reviver', 401);
  if (body.office_id !== config.office_id) throw new ReviverError('wrong_office', 'la petición es para otra oficina', 401);
  const client = typeof body.client === 'string' && Object.prototype.hasOwnProperty.call(clients, body.client) ? clients[body.client] : null;
  if (!client) throw new ReviverError('unknown_client', 'cliente no autorizado', 401);
  if (!verify(client.x, 'req', raw, sig)) throw new ReviverError('bad_signature', 'firma inválida', 401);
  if (typeof body.ts !== 'number' || Math.abs(now - body.ts) > SKEW_MS) throw new ReviverError('stale', 'la hora no coincide (más de 60 s)', 401);
  if (body.ts < bootAt - 1000) throw new ReviverError('stale', 'petición anterior a este arranque del reviver', 401);
  if (typeof body.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(body.nonce)) throw new ReviverError('bad_nonce', 'nonce inválido', 401);
  for (const [k, t] of seen) if (now - t > 2 * SKEW_MS) seen.delete(k);
  const key = `${body.client}:${body.nonce}`;
  if (seen.has(key)) throw new ReviverError('replay', 'petición repetida', 401);
  seen.set(key, now);
  return { body, client: { client_id: body.client, name: client.name } };
}

function createReviverServer({ reviver, log = () => {} } = {}) {
  const dir = reviver.dir;
  const identity = loadIdentity(dir);
  const seen = new Map();
  const bootAt = Date.now();

  const reply = (res, status, payload, nonce) => {
    const raw = JSON.stringify({ ...payload, reviver_id: identity.reviver_id, ts: Date.now(), re: nonce || null });
    res.writeHead(status, { 'content-type': 'application/json', 'x-reviver-sig': sign(identity, 'res', raw), 'cache-control': 'no-store' });
    res.end(raw);
  };

  return http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    if (req.method === 'GET' && url.pathname === '/reviver/v1/hello') {
      let office_id = null;
      try { office_id = reviver.config().office_id; } catch { /* unconfigured */ }
      return reply(res, 200, { ok: true, protocol: PROTOCOL, name: identity.name, x: identity.x, office_id });
    }
    const m = url.pathname.match(/^\/reviver\/v1\/([a-z]+)$/);
    if (req.method !== 'POST' || !m || !OPS.includes(m[1])) return reply(res, 404, { ok: false, error: 'not_found' });
    const op = m[1];
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) req.destroy(); else chunks.push(c); });
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let nonce = null;
      try { nonce = JSON.parse(raw).nonce; } catch { /* checked below */ }
      let who;
      try {
        const config = reviver.config();
        const clients = loadClients(dir);
        who = checkRequest({ identity, config, clients, seen, bootAt }, op, raw, req.headers['x-reviver-sig']).client;
      } catch (e) {
        log(`rechazada ${op} desde ${req.socket.remoteAddress}: ${e.code || e.message}`);
        return reply(res, e.status || 400, { ok: false, error: e.code || 'error', message: e.message }, typeof nonce === 'string' ? nonce : null);
      }
      try {
        const caller = `${who.name} (${who.client_id})`;
        let result;
        if (op === 'status') result = await reviver.status();
        else if (op === 'receipts') result = { receipts: readReceipts(dir, 10) };
        else result = await reviver[op](caller); // Reviver.finish() logs and keeps the receipt
        return reply(res, 200, { ok: true, op, result }, nonce);
      } catch (e) {
        return reply(res, e.status || 500, { ok: false, error: e.code || 'error', message: e.message }, nonce);
      }
    });
  });
}

// ─── the client (CLI, MCP adapter, another office) ──────────────────────────
async function call(cred, op, { address, timeoutMs } = {}) {
  if (!OPS.includes(op)) throw new ReviverError('bad_op', `operación desconocida: ${op} (solo ${OPS.join(', ')})`);
  const addr = address || cred.reviver.address;
  const body = {
    v: 1, op,
    reviver_id: cred.reviver.reviver_id, office_id: cred.reviver.office_id,
    client: cred.client_id, ts: Date.now(), nonce: b64u(crypto.randomBytes(18)),
  };
  const raw = JSON.stringify(body);
  const res = await fetch(`http://${addr}/reviver/v1/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-reviver-sig': sign(cred.key, 'req', raw) },
    body: raw,
    signal: AbortSignal.timeout(timeoutMs || (MUTATING.has(op) ? 180_000 : 15_000)),
  });
  const text = await res.text();
  if (!verify(cred.reviver.x, 'res', text, res.headers.get('x-reviver-sig'))) throw new ReviverError('bad_reply_signature', `la respuesta de ${addr} no viene del reviver esperado`, 502);
  const out = JSON.parse(text);
  if (out.reviver_id !== cred.reviver.reviver_id || out.re !== body.nonce) throw new ReviverError('bad_reply', 'la respuesta no corresponde a esta petición', 502);
  if (!out.ok) throw new ReviverError(out.error || 'error', out.message || out.error || 'error', res.status);
  return out.result;
}

module.exports = {
  PROTOCOL, DEFAULT_PORT, OPS, ReviverError,
  stateDir, files, readJson, writePrivate,
  loadIdentity, loadClients, authorizeClient, revokeClient, newClientCredential, localCredential, newKeyPair, idOf,
  loadConfig, saveConfig, validateConfig, DEFAULT_WATCHDOG,
  systemProcs, splitWindowsCmd, candidates, descendants, probeHealth, observe,
  readReceipts, Reviver, createReviverServer, checkRequest, call, sign, verify,
};
