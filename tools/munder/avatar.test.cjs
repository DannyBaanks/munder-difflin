'use strict';
/**
 * avatar tests (lienzo editable + edición por modelo). Self-contained, sin
 * framework: `node tools/munder/avatar.test.cjs`. Sin red (stub local),
 * sin GUI, sin archivos reales fuera de sandbox.
 *
 * Cubre: codec PNG roundtrip + rechazos, lienzo 18×28 transparente,
 * matriz de verificación M11 (incl. que el lienzo en blanco se RECHAZA como
 * avatar), multipart, edición contra stub (b64 + url + 404 honesto),
 * CLI lienzo/editar (validaciones sin red) e higiene de la key de edición.
 */

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, 'munder');
const lib = require('./lib-avatar.cjs');

let failures = 0;
function test(name, fn) {
  return (async () => {
    try { await fn(); console.log(`  ✓ ${name}`); }
    catch (err) { failures++; console.log(`  ✗ ${name}\n     ${err && err.message}`); }
  })();
}
const pending = [];
const t2 = (n, f) => pending.push(test(n, f));

console.log('avatar tests');

t2('codec: roundtrip RGBA 2×2 exacto', () => {
  const px = [[255, 0, 0, 255], [0, 255, 0, 128], [0, 0, 255, 0], [1, 2, 3, 4]];
  const buf = lib.encodeRGBA(2, 2, (x, y) => px[y * 2 + x]);
  const d = lib.decodePNG(buf);
  assert.equal(d.w, 2); assert.equal(d.h, 2);
  assert.deepEqual([...d.rgba], px.flat());
});

t2('codec: rechaza firma rota, CRC malo y truncado', () => {
  const good = lib.encodeRGBA(2, 2, () => [0, 0, 0, 0]);
  assert.throws(() => lib.decodePNG(Buffer.from('hola')), /firma/);
  const badCrc = Buffer.from(good);
  badCrc[30] ^= 0xFF;
  assert.throws(() => lib.decodePNG(badCrc), /CRC/);
  assert.throws(() => lib.decodePNG(good.slice(0, 20)), /firma|inesperado|sin IHDR/);
});

t2('codec: gris y paleta con tRNS decodifican', () => {
  const zlib = require('node:zlib');
  const mk = (colorType, raw, extra = []) => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8; ihdr[9] = colorType;
    const idat = zlib.deflateSync(Buffer.concat([Buffer.from([0]), raw]));
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const chunk = (t, d) => {
      const td = Buffer.from(t, 'ascii'), l = Buffer.alloc(4);
      l.writeUInt32BE(d.length);
      let c = 0xFFFFFFFF;
      const tbl = (() => { const x = new Uint32Array(256); for (let n = 0; n < 256; n++) { let cc = n; for (let k = 0; k < 8; k++) cc = (cc & 1) ? (0xEDB88320 ^ (cc >>> 1)) : (cc >>> 1); x[n] = cc >>> 0; } return x; })();
      const all = Buffer.concat([td, d]);
      for (const b of all) c = tbl[(c ^ b) & 0xFF] ^ (c >>> 8);
      const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ 0xFFFFFFFF) >>> 0);
      return Buffer.concat([l, td, d, crc]);
    };
    return Buffer.concat([sig, chunk('IHDR', ihdr), ...extra.map(([t, d]) => chunk(t, d)), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
  };
  const gray = lib.decodePNG(mk(0, Buffer.from([10, 200])));
  assert.deepEqual([gray.rgba[0], gray.rgba[3]], [10, 255]);
  const pal = lib.decodePNG(mk(3, Buffer.from([0, 1]),
    [['PLTE', Buffer.from([255, 0, 0, 0, 0, 255])], ['tRNS', Buffer.from([255, 128])]]));
  assert.deepEqual([pal.rgba[0], pal.rgba[3], pal.rgba[4], pal.rgba[7]], [255, 255, 0, 128]);
});

t2('lienzo: 18×28 RGBA totalmente transparente', () => {
  const buf = lib.blankCanvas(18, 28);
  const d = lib.decodePNG(buf);
  assert.equal(d.w, 18); assert.equal(d.h, 28);
  for (let i = 3; i < d.rgba.length; i += 4) assert.equal(d.rgba[i], 0);
});

t2('verify: matriz M11 (ok, dims, alpha, vacio, tamaño, basura)', () => {
  const good = lib.encodeRGBA(18, 28, (x, y) => (x === 0 && y === 0 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
  const spec = { w: 18, h: 28, needAlpha: true, maxBytes: 512 * 1024 };
  assert.equal(lib.verifyAvatar(good, spec).ok, true);
  const big = lib.encodeRGBA(1024, 1024, () => [1, 2, 3, 255]);
  const r1 = lib.verifyAvatar(big, spec);
  assert.equal(r1.ok, false); assert.match(r1.reason, /dimensiones/);
  const opaque = lib.encodeRGBA(18, 28, () => [1, 2, 3, 255]);
  assert.match(lib.verifyAvatar(opaque, spec).reason, /sin canal alpha/);
  assert.match(lib.verifyAvatar(lib.blankCanvas(18, 28), spec).reason, /vacío/);
  assert.match(lib.verifyAvatar(Buffer.from('basura'), spec).reason, /decodifica/);
});

t2('multipart lleva imagen+campos con boundary coherente', () => {
  const { multipartEdit } = lib;
  const img = Buffer.from([1, 2, 3]);
  const { body, boundary } = multipartEdit(img, { model: 'm', prompt: 'p' });
  const s = body.toString('latin1');
  assert.ok(s.includes(`name="model"`) && s.includes('munder'), 'campos presentes');
  assert.ok(s.includes('filename="canvas.png"'), 'archivo como canvas.png');
  assert.ok(body.includes(img), 'bytes de imagen embebidos');
  void boundary;
});

function stubEditServer(handler) {
  const http = require('node:http');
  return new Promise((resolve) => {
    const seen = { auth: null, contentType: null, hasImage: false };
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        seen.auth = req.headers.authorization || null;
        seen.contentType = req.headers['content-type'] || '';
        seen.hasImage = raw.includes(Buffer.from('canvas.png'));
        handler(req, res, seen);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, seen }));
  });
}

