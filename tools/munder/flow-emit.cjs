'use strict';
/**
 * flow-emit — receta del engine -> programa .flowpaint determinista.
 *
 * Estilo-flow: busto plano y simplificado (NO es el retrato procedural del
 * engine local). Misma receta de entrada, otra mano: sirve para que modelos
 * SIN motor de imagen (todos menos GPT-con-engine) creen avatares desde
 * texto puro, via `flow paint` (determinista, DENY fail-closed).
 *
 * Solo datos compartidos con el canon: tonos de piel (espejo documentado de
 * portraitArt.ts via avatar-engine.cjs, que NO se toca: es GENERATED) y las
 * coordenadas de ojos/boca (las mismas regiones que AVATAR_REGIONS). La
 * geometria del busto es propia y minima; los goldens la fijan.
 *
 * Sin dependencias (builtins de node). El spawn a flow vive aqui tambien
 * para no regar child_process por munder: `runFlowProgram()`.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateAvatarRecipe } = require('./lib-avatar.cjs');

// Espejo de SKIN (portraitArt.ts): solo la paleta, sin geometria.
const SKIN = {
  light: { hi: [255, 221, 189], base: [247, 201, 170], sh: [212, 158, 126], line: [168, 112, 82] },
  tan: { hi: [232, 182, 136], base: [214, 162, 116], sh: [176, 126, 86], line: [138, 92, 60] },
  brown: { hi: [180, 130, 94], base: [158, 112, 78], sh: [124, 86, 58], line: [90, 60, 40] },
  dark: { hi: [142, 98, 70], base: [120, 80, 56], sh: [94, 62, 42], line: [64, 42, 28] },
};

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
function shades(rgb, dl = 1.22, dd = 0.68) {
  return [
    [clamp(rgb[0] * dl), clamp(rgb[1] * dl), clamp(rgb[2] * dl)],
    [rgb[0], rgb[1], rgb[2]],
    [clamp(rgb[0] * dd), clamp(rgb[1] * dd), clamp(rgb[2] * dd)],
  ];
}

const WHITE = [250, 248, 244], PUP = [46, 38, 42], MOUTH = [158, 86, 80];
const LASH = [54, 40, 48], GLINT = [252, 250, 248], BLUSH = [235, 150, 140];
const FRAME = [60, 54, 62], LENS = [236, 240, 246], SHIRT = [238, 238, 236];

/**
 * Receta -> programa .flowpaint (texto). Puro y determinista: misma receta,
 * mismo programa, siempre. Lanza si la receta no valida (error de
 * programador: el parser solo emite vocabulario).
 */
// ─── secciones compartidas (busto 18×28 y cuerpo 18×32 usan la misma mano) ───
// S = {L, color, rect, line, px}. Los builders solo emiten ops sobre nombres
// de paleta; cada emisor define primero su paleta. Orden de emisión idéntico
// al original: mover código aquí no cambia ni una línea (goldens lo fijan).
function makeSink() {
  const L = [];
  return {
    L,
    color: (name, c, a) => L.push(`COLOR ${name} ${c[0]} ${c[1]} ${c[2]}${a === undefined ? '' : ' ' + a}`),
    rect: (x, y, w, h, c) => L.push(`RECT ${x} ${y} ${w} ${h} ${c}`),
    line: (x0, y0, x1, y1, c) => L.push(`LINE ${x0} ${y0} ${x1} ${y1} ${c}`),
    px: (x, y, c) => L.push(`PIXEL ${x} ${y} ${c}`),
  };
}

// r con forma receta-legacy: {skin,hairc,hair,hairargs,cloth,c1,c2,tie,brow,
// mouth,blush,lashes,glasses,facial,heavy}. El emisor spec adapta (M2).
function paintPalette(S, r, extra) {
  const s = SKIN[r.skin];
  const [, hbase, hsh] = shades(r.hairc);
  const [, cbase, csh] = shades(r.c1);
  S.color('piel', s.base); S.color('piel_hi', s.hi); S.color('piel_sh', s.sh); S.color('linea', s.line);
  S.color('pelo', hbase); S.color('pelo_sh', hsh);
  S.color('ropa', cbase); S.color('ropa_sh', csh);
  if (r.cloth === 'cardigan') S.color('inner', r.c2 ? shades(r.c2)[1] : [235, 233, 226]);
  if (r.cloth === 'polo' && r.c2) S.color('acento', shades(r.c2)[1]);
  if (r.tie) { S.color('corb', r.tie); S.color('corb_hi', shades(r.tie)[0]); }
  S.color('ojow', WHITE); S.color('pup', PUP); S.color('boca', MOUTH);
  if (r.lashes) { S.color('lash', LASH); S.color('glint', GLINT); }
  if (r.blush) S.color('rubor', BLUSH, 140);
  if (r.glasses) { S.color('marco', FRAME); S.color('brillo', LENS); }
  if (r.facial === 'stubble') S.color('barb', hsh, 150);
  for (const [name, c] of (extra || [])) S.color(name, c);
}

