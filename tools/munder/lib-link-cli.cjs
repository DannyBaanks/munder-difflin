'use strict';
/**
 * `munder link …` — the human side of Munder Link (lib-link.cjs is the engine).
 * Spanish subcommands like the rest of the CLI, English aliases for muscle memory.
 */
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const L = require('./lib-link.cjs');

const HELP = `munder link — enlaza oficinas (Michael ↔ Michael) por tu red o por Tailscale

  munder link conectar          Todo en uno: enciende, busca oficinas y empareja
  munder link                   Estado: esta oficina, las enlazadas y solicitudes
  munder link encender | apagar Servidor del enlace en segundo plano (puerto ${L.DEFAULT_PORT})
  munder link servir            El servidor en primer plano (para ver qué pasa)
  munder link buscar            Oficinas en tu red y en Tailscale (no confía en nadie)
  munder link emparejar <ip|nombre>
                                Pide enlazarse; ambas pantallas muestran un código
  munder link aceptar [código]  En la otra máquina: acepta si el código coincide
  munder link enviar <oficina> "tarea" [--titulo X] [--prioridad N]
                                Delega trabajo; su Michael decide cómo hacerlo
  munder link responder <oficina> <origin_ref> "texto" [--resultado X] [--estado N]
                                Contesta una tarea delegada, por su origin_ref
  munder link tarea <oficina> <task_id>
  munder link mensaje <oficina> <task_id> "texto"
  munder link cancelar <oficina> <task_id> [motivo]
  munder link olvidar <oficina|celular>
                                Quita la confianza en esa oficina o celular
  munder link panel <celular> [--quitar]
                                Deja que ese celular maneje la computadora
                                (los botones del Panel), no solo la oficina
  munder link celular           Maneja esta oficina desde el celular (Munder Remote)
  munder link nombre <nuevo>    Cambia el nombre de esta oficina

Guía: tools/munder/LINK.md`;

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

function daemonPid() {
  try {
    const pid = Number(fs.readFileSync(L.files().pid, 'utf8').trim());
    if (pid > 0) { process.kill(pid, 0); return pid; }
  } catch { /* not running */ }
  return null;
}

function looksLikeAddress(s) {
  return /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(s) || /^\[[0-9a-f:]+\](:\d+)?$/i.test(s) || /\.(local|ts\.net|lan)$/i.test(s.replace(/:\d+$/, '')) || /:\d+$/.test(s);
}

