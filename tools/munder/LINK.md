# Munder Link — guía

Enlaza dos oficinas de Munder, por ejemplo la Linux de 16 GB con la Xeon de 32 GB, para que un Michael le pase trabajo al otro. Funciona en la misma red wifi y también por Tailscale.

## El comando

En **las dos máquinas**:

```bash
munder link conectar
```

Una de las dos va a encontrar a la otra y a mostrar un código de 6 dígitos. En la otra corres `munder link aceptar` y escribes ese código. Listo: quedan enlazadas para siempre, aunque cambie la IP.

Después:

```bash
munder link enviar xeon "audita PITON"
```

Cuando la otra oficina termine, contesta ella:

```bash
munder link responder linux link-1790320261836-f1c80b "listo" --resultado "3 hallazgos"
```

## La regla de oro

**Solo acepta un código que estés viendo en la otra pantalla.** Emparejar es darle a esa máquina permiso de mandarle trabajo a tu Michael, y tu Michael ejecuta agentes en tu computadora. Si llega una solicitud que no esperabas, o el código no coincide, no aceptes nada.

## Cómo funciona (en corto)

```text
Linux                                   Xeon
Michael A ──▶ munder link enviar ──▶ servidor del enlace ──▶ inbox de Michael B
   ▲            (firmado + cifrado)        (puerto 47831)          │
   │                                                                ▼
   └── munder link responder ◀── munder link responder ── Michael B termina
```

- **Michael ↔ Michael.** La otra máquina nunca toca tu hive ni tus terminales. Deja la tarea en el inbox de tu Michael, igual que el Office Bridge, y tu Michael decide cómo hacerla.
- **Descubrir es automático; confiar, no.** La red local no se considera segura por sí sola.
- **Cada llamada va firmada (Ed25519) y cifrada (X25519 + AES-256-GCM)**, también por Tailscale. Un sobre repetido, alterado o viejo se rechaza.
- **Una oficina solo ve las tareas que ella misma delegó**, no el resto de tu tablero.
- **Queda recibo en los dos lados:** `link_delegated` en el `log.jsonl` del hive que envía, `link_received` en el que recibe, y `~/.local/state/munder/link/receipts.jsonl`.

## La `origin_ref`: por qué la respuesta llega a quien corresponde

Cada `enviar` inventa un `origin_ref` (lo verás en la línea **Tarea de origen:** de la tarea delegada y en `link.origin_ref` dentro de `tasks.json`). Es el hilo.

- **Se guarda siempre pegada a la oficina que la mandó**, en `~/.local/state/munder/link/origins.json`, con la clave `<oficina>|<origin_ref>`. Una `origin_ref` suelta no significa nada: por eso otra oficina emparejada no puede contestar una tarea que no es suya (sale `no tengo ninguna tarea delegada con esa referencia` y queda en el log como `link_reply_rejected`).
- **Reenviar la misma `origin_ref` no duplica trabajo.** Si el comando se cayó a mitad de camino y lo repites con la misma ref, la otra oficina te devuelve la misma tarea en vez de crearte otra. La primera versión gana.
- **Contestar no es abrir la puerta.** `responder` solo funciona para una ref que esa misma oficina te dio, y solo escribe un mensaje en el inbox de tu Michael (`link_reply_received` en tu log, y `reply_received` en sus recibos).

El índice se poda solo: 30 días y 2000 entradas como máximo.

## Los comandos, uno por uno

Todo lo de abajo se ejecutó el 2026-09-25 con dos oficinas en la misma máquina (puertos de prueba y hives de prueba). Por eso las direcciones son `127.0.0.1` o de Docker; entre dos máquinas verás la IP de tu red o la de Tailscale.

### Buscar oficinas

```console
$ munder link buscar
munder: buscando oficinas (red local + Tailscale)…
  xeon  fee8 4593 d1ba df6e  172.18.0.1:48831    lan
```

Solo lista, no confía en nadie. Busca por broadcast en tu red, y si tienes Tailscale también pregunta a tus nodos en línea.

