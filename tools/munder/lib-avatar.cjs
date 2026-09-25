'use strict';
/**
 * lib-avatar — PNG mínimo + avatar blank-canvas + verificación (M11 semilla).
 *
 * Sin dependencias (node:zlib + node:fs builtins). Lo requiere el CLI
 * (tools/munder/munder) y los tests. Nada aquí toca red ni secretos:
 * la key de edición viaja solo en el header que arma el llamador.
 *
 * Formatos soportados en DECODIFICACIÓN: PNG 8-bit, color types 0 (gris),
 * 2 (RGB), 3 (paleta + tRNS opcional), 4 (gris+alpha), 6 (RGBA). Suficiente
 * para verificar salidas de endpoints y para el lienzo que generamos.
 * CODIFICACIÓN: siempre RGBA 8-bit (canónico para avatares).
 */

const zlib = require('node:zlib');

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32Table() {
  if (crc32Table.t) return crc32Table.t;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  crc32Table.t = t;
  return t;
}

function crc32(buf) {
  const t = crc32Table();
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const td = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([td, data])));
  return Buffer.concat([len, td, data, crc]);
}

/** Crea un PNG RGBA 8-bit de w×h con el callback de píxel (x,y)->[r,g,b,a]. */
function encodeRGBA(w, h, px) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filtro None por scanline
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = px(x, y);
      const o = y * (1 + w * 4) + 1 + x * 4;
      raw[o] = r & 0xFF; raw[o + 1] = g & 0xFF; raw[o + 2] = b & 0xFF; raw[o + 3] = a & 0xFF;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** Decodifica un PNG a {w,h,rgba:Buffer}. Lanza con motivo si es inválido. */
function decodePNG(buf) {
  const fail = (why) => { throw new Error(`PNG inválido: ${why}`); };
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 33 || !buf.slice(0, 8).equals(PNG_SIG)) fail('firma');
  let pos = 8, w, h, bitDepth, colorType, idat = [], plte = null, trns = null;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString('ascii');
    const data = buf.slice(pos + 8, pos + 8 + len);
    const want = buf.readUInt32BE(pos + 8 + len);
    if (crc32(buf.slice(pos + 4, pos + 8 + len)) !== want) fail(`CRC en ${type}`);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (bitDepth !== 8) fail(`bitDepth ${bitDepth} (solo 8)`);
      if (![0, 2, 3, 4, 6].includes(colorType)) fail(`color ${colorType} no soportado`);
      if (data[10] !== 0 || data[12] !== 0) fail('compresión/filtro/entrelazado no estándar');
    } else if (type === 'PLTE') {
      plte = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (w === undefined) fail('sin IHDR');
  if (!w || !h || w > 4096 || h > 4096) fail(`dimensiones absurdas ${w}x${h}`);
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch { fail('IDAT no infla'); }
  // Canales por píxel según color type (8-bit, sin entrelazado).
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const stride = w * ch;
  if (raw.length !== h * (stride + 1)) fail(`tamaño inesperado (${raw.length})`);
  const rgba = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    if (f > 4) fail(`filtro ${f} no soportado`);
    const line = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const recon = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? recon[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (f === 1) v = (v + a) & 0xFF;
      else if (f === 2) v = (v + b) & 0xFF;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 0xFF;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xFF;
      }
      recon[i] = v;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (colorType === 6) {
        rgba[o] = recon[x * 4]; rgba[o + 1] = recon[x * 4 + 1];
        rgba[o + 2] = recon[x * 4 + 2]; rgba[o + 3] = recon[x * 4 + 3];
      } else if (colorType === 2) {
        rgba[o] = recon[x * 3]; rgba[o + 1] = recon[x * 3 + 1]; rgba[o + 2] = recon[x * 3 + 2]; rgba[o + 3] = 255;
      } else if (colorType === 0) {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = recon[x]; rgba[o + 3] = 255;
      } else if (colorType === 4) {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = recon[x * 2]; rgba[o + 3] = recon[x * 2 + 1];
      } else if (colorType === 3) {
        const idx = recon[x] * 3;
        rgba[o] = plte[idx]; rgba[o + 1] = plte[idx + 1]; rgba[o + 2] = plte[idx + 2];
        rgba[o + 3] = trns && recon[x] < trns.length ? trns[recon[x]] : 255;
      }
    }
    prev = recon;
  }
  return { w, h, rgba };
}

/** Lienzo en blanco para avatares: w×h RGBA totalmente transparente. */
function blankCanvas(w, h) {
  return encodeRGBA(w, h, () => [0, 0, 0, 0]);
}

