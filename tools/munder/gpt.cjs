#!/usr/bin/env node
'use strict';
/**
 * munder gpt: the operator's side of the ChatGPT principal (lib-gpt.cjs).
 *
 *   munder gpt                       estado + menú (con TTY)
 *   munder gpt perfil lectura|operador|full [--si]
 *   munder gpt capacidades [perfil]
 *   munder gpt encender [--transporte local|ngrok|cloudflared|manual] [--dominio D] [--url U] [--puerto N]
 *   munder gpt apagar
 *   munder gpt estado
 *   munder gpt solicitudes           accesos que ChatGPT está pidiendo
 *   munder gpt aprobar CÓDIGO        el código de 6 dígitos que muestra la página de autorización
 *   munder gpt rechazar CÓDIGO
 *   munder gpt permisos              permisos vivos (uno por ChatGPT conectado)
 *   munder gpt revocar ID|CLIENTE|todo
 *   munder gpt auditoria [N]
 *   munder gpt buzon                 lo que Michael le mandó a GPT
 *   munder gpt reviver               darle a GPT su propia llave del Reviver
 */
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const G = require('./lib-gpt.cjs');

const say = (m) => console.log(`munder gpt: ${m}`);
const die = (m, code = 1) => { console.error(`munder gpt: ${m}`); process.exit(code); };
const IS_TTY = !!process.stdin.isTTY && !!process.stdout.isTTY;

function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    if (['si', 'yes', 'json'].includes(k)) { out[k] = true; continue; }
    const v = inline !== undefined ? inline : args[++i];
    if (v === undefined) die(`--${k} necesita un valor`);
    out[k] = v;
  }
  return out;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readPid = (f) => { try { const n = Number(fs.readFileSync(f, 'utf8').trim()); return n > 0 ? n : null; } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health(url, ms = 4000) {
  try {
    const r = await fetch(`${url.replace(/\/+$/, '')}/health`, { headers: { 'ngrok-skip-browser-warning': '1', 'user-agent': 'munder-gpt-cli' }, signal: AbortSignal.timeout(ms) });
    const j = await r.json().catch(() => ({}));
    return r.ok && j.service === 'munder-gpt' ? j : null;
  } catch { return null; }
}

function printProfile(profile) {
  const d = G.describeProfile(profile);
  console.log(`Perfil ${d.profile.toUpperCase()}`);
  for (const s of d.scopes) console.log(`  ${s.scope.padEnd(15)} ${s.what}`);
  console.log(`\nHerramientas que verá ChatGPT (${d.tools.length}):`);
  for (const t of d.tools) console.log(`  ${t.mutating ? '✎' : '·'} ${t.name.padEnd(22)} ${t.title}`);
  console.log('\nNunca, con ningún perfil:');
  for (const [k, v] of Object.entries(d.never)) console.log(`  ✗ ${k}: ${v}`);
}

function ask(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); resolve(a.trim()); });
  });
}

async function cmdProfile(f) {
  const name = f._[0];
  if (!name) { printProfile(G.loadConfig().profile); return; }
  const profile = G.profileName(name);
  printProfile(profile);
  if (!f.si) {
    if (!IS_TTY) die('confirma con --si (sin terminal interactiva no pregunto)');
    const a = await ask(`\n¿Darle a ChatGPT el perfil ${profile.toUpperCase()}? (s/n) `);
    if (!/^s/i.test(a)) { say('sin cambios'); return; }
  }
  const before = G.loadConfig().profile;
  G.saveConfig(G.stateDir(), { profile });
  G.audit(G.stateDir(), { event: 'profile_changed', from: before, to: profile, by: 'operator' });
  say(`perfil: ${profile.toUpperCase()}. Aplica ya: un permiso nunca excede el perfil actual.`);
}

