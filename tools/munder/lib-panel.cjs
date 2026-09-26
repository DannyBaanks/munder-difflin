'use strict';
/**
 * Munder Panel: the `munder` CLI as buttons, for people who never open a terminal.
 *
 * A tiny local web app (builtins only, like the rest of tools/munder) that the
 * packaged app opens with `Munder Difflin --panel`, and a dev checkout with
 * `munder panel`. It runs in its own process, so it works while Munder is
 * closed or crashed: that is when "Abrir Munder" and "Revivir" matter most.
 *
 * It never takes a command line from the page. Every button is one entry in
 * ACTIONS, calling the same engines the CLI uses (lib-link, lib-gpt,
 * lib-reviver) or the CLI scripts themselves with fixed arguments.
 *
 * Only 127.0.0.1, only its own Host header, and every API call carries a
 * random token that the page receives in the URL fragment (never sent over
 * the network, never logged).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const HERE = __dirname;
const L = require('./lib-link.cjs');

// ─── where things live ──────────────────────────────────────────────────────
function stateDir() {
  return process.env.MUNDER_PANEL_DIR
    || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'munder', 'panel');
}

/** Munder's userData, the same rule the reviver uses (both spellings, every OS). */
function userDataDir() {
  if (process.env.MUNDER_USER_DATA) return process.env.MUNDER_USER_DATA;
  const base = process.platform === 'win32' ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  const names = ['munder-difflin', 'Munder Difflin'];
  return names.map((n) => path.join(base, n)).find((d) => fs.existsSync(d)) || path.join(base, names[0]);
}

/**
 * The env for our own node scripts (gpt.cjs, link-serve.cjs…). Inside the
 * packaged panel this process IS Electron: without ELECTRON_RUN_AS_NODE the
 * child would boot a second copy of the app instead of running the script.
 */
function nodeEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

const readJson = (f, fallback = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };

/** Run one of the sibling CLI scripts (gpt.cjs, reviver.cjs…) with fixed args. */
function runScript(script, args, { timeoutMs = 60_000 } = {}) {
  const r = spawnSync(process.execPath, [path.join(HERE, script), ...args], {
    encoding: 'utf8', timeout: timeoutMs, env: nodeEnv({ NO_COLOR: '1' }), windowsHide: true,
  });
  const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { ok: r.status === 0, code: r.status, text: text || (r.error ? r.error.message : '') };
}

