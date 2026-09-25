/*
 * Munder Remote — the phone's crypto, in plain JavaScript.
 *
 * Why not WebCrypto: `crypto.subtle` only exists in a secure context, and the
 * phone must also work over plain http on the home LAN (http://192.168.x.y:47831/app).
 * `crypto.getRandomValues` works everywhere, so only the primitives are ours:
 * X25519 (RFC 7748), SHA-256 / HMAC / HKDF (RFC 5869) and ChaCha20-Poly1305
 * (RFC 8439). The office side uses Node's native implementations of the same
 * algorithms, and the focused tests check both agree byte for byte.
 *
 * The X25519 here is BigInt and not constant-time. It runs once per pairing on
 * the phone, with a key that only ever talks to one office; timing it would take
 * code already running on the phone.
 *
 * Loads as a CommonJS module (tests) or as a classic <script> (window.MunderCrypto).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MunderCrypto = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const utf8 = (s) => enc.encode(String(s));

  function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  // ── base64url ──────────────────────────────────────────────────────────────
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function b64u(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
      if (i + 1 < bytes.length) s += B64[(n >> 6) & 63];
      if (i + 2 < bytes.length) s += B64[n & 63];
    }
    return s;
  }
  function fromB64u(str) {
    const s = String(str).replace(/=+$/, '');
    const out = new Uint8Array(Math.floor((s.length * 3) / 4));
    let bits = 0, acc = 0, o = 0;
    for (const ch of s) {
      const v = B64.indexOf(ch === '+' ? '-' : ch === '/' ? '_' : ch);
      if (v < 0) throw new Error('base64 inválido');
      acc = (acc << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
    }
    return out.subarray(0, o);
  }
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

  function random(n) {
    const out = new Uint8Array(n);
    globalThis.crypto.getRandomValues(out);
    return out;
  }

  // ── SHA-256 / HMAC / HKDF ─────────────────────────────────────────────────
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function sha256(data) {
    const msg = typeof data === 'string' ? utf8(data) : data;
    const len = msg.length;
    const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
    padded.set(msg);
    padded[len] = 0x80;
    const bits = len * 8;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(padded.length - 4, bits >>> 0);
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < padded.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    const out = new Uint8Array(32);
    const ov = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
    return out;
  }

  function hmac(key, data) {
    let k = typeof key === 'string' ? utf8(key) : key;
    if (k.length > 64) k = sha256(k);
    const ipad = new Uint8Array(64), opad = new Uint8Array(64);
    for (let i = 0; i < 64; i++) { ipad[i] = (k[i] || 0) ^ 0x36; opad[i] = (k[i] || 0) ^ 0x5c; }
    return sha256(concat(opad, sha256(concat(ipad, typeof data === 'string' ? utf8(data) : data))));
  }

  function hkdf(ikm, salt, info, length) {
    const prk = hmac(typeof salt === 'string' ? utf8(salt) : salt, ikm);
    const out = new Uint8Array(length);
    let prev = new Uint8Array(0);
    for (let i = 0, o = 0; o < length; i++) {
      prev = hmac(prk, concat(prev, typeof info === 'string' ? utf8(info) : info, new Uint8Array([i + 1])));
      out.set(prev.subarray(0, Math.min(32, length - o)), o);
      o += 32;
    }
    return out;
  }

  // ── X25519 ────────────────────────────────────────────────────────────────
  const P = (1n << 255n) - 19n;
  const mod = (a) => { const r = a % P; return r >= 0n ? r : r + P; };
  function modPow(b, e) {
    let r = 1n; b = mod(b);
    while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; }
    return r;
  }
  function leToBig(bytes) {
    let n = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
    return n;
  }
  function bigToLe(n, len) {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) { out[i] = Number(n & 255n); n >>= 8n; }
    return out;
  }

  function x25519(scalar, uBytes) {
    const k = Uint8Array.from(scalar);
    k[0] &= 248; k[31] &= 127; k[31] |= 64;
    const u = Uint8Array.from(uBytes);
    u[31] &= 127;
    const kn = leToBig(k);
    const x1 = mod(leToBig(u));
    let x2 = 1n, z2 = 0n, x3 = x1, z3 = 1n, swap = 0n;
    for (let t = 254; t >= 0; t--) {
      const kt = (kn >> BigInt(t)) & 1n;
      swap ^= kt;
      if (swap) { [x2, x3] = [x3, x2]; [z2, z3] = [z3, z2]; }
      swap = kt;
      const A = mod(x2 + z2), AA = (A * A) % P, B = mod(x2 - z2), BB = (B * B) % P, E = mod(AA - BB);
      const C = mod(x3 + z3), D = mod(x3 - z3), DA = (D * A) % P, CB = (C * B) % P;
      x3 = mod((DA + CB) * (DA + CB));
      z3 = (x1 * mod((DA - CB) * (DA - CB))) % P;
      x2 = (AA * BB) % P;
      z2 = (E * mod(AA + 121665n * E)) % P;
    }
    if (swap) { [x2, x3] = [x3, x2]; [z2, z3] = [z3, z2]; }
    const out = bigToLe((x2 * modPow(z2, P - 2n)) % P, 32);
    if (out.every((b) => b === 0)) throw new Error('llave pública inválida');
    return out;
  }
  const BASE = (() => { const b = new Uint8Array(32); b[0] = 9; return b; })();
  function x25519Keypair() {
    const priv = random(32);
    return { priv, pub: x25519(priv, BASE) };
  }

  // ── ChaCha20-Poly1305 ────────────────────────────────────────────────────
  function chachaBlock(key, counter, nonce) {
    const kv = new DataView(key.buffer, key.byteOffset, 32);
    const nv = new DataView(nonce.buffer, nonce.byteOffset, 12);
    const s = new Uint32Array(16);
    s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574;
    for (let i = 0; i < 8; i++) s[4 + i] = kv.getUint32(i * 4, true);
    s[12] = counter;
    for (let i = 0; i < 3; i++) s[13 + i] = nv.getUint32(i * 4, true);
    const x = Uint32Array.from(s);
    const rotl = (v, c) => (v << c) | (v >>> (32 - c));
    const qr = (a, b, c, d) => {
      x[a] += x[b]; x[d] = rotl(x[d] ^ x[a], 16);
      x[c] += x[d]; x[b] = rotl(x[b] ^ x[c], 12);
      x[a] += x[b]; x[d] = rotl(x[d] ^ x[a], 8);
      x[c] += x[d]; x[b] = rotl(x[b] ^ x[c], 7);
    };
    for (let i = 0; i < 10; i++) {
      qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
      qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
    }
    const out = new Uint8Array(64);
    const ov = new DataView(out.buffer);
    for (let i = 0; i < 16; i++) ov.setUint32(i * 4, (x[i] + s[i]) >>> 0, true);
    return out;
  }

  function chachaXor(key, nonce, counter, data) {
    const out = new Uint8Array(data.length);
    for (let off = 0, c = counter; off < data.length; off += 64, c++) {
      const ks = chachaBlock(key, c, nonce);
      for (let i = 0; i < 64 && off + i < data.length; i++) out[off + i] = data[off + i] ^ ks[i];
    }
    return out;
  }

  const P130 = (1n << 130n) - 5n;
  const M128 = (1n << 128n) - 1n;
  function poly1305(otk, msg) {
    const r = leToBig(otk.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
    const s = leToBig(otk.subarray(16, 32));
    let acc = 0n;
    for (let i = 0; i < msg.length; i += 16) {
      const chunk = msg.subarray(i, i + 16);
      acc = ((acc + leToBig(chunk) + (1n << BigInt(8 * chunk.length))) * r) % P130;
    }
    return bigToLe((acc + s) & M128, 16);
  }

  function macData(aad, ct) {
    const pad = (n) => new Uint8Array((16 - (n % 16)) % 16);
    return concat(aad, pad(aad.length), ct, pad(ct.length), bigToLe(BigInt(aad.length), 8), bigToLe(BigInt(ct.length), 8));
  }

  /** ciphertext ‖ 16-byte tag, exactly what Node's chacha20-poly1305 produces. */
  function aeadSeal(key, nonce, plaintext, aad) {
    const pt = typeof plaintext === 'string' ? utf8(plaintext) : plaintext;
    const ad = typeof aad === 'string' ? utf8(aad) : aad;
    const otk = chachaBlock(key, 0, nonce).subarray(0, 32);
    const ct = chachaXor(key, nonce, 1, pt);
    return concat(ct, poly1305(otk, macData(ad, ct)));
  }

  function aeadOpen(key, nonce, sealed, aad) {
    if (sealed.length < 16) throw new Error('mensaje cifrado inválido');
    const ad = typeof aad === 'string' ? utf8(aad) : aad;
    const ct = sealed.subarray(0, sealed.length - 16);
    const tag = sealed.subarray(sealed.length - 16);
    const want = poly1305(chachaBlock(key, 0, nonce).subarray(0, 32), macData(ad, ct));
    let diff = 0;
    for (let i = 0; i < 16; i++) diff |= want[i] ^ tag[i];
    if (diff) throw new Error('no se pudo descifrar');
    return chachaXor(key, nonce, 1, ct);
  }

  // ── the munder-remote@1 protocol (same strings as tools/munder/lib-remote.cjs) ──
  const REMOTE = 'munder-remote@1';
  const aadFor = (dir, deviceId, officeId) => `${REMOTE}|${dir}|${deviceId}|${officeId}`;

  function deviceIdOf(pubBytes) { return hex(sha256(pubBytes)).slice(0, 16); }

  /** Both screens show this; the phone's nonce was committed before the office answered. */
  function sas(officeBoxPub, devicePub, officeNonce, deviceNonce) {
    const h = sha256(`${REMOTE}|sas|${officeBoxPub}|${devicePub}|${officeNonce}|${deviceNonce}`);
    return String(new DataView(h.buffer).getUint32(0) % 1000000).padStart(6, '0');
  }

  function sessionKey(devicePriv, officeBoxPub, officeId, deviceId) {
    const shared = x25519(devicePriv, fromB64u(officeBoxPub));
    return hkdf(shared, `${officeId}|${deviceId}`, `${REMOTE} key`, 32);
  }

  function sealRequest(key, deviceId, officeId, payload) {
    const iv = random(12);
    const ct = aeadSeal(key, iv, JSON.stringify(payload), aadFor('req', deviceId, officeId));
    return { v: 1, dev: deviceId, iv: b64u(iv), ct: b64u(ct) };
  }

  function openResponse(key, deviceId, officeId, env) {
    const pt = aeadOpen(key, fromB64u(env.iv), fromB64u(env.ct), aadFor('res', deviceId, officeId));
    return JSON.parse(dec.decode(pt));
  }

  return {
    REMOTE, utf8, concat, b64u, fromB64u, hex, random,
    sha256, hmac, hkdf, x25519, x25519Keypair, BASE,
    chachaBlock, poly1305, aeadSeal, aeadOpen,
    aadFor, deviceIdOf, sas, sessionKey, sealRequest, openResponse,
  };
});
