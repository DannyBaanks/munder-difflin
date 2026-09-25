#!/usr/bin/env node
'use strict';
/**
 * munder-reviver: the maintenance plane's CLI and daemon (lib-reviver.cjs).
 *
 *   munder-reviver init [opciones]     pin the target and this office, make the keys
 *   munder-reviver servir              run the daemon in the foreground (what the service runs)
 *   munder-reviver instalar            systemd --user (Linux) / logon task (Windows), then start it
 *   munder-reviver desinstalar
 *   munder-reviver status | start | restart | stop | recibos      (through the local daemon)
 *   munder-reviver cliente nuevo NOMBRE [--direccion HOST:PUERTO] [--salida ARCHIVO]
 *   munder-reviver cliente autorizar NOMBRE LLAVE_PUBLICA
 *   munder-reviver cliente quitar ID|NOMBRE
 *   munder-reviver clientes
 *   munder-reviver llamar CREDENCIAL OPERACION [--direccion HOST:PUERTO]   (from another machine)
 *
 * Builtins only, and it never loads Munder's app code: it must work while Munder is gone.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const R = require('./lib-reviver.cjs');

const say = (m) => console.log(`munder-reviver: ${m}`);
const die = (m, code = 1) => { console.error(`munder-reviver: ${m}`); process.exit(code); };

const OP_ALIASES = { estado: 'status', status: 'status', start: 'start', arrancar: 'start', restart: 'restart', reiniciar: 'restart', stop: 'stop', parar: 'stop', recibos: 'receipts', receipts: 'receipts' };

function flags(args) {
  const out = { _: [], arg: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    const bool = ['autostart', 'force', 'json', 'no-sandbox', 'sin-watchdog', 'solo-archivos'].includes(k);
    const v = bool ? true : inline !== undefined ? inline : args[++i];
    if (!bool && v === undefined) die(`--${k} necesita un valor`);
    if (k === 'arg') out.arg.push(v); else out[k] = v;
  }
  return out;
}

// ─── init: discover the target the way start.sh launches it ─────────────────
function electronIn(root) {
  const dist = path.join(root, 'node_modules', 'electron', 'dist');
  if (process.platform === 'win32') return path.join(dist, 'electron.exe');
  if (process.platform === 'darwin') return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return path.join(dist, 'electron');
}

function defaultUserData() {
  const base = process.platform === 'win32' ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  const names = ['munder-difflin', 'Munder Difflin'];
  const hit = names.map((n) => path.join(base, n)).find((d) => fs.existsSync(d));
  return hit || path.join(base, names[0]);
}

/** The Link office identity is THE office identity; init pins its public id (creating it if this office never had one). */
function officeId(explicit) {
  if (explicit) return explicit;
  const lib = require('./lib-link.cjs');
  return lib.loadIdentity().office_id;
}

function sessionEnv() {
  // A systemd --user service does not inherit the desktop session: remember
  // what Electron needs to open a window. Only these keys, never secrets.
  if (process.platform !== 'linux') return {};
  const keys = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP'];
  const env = {};
  for (const k of keys) if (process.env[k]) env[k] = process.env[k];
  return env;
}

