'use strict';
/**
 * Generated inputs of the iOS app, from the same code the office runs:
 *
 *   Media/Cast/<name>.png      the cast's 18×28 pixel portraits (avatar-engine.cjs)
 *   Assets.xcassets/AppIcon…png    the app icon: Michael on the Munder lemon
 *   Tests/vectors.json             munder-remote@1 crypto vectors computed by the
 *                                  office's own Node code; the Swift tests must
 *                                  reproduce them byte for byte
 *
 *   node ios/MunderMobile/scripts/make-assets.cjs          write them
 *   node ios/MunderMobile/scripts/make-assets.cjs --check  exit 1 if any is stale
 *
 * No dependencies: a small PNG encoder lives below.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..', '..');
const A = require(path.join(REPO, 'tools/munder/avatar-engine.cjs'));
const R = require(path.join(REPO, 'tools/munder/lib-remote.cjs'));

// ─── PNG ─────────────────────────────────────────────────────────────────────
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** pixels: Uint8 array of w*h*channels; channels 4 (RGBA) or 3 (RGB). */
function png(w, h, pixels, channels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * channels + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * channels + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * w * channels, w * channels).copy(raw, y * (w * channels + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── outputs ─────────────────────────────────────────────────────────────────
function castPortraits() {
  const out = {};
  for (const name of Object.keys(A.AVATAR_RECIPES)) {
    const buf = A.composeAvatar(A.AVATAR_RECIPES[name]);
    out[`Media/Cast/${name}.png`] = png(A.PORTRAIT_W, A.PORTRAIT_H, new Uint8Array(buf), 4);
  }
  return out;
}

function appIcon() {
  const S = 1024, scale = 36;
  const bg = [0xdc, 0xab, 0x3c];
  const px = new Uint8Array(S * S * 3);
  for (let i = 0; i < S * S; i++) px.set(bg, i * 3);
  const src = A.composeAvatar(A.AVATAR_RECIPES.michael);
  const ox = Math.round((S - A.PORTRAIT_W * scale) / 2), oy = S - A.PORTRAIT_H * scale;
  for (let y = 0; y < A.PORTRAIT_H * scale; y++) {
    for (let x = 0; x < A.PORTRAIT_W * scale; x++) {
      const si = (Math.floor(y / scale) * A.PORTRAIT_W + Math.floor(x / scale)) * 4;
      const a = src[si + 3] / 255;
      if (!a) continue;
      const di = ((oy + y) * S + ox + x) * 3;
      for (let c = 0; c < 3; c++) px[di + c] = Math.round(src[si + c] * a + px[di + c] * (1 - a));
    }
  }
  return { 'Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png': png(S, S, px, 3) };
}

/** Fixed keys and nonces → what the office computes. The Swift tests must match. */
function vectors() {
  const b64u = (b) => Buffer.from(b).toString('base64url');
  const seed = (label) => crypto.createHash('sha256').update(`munder-mobile test vector ${label}`).digest();
  const x25519FromSeed = (raw) => {
    const der = Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]);
    const priv = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    return priv.export({ format: 'jwk' }); // { x, d }
  };
  const office = x25519FromSeed(seed('office'));
  const device = x25519FromSeed(seed('device'));
  const identity = { office_id: '0123456789abcdef', box: { x: office.x, d: office.d } };
  const deviceId = R.deviceIdOf(device.x);
  const key = R.remoteKey(identity, device.x, deviceId);
  const officeNonce = b64u(seed('office nonce').subarray(0, 16));
  const deviceNonceRaw = seed('device nonce').subarray(0, 16);
  const aad = (dir) => Buffer.from(`${R.REMOTE}|${dir}|${deviceId}|${identity.office_id}`);
  const seal = (dir, iv, text) => {
    const c = crypto.createCipheriv('chacha20-poly1305', key, iv, { authTagLength: 16 });
    const pt = Buffer.from(text, 'utf8');
    c.setAAD(aad(dir), { plaintextLength: pt.length });
    return b64u(Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]));
  };
  const reqIv = seed('request iv').subarray(0, 12);
  const resIv = seed('response iv').subarray(0, 12);
  const reqText = '{"ts":1790000000000,"op":"hello","args":{}}';
  const resText = '{"ok":true,"result":{"name":"michael-victus","addresses":[{"address":"100.101.4.7:47831","via":"tailscale"}]},"re":"' + b64u(reqIv) + '"}';
  return {
    'Tests/vectors.json': Buffer.from(JSON.stringify({
      protocol: R.REMOTE,
      office_id: identity.office_id,
      office_box_pub: office.x,
      device_priv: device.d,
      device_pub: device.x,
      device_id: deviceId,
      session_key: b64u(key),
      office_nonce: officeNonce,
      device_nonce: b64u(deviceNonceRaw),
      commit: b64u(crypto.createHash('sha256').update(deviceNonceRaw).digest()),
      sas: R.remoteSas(office.x, device.x, officeNonce, b64u(deviceNonceRaw)),
      request: { iv: b64u(reqIv), plaintext: reqText, ct: seal('req', reqIv, reqText) },
      response: { iv: b64u(resIv), plaintext: resText, ct: seal('res', resIv, resText) },
    }, null, 2) + '\n'),
  };
}

