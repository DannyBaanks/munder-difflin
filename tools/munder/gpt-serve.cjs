'use strict';
/**
 * The Munder GPT gateway in the foreground: what `munder gpt encender` runs
 * detached. Loopback only; the public side is whatever transport `munder gpt`
 * configured (ngrok, cloudflared, your own reverse proxy), never this process.
 */
const fs = require('node:fs');
const G = require('./lib-gpt.cjs');

const dir = G.stateDir();
const config = G.loadConfig(dir);
const log = (m) => {
  const line = `${new Date().toISOString()} ${m}`;
  console.log(line);
};
const server = G.createGatewayServer({ dir, log });
server.listen(config.port, '127.0.0.1', () => {
  fs.writeFileSync(G.files(dir).pid, String(process.pid));
  log(`[munder-gpt] escuchando en 127.0.0.1:${config.port}; público: ${config.public_url || '—'}; perfil ${config.profile}`);
});
server.on('error', (e) => {
  console.error(`[munder-gpt] ${e.code === 'EADDRINUSE' ? `el puerto ${config.port} está ocupado (¿ya está encendido?)` : e.message}`);
  process.exit(1);
});
const bye = () => {
  try { if (fs.readFileSync(G.files(dir).pid, 'utf8').trim() === String(process.pid)) fs.unlinkSync(G.files(dir).pid); } catch { /* gone */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