function cmdInit(f) {
  const dir = R.stateDir();
  if (fs.existsSync(R.files(dir).config) && !f.force) die(`ya hay configuración en ${R.files(dir).config} (usa --force para rehacerla)`);
  let target;
  if (f.exe) {
    target = { exe: path.resolve(f.exe), args: f.arg, cwd: path.resolve(f.cwd || path.dirname(f.exe)) };
  } else if (process.versions.electron && path.basename(path.dirname(__filename)) === 'munder' && process.resourcesPath) {
    // Packaged app, run as node (ELECTRON_RUN_AS_NODE=1): the target is the app itself.
    target = { exe: process.execPath, args: [], cwd: path.dirname(process.execPath) };
  } else {
    const root = path.resolve(f.app || path.join(__dirname, '..', '..'));
    const exe = electronIn(root);
    if (!fs.existsSync(path.join(root, 'package.json'))) die(`${root} no parece un checkout de Munder (sin package.json). Usa --app o --exe`);
    if (!fs.existsSync(exe)) die(`no encuentro Electron en ${exe}: corre npm install en ${root}`);
    if (!fs.existsSync(path.join(root, 'out', 'main', 'index.js'))) say(`AVISO: no hay build en ${root}/out: corre npm run build antes de usar start`);
    const args = [];
    // Same rule as start.sh: without a root-owned setuid chrome-sandbox, run without the sandbox.
    if (process.platform === 'linux') {
      const helper = path.join(path.dirname(exe), 'chrome-sandbox');
      let ok = false;
      try { const s = fs.statSync(helper); ok = s.uid === 0 && (s.mode & 0o4777) === 0o4755; } catch { /* missing */ }
      if (!ok || f['no-sandbox']) args.push('--no-sandbox');
    }
    args.push(...f.arg, root);
    target = { exe, args, cwd: root };
  }
  const userData = path.resolve(f['user-data'] || defaultUserData());
  if (f['user-data'] && !target.args.some((a) => a.startsWith('--user-data-dir'))) target.args.unshift(`--user-data-dir=${userData}`);
  const env = { ...sessionEnv() };
  if (Object.keys(env).length) target.env = env;
  const config = {
    office_id: officeId(f.oficina || f.office),
    target,
    user_data: userData,
    bind: f.bind || '127.0.0.1',
    port: f.port ? Number(f.port) : R.DEFAULT_PORT,
    autostart: !!f.autostart,
    health_timeout_ms: f['timeout'] ? Number(f['timeout']) * 1000 : 90_000,
    watchdog: { ...R.DEFAULT_WATCHDOG, enabled: !f['sin-watchdog'] },
  };
  R.saveConfig(dir, config);
  const identity = R.loadIdentity(dir);
  R.localCredential(dir);
  say(`listo en ${dir}`);
  console.log(`  reviver:   ${identity.name} (${identity.reviver_id})`);
  console.log(`  oficina:   ${config.office_id}`);
  console.log(`  destino:   ${target.exe} ${target.args.join(' ')}`);
  console.log(`  carpeta:   ${target.cwd}`);
  console.log(`  userData:  ${userData}`);
  console.log(`  escucha:   ${config.bind}:${config.port}${config.autostart ? '  · arranca Munder al iniciar' : ''}`);
  console.log('Siguiente: munder-reviver instalar   (o munder-reviver servir para probar)');
}

// ─── the daemon ──────────────────────────────────────────────────────────────
function cmdServe() {
  const dir = R.stateDir();
  const logFile = R.files(dir).log;
  const log = (m) => {
    const line = `${new Date().toISOString()} ${m}`;
    console.log(line);
    try {
      fs.appendFileSync(logFile, line + '\n', { mode: 0o600 });
      if (fs.statSync(logFile).size > 512 * 1024) fs.writeFileSync(logFile, fs.readFileSync(logFile, 'utf8').slice(-256 * 1024), { mode: 0o600 });
    } catch { /* best effort */ }
  };
  let config;
  try { config = R.loadConfig(dir); } catch (e) { die(e.message); }
  const reviver = new R.Reviver({ dir, log });
  const server = R.createReviverServer({ reviver, log });
  server.on('error', (e) => die(e.code === 'EADDRINUSE' ? `el puerto ${config.port} está ocupado (¿ya hay un reviver?)` : e.message));
  server.listen(config.port, config.bind, async () => {
    const id = R.loadIdentity(dir);
    fs.writeFileSync(R.files(dir).pid, String(process.pid));
    log(`${id.name} (${id.reviver_id}) escuchando en ${config.bind}:${config.port}; oficina ${config.office_id}`);
    if (!['127.0.0.1', '::1', 'localhost'].includes(config.bind)) log(`AVISO: escucho fuera de loopback (${config.bind}). Cada petición va firmada, pero úsalo sobre Tailscale.`);
    try {
      const r = await reviver.autostart();
      if (r) log(`autostart: ${r.verdict}${r.reason ? ` (${r.reason})` : ''}`);
    } catch (e) { log(`autostart: ${e.message}`); }
  });
  let ticking = false;
  const timer = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      const t = await reviver.tick();
      if (t.acted) log(`watchdog: ${t.verdict}`);
    } catch (e) { log(`watchdog: ${e.message}`); } finally { ticking = false; }
  }, config.watchdog.interval_ms);
  const bye = () => { clearInterval(timer); try { fs.unlinkSync(R.files(dir).pid); } catch { /* none */ } server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}

