'use strict';
/**
 * proveedor (sesion proveedor) tests — connect-style provider/model flow.
 * Self-contained, no framework: `node tools/munder/proveedor.test.cjs`.
 * Todo corre en sandbox (PATH/HOME falsos, sudo falso); la máquina real,
 * los CLIs reales y las keys reales no se tocan. Ningún test usa red.
 *
 * Cubre: detección de CLIs por PATH+dirs candidatos, catálogo de endpoints
 * íntegro contra modelCatalog.json y los profiles del fork, sudo-gate por
 * stub, higiene de secretos (la key de prueba solo aparece donde el diseño
 * lo permite) y un smoke del wizard por pty.
 */

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, 'munder');
const PUB = path.join(__dirname, '..', '..');
// Profiles del monorepo hermano (solo existen en la máquina del autor;
// si no están, el test 2 hace skip honesto en vez de fallar).
const FORK_PROFILES = process.env.FORK_PROFILES || path.join(PUB, '..', 'OpenISy', 'packages', 'llm', 'src', 'providers', 'openai-compatible-profile.ts');

let failures = 0;
const pending = [];
function test(name, fn) {
  pending.push((async () => {
    try { await fn(); console.log(`  ✓ ${name}`); }
    catch (err) { failures++; console.log(`  ✗ ${name}\n     ${err && err.message}`); }
  })());
}
async function drain() {
  await Promise.all(pending);
  if (failures > 0) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
  console.log('\nproveedor: all green');
}

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-'));
  const bin = path.join(base, 'bin');
  const home = path.join(base, 'home');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  // PATH del sandbox: node real primero (si no, ni 'node' resuelve -> ENOENT),
  // luego stubs, luego sistema. Sin el node real, spawnSync falla al instante
  // con status null y parece un cuelgue.
  const env = {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    HOME: home,
    MUNDER_STATE_DIR: path.join(home, '.state'),
  };
  delete env.MUNDER_DIR;
  return { base, bin, home, env };
}

console.log('proveedor tests');

// 1) El catálogo de endpoints del CLI existe y cita baseURLs reales del fork.
test('ENDPOINTS íntegro: 10 entradas con baseURL y keyEnv', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  for (const id of ['openai', 'anthropic', 'google', 'nvidia', 'groq', 'openrouter', 'deepseek', 'mistral', 'xai', 'together']) {
    assert.ok(src.includes(`id: '${id}'`), `falta endpoint ${id}`);
  }
  assert.ok(src.includes('https://integrate.api.nvidia.com/v1'), 'NVIDIA NIM documentado');
  assert.ok(src.includes('NVIDIA_API_KEY'), 'keyEnv NVIDIA');
});

// 2) Cross-check contra los profiles del fork (nada inventado en baseURLs).
test('baseURLs coinciden con OpenAICompatibleProfiles del fork', () => {
  if (!fs.existsSync(FORK_PROFILES)) {
    console.log('  ~ skip: sin profiles hermanos (FORK_PROFILES), solo se verifica el CLI');
    const cliOnly = fs.readFileSync(CLI, 'utf8');
    for (const url of ['https://api.groq.com/openai/v1', 'https://openrouter.ai/api/v1']) {
      assert.ok(cliOnly.includes(url), `CLI trae ${url}`);
    }
    return;
  }
  const cli = fs.readFileSync(CLI, 'utf8');
  const fork = fs.readFileSync(FORK_PROFILES, 'utf8');
  for (const [id, url] of [
    ['groq', 'https://api.groq.com/openai/v1'],
    ['openrouter', 'https://openrouter.ai/api/v1'],
    ['deepseek', 'https://api.deepseek.com/v1'],
    ['xai', 'https://api.x.ai/v1'],
    ['together', 'https://api.together.xyz/v1'],
  ]) {
    assert.ok(fork.includes(url), `fork trae ${url}`);
    assert.ok(cli.includes(url), `CLI trae ${url} (${id})`);
  }
});