// ─── Munder itself ──────────────────────────────────────────────────────────
/** Is Munder running? Asked through its own local control channel (/salud). */
async function appStatus({ dir = userDataDir(), timeoutMs = 2500 } = {}) {
  const cfg = readJson(path.join(dir, 'munder-control.json'));
  if (!cfg || typeof cfg.port !== 'number' || typeof cfg.token !== 'string') return { running: false };
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/salud`, {
      headers: { authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status !== 200 || body.ok !== true) return { running: false };
    const inst = body.instance || body;
    return { running: true, pid: inst.pid ?? null, version: inst.version ?? null };
  } catch {
    return { running: false };
  }
}

/**
 * How to open Munder. The packaged launcher passes its own executable in
 * MUNDER_PANEL_APP; a dev checkout goes through `munder start` (start.sh's rules).
 */
function launcher() {
  const exe = process.env.MUNDER_PANEL_APP;
  if (exe) return { cmd: exe, args: [], cwd: path.dirname(exe) };
  return { cmd: process.execPath, args: [path.join(HERE, 'munder'), 'start'], cwd: path.join(HERE, '..', '..') };
}

function openApp() {
  const l = launcher();
  let env;
  if (process.env.MUNDER_PANEL_APP) {
    env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; // the app must boot as an app, not as node
  } else {
    env = nodeEnv(); // dev: `munder start` is a node script
  }
  const child = spawn(l.cmd, l.args, { cwd: l.cwd, env, detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return child.pid;
}

// ─── the reviver, when installed ─────────────────────────────────────────────
function reviverLib() { return require('./lib-reviver.cjs'); }

async function reviverStatus() {
  const R = reviverLib();
  const dir = R.stateDir();
  if (!fs.existsSync(R.files(dir).config)) return { configured: false, running: false };
  try {
    const r = await R.call(R.localCredential(dir), 'status', { timeoutMs: 2500 });
    return { configured: true, running: true, healthy: !!r.healthy, watchdog: r.watchdog && r.watchdog.enabled ? r.watchdog.state : 'apagado' };
  } catch {
    return { configured: true, running: false };
  }
}

async function reviverOp(op) {
  const R = reviverLib();
  const r = await R.call(R.localCredential(R.stateDir()), op, { timeoutMs: 120_000 });
  return { ok: !!r.ok, text: `${r.action}: ${r.verdict}${r.reason ? ` — ${r.reason}` : ''}` };
}

// ─── the whole picture, for the page ─────────────────────────────────────────
function linkPid() {
  try {
    const pid = Number(fs.readFileSync(L.files().pid, 'utf8').trim());
    return pid > 0 && alive(pid) ? pid : null;
  } catch { return null; }
}

async function linkState() {
  const me = L.loadIdentity();
  const pid = linkPid();
  const peers = Object.values(L.loadPeers());
  const seen = await Promise.all(peers.map((p) => L.call(p.office_id, 'status', {}, { timeoutMs: 2500 })
    .then((r) => ({ name: p.name, online: true, latency_ms: r.latency_ms, workers_idle: r.result.capacity.workers_idle, workers_total: r.result.capacity.workers_total }),
      (e) => ({ name: p.name, online: false, reason: e.code === 'unknown_peer' ? 'esperando que acepte' : 'sin conexión' }))));
  return {
    on: !!pid,
    name: me.name,
    fingerprint: L.prettyFingerprint(me.office_id),
    peers: seen,
    pending: Object.values(L.loadPending()).map((q) => ({ name: q.name, kind: q.kind === 'remote' ? 'celular' : 'oficina', code: q.code })),
    phones: Object.values(L.loadRemotes()).map((r) => ({ id: r.device_id, name: r.name, since: String(r.paired_at || '').slice(0, 10), authority: L.remoteAuthority(r) })),
    urls: L.appUrls().map((u) => ({ url: u.url, via: u.via === 'tailscale' ? 'Tailscale (también fuera de casa)' : 'red de casa' })),
  };
}

function gptState() {
  const r = runScript('gpt.cjs', ['estado', '--json'], { timeoutMs: 15_000 });
  const j = (() => { try { return JSON.parse(r.text); } catch { return null; } })();
  if (!j) return { available: false };
  return {
    available: true, on: !!j.enabled, running: !!(j.gateway && j.gateway.running), profile: j.profile,
    public_url: j.public_url || null, grants: (j.grants || []).length,
    pending: (j.pending || []).map((p) => ({ code: p.approval_code, client: p.client_name })),
  };
}

async function state() {
  const [app, link, reviver] = await Promise.all([
    appStatus(),
    linkState().catch((e) => ({ error: e.message })),
    reviverStatus().catch(() => ({ configured: false, running: false })),
  ]);
  return { app, link, gpt: gptState(), reviver, platform: process.platform, launcher: process.env.MUNDER_PANEL_APP ? 'app' : 'dev' };
}

// ─── the buttons ─────────────────────────────────────────────────────────────
const CODE = /^\d{6}$/;
const need = (cond, msg) => { if (!cond) throw Object.assign(new Error(msg), { status: 400 }); };

const ACTIONS = {
  'app.open': async () => {
    if ((await appStatus()).running) return { ok: true, text: 'Munder ya está abierto.' };
    const rv = await reviverStatus();
    if (rv.running) return reviverOp('start');
    openApp();
    return { ok: true, text: 'Abriendo Munder… tarda unos segundos.' };
  },
  'app.close': async () => {
    const rv = await reviverStatus();
    if (rv.running) return reviverOp('stop');
    const s = await appStatus();
    if (!s.running || !s.pid) return { ok: true, text: 'Munder ya estaba cerrado.' };
    process.kill(s.pid, 'SIGTERM');
    return { ok: true, text: 'Cerrando Munder.' };
  },
  'app.restart': async () => {
    const rv = await reviverStatus();
    if (rv.running) return reviverOp('restart');
    await ACTIONS['app.close']();
    for (let i = 0; i < 40 && (await appStatus({ timeoutMs: 500 })).running; i++) await new Promise((r) => setTimeout(r, 250));
    openApp();
    return { ok: true, text: 'Reiniciando Munder… tarda unos segundos.' };
  },

  'link.on': async () => {
    if (linkPid()) return { ok: true, text: 'El enlace ya estaba encendido.' };
    const f = L.files();
    fs.mkdirSync(L.stateDir(), { recursive: true, mode: 0o700 });
    const out = fs.openSync(f.log, 'a');
    const child = spawn(process.execPath, [path.join(HERE, 'link-serve.cjs')], { detached: true, stdio: ['ignore', out, out], env: nodeEnv(), windowsHide: true });
    child.unref();
    fs.writeFileSync(f.pid, String(child.pid));
    return { ok: true, text: 'Enlace encendido. Ya te pueden encontrar tus otras oficinas y tu celular.' };
  },
  'link.off': async () => {
    const pid = linkPid();
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    try { fs.unlinkSync(L.files().pid); } catch { /* none */ }
    return { ok: true, text: pid ? 'Enlace apagado.' : 'El enlace ya estaba apagado.' };
  },
  'link.accept': async ({ code }) => {
    need(CODE.test(String(code || '')), 'El código son 6 números.');
    const p = L.acceptPending(String(code));
    need(p, 'Ese código no coincide con ninguna solicitud. Si no la esperabas, no aceptes nada.');
    return { ok: true, text: p.kind === 'remote' ? `Celular «${p.name}» emparejado.` : `Enlazada con «${p.name}».` };
  },
  'link.forgetPhone': async ({ id }) => {
    need(typeof id === 'string' && id.length > 0 && id.length < 100, 'Falta el celular.');
    const r = L.forgetRemote(id);
    need(r, 'Ese celular ya no estaba emparejado.');
    return { ok: true, text: `Celular «${r.name}» olvidado: deja de funcionar en ese momento.` };
  },
  // The grant a phone needs before it can press anything that touches THIS
  // computer. It is a desktop-only button on purpose: a phone cannot widen its
  // own authority, and this one is not in the phone's action set (PANEL_OFF in
  // lib-remote.cjs) precisely because that would be circular.
  'link.phoneAuthority': async ({ id, on }) => {
    need(typeof id === 'string' && id.length > 0 && id.length < 100, 'Falta el celular.');
    const r = L.setRemoteAuthority(id, on ? L.REMOTE_AUTHORITY.MACHINE : L.REMOTE_AUTHORITY.OFFICE);
    need(r, 'Ese celular no está emparejado con esta oficina.');
    return {
      ok: true,
      text: r.authority === L.REMOTE_AUTHORITY.MACHINE
        ? `Celular «${r.name}» ya puede manejar la computadora, no solo la oficina.`
        : `Celular «${r.name}» vuelve a manejar solo la oficina.`,
    };
  },

  'gpt.on': async () => runScript('gpt.cjs', ['encender'], { timeoutMs: 90_000 }),
  'gpt.off': async () => runScript('gpt.cjs', ['apagar']),
  'gpt.approve': async ({ code }) => { need(CODE.test(String(code || '')), 'El código son 6 números.'); return runScript('gpt.cjs', ['aprobar', String(code)]); },
  'gpt.deny': async ({ code }) => { need(CODE.test(String(code || '')), 'El código son 6 números.'); return runScript('gpt.cjs', ['rechazar', String(code)]); },

  'reviver.enable': async () => {
    const R = reviverLib();
    const steps = [];
    if (!fs.existsSync(R.files(R.stateDir()).config)) {
      // An AppImage runs from a temporary mount: point the reviver at the file itself.
      const init = runScript('reviver.cjs', ['init', ...(process.env.APPIMAGE ? ['--exe', process.env.APPIMAGE] : [])]);
      steps.push(init.text);
      if (!init.ok) return { ok: false, text: steps.join('\n') };
    }
    const inst = runScript('reviver.cjs', ['instalar'], { timeoutMs: 90_000 });
    steps.push(inst.text);
    return { ok: inst.ok, text: steps.join('\n') };
  },
  'reviver.disable': async () => runScript('reviver.cjs', ['desinstalar']),

  'shortcut.install': async () => installShortcut(),
};

// ─── a menu entry that opens the panel ───────────────────────────────────────
/** The command line a desktop shortcut runs to open this panel. */
function panelCommand() {
  if (process.env.APPIMAGE) return { cmd: process.env.APPIMAGE, args: ['--panel'] };
  if (process.env.PORTABLE_EXECUTABLE_FILE) return { cmd: process.env.PORTABLE_EXECUTABLE_FILE, args: ['--panel'] };
  if (process.env.MUNDER_PANEL_APP) return { cmd: process.env.MUNDER_PANEL_APP, args: ['--panel'] };
  return { cmd: process.execPath, args: [path.join(HERE, 'munder'), 'panel'] };
}

function desktopEntry({ cmd, args }) {
  const q = (s) => (/[\s"'\\]/.test(s) ? `"${s.replace(/(["\\`$])/g, '\\$1')}"` : s);
  return [
    '[Desktop Entry]', 'Type=Application', 'Name=Munder Panel',
    'Comment=Abre, cierra y maneja Munder Difflin con botones',
    `Exec=${[cmd, ...args].map(q).join(' ')}`,
    'Icon=munder-difflin', 'Terminal=false', 'Categories=Development;Utility;', '',
  ].join('\n');
}