async function runLink(args, h) {
  const { say, die, st, C, select, ask, IS_TTY, scriptPath, version } = h;
  const sub = (args.shift() || 'estado').toLowerCase();
  const yes = args.includes('--si') || args.includes('--yes');
  const rest = args.filter((a) => a !== '--si' && a !== '--yes');

  const fail = (e) => die(e && e.message ? e.message : String(e));

  const confirm = async (q) => {
    if (yes) return true;
    if (!IS_TTY) die(`${q} — sin terminal interactiva: repite con --si`);
    const a = (await ask(`${q} [s/N] `)).trim().toLowerCase();
    return a === 's' || a === 'si' || a === 'sí' || a === 'y' || a === 'yes';
  };

  const startDaemon = () => {
    const pid = daemonPid();
    if (pid) return pid;
    const f = L.files();
    fs.mkdirSync(L.stateDir(), { recursive: true, mode: 0o700 });
    const out = fs.openSync(f.log, 'a');
    const child = spawn(process.execPath, [scriptPath, 'link', 'servir'], { detached: true, stdio: ['ignore', out, out], env: process.env });
    child.unref();
    fs.writeFileSync(f.pid, String(child.pid));
    return child.pid;
  };

  const printCard = (o, extra = '') => {
    const cap = o.capacity || {};
    const ram = cap.ram_total_gb ? `${cap.ram_total_gb} GB RAM` : '';
    console.log(`  ${st(o.name, C.bold)}  ${st(L.prettyFingerprint(o.office_id), C.dim)}  ${o.address || ''}  ${ram}  ${o.via ? st(o.via, C.cyan) : ''} ${extra}`);
  };

  const pairWith = async (target) => {
    let address = target;
    if (!looksLikeAddress(target)) {
      say(`buscando «${target}» en tu red y en Tailscale…`);
      const found = await discoverAll();
      const q = target.toLowerCase();
      const m = found.filter((o) => o.name.toLowerCase().includes(q) || o.office_id.startsWith(q));
      if (m.length !== 1) die(m.length ? `hay varias oficinas que coinciden con «${target}»; usa su IP` : `no encontré «${target}». ¿Está encendido su enlace? (munder link encender)`);
      address = m[0].address;
    }
    const me = L.loadIdentity();
    const { peer, code } = await L.requestPair(address, { port: L.DEFAULT_PORT });
    console.log('');
    console.log(`  Emparejando ${st(me.name, C.bold)} → ${st(peer.name, C.bold)}  (${address})`);
    console.log(`  Huella de ${peer.name}: ${L.prettyFingerprint(peer.office_id)}`);
    console.log('');
    console.log(`  Código:  ${st(code.replace(/(\d{3})(\d{3})/, '$1 $2'), C.bold, C.green)}`);
    console.log('');
    console.log(`  En ${peer.name} corre:  ${st('munder link aceptar', C.cyan)}  y revisa que muestre este mismo código.`);
    if (!(await confirm('¿Coincide el código en la otra pantalla?'))) die('emparejamiento cancelado: no confíes en una oficina cuyo código no coincide');
    L.trustPeer(peer);
    say(`listo de este lado. Cuando ${peer.name} acepte, prueba: munder link enviar ${peer.name.replace(/^michael-/, '')} "hola"`);
  };

  const discoverAll = async () => {
    const [lan, ts] = await Promise.all([L.discoverLan(), L.discoverTailscale()]);
    const seen = new Map();
    for (const o of [...lan, ...ts.offices]) if (!seen.has(o.office_id)) seen.set(o.office_id, o);
    return [...seen.values()];
  };

  try {
    switch (sub) {
      case 'estado': case 'status': {
        const me = L.loadIdentity();
        const pid = daemonPid();
        console.log(st('ESTA OFICINA', C.bold));
        console.log(`  ${st(me.name, C.bold)}  ${st(L.prettyFingerprint(me.office_id), C.dim)}`);
        console.log(`  enlace: ${pid ? st(`encendido (pid ${pid}, puerto ${L.DEFAULT_PORT})`, C.green) : st('apagado — munder link encender', C.yellow)}`);
        console.log(`  hive: ${L.localHiveRoot() || st('no encontrado (abre Munder una vez)', C.yellow)}`);
        const cap = L.capacity(null);
        console.log(`  ${cap.ram_total_gb} GB RAM (${cap.ram_free_gb} libres) · ${cap.cpus} CPUs · carga ${cap.load1}`);
        const peers = Object.values(L.loadPeers());
        console.log('');
        console.log(st('ENLAZADAS', C.bold));
        if (!peers.length) console.log(st('  ninguna todavía — munder link conectar', C.dim));
        const results = await Promise.all(peers.map((p) => L.call(p.office_id, 'status', {}, { timeoutMs: 3000 }).then((r) => ({ p, r }), (e) => ({ p, e }))));
        for (const { p, r, e } of results) {
          if (r) {
            const c = r.result.capacity;
            console.log(`  ${st('●', C.green)} ${st(p.name, C.bold)}  en línea  ${c.workers_idle ?? '?'}/${c.workers_total ?? '?'} workers libres  ${c.ram_free_gb}/${c.ram_total_gb} GB  Michael: ${c.michael_state}  ${r.latency_ms} ms  ${st(r.address, C.dim)}`);
          } else {
            const why = e.code === 'unknown_peer' ? 'esperando que acepte (munder link aceptar allá)' : e.message;
            console.log(`  ${st('○', C.red)} ${st(p.name, C.bold)}  ${why}  ${st(p.addresses.join(' '), C.dim)}`);
          }
        }
        const pending = Object.values(L.loadPending());
        if (pending.length) {
          console.log('');
          console.log(st('SOLICITUDES', C.bold));
          for (const q of pending) console.log(`  ${q.name}${q.kind === 'remote' ? ' (celular)' : ''}  ${L.prettyFingerprint(q.office_id)}  código ${q.code}  → munder link aceptar ${q.code}`);
        }
        break;
      }
      case 'encender': case 'on': case 'start': {
        const pid = startDaemon();
        say(`enlace encendido (pid ${pid}). Escucha en el puerto ${L.DEFAULT_PORT}/tcp y ${L.DISCOVERY_PORT}/udp.`);
        break;
      }
      case 'apagar': case 'off': case 'stop': {
        const pid = daemonPid();
        if (!pid) { say('el enlace ya estaba apagado'); break; }
        process.kill(pid, 'SIGTERM');
        try { fs.unlinkSync(L.files().pid); } catch { /* gone */ }
        say(`enlace apagado (pid ${pid})`);
        break;
      }
      case 'servir': case 'serve': {
        const { server, identity } = L.createLinkServer({ version });
        const udp = L.createDiscoveryResponder({ version });
        server.listen(L.DEFAULT_PORT, '0.0.0.0', () => {
          say(`${identity.name} (${L.prettyFingerprint(identity.office_id)}) escuchando en 0.0.0.0:${L.DEFAULT_PORT}; hive: ${L.localHiveRoot() || '—'}`);
        });
        server.on('error', (e) => die(e.code === 'EADDRINUSE' ? `el puerto ${L.DEFAULT_PORT} está ocupado (¿ya está encendido? munder link apagar)` : e.message));
        const bye = () => { udp.close(); server.close(() => process.exit(0)); };
        process.on('SIGTERM', bye);
        process.on('SIGINT', bye);
        return new Promise(() => {}); // run until killed
      }
      case 'buscar': case 'discover': {
        say('buscando oficinas (red local + Tailscale)…');
        const [lan, ts] = await Promise.all([L.discoverLan(), L.discoverTailscale()]);
        const peers = L.loadPeers();
        const all = [...lan, ...ts.offices];
        if (!all.length) {
          console.log(st('  nada. En la otra máquina: munder link encender. Si sigue sin aparecer, revisa el firewall (47831/tcp, 47832/udp).', C.dim));
        }
        for (const o of all) printCard(o, peers[o.office_id] ? st('(ya enlazada)', C.green) : '');
        if (!ts.available) console.log(st('  (Tailscale no está instalado o no responde: solo busqué en la red local)', C.dim));
        break;
      }
      case 'emparejar': case 'pair': {
        if (!rest[0]) die('uso: munder link emparejar <ip|nombre>');
        await pairWith(rest[0]);
        break;
      }
      case 'conectar': case 'connect': {
        const pid = startDaemon();
        say(`enlace encendido (pid ${pid}); buscando oficinas…`);
        const peers = L.loadPeers();
        const found = (await discoverAll()).filter((o) => !peers[o.office_id]);
        if (!found.length) die('no encontré oficinas nuevas. En la otra máquina corre «munder link encender» (o «munder link conectar») y vuelve a intentar.');
        let pick = found[0];
        if (found.length > 1) {
          if (!IS_TTY) die('hay varias oficinas; elige una con: munder link emparejar <ip>');
          const i = await select('¿Con cuál oficina te enlazas?', found.map((o) => ({ label: `${o.name}  ${o.address}  ${o.capacity ? o.capacity.ram_total_gb + ' GB' : ''}  ${o.via}`, value: o.office_id })));
          if (i < 0) die('cancelado');
          pick = found[i];
        }
        await pairWith(pick.address);
        break;
      }
      case 'aceptar': case 'accept': {
        const pending = Object.values(L.loadPending());
        if (!pending.length) { say('no hay solicitudes pendientes (duran 10 minutos)'); break; }
        let code = rest[0];
        if (!code) {
          for (const q of pending) console.log(`  ${st(q.name, C.bold)}${q.kind === 'remote' ? ' (celular)' : ''}  ${L.prettyFingerprint(q.office_id)}  desde ${q.addresses.join(' ') || '?'}  código ${st(q.code.replace(/(\d{3})(\d{3})/, '$1 $2'), C.bold, C.green)}`);
          if (!IS_TTY) die('escribe el código: munder link aceptar <código>');
          code = (await ask('Escribe el código que ves en la OTRA pantalla: ')).replace(/\s/g, '');
        }
        const p = L.acceptPending(code.replace(/\s/g, ''));
        if (!p) die('ese código no coincide con ninguna solicitud. Si no lo esperabas, no aceptes nada.');
        if (p.kind === 'remote') say(`celular ${p.name} (${L.prettyFingerprint(p.office_id)}) emparejado. Ya puede manejar esta oficina.`);
        else say(`enlazada con ${p.name} (${L.prettyFingerprint(p.office_id)}). Ya puede delegarte trabajo.`);
        break;
      }
      case 'enviar': case 'send': {
        const title = flag(rest, '--titulo') ?? flag(rest, '--title');
        const prio = flag(rest, '--prioridad') ?? flag(rest, '--priority');
        const [who, ...words] = rest;
        const compose = words.join(' ').trim();
        if (!who || !compose) die('uso: munder link enviar <oficina> "tarea"');
        const r = await L.delegate(who, compose, { title, priority: prio ? Number(prio) : undefined });
        say(`delegada a ${r.peer.name} en ${r.latency_ms} ms → ${r.result.task_id}`);
        console.log(st(`  sigue: munder link tarea ${who} ${r.result.task_id}`, C.dim));
        break;
      }
      case 'responder': case 'reply': {
        const done = flag(rest, '--resultado') ?? flag(rest, '--result');
        const status = flag(rest, '--estado') ?? flag(rest, '--status');
        const [who, ref, ...words] = rest;
        const text = words.join(' ').trim();
        if (!who || !ref || (!text && !done)) die('uso: munder link responder <oficina> <origin_ref> "texto" [--resultado X]');
        const r = await L.reply(who, ref, { text, result: done, status });
        say(`respuesta entregada a ${r.peer.name} en ${r.latency_ms} ms → ${r.result.task_id}${r.result.status ? ` (${r.result.status})` : ''}`);
        break;
      }
      case 'tarea': case 'task': {
        const [who, id] = rest;
        if (!who || !id) die('uso: munder link tarea <oficina> <task_id>');
        const r = await L.call(who, 'get', { task_id: id });
        const t = r.result;
        console.log(`  ${st(t.title, C.bold)}  ${t.status}${t.assignee ? `  (${t.assignee})` : ''}`);
        if (t.result) console.log(`  resultado: ${t.result}`);
        if (t.origin_ref) console.log(st(`  origin_ref: ${t.origin_ref}`, C.dim));
        break;
      }
      case 'mensaje': case 'message': {
        const [who, id, ...words] = rest;
        if (!who || !id || !words.length) die('uso: munder link mensaje <oficina> <task_id> "texto"');
        await L.call(who, 'message', { task_id: id, message: words.join(' ') });
        say('mensaje entregado a su Michael');
        break;
      }
      case 'cancelar': case 'cancel': {
        const [who, id, ...words] = rest;
        if (!who || !id) die('uso: munder link cancelar <oficina> <task_id> [motivo]');
        await L.call(who, 'cancel', { task_id: id, reason: words.join(' ') });
        say('cancelación pedida; su Michael la hará de forma segura');
        break;
      }
      case 'olvidar': case 'forget': {
        if (!rest[0]) die('uso: munder link olvidar <oficina|celular>');
        const p = L.forgetPeer(rest[0]);
        if (p) { say(`olvidada: ${p.name}. Para volver a enlazarla hay que emparejar de nuevo.`); break; }
        const phone = L.forgetRemote(rest[0]);
        if (!phone) die(`no hay una oficina ni un celular «${rest[0]}»`);
        say(`celular olvidado: ${phone.name}. Deja de funcionar en su siguiente llamada.`);
        break;
      }
      case 'panel': case 'botones': {
        if (!rest[0]) die('uso: munder link panel <celular> [--quitar]');
        const off = rest.includes('--quitar') || rest.includes('--off');
        const r = L.setRemoteAuthority(rest[0], off ? L.REMOTE_AUTHORITY.OFFICE : L.REMOTE_AUTHORITY.MACHINE);
        if (!r) die(`no hay un celular emparejado «${rest[0]}»`);
        say(r.authority === L.REMOTE_AUTHORITY.MACHINE
          ? `celular «${r.name}» ya puede manejar la computadora: abrir y cerrar Munder, el enlace y GPT.`
          : `celular «${r.name}» vuelve a manejar solo la oficina.`);
        if (!off) console.log(st('  con esto ese celular puede apagar tu Munder. Quitar: munder link panel ' + r.device_id + ' --quitar', C.dim));
        break;
      }
      case 'celular': case 'phone': case 'remote': {
        const pid = daemonPid();
        console.log(st('MUNDER REMOTE', C.bold) + st('  — esta oficina desde el celular', C.dim));
        if (!pid) console.log(`  ${st('el enlace está apagado — munder link encender', C.yellow)}`);
        const urls = L.appUrls();
        if (!urls.length) console.log(st('  esta máquina no tiene dirección de red local ni de Tailscale', C.yellow));
        for (const u of urls) console.log(`  ${st(u.url, C.cyan)}  ${st(u.via === 'tailscale' ? 'Tailscale (también fuera de casa)' : `red de casa (${u.ifname})`, C.dim)}`);
        console.log('');
        console.log('  1. Ábrela en Safari y toca Compartir → «Agregar a inicio».');
        console.log('  2. Abre Munder desde el ícono y toca «Emparejar».');
        console.log(`  3. Aquí: ${st('munder link aceptar', C.cyan)} si el código coincide con el del celular.`);
        console.log(st('  Mejor por Tailscale: por el Wi-Fi de casa la página misma no va firmada.', C.dim));
        const phones = Object.values(L.loadRemotes());
        console.log('');
        console.log(st('CELULARES', C.bold));
        if (!phones.length) console.log(st('  ninguno todavía', C.dim));
        for (const r of phones) console.log(`  ${st(r.name, C.bold)}  ${L.prettyFingerprint(r.device_id)}  ${st(`desde ${String(r.paired_at || '').slice(0, 10)}`, C.dim)}  → munder link olvidar ${r.device_id}`);
        break;
      }
      case 'nombre': case 'name': {
        if (!rest[0]) die('uso: munder link nombre <nuevo>');
        const me = L.loadIdentity(undefined, rest.join('-').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40));
        say(`esta oficina ahora se llama ${me.name}. Las ya enlazadas la siguen conociendo por su huella.`);
        break;
      }
      case 'help': case 'ayuda': case '--help': case '-h':
        console.log(HELP);
        break;
      default:
        die(`subcomando desconocido «${sub}». munder link ayuda`);
    }
  } catch (e) { fail(e); }
}

module.exports = { runLink, HELP };