/**
 * Verifica un buffer PNG contra la spec de avatar ({w,h,needAlpha,maxBytes}).
 * Devuelve {ok:true, info} o {ok:false, reason} (AVATAR_REJECTED del llamador).
 * Nunca normaliza en silencio: lo que no cumple se rechaza con motivo.
 */
function verifyAvatar(buf, spec) {
  const fail = (reason) => ({ ok: false, reason });
  let img;
  try {
    img = decodePNG(buf);
  } catch (e) {
    return fail(`no decodifica: ${e.message}`);
  }
  if (img.w !== spec.w || img.h !== spec.h) {
    return fail(`dimensiones ${img.w}x${img.h}, se requieren ${spec.w}x${spec.h} exactos (sin reescalado: destruiría el pixel-art)`);
  }
  if (spec.maxBytes && buf.length > spec.maxBytes) {
    return fail(`pesa ${buf.length} bytes (tope ${spec.maxBytes})`);
  }
  if (spec.needAlpha) {
    let opaque = 0, transparent = 0;
    for (let i = 3; i < img.rgba.length; i += 4) {
      if (img.rgba[i] === 0) transparent++;
      else if (img.rgba[i] === 255) opaque++;
    }
    if (transparent === 0) return fail('sin canal alpha real (todo opaco: sin transparencia)');
    if (opaque === 0) return fail('totalmente transparente (lienzo vacío)');
  }
  return { ok: true, info: { w: img.w, h: img.h, bytes: buf.length } };
}

