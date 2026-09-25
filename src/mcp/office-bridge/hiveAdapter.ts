/**
 * Office Bridge MCP v1 — Hive Adapter
 *
 * Host adapter that writes through to the Munder Difflin Hive.
 * Implements the five tool operations against the on-disk Hive structure:
 *   - compose_submit → creates message + task in Michael's inbox
 *   - task_get → reads tasks.json + receipts
 *   - task_message → appends to task thread
 *   - task_cancel → creates cancellation request
 *   - office_status → reads registry.json + tasks.json + router health
 *
 * Environment variables (set by the Hive at agent spawn):
 *   HIVE_ROOT  — path to the hive directory (<harnessHome>/hive/)
 *   AGENT_ID   — this agent's id (for receipts)
 *
 * Security: local stdio only; no network listener. All paths are validated
 * against HIVE_ROOT to prevent traversal.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus =
  | 'accepted'
  | 'queued'
  | 'planning'
  | 'assigned'
  | 'working'
  | 'waiting'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface ComposeResult {
  task_id: string;
  message_id: string;
  status: TaskStatus;
  assigned_to?: string;
  receipt: Receipt;
}

export interface TaskResult {
  task_id: string;
  status: TaskStatus;
  title: string;
  description?: string;
  assignee?: string;
  dependsOn: string[];
  priority: number;
  created_at: string;
  updated_at: string;
  blocked_reason?: string;
  waiting_on?: string[];
  child_tasks: { id: string; title: string; status: TaskStatus }[];
  receipts: Receipt[];
}

export interface TaskMessageResult {
  message_id: string;
  task_id: string;
  receipt: Receipt;
}

export interface TaskCancelResult {
  cancellation_requested: boolean;
  task_id: string;
  receipt: Receipt;
}

export interface OfficeStatusResult {
  available: boolean;
  michael_state: 'idle' | 'working' | 'blocked' | 'offline';
  roster: { id: string; name: string; status: string }[];
  task_counts: Record<TaskStatus, number>;
  blocked_tasks: { id: string; title: string; reason?: string }[];
  capabilities: string[];
  breaker: { tripped: boolean; reason?: string };
}

export interface Receipt {
  id: string;
  timestamp: string;
  kind: string;
  correlation_id: string;
}

// ---------------------------------------------------------------------------
// Internal types (Hive on-disk shapes)
// ---------------------------------------------------------------------------

interface HiveMessage {
  id: string;
  conversation: string;
  in_reply_to: string | null;
  from: string;
  to: string;
  act: 'request' | 'inform' | 'propose' | 'query' | 'agree' | 'refuse' | 'done';
  subject: string;
  body: string;
  hops: number;
  requires_reply: boolean;
  needs_human: boolean;
  created_at: string;
}

interface HiveTask {
  id: string;
  title: string;
  description?: string;
  assignee?: string;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  dependsOn: string[];
  priority: number;
  createdAt: string;
  humanQA?: unknown[];
  result?: string;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class HiveAdapter {
  private hiveRoot: string;
  private agentId: string;
  private idempotencyCache = new Map<string, ComposeResult>();

  constructor(hiveRoot?: string, agentId?: string) {
    this.hiveRoot = hiveRoot || process.env.HIVE_ROOT || '';
    this.agentId = agentId || process.env.AGENT_ID || 'office-bridge';
    if (!this.hiveRoot) {
      throw new Error('HIVE_ROOT environment variable is required');
    }
  }

  // -- Path helpers --------------------------------------------------------

  private safePath(...parts: string[]): string {
    const p = resolve(this.hiveRoot, ...parts);
    const rel = relative(this.hiveRoot, p);
    if (rel.startsWith('..') || rel.startsWith('/')) {
      throw new Error(`Path traversal detected: ${parts.join('/')}`);
    }
    return p;
  }

  private agentsDir(): string {
    return this.safePath('agents');
  }

  private godDir(): string {
    return this.safePath('agents', 'god');
  }

  private godInbox(): string {
    return this.safePath('agents', 'god', 'inbox');
  }

  private tasksFile(): string {
    return this.safePath('tasks.json');
  }

  private registryFile(): string {
    return this.safePath('registry.json');
  }

  private logFile(): string {
    return this.safePath('log.jsonl');
  }

  // -- File I/O ------------------------------------------------------------

  private readJson<T>(path: string): T | null {
    try {
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf-8')) as T;
    } catch {
      return null;
    }
  }

  private writeJson(path: string, data: unknown): void {
    const dir = join(path, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }

  private appendLog(entry: Record<string, unknown>): void {
    const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() });
    const dir = join(this.logFile(), '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.logFile(), line + '\n', { flag: 'a' });
  }

  // -- Receipt creation ----------------------------------------------------

  private makeReceipt(kind: string, correlationId: string): Receipt {
    return {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      kind,
      correlation_id: correlationId
    };
  }

  // -- Message creation ----------------------------------------------------

  private createMessage(
    to: string,
    subject: string,
    body: string,
    act: HiveMessage['act'] = 'request'
  ): HiveMessage {
    const now = new Date().toISOString();
    const msg: HiveMessage = {
      id: `${now.replace(/[:.]/g, '-').slice(0, 19)}Z-${randomUUID().slice(0, 8)}`,
      conversation: `bridge-${randomUUID().slice(0, 8)}`,
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
    return msg;
  }

  private deliverMessage(msg: HiveMessage, toId: string): string {
    const inboxDir = this.safePath('agents', toId, 'inbox');
    if (!existsSync(inboxDir)) {
      mkdirSync(inboxDir, { recursive: true });
    }
    const msgPath = join(inboxDir, `${msg.id}.json`);
    this.writeJson(msgPath, msg);
    return msg.id;
  }

  // -- Task helpers --------------------------------------------------------

  private readTasks(): HiveTask[] {
    const data = this.readJson<{ tasks: HiveTask[] }>(this.tasksFile());
    return data?.tasks || [];
  }

  private writeTasks(tasks: HiveTask[]): void {
    this.writeJson(this.tasksFile(), { tasks });
  }

  private mapHiveStatus(hiveStatus: string): TaskStatus {
    const map: Record<string, TaskStatus> = {
      todo: 'queued',
      doing: 'working',
      blocked: 'blocked',
      done: 'done'
    };
    return map[hiveStatus] || 'queued';
  }

  // -- Registry helpers ----------------------------------------------------

  private readRegistry(): Record<string, { name: string; status: string }> {
    const data = this.readJson<Record<string, { name: string; status: string }>>(
      this.registryFile()
    );
    return data || {};
  }

  // =========================================================================
  // Public API — the five tools
  // =========================================================================

  /**
   * 5.1 compose_submit — Submit a compose to Michael.
   */
  async composeSubmit(params: {
    compose: string;
    title?: string;
    priority?: number;
    constraints?: string[];
    attachments?: { name: string; content: string }[];
    idempotency_key?: string;
  }): Promise<ComposeResult> {
    // Idempotency check
    if (params.idempotency_key && this.idempotencyCache.has(params.idempotency_key)) {
      return this.idempotencyCache.get(params.idempotency_key)!;
    }

    const taskId = `task-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const title = params.title || params.compose.slice(0, 80);
    const body = [
      `## Office Bridge Compose\n`,
      params.compose,
      params.constraints?.length ? `\n**Constraints:** ${params.constraints.join(', ')}` : '',
      params.attachments?.length
        ? `\n**Attachments:** ${params.attachments.map((a) => a.name).join(', ')}`
        : ''
    ].join('\n');

    // 1. Create message to Michael
    const msg = this.createMessage('god', title, body, 'request');
    const messageId = this.deliverMessage(msg, 'god');

    // 2. Create task in tasks.json
    const task: HiveTask = {
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
    const result: ComposeResult = {
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

  /**
   * 5.2 task_get — Get task status and details.
   */
  async taskGet(params: { task_id: string }): Promise<TaskResult | null> {
    const tasks = this.readTasks();
    const task = tasks.find((t) => t.id === params.task_id);
    if (!task) return null;

    const registry = this.readRegistry();
    const assigneeInfo = task.assignee ? registry[task.assignee] : undefined;

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
      updated_at: task.createdAt, // TODO: track updates
      blocked_reason: task.status === 'blocked' ? 'Blocked by orchestrator' : undefined,
      child_tasks: [], // TODO: find child tasks
      receipts: [receipt]
    };
  }

  /**
   * 5.3 task_message — Add a message to a task thread.
   */
  async taskMessage(params: {
    task_id: string;
    message: string;
  }): Promise<TaskMessageResult | null> {
    const tasks = this.readTasks();
    const task = tasks.find((t) => t.id === params.task_id);
    if (!task) return null;

    // Create message to Michael referencing the task
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

  /**
   * 5.4 task_cancel — Request task cancellation.
   */
  async taskCancel(params: {
    task_id: string;
    reason: string;
  }): Promise<TaskCancelResult | null> {
    const tasks = this.readTasks();
    const task = tasks.find((t) => t.id === params.task_id);
    if (!task) return null;

    // Create cancellation message to Michael
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

  /**
   * 5.5 office_status — Get office status.
   */
  async officeStatus(): Promise<OfficeStatusResult> {
    const registry = this.readRegistry();
    const tasks = this.readTasks();

    // Build roster from registry
    const roster = Object.entries(registry).map(([id, info]) => ({
      id,
      name: info.name,
      status: info.status
    }));

    // Count tasks by status
    const taskCounts: Record<TaskStatus, number> = {
      accepted: 0,
      queued: 0,
      planning: 0,
      assigned: 0,
      working: 0,
      waiting: 0,
      blocked: 0,
      done: 0,
      failed: 0,
      cancelled: 0
    };
    for (const task of tasks) {
      const status = this.mapHiveStatus(task.status);
      taskCounts[status]++;
    }

    // Find blocked tasks
    const blockedTasks = tasks
      .filter((t) => t.status === 'blocked')
      .map((t) => ({
        id: t.id,
        title: t.title,
        reason: 'Blocked by orchestrator'
      }));

    // Determine Michael's state
    const godEntry = registry['god'];
    let michaelState: OfficeStatusResult['michael_state'] = 'offline';
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
      capabilities: [
        'compose_submit',
        'task_get',
        'task_message',
        'task_cancel',
        'office_status'
      ],
      breaker: { tripped: false }
    };
  }
}
