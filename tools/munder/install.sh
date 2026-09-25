#!/usr/bin/env bash
# install.sh — instala el CLI `munder` para cualquiera.
#
# Uso:
#   ./tools/munder/install.sh
#
# Hace: symlink ~/.local/bin/munder -> tools/munder/munder, verifica PATH
# y corre `munder check`. No toca nada fuera de ~/.local/bin.
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$APP_ROOT/tools/munder/munder"
TARGET="${HOME}/.local/bin/munder"

[[ -f "$CLI" ]] || { echo "install.sh: no existe $CLI" >&2; exit 1; }
command -v node >/dev/null || { echo "install.sh: falta node (https://nodejs.org)" >&2; exit 1; }

mkdir -p "${HOME}/.local/bin"
if [[ -e "$TARGET" && ! -L "$TARGET" ]]; then
  # Archivo real (no symlink): se respalda, no se pisa (convención: *.pre-cli).
  cp -p "$TARGET" "$TARGET.pre-cli"
  echo "install.sh: respaldo del anterior en $TARGET.pre-cli"
fi
ln -sf "$CLI" "$TARGET"
echo "install.sh: $TARGET -> $CLI"

case ":${PATH}:" in
  *:"${HOME}/.local/bin":*) ;;
  *) echo "install.sh: AVISO — ~/.local/bin no está en tu PATH. Agrega:"; echo "  export PATH=\"\$HOME/.local/bin:\$PATH\"";;
esac

exec "$TARGET" check