function multipartEdit(imageBuf, fields) {
  // multipart/form-data mínimo para images/edits OpenAI-compatible.
  const boundary = '----munder' + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
  const parts = [];
  const push = (s) => parts.push(Buffer.isBuffer(s) ? s : Buffer.from(String(s), 'utf8'));
  for (const [k, v] of Object.entries(fields)) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  }
  push(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="canvas.png"\r\nContent-Type: image/png\r\n\r\n`);
  push(imageBuf);
  push('\r\n');
  push(`--${boundary}--\r\n`);
  return { body: Buffer.concat(parts), boundary };
}

/**
 * Llama a {baseURL}/images/edits (OpenAI-compatible) con el PNG + prompt.
 * Devuelve el buffer de la imagen resultante (b64_json preferido, url con
 * descarga de respaldo). La key viaja SOLO en el header; errores con status
 * sin fugas. Un 404 significa "este endpoint no edita" (degradación honesta).
 */
async function editImageEndpoint({ baseURL, key, model, imageBuf, prompt }) {
  const { body, boundary } = multipartEdit(imageBuf, { model, prompt });
  let res;
  try {
    res = await fetch(String(baseURL).replace(/\/+$/, '') + '/images/edits', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${key}` },
      body,
      signal: AbortSignal.timeout(180000),
    });
  } catch (e) {
    throw new Error(`sin respuesta del endpoint (${e && e.message ? e.message : e})`);
  }
  if (res.status === 404) {
    const err = new Error('endpoint-no-edita');
    err.code = 'ENDPOINT_NO_EDITA';
    throw err;
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`el endpoint respondió ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = await res.json().catch(() => null);
  const item = j && j.data && j.data[0];
  if (item && item.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item && item.url) {
    const dl = await fetch(item.url, { signal: AbortSignal.timeout(120000) });
    if (!dl.ok) throw new Error(`el endpoint devolvió URL pero no se pudo descargar (${dl.status})`);
    return Buffer.from(await dl.arrayBuffer());
  }
  throw new Error('el endpoint no devolvió imagen (sin b64_json ni url)');
}

/* ─── compilador texto-es → receta (frontend del engine) ───────────────────
 *
 * Vocabulario en español sobre AVATAR_VOCAB del engine (portraitArt.ts).
 * Los RGB son aproximaciones documentadas (muestreadas de RECIPES donde
 * existen: jim/pam/stanley/etc.); la forma (qué píxeles) la decide SIEMPRE
 * el engine, aquí solo van nombres→valores. Todo lo no reconocido cae a
 * warnings[] (nunca se inventa geometría).
 */
const AV_PIEL = {
  clara: 'light', blanca: 'light', palida: 'light',
  morena: 'tan', bronceada: 'tan', trigueña: 'tan',
  marron: 'brown', cafe: 'brown',
  oscura: 'dark', negra: 'dark', afro: 'dark',
};
const AV_PELO_ESTILO = {
  corto: 'styleShort', corta: 'styleShort', raya: 'styleShort',
  flequillo: 'styleFloppy', lacio: 'styleFloppy', lacia: 'styleFloppy', caido: 'styleFloppy', caida: 'styleFloppy',
  largo: 'styleFrame', larga: 'styleFrame', enmarcado: 'styleFrame', enmarcada: 'styleFrame', melena: 'styleFrame',
  moño: 'styleBun', recogido: 'styleBun', recogida: 'styleBun', chongo: 'styleBun',
  rizado: 'styleCurly', rizada: 'styleCurly', rizos: 'styleCurly',
  despeinado: 'styleMessy', despeinada: 'styleMessy', desordenado: 'styleMessy', desordenada: 'styleMessy',
  entradas: 'styleRecede', engominado: 'styleRecede', engominada: 'styleRecede', atras: 'styleRecede',
  pinchos: 'styleSpiky', puntiagudo: 'styleSpiky', puntiaguda: 'styleSpiky', punk: 'styleSpiky',
  calvo: 'styleBald', calva: 'styleBald', pelon: 'styleBald', pelona: 'styleBald', 'sin pelo': 'styleBald',
};
const AV_PELO_COLOR = {
  negro: [30, 22, 18], negra: [30, 22, 18],
  castano: [92, 60, 34], castaña: [92, 60, 34], castana: [92, 60, 34],
  marron: [110, 75, 45], morena: [110, 75, 45],
  rubio: [190, 158, 95], rubia: [190, 158, 95],
  pelirrojo: [150, 70, 40], pelirroja: [150, 70, 40], rojo: [150, 70, 40], roja: [150, 70, 40],
  gris: [168, 164, 154], blanco: [228, 228, 228], blanca: [228, 228, 228],
  canoso: [150, 150, 150], canosa: [150, 150, 150],
};
const AV_ROPA = {
  traje: 'suit', sastre: 'suit',
  camisa: 'dressshirt', 'camisa de vestir': 'dressshirt',
  polo: 'polo', playera: 'polo',
  blusa: 'blouse',
  cardigan: 'cardigan', cárdigan: 'cardigan',
  sueter: 'sweater', jersey: 'sweater', sudadera: 'sweater',
};
const AV_COLOR = {
  rojo: [176, 65, 58], roja: [176, 65, 58],
  azul: [110, 140, 180],
  verde: [110, 174, 111],
  negro: [58, 58, 68], negra: [58, 58, 68],
  blanco: [240, 238, 234], blanca: [240, 238, 234],
  gris: [150, 150, 150],
  rosa: [236, 174, 192],
  morado: [150, 146, 170], morada: [150, 146, 170],
  violeta: [150, 146, 170],
  marron: [150, 120, 86],
  beige: [236, 220, 190],
  amarillo: [232, 200, 90], amarilla: [232, 200, 90],
  naranja: [210, 130, 60],
  celeste: [140, 190, 220],
};
const AV_CEJA = { rectas: 'flat', recta: 'flat', enojadas: 'angry', enojada: 'angry', arqueadas: 'raised', arqueada: 'raised', suaves: 'soft', suave: 'soft' };
const AV_BOCA = { neutra: 'neutral', neutro: 'neutral', sonrisa: 'smile', sonrie: 'smile', sonriente: 'smile', ceño: 'frown', molesta: 'frown', molesto: 'frown', mueca: 'grin', sonrisota: 'grin' };
const AV_FACIAL = { bigote: 'mustache', mostacho: 'mustache', 'bigote corto': 'mustacheSm', perilla: 'goatee', chivo: 'goatee', barba: 'stubble', incipiente: 'stubble', 'barba de dias': 'stubble' };
const AV_CORBATIN = [170, 58, 58]; // corbata por defecto (la de Michael)

const AV_DEFAULT_RECIPE = {
  skin: 'light', hairc: [74, 51, 32], hair: 'styleShort', hairargs: {},
  cloth: 'dressshirt', c1: [150, 150, 150], c2: [240, 238, 234],
  brow: 'flat', mouth: 'neutral',
};

function avNorm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Parsea descripción en español a receta del engine. Determinista y total:
 * devuelve {recipe, warnings[], matched[]}. Lo no reconocido va a warnings
 * (con la frase tal cual); jamás se inventa geometría. La ÚLTIMA mención
 * por categoría gana (permite corregir: "camisa azul, no, roja").
 */
function parseAvatarDesc(text, vocab) {
  const warnings = [];
  const matched = [];
  const recipe = { ...AV_DEFAULT_RECIPE, hairargs: { ...AV_DEFAULT_RECIPE.hairargs } };
  // Separadores: comas/puntos Y conjunciones (' y ', ' con ') — así "camisa
  // azul con corbata roja" y "pelo negro y camisa azul" se entienden por
  // partes, y lo no reconocido ("ojos verdes", "sombrero") avisa en vez de
  // esconderse dentro de una frase que sí pegó. Ninguna keyword contiene
  // estos separadores, así que el corte nunca rompe un término válido.
  const phrases = avNorm(text).split(/[,;.\n]+|\s+y\s+|\s+con\s+/).map((s) => s.trim()).filter(Boolean);
  if (!phrases.length) return { recipe, warnings: ['descripción vacía: se usó base neutra'], matched };

  const has = (phrase, table) => {
    const keys = Object.keys(table).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      if (k.includes(' ') ? phrase.includes(k) : new RegExp(`(^| )${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(phrase)) {
        return k;
      }
    }
    return null;
  };
  const colorIn = (phrase) => {
    const keys = Object.keys(AV_COLOR).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      if (new RegExp(`(^| )${k}( |$)`).test(phrase)) return k;
    }
    return null;
  };

  // Contexto discursivo: un modificador suelto ("pinchos" tras "pelo negro
  // con...") hereda la última categoría mencionada. Sin esto, el corte por
  // ' con ' huérfana modificadores (medido dogfooding: "pelo negro con
  // pinchos" perdía el estilo). Solo hair/cloth portan contexto.
  let lastCtx = null;
  for (const phrase of phrases) {
    let hit = false;
    // Piel: "piel X" o el adjetivo solo si nombra tono conocido.
    if (phrase.includes('piel') || phrase.includes('tez') || phrase.includes('cara')) {
      const k = has(phrase, AV_PIEL);
      if (k) { recipe.skin = AV_PIEL[k]; matched.push(`piel:${k}`); hit = true; }
    }
    // Pelo: estilo + color. "pelo/ pelo/cabello".
    if (phrase.includes('pelo') || phrase.includes('cabello') || phrase.includes('cabellera') || phrase.includes('afro')) {
      const k = has(phrase, AV_PELO_ESTILO);
      if (k) { recipe.hair = AV_PELO_ESTILO[k]; matched.push(`pelo:${k}`); hit = true; lastCtx = 'hair'; }
      else if (phrase.includes('afro')) { recipe.hair = 'styleCurly'; matched.push('pelo:afro'); hit = true; lastCtx = 'hair'; }
      const c = has(phrase, AV_PELO_COLOR);
      if (c) { recipe.hairc = [...AV_PELO_COLOR[c]]; matched.push(`pelo-color:${c}`); hit = true; lastCtx = 'hair'; }
      if (phrase.includes('raya')) {
        if (phrase.includes('derecha')) { recipe.hairargs = { ...recipe.hairargs, part: 'R' }; matched.push('raya:R'); hit = true; }
        else { recipe.hairargs = { ...recipe.hairargs, part: 'L' }; matched.push('raya:L'); hit = true; }
      }
    }
    // Ropa: prenda + color (camisa azul), corbata aparte.
    const clothK = has(phrase, AV_ROPA);
    if (clothK) {
      recipe.cloth = AV_ROPA[clothK];
      matched.push(`ropa:${clothK}`);
      hit = true;
      lastCtx = 'cloth';
      const c = colorIn(phrase);
      if (c) { recipe.c1 = [...AV_COLOR[c]]; matched.push(`ropa-color:${c}`); }
    } else {
      const c = colorIn(phrase);
      if (c && !phrase.includes('corbata') && !phrase.includes('pelo') && !phrase.includes('cabello')) {
        recipe.c1 = [...AV_COLOR[c]];
        matched.push(`ropa-color:${c}`);
        hit = true;
      }
    }
    if (phrase.includes('corbata')) {
      const c = colorIn(phrase);
      recipe.tie = c ? [...AV_COLOR[c]] : [...AV_CORBATIN];
      matched.push(`corbata:${c || 'default'}`);
      hit = true;
    }
    // Cara: cejas, boca, vello, lentes, extras.
    const b = has(phrase, AV_CEJA);
    if ((phrase.includes('ceja') || b) && b) { recipe.brow = AV_CEJA[b]; matched.push(`ceja:${b}`); hit = true; }
    const m = has(phrase, AV_BOCA);
    if ((phrase.includes('boca') || phrase.includes('sonrisa') || phrase.includes('mueca') || m) && m) {
      recipe.mouth = AV_BOCA[m]; matched.push(`boca:${m}`); hit = true;
    }
    const f = has(phrase, AV_FACIAL);
    if (f) { recipe.facial = AV_FACIAL[f]; matched.push(`facial:${f}`); hit = true; }
    if (phrase.includes('gafas') || phrase.includes('lentes') || phrase.includes('anteojos')) {
      recipe.glasses = true; matched.push('gafas'); hit = true;
    }
    if (phrase.includes('rubor') || phrase.includes('mejillas') || phrase.includes('sonroj')) {
      recipe.blush = true; matched.push('rubor'); hit = true;
    }
    if (phrase.includes('pesta')) { recipe.lashes = true; matched.push('pestañas'); hit = true; }
    if (phrase.includes('robust') || phrase.includes('gordo') || phrase.includes('corpulent') || phrase.includes('rechoncho')) {
      recipe.heavy = true; matched.push('robusto'); hit = true;
    }
    if (!hit && lastCtx) {
      // Reintento con contexto: modificador huérfano ("pinchos" tras "pelo
      // negro con..."). Solo tablas de la categoría activa, nada más.
      if (lastCtx === 'hair') {
        const k = has(phrase, AV_PELO_ESTILO);
        if (k) { recipe.hair = AV_PELO_ESTILO[k]; matched.push(`pelo:${k} (ctx)`); hit = true; }
        else {
          const c = has(phrase, AV_PELO_COLOR);
          if (c) { recipe.hairc = [...AV_PELO_COLOR[c]]; matched.push(`pelo-color:${c} (ctx)`); hit = true; }
        }
      } else if (lastCtx === 'cloth') {
        const c = colorIn(phrase);
        if (c) { recipe.c1 = [...AV_COLOR[c]]; matched.push(`ropa-color:${c} (ctx)`); hit = true; }
      }
    }
    if (!hit) warnings.push(`no entendí: "${phrase.trim()}"`);
  }
  return { recipe, warnings, matched };
}

