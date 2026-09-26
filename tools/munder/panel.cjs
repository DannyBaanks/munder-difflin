#!/usr/bin/env node
'use strict';
/**
 * Munder Panel: opens the button panel in the browser.
 *
 *   munder panel                 dev checkout
 *   "Munder Difflin" --panel     packaged app (the launcher runs this file as node)
 *   … [--no-abrir]               start it without opening the browser (tests, SSH)
 *
 * One panel at a time: a second launch reopens the one already running. It
 * closes itself a couple of minutes after its page is closed.
 */
const fs = require('node:fs');
const path = require('node:path');
const P = require('./lib-panel.cjs');

const IDLE_MS = 2 * 60_000;

async function reuse(file) {
  const s = P.readJson(file);
  if (!s || !s.pid || !s.port || !s.token || !P.alive(s.pid)) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}/api/state`, { headers: { 'x-munder-panel': s.token }, signal: AbortSignal.timeout(3000) });
    if (r.status === 200) return `http://127.0.0.1:${s.port}/#t=${s.token}`;
  } catch { /* stale */ }
  return null;
}

async function main() {
  const open = !process.argv.includes('--no-abrir');
  const dir = P.stateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'panel.json');

  const existing = await reuse(file);
  if (existing) {
    console.log(`Munder Panel ya estaba abierto: ${existing.replace(/#t=.*/, '')}`);
    if (open) P.openBrowser(existing);
    return;
  }

  const bye = () => { try { if (P.readJson(file)?.pid === process.pid) fs.unlinkSync(file); } catch { /* gone */ } process.exit(0); };
  const { server, token, url } = P.createPanelServer({ idleMs: IDLE_MS, onIdle: bye });
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, port, token }), { mode: 0o600 });
    console.log(`Munder Panel en http://127.0.0.1:${port}/ (se cierra solo al cerrar la página)`);
    if (open) P.openBrowser(url());
  });
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}

main().catch((e) => { console.error(`munder panel: ${e.message}`); process.exit(1); });
