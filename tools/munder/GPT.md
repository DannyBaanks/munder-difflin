# Munder GPT

ChatGPT entra a tu oficina como un **principal** de Munder, llamado `gpt`, con la autoridad que tú le das. No es un conjunto de excepciones del MCP: es un usuario de Munder, con permisos explícitos, con auditoría y revocable.

```text
transporte  dice DÓNDE está Munder          (una URL; no da ningún permiso)
OAuth       dice QUIÉN llama                (un token que tú aprobaste)
el permiso  dice QUÉ puede hacer            (scopes, con el perfil como tope)
```

## En tres pasos

```bash
munder gpt perfil full                  # te muestra TODO lo que tendrá y te pide confirmar
munder gpt encender --transporte ngrok --dominio tu-dominio.ngrok-free.dev
munder gpt aprobar 123456               # el código que te muestra ChatGPT al conectar
```

`encender` imprime algo así:

```text
MUNDER GPT

Principal:  gpt
Autoridad:  FULL (munder.read munder.operate munder.admin)
OAuth:      listo (registro dinámico + PKCE + tu aprobación en esta terminal)
Gateway:    corriendo en 127.0.0.1:47834
Transporte: ngrok
Endpoint:   https://tu-dominio.ngrok-free.dev
Permisos:   0 activo(s)

Conexión en ChatGPT (Settings → Apps & Connectors → Advanced → Developer mode → Create):
  MCP Server URL: https://tu-dominio.ngrok-free.dev/mcp
  Authentication: OAuth
```

Al crear el conector, ChatGPT abre una página de Munder con un **código de 6 dígitos**:

1. En la computadora, `munder gpt solicitudes` muestra la solicitud y a qué host regresa. Debe ser `chatgpt.com`.
2. Apruébala con `munder gpt aprobar <código>`.
3. La página regresa sola a ChatGPT.

Nadie puede aprobar desde la web: solo tú, en tu terminal.

## Perfiles

| Perfil | Scopes | Para qué |
|---|---|---|
| `lectura` | `munder.read` | Ver la oficina, las tareas, la bitácora, el buzón y las oficinas enlazadas. |
| `operador` | `+ munder.operate` | Escribirle a Michael, contestar preguntas, delegar por Link, mandar mensajes y cancelar lo delegado. |
| `full` | `+ munder.admin` | Contratar y despedir agentes, arrancar packs y el Reviver. |

- **Cómo se combinan:** el permiso de cada ChatGPT conectado nunca excede el perfil **actual**. Si bajas a `lectura`, los permisos ya dados pierden `operate` y `admin` desde la siguiente llamada.
- **Qué muestra ChatGPT:** `tools/list` solo lista lo que el permiso deja usar.
- **Si pide algo fuera de su scope:** la llamada se rechaza y queda en la auditoría como `tool_denied`.

`munder gpt capacidades full` lista las 25 herramientas. Esta es la lista de **Full**, que es todo lo que este operador puede delegar:

| Scope | Herramientas |
|---|---|
| read | `office_overview`, `task_get`, `activity_log`, `gpt_inbox`, `gpt_inbox_read`, `link_offices`, `link_office_status`, `link_task_get`, `session_agents`, `packs_list`, `gpt_audit`, `reviver_status` |
| operate | `michael_message`, `gpt_inbox_reply`, `gpt_inbox_mark_read`, `question_answer`, `link_delegate`, `link_task_message`, `link_task_cancel` |
| admin | `agent_hire`, `agent_fire`, `pack_start`, `reviver_start`, `reviver_restart`, `reviver_stop` |

**Nunca, con ningún perfil:**
- Emparejar, aceptar u olvidar oficinas o celulares: cambia en quién confía la oficina.
- Cambiar sus propios permisos.
- Configurar el Reviver.
- Contratar con un comando libre, que sería una shell remota. Se contrata solo con los CLIs conocidos: `claude`, `codex`, `opencode`, `openisy`, …

### De dónde sale la lista

Munder no tiene un registro único de operaciones. Tiene cuatro superficies:
- el `dispatch` de Munder Remote;
- las operaciones de Munder Link;
- las rutas del canal de control de la app;
- las operaciones del Reviver.

`INVENTORY` en `lib-gpt.cjs` clasifica cada una como **expuesta** (con qué herramienta) o **excluida** (y por qué). El test `inventory` **lee esas cuatro fuentes** y falla si aparece una operación nueva sin clasificar. Una operación nueva de Munder no puede quedarse fuera de Full en silencio, ni colarse sin scope.

## El buzón de GPT: «¿ya me contestó Michael?»