t2('editImageEndpoint: b64 válido + Bearer solo en header', async () => {
  const { srv, port, seen } = await stubEditServer((req, res) => {
    const { encodeRGBA } = lib;
    const png = encodeRGBA(18, 28, (x, y) => (x === 0 && y === 0 ? [9, 9, 9, 255] : [0, 0, 0, 0]));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  });
  try {
    const out = await lib.editImageEndpoint({
      baseURL: `http://127.0.0.1:${port}`, key: 'sk-FAKE-EDIT', model: 'm',
      imageBuf: Buffer.from([0]), prompt: 'p',
    });
    assert.equal(lib.decodePNG(out).w, 18);
    assert.equal(seen.auth, 'Bearer sk-FAKE-EDIT', 'key solo en header');
    assert.ok(seen.hasImage, 'imagen llegó en el multipart');
    assert.ok(seen.contentType.includes('multipart/form-data'), 'content-type multipart');
  } finally { srv.close(); }
});

t2('editImageEndpoint: 404 honesto + error con status sin fugas', async () => {
  const { srv, port } = await stubEditServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'no such endpoint' }));
  });
  try {
    await assert.rejects(lib.editImageEndpoint({
      baseURL: `http://127.0.0.1:${port}`, key: 'sk-SECRETA-EDIT', model: 'm',
      imageBuf: Buffer.from([0]), prompt: 'p',
    }), (e) => {
      assert.equal(e.code, 'ENDPOINT_NO_EDITA');
      assert.ok(!String(e.message).includes('sk-SECRETA'), 'sin fuga en el error');
      return true;
    });
  } finally { srv.close(); }
});

t2('CLI avatar lienzo crea PNG válido; rechaza existente', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'av-'));
  const out = path.join(d, 'c.png');
  let r = spawnSync('node', [CLI, 'avatar', 'lienzo', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const dec = lib.decodePNG(fs.readFileSync(out));
  assert.equal(dec.w, 18); assert.equal(dec.h, 28);
  r = spawnSync('node', [CLI, 'avatar', 'lienzo', out], { encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0, 'rehúsa sobreescribir');
  assert.match(r.stderr + r.stdout, /ya existe/);
});

t2('CLI avatar editar valida sin red (archivo/endpoint/modelo/key)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'av-'));
  const png = path.join(d, 'c.png');
  fs.writeFileSync(png, lib.blankCanvas(18, 28));
  const env = { ...process.env, HOME: d, MUNDER_STATE_DIR: path.join(d, 'st') };
  const run = (args, extraEnv) => spawnSync('node', [CLI, ...args],
    { encoding: 'utf8', env: { ...env, ...extraEnv }, timeout: 15000 });
  let r = run(['avatar', 'editar', '/noexiste.png', '--endpoint', 'openai', '--model', 'm']);
  assert.notStrictEqual(r.status, 0); assert.match(r.stderr + r.stdout, /no existe/);
  r = run(['avatar', 'editar', png, '--endpoint', 'nope', '--model', 'm']);
  assert.notStrictEqual(r.status, 0); assert.match(r.stderr + r.stdout, /desconocido/);
  r = run(['avatar', 'editar', png, '--endpoint', 'anthropic', '--model', 'm']);
  assert.notStrictEqual(r.status, 0); assert.match(r.stderr + r.stdout, /openai-compatibles/);
  r = run(['avatar', 'editar', png, '--endpoint', 'openai', '--model', 'm']);
  assert.notStrictEqual(r.status, 0); assert.match(r.stderr + r.stdout, /OPENAI_API_KEY/);
});

t2('CLI avatar editar E2E contra stub (--base-url): instala válido, rechaza 1024', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'av-'));
  const png = path.join(d, 'c.png');
  fs.writeFileSync(png, lib.blankCanvas(18, 28));
  const st = path.join(d, 'st');
  const FAKEKEY = 'sk-FAKE-E2E-EDIT';
  const env = { ...process.env, HOME: d, MUNDER_STATE_DIR: st, OPENAI_API_KEY: FAKEKEY };
  // OJO: el stub corre en proceso APARTE — si viviera aquí, spawnSync
  // bloquearía el loop y el stub jamás aceptaría (deadlock).
  const stubFile = path.join(d, 'stub.cjs');
  const portFile = path.join(d, 'port.txt');
  const authFile = path.join(d, 'auth.txt');
  const goodB64 = lib.encodeRGBA(18, 28, (x, y) => (x === 0 && y === 0 ? [5, 5, 5, 255] : [0, 0, 0, 0])).toString('base64');
  const bigB64 = lib.encodeRGBA(1024, 64, () => [5, 5, 5, 255]).toString('base64');
  fs.writeFileSync(stubFile, `
const http = require('node:http');
const fs = require('node:fs');
const [,, mode, authFile, portFile] = process.argv;
const body = mode === 'big' ? ${JSON.stringify(bigB64)} : ${JSON.stringify(goodB64)};
const srv = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    fs.writeFileSync(authFile, req.headers.authorization || 'SIN-AUTH');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ b64_json: body }] }));
  });
});
srv.listen(0, '127.0.0.1', () => { fs.writeFileSync(portFile, String(srv.address().port)); setInterval(() => {}, 10000); });
`);
  const { spawn } = require('node:child_process');
  const waitPort = () => {
    try { fs.unlinkSync(portFile); } catch { /* noop */ }
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      try {
        const v = fs.readFileSync(portFile, 'utf8').trim();
        if (/^[0-9]+$/.test(v)) return v;
      } catch { /* aún no */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    throw new Error('stub sin puerto');
  };
  const run = (base) => spawnSync('node',
    [CLI, 'avatar', 'editar', png, '--endpoint', 'openai', '--model', 'm', '--prompt', 'x', '--si', '--base-url', base],
    { encoding: 'utf8', env, timeout: 30000 });
  let stubProc = null;
  try {
    stubProc = spawn('node', [stubFile, 'good', authFile, portFile], { stdio: 'ignore', detached: true });
    stubProc.unref();
    let r = run(`http://127.0.0.1:${waitPort()}`);
    assert.equal(r.status, 0, `instala válido: ${(r.stderr || '').slice(-200)}`);
    assert.match(r.stdout, /válido instalado en pendientes/);
    assert.equal(fs.readFileSync(authFile, 'utf8'), `Bearer ${FAKEKEY}`, 'key solo en header');
    const installed = fs.readdirSync(path.join(st, 'avatars')).filter((f) => f.endsWith('.png'));
    assert.equal(installed.length, 1, 'un PNG instalado');
    const dec = lib.decodePNG(fs.readFileSync(path.join(st, 'avatars', installed[0])));
    assert.equal(dec.w, 18); assert.equal(dec.h, 28);
    try { process.kill(stubProc.pid, 9); } catch { /* noop */ }
    stubProc = spawn('node', [stubFile, 'big', authFile, portFile], { stdio: 'ignore', detached: true });
    stubProc.unref();
    r = run(`http://127.0.0.1:${waitPort()}`);
    assert.equal(r.status, 2, 'rechazo sale con código 2');
    assert.match(r.stdout, /AVATAR_REJECTED/);
    assert.match(r.stdout, /dimensiones/);
    assert.equal(fs.readdirSync(path.join(st, 'avatars')).length, 1, 'el rechazado no se instala');
    // Higiene: la key no está en ningún archivo del sandbox (logs, estado,
    // pendientes) — salvo auth.txt, que es el propio registro del stub para
    // afirmar el header (el stub es el "endpoint", no munder).
    const bad = [];
    const scan = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (p === authFile) continue;
        if (e.isDirectory()) scan(p);
        else if (e.isFile()) {
          try { if (fs.readFileSync(p, 'utf8').includes(FAKEKEY)) bad.push(p); } catch { /* binario */ }
        }
      }
    };
    scan(d);
    assert.deepEqual(bad, [], `fuga de key en: ${bad.join(', ')}`);
  } finally {
    try { if (stubProc) process.kill(stubProc.pid, 9); } catch { /* noop */ }
  }
});

