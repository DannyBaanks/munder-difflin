// Portado de agentvivekkumar/dontbemichael (Vivek Kumar, MIT).
/**
 * Office Pack loader — the bundled packs, read from disk and merged with core.
 *
 * `src/shared/officePack.ts` owns the FORMAT (what a valid pack is, what an
 * imported one may grant). This module owns GETTING them: where the files live
 * in dev versus a packaged app, which ones are readable, and what the caller
 * sees when one is broken.
 *
 * Path resolution mirrors `skillsResourceDir()` in `index.ts` exactly, because
 * packs ship the same way skills do — a directory copied into `extraResources`,
 * so `<resourcesPath>/packs` in the packaged app and `resources/packs` in dev.
 *
 * FAILURE POSTURE: a broken pack never takes the others down. Onboarding's first
 * screen is a grid of business types, and one malformed file must not empty that
 * grid — the owner would see a dead first screen with nothing to click. Each file
 * is read and validated on its own; the bad one is reported and skipped, and the
 * rest still load. A test (`office-pack-fixtures.test.cjs`) keeps the shipped
 * files valid so this path stays theoretical for bundled packs.
 *
 * Electron is imported ONLY for the path lookup, behind an injectable seam, so
 * the loader can be unit-tested under plain node like `integrationBroker.ts` is.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  mergeWithCore,
  validateOfficePack,
  type OfficePack,
  type PackOrigin
} from '../shared/officePack';

/** The core pack's file name and business type; it supplies agents every pack inherits. */
export const CORE_PACK_ID = 'core';

/** Byte cap per pack file. A pack is a small document; anything larger is a mistake
 *  or an attempt to wedge the loader, and reading it fully would be the bug. */
const MAX_PACK_BYTES = 256 * 1024;

export interface LoadedPack {
  /** Ready to use: core agents merged in, levels capped if imported. */
  pack: OfficePack;
  /** Where it came from, for the UI's "from outside this app" review screen. */
  origin: PackOrigin;
}

export interface PackLoadResult {
  /** Business packs, core already merged into each. Never includes the core pack. */
  packs: LoadedPack[];
  /** One entry per file that could not be used, with a reason worth showing. */
  problems: Array<{ file: string; reason: string }>;
  /** The core pack on its own. "Something else" in onboarding starts from this,
   *  since no business pack applies. Absent when core failed to load. */
  core?: OfficePack;
}

/** Injected so tests can point at a fixture directory without electron. */
export interface PackLoaderDeps {
  packsDir: () => string;
}

function readJson(file: string): { value?: unknown; error?: string } {
  try {
    // Size is checked BEFORE reading: a cap applied to an already-loaded string
    // has not avoided anything.
    if (statSync(file).size > MAX_PACK_BYTES) {
      return { error: `file is larger than ${Math.round(MAX_PACK_BYTES / 1024)}KB` };
    }
    return { value: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Load every bundled pack.
 *
 * The core pack is loaded first and merged into each business pack, so callers
 * never have to remember the inheritance rule. If core itself is missing or
 * invalid, business packs still load — without it — and the problem is reported;
 * an office without finance is worse than one whose owner was told why.
 */
export function loadBundledPacks(deps: PackLoaderDeps): PackLoadResult {
  const dir = deps.packsDir();
  const problems: Array<{ file: string; reason: string }> = [];
  if (!existsSync(dir)) {
    return { packs: [], problems: [{ file: dir, reason: 'no packs directory in this build' }] };
  }

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch (e) {
    return { packs: [], problems: [{ file: dir, reason: e instanceof Error ? e.message : String(e) }] };
  }

  let core: OfficePack | undefined;
  const coreFile = `${CORE_PACK_ID}.json`;
  if (files.includes(coreFile)) {
    const read = readJson(join(dir, coreFile));
    if (read.error) {
      problems.push({ file: coreFile, reason: read.error });
    } else {
      const res = validateOfficePack(read.value, 'bundled');
      if (res.ok && res.pack) core = res.pack;
      else problems.push({ file: coreFile, reason: res.errors.join('; ') });
    }
  } else {
    problems.push({ file: coreFile, reason: 'core pack is missing from this build' });
  }

  const packs: LoadedPack[] = [];
  for (const file of files) {
    if (file === coreFile) continue;
    const read = readJson(join(dir, file));
    if (read.error) {
      problems.push({ file, reason: read.error });
      continue;
    }
    const res = validateOfficePack(read.value, 'bundled');
    if (!res.ok || !res.pack) {
      problems.push({ file, reason: res.errors.join('; ') });
      continue;
    }
    packs.push({ pack: core ? mergeWithCore(res.pack, core) : res.pack, origin: 'bundled' });
  }

  return { packs, problems, ...(core ? { core } : {}) };
}

/**
 * Validate a pack that arrived from a file or a deep link.
 *
 * Always `'imported'`, which is what forces every outward capability down to
 * "Ask me" (Decision 7). The caller shows the result on the "from outside this
 * app" review screen before anything is created.
 */
export function loadImportedPack(raw: unknown, core?: OfficePack): { pack?: OfficePack; errors: string[] } {
  const res = validateOfficePack(raw, 'imported');
  if (!res.ok || !res.pack) return { errors: res.errors };
  return { pack: core ? mergeWithCore(res.pack, core) : res.pack, errors: [] };
}

/**
 * The bundled packs directory.
 *
 * Mirrors `skillsResourceDir()`: packs ship as a directory copy under
 * `extraResources`, so the packaged app reads `<resourcesPath>/packs` while dev
 * reads `resources/packs` from the app path. Passed in rather than imported so
 * nothing here needs electron at test time.
 */
export function packsResourceDir(app: { isPackaged: boolean; getAppPath: () => string }, resourcesPath: string): string {
  return app.isPackaged ? join(resourcesPath, 'packs') : join(app.getAppPath(), 'resources', 'packs');
}