function paintHeadFace(S, r, neckH, iris) {
  const { rect, line, px } = S;
  // ── cabeza (x4..13, y4..16, esquinas redondas por omisión) ──
  rect(5, 4, 8, 13, 'piel');
  rect(4, 5, 10, 11, 'piel');
  for (const y of [9, 10, 11]) { px(3, y, 'piel'); px(14, y, 'piel'); }
  rect(7, 17, 4, neckH, 'piel_sh');
  if (r.heavy) {
    rect(3, 12, 1, 3, 'piel'); rect(14, 12, 1, 3, 'piel');
    rect(6, 17, 6, 2, 'piel');
  }

  // ── cara (ojos y=9, boca y=14: mismas regiones del canon) ──
  for (const x of [5, 6, 10, 11]) px(x, 9, 'ojow');
  px(6, 9, iris); px(10, 9, iris);
  if (r.lashes) {
    line(5, 8, 6, 8, 'lash'); line(10, 8, 11, 8, 'lash');
    px(5, 9, 'glint'); px(10, 9, 'glint');
  }
  const brow = r.brow || 'flat';
  if (brow === 'flat') { line(5, 7, 6, 7, 'linea'); line(10, 7, 11, 7, 'linea'); }
  else if (brow === 'angry') { px(5, 8, 'linea'); px(6, 7, 'linea'); px(10, 7, 'linea'); px(11, 8, 'linea'); }
  else if (brow === 'raised') { line(5, 6, 6, 6, 'linea'); line(10, 6, 11, 6, 'linea'); }
  else if (brow === 'soft') { px(5, 7, 'linea'); px(11, 7, 'linea'); px(6, 7, 'piel_sh'); px(10, 7, 'piel_sh'); }
  px(8, 11, 'piel_sh'); px(8, 12, 'piel_sh'); px(7, 12, 'piel_sh');
  const mouth = r.mouth || 'neutral';
  if (mouth === 'neutral') line(7, 14, 10, 14, 'boca');
  else if (mouth === 'smile') { line(7, 14, 10, 14, 'boca'); px(6, 13, 'boca'); px(11, 13, 'boca'); }
  else if (mouth === 'frown') { line(7, 15, 10, 15, 'boca'); px(6, 14, 'boca'); px(11, 14, 'boca'); }
  else if (mouth === 'grin') { line(7, 13, 10, 13, 'boca'); line(7, 14, 10, 14, 'boca'); px(6, 13, 'boca'); px(11, 13, 'boca'); }
  if (r.blush) { px(5, 12, 'rubor'); px(12, 12, 'rubor'); }

  // ── vello facial (color pelo) ──
  if (r.facial === 'mustache') { line(6, 13, 10, 13, 'pelo'); px(6, 12, 'pelo'); px(10, 12, 'pelo'); }
  else if (r.facial === 'mustacheSm') line(7, 13, 9, 13, 'pelo');
  else if (r.facial === 'goatee') { line(7, 13, 10, 13, 'pelo'); px(8, 14, 'pelo'); px(9, 14, 'pelo'); px(8, 15, 'pelo'); px(9, 15, 'pelo'); }
  else if (r.facial === 'stubble') {
    for (const [x, y] of [[5, 14], [6, 15], [8, 15], [10, 15], [11, 14], [12, 13], [4, 13]]) px(x, y, 'barb');
  }
}

