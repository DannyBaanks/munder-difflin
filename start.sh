#!/usr/bin/env bash
set -euo pipefail

# start.sh — launcher de Munder Difflin (build compilado, DESPEGADO de la terminal).
#
# FIX 2026-09-21 — freeze "Detenido" al aceptar la sesión del harness:
# lanzar Electron adjunto a la terminal lo deja bajo job control del shell.
# Cuando node-pty arranca los agentes, el árbol recibe SIGTSTP y la app
# entera se congela (state T, "[N]+ Detenido" en bash, ventana freezada).
# Evidencia: PR del maintainer en el bridge (opencode/maintainer/pr-munder-sandbox,
# "node-pty SIGTSTP freeze on harness OK") + runs [1..3] "Detenido" del
# usuario + la instancia lanzada sin terminal de control (nohup sin tty) que
# nunca se congeló. Fix: setsid + stdio fuera de la terminal — sin terminal de
# control, el job control no puede enviar SIGTSTP.
#
# NOTA singleton: el userData (~/.config/munder-difflin) es COMPARTIDO entre
# este build y cualquier `npm run dev` del checkout de desarrollo. No lances
# ambos a la vez: la segunda instancia muere al arrancar (second-instance).
#
# SESIONES PARALELAS (2 harnesses a la vez): cada instancia necesita su PROPIO
# userData (ahí viven el singleton lock, config.json y harness.db — compartirlo
# es lo que impide el paralelo). Receta:
#   ./start.sh --user-data-dir ~/.config/munder-difflin          # sesión 1 (default)
#   ./start.sh --user-data-dir ~/.config/munder-difflin-harness2 # sesión 2
# Cada userData tiene su propio config.json → cada uno apunta a su propio
# harness home (el botón "create new config…" del HivePicker los crea). Los
# puertos del broker/telemetry son efímeros (no colisionan). OJO: no pongas a
# dos sesiones a trabajar sobre los mismos repos a la vez.
#
# Uso:
#   ./start.sh                 lanza la app despegada (recomendado)
#   ./start.sh --fg            modo viejo adjunto — SOLO debug, puede congelarse
#   ./start.sh --stop          detiene la app (TODAS las instancias de este build)
#   ./start.sh --check         verifica electron + build
#   ./start.sh --electron-version  versión de electron
#   ./start.sh --user-data-dir DIR  userData propio (sesiones paralelas)
#
# Logs:    tail -f "$(readlink -f ~/.local/state/munder-difflin/latest.log)"

# Resolvemos la raíz del repo desde la ubicación de este script.
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
APP_ROOT="$(dirname "$SCRIPT_PATH")"
ELECTRON="$APP_ROOT/node_modules/.bin/electron"
APP_BIN="$APP_ROOT/node_modules/electron/dist/electron"   # binario real (el .bin/ es un shim que muere)
MAIN_ENTRY="$APP_ROOT/out/main/index.js"
SANDBOX_HELPER="$APP_BIN/../chrome-sandbox"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/munder-difflin"
GPU_SIG="GPU process.*isn't usable|GPU process launch failed"

say() { printf 'start.sh: %s\n' "$*"; }

# Pre-barre --user-data-dir (formas `--user-data-dir DIR` y `--user-data-dir=DIR`)
# antes del dispatch por $1, para que combine con --fg/--stop/lanzamiento.
USER_DATA_DIR=""
FILTERED_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user-data-dir)
      USER_DATA_DIR="${2:-}"; shift 2 || { printf 'start.sh: --user-data-dir necesita un directorio\n' >&2; exit 2; }
      [[ -n "$USER_DATA_DIR" ]] || { printf 'start.sh: --user-data-dir necesita un directorio\n' >&2; exit 2; }
      ;;
    --user-data-dir=*)
      USER_DATA_DIR="${1#--user-data-dir=}"; shift
      [[ -n "$USER_DATA_DIR" ]] || { printf 'start.sh: --user-data-dir necesita un directorio\n' >&2; exit 2; }
      ;;
    *) FILTERED_ARGS+=("$1"); shift ;;
  esac
