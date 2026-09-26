<!-- Notas del release del fork. Se publican tal cual como cuerpo del GitHub Release. -->
# Munder Difflin v0.5.2-ISyCo.2

Segunda iteración pública del fork ISyCo sobre Munder Difflin 0.5.2.

`v0.5.2-ISyCo.1` fue el primer corte público del fork. Desde ese snapshot, Munder dejó de ser solo una oficina multiagente con CLI y Munder Link: ahora puede enlazar máquinas, entrar desde iPhone, exponer una superficie de Panel con autoridades explícitas, recibir a ChatGPT como principal con permisos, recuperarse aunque la app esté caída y delegar trabajo a harnesses externos conservando recibos y provenance.

> **Piso de evidencia:** esta nota enumera únicamente capacidades presentes en este tag. Ideas futuras —como Munder Worlds— y superficies todavía incompletas —como el catálogo instalable del Marketplace— no se anuncian como terminadas.

## Lo grande de este build

### 🔗 Munder Link: oficinas reales entre máquinas

- Enlaza oficinas por LAN o Tailscale con confirmación humana mediante código de 6 dígitos.
- Cada oficina conserva su propio Michael, agentes, archivos y runtime; una oficina delega trabajo a la otra en vez de montar el filesystem remoto.
- Estado, tareas y respuestas remotas viajan por el protocolo sellado de Link.
- El emparejamiento y las respuestas fueron endurecidos: SAS ligado a las llaves de cifrado, anti-replay, límites de `/pair` y descubrimiento UDP acotado a redes privadas/Tailscale.
- La UI de **Configuración → Munder Link** usa el mismo estado y motor que el CLI.

### 📱 Munder Mobile: PWA + app nativa de iPhone

- Cliente móvil para ver la oficina, preguntas y tablero; escribirle a Michael o a un agente y cambiar entre oficinas enlazadas.
- App nativa SwiftUI con el mismo protocolo `munder-remote@1`; CI produce una `.ipa` sin firmar y verifica su build.
- Emparejamiento único con direcciones LAN/Tailscale y selección de la ruta que responde.
- **Face ID / código del dispositivo** antes de mostrar la oficina y nuevamente para acciones sensibles.
- La app se vuelve a bloquear tras pasar tiempo en segundo plano y cubre el snapshot del app switcher.

### 🎛️ Panel como estrato, no como duplicado de la oficina

- **Munder Panel** expone las operaciones útiles del CLI como botones y puede abrir aunque Munder esté cerrado o haya fallado.
- La superficie remota usa `panel.state` / `panel.action` y reutiliza las acciones reales del host en vez de reimplementar la oficina.
- Autoridades separadas: emparejar un celular no le concede automáticamente control de máquina.
- Operaciones sensibles de host requieren autoridad `machine`; las no declaradas fallan cerradas.
- La pestaña Panel de iPhone pasa cada mutación por autenticación del dueño.

### 💬 ChatGPT como principal `gpt`

- `munder gpt` conecta ChatGPT como un principal real de Munder, no como excepciones ad hoc del MCP.
- OAuth 2.1/PKCE, perfiles `read` / `operate` / `admin`, permisos revocables y con caducidad.
- Las tools expuestas dependen del permiso vigente.
- Mutaciones dejan recibos y auditoría; los tokens se almacenan por hash, no en claro.
- Buzón propio `gpt` dentro del hive sin convertir a ChatGPT en un worker con terminal.

### 🛟 Munder Reviver

- Plano de mantenimiento independiente de la app principal.
- Puede consultar salud, arrancar o reiniciar Munder incluso cuando Munder está totalmente caído.
- Watchdog acotado: no entra en loops infinitos de reinicio y respeta los cierres intencionales.
- Identidad, nonces y recibos para las operaciones del Reviver.
- Integración con Linux (`systemd --user`) y Windows.

### 🧩 Harnesses externos sin absorberlos

- Munder puede usar **OpenAI Codex** y **DeepSeek Harness** como dominios de ejecución externos.
- Adaptadores con capabilities declaradas, límites de recursión, filtrado de secretos y recibos.
- Artefactos medidos antes/después del trabajo y eventos crudos + normalizados para conservar provenance.
- Un harness que no demuestra cierre positivo no se reporta falsamente como `completed`.

### 🧠 Continuidad de agentes y memoria

- Agentes OpenCode/OpenISy recuperan su `session_id` y reanudan la conversación al volver a abrir Munder cuando la sesión todavía existe.
- La configuración del agente se mezcla en vez de destruirse al respawn.
- Reparación del caso real de Hugging Face/ONNX donde el modelo y sus datos externos quedaban separados y MemPalace dejaba de indexar.

### 🏢 Office Packs y documentos