// ─── talking to it ───────────────────────────────────────────────────────────
function show(op, result, asJson) {
  if (asJson) { console.log(JSON.stringify(result, null, 2)); return; }
  if (op === 'status') {
    const m = result.munder;
    console.log(`reviver:  ${result.reviver.name} (${result.reviver.reviver_id}) en ${result.reviver.host}`);
    console.log(`oficina:  esperada ${result.office.expected}${result.office.seen ? `, contesta ${result.office.seen}` : ''}`);
    console.log(`destino:  ${result.target.exe}${result.target.exists ? '' : '  (¡NO EXISTE!)'}`);
    console.log(`munder:   ${m.state}${m.pids.length ? `  pid ${m.pids.join(', ')}` : ''}${m.version ? `  v${m.version}` : ''}`);
    console.log(`salud:    canal ${m.health.channel}, ${m.health_ok ? 'contesta' : `no contesta${m.health.detail ? ` (${m.health.detail})` : ''}`}; identidad ${m.identity_verified ? 'verificada' : 'NO verificada'}`);
    console.log(`watchdog: ${result.watchdog.enabled ? result.watchdog.state : 'apagado'}; deseado: ${result.desired || '—'}${result.busy ? `; ocupado: ${result.busy}` : ''}`);
    if (result.last) console.log(`último:   ${result.last.action} → ${result.last.verdict}${result.last.reason ? ` (${result.last.reason})` : ''} ${result.last.at}`);
    if (!result.healthy) process.exitCode = 3;
    return;
  }
  if (op === 'receipts') {
    for (const r of result.receipts) console.log(`${r.completed_at}  ${r.action.padEnd(15)} ${r.verdict.padEnd(13)} ${r.caller}${r.reason ? `  — ${r.reason}` : ''}`);
    if (!result.receipts.length) console.log('(sin recibos todavía)');
    return;
  }
  console.log(`${result.action}: ${result.verdict}${result.reason ? ` — ${result.reason}` : ''}`);
  if (result.stop && result.stop.verified_target) console.log(`  paré pid ${result.stop.pid} (verificado por ${result.stop.verified_by}); árbol ${result.stop.tree.join(', ')}${result.stop.forced ? `; forzados ${result.stop.forced.join(', ')}` : ''}`);
  if (result.start) console.log(`  lancé: ${result.start.spawned ? `pid ${result.start.pid}` : 'no'}; log ${result.start.log_file}`);
  if (result.after) console.log(`  después: ${result.after.state}; salud ${result.after.health_ok ? 'ok' : 'no'}; identidad ${result.after.identity_verified ? 'ok' : 'no'}`);
  console.log(`  recibo ${result.receipt_id}`);
  if (!result.ok) process.exitCode = 2;
}

async function cmdOp(op, f) {
  const dir = R.stateDir();
  let cred;
  try { cred = R.localCredential(dir); } catch (e) { die(e.message); }
  try {
    show(op, await R.call(cred, op, { address: f.direccion }), f.json);
  } catch (e) {
    if (e.cause && e.cause.code === 'ECONNREFUSED') die('el reviver no está corriendo: munder-reviver instalar (o servir)');
    die(e.message);
  }
}

async function cmdRemote(credFile, op, f) {
  const cred = R.readJson(credFile, null);
  if (!cred || !cred.key || !cred.reviver) die(`${credFile} no es una credencial de reviver`);
  try { show(op, await R.call(cred, op, { address: f.direccion }), f.json); } catch (e) { die(e.message); }
}