// ─── transport ───────────────────────────────────────────────────────────────
async function startTransport(dir, config, f) {
  const provider = f.transporte || (config.transport && config.transport.provider) || 'local';
  const port = config.port;
  const stopOld = () => { const pid = readPid(G.files(dir).transportPid); if (pid && alive(pid)) { try { process.kill(pid); } catch { /* gone */ } } };
  if (provider === 'local') {
    stopOld();
    return { provider, public_url: `http://127.0.0.1:${port}` };
  }
  if (provider === 'manual') {
    const url = f.url || config.public_url;
    if (!url || !/^https:\/\//.test(url)) die('con --transporte manual pasa --url https://… (tu reverse proxy o Tailscale Funnel apuntando a 127.0.0.1:' + port + ')');
    stopOld();
    return { provider, public_url: url.replace(/\/+$/, '') };
  }
  const logFile = G.files(dir).transportLog;
  if (provider === 'ngrok') {
    const domain = (f.dominio || (config.transport && config.transport.domain) || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!domain) die('con ngrok pasa --dominio tu-dominio.ngrok-free.dev (un dominio estático de tu cuenta; no uses el del EVO Gateway)');
    stopOld();
    const out = fs.openSync(logFile, 'w');
    const child = spawn('ngrok', ['http', `--url=https://${domain}`, `http://127.0.0.1:${port}`, '--log=stdout'], { detached: true, stdio: ['ignore', out, out], windowsHide: true });
    await new Promise((r) => { child.once('error', (e) => die(`no pude lanzar ngrok: ${e.code === 'ENOENT' ? 'no está instalado' : e.message}`)); child.once('spawn', r); });
    child.unref();
    fs.writeFileSync(G.files(dir).transportPid, String(child.pid));
    return { provider, domain, public_url: `https://${domain}` };
  }
  if (provider === 'cloudflared') {
    stopOld();
    const out = fs.openSync(logFile, 'w');
    const child = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`], { detached: true, stdio: ['ignore', out, out], windowsHide: true });
    await new Promise((r) => { child.once('error', (e) => die(`no pude lanzar cloudflared: ${e.code === 'ENOENT' ? 'no está instalado' : e.message}`)); child.once('spawn', r); });
    child.unref();
    fs.writeFileSync(G.files(dir).transportPid, String(child.pid));
    for (let i = 0; i < 40; i++) {
      const m = (fs.readFileSync(logFile, 'utf8').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/) || [])[0];
      if (m) { say('AVISO: la URL de trycloudflare cambia en cada arranque; para una fija usa ngrok o manual'); return { provider, public_url: m }; }
      await sleep(500);
    }
    die(`cloudflared no dio URL (ver ${logFile})`);
  }
  die(`transporte desconocido: ${provider} (local, ngrok, cloudflared, manual)`);
}

async function cmdOn(f) {
  const dir = G.stateDir();
  let config = G.loadConfig(dir);
  if (f.puerto) config = G.saveConfig(dir, { port: Number(f.puerto) });
  const inbox = G.ensureInbox();
  if (!inbox) say('AVISO: no encuentro el hive de esta oficina (abre Munder una vez); sin buzón de GPT hasta entonces');
  // 1. the gateway (loopback)
  let pid = readPid(G.files(dir).pid);
  if (!(pid && alive(pid) && await health(`http://127.0.0.1:${config.port}`, 1500))) {
    const out = fs.openSync(G.files(dir).log, 'a');
    const env = { ...process.env };
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    const child = spawn(process.execPath, [path.join(__dirname, 'gpt-serve.cjs')], { detached: true, stdio: ['ignore', out, out], windowsHide: true, env });
    child.unref();
    pid = child.pid;
    for (let i = 0; i < 40 && !(await health(`http://127.0.0.1:${config.port}`, 500)); i++) await sleep(250);
    if (!(await health(`http://127.0.0.1:${config.port}`, 1500))) die(`el gateway no arrancó (ver ${G.files(dir).log})`);
  }
  // 2. the transport, then enable: OAuth metadata must already name the public URL
  const t = await startTransport(dir, config, f);
  config = G.saveConfig(dir, { enabled: true, public_url: t.public_url, transport: { provider: t.provider, ...(t.domain ? { domain: t.domain } : {}) } });
  G.audit(dir, { event: 'gateway_enabled', transport: t.provider, public_url: t.public_url, profile: config.profile });
  // 3. prove the public URL reaches THIS gateway
  let reach = null;
  for (let i = 0; i < 30 && !reach; i++) { reach = await health(t.public_url, 4000); if (!reach) await sleep(1000); }
  printReady(config, t, !!reach);
  if (!reach) process.exitCode = 2;
}

function printReady(config, t, reachable) {
  const grants = Object.values(G.loadGrants(G.stateDir())).filter((g) => !g.revoked_at && Date.parse(g.expires_at) > Date.now());
  console.log('\nMUNDER GPT\n');
  console.log(`Principal:  ${G.PRINCIPAL}`);
  console.log(`Autoridad:  ${config.profile.toUpperCase()} (${G.PROFILES[config.profile].join(' ')})`);
  console.log(`OAuth:      listo (registro dinámico + PKCE + tu aprobación en esta terminal)`);
  console.log(`Gateway:    corriendo en 127.0.0.1:${config.port}`);
  console.log(`Transporte: ${t.provider}${reachable ? '' : '  (¡la URL pública NO respondió!)'}`);
  console.log(`Endpoint:   ${t.public_url}`);
  console.log(`Permisos:   ${grants.length} activo(s)`);
  console.log('\nConexión en ChatGPT (Settings → Apps & Connectors → Advanced → Developer mode → Create):');
  console.log(`  MCP Server URL: ${t.public_url}/mcp`);
  console.log('  Authentication: OAuth');
  console.log('  Al conectar, ChatGPT abre una página con un código de 6 dígitos:');
  console.log('  apruébalo aquí con  munder gpt aprobar <código>');
  if (t.provider === 'local') console.log('\n(transporte local: solo para probar en esta máquina; ChatGPT necesita una URL https pública)');
}

function cmdOff() {
  const dir = G.stateDir();
  G.saveConfig(dir, { enabled: false });
  for (const f of [G.files(dir).transportPid, G.files(dir).pid]) {
    const pid = readPid(f);
    if (pid && alive(pid)) { try { process.kill(pid); } catch { /* gone */ } }
    try { fs.unlinkSync(f); } catch { /* none */ }
  }
  G.audit(dir, { event: 'gateway_disabled', by: 'operator' });
  say('apagado. Los permisos siguen guardados (revócalos con munder gpt revocar todo); el hive y Link no se tocan.');
}

async function cmdStatus(f) {
  const dir = G.stateDir();
  const c = G.loadConfig(dir);
  const pid = readPid(G.files(dir).pid);
  const local = pid && alive(pid) ? await health(`http://127.0.0.1:${c.port}`, 1500) : null;
  const pub = c.public_url && c.enabled ? await health(c.public_url, 4000) : null;
  const grants = Object.entries(G.loadGrants(dir)).map(([id, g]) => G.publicGrant(id, g));
  const pending = G.pendingRequests(dir);
  let inbox = [];
  try { inbox = G.inboxMessages(false); } catch { /* no hive */ }
  const out = {
    principal: G.PRINCIPAL, profile: c.profile, scopes: G.PROFILES[c.profile], enabled: c.enabled,
    gateway: { running: !!local, pid: local ? pid : null, local: `http://127.0.0.1:${c.port}` },
    transport: c.transport, public_url: c.public_url, public_reachable: !!pub,
    grants: grants.filter((g) => g.active), pending, inbox_unread: inbox.length,
  };
  if (f.json) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log(`MUNDER GPT · principal ${G.PRINCIPAL}`);
  console.log(`autoridad:  ${c.profile.toUpperCase()} (${out.scopes.join(' ')})`);
  console.log(`gateway:    ${c.enabled ? 'encendido' : 'apagado'}; proceso ${local ? `vivo (pid ${pid})` : 'parado'} en 127.0.0.1:${c.port}`);
  console.log(`transporte: ${c.transport.provider}${c.public_url ? ` → ${c.public_url}` : ''}${c.enabled ? (pub ? ' (responde)' : ' (NO responde)') : ''}`);
  console.log(`permisos:   ${out.grants.length} activo(s)${out.grants.map((g) => `\n  ${g.grant_id}  ${g.client_name}  ${g.scopes.join(' ')}  caduca ${g.expires_at.slice(0, 10)}${g.last_used_at ? `  usado ${g.last_used_at}` : ''}`).join('')}`);
  if (pending.length) console.log(`solicitudes: ${pending.map((p) => `\n  código ${p.approval_code}  ${p.client_name}  (${p.redirect_host}, ${p.expires_in_s}s)  → munder gpt aprobar ${p.approval_code}`).join('')}`);
  console.log(`buzón:      ${inbox.length} sin leer`);
}

function cmdApprove(f, decision) {
  const code = f._[0] || die(`uso: munder gpt ${decision === 'approve' ? 'aprobar' : 'rechazar'} CÓDIGO`);
  const r = G.approve(G.stateDir(), code, decision);
  if (r.denied) { say(`rechazado: ${r.client_name}`); return; }
  say(`aprobado: ${r.client_name} → permiso ${r.grant_id} (${r.scopes.join(' ')}), caduca ${r.expires_at.slice(0, 10)}. La página de ChatGPT sigue sola.`);
}

function cmdGrants() {
  const grants = Object.entries(G.loadGrants(G.stateDir())).map(([id, g]) => G.publicGrant(id, g));
  if (!grants.length) { console.log('(sin permisos todavía)'); return; }
  for (const g of grants) console.log(`${g.grant_id}  ${g.active ? 'activo  ' : 'inactivo'}  ${g.client_name}  ${g.scopes.join(' ')}  creado ${g.created_at.slice(0, 16)}  caduca ${g.expires_at.slice(0, 10)}${g.revoked_at ? `  revocado ${g.revoked_at.slice(0, 16)}` : ''}`);
}

function cmdRevoke(f) {
  const which = f._[0] || die('uso: munder gpt revocar ID|CLIENTE|todo');
  const hits = G.revoke(G.stateDir(), which);
  say(hits.length ? `revocado: ${hits.join(', ')}. Deja de funcionar desde la siguiente llamada.` : `no había permisos activos que coincidan con «${which}»`);
}

function cmdAudit(f) {
  for (const e of G.readAudit(G.stateDir(), Number(f._[0]) || 30)) {
    const { ts, principal, event, ...rest } = e;
    console.log(`${ts}  ${principal}  ${event}  ${JSON.stringify(rest)}`);
  }
}

function cmdInbox() {
  const msgs = G.inboxMessages(true);
  if (!msgs.length) { console.log('(el buzón de GPT está vacío)'); return; }
  for (const m of msgs) console.log(`${m.read ? '  ' : '● '}${m.created_at}  de ${m.from}  ${m.subject}  [${m.id}]`);
}

function cmdReviver() {
  const R = require('./lib-reviver.cjs');
  let cred;
  try { cred = R.newClientCredential(R.stateDir(), 'gpt'); } catch (e) { die(`${e.message}\nPrimero: munder reviver init`); }
  const f = G.files(G.stateDir()).reviver;
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, JSON.stringify(cred, null, 2) + '\n', { mode: 0o600 });
  say(`GPT tiene su propia llave del Reviver (cliente ${cred.client_id}); sus recibos dirán «gpt». Quítala con: munder reviver cliente quitar gpt`);
}

