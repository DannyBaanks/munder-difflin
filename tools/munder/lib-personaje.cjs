'use strict';
/**
 * lib-personaje — lógica testeable del chat creador de personajes.
 *
 * Sin dependencias (builtins de node). Lo requiere el CLI
 * (tools/munder/munder) y los tests (sin red salvo stub local).
 *
 * La key NUNCA pasa por aquí salvo como header Bearer de una llamada que el
 * usuario pidió explícitamente; este módulo no loguea, no escribe archivos
 * y no conserva nada entre llamadas.
 */

const SYSTEM_PERSONAJE = `Eres el creador de personajes de Munder Difflin, una oficina virtual de agentes con estética de sitcom de oficina en pixel art.
El usuario te describirá en lenguaje natural el worker que quiere (ejemplo: "quiero un personaje como Jim, bromista pero que programe").
Tu trabajo:
1. Conversa en español, con preguntas CORTAS (máximo 2 por turno) para afinar: nombre, rol en la oficina, personalidad y apariencia visual.
2. Cuando el usuario confirme o diga "listo", emite EXACTAMENTE UN bloque final así (y nada más después de él):
\`\`\`personaje-json
{"nombre": "...", "rol": "...", "persona": "...", "avatar_desc": "..."}
\`\`\`
- nombre: corto, único, estilo oficina (sin apellidos reales de la serie salvo que lo pidan).
- rol: puesto en la oficina (ej: "ventas", "recepción", "contabilidad").
- persona: 2-3 frases de personalidad y forma de hablar (guiará su system prompt).
- avatar_desc: descripción visual CONCRETA para pixel-art pequeño (ropa, colores, rasgos, objeto distintivo). Sin fondos, sin texto en la imagen.
3. Nunca inventes capacidades técnicas ni permisos: aquí solo se diseña identidad.
4. No pidas API keys (ya las tenemos) ni datos personales.`;

/** Extrae el ÚLTIMO bloque ```personaje-json válido ({nombre,...}) o null. Pura. */
function extraerPersonaje(text) {
  if (typeof text !== 'string') return null;
  const re = /```personaje-json\s*([\s\S]*?)```/g;
  let m, last = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  if (last === null) return null;
  try {
    const o = JSON.parse(last);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    if (typeof o.nombre !== 'string' || !o.nombre.trim()) return null;
    const str = (v) => (typeof v === 'string' ? v.trim() : '');
    return { nombre: o.nombre.trim(), rol: str(o.rol), persona: str(o.persona), avatar_desc: str(o.avatar_desc) };
  } catch {
    return null;
  }
}

/** Una línea SSE `data: ...` -> {done} | {content} | null. Pura. */
function parseSSEDataLine(line) {
  if (typeof line !== 'string' || !line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (payload === '[DONE]') return { done: true };
  if (!payload) return null;
  try {
    const j = JSON.parse(payload);
    const c = j && j.choices && j.choices[0]
      ? (j.choices[0].delta && j.choices[0].delta.content) ?? (j.choices[0].message && j.choices[0].message.content) ?? ''
      : '';
    return c ? { content: c } : null;
  } catch {
    return null;
  }
}

/**
 * POST {baseURL}/chat/completions (OpenAI-compatible) con streaming SSE y
 * fallback a JSON no-stream. Resuelve el texto completo. La key viaja SOLO
 * en el header Authorization; ni el cuerpo ni ningún log la contienen.
 */
async function chatCompletions(baseURL, key, model, messages, onToken) {
  const url = String(baseURL).replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, stream: true, temperature: 0.7 }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`el endpoint respondió ${res.status}: ${t.slice(0, 200)}`);
  }
  let full = '';
  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('text/event-stream') && res.body) {
    let buf = '', finished = false;
    for await (const chunk of res.body) {
      if (finished) break;
      buf += Buffer.from(chunk).toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const p = parseSSEDataLine(line.trim());
        if (!p) continue;
        if (p.done) { finished = true; break; }
        if (p.content) { full += p.content; if (onToken) onToken(p.content); }
      }
    }
  } else {
    const j = await res.json();
    full = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    if (full && onToken) onToken(full);
  }
  return full;
}

/**
 * Bucle de chat creador de personajes. `io` inyectado para tests
 * ({ask, select, print} con las mismas firmas que el CLI real).
 * Devuelve el personaje aceptado o null (cancelado). La key solo viaja en
 * el header de chatCompletions; aquí jamás se escribe ni se loguea.
 */
async function chatearPersonaje(endpoint, model, key, io) {
  io.print('');
  io.print('  Chat con IA para crear tu personaje (escribe /salir para terminar).');
  io.print(`  Hablas con ${model} vía ${endpoint.label}. La key solo vive en memoria de esta corrida.`);
  const history = [{ role: 'system', content: SYSTEM_PERSONAJE }];
  for (;;) {
    const msg = await io.ask('  tú: ');
    if (msg === null || /^\/(salir|exit|quit)\s*$/.test(msg.trim())) return null;
    if (!msg.trim()) continue;
    history.push({ role: 'user', content: msg });
    if (history.length > 21) history.splice(1, history.length - 21);
    let full = '';
    try {
      full = await chatCompletions(endpoint.baseURL, key, model, history, (t) => io.print(t, true));
    } catch (e) {
      io.print('');
      io.print(`  el endpoint falló: ${e.message}`);
      continue;
    }
    io.print('');
    if (!full.trim()) { io.print('  (respuesta vacía, intenta de nuevo)'); continue; }
    history.push({ role: 'assistant', content: full });
    const pj = extraerPersonaje(full);
    if (!pj) continue;
    io.print('');
    io.print('  ¡Personaje propuesto!');
    io.print(`    nombre: ${pj.nombre}`);
    if (pj.rol) io.print(`    rol: ${pj.rol}`);
    if (pj.persona) io.print(`    persona: ${pj.persona}`);
    if (pj.avatar_desc) io.print(`    avatar: ${pj.avatar_desc}`);
    const i = await io.select('¿Usamos este personaje?', ['Sí, continuar con él', 'Seguir chateando']);
    if (i === 0) return pj;
    if (i < 0) return null;
  }
}

module.exports = { SYSTEM_PERSONAJE, extraerPersonaje, parseSSEDataLine, chatCompletions, chatearPersonaje };
