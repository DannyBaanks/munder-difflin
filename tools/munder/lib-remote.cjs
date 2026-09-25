'use strict';
/**
 * Munder Remote — run this office from your phone.
 *
 * The link daemon (the same one `munder link encender` and Settings → Munder
 * Link start) also serves a small web app at /app and the sealed API behind it
 * at /remote/v1/*. Open http://<this machine>:47831/app on the phone, over the
 * LAN or over Tailscale, add it to the home screen, and pair it once.
 *
 * TRUST, the same shape as office pairing:
 *  - The phone makes an X25519 key and asks to pair. It COMMITS to its nonce
 *    (sends only its hash) before it sees ours, then reveals it. That order is
 *    what stops a man in the middle from grinding nonces until the 6-digit codes
 *    on both screens match.
 *  - Both screens show the code; a human accepts it ON THIS MACHINE
 *    (`munder link aceptar`, or Settings → Munder Link). Nothing is trusted
 *    before that.
 *  - A paired phone lives in remotes.json, never in peers.json: it is the
 *    operator's remote control, not an office. It can't be delegated to and
 *    can't submit work as a peer.
 *
 * WIRE: every call is ChaCha20-Poly1305 under a key from X25519 + HKDF, with a
 * timestamp and a replay check. The phone does this in plain JS
 * (remote-app/remote-crypto.js) so it also works over plain http on the LAN,
 * where browsers withhold WebCrypto.
 *
 * LIMIT, stated plainly: over plain http the app's own code travels unsigned, so
 * someone able to rewrite traffic on your LAN could serve the phone a modified
 * app. Over Tailscale (WireGuard) that isn't possible. Prefer Tailscale; use the
 * LAN address at home.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const L = require('./lib-link.cjs');

const REMOTE = 'munder-remote@1';
const APP_DIR = path.join(__dirname, 'remote-app');
const MAX_TEXT = 8000;
const MAX_PRE = 8;

const STATIC = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'app.css': 'text/css; charset=utf-8',
  'remote-crypto.js': 'text/javascript; charset=utf-8',
  'manifest.webmanifest': 'application/manifest+json',
  'icon-180.png': 'image/png',
  'icon-512.png': 'image/png',
  // Press Start 2P, the app's display face (SIL OFL 1.1, see src/renderer/src/assets/fonts/LICENSE.txt).
  'press-start-2p.woff2': 'font/woff2',
};

/**
 * Built on request instead of copied: the cast's pixel portraits come from the
 * SAME generated engine the CLI and the app use (avatar-engine.cjs), wrapped so a
 * classic <script> exposes it as window.MunderAvatar. One source, no drift.
 */
const GENERATED = {
  'avatar-engine.js': {
    type: 'text/javascript; charset=utf-8',
    body: () => Buffer.from(`(function (exports) {\n${fs.readFileSync(path.join(__dirname, 'avatar-engine.cjs'), 'utf8')}\n})(self.MunderAvatar = {});\n`),
  },
};

const APP_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-cache',
};

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');
const clip = (s, n) => (typeof s === 'string' ? (s.length > n ? `${s.slice(0, n)}…` : s) : null);

function rawKey(b64, what) {
  const raw = typeof b64 === 'string' ? fromB64u(b64) : Buffer.alloc(0);
  if (raw.length !== 32) throw new L.LinkError('bad_args', `${what} inválida`);
  return raw;
}

function deviceIdOf(pubB64u) {
  return crypto.createHash('sha256').update(rawKey(pubB64u, 'llave')).digest('hex').slice(0, 16);
}

/** Same string as remote-crypto.js `sas`. */
function remoteSas(officeBoxPub, devicePub, officeNonce, deviceNonce) {
  const h = crypto.createHash('sha256').update(`${REMOTE}|sas|${officeBoxPub}|${devicePub}|${officeNonce}|${deviceNonce}`).digest();
  return String(h.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

function remoteKey(identity, devicePub, deviceId) {
  const priv = crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', x: identity.box.x, d: identity.box.d }, format: 'jwk' });
  const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: devicePub }, format: 'jwk' });
  const secret = crypto.diffieHellman({ privateKey: priv, publicKey: pub });
  return Buffer.from(crypto.hkdfSync('sha256', secret, `${identity.office_id}|${deviceId}`, `${REMOTE} key`, 32));
}