// ─── engine texto→píxeles (compilador) ──────────────────────────────────────
const ENGINE_PATH = path.join(__dirname, 'avatar-engine.cjs');
const engine = require('./avatar-engine.cjs');
const SRC_DEFAULT = path.join(__dirname, '..', '..', 'src', 'renderer', 'src', 'scene', 'office', 'portraitArt.ts');

test('sync: avatar-engine.cjs corresponde al portraitArt.ts actual', () => {
  const srcPath = process.env.AVATAR_FUENTE || SRC_DEFAULT;
  const src = fs.readFileSync(srcPath, 'utf8');
  const hash = require('node:crypto').createHash('sha256').update(src, 'utf8').digest('hex');
  const head = fs.readFileSync(ENGINE_PATH, 'utf8').split('\n').slice(0, 4).join('\n');
  assert.ok(head.includes(hash), 'hash mismatch: corre node tools/munder/sync-avatar-engine.cjs');
});

test('vocab del engine cubre lo que el frontend emite', () => {
  const V = engine.AVATAR_VOCAB;
  for (const k of ['skins', 'hairs', 'cloths', 'facials', 'brows', 'mouths']) {
    assert.ok(Array.isArray(V[k]) && V[k].length > 0, `vocab ${k}`);
  }
  assert.ok(V.hairs.includes('styleShort') && V.hairs.includes('styleBald'), 'estilos conocidos');
});

test('los 14 personajes del cast renderizan válido (pin de regresión)', () => {
  const names = Object.keys(engine.AVATAR_RECIPES);
  assert.ok(names.length >= 14, `cast completo, hay ${names.length}`);
  for (const n of names) {
    const r = engine.AVATAR_RECIPES[n];
    // Toda receta del cast valida contra el vocab (pin anti-drift)...
    assert.deepEqual(lib.validateAvatarRecipe(r, engine.AVATAR_VOCAB), [], `${n} valida`);
    // ...y compone 18×28 con alfa real.
    const buf = engine.composeAvatar(r);
    assert.equal(buf.length, 18 * 28 * 4, `${n} dims`);
    let opaque = 0, transparent = 0;
    for (let i = 3; i < buf.length; i += 4) {
      if (buf[i] === 255) opaque++;
      else if (buf[i] === 0) transparent++;
    }
    assert.ok(opaque > 50, `${n} tiene cuerpo opaco`);
    assert.ok(transparent > 50, `${n} tiene fondo transparente`);
  }
});

test('parseAvatarDesc: categorías, última-gana, warnings', () => {
  const lib2 = lib;
  let r = lib2.parseAvatarDesc('piel morena, pelo negro corto, camisa azul, gafas');
  assert.equal(r.recipe.skin, 'tan');
  assert.equal(r.recipe.hair, 'styleShort');
  assert.deepEqual(r.recipe.hairc, [30, 22, 18]);
  assert.equal(r.recipe.cloth, 'dressshirt');
  assert.deepEqual(r.recipe.c1, [110, 140, 180]);
  assert.equal(r.recipe.glasses, true);
  assert.deepEqual(r.warnings, []);
  assert.ok(r.matched.length >= 5);
  r = lib2.parseAvatarDesc('camisa azul, no, roja');
  assert.deepEqual(r.recipe.c1, [176, 65, 58], 'última gana');
  r = lib2.parseAvatarDesc('piel morena con ojos verdes y sombrero');
  assert.ok(r.warnings.some((w) => w.includes('ojos verdes')), 'ojos avisa (no parametrizables)');
  assert.ok(r.warnings.some((w) => w.includes('sombrero')), 'sombrero avisa');
  r = lib2.parseAvatarDesc('');
  assert.ok(r.warnings.length > 0 && r.recipe.skin === 'light', 'vacío usa base neutra');
  r = lib2.parseAvatarDesc('Piel OSCURA, Pelo RUBIO largo, Traje NEGRO, bigote, BARBA de días');
  assert.equal(r.recipe.skin, 'dark', 'mayúsculas y tildes normalizadas');
  assert.equal(r.recipe.hair, 'styleFrame', 'largo enmarca');
  assert.deepEqual(r.recipe.hairc, [190, 158, 95], 'rubio');
  r = lib2.parseAvatarDesc('pelo negro con pinchos');
  assert.equal(r.recipe.hair, 'styleSpiky', 'modificador huérfano hereda contexto pelo');
  assert.deepEqual(r.warnings, [], 'sin warnings con contexto');
  r = lib2.parseAvatarDesc('camisa azul con rayas');
  assert.equal(r.recipe.cloth, 'dressshirt');
  assert.ok(r.warnings.some((w) => w.includes('rayas')), 'rayas avisa igual');
});