function cmdClient(sub, rest, f) {
  const dir = R.stateDir();
  if (sub === 'nuevo') {
    const name = rest[0] || die('uso: munder-reviver cliente nuevo NOMBRE [--direccion HOST:PUERTO] [--salida ARCHIVO]');
    const cred = R.newClientCredential(dir, name, f.direccion);
    if (f.salida) { R.writePrivate(path.resolve(f.salida), cred); say(`credencial de «${name}» (${cred.client_id}) en ${f.salida}: trátala como una contraseña`); }
    else { console.log(JSON.stringify(cred, null, 2)); console.error('munder-reviver: esta es la única copia de la llave privada: guárdala como una contraseña.'); }
    return;
  }
  if (sub === 'autorizar') {
    const [name, pub] = rest;
    if (!name || !pub) die('uso: munder-reviver cliente autorizar NOMBRE LLAVE_PUBLICA');
    const c = R.authorizeClient(dir, name, pub);
    say(`autorizado «${c.name}» (${c.client_id})`);
    return;
  }
  if (sub === 'quitar') {
    const c = R.revokeClient(dir, rest[0] || die('uso: munder-reviver cliente quitar ID|NOMBRE'));
    if (!c) die(`no hay cliente «${rest[0]}»`);
    say(`quitado «${c.name}» (${c.client_id})`);
    return;
  }
  die('uso: munder-reviver cliente nuevo|autorizar|quitar …');
}

function cmdClients() {
  const clients = R.loadClients(R.stateDir());
  const rows = Object.entries(clients);
  if (!rows.length) { console.log('(sin clientes)'); return; }
  for (const [id, c] of rows) console.log(`${id}  ${c.name}${c.local ? ' (esta máquina)' : ''}  desde ${c.added_at}`);
}

// ─── OS integration ──────────────────────────────────────────────────────────
function nodeInvocation() {
  // Packaged installs have no node: Electron runs this file as node.
  const env = {};
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  if (process.env.MUNDER_REVIVER_DIR) env.MUNDER_REVIVER_DIR = process.env.MUNDER_REVIVER_DIR;
  if (process.env.MUNDER_STATE_DIR) env.MUNDER_STATE_DIR = process.env.MUNDER_STATE_DIR;
  return { exe: process.execPath, script: __filename, env };
}

