#!/usr/bin/env node
'use strict';
/**
 * munder harness: hand one task to an external agent harness, get a receipt.
 *
 *   munder harness adaptadores
 *   munder harness run ADAPTADOR "tarea" --cwd DIR [--tarea ID] [--retomar SESIÓN]
 *        [--timeout S] [--aprobaciones reject|allow] [--requiere CAP]… [--anidado] [--json]
 *   munder harness recibos [N]
 *
 * Explicit selection only (P0): Munder does not route between harnesses yet.
 */
const H = require('./lib-harness.cjs');

const die = (m, code = 1) => { console.error(`munder harness: ${m}`); process.exit(code); };

function flags(args) {
  const out = { _: [], requiere: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    if (['json', 'anidado'].includes(k)) { out[k] = true; continue; }
    const v = args[++i];
    if (v === undefined) die(`--${k} necesita un valor`);
    if (k === 'requiere') out.requiere.push(v); else out[k] = v;
  }
  return out;
}

function show(r, asJson) {
  if (asJson) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log(`${r.adapter}: ${r.status}${r.stop_reason ? ` (${r.stop_reason})` : ''}${r.error ? ` — ${r.error.code}: ${r.error.message}` : ''}`);
  if (r.harness) console.log(`  harness:  ${[r.harness.name, r.harness.version, r.harness.protocol].filter(Boolean).join(' · ')}`);
  if (r.external_session_id) console.log(`  sesión:   ${r.external_session_id}`);
  if (r.events) console.log(`  eventos:  ${r.events.tools} herramienta(s)${r.events.tool_failures ? `, ${r.events.tool_failures} fallida(s)` : ''}, ${r.events.messages} mensaje(s)${r.events.permissions.length ? `, permisos: ${r.events.permissions.map((p) => p.decision).join(', ')}` : ''}`);
  if (r.artifacts) console.log(`  archivos: ${r.artifacts.measured ? (r.artifacts.files.map((f) => `${f.path} (${f.git_status})`).join(', ') || 'ninguno') : r.artifacts.reason}`);
  if (r.final_text) console.log(`  dijo:     ${r.final_text.slice(0, 300)}`);
  console.log(`  recibo:   ${r.receipt_id}${r.evidence ? `  (evidencia: ${r.evidence.dir})` : ''}`);
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const f = flags(rest);
  if (!cmd || cmd === 'ayuda' || cmd === 'help') {
    console.log('munder harness adaptadores | run ADAPTADOR "tarea" --cwd DIR [...] | recibos [N]\nGuía: EXTERNAL_HARNESS_AUDIT.md');
    return;
  }
  if (cmd === 'adaptadores' || cmd === 'adapters') {
    for (const [name, cfg] of Object.entries(H.loadAdapters())) {
      const { mod } = H.adapterFor(name);
      console.log(`${name.padEnd(10)} ${cfg.kind.padEnd(6)} ${[cfg.command, ...(cfg.args || [])].join(' ')}`);
      console.log(`           ${Object.entries(mod.capabilities(cfg)).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    }
    return;
  }
  if (cmd === 'recibos' || cmd === 'receipts') {
    for (const r of H.readReceipts(undefined, Number(f._[0]) || 20)) console.log(`${r.completed_at}  ${r.adapter.padEnd(9)} ${r.status.padEnd(10)} ${r.external_session_id || '—'}  ${r.prompt.excerpt.slice(0, 60)}`);
    return;
  }
  if (cmd === 'run') {
    const [adapter, prompt] = f._;
    if (!adapter || !prompt) die('uso: munder harness run ADAPTADOR "tarea" --cwd DIR');
    const ac = new AbortController();
    process.on('SIGINT', () => ac.abort());
    const r = await H.run({
      adapter, prompt, cwd: f.cwd || process.cwd(), taskId: f.tarea, resume: f.retomar,
      timeoutMs: f.timeout ? Number(f.timeout) * 1000 : undefined, approvals: f.aprobaciones,
      requires: f.requiere, nested: !!f.anidado, signal: ac.signal,
    });
    show(r, f.json);
    if (!r.ok) process.exitCode = r.status === 'rejected' ? 3 : 2;
    return;
  }
  die(`comando desconocido: ${cmd}`);
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => die(e.message));
module.exports = { main };