- Office Packs para levantar equipos prearmados desde el CLI/canal de control.
- Validación de packs importados y límites explícitos sobre acciones externas.
- Lectura de Word, Excel, PowerPoint y PDF fuera del proceso main; si un documento no puede extraerse, no se inventa contenido.

### 🧭 Nuevo shell de navegación

- Barra global con **Oficina · Configuración ▾ · Marketplace**.
- Configuración abre directamente sus secciones desde la barra superior.
- El piso y los agentes siguen montados al cambiar de superficie.
- El Marketplace existe como shell/vitrina, pero **el catálogo instalable todavía no está conectado**.

### 🔐 Integridad y seguridad del hive

- Escrituras durables mediante temp + rename para evitar JSON truncado tras crash, reboot o disco lleno.
- Los IDs de mensajes se generan del lado de Munder: un agente ya no puede elegir un filename de inbox ni atravesar rutas con un ID fabricado.
- El hold del operador silencia las rutas automáticas de entrega sin descartar los mensajes pendientes.
- `PROTOCOL.md` / `COMMANDS.md` dejan de sobrescribirse durante operaciones normales; se refrescan en bootstrap.
- Guardia de escritura del hive y compatibilidad de trust paths de Claude Code en Windows.

### 🪟🐧🍎 Multiplataforma de verdad

- CI de build/tests en Linux, Windows y macOS.
- Correcciones específicas de Windows para worktrees, junctions, rutas, Claude Code y las carreras de cierre de Codex/ACP.
- Workflow separado para compilar/probar Munder Mobile en iOS.
- El release empaqueta Windows, Linux y macOS desde el mismo tag.

## Cosas que deliberadamente NO estamos llamando terminadas

- **Marketplace:** la navegación y la vitrina existen; el catálogo/instalación todavía está en evolución.
- **Munder Worlds:** Monster Trainer, Tavern, Starship y otros mundos visuales son trabajo futuro; no forman parte de este build.
- **Self-signing de Munder Mobile:** existe investigación/documentación, no se anuncia como feature shipping.
- El endurecimiento de reconexión móvil/Link continúa a medida que aparecen casos reales de campo.

## Descargas

| Plataforma | Descarga |
|---|---|
| macOS (universal) | [`Munder-Difflin-0.5.2-ISyCo.2-mac-universal.dmg`](https://github.com/DannyBaanks/munder-difflin/releases/download/v0.5.2-ISyCo.2/Munder-Difflin-0.5.2-ISyCo.2-mac-universal.dmg) |
| Windows (instalador) | [`Munder-Difflin-0.5.2-ISyCo.2-win-x64-setup.exe`](https://github.com/DannyBaanks/munder-difflin/releases/download/v0.5.2-ISyCo.2/Munder-Difflin-0.5.2-ISyCo.2-win-x64-setup.exe) |
| Windows (portable) | [`Munder-Difflin-0.5.2-ISyCo.2-win-x64-portable.exe`](https://github.com/DannyBaanks/munder-difflin/releases/download/v0.5.2-ISyCo.2/Munder-Difflin-0.5.2-ISyCo.2-win-x64-portable.exe) |
| Linux (AppImage) | [`Munder-Difflin-0.5.2-ISyCo.2-linux-x86_64.AppImage`](https://github.com/DannyBaanks/munder-difflin/releases/download/v0.5.2-ISyCo.2/Munder-Difflin-0.5.2-ISyCo.2-linux-x86_64.AppImage) |
| Linux (`.deb`) | [`Munder-Difflin-0.5.2-ISyCo.2-linux-amd64.deb`](https://github.com/DannyBaanks/munder-difflin/releases/download/v0.5.2-ISyCo.2/Munder-Difflin-0.5.2-ISyCo.2-linux-amd64.deb) |

Verifica los artefactos con [`SHA256SUMS.txt`](https://github.com/DannyBaanks/munder-difflin/releases/download/v0.5.2-ISyCo.2/SHA256SUMS.txt).

```bash
sha256sum -c SHA256SUMS.txt
```

Los builds pueden estar sin firma si los secretos/certificados de firma no están disponibles en CI; el workflow está diseñado para seguir produciendo artefactos de contribuidor en ese caso.

## Provenance

- Upstream: [`chaitanyagiri/munder-difflin`](https://github.com/chaitanyagiri/munder-difflin)
- Fork ISyCo: [`DannyBaanks/munder-difflin`](https://github.com/DannyBaanks/munder-difflin)
- Base de producto: Munder Difflin `0.5.2`
- Línea del fork: `0.5.2-ISyCo.N`

---

**Regla de este release:** si una capacidad no está en el tag o no tiene una superficie verificable en el repo, no aparece arriba como feature terminada.