async function menu() {
  await cmdStatus({ _: [] });
  const items = [
    ['Ver lo que puede hacer ChatGPT', () => printProfile(G.loadConfig().profile)],
    ['Cambiar autoridad (lectura / operador / full)', async () => cmdProfile({ _: [await ask('Perfil (lectura, operador, full): ')] })],
    ['Encender el gateway', async () => cmdOn({ _: [], transporte: (await ask('Transporte (local, ngrok, cloudflared, manual) [' + (G.loadConfig().transport.provider) + ']: ')) || undefined })],
    ['Apagar el gateway', () => cmdOff()],
    ['Aprobar una solicitud de ChatGPT', async () => cmdApprove({ _: [await ask('Código de 6 dígitos: ')] }, 'approve')],
    ['Ver permisos', () => cmdGrants()],
    ['Revocar', async () => cmdRevoke({ _: [await ask('Permiso, cliente o "todo": ')] })],
    ['Auditoría', () => cmdAudit({ _: [] })],
    ['Buzón de GPT', () => cmdInbox()],
  ];
  for (;;) {
    console.log('\n' + items.map(([l], i) => `  ${i + 1}. ${l}`).join('\n') + '\n  0. Salir');
    const n = Number(await ask('> '));
    if (!n) return;
    const item = items[n - 1];
    if (!item) continue;
    try { await item[1](); } catch (e) { console.error(`munder gpt: ${e.message}`); }
  }
}