function systemdUnit() {
  const n = nodeInvocation();
  const q = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;
  return [
    '[Unit]',
    'Description=Munder Reviver (arranca y revive Munder)',
    'Documentation=https://github.com/DannyBaanks/munder-difflin/blob/main/tools/munder/REVIVER.md',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${q(n.exe)} ${q(n.script)} servir`,
    ...Object.entries(n.env).map(([k, v]) => `Environment=${q(`${k}=${v}`)}`),
    'Restart=on-failure',
    'RestartSec=5',
    // Only the reviver belongs to this unit's lifetime: restarting or stopping
    // the reviver must never take the Munder it launched down with it.
    'KillMode=process',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function windowsTaskXml(vbs) {
  const user = `${process.env.USERDOMAIN || os.hostname()}\\${process.env.USERNAME || os.userInfo().username}`;
  const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Munder Reviver: arranca y revive Munder aunque Munder se caiga.</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${x(user)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${x(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>${x(`//B //NoLogo "${vbs}"`)}</Arguments></Exec></Actions>
</Task>
`;
}

function windowsLauncherVbs() {
  // Hidden window (0) and WAIT for node (True): if the reviver dies, the task
  // sees the failure and RestartOnFailure brings it back.
  const n = nodeInvocation();
  const v = (s) => String(s).replace(/"/g, '""');
  return [
    'Set sh = CreateObject("WScript.Shell")',
    'Set env = sh.Environment("Process")',
    ...Object.entries(n.env).map(([k, val]) => `env("${k}") = "${v(val)}"`),
    `rc = sh.Run("""${v(n.exe)}"" ""${v(n.script)}"" servir", 0, True)`,
    'WScript.Quit rc',
    '',
  ].join('\r\n');
}

const TASK_NAME = 'Munder Reviver';

function cmdInstall(f) {
  const dir = R.stateDir();
  try { R.loadConfig(dir); } catch (e) { die(`${e.message}\nPrimero: munder-reviver init`); }
  if (process.platform === 'linux') {
    const unitDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');
    const unit = path.join(unitDir, 'munder-reviver.service');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(unit, systemdUnit());
    say(`unidad escrita: ${unit}`);
    if (f['solo-archivos']) return;
    for (const args of [['--user', 'daemon-reload'], ['--user', 'enable', '--now', 'munder-reviver.service']]) {
      const r = spawnSync('systemctl', args, { stdio: 'inherit' });
      if (r.status !== 0) die(`systemctl ${args.join(' ')} falló`);
    }
    say('instalado y corriendo (systemctl --user status munder-reviver). Para que siga vivo sin sesión abierta: loginctl enable-linger');
    return;
  }
  if (process.platform === 'win32') {
    const vbs = path.join(dir, 'reviver-launch.vbs');
    const xml = path.join(dir, 'reviver-task.xml');
    fs.writeFileSync(vbs, windowsLauncherVbs());
    fs.writeFileSync(xml, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(windowsTaskXml(vbs), 'utf16le')]));
    say(`tarea escrita: ${xml}`);
    if (f['solo-archivos']) return;
    let r = spawnSync('schtasks', ['/Create', '/F', '/TN', TASK_NAME, '/XML', xml], { stdio: 'inherit', windowsHide: true });
    if (r.status !== 0) die('schtasks /Create falló');
    r = spawnSync('schtasks', ['/Run', '/TN', TASK_NAME], { stdio: 'inherit', windowsHide: true });
    if (r.status !== 0) die('schtasks /Run falló');
    say(`instalado como tarea «${TASK_NAME}» (arranca al iniciar sesión y se reinicia si se cae)`);
    return;
  }
  die(`instalar no está soportado en ${process.platform}: corre munder-reviver servir con tu supervisor`);
}

function cmdUninstall() {
  if (process.platform === 'linux') {
    spawnSync('systemctl', ['--user', 'disable', '--now', 'munder-reviver.service'], { stdio: 'inherit' });
    const unit = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user', 'munder-reviver.service');
    try { fs.unlinkSync(unit); } catch { /* gone */ }
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
    say('desinstalado (Munder, si corre, sigue corriendo)');
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('schtasks', ['/End', '/TN', TASK_NAME], { stdio: 'inherit', windowsHide: true });
    spawnSync('schtasks', ['/Delete', '/F', '/TN', TASK_NAME], { stdio: 'inherit', windowsHide: true });
    say('desinstalado (Munder, si corre, sigue corriendo)');
    return;
  }
  die(`no hay nada que desinstalar en ${process.platform}`);
}

const HELP = `munder-reviver — arranca y revive Munder aunque Munder esté muerto

  init [--app DIR | --exe RUTA --arg A …] [--user-data DIR] [--bind IP] [--port N] [--autostart] [--force]
  servir                  el daemon, en primer plano (lo que corre el servicio)
  instalar | desinstalar  systemd --user (Linux) o tarea al iniciar sesión (Windows)

  status | start | restart | stop | recibos   [--json]
  cliente nuevo NOMBRE [--direccion HOST:PUERTO] [--salida ARCHIVO]
  cliente autorizar NOMBRE LLAVE_PUBLICA
  cliente quitar ID|NOMBRE
  clientes
  llamar CREDENCIAL OPERACION [--direccion HOST:PUERTO]   desde otra máquina

Solo hace status, start, restart y stop de UN Munder configurado en init.
Nunca ejecuta comandos, rutas ni argumentos que mande quien llama.
Guía: tools/munder/REVIVER.md`;

async function main(argv) {
  const [cmd, ...rest] = argv;
  const f = flags(rest);
  if (!cmd || cmd === 'ayuda' || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(HELP); return; }
  if (cmd === 'init') return cmdInit(f);
  if (cmd === 'servir' || cmd === 'serve') return cmdServe();
  if (cmd === 'instalar' || cmd === 'install') return cmdInstall(f);
  if (cmd === 'desinstalar' || cmd === 'uninstall') return cmdUninstall();
  if (cmd === 'cliente') return cmdClient(f._[0], f._.slice(1), f);
  if (cmd === 'clientes') return cmdClients();
  if (cmd === 'llamar') {
    const [cred, op] = f._;
    if (!cred || !OP_ALIASES[op]) die('uso: munder-reviver llamar CREDENCIAL status|start|restart|stop|recibos');
    return cmdRemote(cred, OP_ALIASES[op], f);
  }
  if (OP_ALIASES[cmd]) return cmdOp(OP_ALIASES[cmd], f);
  die(`comando desconocido: ${cmd}\n\n${HELP}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => die(e && e.message ? e.message : String(e)));
}

module.exports = { main, systemdUnit, windowsTaskXml, windowsLauncherVbs, flags };