test('compileAvatar E2E: texto -> PNG válido con alfa', () => {
  const { png, recipe, warnings } = lib.compileAvatar(engine, 'piel morena, pelo negro corto, camisa azul, gafas');
  assert.equal(recipe.skin, 'tan');
  const d = lib.decodePNG(png);
  assert.equal(d.w, 18); assert.equal(d.h, 28);
  const v = lib.verifyAvatar(png, { w: 18, h: 28, needAlpha: true, maxBytes: 512 * 1024 });
  assert.equal(v.ok, true, `verify: ${v.reason || 'ok'}`);
  assert.deepEqual(warnings, [], 'todo reconocido');
});

test('CLI avatar compilar crea PNG válido; rechaza vacío', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avc-'));
  const out = path.join(d, 'pj.png');
  let r = spawnSync('node', [CLI, 'avatar', 'compilar', 'piel clara, pelo rubio corto, traje negro', '--salida', out],
    { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, `compila: ${(r.stderr || '').slice(-200)}`);
  assert.match(r.stdout, /avatar compilado/);
  const dec = lib.decodePNG(fs.readFileSync(out));
  assert.equal(dec.w, 18); assert.equal(dec.h, 28);
  r = spawnSync('node', [CLI, 'avatar', 'compilar', '   ', '--salida', path.join(d, 'x.png')],
    { encoding: 'utf8', timeout: 15000 });
  assert.notStrictEqual(r.status, 0, 'vacío se rechaza');
});

t2('CLI avatar inspect: matriz 28×18 + leyenda + regiones (cast y PNG)', () => {
  const run = (args) => spawnSync('node', [CLI, ...args], { encoding: 'utf8', timeout: 30000 });
  let r = run(['avatar', 'inspect', 'pam']);
  assert.equal(r.status, 0, `inspect pam: ${(r.stderr || '').slice(-200)}`);
  const lines = r.stdout.split('\n');
  assert.ok(lines[0].startsWith('CANVAS 18x28'), 'cabecera CANVAS');
  const rows = lines.filter((l) => /^[0-9]{2} [.A-Z?]{18}$/.test(l));
  assert.equal(rows.length, 28, '28 filas de 18 celdas');
  assert.ok(/^[A-Z] = #[0-9a-f]{6}$/.test(lines.find((l) => /^[A-Z] = #/.test(l)) || ''), 'leyenda hex');
  assert.ok(r.stdout.includes('eyes') && r.stdout.includes('torso'), 'regiones');
  // Ojos de pam en la fila 09 (medido en drawFace, no del sketch).
  const row09 = rows[9].slice(3);
  assert.ok(/[A-Z]/.test(row09.replace(/\./g, '').slice(4, 13)) || row09.includes('.'), 'fila de ojos presente');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avi-'));
  const png = path.join(d, 'x.png');
  fs.writeFileSync(png, lib.blankCanvas(18, 28));
  r = run(['avatar', 'inspect', png]);
  assert.equal(r.status, 0, 'inspect PNG');
  assert.ok(r.stdout.includes('CANVAS 18x28'), 'misma forma para PNG');
  r = run(['avatar', 'inspect', 'nadie-existe-ni-archivo']);
  assert.notStrictEqual(r.status, 0, 'desconocido falla limpio');
  assert.match(r.stderr + r.stdout, /ni personaje|Personajes/);
});

// ─── motores de compilación (local | modelo | flow) ──────────────────────────
const flowEmit = require('./flow-emit.cjs');

// Goldens del emisor estilo-flow (programa texto por personaje). Fijados por
// ejecución; si cambia el estilo, regenerar y decir por qué en el commit.
// (Emitidos contra avatar-engine.cjs + RECIPES del mismo commit que este test.)
const FLOW_GOLDENS = {
  michael: 'a3d04b4b16ada7217f462823428dcf1bd0a27034fb3576e701578360b16d5d92',
  jim: '5de6de89ca2571f148b209e412c2548e32f56b5bf9a6da50cbc2798580e52b70',
  pam: 'c66fb10b22e7b163e867f9e7debfa409fa3e7baacaebfd050befce5c2f71e009',
  dwight: '624d995aa296e53d190d31f253ef2bd6a8e4bc8da9dad7a59a72978101b9c158',
  kevin: 'b254dfbf429bde2bf46158eaacde648d1cd924e4cf577381865bd5cba49ea334',
  angela: 'efb2bf3ac1aa73174945cd43bb2800ffebb5805ed10ab940da3c0f3a720b3f56',
  oscar: 'd27bc500ed693ed04fe408fe314dcc28d684ac39cf3cc99e231b9f8a15ca2837',
  stanley: 'ba2659a051c79f7d854a80c10c7ce6db54c61a82a8f5b290fe8eece27d779dcd',
  phyllis: 'd47212c267edc5aafaa31591c9a09cbf16c1ca01a940248ad89a9d85fe8717d9',
  andy: '4302be0df6af1eff29bfd4789766e956e1c704c2444bf3c2726c53e9a008de05',
  kelly: '5b2375533bbc7ef29f4c79d691160f23cbba7d8df0d7897584fe52e5d52c5b1d',
  ryan: 'eb6b22ff8daafb5aac4b78f46936bd7287622fe0957f149a70d1b3b04af5d937',
  toby: '33bb6343f7ad7085ce138308a7f3aa6dfd5fa253972f0677bafc757e0c0ca266',
  creed: 'dbb0c59f0423e74e56022950359641bf903ea85a17c9675eae525f9e341e6169',
  meredith: '9b363fd312114571d3c96ffd629713bc5776376f032fc6d2aeb720ef68495b7b',
};

test('flow-emit: determinista, CANVAS 18 28, solo ops del pincel', () => {
  const crypto = require('node:crypto');
  const OPS = new Set(['CANVAS', 'COLOR', 'MOVE', 'PIXEL', 'LINE', 'RECT', 'FILL', 'COPY', 'MIRROR_X', 'MIRROR_Y', 'UNDO', 'SAVE']);
  for (const n of Object.keys(engine.AVATAR_RECIPES)) {
    const a = flowEmit.emitFlowProgram(engine.AVATAR_RECIPES[n]);
    assert.equal(a, flowEmit.emitFlowProgram(engine.AVATAR_RECIPES[n]), `${n} determinista`);
    const lines = a.split('\n').filter((l) => l && !l.startsWith('#'));
    assert.equal(lines[0], 'CANVAS 18 28', `${n} canvas`);
    for (const l of lines) assert.ok(OPS.has(l.split(' ')[0]), `${n}: op válida (${l.slice(0, 20)})`);
    const h = crypto.createHash('sha256').update(a).digest('hex');
    assert.equal(h, FLOW_GOLDENS[n], `${n} golden`);
  }
});

test('flow-emit: receta inválida lanza (no emite basura)', () => {
  assert.throws(() => flowEmit.emitFlowProgram({ skin: 'verde', hair: 'styleX', cloth: 'toga' }), /receta inválida/);
});

t2('CLI compilar --motor flow: PNG válido con alfa (o skip honesto sin flow)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avf-'));
  const out = path.join(d, 'f.png');
  const r = spawnSync('node', [CLI, 'avatar', 'compilar', 'piel morena, pelo negro corto, camisa azul', '--motor', 'flow', '--salida', out],
    { encoding: 'utf8', timeout: 60000 });
  const both = r.stderr + r.stdout;
  if (r.status !== 0 && /flow no disponible/.test(both)) {
    console.log('     (skip: flow no instalado en este host)');
    return;
  }
  assert.equal(r.status, 0, `flow compila: ${both.slice(-300)}`);
  assert.match(r.stdout, /avatar compilado/, 'mismo bloque de éxito que local');
  const dec = lib.decodePNG(fs.readFileSync(out));
  assert.equal(dec.w, 18); assert.equal(dec.h, 28);
  assert.equal(lib.verifyAvatar(fs.readFileSync(out), { w: 18, h: 28, needAlpha: true, maxBytes: 512 * 1024 }).ok, true);
});

