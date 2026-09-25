/**
 * Open the OS terminal emulator at a folder — the "abrir consola" button on an
 * agent (FullscreenTerminal / AgentDetailPanel / CommandCenterPanel, via the
 * `terminal:openAtFolder` IPC).
 *
 * WHY THIS EXISTS. The old handler ran `spawn('open', ['-a', 'Terminal', cwd])`
 * on EVERY platform. `-a` is a macOS-only flag of the `open` command. On Linux
 * `/usr/bin/open` is the Debian-alternatives alias of **xdg-open**, which has
 * no `-a` flag — so every click died with:
 *
 *     xdg-open: unexpected option '-a'
 *
 * (measured 2026-09-21 on Ubuntu 24.04: /usr/bin/open -> /etc/alternatives/open
 * -> xdg-open). Even without the flag, xdg-open would be wrong here: it opens
 * the DEFAULT app for a path, which for a directory is the FILE MANAGER, not
 * a terminal.
 *
 * Platform behavior now:
 *   macOS   — unchanged legacy path: `open -a Terminal <cwd>`.
 *   Windows — `cmd.exe /c start "" cmd.exe /k "cd /d <cwd>"` (new console).
 *   Linux   — probe for a real terminal emulator in a fixed preference order
 *             (gnome-terminal → ptyxis → konsole → xfce4-terminal →
 *             mate-terminal → alacritty → kitty → wezterm → xterm fallback)
 *             and spawn it with that emulator's own working-directory flag.
 *
 * The spawn is fire-and-forget (detached, stdio ignored, unref'd): terminal
 * emulators daemonize (gnome-terminal's client exits 0 once the server opens
 * the window), so waiting for close would either return before the window
 * exists or block until the user closes it (xterm). A successful spawn
 * resolves { ok: true }; only validation failures and immediate spawn errors
 * resolve { ok: false }.
 *
 * Kept dependency-free (node builtins only) so the repo's transpile-and-require
 * test pattern (test/*.test.cjs) can exercise it without Electron.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { posix } from 'node:path';

export type TerminalKind =
  | 'gnome-terminal'
  | 'ptyxis'
  | 'konsole'
  | 'xfce4-terminal'
  | 'mate-terminal'
  | 'alacritty'
  | 'kitty'
  | 'wezterm'
  | 'xterm';

export interface ResolvedTerminal {
  bin: string;
  kind: TerminalKind;
}

/** Filesystem probes, injectable so tests can fake an OS without touching disk. */
export interface TerminalDeps {
  exists(p: string): boolean;
  /** Absolute path of `name` off PATH, or null when not installed. */
  which(name: string): string | null;
  homeDir(): string;
}

const LINUX_CANDIDATES: ReadonlyArray<{ name: string; kind: TerminalKind }> = [
  { name: 'gnome-terminal', kind: 'gnome-terminal' },
  { name: 'ptyxis', kind: 'ptyxis' },
  { name: 'konsole', kind: 'konsole' },
  { name: 'xfce4-terminal', kind: 'xfce4-terminal' },
  { name: 'mate-terminal', kind: 'mate-terminal' },
  { name: 'alacritty', kind: 'alacritty' },
  { name: 'kitty', kind: 'kitty' },
  { name: 'wezterm', kind: 'wezterm' },
  { name: 'xterm', kind: 'xterm' }
];

const SYSTEM_BIN_DIRS: ReadonlyArray<string> = ['/usr/local/bin', '/usr/bin', '/bin', '/snap/bin'];

const defaultDeps: TerminalDeps = {
  exists: (p: string): boolean => {
    try { return existsSync(p); } catch { return false; }
  },
  which: (name: string): string | null => {
    try {
      const r = spawnSync('which', [name], { encoding: 'utf8', timeout: 2000 });
      const line = String(r.stdout ?? '')
        .split('\n').map((s) => s.trim()).filter(Boolean)[0];
      return line ?? null;
    } catch { return null; }
  },
  homeDir: (): string => process.env.HOME ?? ''
};

