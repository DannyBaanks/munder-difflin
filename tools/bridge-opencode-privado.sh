#!/usr/bin/env bash
set -euo pipefail

# bridge-opencode-privado.sh — puente entre el store privado (DEVELOPMENT) y
# OpenISy/OpenCode (directo en consola Y spawneado por munder).
#
# PROBLEMA (2026-09-22): las customizaciones privadas (agentes, comandos, modos,
# plugins) no pueden vivir en los repos — varios se harán públicos — pero los
# agentes de munder arrancan aislados (cwd=worktree + OPENCODE_CONFIG_DIR
# per-agente + OPENCODE_CONFIG_CONTENT mínimo) y solo ven build/plan.
#
# POR QUÉ AQUÍ Y NO EN ~/Development/.opencode: el discovery de OpenISy camina
# hacia arriba desde el cwd, pero se DETIENE en la raíz del repo
# (`afs.up stop: worktree`, verificado en código). Un .opencode a nivel
# Development solo lo heredarían cwds fuera de git. En cambio la capa GLOBAL
# (~/.config/opencode, constante en Global.Path.config) se lee SIEMPRE, en
# todo arranque, sin depender del cwd: es el puente correcto.
#
# LO QUE HACE: enlaza (symlink, nunca copia) cada archivo del store hacia
# ~/.config/opencode/{agent,command,mode,plugins}/. Un solo origen de verdad
# (el store), efecto inmediato en cada arranque, cero contenido privado en repos.
#
# SEGURIDAD: jamás escribe dentro de repos (el destino está en $HOME, fuera de
# todo repo); jamás sobreescribe archivos reales (ante conflicto avisa y salta);
# --check audita enlaces + git-status del store sin tocar nada.
#
# Uso:
#   ./tools/bridge-opencode-privado.sh            enlaza todo (idempotente)
#   ./tools/bridge-opencode-privado.sh --check    audita sin tocar nada
#   ./tools/bridge-opencode-privado.sh --unlink   retira los enlaces del puente
#
# Env (para tests): OPENCODE_PRIVATE_STORE, OPENCODE_TARGET_HOME.

STORE="${OPENCODE_PRIVATE_STORE:-$HOME/.local/share/opencode-privado}"
TARGET_HOME="${OPENCODE_TARGET_HOME:-$HOME}"
TARGET="$TARGET_HOME/.config/opencode"

# store-subdir -> target-subdir (nombres que OpenISy realmente escanea:
# {agent,agents} / {command,commands} / {mode,modes} / plugins).
MAP="agent:agent command:command mode:mode plugin:plugins"

say() { printf 'bridge: %s\n' "$*"; }
warn() { printf 'bridge: AVISO: %s\n' "$*" >&2; }

linked=0; skipped=0; conflicts=0

link_one() { # $1=categoría-store $2=categoría-destino $3=archivo
  local src="$STORE/$1/$3" dest="$TARGET/$2/$3"
  if [[ -L "$dest" ]]; then
    if [[ "$(readlink -f "$dest")" == "$(readlink -f "$src")" ]]; then
      linked=$((linked + 1)); return 0
    fi
    warn "salto $dest (symlink a otro lado: $(readlink "$dest"))"
    conflicts=$((conflicts + 1)); return 0
  fi
  if [[ -e "$dest" ]]; then
    warn "salto $dest (archivo real ajeno — no lo toco)"
    conflicts=$((conflicts + 1)); return 0
  fi
  ln -s "$src" "$dest"
  linked=$((linked + 1))
}

do_link() {
  [[ -d "$STORE" ]] || { printf 'bridge: ERROR: store ausente: %s\n' "$STORE" >&2; exit 1; }
  mkdir -p "$TARGET"
  local pair ssub tsub f
  for pair in $MAP; do
    ssub="${pair%%:*}"; tsub="${pair##*:}"
    [[ -d "$STORE/$ssub" ]] || continue
    mkdir -p "$TARGET/$tsub"
    for f in "$STORE/$ssub"/*; do
      [[ -e "$f" ]] || continue
      [[ -f "$f" ]] || { warn "salto $f (no es archivo regular)"; skipped=$((skipped + 1)); continue; }
      link_one "$ssub" "$tsub" "$(basename "$f")"
    done
  done
  say "enlazados=$linked omitidos=$skipped conflictos=$conflicts"
  [[ $conflicts -eq 0 ]]
}

do_unlink() {
  local pair ssub tsub dest removed=0 kept=0 store_real
  # Compare canonical paths on BOTH sides: readlink -f resolves the link fully,
  # so a store under a symlinked dir (macOS /var -> /private/var, a symlinked
  # home) never matched the raw $STORE and --unlink removed nothing, exit 0.
  store_real="$(cd "$STORE" 2>/dev/null && pwd -P)" || store_real="$STORE"
  for pair in $MAP; do
    ssub="${pair%%:*}"; tsub="${pair##*:}"
    [[ -d "$TARGET/$tsub" ]] || continue
    for dest in "$TARGET/$tsub"/*; do
      [[ -L "$dest" ]] || continue
      if [[ "$(readlink -f "$dest" 2>/dev/null)" == "$store_real/$ssub/$(basename "$dest")" ]]; then
        rm "$dest"; removed=$((removed + 1))
      else
        kept=$((kept + 1))
      fi
    done
  done
  say "retirados=$removed ajenos_conservados=$kept"
}

do_check() {
  local rc=0 pair ssub tsub f dest
  say "store: $STORE"
  if [[ ! -d "$STORE" ]]; then printf 'bridge: ERROR: store ausente\n' >&2; exit 1; fi
  # Guardia anti-fuga: ¿el store vive dentro de un work tree git? ¿con qué remoto?
  if git -C "$STORE" rev-parse --show-toplevel >/dev/null 2>&1; then
    local top remote
    top="$(git -C "$STORE" rev-parse --show-toplevel)"
    remote="$(git -C "$STORE" remote get-url origin 2>/dev/null || echo '(sin remoto)')"
    warn "el store está dentro del work tree $top (remoto: $remote) — moverlo fuera de repos"
    rc=1
  else
    say "store fuera de todo repo git: OK"
  fi
  for pair in $MAP; do
    ssub="${pair%%:*}"; tsub="${pair##*:}"
    [[ -d "$STORE/$ssub" ]] || continue
    for f in "$STORE/$ssub"/*; do
      [[ -e "$f" ]] || continue
      dest="$TARGET/$tsub/$(basename "$f")"
      if [[ -L "$dest" ]] && [[ "$(readlink -f "$dest")" == "$(readlink -f "$f")" ]]; then
        say "OK $(basename "$f") -> $tsub/"
      else
        say "PENDIENTE $(basename "$f") (corre sin --check para enlazar)"
        rc=1
      fi
    done
  done
  # Enlaces rotos del puente (apuntan al store pero el origen ya no existe).
  local d
  for pair in $MAP; do
    tsub="${pair##*:}"
    [[ -d "$TARGET/$tsub" ]] || continue
    for d in "$TARGET/$tsub"/*; do
      if [[ -L "$d" ]] && [[ ! -e "$d" ]]; then
        warn "enlace roto: $d -> $(readlink "$d")"
        rc=1
      fi
    done
  done
  exit $rc
}

case "${1:-}" in
  --check) do_check ;;
  --unlink) do_unlink ;;
  '' ) do_link ;;
  *) printf 'uso: %s [--check|--unlink]\n' "$0" >&2; exit 2 ;;
esac