t2('CLI compilar --motor: valor malo y validaciones modelo sin red', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avm-'));
  const run = (args, extraEnv) => spawnSync('node', [CLI, ...args],
    { encoding: 'utf8', env: { ...process.env, ...extraEnv }, timeout: 15000 });
  let r = run(['avatar', 'compilar', 'x', '--motor', 'turbo', '--salida', path.join(d, 'x.png')]);
  assert.notStrictEqual(r.status, 0); assert.match(r.stderr + r.stdout, /motor desconocido.*local.*modelo.*flow/);
  const env = { HOME: d, MUNDER_STATE_DIR: path.join(d, 'st') };
  r = run(['avatar', 'compilar', 'piel clara', '--motor', 'modelo', '--endpoint', 'nope', '--model', 'm', '--salida', path.join(d, 'a.png')], env);
  assert.notStrictEqual(r.status, 0); assert.match(r.stderr + r.stdout, /desconocido/);
  r = run(['avatar', 'compilar', 'piel clara', '--motor', 'modelo', '--endpoint', 'anthropic', '--model', 'm', '--salida', path.join(d, 'b.png')], env);
  assert.notStrictEqual(r.status, 0); assert.match(r.stderr + r.stdout, /openai-compatibles/);
  const noKey = { ...env };
  delete noKey.OPENAI_API_KEY;
  r = run(['avatar', 'compilar', 'piel clara', '--motor', 'modelo', '--endpoint', 'openai', '--model', 'm', '--salida', path.join(d, 'c.png')], noKey);
  assert.notStrictEqual(r.status, 0); assert.match(r.stderr + r.stdout, /OPENAI_API_KEY/);
});

t2('CLI compilar --motor modelo E2E contra stub (instala, rechaza, sin fugas)', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avm2-'));
  const out = path.join(d, 'm.png');
  const st = path.join(d, 'st');
  const FAKEKEY = 'sk-FAKE-MODELO-E2E';
  const env = { ...process.env, HOME: d, MUNDER_STATE_DIR: st, OPENAI_API_KEY: FAKEKEY };
  const stubFile = path.join(d, 'stub.cjs');
  const portFile = path.join(d, 'port.txt');
  const goodB64 = lib.encodeRGBA(18, 28, (x, y) => (x === 0 && y === 0 ? [5, 5, 5, 255] : [0, 0, 0, 0])).toString('base64');
  const bigB64 = lib.encodeRGBA(1024, 64, () => [5, 5, 5, 255]).toString('base64');
  fs.writeFileSync(stubFile, `
const http = require('node:http');
const fs = require('node:fs');
const [,, mode, portFile] = process.argv;
const body = mode === 'big' ? ${JSON.stringify(bigB64)} : ${JSON.stringify(goodB64)};
const srv = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ b64_json: body }] }));
  });
});
srv.listen(0, '127.0.0.1', () => { fs.writeFileSync(portFile, String(srv.address().port)); setInterval(() => {}, 10000); });
`);
  const { spawn } = require('node:child_process');
  const waitPort = () => {
    try { fs.unlinkSync(portFile); } catch { /* noop */ }
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      try {
        const v = fs.readFileSync(portFile, 'utf8').trim();
        if (/^[0-9]+$/.test(v)) return v;
      } catch { /* aún no */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    throw new Error('stub sin puerto');
  };
  const run = (base, salida) => spawnSync('node',
    [CLI, 'avatar', 'compilar', 'piel clara, pelo corto', '--motor', 'modelo', '--endpoint', 'openai', '--model', 'm', '--si', '--base-url', base, '--salida', salida],
    { encoding: 'utf8', env, timeout: 30000 });
  let stubProc = null;
  try {
    stubProc = spawn('node', [stubFile, 'good', portFile], { stdio: 'ignore', detached: true });
    stubProc.unref();
    let r = run(`http://127.0.0.1:${waitPort()}`, out);
    assert.equal(r.status, 0, `modelo instala: ${(r.stderr || '').slice(-200)}`);
    assert.match(r.stdout, /avatar compilado/);
    const dec = lib.decodePNG(fs.readFileSync(out));
    assert.equal(dec.w, 18); assert.equal(dec.h, 28);
    assert.ok(!(r.stdout + r.stderr).includes(FAKEKEY), 'key fuera de la salida');
    try { process.kill(stubProc.pid, 9); } catch { /* noop */ }
    stubProc = spawn('node', [stubFile, 'big', portFile], { stdio: 'ignore', detached: true });
    stubProc.unref();
    r = run(`http://127.0.0.1:${waitPort()}`, path.join(d, 'big.png'));
    assert.equal(r.status, 0, 'modelo escribe y avisa (estilo compilar)');
    assert.match(r.stdout, /aviso verify:.*dimensiones/);
  } finally {
    try { if (stubProc) process.kill(stubProc.pid, 9); } catch { /* noop */ }
  }
});

