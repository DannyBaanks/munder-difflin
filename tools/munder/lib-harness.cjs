'use strict';
/**
 * External harnesses as Munder execution domains (P0).
 *
 *   Munder   = authority, routing, evidence   (this file: who asked, what for,
 *              what happened, what changed on disk, the receipt)
 *   Harness  = execution                      (its own session, agent loop,
 *              tools, subagents; opaque to Munder beyond the boundary below)
 *
 * The boundary Munder needs from any harness is small: open or resume a
 * session in a workspace, send one prompt, observe events, settle with a
 * status, cancel. Adapters implement exactly that and declare what else they
 * natively have (capabilities), instead of faking parity:
 *
 *   harness-acp.cjs    any Agent Client Protocol agent (DeepSeek Harness is
 *                      configured as `dsh --profile acp`; nothing DeepSeek-
 *                      specific lives in code)
 *   harness-codex.cjs  OpenAI Codex, self-operated (`codex exec --experimental-json`,
 *                      the surface the official Codex SDK drives)
 *
 * This core never branches on a vendor. It owns:
 *   - the receipt (Munder's record, normalised) next to the raw native events;
 *   - artifacts measured from the workspace (git), never taken from the
 *     harness's own claims;
 *   - the verdict: `completed` only when the harness settled successfully, not
 *     because the adapter process exited 0;
 *   - the recursion guard: a harness may not re-enter Munder's harness runner
 *     without an explicit, bounded transition;
 *   - credentials: adapters get secrets from the environment by NAME only;
 *     values never reach receipts, events on disk, the hive or argv.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CHAIN_ENV = 'MUNDER_HARNESS_CHAIN';
const MAX_DEPTH = 2;

class HarnessError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function stateDir() {
  const base = process.env.MUNDER_STATE_DIR
    || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'munder');
  return process.env.MUNDER_HARNESS_DIR || path.join(base, 'harness');
}

// ─── adapters (by name; the only place a harness is named) ───────────────────
function loadAdapters(dir = stateDir()) {
  const overrides = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'adapters.json'), 'utf8')); } catch { return {}; } })();
  const defaults = {
    codex: { kind: 'codex', command: 'codex', credential_env: ['CODEX_API_KEY', 'OPENAI_API_KEY'] },
    deepseek: { kind: 'acp', command: 'dsh', args: ['--profile', 'acp'], credential_env: ['DEEPSEEK_API_KEY'] },
  };
  const all = { ...defaults };
  for (const [name, cfg] of Object.entries(overrides)) all[name] = { ...(all[name] || {}), ...cfg };
  return all;
}

function adapterFor(name, dir) {
  const cfg = loadAdapters(dir)[name];
  if (!cfg) throw new HarnessError('unknown_adapter', `no hay adaptador «${name}» (${Object.keys(loadAdapters(dir)).join(', ')})`);
  const mod = cfg.kind === 'codex' ? require('./harness-codex.cjs') : cfg.kind === 'acp' ? require('./harness-acp.cjs') : null;
  if (!mod) throw new HarnessError('unknown_kind', `tipo de adaptador desconocido: ${cfg.kind}`);
  return { name, cfg, mod };
}

// ─── secrets: names travel, values don't ─────────────────────────────────────
const SECRET_KEY = /(api[_-]?key|authorization|token|secret|password|credential)/i;
const SECRET_VALUE = /\b(sk-[A-Za-z0-9_-]{8,}|mga_[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})/g;

/** Redact by key name, by known token shape, and by the exact values of the
 *  adapter's declared credential variables (so an unusual key format is still caught). */