function paintHair(S, r) {
  const { rect, line, px } = S;
  const hair = r.hair, ha = r.hairargs || {};
  const sides = (y0, y1) => { for (let y = y0; y <= y1; y++) { px(3, y, 'pelo'); px(14, y, 'pelo'); } };
  if (hair === 'styleShort') {
    rect(4, 2, 10, 3, 'pelo');
    line(3, 3, 14, 3, 'pelo');
    sides(6, 8);
    const hx = (ha.part || 'L') === 'L' ? 6 : 11;
    line(hx, 2, hx, 5, 'pelo_sh');
    if (ha.recede) px(8, 5, 'pelo');
  } else if (hair === 'styleFloppy') {
    rect(4, 2, 10, 3, 'pelo');
    rect(3, 4, 12, 2, 'pelo');
    line(6, 6, 11, 6, 'pelo');
    sides(6, 8);
    for (const x of [9, 10, 11]) px(x, 7, 'pelo');
  } else if (hair === 'styleFrame') {
    const len = Math.min(ha.length ?? 17, 27), vol = ha.vol ?? 1;
    rect(3, 2, 12, 4, 'pelo');
    for (let dx = 0; dx < vol; dx++) {
      line(3 - dx, 6, 3 - dx, len, 'pelo');
      line(14 + dx, 6, 14 + dx, len, 'pelo');
    }
    line(4, 6, 4, len, 'pelo'); line(13, 6, 13, len, 'pelo');
  } else if (hair === 'styleBun') {
    rect(4, 3, 10, 3, 'pelo');
    line(6, 6, 11, 6, 'pelo');
    sides(6, 8);
    rect(7, 0, 4, 2, 'pelo');
  } else if (hair === 'styleCurly') {
    rect(4, 3, 10, 3, 'pelo');
    for (const [x, y] of [[5, 2], [7, 2], [9, 2], [11, 2], [3, 4], [14, 4], [3, 5], [14, 5], [3, 6], [14, 6], [3, 7], [14, 7]]) px(x, y, 'pelo');
    line(6, 6, 11, 6, 'pelo');
  } else if (hair === 'styleMessy') {
    const len = Math.min(ha.length ?? 8, 27);
    rect(3, 2, 12, 4, 'pelo');
    for (const [x, y] of [[5, 1], [9, 1], [13, 1], [3, 2], [7, 2], [11, 2]]) px(x, y, 'pelo');
    line(6, 6, 11, 6, 'pelo');
    line(3, 6, 3, len, 'pelo'); line(14, 6, 14, len, 'pelo');
  } else if (hair === 'styleRecede') {
    line(4, 4, 13, 4, 'pelo');
    sides(4, 9);
    line(4, 4, 13, 4, 'pelo_sh');
  } else if (hair === 'styleSpiky') {
    rect(4, 3, 10, 3, 'pelo');
    for (const [x, y] of [[5, 2], [7, 1], [9, 2], [11, 1], [6, 2], [8, 2], [10, 2], [12, 2]]) px(x, y, 'pelo');
    line(6, 6, 11, 6, 'pelo');
    sides(6, 7);
  } else if (hair === 'styleBald') {
    const top = ha.recede ? 8 : 6;
    for (let y = top; y <= 10; y++) { px(3, y, 'pelo'); px(14, y, 'pelo'); }
    for (const x of [7, 8, 9]) px(x, 2, 'piel_hi');
  }
}

function paintGlasses(S, r) {
  if (!r.glasses) return;
  const { line, px } = S;
  line(5, 8, 6, 8, 'marco'); line(5, 10, 6, 10, 'marco');
  px(4, 9, 'marco'); px(7, 9, 'marco'); px(4, 8, 'marco'); px(7, 8, 'marco');
  line(10, 8, 11, 8, 'marco'); line(10, 10, 11, 10, 'marco');
  px(9, 9, 'marco'); px(12, 9, 'marco'); px(9, 8, 'marco'); px(12, 8, 'marco');
  px(8, 8, 'marco');
  px(4, 8, 'brillo'); px(9, 8, 'brillo');
}