done
if [[ ${#FILTERED_ARGS[@]} -gt 0 ]]; then set -- "${FILTERED_ARGS[@]}"; else set --; fi

if [[ "${1:-}" == "--check" ]]; then
  [[ -x "$ELECTRON" ]] || { printf 'Electron no encontrado: %s\n' "$ELECTRON" >&2; exit 1; }
  [[ -f "$MAIN_ENTRY" ]] || { printf 'Build de Munder no encontrado: %s\n' "$MAIN_ENTRY" >&2; exit 1; }
  printf 'start.sh: OK\nroot: %s\nelectron: %s\nmain: %s\n' "$APP_ROOT" "$ELECTRON" "$MAIN_ENTRY"
  exit 0
fi

if [[ "${1:-}" == "--electron-version" ]]; then
  exec "$ELECTRON" --version
fi

[[ -x "$ELECTRON" ]] || {
  printf 'Electron no encontrado. Ejecuta npm install en %s\n' "$APP_ROOT" >&2
  exit 1
}
[[ -f "$MAIN_ENTRY" ]] || {
  printf 'Build de Munder no encontrado. Ejecuta npm run build en %s\n' "$APP_ROOT" >&2
  exit 1
}

if [[ "${1:-}" == "--stop" ]]; then
  if pkill -f "$APP_ROOT" 2>/dev/null; then
    say "señal SIGTERM enviada a los procesos de $APP_ROOT"
  else
    say "no hay procesos corriendo"
  fi
  exit 0
fi

cd "$APP_ROOT"

# Linux Electron installs from a user checkout cannot normally make
# chrome-sandbox root-owned/setuid. Keep the launcher usable in that case, but
# allow a strict sandbox run with MUNDER_NO_SANDBOX=0 after the helper is fixed.
ELECTRON_FLAGS=()
if [[ "${MUNDER_NO_SANDBOX:-auto}" == "1" ]] || {
  [[ "${MUNDER_NO_SANDBOX:-auto}" != "0" ]] &&
  [[ ! -f "$SANDBOX_HELPER" || "$(stat -c '%u %a' "$SANDBOX_HELPER")" != "0 4755" ]]
}; then
  ELECTRON_FLAGS+=(--no-sandbox)
fi
# userData propio → instancia independiente (singleton, config.json y
# harness.db separados): la base de las sesiones paralelas. Chromium lo consume
# nativamente; va en flags para que aplique igual en despegado y --fg.
if [[ -n "$USER_DATA_DIR" ]]; then
  ELECTRON_FLAGS+=("--user-data-dir=$USER_DATA_DIR")
fi
# Guardia singleton acotada al userData: sin --user-data-dir cubre todo el
# build (comportamiento anterior); con flag solo vigila esa instancia para
# no bloquear el paralelo.
GUARD_PATTERN="$APP_BIN"
[[ -n "$USER_DATA_DIR" ]] && GUARD_PATTERN="$APP_BIN.*$USER_DATA_DIR"

if [[ "${1:-}" == "--fg" ]]; then
  # Modo viejo: adjunto a esta terminal. Puede recibir SIGTSTP del job control
  # y congelarse al aceptar la sesión del harness — solo para debug.
  printf 'start.sh: modo adjunto (--fg): ADVERTENCIA — puede congelarse (SIGTSTP del job control)\n'
  exec "$ELECTRON" "${ELECTRON_FLAGS[@]}" "$APP_ROOT"
fi

# ─── Lanzamiento despegado (fix del freeze) ────────────────────────────────────
# Log por corrida (evidencia conservada) + symlink latest.log. El .bin/electron
# es un shim de Node: el proceso real es APP_BIN — es a quien hay que vigilar.
mkdir -p "$STATE_DIR"
RUN_LOG="$STATE_DIR/run-$(date +%Y%m%dT%H%M%S).log"
ln -sfn "$RUN_LOG" "$STATE_DIR/latest.log"

launch_detached() {
  # setsid: nueva sesión sin terminal de control. stdio a archivo: ni SIGTSTP
  # del job control ni SIGHUP al cerrar la terminal pueden tocar la app.
  setsid "$ELECTRON" "${ELECTRON_FLAGS[@]}" "$@" "$APP_ROOT" </dev/null >>"$RUN_LOG" 2>&1 &
}

if pgrep -f "$GUARD_PATTERN" >/dev/null; then
  printf 'start.sh: ya hay una instancia corriendo (singleton compartido) — no lanzo otra\n'
  exit 0
fi

printf 'start.sh: lanzando despegada (sin terminal de control)\n'
launch_detached

# Ventana de detección de fallo de GPU (~6 s): la muerte por GPU es rápida.
# Si el proceso muere y el log firma el fallo de GPU, reintenta con software.
for _ in $(seq 1 12); do
  sleep 0.5
  if ! pgrep -f "$GUARD_PATTERN" >/dev/null; then
    if grep -Eq "$GPU_SIG" "$RUN_LOG"; then
      printf 'start.sh: proceso GPU falló — reintentando con render por software\n'
      launch_detached --disable-gpu --use-gl=swiftshader
    else
      printf 'start.sh: la app terminó de forma inesperada; últimas líneas del log:\n'
      tail -n 20 "$RUN_LOG" >&2
      exit 1
    fi
    break
  fi
done

PID_MAIN="$(pgrep -f "$GUARD_PATTERN" | head -1 || true)"
printf 'start.sh: en marcha (pid main: %s)\n' "${PID_MAIN:-?}"
printf 'start.sh: log de esta corrida: %s\n' "$RUN_LOG"
printf 'start.sh: parar: ./start.sh --stop\n'