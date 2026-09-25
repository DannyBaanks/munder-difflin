#!/usr/bin/env node
/**
 * Office Bridge MCP v1 — Server (plain JS, no compile step)
 *
 * A local-first MCP server that lets ChatGPT/Codex submit work to Michael
 * (the orchestrator in Munder Difflin), observe its lifecycle, add context,
 * request cancellation, and inspect office state.
 *
 * Protocol: office-bridge@1
 * Transport: stdio (JSON-RPC 2.0)
 * Security: local only; no network listener
 *
 * Usage:
 *   node server.js
 *
 * Environment:
 *   HIVE_ROOT  — path to the hive directory (required)
 *   AGENT_ID   — this agent's id (default: 'office-bridge')
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema
} = require('@modelcontextprotocol/sdk/types.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = 'office-bridge@1';
const SERVER_NAME = 'office-bridge';
const SERVER_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Hive Adapter (inline, no separate file needed)
// ---------------------------------------------------------------------------

class HiveAdapter {
  constructor(hiveRoot, agentId) {
    this.hiveRoot = hiveRoot || process.env.HIVE_ROOT || '';
    this.agentId = agentId || process.env.AGENT_ID || 'office-bridge';
    this.idempotencyCache = new Map();
    if (!this.hiveRoot) {
      throw new Error('HIVE_ROOT environment variable is required');
    }
  }

  // -- Path helpers --------------------------------------------------------

  safePath(...parts) {
    const p = path.resolve(this.hiveRoot, ...parts);
    const rel = path.relative(this.hiveRoot, p);
    if (rel.startsWith('..') || rel.startsWith('/')) {
      throw new Error(`Path traversal detected: ${parts.join('/')}`);
    }
    return p;
  }

  godInbox() {
    return this.safePath('agents', 'god', 'inbox');
  }

  tasksFile() {
    return this.safePath('tasks.json');
  }

  registryFile() {
    return this.safePath('registry.json');
  }

  logFile() {
    return this.safePath('log.jsonl');
  }

  // -- File I/O ------------------------------------------------------------

  readJson(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return null;
    }
  }

  writeJson(filePath, data) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }

  appendLog(entry) {
    const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() });
    const logPath = this.logFile();
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(logPath, line + '\n', { flag: 'a' });
  }

  // -- Receipt creation ----------------------------------------------------

  makeReceipt(kind, correlationId) {
    return {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      kind,
      correlation_id: correlationId
    };
  }

  // -- Message creation ----------------------------------------------------

  createMessage(to, subject, body, act = 'request') {
    const now = new Date().toISOString();
    return {
      id: `${now.replace(/[:.]/g, '-').slice(0, 19)}Z-${crypto.randomUUID().slice(0, 8)}`,
      conversation: `bridge-${crypto.randomUUID().slice(0, 8)}`,
      in_reply_to: null,
      from: this.agentId,
      to,
      act,
      subject,
      body,
      hops: 0,
      requires_reply: act === 'request' || act === 'query' || act === 'propose',
      needs_human: false,
      created_at: now
    };
  }

  deliverMessage(msg, toId) {
    const inboxDir = this.safePath('agents', toId, 'inbox');
    if (!fs.existsSync(inboxDir)) {
      fs.mkdirSync(inboxDir, { recursive: true });
    }
    const msgPath = path.join(inboxDir, `${msg.id}.json`);
    this.writeJson(msgPath, msg);
    return msg.id;
  }

  // -- Task helpers --------------------------------------------------------

  readTasks() {
    const data = this.readJson(this.tasksFile());
    return data?.tasks || [];
  }

  writeTasks(tasks) {
    this.writeJson(this.tasksFile(), { tasks });
  }

  mapHiveStatus(hiveStatus) {
    const map = { todo: 'queued', doing: 'working', blocked: 'blocked', done: 'done' };
    return map[hiveStatus] || 'queued';
  }

  // -- Registry helpers ----------------------------------------------------

  readRegistry() {
    return this.readJson(this.registryFile()) || {};
  }

  // =========================================================================
  // Public API — the five tools
  // =========================================================================

  async composeSubmit(params) {
    // Idempotency check
    if (params.idempotency_key && this.idempotencyCache.has(params.idempotency_key)) {
      return this.idempotencyCache.get(params.idempotency_key);
    }

    const taskId = `task-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const title = params.title || params.compose.slice(0, 80);
    const body = [
      '## Office Bridge Compose\n',
      params.compose,
      params.constraints?.length ? `\n**Constraints:** ${params.constraints.join(', ')}` : '',
      params.attachments?.length
        ? `\n**Attachments:** ${params.attachments.map(a => a.name).join(', ')}`
        : ''
    ].join('\n');

    // 1. Create message to Michael
    const msg = this.createMessage('god', title, body, 'request');
    const messageId = this.deliverMessage(msg, 'god');

    // 2. Create task in tasks.json
    const task = {
      id: taskId,
      title,
      description: params.compose,
      status: 'todo',
      dependsOn: [],
      priority: params.priority ?? 5,
      createdAt: new Date().toISOString()
    };
    const tasks = this.readTasks();
    tasks.push(task);
    this.writeTasks(tasks);

    // 3. Audit log
    this.appendLog({
      event: 'compose_submit',
      task_id: taskId,
      message_id: messageId,
      from: this.agentId,
      compose: params.compose.slice(0, 200)
    });

    const receipt = this.makeReceipt('compose_submitted', taskId);
    const result = {
      task_id: taskId,
      message_id: messageId,
      status: 'accepted',
      receipt
    };

    // Cache for idempotency
    if (params.idempotency_key) {
      this.idempotencyCache.set(params.idempotency_key, result);
    }

    return result;
  }

  async taskGet(params) {
    const tasks = this.readTasks();
    const task = tasks.find(t => t.id === params.task_id);
    if (!task) return null;

    const receipt = this.makeReceipt('task_read', task.id);
    return {
      task_id: task.id,
      status: this.mapHiveStatus(task.status),
      title: task.title,
      description: task.description,
      assignee: task.assignee,
      dependsOn: task.dependsOn,
      priority: task.priority,
      created_at: task.createdAt,
      updated_at: task.createdAt,
      blocked_reason: task.status === 'blocked' ? 'Blocked by orchestrator' : undefined,
      child_tasks: [],
      receipts: [receipt]
    };
  }

  async taskMessage(params) {
    const tasks = this.readTasks();
    const task = tasks.find(t => t.id === params.task_id);
    if (!task) return null;

    const msg = this.createMessage(
      'god',
      `Re: ${task.title}`,
      `**Task:** ${params.task_id}\n\n${params.message}`,
      'inform'
    );
    const messageId = this.deliverMessage(msg, 'god');

    const receipt = this.makeReceipt('task_message_sent', params.task_id);
    return {
      message_id: messageId,
      task_id: params.task_id,
      receipt
    };
  }

  async taskCancel(params) {
    const tasks = this.readTasks();
    const task = tasks.find(t => t.id === params.task_id);
    if (!task) return null;

    const msg = this.createMessage(
      'god',
      `Cancel: ${task.title}`,
      `**Task:** ${params.task_id}\n**Reason:** ${params.reason}\n\nPlease cancel this task safely.`,
      'request'
    );
    this.deliverMessage(msg, 'god');

    const receipt = this.makeReceipt('cancel_requested', params.task_id);
    return {
      cancellation_requested: true,
      task_id: params.task_id,
      receipt
    };
  }

  async officeStatus() {
    const registry = this.readRegistry();
    const tasks = this.readTasks();

    const roster = Object.entries(registry).map(([id, info]) => ({
      id,
      name: info.name,
      status: info.status
    }));

    const taskCounts = {
      accepted: 0, queued: 0, planning: 0, assigned: 0, working: 0,
      waiting: 0, blocked: 0, done: 0, failed: 0, cancelled: 0
    };
    for (const task of tasks) {
      const status = this.mapHiveStatus(task.status);
      taskCounts[status]++;
    }

    const blockedTasks = tasks
      .filter(t => t.status === 'blocked')
      .map(t => ({
        id: t.id,
        title: t.title,
        reason: 'Blocked by orchestrator'
      }));

    const godEntry = registry['god'];
    let michaelState = 'offline';
    if (godEntry) {
      if (godEntry.status === 'idle') michaelState = 'idle';
      else if (godEntry.status === 'working') michaelState = 'working';
      else if (godEntry.status === 'blocked') michaelState = 'blocked';
      else michaelState = 'idle';
    }

    return {
      available: true,
      michael_state: michaelState,
      roster,
      task_counts: taskCounts,
      blocked_tasks: blockedTasks,
      capabilities: ['compose_submit', 'task_get', 'task_message', 'task_cancel', 'office_status'],
      breaker: { tripped: false }
    };
  }
}

// ---------------------------------------------------------------------------
// Initialize adapter
// ---------------------------------------------------------------------------

const adapter = new HiveAdapter();

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } }
);

// -- List tools ------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'compose_submit',
      description:
        'Submit a compose (instruction) to Michael for decomposition and assignment. ' +
        'Returns task_id, message_id, status, and receipt. The compose is addressed to ' +
        'Michael; the caller cannot name a worker directly.',
      inputSchema: {
        type: 'object',
        properties: {
          compose: { type: 'string', description: 'Human-readable instruction for Michael' },
          title: { type: 'string', description: 'Optional short title for the task' },
          priority: { type: 'number', description: 'Task priority (1=highest, 10=lowest). Default: 5' },
          constraints: { type: 'array', items: { type: 'string' }, description: 'Optional constraints' },
          attachments: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' } } },
            description: 'Optional file attachments'
          },
          idempotency_key: { type: 'string', description: 'Optional key to prevent duplicate composes' }
        },
        required: ['compose']
      }
    },
    {
      name: 'task_get',
      description:
        'Get the current status and details of a task. Returns normalized status, ' +
        'title, owner, child task summary, blocked reason, and receipts.',
      inputSchema: {
        type: 'object',
        properties: { task_id: { type: 'string', description: 'The task ID to query' } },
        required: ['task_id']
      }
    },
    {
      name: 'task_message',
      description:
        'Add a message to a task thread. The message is delivered to Michael, ' +
        'who decides whether to relay, revise, or hold it.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task ID to message on' },
          message: { type: 'string', description: 'The message content' }
        },
        required: ['task_id', 'message']
      }
    },
    {
      name: 'task_cancel',
      description:
        'Request cancellation of a task. This asks the office to stop safely; ' +
        'it is not a process-kill escape hatch.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task ID to cancel' },
          reason: { type: 'string', description: 'Reason for cancellation' }
        },
        required: ['task_id', 'reason']
      }
    },
    {
      name: 'office_status',
      description:
        'Get the current office status: availability, Michael state, roster summary, ' +
        'task counts, blocked tasks, capabilities, and breaker state.',
      inputSchema: {
        type: 'object',
        properties: {
          detail: { type: 'string', enum: ['minimal', 'full'], description: 'Detail level' }
        }
      }
    }
  ]
}));

// -- Call tool -------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'compose_submit': {
        const result = await adapter.composeSubmit({
          compose: args?.compose || '',
          title: args?.title,
          priority: args?.priority,
          constraints: args?.constraints,
          attachments: args?.attachments,
          idempotency_key: args?.idempotency_key
        });
        return {
          content: [{ type: 'text', text: JSON.stringify({ protocol: PROTOCOL_VERSION, ...result }, null, 2) }]
        };
      }

      case 'task_get': {
        const result = await adapter.taskGet({ task_id: args?.task_id || '' });
        if (!result) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ protocol: PROTOCOL_VERSION, error: 'task_not_found', task_id: args?.task_id }, null, 2) }],
            isError: true
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ protocol: PROTOCOL_VERSION, ...result }, null, 2) }]
        };
      }

      case 'task_message': {
        const result = await adapter.taskMessage({ task_id: args?.task_id || '', message: args?.message || '' });
        if (!result) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ protocol: PROTOCOL_VERSION, error: 'task_not_found', task_id: args?.task_id }, null, 2) }],
            isError: true
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ protocol: PROTOCOL_VERSION, ...result }, null, 2) }]
        };
      }

      case 'task_cancel': {
        const result = await adapter.taskCancel({ task_id: args?.task_id || '', reason: args?.reason || '' });
        if (!result) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ protocol: PROTOCOL_VERSION, error: 'task_not_found', task_id: args?.task_id }, null, 2) }],
            isError: true
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ protocol: PROTOCOL_VERSION, ...result }, null, 2) }]
        };
      }

      case 'office_status': {
        const result = await adapter.officeStatus();
        return {
          content: [{ type: 'text', text: JSON.stringify({ protocol: PROTOCOL_VERSION, ...result }, null, 2) }]
        };
      }

      default:
        return {
          content: [{ type: 'text', text: JSON.stringify({ protocol: PROTOCOL_VERSION, error: 'unknown_tool', message: `Unknown tool: ${name}` }, null, 2) }],
          isError: true
        };
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ protocol: PROTOCOL_VERSION, error: 'internal_error', message: error?.message || String(error) }, null, 2) }],
      isError: true
    };
  }
});

// -- Start -----------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[office-bridge] MCP server started (protocol: ${PROTOCOL_VERSION})`);
}

main().catch((error) => {
  console.error('[office-bridge] Fatal error:', error);
  process.exit(1);
});