function installShortcut() {
  if (process.platform === 'linux') {
    const dir = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'applications');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'munder-panel.desktop');
    fs.writeFileSync(file, desktopEntry(panelCommand()), { mode: 0o755 });
    return { ok: true, text: 'Listo: busca «Munder Panel» en tu menú de aplicaciones.' };
  }
  if (process.platform === 'win32') {
    const portable = process.env.PORTABLE_EXECUTABLE_FILE;
    if (!portable) return { ok: true, text: 'En Windows el instalador ya pone «Munder Panel» en el menú Inicio.' };
    // The portable .exe has no installer: make the Start menu entry here.
    // Paths travel as env vars, never spliced into the PowerShell command.
    const dir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:MP_LNK); $s.TargetPath=$env:MP_EXE; $s.Arguments="--panel"; $s.Save()'],
    { env: { ...process.env, MP_LNK: path.join(dir, 'Munder Panel.lnk'), MP_EXE: portable }, windowsHide: true, encoding: 'utf8', timeout: 20_000 });
    return r.status === 0 ? { ok: true, text: 'Listo: busca «Munder Panel» en el menú Inicio.' } : { ok: false, text: `No pude crear el acceso directo: ${(r.stderr || r.error?.message || '').trim()}` };
  }
  return { ok: false, text: 'En Mac, abre el Panel desde Munder o con: munder panel' };
}

