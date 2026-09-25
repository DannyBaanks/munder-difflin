'use strict';
/**
 * avatar-spec — normalizador ES/DSL -> avatar-spec v1 (normativo: AVATAR_SPEC.md).
 *
 * El LLM traduce intención; este módulo la convierte en spec válido o la
 * rechaza con motivo + corrección. Nunca inventa geometría ni adivina:
 * categoría explícita sin match -> INVALID_ENUM con `available` (bucle de
 * corrección del modelo); frase sin categoría -> warning (como parseAvatarDesc).
 *
 * Gramática de frases y matching copiados de `parseAvatarDesc`
 * (lib-avatar.cjs:317-430): mismos separadores (`,;.` + ` y ` + ` con `),
 * longest-key-first, claves con espacio por substring y resto por palabra.
 * Lo único nuevo es el VALOR: IDs del spec en vez de valores del engine.
 *
 * Sin dependencias (builtins de node). Puro: texto -> {ok,spec|error}.
 */

const SPEC_ID = 'avatar-spec/1';

// Vocabularios cerrados v1 (AVATAR_SPEC.md §3).
const HAIR_STYLES = ['short_01', 'floppy_01', 'frame_01', 'bun_01', 'curly_01', 'messy_01', 'recede_01', 'spiky_01', 'bald_01'];
const CLOTHS = ['suit', 'dressshirt', 'polo', 'blouse', 'cardigan', 'sweater'];
const BROWS = ['flat', 'angry', 'raised', 'soft'];
const MOUTHS = ['neutral', 'smile', 'frown', 'grin'];
const FACIALS = ['mustache', 'mustacheSm', 'stubble', 'goatee'];
const EYE_STYLES = ['round_01'];

