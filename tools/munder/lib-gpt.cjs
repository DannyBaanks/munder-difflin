'use strict';
/**
 * Munder GPT: ChatGPT as a first-class Munder principal (`gpt`).
 *
 *   transport  tells ChatGPT WHERE Munder is      (a URL; grants nothing)
 *   OAuth      tells Munder WHO is calling         (a token the operator approved)
 *   the grant  tells Munder WHAT it may do         (scopes, capped by the profile)
 *
 * Authority path:
 *   Danny ─ munder gpt perfil ─▶ profile (read | operator | full)
 *         ─ munder gpt aprobar ─▶ grant for one ChatGPT client (scopes ∩ profile,
 *                                  expiry, revocable)
 *   ChatGPT ─ OAuth (DCR + PKCE S256 + operator approval) ─▶ short-lived token
 *           ─ MCP /mcp ─▶ only the tools the grant's scopes allow ─▶ this office
 *             (L.Office as principal `gpt`) or a Munder Link peer (Link's own
 *             ownership rules, unchanged).
 *
 * Full = everything this office's operator can legitimately delegate. It never
 * reaches into another office's board: over Link, GPT is this office acting as a
 * peer, and a peer sees only what it delegated. Another office gets its own
 * `munder gpt`.
 *
 * Builtins only (like lib-link, lib-remote, lib-reviver). Nothing secret is
 * stored in the clear: tokens and codes are kept as SHA-256 hashes, and nothing
 * secret is ever logged, audited or put in a URL.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const L = require('./lib-link.cjs');
const { openQuestion, overview } = require('./lib-remote.cjs');

const PRINCIPAL = 'gpt';
const PROTOCOL = 'munder-gpt@1';
const DEFAULT_PORT = Number(process.env.MUNDER_GPT_PORT) || 47834;
const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const ACCESS_TTL_S = 3600;
const CODE_TTL_MS = 5 * 60_000;
const REQUEST_TTL_MS = 10 * 60_000;
const MAX_CLIENTS = 20;
const MAX_PENDING = 5;
const MAX_BODY = 256 * 1024;
const MAX_TEXT = 20_000;

// ─── scopes and profiles ─────────────────────────────────────────────────────
const SCOPES = {
  'munder.read': 'ver la oficina: agentes, tareas, preguntas, bitácora, recibos, buzón de GPT, oficinas enlazadas',
  'munder.operate': 'trabajar como operador: escribirle a Michael, contestar preguntas, delegar por Link, mensajes y cancelaciones de lo delegado',
  'munder.admin': 'administrar: contratar y despedir agentes, arrancar packs, Reviver (start/restart/stop)',
};
const PROFILES = {
  lectura: ['munder.read'],
  operador: ['munder.read', 'munder.operate'],
  full: ['munder.read', 'munder.operate', 'munder.admin'],
};
const PROFILE_ALIASES = { read: 'lectura', 'read-only': 'lectura', lectura: 'lectura', operator: 'operador', operador: 'operador', full: 'full', maximo: 'full', máximo: 'full' };

class GptError extends Error {
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
  return process.env.MUNDER_GPT_DIR || path.join(base, 'gpt');
}

const files = (dir = stateDir()) => ({
  config: path.join(dir, 'config.json'),
  clients: path.join(dir, 'clients.json'),
  grants: path.join(dir, 'grants.json'),
  pending: path.join(dir, 'pending.json'),
  audit: path.join(dir, 'audit.jsonl'),
  reviver: path.join(dir, 'reviver-credential.json'),
  lock: path.join(dir, '.lock'),
  pid: path.join(dir, 'gateway.pid'),
  transportPid: path.join(dir, 'transport.pid'),
  log: path.join(dir, 'gateway.log'),
  transportLog: path.join(dir, 'transport.log'),
});

const readJson = (f, fallback) => L.readJson(f, fallback);

function writePrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* windows */ }
}

/** The CLI (revocar, aprobar) and the gateway both write grants: one writer at a time. */
function withLock(dir, fn) {
  const f = files(dir).lock;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 5000;
  for (;;) {
    try { fs.closeSync(fs.openSync(f, 'wx')); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(f).mtimeMs > 10_000) { fs.unlinkSync(f); continue; } } catch { /* raced */ }
      if (Date.now() > deadline) throw new GptError('busy', 'otro proceso tiene la configuración de GPT abierta', 503);
      const until = Date.now() + 20;
      while (Date.now() < until) { /* spin briefly: synchronous on purpose */ }
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(f); } catch { /* gone */ } }
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const token = (prefix, bytes = 32) => `${prefix}_${crypto.randomBytes(bytes).toString('base64url')}`;
const nowIso = () => new Date().toISOString();

// ─── config ──────────────────────────────────────────────────────────────────
function defaultConfig() {
  return {
    principal: PRINCIPAL, profile: 'full', enabled: false, port: DEFAULT_PORT,
    public_url: null, transport: { provider: 'local' }, grant_days: 30,
    created_at: nowIso(), updated_at: nowIso(),
  };
}

function loadConfig(dir = stateDir()) {
  const c = { ...defaultConfig(), ...readJson(files(dir).config, {}) };
  if (!PROFILES[c.profile]) c.profile = 'lectura'; // an unknown profile degrades to the least authority
  return c;
}

function saveConfig(dir, patch) {
  const next = { ...loadConfig(dir), ...patch, updated_at: nowIso() };
  writePrivate(files(dir).config, next);
  return next;
}

function profileName(p) {
  const n = PROFILE_ALIASES[String(p || '').toLowerCase()];
  if (!n) throw new GptError('bad_profile', `perfil desconocido: ${p} (lectura, operador o full)`);
  return n;
}

// ─── audit (never a token, never a secret) ───────────────────────────────────
const SECRETISH = /^(access_token|refresh_token|code|code_verifier|token|client_secret|authorization)$/i;

function scrub(v, depth = 0) {
  if (depth > 4) return '…';
  if (typeof v === 'string') return v.length > 300 ? `${v.slice(0, 300)}…` : v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => scrub(x, depth + 1));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRETISH.test(k) ? '[REDACTED]' : scrub(x, depth + 1);
    return out;
  }
  return v;
}

function audit(dir, entry) {
  const line = JSON.stringify({ ts: nowIso(), principal: PRINCIPAL, ...scrub(entry) });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(files(dir).audit, line + '\n', { mode: 0o600 });
}

function readAudit(dir, n = 20) {
  try { return fs.readFileSync(files(dir).audit, 'utf8').split('\n').filter(Boolean).slice(-n).map((l) => JSON.parse(l)); } catch { return []; }
}

// ─── grants ──────────────────────────────────────────────────────────────────
const loadGrants = (dir) => readJson(files(dir).grants, { grants: {} }).grants || {};
const saveGrants = (dir, grants) => writePrivate(files(dir).grants, { grants });

/** What a grant may do right now: its own scopes, capped by the CURRENT profile. */
function effectiveScopes(grant, config) {
  const cap = new Set(PROFILES[config.profile] || []);
  return (grant.scopes || []).filter((s) => cap.has(s));
}