// ─── the server ──────────────────────────────────────────────────────────────
const PAGE_DIR = path.join(HERE, 'panel-app');
const FONT = path.join(HERE, 'remote-app', 'press-start-2p.woff2');

function createPanelServer({ token = crypto.randomBytes(24).toString('hex'), actions = ACTIONS, getState = state, idleMs = 0, onIdle } = {}) {
  let port = 0;
  let lastSeen = Date.now();
  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, {
      'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const authed = (req) => {
    const t = String(req.headers['x-munder-panel'] || '');
    return t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token));
  };
  const server = http.createServer(async (req, res) => {
    // Only this panel, by its own address: a DNS-rebound page on another name is refused.
    if (req.headers.host !== `127.0.0.1:${port}`) return send(res, 421, { error: 'host' });
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, fs.readFileSync(path.join(PAGE_DIR, 'index.html')), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/panel.js') return send(res, 200, fs.readFileSync(path.join(PAGE_DIR, 'panel.js')), 'text/javascript; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/panel.css') return send(res, 200, fs.readFileSync(path.join(PAGE_DIR, 'panel.css')), 'text/css; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/font.woff2') {
        return fs.existsSync(FONT) ? send(res, 200, fs.readFileSync(FONT), 'font/woff2') : send(res, 404, { error: 'none' });
      }
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not_found' });
      if (!authed(req)) return send(res, 401, { error: 'token' });
      lastSeen = Date.now();
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, await getState());
      if (req.method === 'POST' && url.pathname === '/api/action') {
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > 8192) return send(res, 413, { error: 'too_big' }); }
        let body;
        try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { ok: false, text: 'Petición inválida.' }); }
        const fn = Object.prototype.hasOwnProperty.call(actions, body.action) ? actions[body.action] : null;
        if (!fn) return send(res, 400, { ok: false, text: 'Ese botón no existe.' });
        try {
          const r = await fn(body.args || {});
          return send(res, 200, { ok: !!r.ok, text: r.text || '' });
        } catch (e) {
          return send(res, e.status || 500, { ok: false, text: e.message });
        }
      }
      return send(res, 405, { error: 'method' });
    } catch (e) {
      return send(res, 500, { ok: false, text: e.message });
    }
  });
  server.on('listening', () => { port = server.address().port; });
  let timer = null;
  if (idleMs > 0) {
    timer = setInterval(() => { if (Date.now() - lastSeen > idleMs) { clearInterval(timer); if (onIdle) onIdle(); } }, Math.min(idleMs, 5000));
    timer.unref();
    server.on('close', () => clearInterval(timer));
  }
  return { server, token, url: () => `http://127.0.0.1:${port}/#t=${token}` };
}

/** Open a URL in the person's browser, without a shell. */
function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); return true; } catch { return false; }
}

module.exports = {
  stateDir, userDataDir, nodeEnv, appStatus, launcher, openApp, reviverStatus, linkState, gptState, state,
  ACTIONS, CODE, panelCommand, desktopEntry, installShortcut, createPanelServer, openBrowser, readJson, alive,
};