### Emparejar (en la máquina que pide)

```console
$ munder link emparejar 127.0.0.1:48831

  Emparejando linux → xeon  (127.0.0.1:48831)
  Huella de xeon: fee8 4593 d1ba df6e

  Código:  671 868

  En xeon corre:  munder link aceptar  y revisa que muestre este mismo código.
¿Coincide el código en la otra pantalla? [s/N] s
munder: listo de este lado. Cuando xeon acepte, prueba: munder link enviar xeon "hola"
```

Puedes emparejar por IP (`192.168.1.82`), por IP de Tailscale (`100.x.y.z`) o por el nombre que salió en `buscar`.

### Aceptar (en la otra máquina)

```console
$ munder link aceptar
  linux  dbd0 fb7e 6f51 4f77  desde 127.0.0.1:48841  código 671 868
Escribe el código que ves en la OTRA pantalla: 671868
munder: enlazada con linux (dbd0 fb7e 6f51 4f77). Ya puede delegarte trabajo.
```

Las solicitudes duran 10 minutos. Sin terminal interactiva, `aceptar` solo las lista y pide el código como argumento: `munder link aceptar 671868`.

### Delegar trabajo

```console
$ munder link enviar xeon "Audita PITON y dame un resumen" --titulo "Auditoría PITON"
munder: delegada a xeon en 15 ms → task-1790320263790-14f3f70b
  sigue: munder link tarea xeon task-1790320263790-14f3f70b

$ munder link tarea xeon task-1790320263790-14f3f70b
  Auditoría PITON  queued
  origin_ref: link-1790320261836-f1c80b
```

### Contestar (en la oficina que hizo el trabajo)

```console
$ munder link responder linux link-1790320261836-f1c80b "listo" --resultado "3 hallazgos"
munder: respuesta entregada a linux en 32 ms → task-1790320263790-14f3f70b
```

Eso deja un mensaje en el inbox del Michael que mandó la tarea, y en la consola de la que lo escribió:

```json
{"subject": "Re: link-1790320261836-f1c80b", "act": "inform",
 "body": "**Origin_ref:** `link-1790320261836-f1c80b`\n**Tarea delegada:** task-1790320263790-14f3f70b\n**Desde:** xeon\n\nlisto\n\n**Resultado:** 3 hallazgos"}
```

`--estado todo|doing|blocked|done` fija el estado si lo quieres explícito; con `--resultado` la tarea pasa a `done` sola. Si mandas una `origin_ref` que esa oficina nunca te dio: `no tengo ninguna tarea delegada con esa referencia`.

También existen `munder link mensaje <oficina> <task_id> "texto"` para agregar contexto y `munder link cancelar <oficina> <task_id> [motivo]`. Al nombre de la oficina le puedes quitar el `michael-`, y basta con cualquier parte que no sea ambigua.

### Ver el estado

```console
$ munder link
ESTA OFICINA
  linux  dbd0 fb7e 6f51 4f77
  enlace: apagado — munder link encender
  14.8 GB RAM (5.8 libres) · 12 CPUs · carga 3.51

ENLAZADAS
  ● xeon  en línea  2/3 workers libres  5.8/14.8 GB  Michael: idle  9 ms  127.0.0.1:48831
```

### Encender y apagar

`munder link encender` deja el servidor corriendo en segundo plano (puertos 47831/tcp y 47832/udp). `munder link apagar` lo detiene. `munder link servir` es lo mismo pero en primer plano, para ver qué pasa. **La máquina que va a recibir trabajo necesita el enlace encendido.** `conectar` lo enciende solo.

## Munder Remote: la oficina desde el celular

El mismo servidor del enlace sirve una app web en `/app`. Ábrela en el celular, agrégala a la pantalla de inicio y maneja esta oficina desde ahí.

```bash
munder link encender     # si no estaba encendido
munder link celular      # te da las direcciones: Tailscale primero, luego tu red de casa
```

