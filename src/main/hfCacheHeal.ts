/**
 * Keep an ONNX model and its external weights in ONE real directory.
 *
 * WHY THIS EXISTS. MemPalace loads EmbeddingGemma from the Hugging Face cache:
 * `snapshots/<rev>/onnx/model_quantized.onnx` plus `model_quantized.onnx_data`.
 * huggingface_hub 1.32 keeps blobs in a shared, sharded store, so those two
 * snapshot symlinks resolve into DIFFERENT directories (`hub/blobs/6a/…` and
 * `hub/blobs/2d/…`). onnxruntime 1.30 validates external data against the
 * model's resolved directory and refuses: "External data path escapes model
 * directory". Every `mempalace mine` then exited 1 and no agent's long-term
 * memory was indexed — 264 failures in one session, and nothing else broke.
 * Reported upstream: MemPalace/mempalace#2601.
 *
 * The repair: in a snapshot directory where an `.onnx` and its weights resolve
 * to different places, replace each of those symlinks with a hardlink to its
 * own target (a copy only when the cache spans filesystems). Same bytes, no
 * extra disk, and the pair now shares one real directory. Nothing else in the
 * cache is touched, and a pair that already agrees is left exactly as it is.
 */
import { copyFileSync, linkSync, lstatSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Where huggingface_hub keeps its cache, by the same precedence it uses. */
export function hfHubCacheDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.HF_HUB_CACHE) return env.HF_HUB_CACHE;
  if (env.HF_HOME) return join(env.HF_HOME, 'hub');
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'huggingface', 'hub');
}

/** The weight files ONNX exporters write next to `<name>.onnx`. */
const DATA_SUFFIXES = ['_data', '.data'];
/** snapshots/<rev>/<subfolders…>: models keep their .onnx at most a few levels down. */
const MAX_DEPTH = 4;

export interface HealResult {
  /** Snapshot paths whose symlink became a real file. */
  healed: string[];
  errors: string[];
}

const isLink = (p: string): boolean => {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
};

function realDir(p: string): string | null {
  try { return dirname(realpathSync(p)); } catch { return null; }
}

/** Replace a symlink by a hardlink (or, across filesystems, a copy) of its target. */
function materialize(file: string): void {
  const target = realpathSync(file);
  const tmp = `${file}.munder-heal`;
  rmSync(tmp, { force: true });
  try {
    linkSync(target, tmp);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    copyFileSync(target, tmp);
  }
  renameSync(tmp, file); // atomic swap: the path is never missing
}

function healDir(dir: string, out: HealResult, depth = 0): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.onnx')) continue;
    const model = join(dir, name);
    for (const suffix of DATA_SUFFIXES) {
      const data = model + suffix;
      if (!names.includes(name + suffix)) continue;
      const modelDir = realDir(model);
      const dataDir = realDir(data);
      if (!modelDir || !dataDir || modelDir === dataDir) continue;
      for (const f of [model, data]) {
        if (!isLink(f)) continue;
        try {
          materialize(f);
          out.healed.push(f);
        } catch (e) {
          out.errors.push(`${f}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }
  if (depth >= MAX_DEPTH) return;
  for (const name of names) {
    const sub = join(dir, name);
    // lstat, not stat: never follow a symlinked directory out of the snapshot.
    try { if (lstatSync(sub).isDirectory()) healDir(sub, out, depth + 1); } catch { /* vanished */ }
  }
}

/** Heal every split .onnx pair under `hub/models--*\/snapshots/*`. Best-effort, never throws. */
export function healSplitOnnxPairs(hubDir: string = hfHubCacheDir()): HealResult {
  const out: HealResult = { healed: [], errors: [] };
  let repos: string[];
  try { repos = readdirSync(hubDir).filter((n) => n.startsWith('models--')); } catch { return out; }
  for (const repo of repos) {
    const snaps = join(hubDir, repo, 'snapshots');
    let revs: string[];
    try { revs = readdirSync(snaps); } catch { continue; }
    for (const rev of revs) healDir(join(snaps, rev), out);
  }
  return out;
}
