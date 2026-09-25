#!/usr/bin/env node
'use strict';
/**
 * The Reviver's MCP adapter: the boundary a ChatGPT/Claude connector talks to.
 *
 * An MCP server over stdio (JSON-RPC 2.0, one message per line) with three
 * tools: munder_status, munder_start, munder_restart. The ONLY input is
 * `machine`, an enum of the names in the targets file; each name maps to a
 * reviver credential (made with `munder-reviver cliente nuevo`). No address,
 * path, command or argument ever comes from the model.
 *
 * It talks straight to each machine's reviver (lib-reviver.cjs `call`), never
 * through Munder Link or the normal Munder MCP: those die with Munder.
 *
 *   MUNDER_REVIVER_TARGETS=/ruta/targets.json node reviver-mcp.cjs
 *
 * targets.json:
 *   { "machines": { "xeon":   { "credential": "/ruta/xeon.json",   "address": "100.64.0.7:47833" },
 *                   "victus": { "credential": "/ruta/victus.json" } } }
 *
 * Same network posture as munder-chatgpt-link: every address goes through its
 * network gate (loopback, same LAN subnet or Tailscale; the same
 * MUNDER_CHATGPT_ALLOW_* overrides). And every answer must carry the pinned
 * reviver's signature, so an address alone never proves anything.
 *
 * For chatgpt.com: src/mcp/munder-chatgpt-link/chatgpt-tunnel.sh --reviver
 * (its own connector, its own port; the tool surface stays exactly this).
 */
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const R = require('./lib-reviver.cjs');

const PROTOCOL_VERSION = '2025-06-18';
const GATE = path.join(__dirname, '..', '..', 'src', 'mcp', 'munder-chatgpt-link', 'network-gate.mjs');

let gate = null;
/** munder-chatgpt-link's gate, reused as is. Without it only loopback passes. */
async function gateFor(address) {
  if (!gate) {
    gate = import(require('node:url').pathToFileURL(GATE).href)
      .then((m) => m.gateReachability)
      .catch(() => (addr) => {
        const host = String(addr).replace(/^\[|\](:\d+)?$/g, '').replace(/:\d+$/, '');
        const ok = host === '::1' || /^127\./.test(host);
        return { ok, class: ok ? 'loopback' : 'unknown', reason: ok ? 'same host' : `network gate not found (${GATE}): only loopback` };
      });
  }
  return (await gate)(address);
}

function loadTargets(file = process.env.MUNDER_REVIVER_TARGETS) {
  if (!file) throw new Error('falta MUNDER_REVIVER_TARGETS (el archivo con las máquinas)');
  const raw = R.readJson(file, null);
  if (!raw || typeof raw.machines !== 'object' || !raw.machines) throw new Error(`${file} no tiene { "machines": { … } }`);
  const machines = {};
  for (const [name, m] of Object.entries(raw.machines)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name)) throw new Error(`nombre de máquina inválido: ${name}`);
    const credFile = path.resolve(path.dirname(file), m.credential);
    const cred = R.readJson(credFile, null);
    if (!cred || !cred.key || !cred.reviver) throw new Error(`${credFile} no es una credencial de reviver`);
    machines[name] = { cred, address: m.address || cred.reviver.address };
  }
  if (!Object.keys(machines).length) throw new Error('no hay máquinas en el archivo');
  return machines;
}

const TOOLS = [
  ['munder_status', 'status', 'Is Munder alive and healthy on this machine? Reports pid, health, verified office identity, watchdog and the last recovery action. Read-only.'],
  ['munder_start', 'start', 'Start Munder on this machine if it is not healthy. A no-op when it already is. Waits for health and office identity, and returns a receipt.'],
  ['munder_restart', 'restart', 'Restart Munder on this machine: stops only the verified Munder instance, starts it again, waits for health and office identity, and returns a receipt. Fails closed if the target is ambiguous.'],
];

function toolList(machines) {
  const names = Object.keys(machines);
  return TOOLS.map(([name, , description]) => ({
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: { machine: { type: 'string', enum: names, description: `One of: ${names.join(', ')}` } },
      required: ['machine'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: name === 'munder_status', destructiveHint: name === 'munder_restart', idempotentHint: name !== 'munder_restart', openWorldHint: false },
  }));
}

/** A line a person can read first, then the whole result for the model. */
function summarize(op, machine, r) {
  if (op === 'status') {
    const m = r.munder;
    return `${machine}: Munder ${r.healthy ? 'HEALTHY' : m.state.toUpperCase()}${m.pids.length ? ` (pid ${m.pids.join(', ')})` : ''}; identity ${m.identity_verified ? 'verified' : 'NOT verified'}; watchdog ${r.watchdog.state}${r.last ? `; last ${r.last.action} → ${r.last.verdict}` : ''}`;
  }
  return `${machine}: ${r.action} → ${r.verdict}${r.reason ? ` (${r.reason})` : ''}; receipt ${r.receipt_id}`;
}

async function handle(msg, machines, callImpl = R.call) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'munder-reviver', version: '1' } };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: toolList(machines) };
  if (method === 'tools/call') {
    const tool = TOOLS.find(([name]) => name === (params && params.name));
    if (!tool) throw Object.assign(new Error(`unknown tool: ${params && params.name}`), { rpc: -32602 });
    const args = (params && params.arguments) || {};
    const extra = Object.keys(args).filter((k) => k !== 'machine');
    if (extra.length) throw Object.assign(new Error(`unexpected arguments: ${extra.join(', ')}`), { rpc: -32602 });
    const target = Object.prototype.hasOwnProperty.call(machines, args.machine) ? machines[args.machine] : null;
    if (!target) throw Object.assign(new Error(`unknown machine: ${args.machine} (known: ${Object.keys(machines).join(', ')})`), { rpc: -32602 });
    const op = tool[1];
    const reach = await gateFor(target.address);
    if (!reach.ok) {
      return { content: [{ type: 'text', text: `${args.machine}: ${target.address} is not an allowed route (${reach.class}: ${reach.reason}). Use its Tailscale or same-LAN address.` }], isError: true };
    }
    try {
      const r = await callImpl(target.cred, op, { address: target.address });
      const ok = op === 'status' ? true : r.ok;
      return { content: [{ type: 'text', text: summarize(op, args.machine, r) }, { type: 'text', text: JSON.stringify(r, null, 2) }], structuredContent: r, isError: !ok };
    } catch (e) {
      // The reviver itself unreachable is information, not a protocol error: say so plainly.
      const why = e.cause && e.cause.code ? e.cause.code : e.code || e.message;
      return { content: [{ type: 'text', text: `${args.machine}: could not reach its reviver (${why}). If the machine is off or asleep, software cannot answer: it needs Wake-on-LAN or a person.` }], isError: true };
    }
  }
  if (id === undefined) return undefined; // a notification (e.g. notifications/initialized)
  throw Object.assign(new Error(`method not found: ${method}`), { rpc: -32601 });
}

function serve({ input = process.stdin, output = process.stdout, machines = loadTargets(), callImpl } = {}) {
  const rl = readline.createInterface({ input });
  const send = (m) => output.write(JSON.stringify(m) + '\n');
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    try {
      const result = await handle(msg, machines, callImpl);
      if (msg.id !== undefined && result !== undefined) send({ jsonrpc: '2.0', id: msg.id, result });
    } catch (e) {
      if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: e.rpc || -32603, message: e.message } });
    }
  });
  return rl;
}

if (require.main === module) {
  try { serve(); } catch (e) { console.error(`munder-reviver-mcp: ${e.message}`); process.exit(1); }
}

module.exports = { serve, handle, loadTargets, toolList, TOOLS };