1. En el iPhone, abre en Safari la dirección que te dio `munder link celular`, por ejemplo `http://100.x.y.z:47831/app/`.
2. Toca Compartir → **Agregar a inicio**.
3. Abre **Munder** desde el ícono y toca **Emparejar**. Tiene que ser desde el ícono: la app de inicio guarda sus llaves aparte de Safari.
4. El celular muestra un código de 6 dígitos. En la computadora, acéptalo con `munder link aceptar`, o en Configuración → Munder Link → Solicitudes. Solo si el código es el mismo.

**Qué puedes hacer desde el celular:**
- **Oficina:** estado de Michael, workers libres, tareas abiertas, RAM y CPU; el equipo; y un campo para pedirle algo a Michael.
- **Preguntas:** las preguntas (`humanQA`) de las tarjetas bloqueadas. Tu respuesta se guarda en la tarjeta y le llega a Michael, igual que desde el tablero ASK ME.
- **Tablero:** las tareas bloqueadas, en curso, por hacer y las últimas terminadas.
- **Enlace:** las otras oficinas enlazadas en vivo, y delegarles trabajo.

**Cómo está protegido:**
- **Quién guarda qué.** El celular tiene su propia llave X25519, y la computadora lo guarda en `remotes.json`, no en `peers.json`. Un celular es un control remoto, no una oficina: no recibe trabajo, y otra oficina que reciba algo delegado desde él lo ve como enviado por **esta** oficina.
- **Cómo viajan las llamadas.** Todas van cifradas y autenticadas (ChaCha20-Poly1305), con hora y protección contra repetición. El celular hace la criptografía en JavaScript puro (`remote-app/remote-crypto.js`) porque el navegador no da WebCrypto por `http://`. Los tests comprueban que da exactamente lo mismo que Node.
- **El código de emparejamiento.** El celular se compromete a su nonce (manda solo su hash) antes de ver el de la computadora. Así, nadie en medio puede probar nonces hasta que los dos códigos coincidan.
- **Revocar un celular.** Usa `munder link olvidar <celular>`, o Olvidar en Configuración → Munder Link → Celulares. Deja de funcionar en su siguiente llamada.

**Trampas:**
- **Mejor por Tailscale.** Por el Wi-Fi de casa (`http://192.168…`) las llamadas van cifradas, pero la página misma no va firmada. Alguien capaz de reescribir el tráfico de tu red podría servirle al celular una app modificada. Por Tailscale (WireGuard) eso no pasa.
- **Cada dirección cuenta como una app distinta.** Para el navegador, la IP de tu casa y la de Tailscale son sitios distintos, cada uno con su emparejamiento. Si usas Tailscale también en casa, empareja solo por Tailscale.
- **La hora.** Si el celular y la computadora difieren más de 2 minutos, las llamadas se rechazan. Deja la hora automática en los dos.
- **Firewall.** Igual que el enlace entre oficinas: 47831/tcp tiene que estar abierto en la computadora.

## Cómo leer lo que ves

| Ves | Significa | Qué hacer |
|---|---|---|
| `● … en línea` | Enlazada y contestando | Nada |
| `○ … esperando que acepte` | Tú ya confiaste, la otra todavía no | En la otra: `munder link aceptar` |
| `○ … no contesta (ECONNREFUSED)` | Su enlace está apagado | En la otra: `munder link encender` |
| `○ … sin respuesta` | No llega nada: otra red, firewall o apagada | Revisa la trampa 2 |
| `sobre fuera de tiempo` | Los relojes de las dos máquinas difieren más de 2 minutos | Ajusta la hora automática en ambas |
| `oficina no emparejada` | La otra máquina te olvidó, o reinstaló | Vuelve a emparejar |
| `esa tarea no existe o no es tuya` | Pediste una tarea que no delegaste tú | Usa el `task_id` que te dio `enviar` |
| `no tengo ninguna tarea delegada con esa referencia` | La `origin_ref` no es de esa oficina, o es vieja (pasa a los 30 días) | Copia el `origin_ref` de la línea **Tarea de origen:** de la tarea |
| `0/0 workers libres … Michael: offline` | La oficina no encuentra su `registry.json` | Abre Munder una vez en esa máquina, o revisa `MUNDER_LINK_HIVE` |