/** A real `overview` answer, from lib-remote.cjs over a small hive, with the host numbers pinned. */
function overviewFixture() {
  const os = require('node:os');
  const L = require(path.join(REPO, 'tools/munder/lib-link.cjs'));
  const hive = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-fixture-'));
  fs.writeFileSync(path.join(hive, 'registry.json'), JSON.stringify({ godId: 'god', agents: {
    god: { name: 'Michael', status: 'working', role: 'Orquestador' },
    'worker-pam': { name: 'Pam', status: 'blocked', role: 'Diseño y docs' },
    dwight: { name: 'Dwight', status: 'idle', onHold: true },
  } }));
  fs.writeFileSync(path.join(hive, 'tasks.json'), JSON.stringify({ tasks: [
    { id: 'task-1', title: 'Publicar la landing', status: 'blocked', assignee: 'worker-pam', dependsOn: [], priority: 3, createdAt: '2026-09-25T10:00:00.000Z',
      humanQA: [{ q: '**¿Qué dominio uso?**\n\n- `isyco.mx`', askedAt: '2026-09-25T10:05:00.000Z' }] },
    { id: 'task-2', title: 'Migrar tests', status: 'doing', assignee: 'dwight', dependsOn: [], priority: 'alta', createdAt: '2026-09-25T09:00:00Z', description: 'node --test', link: { from_name: 'michael-xeon' } },
    { id: 'task-3', status: 'done', dependsOn: [], result: 'listo' },
  ] }));
  const identity = { office_id: '0123456789abcdef', name: 'michael-victus' };
  const out = R.overview(new L.Office(hive, 'human', fs.mkdtempSync(path.join(os.tmpdir(), 'mm-state-'))), identity, 'fixture');
  out.office.host = 'victus';
  out.capacity = { ram_total_gb: 15.7, ram_free_gb: 9.2, cpus: 12, load1: 0.64, platform: 'linux', workers_total: 2, workers_idle: 1, michael_state: 'working', tasks_open: 2 };
  return { 'Tests/overview.json': Buffer.from(JSON.stringify(out, null, 2) + '\n') };
}

/** The data behind `-MunderDemo` (simulator screenshots): a lively office, same shape the office sends. */
function demoData() {
  const os = require('node:os');
  const L = require(path.join(REPO, 'tools/munder/lib-link.cjs'));
  const hive = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-demo-'));
  fs.writeFileSync(path.join(hive, 'registry.json'), JSON.stringify({ godId: 'god', agents: {
    god: { name: 'Michael', status: 'working', role: 'Orquestador' },
    dwight: { name: 'Dwight', status: 'working', role: 'Backend y tests' },
    jim: { name: 'Jim', status: 'idle', role: 'Frontend' },
    pam: { name: 'Pam', status: 'blocked', role: 'Diseño y docs' },
    oscar: { name: 'Oscar', status: 'idle', role: 'Finanzas', onHold: true },
  } }));
  fs.writeFileSync(path.join(hive, 'tasks.json'), JSON.stringify({ tasks: [
    { id: 'task-1', title: 'Publicar la landing de ISyCo', status: 'blocked', assignee: 'pam', dependsOn: [], createdAt: '2026-09-25T08:00:00.000Z',
      humanQA: [{ q: '**¿Qué dominio uso para la landing?** `isyco.mx` ya lo tienes; `isyco.office` hay que comprarlo.', askedAt: '2026-09-25T09:48:00.000Z' }] },
    { id: 'task-2', title: 'Cotización para cliente Monterrey', status: 'blocked', assignee: 'oscar', dependsOn: [], createdAt: '2026-09-25T07:00:00.000Z',
      humanQA: [{ q: '**¿Aplico el descuento del 10%?** El cliente lo pidió por correo.', askedAt: '2026-09-25T09:15:00.000Z' }] },
    { id: 'task-3', title: 'Migrar tests a node --test', status: 'doing', assignee: 'dwight', dependsOn: [], createdAt: '2026-09-25T09:30:00.000Z', description: 'Pasar los tests de mocha a node --test en tools/munder.' },
    { id: 'task-4', title: 'Rediseñar el onboarding', status: 'doing', assignee: 'jim', dependsOn: [], createdAt: '2026-09-25T09:10:00.000Z' },
    { id: 'task-5', title: 'Revisar PR de Windows CI', status: 'todo', dependsOn: [], createdAt: '2026-09-25T09:40:00.000Z' },
    { id: 'task-6', title: 'Pestaña Munder Link en Configuración', status: 'done', assignee: 'jim', dependsOn: [], createdAt: '2026-09-24T18:00:00.000Z', result: 'Mergeado en #12.' },
  ] }));
  const identity = { office_id: 'fa801f7ab6693f03', name: 'michael-victus' };
  const overview = R.overview(new L.Office(hive, 'human', fs.mkdtempSync(path.join(os.tmpdir(), 'mm-demo-state-'))), identity, 'demo');
  overview.office.host = 'victus';
  overview.capacity = { ram_total_gb: 15.7, ram_free_gb: 9.2, cpus: 12, load1: 0.64, platform: 'linux', workers_total: 4, workers_idle: 2, michael_state: 'working', tasks_open: 5 };
  const peers = { peers: [
    { office_id: '1029dd438aa3a6a1', name: 'michael-xeon', fingerprint: '1029 dd43 8aa3 a6a1', online: true, latency_ms: 27,
      capacity: { workers_idle: 12, workers_total: 16, ram_free_gb: 22.4, ram_total_gb: 31.9, michael_state: 'idle' } },
    { office_id: '77aa00bb11cc22dd', name: 'michael-laptop', fingerprint: '77aa 00bb 11cc 22dd', online: false, error: 'sin respuesta' },
  ] };
  return {
    'Media/Demo/overview.json': Buffer.from(JSON.stringify(overview, null, 2) + '\n'),
    'Media/Demo/demo-peers.json': Buffer.from(JSON.stringify(peers, null, 2) + '\n'),
  };
}

