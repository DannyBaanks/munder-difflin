'use strict';
/**
 * The Munder Link server in the foreground: exactly what `munder link servir`
 * runs, without the rest of the CLI. The app starts it detached (Settings →
 * Munder Link) the same way `munder link encender` does — same pid file, same
 * log — so the CLI and the app always agree on whether the link is on, and
 * either one can turn it off.
 */
const L = require('./lib-link.cjs');

const version = process.env.MUNDER_LINK_VERSION || 'app';
const { server, identity } = L.createLinkServer({ version });
const udp = L.createDiscoveryResponder({ version });

server.listen(L.DEFAULT_PORT, '0.0.0.0', () => {
  console.log(`[munder-link] ${identity.name} (${L.prettyFingerprint(identity.office_id)}) escuchando en 0.0.0.0:${L.DEFAULT_PORT}; hive: ${L.localHiveRoot() || '—'}`);
});
server.on('error', (e) => {
  console.error(`[munder-link] ${e.code === 'EADDRINUSE' ? `el puerto ${L.DEFAULT_PORT} está ocupado (¿ya está encendido?)` : e.message}`);
  process.exit(1);
});

const bye = () => { try { udp.close(); } catch { /* closed */ } server.close(() => process.exit(0)); };
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