const HELP = `munder gpt: ChatGPT como principal «gpt» de tu oficina, con la autoridad que tú le das

  munder gpt                        estado y menú
  munder gpt perfil lectura|operador|full [--si]
  munder gpt capacidades [perfil]
  munder gpt encender [--transporte local|ngrok|cloudflared|manual] [--dominio D] [--url U] [--puerto N]
  munder gpt apagar | estado [--json]
  munder gpt solicitudes | aprobar CÓDIGO | rechazar CÓDIGO
  munder gpt permisos | revocar ID|CLIENTE|todo
  munder gpt auditoria [N] | buzon | reviver

La URL solo dice dónde está Munder. Entrar exige OAuth y tu aprobación aquí.
Guía: tools/munder/GPT.md`;

async function main(argv) {
  const [cmd, ...rest] = argv;
  const f = flags(rest);
  if (!cmd) { if (IS_TTY) return menu(); return cmdStatus(f); }
  switch (cmd) {
    case 'help': case 'ayuda': case '--help': case '-h': console.log(HELP); return;
    case 'perfil': case 'profile': return cmdProfile(f);
    case 'capacidades': case 'capabilities': printProfile(f._[0] || G.loadConfig().profile); return;
    case 'encender': case 'on': case 'start': return cmdOn(f);
    case 'apagar': case 'off': case 'stop': return cmdOff();
    case 'estado': case 'status': return cmdStatus(f);
    case 'solicitudes': case 'requests': { const p = G.pendingRequests(G.stateDir()); if (!p.length) console.log('(sin solicitudes pendientes)'); for (const r of p) console.log(`código ${r.approval_code}  ${r.client_name}  ${r.scopes.join(' ')}  (${r.redirect_host}, desde ${r.from_ip}, ${r.expires_in_s}s)`); return; }
    case 'aprobar': case 'approve': return cmdApprove(f, 'approve');
    case 'rechazar': case 'deny': return cmdApprove(f, 'deny');
    case 'permisos': case 'sesiones': case 'grants': return cmdGrants();
    case 'revocar': case 'revoke': return cmdRevoke(f);
    case 'auditoria': case 'auditoría': case 'audit': return cmdAudit(f);
    case 'buzon': case 'buzón': case 'inbox': return cmdInbox();
    case 'reviver': return cmdReviver();
    default: die(`comando desconocido: ${cmd}\n\n${HELP}`);
  }
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => die(e && e.message ? e.message : String(e)));

module.exports = { main, flags };