function paintTorsoBust(S, r) {
  const { line, px } = S;
  // ── torso busto (y19..27) ──
  const rows = r.heavy
    ? [[19, 5, 12], [20, 3, 14], [21, 2, 15], [22, 1, 16], [23, 1, 16], [24, 0, 17], [25, 0, 17], [26, 0, 17], [27, 0, 17]]
    : [[19, 6, 11], [20, 4, 13], [21, 3, 14], [22, 2, 15], [23, 2, 15], [24, 1, 16], [25, 1, 16], [26, 1, 16], [27, 1, 16]];
  for (const [y, a, b] of rows) S.L.push(`RECT ${a} ${y} ${b - a + 1} 1 ropa`);
  const cloth = r.cloth;
  if (cloth === 'suit') {
    for (const [x, y] of [[8, 19], [9, 19], [7, 20], [8, 20], [9, 20], [10, 20], [8, 21], [9, 21]]) px(x, y, 'ropa_sh');
    if (r.tie) { line(8, 20, 8, 25, 'corb'); line(9, 20, 9, 25, 'corb'); px(8, 20, 'corb_hi'); }
  } else if (cloth === 'dressshirt') {
    for (const y of [20, 22, 24, 26]) px(8, y, 'ropa_sh');
    if (r.tie) { line(8, 19, 8, 25, 'corb'); line(9, 19, 9, 25, 'corb'); }
  } else if (cloth === 'polo') {
    for (const [x, y] of [[6, 19], [7, 19], [10, 19], [11, 19]]) px(x, y, 'ropa_sh');
    px(8, 20, 'ropa_sh'); px(8, 22, 'ropa_sh');
    px(7, 20, r.c2 ? 'acento' : 'ropa_sh'); px(9, 20, r.c2 ? 'acento' : 'ropa_sh');
  } else if (cloth === 'blouse') {
    for (const [x, y] of [[7, 19], [8, 19], [9, 19], [10, 19], [8, 20], [9, 20]]) px(x, y, 'piel_sh');
  } else if (cloth === 'cardigan') {
    line(8, 19, 8, 26, 'inner'); line(9, 19, 9, 26, 'inner');
  } else if (cloth === 'sweater') {
    line(6, 19, 11, 19, 'ropa_sh');
  }
}

/**
 * Receta -> programa .flowpaint (texto). Puro y determinista: misma receta,
 * mismo programa, siempre. Lanza si la receta no valida (error de
 * programador: el parser solo emite vocabulario).
 */
function emitFlowProgram(r) {
  const vocab = { skins: Object.keys(SKIN),
    hairs: ['styleShort', 'styleFloppy', 'styleFrame', 'styleBun', 'styleCurly', 'styleMessy', 'styleRecede', 'styleSpiky', 'styleBald'],
    cloths: ['suit', 'dressshirt', 'polo', 'blouse', 'cardigan', 'sweater'],
    facials: ['mustache', 'mustacheSm', 'stubble', 'goatee'],
    brows: ['flat', 'angry', 'raised', 'soft'],
    mouths: ['neutral', 'smile', 'frown', 'grin'] };
  const errs = validateAvatarRecipe(r, vocab);
  if (errs.length) throw new Error(`receta inválida para flow: ${errs.join('; ')}`);

  const S = makeSink();
  S.L.push('# estilo-flow (munder): busto simplificado desde receta. Determinista.');
  S.L.push('CANVAS 18 28');
  paintPalette(S, r, []);
  paintHeadFace(S, r, 2, 'pup');
  paintHair(S, r);
  paintGlasses(S, r);
  paintTorsoBust(S, r);
  S.L.push('SAVE avatar-flow.png');
  return S.L.join('\n') + '\n';
}

// ─── cuerpo completo 18×32 desde avatar-spec v1 ─────────────────────────────
// Cabeza/cara/pelo/gafas idénticos al busto (misma cabeza del canon);
// torso escena + piernas según AVATAR_SPEC.md §1 (evidencia: drawSceneTorso
// y drawSceneLegs del engine). El spec entra con IDs; aquí se resuelven a
// RGB vía SPEC_PALETTE (única fuente en código) o HEX literal.
const { validateAvatarSpec, SPEC_PALETTE } = require('./avatar-spec.cjs');

const SPEC_SKIN_TONE = { SKIN_01: 'light', SKIN_02: 'tan', SKIN_03: 'brown', SKIN_04: 'dark' };
const SPEC_HAIR_STYLE = {
  short_01: 'styleShort', floppy_01: 'styleFloppy', frame_01: 'styleFrame',
  bun_01: 'styleBun', curly_01: 'styleCurly', messy_01: 'styleMessy',
  recede_01: 'styleRecede', spiky_01: 'styleSpiky', bald_01: 'styleBald',
};

