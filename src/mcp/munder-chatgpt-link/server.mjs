#!/usr/bin/env node
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { gateReachability } from './network-gate.mjs';

const require = createRequire(import.meta.url);
const defaultLinkModule = fileURLToPath(new URL('../../../tools/munder/lib-link.cjs', import.meta.url));
const link = require(process.env.MUNDER_LINK_MODULE || defaultLinkModule);

const {
  call,
  delegate,
  loadPeers,
  findPeer,
  prettyFingerprint,
  stateDir,
} = link;

const SERVER_NAME = 'munder-chatgpt-link';
const SERVER_VERSION = '0.1.0';
const PROTOCOL = 'munder-chatgpt-link@1';
const LINK_DIR = process.env.MUNDER_LINK_DIR || stateDir();

function asText(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ protocol: PROTOCOL, ...value }, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function peerSummary(peer) {
  return {
    office_id: peer.office_id,
    name: peer.name,
    fingerprint: prettyFingerprint(peer.office_id),
    addresses: peer.addresses || [],
    paired_at: peer.paired_at || null,
  };
}

async function verifyOffice(query) {
  const peers = loadPeers(LINK_DIR);
  const peer = findPeer(query, peers);
  if (!peer) {
    const err = new Error(`No hay una oficina Munder Link emparejada que coincida con «${query}».`);
    err.code = 'unknown_peer';
    throw err;
  }

  // This is already a signed + encrypted Munder Link round-trip. If the pinned
  // key or remote identity does not match, lib-link rejects the response.
  const probe = await call(query, 'status', {}, { dir: LINK_DIR, timeoutMs: 5000 });
  const network = gateReachability(probe.address);

  if (!network.ok) {
    const err = new Error(
      `Peer autenticado, pero la ruta ${probe.address} no cumple el gate local: ${network.reason}. ` +
      'Usa la misma LAN/Tailscale, o habilita una excepción explícita.'
    );
    err.code = 'network_gate_failed';
    err.details = { address: probe.address, network, peer: peerSummary(peer) };
    throw err;
  }

  return {
    verified: true,
    peer: peerSummary(probe.peer),
    address: probe.address,
    latency_ms: probe.latency_ms,
    network,
    remote: probe.result,
  };
}

async function gatedCall(office, op, args = {}) {
  const verification = await verifyOffice(office);
  const result = await call(office, op, args, { dir: LINK_DIR });
  return { verification, result: result.result, latency_ms: result.latency_ms, address: result.address };
}

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'munder_link_verify',
      description: 'Verify that a paired Munder office is cryptographically authenticated and reachable over loopback, the same LAN subnet, or Tailscale. Performs a signed+encrypted status round-trip before returning success.',
      inputSchema: {
        type: 'object',
        properties: { office: { type: 'string', description: 'Paired office name/id/prefix, e.g. xeon' } },
        required: ['office'],
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'munder_link_peers',
      description: 'List locally paired Munder Link offices without exposing private keys.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'munder_office_status',
      description: 'Get capacity and Michael state from a verified paired office. The network/identity gate runs first.',
      inputSchema: {
        type: 'object',
        properties: { office: { type: 'string' } },
        required: ['office'],
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'munder_compose_submit',
      description: 'Delegate a compose to Michael in a verified paired Munder office. Returns the remote task id and Munder Link receipt metadata.',
      inputSchema: {
        type: 'object',
        properties: {
          office: { type: 'string', description: 'Paired office name/id/prefix' },
          compose: { type: 'string', description: 'Instruction for remote Michael' },
          title: { type: 'string' },
          priority: { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['office', 'compose'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'munder_task_get',
      description: 'Read one remote task that this office delegated. Munder Link itself prevents reading unrelated tasks.',
      inputSchema: {
        type: 'object',
        properties: { office: { type: 'string' }, task_id: { type: 'string' } },
        required: ['office', 'task_id'],
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'munder_task_message',
      description: 'Add context to a remote delegated task through Michael after re-verifying the peer and network route.',
      inputSchema: {
        type: 'object',
        properties: {
          office: { type: 'string' },
          task_id: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['office', 'task_id', 'message'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'munder_task_cancel',
      description: 'Request safe cancellation of a remote delegated task through Michael. This does not directly kill a worker process.',
      inputSchema: {
        type: 'object',
        properties: {
          office: { type: 'string' },
          task_id: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['office', 'task_id'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    switch (name) {
      case 'munder_link_verify':
        return asText(await verifyOffice(args.office));

      case 'munder_link_peers': {
        const peers = Object.values(loadPeers(LINK_DIR)).map(peerSummary);
        return asText({ peers });
      }

      case 'munder_office_status':
        return asText(await gatedCall(args.office, 'status'));

      case 'munder_compose_submit': {
        const verification = await verifyOffice(args.office);
        const result = await delegate(args.office, args.compose, {
          title: args.title,
          priority: args.priority,
          dir: LINK_DIR,
        });
        return asText({
          verification,
          result: result.result,
          origin_ref: result.origin_ref,
          address: result.address,
          latency_ms: result.latency_ms,
        });
      }

      case 'munder_task_get':
        return asText(await gatedCall(args.office, 'get', { task_id: args.task_id }));

      case 'munder_task_message':
        return asText(await gatedCall(args.office, 'message', { task_id: args.task_id, message: args.message }));

      case 'munder_task_cancel':
        return asText(await gatedCall(args.office, 'cancel', { task_id: args.task_id, reason: args.reason || '' }));

      default:
        return asText({ error: 'unknown_tool', tool: name }, true);
    }
  } catch (error) {
    return asText({
      error: error?.code || 'munder_link_error',
      message: error instanceof Error ? error.message : String(error),
      details: error?.details || undefined,
    }, true);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[${SERVER_NAME}] ready (${PROTOCOL}); link dir=${LINK_DIR}`);