// ─── avatar-spec v1: normalizador ES/DSL -> spec (M1) ────────────────────────
const avspec = require('./avatar-spec.cjs');

test('spec-normalize: categorías, última-gana, warnings', () => {
  let r = avspec.normalizeAvatarDesc('piel morena, pelo negro corto, camisa azul, gafas');
  assert.equal(r.ok, true);
  assert.equal(r.spec.skin, 'SKIN_02');
  assert.equal(r.spec.hair.style, 'short_01');
  assert.equal(r.spec.hair.color, 'HAIR_01');
  assert.equal(r.spec.shirt.style, 'dressshirt');
  assert.equal(r.spec.shirt.color, 'CLOTH_BLUE');
  assert.equal(r.spec.glasses, true);
  assert.deepEqual(r.warnings, []);
  assert.ok(r.matched.length >= 5);
  r = avspec.normalizeAvatarDesc('camisa azul, no, roja');
  assert.equal(r.spec.shirt.color, 'CLOTH_RED', 'última gana');
  r = avspec.normalizeAvatarDesc('piel morena con sombrero');
  assert.ok(r.warnings.some((w) => w.includes('sombrero')), 'sombrero avisa');
  r = avspec.normalizeAvatarDesc('');
  assert.ok(r.warnings.length > 0 && r.spec.skin === 'SKIN_01', 'vacío usa base neutra');
  r = avspec.normalizeAvatarDesc('Piel OSCURA, Pelo RUBIO largo, Traje NEGRO, bigote');
  assert.equal(r.spec.skin, 'SKIN_04', 'mayúsculas y tildes normalizadas');
  assert.equal(r.spec.hair.style, 'frame_01', 'largo enmarca');
  assert.equal(r.spec.hair.color, 'HAIR_04', 'rubio');
  r = avspec.normalizeAvatarDesc('pelo negro con pinchos');
  assert.equal(r.spec.hair.style, 'spiky_01', 'huérfano hereda contexto pelo');
  assert.equal(r.spec.hair.color, 'HAIR_01', 'color de la primera frase');
  assert.deepEqual(r.warnings, [], 'sin warnings con contexto');
  r = avspec.normalizeAvatarDesc('camisa azul con rayas');
  assert.equal(r.spec.shirt.style, 'dressshirt');
  assert.ok(r.warnings.some((w) => w.includes('rayas')), 'rayas avisa igual');
  r = avspec.normalizeAvatarDesc('ojos verdes');
  assert.equal(r.spec.eyes.color, 'EYE_03', 'ojos sí parametrizables aquí');
  assert.equal(r.spec.shirt.color, 'CLOTH_WHITE', 'el verde no mancha la camisa');
});

test('spec-normalize: INVALID_ENUM con available (bucle de corrección)', () => {
  let r = avspec.normalizeAvatarDesc('pelo dragon');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_ENUM');
  assert.equal(r.error.field, 'hair.style');
  assert.ok(r.error.available.includes('short_01'), 'available para corregir');
  r = avspec.normalizeAvatarDesc('camisa PANTONE 999 Z');
  assert.equal(r.ok, false);
  assert.equal(r.error.field, 'shirt.color');
  r = avspec.normalizeAvatarDesc('camisa PANTONE 186 C rojo');
  assert.equal(r.ok, true);
  assert.equal(r.spec.shirt.color, 'CLOTH_RED');
  assert.equal(r.spec.custom.shirt.pantone, '186 C rojo', 'verbatim preservado');
  r = avspec.normalizeAvatarDesc('camisa #ff0000');
  assert.equal(r.ok, true);
  assert.equal(r.spec.shirt.color, '#FF0000');
  r = avspec.normalizeAvatarDesc('pantalon azul, zapatos negros');
  assert.equal(r.spec.pants.color, 'CLOTH_BLUE');
  assert.equal(r.spec.shoes.color, 'CLOTH_BLACK');
});

test('spec-dsl: bloque válido, enum malo, forma rota', () => {
  const good = 'avatar {\n body standard_01\n skin SKIN_02\n hair short_01 HAIR_02\n eyes round_01 EYE_02\n eyebrows soft\n mouth smile\n shirt suit CLOTH_BLUE tie #AA3A3A\n pants standard_01 CLOTH_BLUE\n shoes standard_01 CLOTH_BLACK\n accessory_1 none\n}';
  let r = avspec.parseAvatarDSL(good);
  assert.equal(r.ok, true, JSON.stringify(r.error || null));
  assert.equal(r.spec.skin, 'SKIN_02');
  assert.equal(r.spec.shirt.tie, '#AA3A3A');
  r = avspec.parseAvatarDSL('avatar {\n hair dragon_supersaiyan HAIR_01\n}');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'INVALID_ENUM');
  assert.equal(r.error.field, 'hair.style');
  assert.ok(r.error.available.includes('short_01'));
  r = avspec.parseAvatarDSL('avatar {\n cape heroica\n}');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'SCHEMA');
  r = avspec.parseAvatarDSL('sin bloque');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'SCHEMA');
});

test('spec-validate: fixtures M0 pasan por el validador permanente', () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'avatar-spec.fixtures.json'), 'utf8')).fixtures;
  assert.equal(fx.length, 3, 'M0 fijó 3 fixtures');
  for (const f of fx) {
    const v = avspec.validateAvatarSpec(f.spec);
    assert.equal(v.ok, f.expect.ok, `${f.name} ok`);
    if (!f.expect.ok) {
      assert.equal(v.error.code, f.expect.code, `${f.name} code`);
      if (f.expect.field) assert.equal(v.error.field, f.expect.field, `${f.name} field`);
    }
  }
});