function specRgb(v) {
  if (SPEC_PALETTE[v]) return SPEC_PALETTE[v];
  const m = /^#([0-9A-Fa-f]{6})$/.exec(v || '');
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  throw new Error(`color del spec sin resolver: ${v}`);
}

function paintTorsoScene(S, r) {
  const { line, px } = S;
  // ── torso escena (y18..24; coords de drawSceneTorso) ──
  const rows = r.heavy
    ? [[18, 3, 14], [19, 2, 15], [20, 2, 15], [21, 2, 15], [22, 1, 16], [23, 1, 16], [24, 1, 16]]
    : [[18, 4, 13], [19, 3, 14], [20, 4, 13], [21, 4, 13], [22, 2, 15], [23, 2, 15], [24, 2, 15]];
  for (const [y, a, b] of rows) S.L.push(`RECT ${a} ${y} ${b - a + 1} 1 ropa`);
  const cloth = r.cloth;
  if (cloth === 'suit') {
    for (const [x, y] of [[8, 18], [9, 18], [7, 19], [8, 19], [9, 19], [10, 19], [8, 20], [9, 20]]) px(x, y, 'ropa_sh');
    for (const [x, y] of [[6, 19], [7, 20], [11, 19], [10, 20]]) px(x, y, 'ropa_sh');
    if (r.tie) { line(8, 19, 8, 24, 'corb'); line(9, 19, 9, 24, 'corb'); px(8, 19, 'corb_hi'); }
  } else if (cloth === 'dressshirt') {
    for (const [x, y] of [[6, 18], [7, 18], [10, 18], [11, 18], [7, 19], [10, 19]]) px(x, y, 'ropa_sh');
    if (r.tie) { line(8, 18, 8, 24, 'corb'); line(9, 18, 9, 24, 'corb'); }
    else for (const y of [20, 22, 24]) px(8, y, 'ropa_sh');
  } else if (cloth === 'polo') {
    for (const [x, y] of [[6, 18], [7, 18], [10, 18], [11, 18]]) px(x, y, 'ropa_sh');
    px(8, 19, 'ropa_sh'); px(8, 21, 'ropa_sh');
  } else if (cloth === 'blouse') {
    for (const [x, y] of [[7, 18], [8, 18], [9, 18], [10, 18], [8, 19], [9, 19]]) px(x, y, 'piel_sh');
  } else if (cloth === 'cardigan') {
    line(8, 18, 8, 24, 'inner'); line(9, 18, 9, 24, 'inner');
    for (const [x, y] of [[6, 18], [7, 18], [10, 18], [11, 18]]) px(x, y, 'ropa_sh');
  } else if (cloth === 'sweater') {
    for (const [x, y] of [[6, 18], [7, 18], [8, 18], [9, 18], [10, 18], [11, 18]]) px(x, y, 'ropa_sh');
  }
}

function paintLegs(S) {
  // ── piernas (y25..30) + pies (y31): coords de drawSceneLegs ──
  // Colores por nombres de paleta ('pantalon', 'zapatos'): los define el
  // emisor antes de llamar. Parado quieto (fase 0): ambos pies en y31.
  for (const [lx0, lx1] of [[5, 7], [10, 12]]) {
    S.L.push(`RECT ${lx0} 25 ${lx1 - lx0 + 1} 6 pantalon`);
    S.L.push(`RECT ${lx0} 31 ${lx1 - lx0 + 1} 1 zapatos`);
  }
}

/**
 * Spec v1 -> programa .flowpaint cuerpo completo 18×32. Puro y
 * determinista. Lanza si el spec no valida (validateAvatarSpec).
 */
