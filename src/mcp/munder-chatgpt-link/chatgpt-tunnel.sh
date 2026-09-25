#!/usr/bin/env bash
# chatgpt-tunnel.sh — expone munder-chatgpt-link a chatgpt.com.
#
# Cadena: server.mjs (stdio) -> supergateway (Streamable HTTP :8093/mcp)
#         -> cloudflared quick tunnel (HTTPS publica, URL aleatoria).
# Uso:  ./chatgpt-tunnel.sh
#       (deja supergateway + tunel corriendo; matalos con --stop)
# Requiere: node, npx (supergateway), cloudflared en PATH, link encendido.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${MUNDER_CHATGPT_PORT:-8093}"
WRAP="$HOME/.local/share/munder/munder-link-stdio.sh"
STATE="$HOME/.local/state/munder/chatgpt-tunnel"

if [[ "${1:-}" == "--stop" ]]; then
  pkill -f "supergateway.*$PORT" 2>/dev/null || true
  pkill -f "cloudflared tunnel --url http://127.0.0.1:$PORT" 2>/dev/null || true
  echo "chatgpt-tunnel: detenido (puerto $PORT)"
  exit 0
fi

# Wrapper sin espacios: supergateway parte --stdio por espacios y la ruta
# del repo ("ISyCo Git") lo rompe. El server resuelve lib-link por si solo.
mkdir -p "$(dirname "$WRAP")" "$STATE"
printf '#!/bin/sh\nexec node "%s/server.mjs" "$@"\n' "$HERE" > "$WRAP"
chmod +x "$WRAP"

command -v cloudflared >/dev/null || { echo "chatgpt-tunnel: falta cloudflared" >&2; exit 1; }

nohup npx -y supergateway --stdio "$WRAP" --outputTransport streamableHttp \
  --port "$PORT" --streamableHttpPath /mcp --logLevel none >"$STATE/sg.log" 2>&1 &
sleep 6
curl -s -o /dev/null -X POST "http://127.0.0.1:$PORT/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  --max-time 20 || { echo "chatgpt-tunnel: supergateway no responde en :$PORT (ver $STATE/sg.log)" >&2; exit 1; }

nohup cloudflared tunnel --url "http://127.0.0.1:$PORT" >"$STATE/cf.log" 2>&1 &
for _ in $(seq 1 20); do
  URL="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$STATE/cf.log" 2>/dev/null | head -n 1)"
  [[ -n "$URL" ]] && break
  sleep 2
done
[[ -n "${URL:-}" ]] || { echo "chatgpt-tunnel: sin URL (ver $STATE/cf.log)" >&2; exit 1; }
echo "chatgpt-tunnel: pega en chatgpt.com esta URL (mas /mcp):"
echo "$URL/mcp"
echo "(tuerce el tunel con ./chatgpt-tunnel.sh --stop; la URL muere al cerrarlo)"
