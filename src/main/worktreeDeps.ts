import { existsSync } from 'node:fs';
import { lstat, readlink, realpath, symlink, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type DepLink =
  | { ok: true; skipped: boolean }
  | { ok: false; error: string };

export type DepUnlink =
  | { ok: true; removed: boolean }
  | { ok: false; error: string };

/** Link the base checkout's dependencies into an isolated worktree. */
export async function linkWorktreeDeps(baseDir: string, worktreeDir: string): Promise<DepLink> {
  const baseNodeModules = join(baseDir, 'node_modules');
  const worktreeNodeModules = join(worktreeDir, 'node_modules');
  if (!existsSync(baseNodeModules)) return { ok: true, skipped: true };

  try {
    await lstat(worktreeNodeModules);
    return { ok: true, skipped: true };
  } catch {
    // node_modules does not exist in this worktree yet.
  }

  try {
    await symlink(baseNodeModules, worktreeNodeModules, process.platform === 'win32' ? 'junction' : null);
    return { ok: true, skipped: false };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/** Remove the dependency link before testing whether a worktree is dirty. */
export async function unlinkWorktreeDeps(baseDir: string, worktreeDir: string): Promise<DepUnlink> {
  const baseNodeModules = join(baseDir, 'node_modules');
  const worktreeNodeModules = join(worktreeDir, 'node_modules');

  try {
    const stat = await lstat(worktreeNodeModules);
    if (!stat.isSymbolicLink()) return { ok: true, removed: false };
    const linkTarget = await readlink(worktreeNodeModules);
    const [baseTarget, worktreeTarget] = await Promise.all([
      realpath(baseNodeModules),
      realpath(resolve(worktreeDir, linkTarget))
    ]);
    if (baseTarget !== worktreeTarget) return { ok: true, removed: false };
    await unlink(worktreeNodeModules);
    return { ok: true, removed: true };
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return { ok: true, removed: false };
    return { ok: false, error: String(error) };
  }
}

/**
 * Drop the worktree's `node_modules` LINK itself — never what it points at —
 * before the worktree directory is deleted.
 *
 * On Windows the link is a directory junction, and `git worktree remove
 * --force` then walks a tree whose `node_modules` is a reparse point into the
 * BASE checkout's dependencies. Whether a recursive delete follows it depends
 * on how that git build classifies junctions; the CI run on windows-2022 left
 * the worktree behind, so nothing proved the base survived. Removing the link
 * first takes the question away on every OS: `unlink` on a symlink or junction
 * removes only the link (libuv uses RemoveDirectoryW for directory junctions).
 * A real node_modules directory is left alone for git to handle.
 */
export async function detachWorktreeDepsLink(worktreeDir: string): Promise<DepUnlink> {
  const worktreeNodeModules = join(worktreeDir, 'node_modules');
  try {
    const stat = await lstat(worktreeNodeModules);
    if (!stat.isSymbolicLink()) return { ok: true, removed: false };
    await unlink(worktreeNodeModules);
    return { ok: true, removed: true };
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return { ok: true, removed: false };
    return { ok: false, error: String(error) };
  }
}