const aadFor = (dir, deviceId, officeId) => Buffer.from(`${REMOTE}|${dir}|${deviceId}|${officeId}`);

function sealFor(key, deviceId, officeId, payload, dir = 'res') {
  const iv = crypto.randomBytes(12);
  const pt = Buffer.from(JSON.stringify(payload), 'utf8');
  const c = crypto.createCipheriv('chacha20-poly1305', key, iv, { authTagLength: 16 });
  c.setAAD(aadFor(dir, deviceId, officeId), { plaintextLength: pt.length });
  const ct = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
  return { v: 1, iv: b64u(iv), ct: b64u(ct) };
}

function openFrom(key, deviceId, officeId, env, dir = 'req') {
  const iv = fromB64u(env.iv || '');
  const raw = fromB64u(env.ct || '');
  if (iv.length !== 12 || raw.length < 16) throw new L.LinkError('bad_envelope', 'sobre inválido');
  const d = crypto.createDecipheriv('chacha20-poly1305', key, iv, { authTagLength: 16 });
  d.setAAD(aadFor(dir, deviceId, officeId), { plaintextLength: raw.length - 16 });
  d.setAuthTag(raw.subarray(raw.length - 16));
  try { return JSON.parse(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8')); }
  catch { throw new L.LinkError('bad_seal', 'no se pudo descifrar', 401); }
}

// ─── what the phone can see and do ───────────────────────────────────────────

/** The open ask on a card: the newest entry nobody answered or dismissed (same rule as the ASK ME board). */
function openQuestion(t) {
  if (!Array.isArray(t.humanQA)) return null;
  for (let i = t.humanQA.length - 1; i >= 0; i--) {
    const e = t.humanQA[i];
    if (e && typeof e.q === 'string' && !e.a && !e.dismissedAt) return e;
  }
  return null;
}

function taskView(t) {
  const open = openQuestion(t);
  return {
    id: t.id, title: clip(t.title, 200), status: t.status, assignee: t.assignee || null,
    priority: t.priority, created_at: t.createdAt || null,
    description: clip(t.description, 600), result: clip(t.result, 600),
    question: open ? { q: clip(open.q, 4000), asked_at: open.askedAt || null } : null,
    from_office: (t.link && t.link.from_name) || null,
  };
}

function overview(office, identity, version) {
  const cap = office ? L.capacity(office) : { ...L.hostCapacity(), michael_state: 'offline' };
  const out = {
    office: { office_id: identity.office_id, name: identity.name, fingerprint: L.prettyFingerprint(identity.office_id), host: require('node:os').hostname(), version },
    capacity: cap, agents: [], tasks: [], questions: [], hive: !!office,
  };
  if (!office) return out;
  const { agents, godId } = office.registryData();
  out.agents = Object.entries(agents)
    .filter(([, a]) => a && typeof a === 'object' && !a.archived)
    .map(([id, a]) => ({ id, name: a.name || id, role: clip(a.role, 120), status: a.status || 'idle', god: id === godId, on_hold: !!a.onHold }));
  const tasks = office.tasks().filter((t) => t && typeof t === 'object' && typeof t.id === 'string');
  const newest = (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  const live = tasks.filter((t) => t.status !== 'done').sort(newest).slice(0, 200);
  const done = tasks.filter((t) => t.status === 'done').sort(newest).slice(0, 15);
  out.tasks = [...live, ...done].map(taskView);
  out.questions = tasks
    .filter((t) => t.status === 'blocked' && openQuestion(t))
    .map(taskView)
    .sort((a, b) => String(b.question.asked_at || '').localeCompare(String(a.question.asked_at || '')));
  return out;
}

function textArg(v, what) {
  if (typeof v !== 'string' || !v.trim()) throw new L.LinkError('bad_args', `falta ${what}`);
  if (v.length > MAX_TEXT) throw new L.LinkError('bad_args', `${what} es demasiado largo`);
  return v.trim();
}

/** Write the answer on the card, then tell Michael — exactly what the ASK ME board does. */
function answer(office, { task_id, q, text }, device) {
  const reply = textArg(text, 'la respuesta');
  const file = office.p('tasks.json');
  const doc = L.readJson(file, { tasks: [] });
  const tasks = Array.isArray(doc.tasks) ? doc.tasks : [];
  const t = tasks.find((x) => x && x.id === task_id);
  if (!t) throw new L.LinkError('no_task', 'esa tarea ya no existe', 404);
  const open = openQuestion(t);
  // Re-located by its text: never answer a question Michael swapped in meanwhile.
  if (!open || open.q !== q) throw new L.LinkError('question_changed', 'esa pregunta cambió o ya tiene respuesta; recarga', 409);
  open.a = reply;
  open.answeredAt = new Date().toISOString();
  office.writeJson(file, { ...doc, tasks });
  const messageId = office.message(`HUMAN ANSWER on task "${t.title}"`, [
    `The human answered the open question on task ${t.id} ("${t.title}"):`,
    `Q: ${open.q}`,
    `A: ${reply}`,
    'The answer is also recorded in the card\'s humanQA. Act on it, unblock the card, and continue the work.',
    `(Sent from the phone «${device.name}».)`,
  ].join('\n'), 'inform');
  office.log({ event: 'remote_answer', task_id: t.id, device: device.device_id, message_id: messageId });
  return { task_id: t.id, message_id: messageId };
}

/**
 * A message from the human to Michael, or to one agent of THIS office by id.
 * The id must be a live agent in the registry: that is also what keeps a
 * crafted id from ever naming a path.
 */
function ask(office, { text, agent }, device) {
  const body = textArg(text, 'el mensaje');
  let to = 'god';
  let name = 'Michael';
  if (agent !== undefined && agent !== null && agent !== '' && agent !== 'god') {
    const { agents, godId } = office.registryData();
    const a = typeof agent === 'string' && Object.prototype.hasOwnProperty.call(agents, agent) ? agents[agent] : null;
    if (!a || typeof a !== 'object' || a.archived) throw new L.LinkError('no_agent', 'ese agente ya no está en la oficina', 404);
    if (agent !== godId) { to = agent; name = a.name || agent; }
  }
  const subject = `Mensaje del humano desde el celular: ${body.split('\n')[0].slice(0, 60)}`;
  const messageId = office.message(subject, `${body}\n\n_(Enviado desde el celular «${device.name}».)_`, 'request', to);
  office.log({ event: 'remote_message', device: device.device_id, to, message_id: messageId });
  return { message_id: messageId, to, name };
}

/**
 * Another office's overview, fetched through the office link. An office that
 * predates the `overview` op still answers `status`: show its numbers and say
 * the rest needs an update there, instead of failing the whole screen.
 */
async function peerOverview(dir, query) {
  try {
    const r = await L.call(query, 'overview', {}, { dir, timeoutMs: 4000, budgetMs: 5000 });
    return { ...r.result, remote: true, latency_ms: r.latency_ms };
  } catch (e) {
    if (e.code !== 'bad_op') throw e;
    const r = await L.call(query, 'status', {}, { dir, timeoutMs: 3000, budgetMs: 4000 });
    const s = r.result;
    return {
      office: { office_id: s.office_id, name: s.name, fingerprint: L.prettyFingerprint(s.office_id), host: null, version: s.version || null },
      capacity: s.capacity, agents: [], tasks: [], questions: [], hive: true,
      remote: true, limited: true, latency_ms: r.latency_ms,
    };
  }
}

async function peersView(dir) {
  const peers = Object.values(L.loadPeers(dir));
  return Promise.all(peers.map(async (p) => {
    const base = { office_id: p.office_id, name: p.name, fingerprint: L.prettyFingerprint(p.office_id) };
    try {
      const r = await L.call(p.office_id, 'status', {}, { dir, timeoutMs: 2500, budgetMs: 3000 });
      return { ...base, online: true, latency_ms: r.latency_ms, capacity: r.result.capacity };
    } catch (e) {
      return { ...base, online: false, error: e instanceof Error ? e.message : String(e) };
    }
  }));
}

/** host:port for every LAN and Tailscale address this office answers on, Tailscale first. */
function officeAddresses() {
  return L.appUrls().map((u) => ({ address: new URL(u.url).host, via: u.via }));
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

function serveStatic(res, name) {
  const gen = Object.prototype.hasOwnProperty.call(GENERATED, name) ? GENERATED[name] : null;
  const type = gen ? gen.type : (Object.prototype.hasOwnProperty.call(STATIC, name) ? STATIC[name] : null);
  if (!type) return L.send(res, 404, { ok: false, code: 'not_found' });
  let body;
  try { body = gen ? gen.body() : fs.readFileSync(path.join(APP_DIR, name)); }
  catch { return L.send(res, 404, { ok: false, code: 'not_found' }); }
  res.writeHead(200, { ...APP_HEADERS, 'Content-Type': type, 'Content-Length': body.length });
  res.end(body);
}

function createRemoteRoutes({ dir = L.stateDir(), hiveRoot = L.localHiveRoot(), identity = L.loadIdentity(dir), version = 'dev', now = () => Date.now(), pairAllowed = () => true } = {}) {
  /** Pairings that committed but haven't revealed yet. Memory only, bounded. */
  const pre = new Map();
  const seen = new Map();
  const keys = new Map();

  const keyFor = (rec) => {
    const k = `${rec.device_id}|${rec.box_pub}`;
    if (!keys.has(k)) keys.set(k, remoteKey(identity, rec.box_pub, rec.device_id));
    return keys.get(k);
  };

  async function dispatch(op, args, device) {
    const office = () => new L.Office(hiveRoot, 'human', dir);
    const officeOrNull = () => { try { return office(); } catch { return null; } };
    switch (op) {
      // `addresses` lets the native app pair once at home and still find this
      // office over Tailscale later: it tries each address, last good first.
      case 'hello': return { office_id: identity.office_id, name: identity.name, device: device.name, version, addresses: officeAddresses() };
      case 'overview': {
        const target = typeof args.office === 'string' ? args.office.trim() : '';
        if (!target || target === 'self' || target === identity.office_id || target === identity.name) {
          return overview(officeOrNull(), identity, version);
        }
        return peerOverview(dir, target);
      }
      case 'peers': return { peers: await peersView(dir) };
      case 'answer': return answer(office(), args, device);
      case 'ask': return ask(office(), args, device);
      case 'delegate': {
        const text = textArg(args.text, 'la tarea');
        const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim().slice(0, 120) : undefined;
        const r = await L.delegate(String(args.office || ''), text, { title, dir, hiveRoot });
        return { office: r.peer.name, task_id: r.result.task_id, duplicate: !!r.result.duplicate, latency_ms: r.latency_ms };
      }
      default: throw new L.LinkError('bad_op', `operación desconocida: ${op}`);
    }
  }

  async function handle(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/app') {
      res.writeHead(301, { Location: '/app/' });
      return res.end();
    }
    if (req.method === 'GET' && url.pathname.startsWith('/app/')) {
      const name = url.pathname.slice('/app/'.length) || 'index.html';
      return serveStatic(res, name);
    }

    const addr = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');

    if (req.method === 'POST' && url.pathname === '/remote/v1/pair') {
      if (!pairAllowed(addr)) throw new L.LinkError('rate_limited', 'demasiadas solicitudes de emparejamiento desde esta dirección', 429);
      const b = await L.readBody(req);
      const deviceId = deviceIdOf(b.pub);
      rawKey(b.commit, 'compromiso');
      const t = now();
      for (const [k, v] of pre) if (v.expires < t) pre.delete(k);
      if (!pre.has(deviceId) && pre.size >= MAX_PRE) throw new L.LinkError('busy', 'demasiadas solicitudes pendientes', 429);
      const nonce = b64u(crypto.randomBytes(16));
      const name = String(b.name || 'celular').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || 'celular';
      pre.set(deviceId, { device_id: deviceId, name, pub: b.pub, commit: b.commit, nonce, addr, expires: t + L.PENDING_TTL_MS });
      return L.send(res, 200, { protocol: REMOTE, office_id: identity.office_id, name: identity.name, box_pub: identity.box.x, nonce, device_id: deviceId });
    }

    if (req.method === 'POST' && url.pathname === '/remote/v1/reveal') {
      const b = await L.readBody(req);
      const hit = pre.get(String(b.device_id));
      if (!hit || hit.expires < now()) throw new L.LinkError('no_request', 'esa solicitud ya no existe; vuelve a emparejar', 404);
      pre.delete(hit.device_id); // one reveal per commitment, right or wrong
      const nonce = fromB64u(b.nonce || '');
      const digest = crypto.createHash('sha256').update(nonce).digest();
      const commit = fromB64u(hit.commit);
      if (nonce.length < 16 || commit.length !== digest.length || !crypto.timingSafeEqual(digest, commit)) {
        throw new L.LinkError('bad_commit', 'el celular no cumplió su compromiso; vuelve a emparejar', 400);
      }
      const pending = L.loadPending(dir);
      if (!pending[hit.device_id] && Object.keys(pending).length >= L.MAX_PENDING) throw new L.LinkError('busy', 'demasiadas solicitudes pendientes', 429);
      pending[hit.device_id] = {
        office_id: hit.device_id, name: hit.name, kind: 'remote', box_pub: hit.pub,
        addresses: [hit.addr].filter(Boolean),
        code: remoteSas(identity.box.x, hit.pub, hit.nonce, b64u(nonce)),
        expires_at: now() + L.PENDING_TTL_MS,
      };
      L.savePending(pending, dir);
      return L.send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/remote/v1/call') {
      const env = await L.readBody(req);
      const deviceId = String(env.dev || '');
      const rec = L.loadRemotes(dir)[deviceId];
      if (!rec) {
        const waiting = !!L.loadPending(dir)[deviceId];
        throw new L.LinkError(waiting ? 'waiting' : 'unknown_device', waiting ? 'falta que aceptes el código en la computadora' : 'este celular no está emparejado', 401);
      }
      const key = keyFor(rec);
      const msg = openFrom(key, deviceId, identity.office_id, env);
      const t = now();
      if (Math.abs(t - Number(msg.ts)) > L.MAX_SKEW_MS) throw new L.LinkError('stale', 'la hora del celular y la de esta máquina no coinciden', 401);
      for (const [n, exp] of seen) if (exp < t) seen.delete(n);
      const nk = `${deviceId}|${env.iv}`;
      if (seen.has(nk)) throw new L.LinkError('replay', 'mensaje repetido', 401);
      seen.set(nk, t + L.NONCE_TTL_MS);
      let reply;
      try {
        reply = { ok: true, result: await dispatch(String(msg.op || ''), msg.args && typeof msg.args === 'object' ? msg.args : {}, rec) };
      } catch (e) {
        reply = { ok: false, code: e.code || 'error', error: e instanceof L.LinkError ? e.message : 'error interno' };
      }
      // `re` binds the answer to this request, like the office link does.
      return L.send(res, 200, sealFor(key, deviceId, identity.office_id, { ...reply, re: env.iv }));
    }

    return L.send(res, 404, { ok: false, code: 'not_found' });
  }

  return { handle };
}

module.exports = {
  REMOTE, APP_DIR, STATIC, GENERATED, createRemoteRoutes,
  deviceIdOf, remoteSas, remoteKey, sealFor, openFrom, openQuestion, overview,
};