/** Valida una receta contra el vocabulario real del engine. Puro. */
function validateAvatarRecipe(recipe, vocab) {
  const errs = [];
  if (!recipe || typeof recipe !== 'object') return ['receta ausente'];
  const V = vocab || {};
  const check = (field, list, label) => {
    if (recipe[field] === undefined) return;
    if (!Array.isArray(list) || !list.includes(recipe[field])) {
      errs.push(`${label || field} '${recipe[field]}' fuera de vocabulario`);
    }
  };
  check('skin', V.skins, 'piel');
  check('hair', V.hairs, 'pelo');
  check('cloth', V.cloths, 'ropa');
  if (recipe.facial !== undefined) check('facial', V.facials, 'facial');
  if (recipe.brow !== undefined) check('brow', V.brows, 'ceja');
  if (recipe.mouth !== undefined) check('mouth', V.mouths, 'boca');
  const rgb = (v, label) => {
    if (v === undefined) return;
    if (!Array.isArray(v) || v.length !== 3 || v.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      errs.push(`${label} RGB inválido`);
    }
  };
  rgb(recipe.hairc, 'pelo-color');
  rgb(recipe.c1, 'ropa-color');
  rgb(recipe.c2, 'ropa-color-sec');
  if (recipe.tie !== undefined) rgb(recipe.tie, 'corbata');
  return errs;
}

