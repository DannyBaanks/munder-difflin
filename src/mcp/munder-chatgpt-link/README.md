# munder-chatgpt-link — fachada MCP para ChatGPT sobre Munder Link

Expone una oficina emparejada por Munder Link como 7 tools MCP
(`munder_link_verify/peers`, `munder_office_status`, `munder_compose_submit`,
`munder_task_get/message/cancel`). No reemplaza a Munder Link: reutiliza
`tools/munder/lib-link.cjs`, así que identidad, firmas, cifrado, anti-replay,
propiedad de tareas y recibos siguen siendo de Munder Link.

Antes de cada acción remota hace un `status` firmado+cifrado real y verifica
que la ruta sea loopback, misma subred LAN o Tailscale (`100.64.0.0/10`).
IPs privadas ruteadas o públicas se rechazan salvo override explícito, y el
peer debe estar emparejado: IP sola nunca basta.

## Instalar y probar

```bash
cd src/mcp/munder-chatgpt-link
npm install     # @modelcontextprotocol/sdk + zod (node_modules queda fuera del repo)
npm test        # gate de red, 5 tests, sin red
```

Requiere en la máquina: `munder link encender` corriendo y al menos una
oficina emparejada (`munder link` la lista).

## Conectar un cliente MCP (stdio)

```json
{
  "mcpServers": {
    "munder-chatgpt-link": {
      "command": "node",
      "args": ["/ruta/al/fork/src/mcp/munder-chatgpt-link/server.mjs"]
    }
  }
}
```

El servidor resuelve `tools/munder/lib-link.cjs` desde la raíz del repo;
para otro layout: `MUNDER_LINK_MODULE=/ruta/absoluta/lib-link.cjs`.
Usa el mismo state dir de Munder Link: los peers existentes son la confianza.

## Conectar chatgpt.com

```bash
./chatgpt-tunnel.sh    # stdio -> HTTP :8093 -> quick tunnel HTTPS
```

Pega la `https://*.trycloudflare.com/mcp` que imprime en chatgpt.com:
**Settings → Apps & Connectors → Advanced settings → Developer Mode** →
**Create** → Server URL = esa URL. El túnel vive mientras el script corre;
mátalo con `./chatgpt-tunnel.sh --stop` (la URL muere al cerrarlo y cada
levantada es distinta — por eso nadie te presta el suyo: cada quién levanta
el propio). Verificado end-to-end 2026-09-25: submit `accepted` + recibo
vía LAN contra una oficina ya emparejada.

Si chatgpt.com exige OAuth al crear el conector, aún no está: díselo al
mantenedor antes de publicar nada.

## Overrides del gate (normalmente sin tocar)

```bash
export MUNDER_CHATGPT_ALLOW_PRIVATE_ROUTED=1  # privada fuera de subred local
export MUNDER_CHATGPT_ALLOW_PUBLIC=1          # pública (el crypto sigue aplicando)
```

Seguridad: ningún tool expone PTYs, shell, archivos del hive ni tareas
ajenas a la oficina. Detalle del diseño para modelos: ver el README del
bundle original y `../office-bridge/GUIA.md` para el formato Office Bridge.