function emitFullBodyProgram(spec) {
  const v = validateAvatarSpec(spec);
  if (!v.ok) throw new Error(`spec inválido: ${v.error.code} ${v.error.field}`);
  const tone = SPEC_SKIN_TONE[spec.skin];
  const r = {
    skin: tone,
    hairc: specRgb(spec.hair.color),
    hair: SPEC_HAIR_STYLE[spec.hair.style],
    hairargs: {},
    cloth: spec.shirt.style,
    c1: specRgb(spec.shirt.color),
    c2: undefined,
    tie: spec.shirt.tie ? specRgb(spec.shirt.tie) : undefined,
    brow: spec.eyebrows || 'flat',
    mouth: spec.mouth || 'neutral',
    blush: !!spec.blush,
    lashes: !!spec.lashes,
    glasses: !!spec.glasses,
    facial: spec.facial,
    heavy: !!(spec.body && spec.body.heavy),
  };
  const pants = specRgb(spec.pants.color);
  const shoes = specRgb(spec.shoes.color);
  const iris = specRgb(spec.eyes.color);

  const S = makeSink();
  S.L.push('# estilo-spec (munder): cuerpo completo 18x32 desde avatar-spec v1. Determinista.');
  S.L.push('CANVAS 18 32');
  paintPalette(S, r, [['pantalon', pants], ['zapatos', shoes], ['iris', iris]]);
  paintTorsoScene(S, r);
  paintLegs(S);
  paintHeadFace(S, r, 1, 'iris');
  paintHair(S, r);
  paintGlasses(S, r);
  S.L.push('SAVE avatar-spec-18x32.png');
  return S.L.join('\n') + '\n';
}

// ─── localización + ejecución de flow ───────────────────────────────────────

// Checkout hermano (clona FLOW junto a este repo) o exporta FLOW_CHECKOUT.
const FLOW_CHECKOUT_FALLBACK = process.env.FLOW_CHECKOUT
  || path.join(__dirname, '..', '..', '..', 'FLOW');

/** Resuelve cómo invocar `flow paint`: {kind:'bin'|'checkout', cmd, cwd} o lanza. */
function locateFlowCli() {
  const env = process.env.FLOW_CLI;
  if (env) {
    try {
      const st = fs.statSync(env);
      if (st.isDirectory() && fs.existsSync(path.join(env, 'flow', 'cli', 'flow_cli.py')))
        return { kind: 'checkout', dir: env };
      if (st.isFile()) return { kind: 'bin', cmd: env };
    } catch { /* sigue a PATH */ }
    throw new Error(`FLOW_CLI=${env} no es checkout ni ejecutable`);
  }
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, 'flow');
    try { fs.accessSync(p, fs.constants.X_OK); return { kind: 'bin', cmd: p }; } catch { /* sigue */ }
  }
  const fb = path.join(FLOW_CHECKOUT_FALLBACK, 'flow', 'cli', 'flow_cli.py');
  try { fs.accessSync(fb, fs.constants.R_OK); return { kind: 'checkout', dir: FLOW_CHECKOUT_FALLBACK }; }
  catch { /* die abajo */ }
  throw new Error('flow no disponible: ni FLOW_CLI, ni `flow` en PATH, ni el checkout hermano. '
    + 'Instala FLOW o exporta FLOW_CLI=<checkout|binario> (la opción flow necesita el pincel).');
}

const FLOW_PYTHON = process.env.FLOW_PYTHON || 'python3';

/**
 * Ejecuta un programa .flowpaint y devuelve el PNG. Nunca escribe fuera de
 * outPng: el programa va a tmpfile. Lanza Error con el motivo de flow
 * (DENY del programa = bug del emisor, no del usuario).
 */
function runFlowProgram(programText, outPng) {
  const loc = locateFlowCli();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'munder-flow-'));
  const prog = path.join(dir, 'avatar.flowpaint');
  fs.writeFileSync(prog, programText, 'utf8');
  let r;
  try {
    if (loc.kind === 'bin') {
      r = spawnSync(loc.cmd, ['paint', prog, '-o', outPng], { encoding: 'utf8', timeout: 60000 });
    } else {
      r = spawnSync(FLOW_PYTHON, ['-m', 'flow.cli.flow_cli', 'paint', prog, '-o', outPng],
        { encoding: 'utf8', timeout: 60000, cwd: loc.dir });
    }
  } catch (e) {
    throw new Error(`no se pudo ejecutar flow (${e && e.message ? e.message : e})`);
  } finally {
    try { fs.unlinkSync(prog); fs.rmdirSync(dir); } catch { /* tmp, sigue */ }
  }
  if (r.status !== 0) {
    const why = ((r.stderr || '') + (r.stdout || '')).trim().split('\n').slice(-3).join(' | ');
    throw new Error(`flow paint falló (exit ${r.status}): ${why || 'sin motivo'}`);
  }
  return fs.readFileSync(outPng);
}

module.exports = { emitFlowProgram, emitFullBodyProgram, locateFlowCli, runFlowProgram };
