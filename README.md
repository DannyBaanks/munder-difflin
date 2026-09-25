<div align="center">

<img src="./docs/logo.png" alt="Munder Difflin — fork ISyCo" width="180">

# Munder Difflin — Fork ISyCo

### El harness multi-agente, en español y con canal de control local

</div>

> Fork en español de [chaitanyagiri/munder-difflin](https://github.com/chaitanyagiri/munder-difflin) (v0.4.6).
> Este repo es [DannyBaanks/munder-difflin](https://github.com/DannyBaanks/munder-difflin).
> El upstream es la app de oficina multi-agente (Electron + terminales reales + hive):
> su producto completo se documenta en su
> [README](https://github.com/chaitanyagiri/munder-difflin/blob/main/README.md),
> [`HIVE.md`](./HIVE.md), [`SPEC.md`](./SPEC.md) y [`DESIGN.md`](./DESIGN.md).
> Aquí solo está **lo que cambia este fork + lo mínimo para correrlo**.

## El comando que viniste a buscar

```bash
./start.sh                 # build compilado, despegado de la terminal (recomendado)
munder start               # dev con hot reload, también despegado (ver abajo)
```

Regla de oro: **nunca los dos a la vez** — comparten
`~/.config/munder-difflin` y la segunda instancia muere por singleton.
Dos sesiones en paralelo: `./start.sh --user-data-dir ~/.config/munder-difflin-harness2`.

Instaladores firmados (macOS/Windows/Linux) siguen en
[releases del upstream](https://github.com/chaitanyagiri/munder-difflin/releases/latest).

## Para correrlo (mínimo)

Requisitos: Node.js 18+, toolchain C++ para `node-pty`, y al menos un CLI
de agente en tu `PATH` (`claude` por defecto, o `agy/codex/grok/kimi/gemini/qwen/opencode/crush/pi/copilot/cursor-agent`).

```bash
git clone https://github.com/DannyBaanks/munder-difflin.git
cd munder-difflin
npm install        # postinstall recompila node-pty contra Electron
npm run dev        # o mejor: munder start (siguiente sección)
```

En el primer arranque sale el onboarding; **Add agent** crea tu primera sesión —
el GOD se sienta solo en la oficina de Michael.

## ISyCo Features — lo que añade este fork

### 1. Español primero
Selector de idioma al onboarding (`en/es/zh-CN/ar`). El inglés sigue siendo
el default: nada cambia hasta que eliges en Settings. `es.json` completo,
Title Case, sin artefactos de traducción automática.

### 2. Canal de control local (`127.0.0.1`)
Loopback solo-máquina con token `0600` en userData. `munder ctl ping`,
`GET /salud`, `GET /sesion`, `POST/DELETE /sesion/agentes` y repintado
bajo demanda sin restart. Sin token se rehúsa; nada del puerto sale de la máquina.

### 3. Launcher Linux `./start.sh`
Fix del freeze "Detenido": Electron despegado con `setsid`, stdio a
`~/.local/state/munder-difflin/run-*.log`, sin terminal de control para que el
job control no mande `SIGTSTP`. Reintento GPU→software, guardia singleton por
userData, `--fg` solo debug. Ver `./start.sh --check`.

### 4. Supervisión de entrega (router + breaker)
Si hay outbox encolado y el router murió, el beat de 8s lo rearma y drena
(peor caso ~9.5s, log `router-supervise`). Un evento sin `tool_input`
(Pi bridge, plugin OpenCode) ya no cuenta como loop idéntico; velocity /
error-storm / no-progress siguen intactos.
Ver [`docs/delivery-reliability-decision.md`](./docs/delivery-reliability-decision.md).

### 5. Canvas + terminal Linux
`useCanvasRepaint`: repinta retratos 2D tras la muerte del proceso GPU
(heartbeat 30s + focus/visible). `terminal:openAtFolder` abre tu terminal
(gnome-terminal > ptyxis > konsole > …) en vez del `open -a` de macOS.

### 6. Harness usable + avatar compilado
Botón "create new config" en HivePicker, homes anidados en fresh mode,
`.gitignore` auto en cada home, sesiones paralelas por `--user-data-dir`.
Avatares procedurales compartidos app↔CLI (`composeAvatar`, `AVATAR_VOCAB`):
mismo texto = mismo PNG, sin drift.

### 7. Catálogo + Office Bridge MCP
`modelCatalog.json` con familia `openisy`, `mcpCatalog.ts` con `office-bridge`
(stdio local, `HIVE_ROOT` inyectado): `compose_submit/task_get/task_message/task_cancel/office_status`.
Guía sin rutas personales en [`src/mcp/office-bridge/GUIA.md`](./src/mcp/office-bridge/GUIA.md).

### 8. CLI `munder` — sin `npm run dev`
Yo no arranco con `npm run dev`: el fork trae `tools/munder/munder`
(Node puro, cero dependencias). Instala con
`ln -sf "$PWD/tools/munder/munder" ~/.local/bin/munder`:

```bash
munder start / stop / restart / status / logs -f   # ciclo de vida
munder sesion ver / armar / quitar                 # agentes en vivo
munder ctl ping / repaint                          # canal de control
munder sesion proveedor                            # wizard de CLIs y modelos
munder avatar compilar "piel morena, blusa rosa, gafas"  # PNG 18×28/18×32
munder avatar inspect ./yo.png                     # matriz textual
```

Detalle en [`tools/munder/README.md`](./tools/munder/README.md);
receta para modelos en [`tools/munder/AVATAR_AGENTES.md`](./tools/munder/AVATAR_AGENTES.md).

### 9. Placeholder de worker ("cuerpo prestado")
Tu avatar entra al piso como un worker más: `firstFreeCharacter()` elige el
slot libre (nunca `michael`, que es del GOD) e `injectAvatarAs()` le inyecta
tu receta con cachés invalidadas. Comportamiento y hitbox intactos (la clase
`Character` es genérica); las líneas que dice son las del slot prestado.
Y persiste: `munder avatar inyectar "tu desc" --slot auto` guarda la receta
en `avatar-overrides.json` y la app la aplica al arrancar.

## Garantías de este fork

* Nada subido al upstream: remoto `fork=DannyBaanks/munder-difflin`.
* Sin llaves en el repo: solo placeholders (`xoxb-...`) en docs y comentarios.
* `avatar-engine.cjs` es GENERATED desde `portraitArt.ts` (verificado por hash
  en la suite); no se edita a mano:
  `node tools/munder/sync-avatar-engine.cjs`.
* Tests: `node tools/munder/avatar.test.cjs`,
  `node tools/munder/proveedor.test.cjs`, `npm run typecheck`.

## Licencia

Código bajo **MIT** — ver [`LICENSE`](./LICENSE). El pixel-art incluido es
*Modern Interiors - RPG Tileset [16X16]* de
[LimeZu](https://limezu.itch.io/moderninteriors) (licencia Complete Version,
con crédito obligatorio; no cubierto por el MIT) — ver
[`LICENSE-ASSETS`](./LICENSE-ASSETS). Parodia afectuosa, sin afiliación con
NBC, *The Office* ni Dunder Mifflin.