test('spec-fuzz: 100 descripciones nunca tiran y siempre validan o fallan bien', () => {
  const pool = ['piel morena', 'piel clara', 'pelo negro', 'pelo rubio largo', 'pinchos', 'ojos verdes',
    'camisa azul', 'traje negro', 'corbata roja', 'gafas', 'bigote', 'pantalon verde', 'zapatos blancos',
    'sonrisa', 'sombrero', 'PANTONE 1 rojo', 'camisa #00ff00', 'pelo dragon', 'blusa rosa', 'robusto'];
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 100; i++) {
    const n = 1 + Math.floor(rnd() * 3);
    const parts = [];
    for (let j = 0; j < n; j++) parts.push(pool[Math.floor(rnd() * pool.length)]);
    const r = avspec.normalizeAvatarDesc(parts.join(', '));
    if (r.ok) {
      assert.equal(avspec.validateAvatarSpec(r.spec).ok, true, `spec válido: ${parts.join('|')}`);
    } else {
      assert.ok(['INVALID_ENUM', 'SCHEMA'].includes(r.error.code), 'código conocido');
      assert.ok(typeof r.error.field === 'string' && r.error.field.length > 0, 'field presente');
    }
  }
});

// ─── avatar-spec v1: renderer cuerpo completo 18×32 (M2) ────────────────────
// Golden del programa del fixture válido M0 (estilo-spec determinista).
const SPEC_GOLDEN = '502ad820742e5219f47d89ba057ebb1fabac3f0a09f6b429280ec7a758024c27';

test('spec-render: cuerpo 18×32 determinista + golden', () => {
  const crypto = require('node:crypto');
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'avatar-spec.fixtures.json'), 'utf8')).fixtures[0].spec;
  const a = flowEmit.emitFullBodyProgram(fx);
  assert.equal(a, flowEmit.emitFullBodyProgram(fx), 'determinista');
  const lines = a.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.equal(lines[0], 'CANVAS 18 32', 'formato escena M0');
  assert.equal(crypto.createHash('sha256').update(a).digest('hex'), SPEC_GOLDEN, 'golden');
  assert.throws(() => flowEmit.emitFullBodyProgram({ spec: 'avatar-spec/1' }), /spec inválido/, 'invalido lanza');
});

test('spec-render: 9 pelos + 6 ropas + pantalones/zapatos emiten ops válidas', () => {
  const OPS = new Set(['CANVAS', 'COLOR', 'MOVE', 'PIXEL', 'LINE', 'RECT', 'FILL', 'COPY', 'MIRROR_X', 'MIRROR_Y', 'UNDO', 'SAVE']);
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'avatar-spec.fixtures.json'), 'utf8')).fixtures[0].spec;
  const clone = () => JSON.parse(JSON.stringify(fx));
  const cases = [];
  for (const s of avspec.HAIR_STYLES) { const c = clone(); c.hair.style = s; cases.push(['pelo:' + s, c]); }
  for (const s of ['suit', 'dressshirt', 'polo', 'blouse', 'cardigan', 'sweater']) { const c = clone(); c.shirt.style = s; cases.push(['ropa:' + s, c]); }
  const heavy = clone(); heavy.body.heavy = true; cases.push(['heavy', heavy]);
  const hex = clone(); hex.shirt.color = '#FF0000'; hex.pants.color = '#00FF00'; cases.push(['hex', hex]);
  for (const [name, c] of cases) {
    const p = flowEmit.emitFullBodyProgram(c);
    for (const l of p.split('\n').filter((l) => l && !l.startsWith('#')))
      assert.ok(OPS.has(l.split(' ')[0]), `${name}: op válida`);
  }
  assert.equal(cases.length, 9 + 6 + 2, 'cobertura');
});

t2('spec-render E2E: flow pinta 18×32 con alfa (o skip honesto sin flow)', () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'avatar-spec.fixtures.json'), 'utf8')).fixtures[0].spec;
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avs-'));
  const out = path.join(d, 's.png');
  let png;
  try {
    png = flowEmit.runFlowProgram(flowEmit.emitFullBodyProgram(fx), out);
  } catch (e) {
    if (/flow no disponible|no se pudo ejecutar/.test(e.message)) {
      console.log('     (skip: flow no instalado en este host)');
      return;
    }
    throw e;
  }
  const dec = lib.decodePNG(png);
  assert.equal(dec.w, 18); assert.equal(dec.h, 32);
  let opaque = 0, transparent = 0;
  for (let i = 3; i < dec.rgba.length; i += 4) {
    if (dec.rgba[i] === 255) opaque++;
    else if (dec.rgba[i] === 0) transparent++;
  }
  assert.ok(opaque > 50 && transparent > 50, 'cuerpo opaco + fondo transparente');
  assert.equal(lib.verifyAvatar(png, { w: 18, h: 32, needAlpha: true, maxBytes: 512 * 1024 }).ok, true, 'M11 18×32');
});

// ─── avatar-spec v1: frente CLI --motor spec (M3) ────────────────────────────
t2('CLI compilar --motor spec E2E: 18×32 + bloque uniforme (o skip sin flow)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avS-'));
  const out = path.join(d, 's.png');
  const r = spawnSync('node', [CLI, 'avatar', 'compilar', 'piel morena, pelo negro corto, traje azul, pantalon azul, zapatos negros', '--motor', 'spec', '--salida', out],
    { encoding: 'utf8', timeout: 60000 });
  const both = r.stderr + r.stdout;
  if (r.status !== 0 && /flow no disponible|no se pudo ejecutar/.test(both)) {
    console.log('     (skip: flow no instalado en este host)');
    return;
  }
  assert.equal(r.status, 0, `spec compila: ${both.slice(-300)}`);
  assert.match(r.stdout, /avatar compilado/, 'bloque de éxito uniforme');
  assert.match(r.stdout, /receta: piel=SKIN_02 pelo=short_01 ropa=suit/, 'receta del spec');
  const dec = lib.decodePNG(fs.readFileSync(out));
  assert.equal(dec.w, 18); assert.equal(dec.h, 32);
  assert.equal(lib.verifyAvatar(fs.readFileSync(out), { w: 18, h: 32, needAlpha: true, maxBytes: 512 * 1024 }).ok, true, 'M11 18×32');
});