function scrub(v, known = [], depth = 0) {
  if (depth > 8) return '…';
  if (typeof v === 'string') {
    let out = v.replace(SECRET_VALUE, '[REDACTED]');
    for (const k of known) if (k && k.length >= 8) out = out.split(k).join('[REDACTED]');
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => scrub(x, known, depth + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = SECRET_KEY.test(k) && typeof x === 'string' ? '[REDACTED]' : scrub(x, known, depth + 1);
    return o;
  }
  return v;
}

function credentialValues(cfg, env) {
  return (cfg && Array.isArray(cfg.credential_env) ? cfg.credential_env : []).map((n) => env[n]).filter(Boolean);
}

// ─── recursion guard ─────────────────────────────────────────────────────────
function readChain(env = process.env) {
  try { const c = JSON.parse(env[CHAIN_ENV] || '[]'); return Array.isArray(c) ? c : []; } catch { return []; }
}

/** A run started from inside another run is refused unless the caller asked for
 *  a nested transition explicitly, the depth stays bounded, and the harness is
 *  not re-entering itself. */
function checkRecursion(chain, adapter, nested) {
  if (!chain.length) return null;
  if (!nested) return `esta ejecución viene de dentro de otra (${chain.map((c) => `${c.adapter}:${c.run_id}`).join(' → ')}); para anidar hay que pedirlo con --anidado`;
  if (chain.length >= MAX_DEPTH) return `profundidad máxima (${MAX_DEPTH}) alcanzada`;
  if (chain.some((c) => c.adapter === adapter)) return `${adapter} ya está en la cadena: no se re-delega a sí mismo`;
  return null;
}

// ─── artifacts, measured from the workspace ──────────────────────────────────
function gitSnapshot(cwd) {
  const r = spawnSync('git', ['-C', cwd, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const out = new Map();
  for (const entry of r.stdout.split('\0').filter(Boolean)) {
    const file = entry.slice(3);
    out.set(file, { status: entry.slice(0, 2).trim(), hash: fileHash(path.join(cwd, file)) });
  }
  return out;
}

function fileHash(f) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return null; }
}

function artifactsBetween(cwd, before, after) {
  if (!before || !after) return { measured: false, reason: 'el workspace no es un repositorio git: artefactos no medidos', files: [] };
  const files = [];
  for (const [file, a] of after) {
    const b = before.get(file);
    if (!b || b.hash !== a.hash || b.status !== a.status) {
      let size = null;
      try { size = fs.statSync(path.join(cwd, file)).size; } catch { /* deleted */ }
      files.push({ path: file, git_status: a.status, sha256: a.hash, bytes: size });
    }
  }
  for (const file of before.keys()) if (!after.has(file)) files.push({ path: file, git_status: 'reverted', sha256: null, bytes: null });
  return { measured: true, files };
}

// ─── the run ─────────────────────────────────────────────────────────────────
const nowIso = () => new Date().toISOString();

/**
 * Run one prompt through one harness and return Munder's receipt.
 * opts: { adapter, prompt, cwd, resume?, taskId?, timeoutMs?, approvals?: 'reject'|'allow',
 *         requires?: string[], nested?: bool, requestedBy?: string, signal?, env? }
 */
async function run(opts) {
  const dir = opts.dir || stateDir();
  const runId = `hr_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
  const env = opts.env || process.env;
  const chain = readChain(env);
  const receipt = {
    receipt_id: crypto.randomUUID(), run_id: runId, kind: 'harness_run',
    requested_at: nowIso(), requested_by: opts.requestedBy || (chain.length ? `harness:${chain[chain.length - 1].adapter}` : 'operator'),
    adapter: opts.adapter, task_id: opts.taskId || null,
    cwd: opts.cwd ? path.resolve(opts.cwd) : null,
    prompt: { sha256: crypto.createHash('sha256').update(String(opts.prompt || '')).digest('hex'), excerpt: String(opts.prompt || '').slice(0, 200) },
    chain: chain.map((c) => ({ adapter: c.adapter, run_id: c.run_id })),
    resume: opts.resume || null,
  };
  const runDir = path.join(dir, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  let secrets = [];
  const finish = (fields) => {
    Object.assign(receipt, fields, { completed_at: nowIso() });
    receipt.ok = receipt.status === 'completed';
    // What leaves this function (printed by --json, stored, put on the card) is the scrubbed copy.
    const clean = scrub(receipt, secrets);
    fs.appendFileSync(path.join(dir, 'receipts.jsonl'), JSON.stringify(clean) + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(runDir, 'receipt.json'), JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 });
    if (opts.taskId) recordOnTask(opts.taskId, clean);
    return clean;
  };

  let a;
  try { a = adapterFor(opts.adapter, dir); } catch (e) { return finish({ status: 'rejected', error: { code: e.code, message: e.message } }); }
  secrets = credentialValues(a.cfg, env);
  const caps = a.mod.capabilities(a.cfg);
  receipt.capabilities = caps;
  const recursion = checkRecursion(chain, opts.adapter, !!opts.nested);
  if (recursion) return finish({ status: 'rejected', error: { code: 'recursion', message: recursion } });
  const missing = (opts.requires || []).filter((c) => !caps[c] || caps[c] === false);
  if (missing.length) return finish({ status: 'rejected', error: { code: 'unsupported_capability', message: `${opts.adapter} no tiene: ${missing.join(', ')}` } });
  if (!opts.cwd || !fs.existsSync(opts.cwd) || !fs.statSync(opts.cwd).isDirectory()) return finish({ status: 'rejected', error: { code: 'bad_cwd', message: `no existe la carpeta ${opts.cwd}` } });
  if (typeof opts.prompt !== 'string' || !opts.prompt.trim()) return finish({ status: 'rejected', error: { code: 'bad_prompt', message: 'falta la tarea' } });

  const rawFile = path.join(runDir, 'native-events.jsonl');
  const normFile = path.join(runDir, 'events.jsonl');
  const events = { tools: 0, tool_failures: 0, messages: 0, permissions: [] };
  const onNative = (ev) => fs.appendFileSync(rawFile, JSON.stringify(scrub(ev, secrets)) + '\n', { mode: 0o600 });
  const onEvent = (ev) => {
    if (ev.kind === 'tool_end') { events.tools++; if (ev.ok === false) events.tool_failures++; }
    if (ev.kind === 'message') events.messages++;
    if (ev.kind === 'permission') events.permissions.push({ title: ev.title, decision: ev.decision });
    fs.appendFileSync(normFile, JSON.stringify(scrub({ at: nowIso(), ...ev }, secrets)) + '\n', { mode: 0o600 });
  };
  const childChain = JSON.stringify([...chain, { adapter: opts.adapter, run_id: runId }]);
  const before = gitSnapshot(opts.cwd);
  receipt.started_at = nowIso();
  let out;
  try {
    out = await a.mod.run({
      cfg: a.cfg, prompt: opts.prompt, cwd: path.resolve(opts.cwd), resume: opts.resume || null,
      timeoutMs: opts.timeoutMs || 10 * 60_000, approvals: opts.approvals || 'reject', signal: opts.signal,
      env: { ...env, [CHAIN_ENV]: childChain }, onNative, onEvent,
    });
  } catch (e) {
    out = { status: 'failed', error: { code: e.code || 'adapter_error', message: e.message } };
  }
  const after = gitSnapshot(opts.cwd);
  // A harness that "finished" without a settled result is a failure, whatever its exit code.
  const valid = ['completed', 'failed', 'cancelled', 'timed_out'];
  const status = valid.includes(out && out.status) ? out.status : 'failed';
  return finish({
    status,
    stop_reason: (out && out.stop_reason) || null,
    error: status === 'completed' ? null : ((out && out.error) || { code: 'malformed_result', message: 'el adaptador no devolvió un resultado asentado' }),
    harness: (out && out.harness) || null,
    external_session_id: (out && out.session_id) || null,
    final_text: out && typeof out.final_text === 'string' ? out.final_text.slice(0, 4000) : null,
    usage: (out && out.usage) || null,
    events,
    artifacts: artifactsBetween(opts.cwd, before, after),
    evidence: { dir: runDir, native_events: fs.existsSync(rawFile) ? rawFile : null, events: fs.existsSync(normFile) ? normFile : null },
  });
}

/** When the run belongs to a Munder task, the card and the hive log say so (principal harness:<adapter>). */
function recordOnTask(taskId, receipt) {
  try {
    const L = require('./lib-link.cjs');
    const root = L.localHiveRoot();
    if (!root) return;
    const office = new L.Office(root, `harness:${receipt.adapter}`);
    const file = office.p('tasks.json');
    const doc = L.readJson(file, { tasks: [] });
    const t = (doc.tasks || []).find((x) => x && x.id === taskId);
    if (t) {
      t.harness_runs = [...(t.harness_runs || []), { receipt_id: receipt.receipt_id, run_id: receipt.run_id, adapter: receipt.adapter, external_session_id: receipt.external_session_id, status: receipt.status, completed_at: receipt.completed_at }];
      office.writeJson(file, doc);
    }
    office.log({ event: 'harness_run', principal: `harness:${receipt.adapter}`, task_id: taskId, run_id: receipt.run_id, receipt_id: receipt.receipt_id, status: receipt.status, external_session_id: receipt.external_session_id });
  } catch { /* the receipt file is the record of last resort */ }
}

function readReceipts(dir = stateDir(), n = 20) {
  try { return fs.readFileSync(path.join(dir, 'receipts.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-n).map((l) => JSON.parse(l)); } catch { return []; }
}

module.exports = { CHAIN_ENV, MAX_DEPTH, HarnessError, stateDir, loadAdapters, adapterFor, run, readReceipts, readChain, checkRecursion, scrub, gitSnapshot, artifactsBetween };
