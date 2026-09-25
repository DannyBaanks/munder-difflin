#!/usr/bin/env node
'use strict';
/**
 * sync-avatar-engine.cjs — regenera avatar-engine.cjs desde portraitArt.ts.
 *
 * El engine de retratos vive en el checkout munder (procedural, sin DOM en
 * su ruta compose). Este script lo transpila a CJS dependency-free para que
 * el CLI lo use en Node plano con FIDELIDAD TOTAL (mismo composer que la app).
 *
 * Uso: node tools/munder/sync-avatar-engine.cjs [--fuente <checkout>]
 *   --fuente: checkout con los exports composeAvatar/AVATAR_VOCAB/AVATAR_RECIPES
 *             (defecto: munder-difflin-public). Requiere typescript resoluble.
 *
 * El archivo generado lleva el sha256 de la fuente; avatar.test.cjs lo
 * verifica (si portraitArt.ts cambia sin regenerar, el test falla diciendo
 * que corras este script).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HERE = __dirname;
const args = process.argv.slice(2);
const fi = args.indexOf('--fuente');
const FUENTE = fi >= 0 && args[fi + 1]
  ? args[fi + 1]
  : path.join(HERE, '..', '..');
const SRC = path.join(FUENTE, 'src', 'renderer', 'src', 'scene', 'office', 'portraitArt.ts');
const DEST = path.join(HERE, 'avatar-engine.cjs');

function needTypescript() {
  for (const base of [process.cwd(), HERE, FUENTE, path.join(FUENTE, '..')]) {
    try {
      return require(require.resolve('typescript', { paths: [base] }));
    } catch { /* sigue */ }
  }
  console.error('munder: no encontré typescript (¿npm install en el checkout?).');
  process.exit(1);
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`munder: fuente ausente: ${SRC} (usa --fuente <checkout>)`);
    process.exit(1);
  }
  const src = fs.readFileSync(SRC, 'utf8');
  for (const sym of ['composeAvatar', 'AVATAR_VOCAB', 'AVATAR_RECIPES', 'PORTRAIT_W', 'PORTRAIT_H']) {
    if (!src.includes(sym)) {
      console.error(`munder: la fuente no exporta ${sym} — ¿checkout viejo sin el surface de avatar?`);
      process.exit(1);
    }
  }
  const ts = needTypescript();
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const hash = crypto.createHash('sha256').update(src, 'utf8').digest('hex');
  const header = `'use strict';
/* GENERATED from ${path.relative(FUENTE, SRC)} sha256:${hash} — DO NOT EDIT.
 * Regenerar: node tools/munder/sync-avatar-engine.cjs [--fuente <checkout>] */
`;
  fs.writeFileSync(DEST, header + js);
  // Smoke: el módulo carga en Node plano y compone a jim 18×28 con alfa real.
  delete require.cache[require.resolve(DEST)];
  const eng = require(DEST);
  const buf = eng.composeAvatar(eng.AVATAR_RECIPES.jim);
  if (!(buf instanceof Uint8ClampedArray) || buf.length !== 18 * 28 * 4) {
    console.error('munder: smoke falló (buffer inesperado).');
    process.exit(1);
  }
  let opaque = 0, transparent = 0;
  for (let i = 3; i < buf.length; i += 4) {
    if (buf[i] === 255) opaque++;
    else if (buf[i] === 0) transparent++;
  }
  if (!opaque || !transparent) {
    console.error('munder: smoke falló (jim sin mezcla opaco/transparente).');
    process.exit(1);
  }
  console.log(`munder: engine sincronizado (${DEST}) sha256:${hash.slice(0, 12)}… smoke jim OK (${opaque} opacos, ${transparent} transparentes)`);
}

main();