- **De Michael a ChatGPT:** Michael (o cualquier agente) escribe un mensaje con `"to": "gpt"`. El router del hive lo deja en `<hive>/gpt/inbox`.
- **Cómo lo encuentra ChatGPT:** `gpt_inbox` lista lo que le llegó, sin que tú le pases ningún id. Luego `gpt_inbox_read` lo lee, `gpt_inbox_reply` contesta en el mismo hilo (`in_reply_to` y `conversation`) y `gpt_inbox_mark_read` lo archiva.
- **Cuándo existe el buzón:** solo mientras `munder gpt` lo configuró. Sin él, `"to": "gpt"` rebota a Michael como cualquier destinatario desconocido, igual que antes.
- **Qué no es:** `gpt` no es un agente. No tiene terminal, no está en el roster y no recibe los broadcasts.
- **Qué no ve:** los buzones de otros agentes nunca pasan por aquí.

## Oficinas enlazadas: Full aquí no es Full allá

Por Munder Link, ChatGPT es **esta oficina** actuando como peer:
- Delega, sigue, manda mensajes y cancela **lo que esta oficina delegó**.
- Nunca ve el tablero de la otra oficina. Esa es la regla de propiedad de Link, y no se toca.

Para tener Full en el Xeon, corre `munder gpt` **en el Xeon**. Cada oficina decide sobre sí misma.

## Seguridad

- **OAuth 2.1** con el subconjunto que usan los clientes MCP:
  - metadatos RFC 9728 en `/.well-known/oauth-protected-resource/mcp` y RFC 8414 en `/.well-known/oauth-authorization-server`;
  - registro dinámico (RFC 7591), solo para clientes públicos;
  - PKCE `S256` obligatorio;
  - códigos de un solo uso que duran 5 min;
  - access token de 1 h;
  - refresh token que rota: el anterior muere;
  - `/revoke` (RFC 7009).
- **Sin autorización no hay nada:** `/mcp` responde `401` con `WWW-Authenticate: Bearer … resource_metadata="…"`. Saber la URL no da nada.
- **Nada secreto en disco:** tokens y códigos se guardan como SHA-256. Nunca aparecen en `audit.jsonl`, en el log del hive ni en una URL; el test «no raw token» lo comprueba.
- **Cada acción lleva nombre:**
  - el mensaje sale `from: "gpt"`;
  - la bitácora del hive registra `principal: "gpt"` y `grant_id`;
  - el recibo es `{ id, kind, correlation_id, principal: "gpt", grant_id }`;
  - `munder gpt auditoria` registra cada solicitud, aprobación, token, llamada, rechazo y revocación.
- **Revocar:** `munder gpt revocar <permiso|cliente|todo>` funciona desde la siguiente llamada, y el refresh token también deja de servir.
- **Apagar:** `munder gpt apagar` apaga el gateway. Los permisos se quedan (para quitarlos, `revocar todo`), y el hive, Link, Remote y el Reviver no se tocan.
- **Estado en disco:** todo vive en `~/.local/state/munder/gpt/`. Borrar esa carpeta quita GPT por completo sin tocar nada más.

## Transportes

| `--transporte` | URL | Nota |
|---|---|---|
| `ngrok --dominio D` | fija | Un dominio estático de tu cuenta. **No uses el del EVO Gateway**: pide otro o usa `manual`. La primera vez en el navegador, ngrok free muestra un aviso: dale «Visit site». |
| `manual --url https://…` | fija | Tu propio reverse proxy, o Tailscale Funnel (`tailscale funnel --bg 47834`), apuntando a `127.0.0.1:47834`. |
| `cloudflared` | cambia cada vez | Solo para probar. |
| `local` | `http://127.0.0.1:47834` | Solo pruebas en la misma máquina; ChatGPT necesita https. |

La URL que imprime `encender` es la que respondió de verdad: el CLI llama a `<url>/health` y avisa si no contestó.

## Comandos

```text
munder gpt                        estado y menú
munder gpt perfil lectura|operador|full [--si]
munder gpt capacidades [perfil]
munder gpt encender [--transporte …] [--dominio D] [--url U] [--puerto N]
munder gpt apagar | estado [--json]
munder gpt solicitudes | aprobar CÓDIGO | rechazar CÓDIGO
munder gpt permisos | revocar ID|CLIENTE|todo
munder gpt auditoria [N] | buzon | reviver
```

`munder gpt reviver` le da a GPT su propio cliente del Reviver: sus recibos dicen `gpt`, no `local`.

## Pruebas

```bash
node --test tools/munder/gpt.test.cjs              # 19 pruebas contra HTTP real, hive real y dos oficinas Link reales
node --test test/gpt-inbox-routing.test.cjs        # el router del hive con "to": "gpt"
(cd src/mcp/munder-chatgpt-link && npm test)       # incluye el cliente OAuth oficial del SDK de MCP contra el gateway
```
