/*
 * Munder Remote — the phone app. Plain JS, no build step: the link daemon serves
 * this folder as-is (tools/munder/lib-remote.cjs).
 *
 * Every call to the office is sealed with remote-crypto.js under the key agreed
 * at pairing. Nothing here trusts HTML from the office: text goes in through
 * textContent, and the small markdown subset the ASK ME cards use is rebuilt
 * as DOM nodes.
 */
(function () {
  'use strict';
  const C = window.MunderCrypto;
  const STORE = 'munder-remote@1';
  const REFRESH_MS = 5000;
  const PEERS_MS = 15000;

  // ── storage ────────────────────────────────────────────────────────────────
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { return null; }
  }
  function save(v) {
    try { localStorage.setItem(STORE, JSON.stringify(v)); } catch { /* private mode: pairing lasts this visit */ }
  }
  function wipe() {
    try { localStorage.removeItem(STORE); } catch { /* nothing stored */ }
  }

  let state = load();
  let key = state && state.key ? C.fromB64u(state.key) : null;
  const ui = { tab: 'office', filter: 'blocked', data: null, peers: null, online: true, busy: false, drafts: {} };

  // ── DOM helpers ────────────────────────────────────────────────────────────
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const $app = document.getElementById('app');
  const $toast = document.getElementById('toast');
  let toastTimer = null;
  function toast(text) {
    $toast.textContent = text;
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $toast.hidden = true; }, 2600);
  }

  /** **bold**, `code`, "- " bullets, "1. " lists, blank-line paragraphs. Nothing else. */
  function inline(text) {
    const out = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      out.push(m[0].startsWith('**') ? h('strong', null, m[0].slice(2, -2)) : h('code', null, m[0].slice(1, -1)));
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }
  function markdown(text) {
    const root = h('div', { class: 'md' });
    for (const block of String(text || '').split(/\n\s*\n/)) {
      const lines = block.split('\n').filter((l) => l.trim());
      if (!lines.length) continue;
      const bullets = lines.every((l) => /^\s*[-*]\s+/.test(l));
      const numbered = lines.every((l) => /^\s*\d+[.)]\s+/.test(l));
      if (bullets || numbered) {
        root.append(h(numbered ? 'ol' : 'ul', null, lines.map((l) => h('li', null, inline(l.replace(/^\s*([-*]|\d+[.)])\s+/, ''))))));
      } else {
        const p = h('p');
        lines.forEach((l, i) => { if (i) p.append(h('br')); p.append(...inline(l)); });
        root.append(p);
      }
    }
    return root;
  }

  // Pixel icons: one 12×12 grid each, drawn as whole-pixel rects (crispEdges).
  const ICONS = {
    office: [
      '....####....',
      '...#....#...',
      '..#......#..',
      '.#........#.',
      '############',
      '#..........#',
      '#.##....##.#',
      '#.##....##.#',
      '#..........#',
      '#....##....#',
      '#....##....#',
      '############',
    ],
    ask: [
      '...######...',
      '..##....##..',
      '..##....##..',
      '........##..',
      '.......##...',
      '......##....',
      '.....##.....',
      '.....##.....',
      '............',
      '.....##.....',
      '.....##.....',
      '............',
    ],
    board: [
      '############',
      '#..........#',
      '#.##.##.##.#',
      '#.##.##.##.#',
      '#..........#',
      '#.##.##....#',
      '#.##.##....#',
      '#..........#',
      '############',
      '.#........#.',
      '.#........#.',
      '............',
    ],
    link: [
      '............',
      '.####.......',
      '#....#......',
      '#..#####....',
      '#....#..#...',
      '.####....#..',
      '..#....####.',
      '...#..#....#',
      '....#####..#',
      '......#....#',
      '.......####.',
      '............',
    ],
  };
  function icon(name) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('aria-hidden', 'true');
    ICONS[name].forEach((row, y) => [...row].forEach((ch, x) => {
      if (ch !== '#') return;
      const r = document.createElementNS(ns, 'rect');
      r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', 1); r.setAttribute('height', 1);
      r.setAttribute('fill', 'currentColor');
      svg.append(r);
    }));
    return svg;
  }

  // ── the cast's pixel portraits (same engine as the app: avatar-engine.js) ──
  const A = window.MunderAvatar || null;
  const CAST = A ? Object.keys(A.AVATAR_RECIPES) : [];
  const portraitCache = new Map();
  /** Which cast member an agent looks like: its name, its id, Michael for the boss, else a stable pick. */
  function castOf(agent) {
    if (!A) return null;
    if (!agent) return 'michael';
    if (agent.god) return 'michael';
    for (const raw of [agent.name, agent.id]) {
      const k = String(raw || '').toLowerCase().replace(/^worker-/, '').split(/[^a-z]/)[0];
      if (A.AVATAR_RECIPES[k]) return k;
    }
    const pool = CAST.filter((k) => k !== 'michael');
    let hsh = 0;
    for (const ch of String(agent.id || agent.name || '')) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
    return pool[hsh % pool.length];
  }
  function portrait(who, scale = 2) {
    const c = h('canvas', { class: 'px portrait', width: A ? A.PORTRAIT_W : 18, height: A ? A.PORTRAIT_H : 28, 'aria-hidden': 'true' });
    c.style.width = `${18 * scale}px`;
    c.style.height = `${28 * scale}px`;
    if (A && who) {
      if (!portraitCache.has(who)) portraitCache.set(who, A.composeAvatar(A.AVATAR_RECIPES[who]));
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(portraitCache.get(who)), A.PORTRAIT_W, A.PORTRAIT_H), 0, 0);
    }
    return c;
  }
  const agentById = (d, id) => (d && id ? d.agents.find((a) => a.id === id || a.name.toLowerCase() === String(id).toLowerCase()) : null);

  // ── network ────────────────────────────────────────────────────────────────
  async function postJson(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
    let json = {};
    try { json = await r.json(); } catch { /* not json */ }
    return { status: r.status, body: json };
  }

  class RemoteError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  async function call(op, args) {
    const env = C.sealRequest(key, state.device.id, state.office.office_id, { ts: Date.now(), op, args: args || {} });
    const r = await postJson('/remote/v1/call', env);
    if (r.status !== 200) throw new RemoteError(r.body.code || 'http', r.body.error || `HTTP ${r.status}`);
    const msg = C.openResponse(key, state.device.id, state.office.office_id, r.body);
    if (msg.re !== env.iv) throw new RemoteError('bad_reply', 'la respuesta no corresponde a esta llamada');
    if (!msg.ok) throw new RemoteError(msg.code || 'error', msg.error || 'error');
    return msg.result;
  }

  // ── pairing ────────────────────────────────────────────────────────────────
  const fmtCode = (c) => `${c.slice(0, 3)} ${c.slice(3)}`;

  async function pair(name) {
    const kp = C.x25519Keypair();
    const pub = C.b64u(kp.pub);
    const nonce = C.random(16);
    // Commit first, reveal after the office answered (see lib-remote.cjs).
    const r1 = await postJson('/remote/v1/pair', { name, pub, commit: C.b64u(C.sha256(nonce)) });
    if (r1.status !== 200) throw new RemoteError(r1.body.code, r1.body.error || 'no se pudo pedir el emparejamiento');
    const office = r1.body;
    const deviceId = C.deviceIdOf(kp.pub);
    if (office.protocol !== C.REMOTE || office.device_id !== deviceId || typeof office.box_pub !== 'string') {
      throw new RemoteError('bad_office', 'esa no parece una oficina Munder');
    }
    const r2 = await postJson('/remote/v1/reveal', { device_id: deviceId, nonce: C.b64u(nonce) });
    if (r2.status !== 200) throw new RemoteError(r2.body.code, r2.body.error || 'el emparejamiento falló');
    const k = C.sessionKey(kp.priv, office.box_pub, office.office_id, deviceId);
    state = {
      device: { id: deviceId, name, pub, priv: C.b64u(kp.priv) },
      office: { office_id: office.office_id, name: office.name, box_pub: office.box_pub },
      key: C.b64u(k),
      code: C.sas(office.box_pub, pub, office.nonce, C.b64u(nonce)),
      paired: false,
      at: Date.now(),
    };
    key = k;
    save(state);
  }

  let pairPoll = null;
  function waitForAccept() {
    clearTimeout(pairPoll);
    const tick = async () => {
      try {
        await call('hello');
        state.paired = true;
        delete state.code;
        save(state);
        toast('¡Listo! Celular emparejado');
        render();
        refresh();
        return;
      } catch (e) {
        if (e.code === 'unknown_device') {
          ui.pairError = 'La computadora ya no tiene esta solicitud (caducó a los 10 minutos o se rechazó). Empieza de nuevo.';
          render();
          return;
        }
      }
      pairPoll = setTimeout(tick, 2000);
    };
    tick();
  }

  function pairScreen() {
    const input = h('input', { type: 'text', id: 'name', autocomplete: 'off', maxlength: '40', value: 'iPhone' });
    const err = h('div', { class: 'error', role: 'alert' }, ui.pairError || '');
    const btn = h('button', {
      class: 'btn',
      onclick: async () => {
        btn.disabled = true;
        err.textContent = '';
        ui.pairError = null;
        try {
          await pair(input.value.trim() || 'iPhone');
          render();
          waitForAccept();
        } catch (e) {
          err.textContent = e.message || String(e);
          btn.disabled = false;
        }
      },
    }, 'Emparejar con esta oficina');
    return h('main', { class: 'screen bare' },
      h('div', { class: 'top' }, h('h1', null, 'Munder Remote')),
      h('p', { class: 'sub' }, location.host),
      h('div', { class: 'hero' },
        portrait('michael', 3),
        h('div', { class: 'bubble' }, '¡Hola! Empareja este celular y manejas la oficina desde aquí.')),
      h('div', { class: 'card' },
        h('h2', null, 'Emparejar este celular'),
        h('p', { class: 'hint' }, 'La computadora te va a pedir que confirmes un código de 6 dígitos. Hasta que lo aceptes allá, este celular no ve nada.'),
        h('label', { class: 'field', for: 'name' }, 'Nombre de este celular'),
        input, btn, err),
      h('div', { class: 'card' },
        h('h2', null, 'Tenlo como app'),
        h('ol', { class: 'steps' },
          h('li', null, 'En Safari toca Compartir → «Agregar a inicio».'),
          h('li', null, 'Abre Munder desde el ícono y empareja AHÍ: la app de inicio guarda sus llaves aparte de Safari.')),
        h('p', { class: 'hint' }, 'Cada dirección cuenta como una app distinta (la IP de tu casa y la de Tailscale). Si usas Tailscale en casa también, empareja solo por Tailscale.')));
  }

  function codeScreen() {
    return h('main', { class: 'screen bare' },
      h('div', { class: 'top' }, h('h1', null, 'Confirma el código')),
      h('p', { class: 'sub' }, state.office.name),
      h('div', { class: 'hero' },
        portrait('dwight', 3),
        h('div', { class: 'bubble' }, 'Seguridad primero. Compara este número con el de la computadora.')),
      h('div', { class: 'card' },
        h('div', { class: 'code', 'aria-label': `Código ${state.code.split('').join(' ')}` }, fmtCode(state.code)),
        h('p', { class: 'hint' }, 'Acéptalo en la computadora solo si allá sale este MISMO número:'),
        h('ol', { class: 'steps' },
          h('li', null, 'Munder → Configuración → Munder Link → Solicitudes → Aceptar, o'),
          h('li', null, 'en una terminal: ', h('code', null, `munder link aceptar ${state.code}`))),
        ui.pairError ? h('div', { class: 'error', role: 'alert' }, ui.pairError) : h('p', { class: 'hint' }, 'Esperando que lo aceptes…'),
        h('button', { class: 'btn ghost', onclick: () => { clearTimeout(pairPoll); wipe(); state = null; key = null; ui.pairError = null; render(); } }, 'Empezar de nuevo')));
  }

  // ── main screens ───────────────────────────────────────────────────────────
  const MICHAEL = { idle: 'libre', working: 'trabajando', blocked: 'bloqueado', gone: 'fuera', offline: 'apagado' };
  const AGENT_DOT = { idle: 'on', working: 'busy', blocked: 'off', gone: '' };
  const CHIP = { idle: 'idle', working: 'working', blocked: 'blocked' };
  const STATUS = { blocked: 'Bloqueadas', doing: 'En curso', todo: 'Por hacer', done: 'Hechas' };

  function tile(label, value, extra, alert) {
    return h('div', { class: `tile${alert ? ' alert' : ''}` }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value, extra ? h('small', null, ` ${extra}`) : null));
  }

  function composer({ id, placeholder, button, onsend }) {
    const ta = h('textarea', { id, placeholder, rows: '3', 'aria-label': placeholder });
    ta.value = ui.drafts[id] || '';
    ta.addEventListener('input', () => { ui.drafts[id] = ta.value; });
    const btn = h('button', {
      class: 'btn',
      onclick: async () => {
        const text = ta.value.trim();
        if (!text) return ta.focus();
        btn.disabled = true;
        ui.busy = true;
        try {
          await onsend(text);
          ui.drafts[id] = '';
          ta.value = '';
        } catch (e) {
          toast(e.message || 'no se pudo enviar');
          if (e.code === 'question_changed') refresh();
        } finally {
          ui.busy = false;
          btn.disabled = false;
        }
      },
    }, button);
    return [ta, btn];
  }

  function officeTab(d) {
    const c = d.capacity || {};
    const q = d.questions.length;
    const agents = d.agents.filter((a) => !a.god);
    const god = d.agents.find((a) => a.god);
    return [
      h('div', { class: 'tiles' },
        tile('Michael', MICHAEL[c.michael_state] || c.michael_state || '—'),
        tile('Workers libres', `${c.workers_idle ?? '—'}`, c.workers_total !== undefined ? `de ${c.workers_total}` : ''),
        tile('Preguntas', String(q), q ? 'para ti' : '', q > 0),
        tile('Tareas abiertas', String(c.tasks_open ?? '—')),
        tile('RAM libre', `${c.ram_free_gb ?? '—'}`, c.ram_total_gb ? `de ${c.ram_total_gb} GB` : ''),
        tile('Carga CPU', `${c.load1 ?? '—'}`, c.cpus ? `${c.cpus} CPUs` : '')),
      d.hive ? null : h('div', { class: 'offline-banner' }, 'No encuentro el hive de esta oficina. Abre Munder en la computadora.'),
      h('div', { class: 'section-title' }, 'Pídele algo a Michael'),
      h('div', { class: 'card' },
        ...composer({
          id: 'ask', placeholder: 'Escribe lo que necesitas…', button: 'Enviar a Michael',
          onsend: async (text) => { await call('ask', { text }); toast('Enviado a Michael'); },
        })),
      h('div', { class: 'section-title' }, `Equipo · ${agents.length + (god ? 1 : 0)}`),
      god || agents.length
        ? h('div', { class: 'team' }, god ? agentCard(god) : null, agents.map(agentCard))
        : h('div', { class: 'card empty' }, 'Nadie conectado todavía'),
    ];
  }

  /** Like the agent cards along the bottom of the app: portrait, name, state. */
  function agentCard(a) {
    return h('div', { class: `agent${a.god ? ' boss' : ''}` },
      portrait(castOf(a), 2),
      h('div', { class: 'who' },
        h('div', { class: 'name' }, a.name),
        h('span', { class: `chip ${CHIP[a.status] || ''}` }, h('span', { class: `dot ${AGENT_DOT[a.status] || ''}` }), a.god ? 'jefe' : a.on_hold ? 'contigo' : (MICHAEL[a.status] || a.status)),
        a.role ? h('div', { class: 'role' }, a.role) : null));
  }

  function questionsTab(d) {
    if (!d.questions.length) return [h('div', { class: 'empty' }, 'Nada pendiente. Michael no te está esperando 🎉')];
    return d.questions.map((t) => h('article', { class: 'card question' },
      h('h2', null, t.title),
      h('div', { class: 'meta' }, t.assignee ? h('span', null, t.assignee) : null, t.from_office ? h('span', { class: 'chip' }, `de ${t.from_office}`) : null, t.question.asked_at ? h('span', null, ago(t.question.asked_at)) : null),
      h('div', { class: 'asker' },
        portrait(t.assignee ? castOf(agentById(d, t.assignee) || { id: t.assignee }) : 'michael', 2),
        h('div', { class: 'bubble' }, markdown(t.question.q))),
      ...composer({
        id: `qa:${t.id}`, placeholder: 'Tu respuesta…', button: 'Responder',
        onsend: async (text) => {
          await call('answer', { task_id: t.id, q: t.question.q, text });
          toast('Respuesta enviada a Michael');
          await refresh();
        },
      })));
  }

  function boardTab(d) {
    const by = { blocked: [], doing: [], todo: [], done: [] };
    for (const t of d.tasks) (by[t.status] || by.todo).push(t);
    const seg = h('div', { class: 'segments', role: 'group', 'aria-label': 'Estado' },
      Object.keys(STATUS).map((k) => h('button', {
        class: k,
        'aria-pressed': String(ui.filter === k),
        onclick: () => { ui.filter = k; render(); },
      }, h('span', { class: 'n' }, String(by[k].length)), h('span', null, STATUS[k]))));
    const list = by[ui.filter];
    return [
      seg,
      list.length ? list.map((t) => taskCard(t, d)) : h('div', { class: 'empty' }, ui.filter === 'done' ? 'Todavía nada terminado' : 'Vacío'),
      ui.filter === 'done' && list.length ? h('p', { class: 'hint' }, 'Se muestran las 15 más recientes.') : null,
    ];
  }

  function taskCard(t, d) {
    const who = t.assignee ? agentById(d, t.assignee) || { id: t.assignee } : null;
    return h('details', { class: `card task s-${t.status}` },
      h('summary', null,
        who ? portrait(castOf(who), 1.5) : null,
        h('div', { class: 'grow' },
          h('h2', null, t.title),
          h('div', { class: 'meta' },
            h('span', null, t.assignee || 'sin asignar'),
            t.question ? h('span', { class: 'chip blocked' }, 'pregunta') : null,
            t.from_office ? h('span', { class: 'chip' }, `de ${t.from_office}`) : null,
            t.created_at ? h('span', null, ago(t.created_at)) : null))),
      h('div', { class: 'detail' },
        t.description ? [h('b', null, 'Descripción'), t.description] : null,
        t.result ? [h('b', null, 'Resultado'), t.result] : null,
        h('b', null, 'ID'), t.id));
  }

  function linkTab() {
    const peers = ui.peers;
    const online = (peers || []).filter((p) => p.online);
    const select = h('select', { id: 'peer', 'aria-label': 'Oficina' }, online.map((p) => h('option', { value: p.office_id }, p.name)));
    return [
      h('div', { class: 'section-title' }, 'Oficinas enlazadas'),
      h('div', { class: 'card' },
        peers === null ? h('div', { class: 'empty' }, 'Buscando…')
          : !peers.length ? h('div', { class: 'empty' }, 'Ninguna todavía. En la computadora: munder link conectar')
            : peers.map((p) => {
              const c = p.capacity || {};
              return h('div', { class: 'row' },
                portrait('michael', 1.5),
                h('div', { class: 'grow' },
                  h('div', { class: 'name' }, h('span', { class: `dot ${p.online ? 'on' : 'off'}` }), ' ', p.name),
                  h('div', { class: 'role' }, p.online
                    ? `Michael ${MICHAEL[c.michael_state] || c.michael_state || '—'} · ${c.workers_idle ?? '?'}/${c.workers_total ?? '?'} libres · ${c.ram_free_gb ?? '?'} GB`
                    : 'sin conexión')),
                p.online ? h('span', { class: 'chip' }, `${p.latency_ms} ms`) : null);
            })),
      online.length ? h('div', { class: 'section-title' }, 'Delegar a otra oficina') : null,
      online.length ? h('div', { class: 'card' },
        h('label', { class: 'field', for: 'peer' }, 'Oficina'), select,
        h('label', { class: 'field', for: 'delegate' }, 'Tarea'),
        ...composer({
          id: 'delegate', placeholder: 'Qué debe hacer su Michael…', button: 'Delegar',
          onsend: async (text) => {
            const r = await call('delegate', { office: select.value, text });
            toast(`Delegada a ${r.office}`);
          },
        })) : null,
      h('div', { class: 'section-title' }, 'Este celular'),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'name' }, state.device.name), h('div', { class: 'role' }, `huella ${state.device.id.match(/.{4}/g).join(' ')}`))),
        h('p', { class: 'hint' }, 'Para quitarle el acceso de verdad, olvídalo también en la computadora (Munder Link → Celulares).'),
        h('button', {
          class: 'btn danger',
          onclick: () => { if (confirm('¿Olvidar la oficina en este celular?')) { wipe(); state = null; key = null; render(); } },
        }, 'Olvidar en este celular')),
    ];
  }

  function ago(iso) {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return '';
    const m = Math.round(ms / 60000);
    if (m < 1) return 'ahora';
    if (m < 60) return `hace ${m} min`;
    const hrs = Math.round(m / 60);
    if (hrs < 24) return `hace ${hrs} h`;
    return `hace ${Math.round(hrs / 24)} d`;
  }

  function tabs(d) {
    const q = d ? d.questions.length : 0;
    const items = [['office', 'Oficina'], ['ask', 'Preguntas'], ['board', 'Tablero'], ['link', 'Enlace']];
    return h('nav', { class: 'tabs', 'aria-label': 'Secciones' }, items.map(([id, label]) => h('button', {
      'aria-current': ui.tab === id ? 'page' : false,
      onclick: () => { ui.tab = id; render(); if (id === 'link') refreshPeers(); window.scrollTo(0, 0); },
    }, icon(id), label, id === 'ask' && q ? h('span', { class: 'badge' }, String(q)) : null)));
  }

  function mainScreen() {
    const d = ui.data;
    const title = { office: state.office.name, ask: 'Preguntas', board: 'Tablero', link: 'Enlace' }[ui.tab];
    const body = !d ? [h('div', { class: 'empty' }, ui.online ? 'Cargando…' : 'Sin conexión')]
      : ui.tab === 'office' ? officeTab(d)
        : ui.tab === 'ask' ? questionsTab(d)
          : ui.tab === 'board' ? boardTab(d)
            : linkTab();
    return [
      h('main', { class: 'screen' },
        h('div', { class: 'top' }, h('span', { class: `dot ${ui.online ? 'on' : 'off'}`, title: ui.online ? 'en línea' : 'sin conexión' }), h('h1', null, title)),
        ui.tab === 'office' && d ? h('p', { class: 'sub' }, `${d.office.host} · ${d.office.fingerprint}`) : null,
        ui.online ? null : h('div', { class: 'offline-banner' }, ui.offlineWhy || 'No alcanzo la oficina. ¿Está encendido el enlace y estás en la misma red o en Tailscale?'),
        body),
      tabs(d),
    ];
  }

  // ── render + refresh ──────────────────────────────────────────────────────
  /**
   * Press Start 2P has no accented capitals, so «PÍDELE» would print a lowercase
   * «í» mid-word. The small-caps labels drop their accents, as pixel fonts do;
   * everything read as body text keeps them.
   */
  const CAPS = '.section-title, .tile .label, label.field, .task .detail b, .chip, .agent .name, .row .name, .top h1, nav.tabs button, .segments button';
  function plainCaps(root) {
    for (const el of root.querySelectorAll(CAPS)) {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) n.nodeValue = n.nodeValue.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
    }
  }

  function render() {
    // Keep whatever the human is typing: re-rendering must never eat a draft or the focus.
    const focused = document.activeElement && document.activeElement.id;
    const caret = focused && document.activeElement.selectionStart;
    const openCards = new Set([...document.querySelectorAll('details[open] h2')].map((e) => e.textContent));
    $app.replaceChildren(...[].concat(!state ? pairScreen() : !state.paired ? codeScreen() : mainScreen()));
    plainCaps($app);
    document.querySelectorAll('details').forEach((d) => { if (openCards.has(d.querySelector('h2').textContent)) d.open = true; });
    if (focused) {
      const el = document.getElementById(focused);
      if (el) { el.focus(); if (typeof caret === 'number' && el.setSelectionRange) el.setSelectionRange(caret, caret); }
    }
  }

  let timer = null;
  async function refresh() {
    clearTimeout(timer);
    if (!state || !state.paired) return;
    if (document.visibilityState === 'visible' && !ui.busy) {
      try {
        ui.data = await call('overview');
        ui.online = true;
        ui.offlineWhy = null;
      } catch (e) {
        ui.online = false;
        if (e.code === 'unknown_device') {
          ui.offlineWhy = 'La oficina ya no reconoce este celular (lo olvidaron allá). Toca «Olvidar en este celular» y vuelve a emparejar.';
        } else if (e.code === 'stale') {
          ui.offlineWhy = 'La hora del celular y la de la computadora no coinciden. Ajusta la hora automática en ambos.';
        } else ui.offlineWhy = null;
      }
      const el = document.activeElement;
      // Don't swap the DOM under an open keyboard; the next tick will catch up.
      if (!(el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.tagName === 'SELECT'))) render();
    }
    timer = setTimeout(refresh, REFRESH_MS);
  }

  let peersAt = 0;
  async function refreshPeers() {
    if (Date.now() - peersAt < PEERS_MS && ui.peers) return;
    peersAt = Date.now();
    try { ui.peers = (await call('peers')).peers; } catch { ui.peers = ui.peers || []; }
    if (ui.tab === 'link') render();
  }

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });

  render();
  if (state && !state.paired) waitForAccept();
  else refresh();
})();