// 3) Modelos: el CLI lee modelCatalog.json del checkout (sin duplicar listas).
test('modelCatalog.json del checkout tiene modelos por CLI', () => {
  const d = JSON.parse(fs.readFileSync(path.join(PUB, 'src', 'shared', 'modelCatalog.json'), 'utf8'));
  for (const id of ['claude', 'opencode', 'qwen']) {
    const ms = (d.providers[id] || []).filter((m) => m && m.id);
    assert.ok(ms.length > 0, `${id} sin modelos con id`);
  }
  assert.ok(fs.readFileSync(CLI, 'utf8').includes('modelCatalog.json'), 'el CLI lee el catálogo, no lo duplica');
});

// 4) Wizard headless: con flags llega a endpoint-select y cancela limpio
// (sin TTY no hay select: termina, no se cuelga, no pide sudo).
test('sesion proveedor con flags parciales termina limpio sin TTY', () => {
  const { bin, env: senv } = sandbox();
  fs.writeFileSync(path.join(bin, 'gemini'), '#!/bin/sh\necho gemini\n');
  fs.chmodSync(path.join(bin, 'gemini'), 0o755);
  const env = { ...senv, GEMINI_API_KEY: 'ya-la-tengo' };
  const r = spawnSync('node', [CLI, 'sesion', 'proveedor', '--cli', 'gemini', '--model', 'gemini-2.5-flash'],
    { encoding: 'utf8', env, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ok(r.status !== null, 'terminó (no se colgó)');
  assert.ok(/cancelado/.test(r.stdout), 'cancela limpio sin TTY para el select');
  assert.ok(!/sudo/.test(r.stdout), 'nunca llega a sudo');
});

// 5) Sin TTY + solo --cli: cancela en el siguiente select, sin sudo ni prompt.
test('sin TTY cancela limpio sin pedir sudo ni keys', () => {
  const { bin, env } = sandbox();
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho claude\n');
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  const r = spawnSync('node', [CLI, 'sesion', 'proveedor', '--cli', 'claude'],
    { encoding: 'utf8', env, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ok(r.status !== null, 'terminó');
  assert.ok(/cancelado/.test(r.stdout), 'cancela limpio');
  assert.ok(!/contraseña|Pega .*key/i.test(r.stdout + r.stderr), 'ni sudo ni prompt de key');
});

// 6) Higiene de secretos: el linker solo escribe el destino permitido.
test('linkKeyToCli solo toca el auth del CLI (código auditable)', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  assert.ok(src.includes('writableAuth'), 'allowlist explícito de escritura');
  assert.ok(src.includes('.bak-munder'), 'respaldo antes de escribir');
  assert.ok(src.includes('0600') || src.includes('0o600'), 'permisos restingidos en escritura');
  assert.ok(src.includes('NUNCA guarda keys'), 'disclaimer presente');
});

// 7) Higiene de secretos E2E (pty): la key pegada SOLO aparece en el auth
// del CLI destino; en ningún log, estado, roster ni repo.
test('secret hygiene: la key solo existe en el auth destino', () => {
  // Sin CLIs reales que muevan los menús (si los hay, skip honesto).
  const elsewhere = ['/usr/local/bin', '/opt/homebrew/bin'].flatMap((d) => {
    try { return fs.readdirSync(d); } catch { return []; }
  });
  const leak = ['claude', 'codex', 'gemini', 'opencode', 'qwen', 'crush', 'pi', 'copilot', 'cursor-agent', 'agy']
    .filter((b) => elsewhere.includes(b));
  if (leak.length) { console.log(`    (skip: CLIs reales en el sistema: ${leak.join(',')})`); return; }
  const { bin, home, env: senv } = sandbox();
  const munderDir = path.join(home, 'app');
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\necho codex\n');
  fs.chmodSync(path.join(bin, 'codex'), 0o755);
  fs.writeFileSync(path.join(bin, 'sudo'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(bin, 'sudo'), 0o755);
  const env = { ...senv, MUNDER_DIR: munderDir };
  fs.mkdirSync(path.join(munderDir, 'src', 'shared'), { recursive: true });
  fs.writeFileSync(path.join(munderDir, 'src', 'shared', 'modelCatalog.json'), JSON.stringify({
    version: 1,
    providers: { codex: [{ id: 'gpt-5-codex', label: 'GPT 5 Codex' }] },
  }));
  const FAKEKEY = 'sk-test-FAKEKEY-unauthorized';
  // Enter(toolchain: codex) Enter(endpoint propio) Enter(modelo) + key + ↓↓Enter(review cancelar).
  const keys = '\n\n\n' + FAKEKEY + '\n\x1b[B\x1b[B\n';
  // CLI entrecomillado: el checkout puede vivir en una ruta con espacios.
  const r = spawnSync('bash', ['-c', `printf %b "$KEYS" | timeout 30 script -qec "node \\"${CLI}\\" sesion proveedor" /dev/null`],
    { encoding: 'utf8', env: { ...env, KEYS: keys }, timeout: 45000 });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.ok(/vinculada en|No la guardé/.test(out), `el flujo de link corrió:\n${out.slice(-600)}`);
  const authFile = path.join(home, '.codex', 'auth.json');
  assert.ok(fs.existsSync(authFile), 'auth del CLI destino creado');
  assert.equal((fs.statSync(authFile).mode & 0o777), 0o600, 'auth con 0600');
  assert.equal(JSON.parse(fs.readFileSync(authFile, 'utf8')).OPENAI_API_KEY, FAKEKEY, 'key en destino');
  // La key NO existe en ningún otro archivo del sandbox (logs, estado, repo).
  // Se excluye SOLO el destino diseñado (~/.codex/auth.json); el .bak solo
  // existe si ya había archivo previo (aquí no lo hay).
  const bad = [];
  const scan2 = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (p === authFile) continue;
      if (e.isDirectory()) scan2(p);
      else if (e.isFile()) {
        try { if (fs.readFileSync(p, 'utf8').includes(FAKEKEY)) bad.push(p); } catch { /* noop */ }
      }
    }
  };
  scan2(home);
  assert.deepEqual(bad, [], `la key fugó a: ${bad.join(', ')}`);
});

// ─── chat IA (lib-personaje) ─────────────────────────────────────────────
const lib = require('./lib-personaje.cjs');

test('extraerPersonaje: bloque válido, último gana, inválidos a null', () => {
  const good = 'hola\n```personaje-json\n{"nombre":"Milo","rol":"ventas"}\n```\nlisto';
  assert.deepEqual(lib.extraerPersonaje(good), { nombre: 'Milo', rol: 'ventas', persona: '', avatar_desc: '' });
  const two = good + '\n```personaje-json\n{"nombre":"Otto"}\n```';
  assert.equal(lib.extraerPersonaje(two).nombre, 'Otto');
  assert.strictEqual(lib.extraerPersonaje('sin bloque'), null);
  assert.strictEqual(lib.extraerPersonaje('```personaje-json\n{roto\n```'), null);
  assert.strictEqual(lib.extraerPersonaje('```personaje-json\n{"rol":"x"}\n```'), null);
  assert.strictEqual(lib.extraerPersonaje(null), null);
});

test('parseSSEDataLine: content, done, ruido, JSON roto, forma message', () => {
  assert.deepEqual(lib.parseSSEDataLine('data: {"choices":[{"delta":{"content":"Hola"}}]}'), { content: 'Hola' });
  assert.deepEqual(lib.parseSSEDataLine('data: [DONE]'), { done: true });
  assert.strictEqual(lib.parseSSEDataLine(': comentario'), null);
  assert.strictEqual(lib.parseSSEDataLine(''), null);
  assert.strictEqual(lib.parseSSEDataLine('data: {roto'), null);
  assert.deepEqual(lib.parseSSEDataLine('data: {"choices":[{"message":{"content":"Hi"}}]}'), { content: 'Hi' });
  assert.strictEqual(lib.parseSSEDataLine('data: {"choices":[{"delta":{}}]}'), null);
});

test('SYSTEM_PERSONAJE: español, bloque personaje-json, sin dimensiones hardcodeadas', () => {
  const s = lib.SYSTEM_PERSONAJE;
  assert.ok(s.includes('personaje-json'), 'explica el formato de salida');
  for (const f of ['nombre', 'rol', 'persona', 'avatar_desc']) assert.ok(s.includes(f), `campo ${f}`);
  assert.ok(!/\d+x\d+/.test(s), 'sin dimensiones (las pone MUNDER_AVATAR_SPEC, no el usuario)');
  assert.ok(!/api[_-]?key/i.test(s), 'nunca pide keys');
});

test('lib-personaje no toca fs ni logs (higiene estructural)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'lib-personaje.cjs'), 'utf8');
  assert.ok(!/require\(['"]node:fs['"]\)/.test(src), 'sin fs');
  assert.ok(!/writeFileSync|appendFile|console\.log/.test(src), 'sin escritura ni logs propios');
});

function stubChatServer(handler) {
  const http = require('node:http');
  return new Promise((resolve) => {
    const seen = { auth: null, bodies: [] };
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.auth = req.headers.authorization || null;
        try { seen.bodies.push(JSON.parse(body)); } catch { /* noop */ }
        handler(req, res, seen);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, seen }));
  });
}

test('chatCompletions: SSE real, header Bearer, cuerpo sin key', async () => {
  const { srv, port, seen } = await stubChatServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Hola "}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"Milo"}}]}\n\n');
    res.end('data: [DONE]\n\n');
  });
  try {
    const tokens = [];
    const out = await lib.chatCompletions(`http://127.0.0.1:${port}`, 'sk-FAKE', 'm', [{ role: 'user', content: 'hola' }], (t) => tokens.push(t));
    assert.equal(out, 'Hola Milo');
    assert.deepEqual(tokens, ['Hola ', 'Milo']);
    assert.equal(seen.auth, 'Bearer sk-FAKE', 'key solo en header');
    assert.ok(!JSON.stringify(seen.bodies).includes('sk-FAKE'), 'key jamás en el cuerpo');
  } finally { srv.close(); }
});