## Trampas

1. **El código es la seguridad.** Si alguien en tu red intercepta el emparejamiento, los dos códigos no coinciden. Por eso nunca se acepta sin mirar las dos pantallas. El código cubre las llaves de firma **y** las de cifrado de las dos oficinas (sas@2): antes solo cubría las de firma, y quien cambiara únicamente la llave de cifrado veía el mismo código en las dos pantallas y podía leer las llamadas.
2. **Firewall.** Si `buscar` no encuentra la otra máquina en la misma red, abre 47831/tcp y 47832/udp en la que recibe. Con Tailscale el descubrimiento no usa broadcast: pregunta directo a cada nodo en línea por el 47831.
3. **El broadcast se pierde, y eso es normal.** Por eso `buscar` no lanza un solo sondeo: barre la red varias veces dentro del mismo segundo y medio (nunca más de 4 rondas ni más de 32 direcciones). Si aun así no aparece, casi siempre es el firewall (trampa 2), no la red.
4. **Tailscale tiene que estar en línea en las dos.** Hoy (2026-09-25) `tailscale status` mostraba el nodo Windows `danny` «offline, last seen 4d ago»: así no aparece en `buscar`.
5. **Olvidar es de un solo lado.** `munder link olvidar xeon` quita tu confianza en xeon, pero xeon te sigue conociendo hasta que ella también te olvide.
6. **Las llaves viven en `~/.local/state/munder/link/`** (en Windows, bajo tu carpeta de usuario), con permisos privados. Ahí también queda `origins.json`, el índice de `origin_ref` que permite contestar y repetir sin duplicar. Si lo borras, puedes seguir usando el enlace, pero las respuestas antiguas dejan de enrutar.
7. **Emparejar entre versiones.** Una máquina con sas@2 y otra sin él calculan códigos distintos: actualiza las dos antes de emparejar. Los enlaces que ya existen siguen funcionando.
8. **Pedir emparejamiento tiene límite.** `/pair` acepta 5 solicitudes por dirección cada 10 minutos, y una solicitud pendiente no se puede reemplazar con otras llaves. El descubrimiento UDP solo contesta a IPs privadas, locales o de Tailscale.
9. **Las tareas que llegan son externas.** Se marcan `link.external` y el mensaje a Michael le pide confirmación humana antes de enviar, publicar, pagar o borrar algo fuera de la máquina. Es una instrucción en el prompt, no un permiso aplicado: la guardia del hive sí es real, pero solo cubre las herramientas de archivos.

## Qué ve cada quien

`GET /link/v1/hello` es la única ruta sin cifrar, y solo dice cosas de la **máquina** (RAM, CPUs, carga, plataforma) más su nombre y sus llaves públicas. Los números de la **oficina** —workers libres, estado de Michael, tareas abiertas— solo salen por la llamada firmada `status`, y las tareas solo las ve quien las delegó.

## NO PROBADO

- Entre dos máquinas físicas distintas: todo lo de arriba se probó con dos oficinas en la misma computadora (también por su IP de Tailscale, `100.115.163.4`).
- En Windows: la librería solo usa módulos de Node y debería funcionar, pero no se ha corrido allí. En Windows sería `node tools\munder\munder link conectar`.
- `responder` entre dos máquinas distintas: el flujo completo se probó con las dos oficinas en la misma computadora.
- Munder Remote en un iPhone de verdad: se probó en Chromium con el perfil de iPhone 13, en claro y oscuro, con la misma criptografía que usa Safari. Falta confirmar en Safari que «Agregar a inicio» conserva el emparejamiento después de cerrar la app.
- Delegar automáticamente según la capacidad (el «router de oficinas»): el estado ya trae RAM, CPUs, carga y workers libres para decidirlo, pero la política todavía no existe.
