// Portado de agentvivekkumar/dontbemichael (Vivek Kumar, MIT).
/**
 * The installed Claude Code version, for the model floor in
 * src/shared/modelCliFloor.ts.
 *
 * `claude --version` is a process launch, so the answer is cached per binary.
 * The key is the resolved real path plus its mtime: the native installer
 * updates by pointing ~/.local/bin/claude at a new versions/<n> file, and npm
 * rewrites the file in place, so either kind of update is noticed on the next
 * spawn without a restart. A probe that fails or times out answers null
 * ("unknown"), which never blocks a spawn.
 */
import { execFile } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { parseCliVersion } from '../shared/modelCliFloor';

const cache = new Map<string, string | null>();

export async function claudeCliVersion(binPath: string | null): Promise<string | null> {
  if (!binPath) return null;
  let key: string;
  try {
    const real = realpathSync(binPath);
    key = `${real}:${statSync(real).mtimeMs}`;
  } catch { return null; }
  if (cache.has(key)) return cache.get(key)!;
  const version = await new Promise<string | null>((resolve) => {
    execFile(binPath, ['--version'], { timeout: 5000, encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? null : parseCliVersion(String(stdout)));
    });
  });
  // Only a real answer is cached: a timeout on a busy machine is worth retrying.
  if (version) cache.set(key, version);
  return version;
}