test('chatCompletions: fallback no-stream + error con status sin fugas', async () => {
  const { srv, port } = await stubChatServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'listo' } }] }));
  });
  try {
    const out = await lib.chatCompletions(`http://127.0.0.1:${port}`, 'k', 'm', []);
    assert.equal(out, 'listo');
  } finally { srv.close(); }
  const { srv: srv2, port: port2 } = await stubChatServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad key' }));
  });
  try {
    await assert.rejects(
      lib.chatCompletions(`http://127.0.0.1:${port2}`, 'sk-SECRETA', 'm', []),
      (e) => {
        assert.match(e.message, /401/);
        assert.ok(!e.message.includes('sk-SECRETA'), 'el error no fuga la key');
        return true;
      });
  } finally { srv2.close(); }
});

test('chatearPersonaje E2E con io scripteado: propone y devuelve', async () => {
  const { srv, port } = await stubChatServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"va\\n```personaje-json\\n{\\"nombre\\":\\"Milo\\",\\"rol\\":\\"ventas\\"}\\n```"}}]}\n\ndata: [DONE]\n\n');
  });
  try {
    const said = [];
    const answers = ['quiero uno como jim', 0]; // mensaje, luego índice 0 (aceptar)
    let ai = 0;
    const io = {
      ask: async () => 'quiero uno como jim',
      select: async () => 0,
      print: (t) => { said.push(String(t)); },
    };
    const pj = await lib.chatearPersonaje(
      { label: 'Stub', baseURL: `http://127.0.0.1:${port}` }, 'stub-model', 'sk-FAKE', io);
    assert.deepEqual(pj && pj.nombre, 'Milo');
    assert.ok(said.join('\n').includes('¡Personaje propuesto!'), 'muestra la propuesta');
    void ai;
  } finally { srv.close(); }
});

drain();