function publicGrant(id, g) {
  return {
    grant_id: id, client_name: g.client_name, client_id: g.client_id, scopes: g.scopes,
    created_at: g.created_at, expires_at: g.expires_at, revoked_at: g.revoked_at || null,
    last_used_at: g.last_used_at || null, active: !g.revoked_at && Date.parse(g.expires_at) > Date.now(),
  };
}

function revoke(dir, which, why = 'operator') {
  return withLock(dir, () => {
    const grants = loadGrants(dir);
    const hits = [];
    for (const [id, g] of Object.entries(grants)) {
      if (g.revoked_at) continue;
      if (which === 'todo' || which === 'all' || id === which || id.startsWith(which) || g.client_name === which) {
        g.revoked_at = nowIso();
        g.access = [];
        g.refresh = null;
        hits.push(id);
      }
    }
    saveGrants(dir, grants);
    for (const id of hits) audit(dir, { event: 'grant_revoked', grant_id: id, by: why });
    return hits;
  });
}

/** Resolve a bearer token to its live grant, or throw 401. Revocation takes effect on the next request. */
function authenticate(dir, bearer) {
  if (typeof bearer !== 'string' || !bearer.startsWith('mga_')) throw new GptError('invalid_token', 'falta un token válido', 401);
  const h = sha(bearer);
  const config = loadConfig(dir);
  if (!config.enabled) throw new GptError('invalid_token', 'el gateway de GPT está apagado (munder gpt encender)', 401);
  const grants = loadGrants(dir);
  for (const [id, g] of Object.entries(grants)) {
    const a = (g.access || []).find((x) => x.hash === h);
    if (!a) continue;
    if (g.revoked_at) throw new GptError('invalid_token', 'el permiso fue revocado', 401);
    if (Date.parse(g.expires_at) <= Date.now()) throw new GptError('invalid_token', 'el permiso caducó', 401);
    if (a.exp * 1000 <= Date.now()) throw new GptError('invalid_token', 'el token caducó', 401);
    return { grant_id: id, grant: g, scopes: effectiveScopes(g, config), config };
  }
  throw new GptError('invalid_token', 'token desconocido', 401);
}

// ─── the office, as principal `gpt` ──────────────────────────────────────────
function hiveRoot() {
  return L.localHiveRoot();
}

function office() {
  return new L.Office(hiveRoot(), PRINCIPAL);
}

const gptInbox = (root = hiveRoot()) => path.join(root, 'gpt', 'inbox');

/** Turning GPT on creates its mailbox; the hive router delivers `"to": "gpt"` only while it exists. */
function ensureInbox(root = hiveRoot()) {
  if (!root) return null;
  const dir = gptInbox(root);
  fs.mkdirSync(path.join(dir, '.done'), { recursive: true });
  return dir;
}

function receipt(kind, correlationId, ctx) {
  return { id: crypto.randomUUID(), timestamp: nowIso(), kind, correlation_id: correlationId || null, principal: PRINCIPAL, grant_id: ctx.grant_id };
}

/** A message from principal gpt into Michael's inbox: same shape as Office.message, plus threading. */
function toMichael(ctx, { subject, body, act = 'request', in_reply_to = null, conversation = null }) {
  const o = office();
  const now = nowIso();
  const msg = {
    id: `${now.replace(/[:.]/g, '-').slice(0, 19)}Z-${crypto.randomUUID().slice(0, 8)}`,
    conversation: conversation || `gpt-${crypto.randomUUID().slice(0, 8)}`,
    in_reply_to, from: PRINCIPAL, to: 'god', act, subject, body, hops: 0,
    requires_reply: act === 'request', needs_human: false, created_at: now,
  };
  o.writeJson(o.p('agents', 'god', 'inbox', `${msg.id}.json`), msg);
  o.log({ event: 'gpt_message', principal: PRINCIPAL, grant_id: ctx.grant_id, message_id: msg.id, conversation: msg.conversation, in_reply_to });
  return msg;
}

function text(v, what, max = MAX_TEXT) {
  if (typeof v !== 'string' || !v.trim()) throw new GptError('bad_args', `falta ${what}`);
  if (v.length > max) throw new GptError('bad_args', `${what} es demasiado largo`);
  return v.trim();
}

const MSG_ID = /^[A-Za-z0-9._:-]{6,120}$/;

function inboxMessages(includeDone) {
  const dir = gptInbox();
  const read = (d, done) => {
    try {
      return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => {
        const m = readJson(path.join(d, f), null);
        return m && { id: m.id || f.replace(/\.json$/, ''), from: m.from, act: m.act, subject: m.subject, created_at: m.created_at, conversation: m.conversation, in_reply_to: m.in_reply_to || null, read: done };
      }).filter(Boolean);
    } catch { return []; }
  };
  const all = [...read(dir, false), ...(includeDone ? read(path.join(dir, '.done'), true) : [])];
  return all.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

function inboxFile(id) {
  if (typeof id !== 'string' || !MSG_ID.test(id)) throw new GptError('bad_args', 'message_id inválido');
  for (const sub of ['', '.done']) {
    const f = path.join(gptInbox(), sub, `${id}.json`);
    if (fs.existsSync(f)) return { file: f, done: sub === '.done' };
  }
  throw new GptError('not_found', 'no hay ese mensaje en el buzón de GPT', 404);
}

// ─── Link (same verification as munder-chatgpt-link: signed status + network gate) ─
const GATE = path.join(__dirname, '..', '..', 'src', 'mcp', 'munder-chatgpt-link', 'network-gate.mjs');
let gatePromise = null;
function gate(address) {
  if (!gatePromise) {
    gatePromise = import(require('node:url').pathToFileURL(GATE).href).then((m) => m.gateReachability).catch(() => (addr) => {
      const host = String(addr).replace(/:\d+$/, '');
      return /^127\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
        ? { ok: true, class: 'loopback_or_tailscale' }
        : { ok: false, class: 'unknown', reason: `network gate no disponible (${GATE})` };
    });
  }
  return gatePromise.then((fn) => fn(address));
}

async function verifiedCall(officeQuery, op, args) {
  const probe = await L.call(String(officeQuery || ''), 'status', {}, { timeoutMs: 5000 });
  const reach = await gate(probe.address);
  if (!reach.ok) throw new GptError('network_gate_failed', `oficina autenticada, pero la ruta ${probe.address} no pasa el gate (${reach.reason || reach.class})`, 403);
  const verification = { verified: true, office_id: probe.peer.office_id, name: probe.peer.name, address: probe.address, network: reach.class };
  if (op === 'status') return { verification, result: probe.result };
  const r = await L.call(String(officeQuery), op, args, {});
  return { verification, result: r.result };
}

// ─── the live app's control channel (hire/fire/packs) ────────────────────────
function userDataDir() {
  if (process.env.MUNDER_USER_DATA) return process.env.MUNDER_USER_DATA;
  const base = process.platform === 'win32' ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  return path.join(base, 'munder-difflin');
}