/** First installed emulator wins, in LINUX_CANDIDATES order. Null = none found. */
export function resolveLinuxTerminal(deps: TerminalDeps = defaultDeps): ResolvedTerminal | null {
  // Linux paths on purpose (posix.join): this only resolves Linux terminals,
  // and the native join would spell them `\usr\bin\…` on a Windows build.
  const homeBin = posix.join(deps.homeDir(), '.local', 'bin');
  for (const c of LINUX_CANDIDATES) {
    const fromPath = deps.which(c.name);
    if (fromPath) return { bin: fromPath, kind: c.kind };
    for (const dir of [...SYSTEM_BIN_DIRS, homeBin]) {
      const p = posix.join(dir, c.name);
      if (deps.exists(p)) return { bin: p, kind: c.kind };
    }
  }
  return null;
}

/** Single-quote a string for POSIX sh. Pure — unit-tested with hostile paths. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The argv for `bin` (of `kind`) that opens a window at `cwd`. Pure.
 * Flags are per-emulator documented working-directory options — NOT xdg-open,
 * which cannot open a terminal at all (it opens the default app for a path).
 */
export function terminalArgsFor(kind: TerminalKind, cwd: string): string[] {
  switch (kind) {
    case 'gnome-terminal': return [`--working-directory=${cwd}`];
    case 'ptyxis': return ['--new-window', `--working-directory=${cwd}`];
    case 'konsole': return ['--workdir', cwd];
    case 'xfce4-terminal': return [`--working-directory=${cwd}`];
    case 'mate-terminal': return [`--working-directory=${cwd}`];
    case 'alacritty': return ['--working-directory', cwd];
    case 'kitty': return [`--directory=${cwd}`];
    case 'wezterm': return ['start', '--cwd', cwd];
    case 'xterm':
      // No working-directory flag: cd inside, then replace the shell with the
      // user's login shell so the window behaves like their normal terminal.
      // Single argv element; shQuote keeps spaces/quotes in cwd harmless.
      return ['-e', '/bin/sh', '-c', `cd ${shQuote(cwd)} && exec ${shQuote(process.env.SHELL || '/bin/bash')}`];
  }
}

export type TerminalCommand = { file: string; args: string[] } | { error: string };

/** Platform dispatch. Pure (takes the platform as a value) — unit-tested. */
export function commandFor(
  platform: NodeJS.Platform,
  term: ResolvedTerminal | null,
  cwd: string
): TerminalCommand {
  // macOS legacy path — unchanged: Terminal.app opens a window at the folder.
  if (platform === 'darwin') return { file: 'open', args: ['-a', 'Terminal', cwd] };
  if (platform === 'win32') {
    return {
      file: 'cmd.exe',
      // `start ""` needs the empty title so the quoted command is not eaten as
      // the window title; /k keeps the console open on the folder.
      args: ['/c', 'start', '', 'cmd.exe', '/k', `cd /d "${cwd}"`]
    };
  }
  if (!term) {
    return {
      error: 'no se encontró ningún emulador de terminal ' +
        '(gnome-terminal, konsole, xfce4-terminal, mate-terminal, alacritty, kitty, wezterm, xterm)'
    };
  }
  return { file: term.bin, args: terminalArgsFor(term.kind, cwd) };
}

/**
 * Open the OS terminal at `cwd`. Fire-and-forget: { ok: true } means the
 * emulator was spawned, not that its window is visible yet.
 */
export function openTerminalAtFolder(
  cwd: unknown,
  deps: TerminalDeps = defaultDeps
): { ok: boolean; error?: string } {
  if (typeof cwd !== 'string' || cwd.length === 0) return { ok: false, error: 'invalid cwd' };
  const platform = process.platform;
  const term = platform === 'linux' ? resolveLinuxTerminal(deps) : null;
  const cmd = commandFor(platform, term, cwd);
  if ('error' in cmd) return { ok: false, error: cmd.error };
  try {
    const child = spawn(cmd.file, cmd.args, {
      detached: true,
      stdio: 'ignore',
      // The window MUST show: never hide it on Windows.
      windowsHide: false
    });
    // A bin that vanishes between resolve and spawn raises async 'error' —
    // swallow it so it can never crash the main process; the spawn attempt
    // itself already resolved ok.
    child.on('error', () => { /* terminal failed after a successful spawn */ });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