// ES -> IDs del spec (mismas palabras que las tablas AV_* de lib-avatar;
// valores distintos a propósito: aquí mandan SKIN_0x/HAIR_0x/EYE_0x/CLOTH_*).
const ES_SKIN = {
  clara: 'SKIN_01', blanca: 'SKIN_01', palida: 'SKIN_01',
  morena: 'SKIN_02', bronceada: 'SKIN_02', trigueña: 'SKIN_02',
  marron: 'SKIN_03', cafe: 'SKIN_03',
  oscura: 'SKIN_04', negra: 'SKIN_04', afro: 'SKIN_04',
};
const ES_HAIR_STYLE = {
  corto: 'short_01', corta: 'short_01', raya: 'short_01',
  flequillo: 'floppy_01', lacio: 'floppy_01', lacia: 'floppy_01', caido: 'floppy_01', caida: 'floppy_01',
  largo: 'frame_01', larga: 'frame_01', enmarcado: 'frame_01', enmarcada: 'frame_01', melena: 'frame_01',
  moño: 'bun_01', recogido: 'bun_01', recogida: 'bun_01', chongo: 'bun_01',
  rizado: 'curly_01', rizada: 'curly_01', rizos: 'curly_01',
  despeinado: 'messy_01', despeinada: 'messy_01', desordenado: 'messy_01', desordenada: 'messy_01',
  entradas: 'recede_01', engominado: 'recede_01', engominada: 'recede_01', atras: 'recede_01',
  pinchos: 'spiky_01', puntiagudo: 'spiky_01', puntiaguda: 'spiky_01', punk: 'spiky_01',
  calvo: 'bald_01', calva: 'bald_01', pelon: 'bald_01', pelona: 'bald_01', 'sin pelo': 'bald_01',
};
const ES_HAIR_COLOR = {
  negro: 'HAIR_01', negra: 'HAIR_01', negros: 'HAIR_01',
  castano: 'HAIR_02', castaña: 'HAIR_02', castana: 'HAIR_02', castaños: 'HAIR_02', castanos: 'HAIR_02',
  marron: 'HAIR_03', morena: 'HAIR_03',
  rubio: 'HAIR_04', rubia: 'HAIR_04', rubios: 'HAIR_04',
  pelirrojo: 'HAIR_05', pelirroja: 'HAIR_05', rojo: 'HAIR_05', roja: 'HAIR_05',
  gris: 'HAIR_06', blanco: 'HAIR_07', blanca: 'HAIR_07',
  canoso: 'HAIR_06', canosa: 'HAIR_06',
};
const ES_EYE_COLOR = {
  negros: 'EYE_01', negras: 'EYE_01', negro: 'EYE_01', negra: 'EYE_01', oscuros: 'EYE_01',
  marrones: 'EYE_02', marron: 'EYE_02', cafes: 'EYE_02', cafés: 'EYE_02', cafe: 'EYE_02', miel: 'EYE_05',
  verdes: 'EYE_03', verde: 'EYE_03',
  azules: 'EYE_04', azul: 'EYE_04', celestes: 'EYE_04',
};
const ES_CLOTH = {
  traje: 'suit', sastre: 'suit',
  camisa: 'dressshirt', 'camisa de vestir': 'dressshirt',
  polo: 'polo', playera: 'polo',
  blusa: 'blouse',
  cardigan: 'cardigan', cárdigan: 'cardigan',
  sueter: 'sweater', jersey: 'sweater', sudadera: 'sweater',
};
const ES_COLOR = {
  rojo: 'CLOTH_RED', roja: 'CLOTH_RED', rojos: 'CLOTH_RED', rojas: 'CLOTH_RED',
  azul: 'CLOTH_BLUE', azules: 'CLOTH_BLUE',
  verde: 'CLOTH_GREEN', verdes: 'CLOTH_GREEN',
  negro: 'CLOTH_BLACK', negra: 'CLOTH_BLACK', negros: 'CLOTH_BLACK', negras: 'CLOTH_BLACK',
  blanco: 'CLOTH_WHITE', blanca: 'CLOTH_WHITE', blancos: 'CLOTH_WHITE', blancas: 'CLOTH_WHITE',
  gris: 'CLOTH_SKY', grises: 'CLOTH_SKY',
  rosa: 'CLOTH_PINK', rosas: 'CLOTH_PINK',
  morado: 'CLOTH_PURPLE', morada: 'CLOTH_PURPLE', morados: 'CLOTH_PURPLE', moradas: 'CLOTH_PURPLE',
  violeta: 'CLOTH_PURPLE', violetas: 'CLOTH_PURPLE',
  marron: 'CLOTH_BROWN', marrones: 'CLOTH_BROWN',
  beige: 'CLOTH_BEIGE',
  amarillo: 'CLOTH_YELLOW', amarilla: 'CLOTH_YELLOW', amarillos: 'CLOTH_YELLOW', amarillas: 'CLOTH_YELLOW',
  naranja: 'CLOTH_ORANGE', naranjas: 'CLOTH_ORANGE',
  celeste: 'CLOTH_SKY', celestes: 'CLOTH_SKY',
};
const ES_BROW = { rectas: 'flat', recta: 'flat', enojadas: 'angry', enojada: 'angry', arqueadas: 'raised', arqueada: 'raised', suaves: 'soft', suave: 'soft' };
const ES_MOUTH = { neutra: 'neutral', neutro: 'neutral', sonrisa: 'smile', sonrie: 'smile', sonriente: 'smile', ceño: 'frown', molesta: 'frown', molesto: 'frown', mueca: 'grin', sonrisota: 'grin' };
const ES_FACIAL = { bigote: 'mustache', mostacho: 'mustache', 'bigote corto': 'mustacheSm', perilla: 'goatee', chivo: 'goatee', barba: 'stubble', incipiente: 'stubble', 'barba de dias': 'stubble' };