/**
 * Compila descripción ES → PNG (vía engine inyectado). El engine es el módulo
 * generado (avatar-engine.cjs): composeAvatar + AVATAR_VOCAB + PORTRAIT_W/H.
 * Devuelve {png, recipe, warnings}. Lanza si la receta no valida (error de
 * programador, nunca de usuario: el parser solo emite valores del vocab).
 */
function compileAvatar(engine, text) {
  if (!engine || typeof engine.composeAvatar !== 'function') {
    throw new Error('engine sin composeAvatar (¿corriste sync-avatar-engine?)');
  }
  const vocab = engine.AVATAR_VOCAB || {};
  const { recipe, warnings, matched } = parseAvatarDesc(text);
  const errs = validateAvatarRecipe(recipe, vocab);
  if (errs.length) throw new Error(`receta inválida: ${errs.join('; ')}`);
  const w = engine.PORTRAIT_W || 18, h = engine.PORTRAIT_H || 28;
  const buf = engine.composeAvatar(recipe);
  if (!(buf instanceof Uint8ClampedArray) || buf.length !== w * h * 4) {
    throw new Error('el engine devolvió un buffer inesperado');
  }
  const px = (x, y) => {
    const o = (y * w + x) * 4;
    return [buf[o], buf[o + 1], buf[o + 2], buf[o + 3]];
  };
  return { png: encodeRGBA(w, h, px), recipe, warnings, matched, w, h };
}

module.exports = {
  encodeRGBA, decodePNG, blankCanvas, verifyAvatar, multipartEdit, editImageEndpoint,
  parseAvatarDesc, validateAvatarRecipe, compileAvatar,
  AV_DEFAULT_RECIPE, AVATAR_W: 18, AVATAR_H: 28,
};
