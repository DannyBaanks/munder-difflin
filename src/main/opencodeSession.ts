/**
 * Does an OpenCode (or OpenISy) session still exist?
 *
 * `opencode --session <id>` reopens a conversation, but when the id is gone
 * (deleted, pruned, another machine's data dir) OpenCode prints "Session not
 * found" and exits 1: a restored agent would die on the spot. So the resume
 * flag is attached only when the session is found in OpenCode's own store:
 *   - opencode.db (SQLite, current builds): a row in `session`;
 *   - storage/session/**\/<id>.json (older builds, JSON files).
 *
 * The data dir is xdg-basedir's on every OS (OpenCode uses it on Windows too):
 * $XDG_DATA_HOME, else ~/.local/share, then `opencode` (or `openisy`).
 * Anything unreadable counts as "not found": starting fresh is recoverable,
 * a dead agent is not.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type SqliteOpen = (file: string) => { prepare(sql: string): { get(...args: unknown[]): unknown }; close(): void };

const SESSION_ID = /^ses_[A-Za-z0-9]{8,64}$/;

export function opencodeDataDirs(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const base = env.XDG_DATA_HOME || join(home, '.local', 'share');
  return [join(base, 'opencode'), join(base, 'openisy')];
}

export function opencodeSessionExists(sessionId: string, opts: { dirs?: string[]; openDb?: SqliteOpen } = {}): boolean {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return false;
  const dirs = opts.dirs ?? opencodeDataDirs();
  for (const dir of dirs) {
    const db = join(dir, 'opencode.db');
    if (opts.openDb && existsSync(db)) {
      try {
        const conn = opts.openDb(db);
        try {
          if (conn.prepare('SELECT 1 FROM session WHERE id = ?').get(sessionId)) return true;
        } finally {
          conn.close();
        }
      } catch { /* unreadable: try the next store */ }
    }
    if (jsonSessionExists(join(dir, 'storage', 'session'), `${sessionId}.json`, 3)) return true;
  }
  return false;
}

function jsonSessionExists(dir: string, name: string, depth: number): boolean {
  if (depth < 0 || !existsSync(dir)) return false;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && e.name === name) return true;
      if (e.isDirectory() && jsonSessionExists(join(dir, e.name), name, depth - 1)) return true;
    }
  } catch { /* unreadable */ }
  return false;
}