/**
 * `panel.state` as the office's own code answers it, so the Swift test decodes
 * the real bytes and not a shape someone typed.
 *
 * Same trick as `overviewFixture`: call the real thing, then pin the leaves that
 * belong to whoever ran the generator. Without that this fixture carries the
 * machine's Tailscale IP and hostname, and `make-assets.cjs --check` fails on a
 * CI runner that has neither. Both state dirs are sandboxed because `state()`
 * reaches the real `appStatus` and the real link files.
 */
async function panelFixture() {
  const os = require('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-panel-'));
  const office = path.join(home, 'office');
  process.env.MUNDER_LINK_DIR = office;
  process.env.MUNDER_USER_DATA = path.join(home, 'userdata');
  process.env.XDG_STATE_HOME = path.join(home, 'state');
  fs.mkdirSync(office, { recursive: true });
  // One phone, elevated, so the fixture carries the `authority` the app shows.
  const L = require(path.join(REPO, 'tools/munder/lib-link.cjs'));
  L.trustRemote({ office_id: '9ed00cd88840bed1', name: 'iPhone de Danny', box_pub: 'Vvzqnrc6mgdtA5HOBqVEEPKSn7nG3zGQysMrTDpWVlQ' }, office);
  L.setRemoteAuthority('9ed00cd88840bed1', L.REMOTE_AUTHORITY.MACHINE, office);
  const P = require(path.join(REPO, 'tools/munder/lib-panel.cjs'));
  const state = await P.state();
  // Deterministic leaves. The SHAPE is the office's; these three are the machine's.
  state.app = { running: false, pid: null, version: 'fixture' };
  state.link.name = 'michael-victus';
  state.link.fingerprint = 'a3cd ab50 d939 52ee';
  state.link.urls = [
    { url: 'http://192.168.1.64:47831/app/', via: 'red de casa' },
    { url: 'http://100.101.4.7:47831/app/', via: 'Tailscale (tambien fuera de casa)' },
  ];
  state.gpt = { available: false, on: false, running: false, profile: 'full', public_url: null, grants: 0, pending: [] };
  state.launcher = 'dev';
  const bytes = Buffer.from(JSON.stringify(state, null, 2) + '\n');
  // Also in the demo bundle, next to overview and demo-peers: that is what lets the
  // CI screenshots job photograph the Panel tab without a host behind it.
  return { 'Tests/panel.json': bytes, 'Media/Demo/demo-panel.json': bytes };
}

// panel.state() is async, so the whole pass is. Everything else is sync and
// unchanged; awaiting one fixture is cheaper than a second entry point.
const check = process.argv.includes('--check');
(async () => {
  const all = { ...castPortraits(), ...appIcon(), ...vectors(), ...overviewFixture(), ...demoData(), ...(await panelFixture()) };
  let stale = 0;
  for (const [rel, data] of Object.entries(all)) {
    const file = path.join(ROOT, rel);
    const same = fs.existsSync(file) && fs.readFileSync(file).equals(data);
    if (check) { if (!same) { console.error(`stale: ${rel}`); stale++; } continue; }
    if (!same) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); console.log(`wrote ${rel}`); }
  }
  if (check && stale) process.exit(1);
  if (check) console.log(`${Object.keys(all).length} generated files up to date`);
})();
module.exports = { png };
