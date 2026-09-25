// Portado de agentvivekkumar/dontbemichael (harnessGuard.ts, Vivek Kumar, MIT).
/**
 * The hive folder is coordination only.
 *
 * Agents are told which hive files are theirs (the injected prompt and
 * PROTOCOL.md); this refuses a file-writing tool call that lands anywhere else
 * in the hive: another agent's mailbox or memory, the registry, fleet.json,
 * log.jsonl, stray documents. The refusal reason goes straight back to the agent
 * so it can correct itself.
 *
 * Scope differs from the original on purpose: here the harness home may be the
 * parent of the operator's projects (god even runs with it as cwd), so only the
 * hive root is guarded, never the whole home.
 *
 * LIMITS, stated plainly:
 *  - Only Claude's file tools (Write/Edit/MultiEdit/NotebookEdit) are checked.
 *    A shell command that writes a file can't be judged from its text.
 *  - The PreToolUse hook fails OPEN when the agent's shim can't reach the app's
 *    socket, so this is a strong guard, not an airtight one.
 *
 * Pure: no fs, no electron. The hook server supplies the paths.
 */

import { isAbsolute, relative, resolve } from 'node:path';

/** Claude's tools that write a file at a path given in their input. */
export const GUARDED_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export interface HiveWriteInput {
  tool: string;
  toolInput: unknown;
  /** The agent's working directory, from the hook payload. Relative paths resolve against it. */
  cwd?: string;
  agentId: string;
  isGod: boolean;
  hiveRoot: string;
  /** macOS and Windows file systems ignore case; Linux does not. */
  caseInsensitive: boolean;
}

export function hiveWriteDecision(i: HiveWriteInput): { deny: boolean; reason?: string } {
  if (!GUARDED_TOOLS.has(i.tool)) return { deny: false };
  const target = targetPath(i.toolInput, i.cwd);
  if (!target) return { deny: false };

  const norm = (p: string): string => (i.caseInsensitive ? p.toLowerCase() : p);
  if (!isInside(norm(i.hiveRoot), norm(target))) return { deny: false };

  const rel = relative(norm(resolve(i.hiveRoot)), norm(target)).split(/[\\/]/).join('/');
  if (isPlumbing(rel, norm(i.agentId), i.isGod)) return { deny: false };

  return {
    deny: true,
    reason:
      'The hive folder is only for coordination: your own memory.md, inbox and outbox, and tasks.json'
      + (i.isGod ? ' (plus board.md and spawn-requests/ for you)' : '')
      + '. To reach another agent, write a message into your outbox. Save documents and other work in your working folder instead.'
  };
}

/** The files the hive protocol tells an agent to write. Everything else in the hive is the app's. */
function isPlumbing(rel: string, agentId: string, isGod: boolean): boolean {
  const own = `agents/${agentId}/`;
  if (rel === `${own}memory.md`) return true;
  if (rel.startsWith(`${own}outbox/`) || rel.startsWith(`${own}inbox/`)) return true;
  // Every agent keeps its task's status current; god adds human questions.
  if (rel === 'tasks.json') return true;
  // God is the board's sole scribe, and the only one who files spawn requests.
  if (isGod && (rel === 'board.md' || rel.startsWith('spawn-requests/'))) return true;
  return false;
}

/** The absolute path a tool call would write, or null if it names none. */
function targetPath(input: unknown, cwd: string | undefined): string | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as { file_path?: unknown; notebook_path?: unknown };
  const p = typeof o.file_path === 'string' ? o.file_path : typeof o.notebook_path === 'string' ? o.notebook_path : null;
  if (!p) return null;
  // resolve() also collapses `..`, so `outbox/../../registry.json` is judged as registry.json.
  return isAbsolute(p) ? resolve(p) : cwd ? resolve(cwd, p) : null;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