async function control(method, p, body) {
  const cfg = readJson(path.join(userDataDir(), 'munder-control.json'), null);
  if (!cfg || typeof cfg.port !== 'number') throw new GptError('app_down', 'Munder no está abierto en esta computadora (sin canal de control)', 503);
  const res = await fetch(`http://127.0.0.1:${cfg.port}${p}`, {
    method, headers: { authorization: `Bearer ${cfg.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out.ok === false) throw new GptError('app_error', out.error || `la app respondió ${res.status}`, res.status >= 500 ? 502 : 400);
  return out;
}

/** Agents GPT may hire: a known provider CLI, never a command string from the caller. */
const HIRE_PROVIDERS = { claude: 'claude', codex: 'codex', opencode: 'opencode', openisy: 'openisy', gemini: 'gemini', qwen: 'qwen', crush: 'crush', pi: 'pi', grok: 'grok', kimi: 'kimi', copilot: 'copilot', cursor: 'cursor-agent' };

function hireCommand(provider) {
  const p = String(provider || 'claude').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(HIRE_PROVIDERS, p)) throw new GptError('bad_args', `proveedor no permitido: ${provider} (${Object.keys(HIRE_PROVIDERS).join(', ')})`);
  return { provider: p, command: HIRE_PROVIDERS[p] };
}

function existingDir(v) {
  const d = text(v, 'la carpeta de trabajo (cwd)', 1000);
  if (!path.isAbsolute(d)) throw new GptError('bad_args', 'cwd debe ser una ruta absoluta');
  let st;
  try { st = fs.statSync(d); } catch { throw new GptError('bad_args', `no existe la carpeta ${d}`); }
  if (!st.isDirectory()) throw new GptError('bad_args', `${d} no es una carpeta`);
  return d;
}

// ─── Reviver (its own principal: a reviver client credential named gpt) ──────
function reviverCall(dir, op) {
  const cred = readJson(files(dir).reviver, null);
  if (!cred) throw new GptError('no_reviver', 'el Reviver no está enlazado a GPT (munder gpt reviver, tras munder reviver init)', 503);
  return require('./lib-reviver.cjs').call(cred, op);
}

// ─── the capability catalogue ────────────────────────────────────────────────
const S = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', minimum: 1, maximum: 200, description });

const CAPABILITIES = [
  // ── munder.read ──
  { name: 'office_overview', scope: 'munder.read', title: 'Oficina: estado, agentes, tareas y preguntas abiertas',
    input: S({}), run: () => overview(safeOffice(), L.loadIdentity(), 'gpt') },
  { name: 'task_get', scope: 'munder.read', title: 'Una tarea de esta oficina, completa (con su historial de preguntas)',
    input: S({ task_id: str('id de la tarea') }, ['task_id']),
    run: (_c, a) => {
      const t = office().tasks().find((x) => x && x.id === a.task_id);
      if (!t) throw new GptError('not_found', 'no existe esa tarea en esta oficina', 404);
      return { task: t };
    } },
  { name: 'activity_log', scope: 'munder.read', title: 'Bitácora del hive (lo último que pasó en la oficina)',
    input: S({ limit: int('cuántas entradas (máx. 200)') }),
    run: (_c, a) => {
      const lines = (() => { try { return fs.readFileSync(office().p('log.jsonl'), 'utf8').split('\n').filter(Boolean); } catch { return []; } })();
      return { entries: lines.slice(-(a.limit || 50)).map((l) => { try { return JSON.parse(l); } catch { return { raw: l.slice(0, 300) }; } }) };
    } },
  { name: 'gpt_inbox', scope: 'munder.read', title: 'Buzón de GPT: lo que Michael u otro agente te mandó ("to": "gpt")',
    input: S({ include_read: { type: 'boolean', description: 'incluir los ya marcados como leídos' } }),
    run: (_c, a) => ({ inbox: gptInbox(), messages: inboxMessages(!!a.include_read) }) },
  { name: 'gpt_inbox_read', scope: 'munder.read', title: 'Leer un mensaje del buzón de GPT',
    input: S({ message_id: str('id del mensaje') }, ['message_id']),
    run: (_c, a) => { const { file, done } = inboxFile(a.message_id); return { message: readJson(file, null), read: done }; } },
  { name: 'link_offices', scope: 'munder.read', title: 'Oficinas: esta y las enlazadas por Munder Link',
    input: S({}),
    run: () => {
      const id = L.loadIdentity();
      return {
        self: { office_id: id.office_id, name: id.name, fingerprint: L.prettyFingerprint(id.office_id) },
        peers: Object.values(L.loadPeers()).map((p) => ({ office_id: p.office_id, name: p.name, fingerprint: L.prettyFingerprint(p.office_id), addresses: p.addresses || [] })),
      };
    } },
  { name: 'link_office_status', scope: 'munder.read', title: 'Estado verificado de una oficina enlazada (firma + cifrado + gate de red)',
    input: S({ office: str('nombre o id de la oficina enlazada') }, ['office']),
    run: (_c, a) => verifiedCall(a.office, 'status', {}) },
  { name: 'link_task_get', scope: 'munder.read', title: 'Una tarea que ESTA oficina delegó a otra (regla de Link: solo las propias)',
    input: S({ office: str('oficina'), task_id: str('id de la tarea remota') }, ['office', 'task_id']),
    run: (_c, a) => verifiedCall(a.office, 'get', { task_id: a.task_id }) },
  { name: 'session_agents', scope: 'munder.read', title: 'Agentes vivos en la app (terminales abiertas)',
    input: S({}), run: () => control('GET', '/sesion') },
  { name: 'packs_list', scope: 'munder.read', title: 'Office Packs disponibles para arrancar un equipo',
    input: S({}), run: () => control('GET', '/packs') },
  { name: 'gpt_audit', scope: 'munder.read', title: 'Tu propia auditoría: lo que GPT hizo y recibió',
    input: S({ limit: int('cuántas entradas (máx. 200)') }),
    run: (c, a) => ({ entries: readAudit(c.dir, a.limit || 30) }) },
  { name: 'reviver_status', scope: 'munder.read', title: 'Reviver: ¿Munder vivo y sano en esta máquina?',
    input: S({}), run: (c) => reviverCall(c.dir, 'status') },

  // ── munder.operate ──
  { name: 'michael_message', scope: 'munder.operate', mutating: true, title: 'Escribirle a Michael (llega a su buzón como principal gpt)',
    input: S({ text: str('el mensaje'), subject: str('asunto corto (opcional)') }, ['text']),
    run: (c, a) => {
      const body = text(a.text, 'el mensaje');
      const subject = typeof a.subject === 'string' && a.subject.trim() ? a.subject.trim().slice(0, 120) : `Mensaje de ChatGPT: ${body.split('\n')[0].slice(0, 60)}`;
      const m = toMichael(c, { subject, body: `${body}\n\n_(De ChatGPT, principal gpt. Para contestarle: un mensaje con "to": "gpt".)_` });
      return { message_id: m.id, conversation: m.conversation, receipt: receipt('gpt_message_sent', m.id, c) };
    } },
  { name: 'gpt_inbox_reply', scope: 'munder.operate', mutating: true, title: 'Contestar un mensaje del buzón de GPT (mismo hilo)',
    input: S({ message_id: str('id del mensaje que contestas'), text: str('tu respuesta') }, ['message_id', 'text']),
    run: (c, a) => {
      const { file } = inboxFile(a.message_id);
      const orig = readJson(file, {});
      const body = text(a.text, 'la respuesta');
      const m = toMichael(c, { subject: `Re: ${String(orig.subject || '').slice(0, 100)}`, body, act: 'inform', in_reply_to: orig.id || a.message_id, conversation: orig.conversation || null });
      return { message_id: m.id, in_reply_to: m.in_reply_to, conversation: m.conversation, receipt: receipt('gpt_reply_sent', m.id, c) };
    } },
  { name: 'gpt_inbox_mark_read', scope: 'munder.operate', mutating: true, title: 'Marcar como leído un mensaje del buzón de GPT',
    input: S({ message_id: str('id del mensaje') }, ['message_id']),
    run: (c, a) => {
      const { file, done } = inboxFile(a.message_id);
      if (!done) fs.renameSync(file, path.join(gptInbox(), '.done', path.basename(file)));
      return { message_id: a.message_id, read: true, receipt: receipt('gpt_inbox_read', a.message_id, c) };
    } },
  { name: 'question_answer', scope: 'munder.operate', mutating: true, title: 'Contestar la pregunta abierta de una tarea bloqueada (como el tablero ASK ME)',
    input: S({ task_id: str('id de la tarea'), q: str('la pregunta tal como aparece (se verifica que no cambió)'), text: str('la respuesta') }, ['task_id', 'q', 'text']),
    run: (c, a) => {
      const o = office();
      const reply = text(a.text, 'la respuesta');
      const file = o.p('tasks.json');
      const doc = readJson(file, { tasks: [] });
      const tasks = Array.isArray(doc.tasks) ? doc.tasks : [];
      const t = tasks.find((x) => x && x.id === a.task_id);
      if (!t) throw new GptError('not_found', 'esa tarea ya no existe', 404);
      const open = openQuestion(t);
      if (!open || open.q !== a.q) throw new GptError('question_changed', 'esa pregunta cambió o ya tiene respuesta; vuelve a leer la tarea', 409);
      open.a = reply;
      open.answeredAt = nowIso();
      open.answeredBy = PRINCIPAL;
      o.writeJson(file, { ...doc, tasks });
      const m = toMichael(c, { subject: `GPT ANSWER on task "${t.title}"`, act: 'inform', body: [
        `ChatGPT (principal gpt, granted by the operator) answered the open question on task ${t.id} ("${t.title}"):`,
        `Q: ${open.q}`, `A: ${reply}`,
        'The answer is also recorded in the card\'s humanQA. Act on it, unblock the card, and continue the work.',
      ].join('\n') });
      return { task_id: t.id, message_id: m.id, receipt: receipt('gpt_question_answered', t.id, c) };
    } },
  { name: 'link_delegate', scope: 'munder.operate', mutating: true, title: 'Delegar trabajo a una oficina enlazada (Munder Link)',
    input: S({ office: str('oficina destino'), text: str('qué hay que hacer'), title: str('título corto (opcional)') }, ['office', 'text']),
    run: async (c, a) => {
      const compose = text(a.text, 'la tarea');
      await verifiedCall(a.office, 'status', {});
      const r = await L.delegate(String(a.office), compose, { title: typeof a.title === 'string' ? a.title.slice(0, 120) : undefined });
      try { office().log({ event: 'gpt_link_delegated', principal: PRINCIPAL, grant_id: c.grant_id, origin_ref: r.origin_ref, to_office: r.peer.office_id, remote_task_id: r.result.task_id }); } catch { /* no local hive */ }
      return { office: r.peer.name, task_id: r.result.task_id, origin_ref: r.origin_ref, duplicate: !!r.result.duplicate, receipt: r.result.receipt || receipt('gpt_link_delegated', r.result.task_id, c) };
    } },
  { name: 'link_task_message', scope: 'munder.operate', mutating: true, title: 'Agregar contexto a una tarea que esta oficina delegó',
    input: S({ office: str('oficina'), task_id: str('id de la tarea remota'), message: str('el contexto') }, ['office', 'task_id', 'message']),
    run: (_c, a) => verifiedCall(a.office, 'message', { task_id: a.task_id, message: text(a.message, 'el mensaje') }) },
  { name: 'link_task_cancel', scope: 'munder.operate', mutating: true, title: 'Pedir que cancelen una tarea que esta oficina delegó',
    input: S({ office: str('oficina'), task_id: str('id de la tarea remota'), reason: str('motivo') }, ['office', 'task_id']),
    run: (_c, a) => verifiedCall(a.office, 'cancel', { task_id: a.task_id, reason: typeof a.reason === 'string' ? a.reason.slice(0, 500) : '' }) },

  // ── munder.admin ──
  { name: 'agent_hire', scope: 'munder.admin', mutating: true, title: 'Contratar un agente (terminal nueva en la app) con un CLI conocido',
    input: S({ name: str('nombre del agente'), provider: { type: 'string', enum: Object.keys(HIRE_PROVIDERS), description: 'CLI del agente' }, cwd: str('carpeta de trabajo (ruta absoluta existente)'), role: str('rol (opcional)') }, ['name', 'cwd']),
    run: async (c, a) => {
      const { provider, command } = hireCommand(a.provider);
      const out = await control('POST', '/sesion/agentes', { name: text(a.name, 'el nombre', 60), cwd: existingDir(a.cwd), command, provider, role: typeof a.role === 'string' ? a.role.slice(0, 120) : undefined });
      try { office().log({ event: 'gpt_agent_hired', principal: PRINCIPAL, grant_id: c.grant_id, agent: out.id || a.name, provider }); } catch { /* no hive */ }
      return { ...out, receipt: receipt('gpt_agent_hired', out.id || a.name, c) };
    } },
  { name: 'agent_fire', scope: 'munder.admin', mutating: true, title: 'Despedir (cerrar) un agente vivo',
    input: S({ agent_id: str('id del agente (de session_agents)') }, ['agent_id']),
    run: async (c, a) => {
      const id = text(a.agent_id, 'el id', 120);
      if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new GptError('bad_args', 'id de agente inválido');
      const out = await control('DELETE', `/sesion/agentes/${encodeURIComponent(id)}`);
      try { office().log({ event: 'gpt_agent_fired', principal: PRINCIPAL, grant_id: c.grant_id, agent: id }); } catch { /* no hive */ }
      return { ...out, receipt: receipt('gpt_agent_fired', id, c) };
    } },
  { name: 'pack_start', scope: 'munder.admin', mutating: true, title: 'Arrancar un Office Pack (varios agentes de un giro)',
    input: S({ pack: str('id del pack (de packs_list)'), cwd: str('carpeta de trabajo'), provider: { type: 'string', enum: Object.keys(HIRE_PROVIDERS) }, picks: { type: 'array', items: { type: 'string' }, description: 'ids de agentes del pack (opcional)' } }, ['pack', 'cwd']),
    run: async (c, a) => {
      const { provider, command } = hireCommand(a.provider);
      const out = await control('POST', '/sesion/pack', { pack: text(a.pack, 'el pack', 80), cwd: existingDir(a.cwd), command, provider, picks: Array.isArray(a.picks) ? a.picks.slice(0, 20).map(String) : undefined });
      try { office().log({ event: 'gpt_pack_started', principal: PRINCIPAL, grant_id: c.grant_id, pack: a.pack }); } catch { /* no hive */ }
      return { ...out, receipt: receipt('gpt_pack_started', a.pack, c) };
    } },
  { name: 'reviver_start', scope: 'munder.admin', mutating: true, title: 'Reviver: arrancar Munder si no está sano',
    input: S({}), run: (c) => reviverCall(c.dir, 'start') },
  { name: 'reviver_restart', scope: 'munder.admin', mutating: true, title: 'Reviver: reiniciar Munder (solo el proceso verificado)',
    input: S({}), run: (c) => reviverCall(c.dir, 'restart') },
  { name: 'reviver_stop', scope: 'munder.admin', mutating: true, title: 'Reviver: parar Munder a propósito',
    input: S({}), run: (c) => reviverCall(c.dir, 'stop') },
];

/**
 * Every operation of the underlying surfaces, classified. The tests read the
 * real sources (lib-remote's dispatch, lib-link's call switch, the control
 * channel's routes, the Reviver's ops) and fail when one appears here as
 * neither exposed nor excluded: a new Munder operation can't be silently left
 * out of Full, and can't slip in without a scope either.
 */
const INVENTORY = {
  remote: {
    hello: { exposed: 'link_offices', why: 'identidad propia (ya en link_offices)' },
    overview: { exposed: 'office_overview' },
    peers: { exposed: 'link_offices' },
    answer: { exposed: 'question_answer' },
    ask: { exposed: 'michael_message' },
    delegate: { exposed: 'link_delegate' },
  },
  link: {
    status: { exposed: 'link_office_status' },
    submit: { exposed: 'link_delegate', why: 'lado que recibe; GPT delega con L.delegate' },
    get: { exposed: 'link_task_get' },
    message: { exposed: 'link_task_message' },
    cancel: { exposed: 'link_task_cancel' },
    reply: { excluded: 'lo manda la oficina que recibió el trabajo (Michael), no quien lo delegó' },
  },
  control: {
    'GET /salud': { excluded: 'salud interna del canal; el estado de la app va por reviver_status' },
    'GET /sesion': { exposed: 'session_agents' },
    'GET /packs': { exposed: 'packs_list' },
    'POST /sesion/pack': { exposed: 'pack_start' },
    'POST /sesion/agentes': { exposed: 'agent_hire', why: 'solo con un CLI conocido; nunca un comando libre' },
    'DELETE /sesion/agentes/': { exposed: 'agent_fire' },
    'POST /repaint': { excluded: 'arreglo visual local de la ventana; sin valor remoto' },
  },
  reviver: {
    status: { exposed: 'reviver_status' },
    receipts: { excluded: 'los recibos del Reviver se ven en la computadora; los de GPT en gpt_audit' },
    start: { exposed: 'reviver_start' },
    restart: { exposed: 'reviver_restart' },
    stop: { exposed: 'reviver_stop' },
  },
  // Trust-root operations: never delegated, whatever the profile.
  never: {
    'link pair/accept/forget': 'cambia en quién confía la oficina: solo el operador, con el código de 6 dígitos',
    'remote pair/forget': 'emparejar celulares: solo el operador',
    'munder gpt perfil/aprobar/revocar': 'GPT no puede darse ni quitarse permisos',
    'reviver init/clientes': 'configurar el Reviver: solo el operador',
    'comando libre al contratar': 'sería una shell remota; se contrata solo con CLIs conocidos',
  },
};

function safeOffice() {
  try { return office(); } catch { return null; }
}

function capabilitiesFor(scopes) {
  const set = new Set(scopes);
  return CAPABILITIES.filter((c) => set.has(c.scope));
}

function describeProfile(profile) {
  const scopes = PROFILES[profileName(profile)];
  return {
    profile: profileName(profile), scopes: scopes.map((s) => ({ scope: s, what: SCOPES[s] })),
    tools: capabilitiesFor(scopes).map((c) => ({ name: c.name, scope: c.scope, mutating: !!c.mutating, title: c.title })),
    never: INVENTORY.never,
  };
}

// ─── MCP (Streamable HTTP, JSON responses) ───────────────────────────────────
async function mcp(dir, auth, msg) {
  const { id, method, params } = msg || {};
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return fail(-32600, 'invalid request');
  if (method === 'initialize') {
    const asked = params && params.protocolVersion;
    return ok({
      protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'munder-gpt', version: '1' },
      instructions: `Eres el principal "gpt" de la oficina Munder de Danny, con scopes: ${auth.scopes.join(', ')}. Para saber si Michael te contestó, usa gpt_inbox. Cada acción queda auditada a tu nombre.`,
    });
  }
  if (method === 'ping') return ok({});
  if (method.startsWith('notifications/')) return null;
  if (method === 'tools/list') {
    return ok({ tools: capabilitiesFor(auth.scopes).map((c) => ({
      name: c.name, title: c.title, description: `${c.title}. Scope: ${c.scope}.`, inputSchema: c.input,
      annotations: { readOnlyHint: !c.mutating, destructiveHint: /fire|stop|cancel/.test(c.name), openWorldHint: c.name.startsWith('link_') },
    })) });
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const cap = CAPABILITIES.find((c) => c.name === name);
    const args = (params && params.arguments) || {};
    if (!cap) return fail(-32602, `herramienta desconocida: ${name}`);
    if (!auth.scopes.includes(cap.scope)) {
      audit(dir, { event: 'tool_denied', grant_id: auth.grant_id, tool: name, scope: cap.scope, reason: 'insufficient_scope' });
      return ok({ content: [{ type: 'text', text: `Sin permiso: ${name} requiere ${cap.scope}, y este permiso tiene ${auth.scopes.join(', ') || 'nada'}.` }], isError: true });
    }
    const allowed = Object.keys(cap.input.properties || {});
    const extra = Object.keys(args).filter((k) => !allowed.includes(k));
    if (extra.length) return fail(-32602, `argumentos no esperados: ${extra.join(', ')}`);
    try {
      const result = await cap.run({ dir, grant_id: auth.grant_id, scopes: auth.scopes }, args);
      audit(dir, { event: 'tool_call', grant_id: auth.grant_id, tool: name, scope: cap.scope, mutating: !!cap.mutating, args, ok: true, receipt_id: result && result.receipt && result.receipt.id || null });
      return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false });
    } catch (e) {
      audit(dir, { event: 'tool_call', grant_id: auth.grant_id, tool: name, scope: cap.scope, mutating: !!cap.mutating, args, ok: false, error: e.code || e.message });
      return ok({ content: [{ type: 'text', text: `${e.code || 'error'}: ${e.message}` }], isError: true });
    }
  }
  return fail(-32601, `método desconocido: ${method}`);
}

// ─── OAuth 2.1 (the subset MCP clients use) ──────────────────────────────────
function baseUrl(dir) {
  const c = loadConfig(dir);
  return String(c.public_url || `http://127.0.0.1:${c.port}`).replace(/\/+$/, '');
}

function asMetadata(dir) {
  const base = baseUrl(dir);
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    revocation_endpoint: `${base}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: Object.keys(SCOPES),
    service_documentation: 'https://github.com/DannyBaanks/munder-difflin/blob/main/tools/munder/GPT.md',
  };
}

function prMetadata(dir) {
  const base = baseUrl(dir);
  return { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: Object.keys(SCOPES), bearer_methods_supported: ['header'], resource_name: 'Munder (principal gpt)' };
}

function validRedirect(u) {
  let url;
  try { url = new URL(u); } catch { return false; }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
}

function register(dir, body) {
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === 'string') : [];
  if (!uris.length || uris.length > 5 || !uris.every(validRedirect)) throw new GptError('invalid_redirect_uri', 'redirect_uris: https (o localhost) y sin fragmento');
  const method = body.token_endpoint_auth_method || 'none';
  if (method !== 'none') throw new GptError('invalid_client_metadata', 'solo clientes públicos (token_endpoint_auth_method: none, con PKCE)');
  return withLock(dir, () => {
    const clients = readJson(files(dir).clients, {});
    const ids = Object.keys(clients);
    if (ids.length >= MAX_CLIENTS) {
      // drop the oldest client that has no live grant
      const grants = loadGrants(dir);
      const idle = ids.filter((id) => !Object.values(grants).some((g) => g.client_id === id && !g.revoked_at)).sort((a, b) => String(clients[a].created_at).localeCompare(String(clients[b].created_at)));
      if (!idle.length) throw new GptError('too_many_clients', 'demasiados clientes registrados; revoca alguno con munder gpt revocar', 429);
      delete clients[idle[0]];
    }
    const client_id = `mgc_${crypto.randomBytes(12).toString('base64url')}`;
    const name = typeof body.client_name === 'string' ? body.client_name.slice(0, 80) : 'cliente MCP';
    clients[client_id] = { client_name: name, redirect_uris: uris, created_at: nowIso() };
    writePrivate(files(dir).clients, clients);
    audit(dir, { event: 'client_registered', client_id, client_name: name, redirect_hosts: uris.map((u) => new URL(u).host) });
    return { client_id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
  });
}

function parseScope(scope, config) {
  const cap = PROFILES[config.profile] || [];
  const asked = typeof scope === 'string' && scope.trim() ? scope.trim().split(/\s+/) : cap;
  const unknown = asked.filter((s) => !SCOPES[s]);
  if (unknown.length) throw new GptError('invalid_scope', `scopes desconocidos: ${unknown.join(', ')}`);
  return asked.filter((s) => cap.includes(s));
}

/** GET /authorize: validate, park the request, and show the operator a code to approve in the terminal. */
function authorizeRequest(dir, q, ip) {
  const config = loadConfig(dir);
  if (!config.enabled) throw new GptError('temporarily_unavailable', 'el gateway de GPT está apagado', 503);
  const clients = readJson(files(dir).clients, {});
  const client = Object.prototype.hasOwnProperty.call(clients, q.client_id) ? clients[q.client_id] : null;
  if (!client) throw new GptError('invalid_client', 'cliente no registrado', 400);
  const redirect = q.redirect_uri || (client.redirect_uris.length === 1 ? client.redirect_uris[0] : null);
  if (!redirect || !client.redirect_uris.includes(redirect)) throw new GptError('invalid_request', 'redirect_uri no registrado', 400);
  // From here on, errors go back to the client's redirect (RFC 6749 §4.1.2.1).
  const back = (error, description) => ({ redirect: withQuery(redirect, { error, error_description: description, state: q.state }) });
  if (q.response_type !== 'code') return back('unsupported_response_type', 'solo code');
  if (q.code_challenge_method !== 'S256' || typeof q.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) return back('invalid_request', 'PKCE S256 obligatorio');
  if (q.resource && q.resource.replace(/\/+$/, '') !== `${baseUrl(dir)}/mcp` && q.resource.replace(/\/+$/, '') !== baseUrl(dir)) return back('invalid_target', 'ese recurso no es este gateway');
  let scopes;
  try { scopes = parseScope(q.scope, config); } catch (e) { return back('invalid_scope', e.message); }
  if (!scopes.length) return back('invalid_scope', `el perfil actual (${config.profile}) no permite lo que se pidió`);
  return withLock(dir, () => {
    const pending = readJson(files(dir).pending, { requests: {}, codes: {} });
    const now = Date.now();
    for (const [k, r] of Object.entries(pending.requests)) if (r.expires_at < now) delete pending.requests[k];
    if (Object.keys(pending.requests).length >= MAX_PENDING) throw new GptError('slow_down', 'demasiadas solicitudes pendientes; espera unos minutos', 429);
    const request_id = crypto.randomBytes(18).toString('base64url');
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    pending.requests[request_id] = {
      approval_code: code, client_id: q.client_id, client_name: client.client_name, redirect_uri: redirect, state: q.state || null,
      code_challenge: q.code_challenge, scopes, from_ip: ip, created_at: now, expires_at: now + REQUEST_TTL_MS, status: 'pending',
    };
    writePrivate(files(dir).pending, pending);
    audit(dir, { event: 'authorization_requested', client_id: q.client_id, client_name: client.client_name, scopes, from_ip: ip });
    return { request_id, approval_code: code, client_name: client.client_name, scopes, profile: config.profile };
  });
}

/** The operator, on the computer: approve (or deny) a pending request by its code. */
function approve(dir, approvalCode, decision = 'approve') {
  const code = String(approvalCode || '').replace(/\D/g, '');
  return withLock(dir, () => {
    const pending = readJson(files(dir).pending, { requests: {}, codes: {} });
    const hit = Object.entries(pending.requests).find(([, r]) => r.approval_code === code && r.status === 'pending' && r.expires_at > Date.now());
    if (!hit) throw new GptError('not_found', `no hay una solicitud pendiente con el código ${code}`, 404);
    const [rid, r] = hit;
    if (decision !== 'approve') {
      r.status = 'denied';
      writePrivate(files(dir).pending, pending);
      audit(dir, { event: 'authorization_denied', client_id: r.client_id, client_name: r.client_name });
      return { denied: true, client_name: r.client_name };
    }
    const config = loadConfig(dir);
    const grant_id = `g_${crypto.randomBytes(6).toString('hex')}`;
    const grants = loadGrants(dir);
    grants[grant_id] = {
      client_id: r.client_id, client_name: r.client_name, scopes: r.scopes, profile_at_grant: config.profile,
      created_at: nowIso(), expires_at: new Date(Date.now() + config.grant_days * 86_400_000).toISOString(),
      approved_by: 'operator', access: [], refresh: null,
    };
    saveGrants(dir, grants);
    const authCode = token('mgx', 24);
    pending.codes[sha(authCode)] = { grant_id, client_id: r.client_id, redirect_uri: r.redirect_uri, code_challenge: r.code_challenge, expires_at: Date.now() + CODE_TTL_MS };
    r.status = 'approved';
    r.redirect = withQuery(r.redirect_uri, { code: authCode, state: r.state });
    writePrivate(files(dir).pending, pending);
    audit(dir, { event: 'authorization_approved', grant_id, client_id: r.client_id, client_name: r.client_name, scopes: r.scopes, request: rid.slice(0, 6) });
    return { grant_id, client_name: r.client_name, scopes: r.scopes, expires_at: grants[grant_id].expires_at };
  });
}

function pendingRequests(dir) {
  const p = readJson(files(dir).pending, { requests: {} });
  return Object.values(p.requests || {}).filter((r) => r.status === 'pending' && r.expires_at > Date.now())
    .map((r) => ({ approval_code: r.approval_code, client_name: r.client_name, scopes: r.scopes, redirect_host: new URL(r.redirect_uri).host, from_ip: r.from_ip, expires_in_s: Math.round((r.expires_at - Date.now()) / 1000) }));
}

/** The approval page polls this. The redirect (with the code) is handed out once. */
function requestStatus(dir, requestId) {
  return withLock(dir, () => {
    const pending = readJson(files(dir).pending, { requests: {}, codes: {} });
    const r = Object.prototype.hasOwnProperty.call(pending.requests, requestId) ? pending.requests[requestId] : null;
    if (!r || r.expires_at < Date.now()) return { status: 'expired' };
    if (r.status === 'approved') {
      const redirect = r.redirect;
      delete pending.requests[requestId];
      writePrivate(files(dir).pending, pending);
      return { status: 'approved', redirect };
    }
    if (r.status === 'denied') {
      delete pending.requests[requestId];
      writePrivate(files(dir).pending, pending);
      return { status: 'denied', redirect: withQuery(r.redirect_uri, { error: 'access_denied', error_description: 'el operador no lo aprobó', state: r.state }) };
    }
    return { status: 'pending' };
  });
}

function issueTokens(grants, grantId) {
  const g = grants[grantId];
  const access = token('mga');
  const refresh = token('mgr');
  const exp = Math.floor(Date.now() / 1000) + ACCESS_TTL_S;
  g.access = [...(g.access || []).filter((a) => a.exp * 1000 > Date.now()).slice(-4), { hash: sha(access), exp }];
  g.refresh = sha(refresh);
  g.last_used_at = nowIso();
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: g.scopes.join(' ') };
}

function tokenEndpoint(dir, b) {
  const config = loadConfig(dir);
  if (!config.enabled) throw new GptError('temporarily_unavailable', 'el gateway de GPT está apagado', 503);
  if (b.grant_type === 'authorization_code') {
    return withLock(dir, () => {
      const pending = readJson(files(dir).pending, { requests: {}, codes: {} });
      const key = sha(b.code || '');
      const c = pending.codes[key];
      delete pending.codes[key]; // single use, whatever happens next
      for (const [k, x] of Object.entries(pending.codes)) if (x.expires_at < Date.now()) delete pending.codes[k];
      writePrivate(files(dir).pending, pending);
      if (!c || c.expires_at < Date.now()) throw new GptError('invalid_grant', 'código inválido o caducado');
      if (b.client_id !== c.client_id) throw new GptError('invalid_grant', 'el código es de otro cliente');
      if (b.redirect_uri && b.redirect_uri !== c.redirect_uri) throw new GptError('invalid_grant', 'redirect_uri no coincide');
      const challenge = crypto.createHash('sha256').update(String(b.code_verifier || '')).digest('base64url');
      if (!b.code_verifier || challenge !== c.code_challenge) throw new GptError('invalid_grant', 'code_verifier no corresponde (PKCE)');
      const grants = loadGrants(dir);
      const g = grants[c.grant_id];
      if (!g || g.revoked_at) throw new GptError('invalid_grant', 'el permiso fue revocado');
      const out = issueTokens(grants, c.grant_id);
      saveGrants(dir, grants);
      audit(dir, { event: 'token_issued', grant_id: c.grant_id, via: 'authorization_code' });
      return out;
    });
  }
  if (b.grant_type === 'refresh_token') {
    return withLock(dir, () => {
      const grants = loadGrants(dir);
      const h = sha(b.refresh_token || '');
      const hit = Object.entries(grants).find(([, g]) => g.refresh === h);
      if (!hit) throw new GptError('invalid_grant', 'refresh_token inválido');
      const [id, g] = hit;
      if (b.client_id && b.client_id !== g.client_id) throw new GptError('invalid_grant', 'el token es de otro cliente');
      if (g.revoked_at || Date.parse(g.expires_at) <= Date.now()) throw new GptError('invalid_grant', 'el permiso fue revocado o caducó');
      const out = issueTokens(grants, id); // rotates: the old refresh token stops working
      saveGrants(dir, grants);
      audit(dir, { event: 'token_issued', grant_id: id, via: 'refresh_token' });
      return out;
    });
  }
  throw new GptError('unsupported_grant_type', 'grant_type no soportado');
}

function revokeEndpoint(dir, b) {
  const h = sha(b.token || '');
  withLock(dir, () => {
    const grants = loadGrants(dir);
    for (const [id, g] of Object.entries(grants)) {
      if (g.refresh === h || (g.access || []).some((a) => a.hash === h)) {
        g.revoked_at = g.revoked_at || nowIso();
        g.access = [];
        g.refresh = null;
        audit(dir, { event: 'grant_revoked', grant_id: id, by: 'client' });
      }
    }
    saveGrants(dir, grants);
  });
  return {}; // RFC 7009: 200 whether or not the token was known
}

function withQuery(u, params) {
  const url = new URL(u);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  return url.toString();
}

// ─── HTTP ────────────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function approvalPage(dir, r) {
  const d = describeProfile(loadConfig(dir).profile);
  const tools = d.tools.filter((t) => r.scopes.includes(t.scope));
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Munder · autorizar a ${esc(r.client_name)}</title>
<style>body{margin:0;background:#FFF8E7;color:#1A1320;font:15px/1.5 system-ui,sans-serif;padding:24px;max-width:640px}h1{font-size:18px}code,.code{font-family:ui-monospace,monospace}.code{font-size:34px;letter-spacing:6px;background:#1A1320;color:#FFF8E7;padding:8px 16px;display:inline-block;margin:8px 0}li{margin:2px 0}.muted{color:#6B5878}</style></head>
<body><h1>${esc(r.client_name)} pide entrar a tu oficina Munder</h1>
<p>Como principal <b>gpt</b>, perfil <b>${esc(r.profile.toUpperCase())}</b>, con: <code>${esc(r.scopes.join(' '))}</code></p>
<p>Para aprobarlo, en la computadora donde corre Munder escribe:</p>
<div class="code">${esc(r.approval_code.replace(/(\d{3})(\d{3})/, '$1 $2'))}</div>
<p><code>munder gpt aprobar ${esc(r.approval_code)}</code></p>
<p class="muted" id="st">Esperando tu aprobación… (caduca en 10 minutos)</p>
<details><summary>Qué podrá hacer (${tools.length} herramientas)</summary><ul>${tools.map((t) => `<li><code>${esc(t.name)}</code>: ${esc(t.title)}</li>`).join('')}</ul></details>
<p class="muted">Nadie puede aprobar esto desde esta página: solo tú, en tu terminal.</p>
<script>const rid=${JSON.stringify(r.request_id)};async function poll(){try{const r=await fetch('/authorize/status?request='+encodeURIComponent(rid));const j=await r.json();if(j.redirect){document.getElementById('st').textContent=j.status==='approved'?'Aprobado. Regresando…':'No aprobado.';location.href=j.redirect;return}if(j.status==='expired'){document.getElementById('st').textContent='La solicitud caducó. Vuelve a conectar desde ChatGPT.';return}}catch(e){}setTimeout(poll,2000)}poll()</script>
</body></html>`;
}

function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string';
  res.writeHead(status, { 'content-type': isStr ? 'text/html; charset=utf-8' : 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(isStr ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new GptError('too_large', 'cuerpo demasiado grande', 413)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const type = String(req.headers['content-type'] || '');
      if (!raw) return resolve({});
      if (type.includes('application/x-www-form-urlencoded')) return resolve(Object.fromEntries(new URLSearchParams(raw)));
      try { resolve(JSON.parse(raw)); } catch { reject(new GptError('invalid_request', 'JSON inválido')); }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  // Behind a tunnel every request comes from 127.0.0.1; the tunnel's header is only a hint for the audit.
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (fwd || req.socket.remoteAddress || '').slice(0, 64);
}

const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key) || { n: 0, reset: now + windowMs };
  if (now > b.reset) { b.n = 0; b.reset = now + windowMs; }
  b.n++;
  buckets.set(key, b);
  if (buckets.size > 5000) buckets.clear();
  return b.n > max;
}

function createGatewayServer({ dir = stateDir(), log = () => {} } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    const p = url.pathname;
    const ip = clientIp(req);
    try {
      if (req.method === 'OPTIONS') return send(res, 204, {}, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id', 'access-control-allow-methods': 'GET, POST, OPTIONS' });
      if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true, service: 'munder-gpt', protocol: PROTOCOL, enabled: loadConfig(dir).enabled });
      if (req.method === 'GET' && (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp')) return send(res, 200, prMetadata(dir), { 'access-control-allow-origin': '*' });
      if (req.method === 'GET' && (p === '/.well-known/oauth-authorization-server' || p === '/.well-known/openid-configuration')) return send(res, 200, asMetadata(dir), { 'access-control-allow-origin': '*' });
      if (req.method === 'POST' && p === '/register') {
        if (limited(`reg:${ip}`, 10, 60_000)) return send(res, 429, { error: 'slow_down' });
        return send(res, 201, register(dir, await readBody(req)));
      }
      if (req.method === 'GET' && p === '/authorize') {
        if (limited(`auth:${ip}`, 20, 60_000)) return send(res, 429, 'Demasiadas solicitudes. Espera un minuto.');
        const q = Object.fromEntries(url.searchParams);
        let r;
        try { r = authorizeRequest(dir, q, ip); } catch (e) { return send(res, e.status || 400, `<!doctype html><meta charset="utf-8"><p>${esc(e.message)}</p>`); }
        if (r.redirect) { res.writeHead(302, { location: r.redirect }); return res.end(); }
        log(`solicitud de acceso de «${r.client_name}»: código ${r.approval_code} (munder gpt aprobar ${r.approval_code})`);
        return send(res, 200, approvalPage(dir, r), { 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'", 'x-frame-options': 'DENY' });
      }
      if (req.method === 'GET' && p === '/authorize/status') return send(res, 200, requestStatus(dir, url.searchParams.get('request') || ''));
      if (req.method === 'POST' && p === '/token') {
        if (limited(`tok:${ip}`, 30, 60_000)) return send(res, 429, { error: 'slow_down' });
        try { return send(res, 200, tokenEndpoint(dir, await readBody(req)), { pragma: 'no-cache' }); } catch (e) { return send(res, e.status && e.status >= 500 ? e.status : 400, { error: e.code || 'invalid_request', error_description: e.message }); }
      }
      if (req.method === 'POST' && p === '/revoke') return send(res, 200, revokeEndpoint(dir, await readBody(req)));
      if (p === '/mcp') {
        const challenge = `Bearer realm="munder", resource_metadata="${baseUrl(dir)}/.well-known/oauth-protected-resource/mcp", scope="${Object.keys(SCOPES).join(' ')}"`;
        let auth;
        try {
          const m = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i);
          auth = authenticate(dir, m ? m[1] : '');
        } catch (e) {
          if (limited(`bad:${ip}`, 60, 60_000)) return send(res, 429, { error: 'slow_down' });
          audit(dir, { event: 'mcp_rejected', reason: e.code, from_ip: ip });
          return send(res, 401, { error: e.code || 'invalid_token', error_description: e.message }, { 'www-authenticate': `${challenge}, error="invalid_token"` });
        }
        if (req.method === 'GET' || req.method === 'DELETE') return send(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
        if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
        withLock(dir, () => { const grants = loadGrants(dir); if (grants[auth.grant_id]) { grants[auth.grant_id].last_used_at = nowIso(); saveGrants(dir, grants); } });
        const body = await readBody(req);
        if (Array.isArray(body)) {
          const out = (await Promise.all(body.map((m) => mcp(dir, auth, m)))).filter(Boolean);
          if (!out.length) { res.writeHead(202); return res.end(); }
          return send(res, 200, out);
        }
        const out = await mcp(dir, auth, body);
        if (!out) { res.writeHead(202); return res.end(); }
        return send(res, 200, out);
      }
      return send(res, 404, { error: 'not_found' });
    } catch (e) {
      log(`error en ${p}: ${e.message}`);
      return send(res, e.status || 500, { error: e.code || 'server_error', error_description: e.status && e.status < 500 ? e.message : 'error interno' });
    }
  });
}

module.exports = {
  PRINCIPAL, PROTOCOL, DEFAULT_PORT, SCOPES, PROFILES, CAPABILITIES, INVENTORY, HIRE_PROVIDERS, GptError,
  stateDir, files, loadConfig, saveConfig, profileName, describeProfile, capabilitiesFor, effectiveScopes,
  audit, readAudit, loadGrants, publicGrant, revoke, authenticate, approve, pendingRequests,
  register, authorizeRequest, requestStatus, tokenEndpoint, revokeEndpoint, asMetadata, prMetadata,
  ensureInbox, gptInbox, inboxMessages, createGatewayServer, mcp, scrub, sha,
};