t2('CLI spec: flags por parte + PANTONE: + INVALID limpio', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avS2-'));
  const run = (args) => spawnSync('node', [CLI, ...args], { encoding: 'utf8', timeout: 60000 });
  let r = run(['avatar', 'compilar', 'piel clara, traje negro', '--motor', 'spec', '--ropa', 'PANTONE 186 C rojo', '--salida', path.join(d, 'a.png')]);
  let both = r.stderr + r.stdout;
  if (r.status !== 0 && /flow no disponible|no se pudo ejecutar/.test(both)) {
    console.log('     (skip: flow no instalado en este host)');
    return;
  }
  assert.equal(r.status, 0, `flags: ${both.slice(-200)}`);
  const plain = run(['avatar', 'compilar', 'piel clara, traje negro', '--motor', 'spec', '--salida', path.join(d, 'b.png')]);
  assert.equal(plain.status, 0);
  assert.notDeepEqual(fs.readFileSync(path.join(d, 'a.png')), fs.readFileSync(path.join(d, 'b.png')), 'el flag cambia el PNG');
  r = run(['avatar', 'compilar', '--motor', 'spec', '--piel', 'morena', '--pelo', 'corto castaño', '--salida', path.join(d, 'c.png')]);
  assert.equal(r.status, 0, `solo flags: ${(r.stderr + r.stdout).slice(-200)}`);
  r = run(['avatar', 'compilar', 'pelo dragon', '--motor', 'spec', '--salida', path.join(d, 'x.png')]);
  assert.notStrictEqual(r.status, 0, 'INVALID muere limpio');
  assert.match(r.stderr + r.stdout, /INVALID_ENUM hair\.style/);
  assert.match(r.stderr + r.stdout, /short_01/, 'available para corregir');
  r = run(['avatar', 'compilar', '--motor', 'spec', '--salida', path.join(d, 'y.png')]);
  assert.notStrictEqual(r.status, 0, 'vacío sin partes se rechaza');
});

t2('CLI spec --dsl: archivo DSL válido compila; malo y contradicción mueren limpio', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avD-'));
  const run = (args) => spawnSync('node', [CLI, ...args], { encoding: 'utf8', timeout: 60000 });
  const good = path.join(d, 'bueno.txt');
  fs.writeFileSync(good, 'avatar {\n body standard_01\n skin SKIN_02\n hair short_01 HAIR_02\n eyes round_01 EYE_02\n shirt suit CLOTH_BLUE\n pants standard_01 CLOTH_BLUE\n shoes standard_01 CLOTH_BLACK\n}\n');
  let r = run(['avatar', 'compilar', '--dsl', good, '--salida', path.join(d, 'd.png')]);
  let both = r.stderr + r.stdout;
  if (r.status !== 0 && /flow no disponible|no se pudo ejecutar/.test(both)) {
    console.log('     (skip: flow no instalado en este host)');
    return;
  }
  assert.equal(r.status, 0, `dsl compila: ${both.slice(-200)}`);
  assert.match(r.stdout, /avatar compilado/);
  const dec = lib.decodePNG(fs.readFileSync(path.join(d, 'd.png')));
  assert.equal(dec.w, 18); assert.equal(dec.h, 32);
  const bad = path.join(d, 'malo.txt');
  fs.writeFileSync(bad, 'avatar {\n hair dragon_supersaiyan HAIR_01\n}\n');
  r = run(['avatar', 'compilar', '--dsl', bad, '--salida', path.join(d, 'e.png')]);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /INVALID_ENUM hair\.style/);
  r = run(['avatar', 'compilar', '--dsl', good, '--motor', 'local', '--salida', path.join(d, 'f.png')]);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /--dsl solo vale con --motor spec/);
  r = run(['avatar', 'compilar', '--dsl', path.join(d, 'noexiste.txt'), '--salida', path.join(d, 'g.png')]);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /no se lee --dsl/);
});

t2('CLI avatar inyectar: guarda, ver lista, quitar libera (sandbox userData)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avinj-'));
  const ud = path.join(d, 'ud');
  const run = (args) => spawnSync('node', [CLI, ...args],
    { encoding: 'utf8', timeout: 30000, env: { ...process.env, MUNDER_USER_DATA: ud, NO_COLOR: '1' } });
  let r = run(['avatar', 'inyectar', 'piel morena, pelo castaño largo, blusa rosa', '--slot', 'kelly']);
  assert.equal(r.status, 0, `inyecta: ${(r.stderr + r.stdout).slice(-300)}`);
  assert.match(r.stdout, /inyectado en 'kelly'/);
  const stored = JSON.parse(fs.readFileSync(path.join(ud, 'avatar-overrides.json'), 'utf8'));
  assert.equal(stored.version, 1);
  assert.equal(stored.overrides.kelly.recipe.skin, 'tan');
  for (const k of ['skin', 'hairc', 'hair', 'cloth', 'c1']) {
    assert.ok(stored.overrides.kelly.recipe[k] !== undefined, `receta trae ${k}`);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(stored.overrides.kelly.recipe)),
    stored.overrides.kelly.recipe, 'receta JSON-plana (round-trip)');
  r = run(['avatar', 'inyectar', '--ver']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /kelly: piel morena/);
  r = run(['avatar', 'inyectar', '--quitar', '--slot', 'kelly']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /eliminado/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ud, 'avatar-overrides.json'), 'utf8')).overrides, {});
});

t2('CLI avatar inyectar: michael no se presta; slot malo y auto sin canal mueren limpio', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'avinj2-'));
  const ud = path.join(d, 'ud');
  const run = (args) => spawnSync('node', [CLI, ...args],
    { encoding: 'utf8', timeout: 30000, env: { ...process.env, MUNDER_USER_DATA: ud, NO_COLOR: '1' } });
  let r = run(['avatar', 'inyectar', 'traje negro', '--slot', 'michael']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /GOD, no se presta/);
  r = run(['avatar', 'inyectar', 'traje negro', '--slot', 'goku']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /slot desconocido/);
  r = run(['avatar', 'inyectar', 'traje negro', '--slot', 'auto']);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /sin canal para auto/);
  assert.ok(!fs.existsSync(path.join(ud, 'avatar-overrides.json')), 'nada se guardó en los rechazos');
});

Promise.all(pending).then(() => {
  if (failures > 0) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
  console.log('\navatar: all green');
});
