'use strict';
// The token arrives in the URL fragment (never sent to any server) and stays in
// this tab only. Every API call carries it; nothing else is trusted.
(function () {
  const m = /[#&]t=([0-9a-f]{16,})/.exec(location.hash);
  if (m) { sessionStorage.setItem('munder-panel', m[1]); history.replaceState(null, '', '/'); }
  const TOKEN = sessionStorage.getItem('munder-panel') || '';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(path, body) {
    const r = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-munder-panel': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) throw new Error('Esta pestaña ya no es válida: abre Munder Panel otra vez.');
    return r.json();
  }

  let toastTimer;
  function toast(text, bad) {
    const t = $('toast');
    t.textContent = text; t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, bad ? 9000 : 5000);
  }

  function setState(dotId, textId, kind, text) {
    $(dotId).className = 'dot ' + kind;
    $(textId).textContent = text;
  }

  // The button that would do nothing right now is shown, but off.
  function offWhen(action, off) {
    const b = document.querySelector(`button[data-action="${action}"]`);
    if (b && !busy) b.disabled = !!off;
  }

  function render(s) {
    if (s.app.running) setState('app-dot', 'app-text', 'on', `Abierto${s.app.version ? ` · v${s.app.version}` : ''}`);
    else setState('app-dot', 'app-text', 'off', 'Cerrado');

    const L = s.link;
    if (L.error) setState('link-dot', 'link-text', 'warn', L.error);
    else setState('link-dot', 'link-text', L.on ? 'on' : 'off', `${L.on ? 'Encendido' : 'Apagado'} · esta oficina es ${L.name}`);
    $('link-pending').innerHTML = (L.pending || []).map((q) => `
      <div class="request">
        <strong>${q.kind === 'celular' ? 'Un celular' : 'Una oficina'} quiere enlazarse: ${esc(q.name)}</strong>
        <div class="code">${esc(q.code.replace(/(\d{3})(\d{3})/, '$1 $2'))}</div>
        <div class="hint">Acepta solo si ves este MISMO código en ${q.kind === 'celular' ? 'el celular' : 'la otra computadora'}.</div>
        <div class="row">
          <button class="primary" data-action="link.accept" data-code="${esc(q.code)}">Sí es el mismo: aceptar</button>
        </div>
      </div>`).join('');
    $('link-peers').innerHTML = (L.peers || []).length ? L.peers.map((p) => `
      <li><span class="dot ${p.online ? 'on' : 'off'}"></span><span class="grow"><strong>${esc(p.name)}</strong>
      <small>${p.online ? `en línea · ${p.workers_idle ?? '?'}/${p.workers_total ?? '?'} libres · ${p.latency_ms} ms` : esc(p.reason)}</small></span></li>`).join('')
      : '<li class="empty">Ninguna todavía. Enciende el enlace en las dos computadoras y empareja desde Munder → Configuración → Munder Link.</li>';
    $('link-urls').innerHTML = (L.urls || []).length ? L.urls.map((u) => `<li><span class="grow">${esc(u.url)}</span><small>${esc(u.via)}</small></li>`).join('')
      : '<li class="empty">Esta computadora no tiene red local ni Tailscale.</li>';
    $('link-phones').innerHTML = (L.phones || []).length ? L.phones.map((p) => `
      <li><span class="grow"><strong>${esc(p.name)}</strong> <small>desde ${esc(p.since)}</small></span>
      <button class="danger" data-action="link.forgetPhone" data-id="${esc(p.id)}" data-confirm="¿Olvidar «${esc(p.name)}»? Deja de funcionar al instante.">Olvidar</button></li>`).join('')
      : '<li class="empty">Ninguno todavía.</li>';

    const G = s.gpt;
    if (!G.available) setState('gpt-dot', 'gpt-text', 'warn', 'No disponible en esta instalación');
    else setState('gpt-dot', 'gpt-text', G.on && G.running ? 'on' : 'off',
      `${G.on && G.running ? 'Encendido' : 'Apagado'} · permisos: ${G.profile}${G.grants ? ` · ${G.grants} conexión(es)` : ''}`);
    $('gpt-pending').innerHTML = (G.pending || []).map((p) => `
      <div class="request">
        <strong>ChatGPT pide permiso: ${esc(p.client)}</strong>
        <div class="code">${esc(p.code.replace(/(\d{3})(\d{3})/, '$1 $2'))}</div>
        <div class="hint">Aprueba solo si tú acabas de conectar ChatGPT y ves este código allá.</div>
        <div class="row">
          <button class="primary" data-action="gpt.approve" data-code="${esc(p.code)}">Aprobar</button>
          <button class="danger" data-action="gpt.deny" data-code="${esc(p.code)}">Rechazar</button>
        </div>
      </div>`).join('');

    offWhen('app.open', s.app.running);
    offWhen('app.close', !s.app.running);
    offWhen('link.on', L.on);
    offWhen('link.off', !L.on);
    offWhen('gpt.on', G.available && G.on && G.running);
    offWhen('gpt.off', !G.available || !G.on);

    const R = s.reviver;
    if (!R.configured) setState('rv-dot', 'rv-text', 'off', 'No activado');
    else if (!R.running) setState('rv-dot', 'rv-text', 'warn', 'Activado, pero no está corriendo');
    else setState('rv-dot', 'rv-text', 'on', `Cuidando a Munder · vigilancia: ${R.watchdog}`);
    offWhen('reviver.enable', R.configured && R.running);
    offWhen('reviver.disable', !R.configured);
  }

  let busy = false;
  async function refresh() {
    if (busy) return;
    try { render(await api('/api/state')); } catch (e) { toast(e.message, true); }
  }

  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button[data-action]');
    if (!b) return;
    if (b.dataset.confirm && !confirm(b.dataset.confirm)) return;
    const args = {};
    if (b.dataset.code) args.code = b.dataset.code;
    if (b.dataset.id) args.id = b.dataset.id;
    busy = true; b.disabled = true; const label = b.textContent; b.textContent = 'Un momento…';
    try {
      const r = await api('/api/action', { action: b.dataset.action, args });
      toast(r.text || (r.ok ? 'Listo.' : 'No se pudo.'), !r.ok);
    } catch (e) { toast(e.message, true); }
    finally { busy = false; b.disabled = false; b.textContent = label; await refresh(); }
  });

  refresh();
  setInterval(refresh, 5000);
})();