function avNorm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function hasWord(phrase, table) {
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (k.includes(' ')) { if (phrase.includes(k)) return k; continue; }
    if (new RegExp(`(^| )${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(phrase)) return k;
  }
  return null;
}

// Categoría por palabra completa: evita que "rojo" dispare "ojo" o
// "máscara" dispare "cara" (includes() puro es trampa en español).
function hasCat(phrase, ...words) {
  return words.some((w) => new RegExp(`(^| )${w}( |$)`).test(phrase));
}

// Reclamo explícito de color (PANTONE:/HEX aunque venga malformado):
// si hay reclamo y nada resolvió, es INVALID, no silencio.
function claimsColor(phrase) {
  return /pantone/i.test(phrase) || /#[0-9a-z]/i.test(phrase);
}

function baseSpec() {
  return {
    spec: SPEC_ID,
    body: { template: 'standard_01' },
    skin: 'SKIN_01',
    hair: { style: 'short_01', color: 'HAIR_02' },
    eyes: { style: 'round_01', color: 'EYE_02' },
    eyebrows: 'flat',
    mouth: 'neutral',
    shirt: { style: 'dressshirt', color: 'CLOTH_WHITE' },
    pants: { template: 'standard_01', color: 'CLOTH_BLACK' },
    shoes: { template: 'standard_01', color: 'CLOTH_BLACK' },
    accessory_1: 'none',
  };
}

const invalid = (field, value, available) => ({
  ok: false, error: { code: 'INVALID_ENUM', field, value, available: [...new Set(available)] },
});

/**
 * Resuelve un color en contexto de parte: ID | #rrggbb | PANTONE:.
 * El match corre sobre texto normalizado; el verbatim PANTONE: se extrae
 * del texto crudo (misma frase, sin normalizar) para preservarlo tal cual.
 */
function resolveColor(text, table, field, rawText) {
  const t = text.trim();
  const hex = t.match(/#([0-9a-fA-F]{6})\b/);
  if (hex) return { id: '#' + hex[1].toUpperCase(), custom: null };
  const pm = t.match(/pantone\s*:?\s*(.+)$/i);
  if (pm) {
    const raw = String(rawText == null ? t : rawText).match(/pantone\s*:?\s*(.+)$/i);
    const verbatim = (raw ? raw[1] : pm[1]).trim();
    if (!verbatim) return { err: invalid(field, text.trim(), Object.values(table)) };
    const k = hasWord(avNorm(pm[1]), table);
    if (k) return { id: table[k], custom: { pantone: verbatim } };
    return { err: invalid(field, verbatim, Object.values(table)) };
  }
  const k = hasWord(avNorm(t), table);
  if (k) return { id: table[k], custom: null };
  return null;
}

/**
 * Texto ES -> spec v1. Total: devuelve spec (con warnings) o INVALID_ENUM.
 * Categoría explícita sin match = error con available; sin categoría = warning.
 */
function normalizeAvatarDesc(text) {
  const warnings = [];
  const matched = [];
  const spec = baseSpec();
  const phrases = avNorm(text).split(/[,;.\n]+|\s+y\s+|\s+con\s+/).map((s) => s.trim()).filter(Boolean);
  if (!phrases.length) return { ok: true, spec, warnings: ['descripción vacía: se usó base neutra'], matched };
  // Frases crudas en paralelo (mismo corte, case-insensitive) para el
  // verbatim PANTONE:. Si no alinean, se usa la normalizada (fail-safe).
  const rawPhrases = String(text || '').split(/[,;.\n]+|\s+y\s+|\s+con\s+/i).map((s) => s.trim()).filter(Boolean);
  const useRaw = rawPhrases.length === phrases.length;

  let lastCtx = null;
  for (let pi = 0; pi < phrases.length; pi++) {
    const phrase = phrases[pi];
    const rawPhrase = useRaw ? rawPhrases[pi] : phrase;
    let hit = false;
    const fail = (field, value, available) => ({ ok: false, error: { code: 'INVALID_ENUM', field, value, available: [...new Set(available)] } });
    if (hasCat(phrase, 'piel', 'tez', 'cara')) {
      const k = hasWord(phrase, ES_SKIN);
      if (k) { spec.skin = ES_SKIN[k]; matched.push(`piel:${k}`); hit = true; }
      else return fail('skin', phrase, Object.values(ES_SKIN));
    }
    if (hasCat(phrase, 'pelo', 'cabello', 'cabellera', 'afro')) {
      const k = hasWord(phrase, ES_HAIR_STYLE);
      const c0 = hasWord(phrase, ES_HAIR_COLOR);
      if (k) { spec.hair.style = ES_HAIR_STYLE[k]; matched.push(`pelo:${k}`); hit = true; lastCtx = 'hair'; }
      else if (hasCat(phrase, 'afro')) { spec.hair.style = 'curly_01'; matched.push('pelo:afro'); hit = true; lastCtx = 'hair'; }
      else if (c0) {
        // Estilo pendiente del contexto ("pelo negro con pinchos"): el color
        // sí se entiende; el estilo lo hereda la frase huérfana.
        spec.hair.color = ES_HAIR_COLOR[c0]; matched.push(`pelo-color:${c0}`); hit = true; lastCtx = 'hair';
      }
      else return fail('hair.style', phrase, HAIR_STYLES);
      const c = hasWord(phrase, ES_HAIR_COLOR);
      if (c) { spec.hair.color = ES_HAIR_COLOR[c]; matched.push(`pelo-color:${c}`); hit = true; lastCtx = 'hair'; }
    }
    if (hasCat(phrase, 'ojo', 'ojos')) {
      const c = hasWord(phrase, ES_EYE_COLOR);
      if (c) { spec.eyes.color = ES_EYE_COLOR[c]; matched.push(`ojos:${c}`); hit = true; }
      else return fail('eyes.color', phrase, Object.values(ES_EYE_COLOR));
    }
    const clothK = hasWord(phrase, ES_CLOTH);
    if (clothK) {
      spec.shirt.style = ES_CLOTH[clothK];
      matched.push(`ropa:${clothK}`);
      hit = true;
      lastCtx = 'cloth';
      const c = resolveColor(phrase, ES_COLOR, 'shirt.color', rawPhrase);
      if (c && c.err) return c.err;
      if (c) {
        spec.shirt.color = c.id;
        matched.push(`ropa-color:${c.id}`);
        if (c.custom) spec.custom = { ...(spec.custom || {}), shirt: c.custom };
      } else if (claimsColor(phrase)) {
        return fail('shirt.color', phrase, Object.values(ES_COLOR));
      }
    } else {
      const c = resolveColor(phrase, ES_COLOR, 'shirt.color', rawPhrase);
      const excluded = hasCat(phrase, 'corbata', 'corbatas', 'pelo', 'cabello', 'pantalon', 'pantalones', 'zapato', 'zapatos', 'ojo', 'ojos');
      if (c && !c.err && !excluded) {
        spec.shirt.color = c.id;
        matched.push(`ropa-color:${c.id}`);
        hit = true;
        if (c.custom) spec.custom = { ...(spec.custom || {}), shirt: c.custom };
      } else if (c && c.err && !excluded) {
        return c.err;
      } else if (!c && claimsColor(phrase) && !excluded) {
        return fail('shirt.color', phrase, Object.values(ES_COLOR));
      }
    }
    if (hasCat(phrase, 'pantalon', 'pantalones')) {
      const c = resolveColor(phrase, ES_COLOR, 'pants.color', rawPhrase);
      if (c && !c.err) {
        spec.pants.color = c.id;
        matched.push(`pantalon-color:${c.id}`);
        hit = true;
        if (c.custom) spec.custom = { ...(spec.custom || {}), pants: c.custom };
      } else if (c && c.err) {
        return c.err;
      } else if (claimsColor(phrase)) {
        return fail('pants.color', phrase, Object.values(ES_COLOR));
      } else {
        matched.push('pantalon:default');
        hit = true;
      }
    }
    if (hasCat(phrase, 'zapato', 'zapatos')) {
      const c = resolveColor(phrase, ES_COLOR, 'shoes.color', rawPhrase);
      if (c && !c.err) {
        spec.shoes.color = c.id;
        matched.push(`zapatos-color:${c.id}`);
        hit = true;
        if (c.custom) spec.custom = { ...(spec.custom || {}), shoes: c.custom };
      } else if (c && c.err) {
        return c.err;
      } else if (claimsColor(phrase)) {
        return fail('shoes.color', phrase, Object.values(ES_COLOR));
      } else {
        matched.push('zapatos:default');
        hit = true;
      }
    }
    if (hasCat(phrase, 'corbata', 'corbatas')) {
      const c = resolveColor(phrase, ES_COLOR, 'shirt.tie', rawPhrase);
      if (c && !c.err) {
        spec.shirt.tie = c.id;
        matched.push(`corbata:${c.id}`);
        hit = true;
      } else if (c && c.err) {
        return c.err;
      } else if (claimsColor(phrase)) {
        return fail('shirt.tie', phrase, Object.values(ES_COLOR));
      } else {
        spec.shirt.tie = 'CLOTH_RED';
        matched.push('corbata:default');
        hit = true;
      }
    }
    const b = hasWord(phrase, ES_BROW);
    if ((hasCat(phrase, 'ceja', 'cejas') || b) && b) { spec.eyebrows = ES_BROW[b]; matched.push(`ceja:${b}`); hit = true; }
    const m = hasWord(phrase, ES_MOUTH);
    if ((hasCat(phrase, 'boca', 'sonrisa', 'mueca') || m) && m) {
      spec.mouth = ES_MOUTH[m]; matched.push(`boca:${m}`); hit = true;
    }
    const f = hasWord(phrase, ES_FACIAL);
    if (f) { spec.facial = ES_FACIAL[f]; matched.push(`facial:${f}`); hit = true; }
    if (hasCat(phrase, 'gafas', 'lentes', 'anteojos')) {
      spec.glasses = true; matched.push('gafas'); hit = true;
    }
    if (hasCat(phrase, 'rubor', 'mejillas', 'sonrojo', 'sonrojado') || phrase.includes('sonroj')) {
      spec.blush = true; matched.push('rubor'); hit = true;
    }
    if (phrase.includes('pesta')) { spec.lashes = true; matched.push('pestañas'); hit = true; }
    if (hasCat(phrase, 'robusto', 'robusta', 'gordo', 'gorda', 'corpulento', 'corpulenta', 'rechoncho', 'rechoncha') || phrase.includes('robust') || phrase.includes('corpulent')) {
      spec.body.heavy = true; matched.push('robusto'); hit = true;
    }
    if (!hit && lastCtx) {
      if (lastCtx === 'hair') {
        const k = hasWord(phrase, ES_HAIR_STYLE);
        if (k) { spec.hair.style = ES_HAIR_STYLE[k]; matched.push(`pelo:${k} (ctx)`); hit = true; }
        else {
          const c = hasWord(phrase, ES_HAIR_COLOR);
          if (c) { spec.hair.color = ES_HAIR_COLOR[c]; matched.push(`pelo-color:${c} (ctx)`); hit = true; }
        }
      } else if (lastCtx === 'cloth') {
        const c = hasWord(phrase, ES_COLOR);
        if (c) { spec.shirt.color = ES_COLOR[c]; matched.push(`ropa-color:${c} (ctx)`); hit = true; }
      }
    }
    if (!hit) warnings.push(`no entendí: "${phrase.trim()}"`);
  }
  const verr = validateAvatarSpec(spec);
  if (!verr.ok) return verr;
  return { ok: true, spec, warnings, matched };
}

// ─── DSL ────────────────────────────────────────────────────────────────────

const DSL_FIELDS = new Set(['body', 'skin', 'hair', 'eyes', 'eyebrows', 'mouth', 'facial', 'glasses', 'blush', 'lashes', 'shirt', 'pants', 'shoes', 'accessory_1']);
const DSL_BOOL = new Set(['glasses', 'blush', 'lashes']);

/**
 * Bloque `avatar { … }` -> spec v1. Una declaración por línea, `#`
 * comentarios, orden libre. Bare flags (glasses) = true.
 */
function parseAvatarDSL(text) {
  const schema = (msg, field) => ({ ok: false, error: { code: 'SCHEMA', field: field || '$', value: msg } });
  const lines = String(text || '').split('\n');
  const open = lines.findIndex((l) => l.trim() === 'avatar {' || l.trim().startsWith('avatar {'));
  const close = lines.findIndex((l) => l.trim() === '}');
  if (open < 0 || close < 0 || close < open) return schema('bloque avatar { … } ausente o mal cerrado', '$');
  const spec = baseSpec();
  delete spec.accessory_1;
  for (let n = open + 1; n < close; n++) {
    const raw = lines[n].trim();
    if (!raw || raw.startsWith('#')) continue;
    const toks = raw.split(/\s+/);
    const field = toks[0];
    if (!DSL_FIELDS.has(field)) return schema(`campo desconocido '${field}'`, field);
    const rest = toks.slice(1);
    if (DSL_BOOL.has(field)) {
      if (rest.length) return schema(`'${field}' no lleva valor`, field);
      spec[field] = true;
      continue;
    }
    if (field === 'body') {
      if (rest[0] !== 'standard_01') return invalid('body.template', rest[0], ['standard_01']);
      continue;
    }
    if (field === 'skin') {
      if (!/^SKIN_0[1-4]$/.test(rest[0] || '')) return invalid('skin', rest[0], ['SKIN_01', 'SKIN_02', 'SKIN_03', 'SKIN_04']);
      spec.skin = rest[0];
      continue;
    }
    if (field === 'hair') {
      if (!HAIR_STYLES.includes(rest[0])) return invalid('hair.style', rest[0], HAIR_STYLES);
      spec.hair.style = rest[0];
      if (rest[1]) {
        if (!isSpecColor(rest[1])) return invalid('hair.color', rest[1], ['HAIR_01…HAIR_07', '#rrggbb', 'PANTONE:…']);
        spec.hair.color = rest[1];
      }
      continue;
    }
    if (field === 'eyes') {
      if (!EYE_STYLES.includes(rest[0])) return invalid('eyes.style', rest[0], EYE_STYLES);
      spec.eyes.style = rest[0];
      if (rest[1]) {
        if (!isSpecColor(rest[1])) return invalid('eyes.color', rest[1], ['EYE_01…EYE_05', '#rrggbb', 'PANTONE:…']);
        spec.eyes.color = rest[1];
      }
      continue;
    }
    if (field === 'eyebrows') {
      if (!BROWS.includes(rest[0])) return invalid('eyebrows', rest[0], BROWS);
      spec.eyebrows = rest[0];
      continue;
    }
    if (field === 'mouth') {
      if (!MOUTHS.includes(rest[0])) return invalid('mouth', rest[0], MOUTHS);
      spec.mouth = rest[0];
      continue;
    }
    if (field === 'facial') {
      if (!FACIALS.includes(rest[0])) return invalid('facial', rest[0], FACIALS);
      spec.facial = rest[0];
      continue;
    }
    if (field === 'shirt') {
      if (!CLOTHS.includes(rest[0])) return invalid('shirt.style', rest[0], CLOTHS);
      spec.shirt.style = rest[0];
      if (rest[1]) {
        if (!isSpecColor(rest[1])) return invalid('shirt.color', rest[1], ['CLOTH_*', '#rrggbb', 'PANTONE:…']);
        spec.shirt.color = rest[1];
      }
      const ti = rest.indexOf('tie');
      if (ti >= 0) {
        if (!isSpecColor(rest[ti + 1] || '')) return invalid('shirt.tie', rest[ti + 1], ['CLOTH_*', '#rrggbb', 'PANTONE:…']);
        spec.shirt.tie = rest[ti + 1];
      }
      continue;
    }
    if (field === 'pants' || field === 'shoes') {
      const key = field === 'pants' ? 'pants' : 'shoes';
      const tpl = field === 'pants' ? rest[0] : rest[0];
      if (tpl !== 'standard_01') return invalid(key + '.template', tpl, ['standard_01']);
      spec[key].template = tpl;
      if (rest[1]) {
        if (!isSpecColor(rest[1])) return invalid(key + '.color', rest[1], ['CLOTH_*', '#rrggbb', 'PANTONE:…']);
        spec[key].color = rest[1];
      }
      continue;
    }
    if (field === 'accessory_1') {
      if (rest[0] !== 'none') return invalid('accessory_1', rest[0], ['none']);
      spec.accessory_1 = 'none';
      continue;
    }
  }
  spec.accessory_1 = spec.accessory_1 || 'none';
  const verr = validateAvatarSpec(spec);
  if (!verr.ok) return verr;
  return { ok: true, spec, warnings: [], matched: ['dsl'] };
}

function isSpecColor(v) {
  return typeof v === 'string' && /^(SKIN_0[1-4]|HAIR_0[1-7]|EYE_0[1-5]|CLOTH_[A-Z]+|#[0-9A-Fa-f]{6}|PANTONE:.+)$/.test(v);
}

// ─── validador permanente (semántica de avatar-spec.schema.json) ────────────

function validateAvatarSpec(spec) {
  const fail = (code, field, value) => ({ ok: false, error: { code, field, value } });
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return fail('SCHEMA', '$', 'spec ausente');
  if (spec.spec !== SPEC_ID) return fail('SCHEMA', 'spec', spec.spec);
  const known = new Set(['spec', 'body', 'skin', 'hair', 'eyes', 'eyebrows', 'mouth', 'facial', 'glasses', 'blush', 'lashes', 'shirt', 'pants', 'shoes', 'accessory_1', 'custom']);
  for (const k of Object.keys(spec)) if (!known.has(k)) return fail('SCHEMA', k, 'campo desconocido');
  for (const k of ['body', 'skin', 'hair', 'eyes', 'shirt', 'pants', 'shoes']) {
    if (!(k in spec)) return fail('SCHEMA', k, 'campo requerido ausente');
  }
  if (!spec.body || spec.body.template !== 'standard_01') return fail('SCHEMA', 'body.template', spec.body && spec.body.template);
  if (!/^SKIN_0[1-4]$/.test(spec.skin || '')) return fail('INVALID_ENUM', 'skin', spec.skin);
  const h = spec.hair || {};
  if (!HAIR_STYLES.includes(h.style)) return fail('INVALID_ENUM', 'hair.style', h.style);
  if (!isSpecColor(h.color)) return fail('INVALID_ENUM', 'hair.color', h.color);
  const e = spec.eyes || {};
  if (!EYE_STYLES.includes(e.style)) return fail('INVALID_ENUM', 'eyes.style', e.style);
  if (!isSpecColor(e.color)) return fail('INVALID_ENUM', 'eyes.color', e.color);
  if ('eyebrows' in spec && !BROWS.includes(spec.eyebrows)) return fail('INVALID_ENUM', 'eyebrows', spec.eyebrows);
  if ('mouth' in spec && !MOUTHS.includes(spec.mouth)) return fail('INVALID_ENUM', 'mouth', spec.mouth);
  if ('facial' in spec && !FACIALS.includes(spec.facial)) return fail('INVALID_ENUM', 'facial', spec.facial);
  for (const k of ['glasses', 'blush', 'lashes']) {
    if (k in spec && typeof spec[k] !== 'boolean') return fail('SCHEMA', k, spec[k]);
  }
  const s = spec.shirt || {};
  if (!CLOTHS.includes(s.style)) return fail('INVALID_ENUM', 'shirt.style', s.style);
  if (!isSpecColor(s.color)) return fail('INVALID_ENUM', 'shirt.color', s.color);
  if ('tie' in s && !isSpecColor(s.tie)) return fail('INVALID_ENUM', 'shirt.tie', s.tie);
  for (const k of ['pants', 'shoes']) {
    const g = spec[k] || {};
    if (g.template !== 'standard_01') return fail('INVALID_ENUM', k + '.template', g.template);
    if (!isSpecColor(g.color)) return fail('INVALID_ENUM', k + '.color', g.color);
  }
  if ('accessory_1' in spec && spec.accessory_1 !== 'none') return fail('INVALID_ENUM', 'accessory_1', spec.accessory_1);
  if ('custom' in spec && (typeof spec.custom !== 'object' || spec.custom === null)) return fail('SCHEMA', 'custom', spec.custom);
  return { ok: true };
}

/**
 * Paleta normativa v1 (AVATAR_SPEC.md §4): ID -> [r,g,b]. ÚNICA fuente en
 * código (el .md manda en prosa; esto manda en runtime). El renderer la usa
 * para resolver IDs; HEX literales se parsean aparte (specRgb() en el
 * llamador o M2). PANTONE: crudos ya vienen resueltos a ID por el
 * normalizador (el verbatim viaja en spec.custom).
 */
const SPEC_PALETTE = {
  SKIN_01: [247, 201, 170], SKIN_02: [214, 162, 116],
  SKIN_03: [158, 112, 78], SKIN_04: [120, 80, 56],
  HAIR_01: [30, 22, 18], HAIR_02: [92, 60, 34], HAIR_03: [110, 75, 45],
  HAIR_04: [190, 158, 95], HAIR_05: [150, 70, 40], HAIR_06: [168, 164, 154],
  HAIR_07: [228, 228, 228],
  EYE_01: [46, 38, 42], EYE_02: [107, 66, 38], EYE_03: [110, 174, 111],
  EYE_04: [110, 140, 180], EYE_05: [150, 104, 46],
  CLOTH_RED: [176, 65, 58], CLOTH_BLUE: [110, 140, 180],
  CLOTH_GREEN: [110, 174, 111], CLOTH_YELLOW: [232, 200, 90],
  CLOTH_BLACK: [58, 58, 68], CLOTH_WHITE: [240, 238, 234],
  CLOTH_PINK: [236, 174, 192], CLOTH_PURPLE: [150, 146, 170],
  CLOTH_BROWN: [150, 120, 86], CLOTH_BEIGE: [236, 220, 190],
  CLOTH_ORANGE: [210, 130, 60], CLOTH_SKY: [140, 190, 220],
};

module.exports = {
  SPEC_ID, HAIR_STYLES, CLOTHS, BROWS, MOUTHS, FACIALS, EYE_STYLES,
  SPEC_PALETTE,
  normalizeAvatarDesc, parseAvatarDSL, validateAvatarSpec, isSpecColor,
};
