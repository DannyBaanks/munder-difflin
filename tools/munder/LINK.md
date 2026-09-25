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

## La regla de oro

**Solo acepta un código que estés viendo en la otra pantalla.** Emparejar es darle a esa máquina permiso de mandarle trabajo a tu Michael, y tu Michael ejecuta agentes en tu computadora. Si llega una solicitud que no esperabas, o el código no coincide, no aceptes nada.

## Cómo funciona (en corto)

```text
Linux                                   Xeon
Michael A ──▶ munder link enviar ──▶ servidor del enlace ──▶ inbox de Michael B
   ▲            (firmado + cifrado)        (puerto 47831)          │
   └──────────── munder link tarea ◀──── estado de la tarea ◀──────┘
```

- **Michael ↔ Michael.** La otra máquina nunca toca tu hive ni tus terminales. Deja la tarea en el inbox de tu Michael, igual que el Office Bridge, y tu Michael decide cómo hacerla.
- **Descubrir es automático; confiar, no.** La red local no se considera segura por sí sola.
- **Cada llamada va firmada (Ed25519) y cifrada (X25519 + AES-256-GCM)**, también por Tailscale. Un sobre repetido, alterado o viejo se rechaza.
- **Una oficina solo ve las tareas que ella misma delegó**, no el resto de tu tablero.
- **Queda recibo en los dos lados:** `link_delegated` en el `log.jsonl` del hive que envía, `link_received` en el que recibe, y `~/.local/state/munder/link/receipts.jsonl`.

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
```

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

## Trampas

1. **El código es la seguridad.** Si alguien en tu red intercepta el emparejamiento, los dos códigos no coinciden. Por eso nunca se acepta sin mirar las dos pantallas. El código cubre las llaves de firma **y** las de cifrado de las dos oficinas (sas@2): antes solo cubría las de firma, y quien cambiara únicamente la llave de cifrado veía el mismo código en las dos pantallas y podía leer las llamadas.
2. **Firewall.** Si `buscar` no encuentra la otra máquina en la misma red, abre 47831/tcp y 47832/udp en la que recibe. Con Tailscale el descubrimiento no usa broadcast: pregunta directo a cada nodo en línea por el 47831.
3. **Tailscale tiene que estar en línea en las dos.** Hoy (2026-09-25) `tailscale status` mostraba el nodo Windows `danny` «offline, last seen 4d ago»: así no aparece en `buscar`.
4. **Olvidar es de un solo lado.** `munder link olvidar xeon` quita tu confianza en xeon, pero xeon te sigue conociendo hasta que ella también te olvide.
5. **Las llaves viven en `~/.local/state/munder/link/`** (en Windows, bajo tu carpeta de usuario), con permisos privados. Si las borras, esta oficina es «otra» para todas y hay que emparejar de nuevo.
6. **Emparejar entre versiones.** Una máquina con sas@2 y otra sin él calculan códigos distintos: actualiza las dos antes de emparejar. Los enlaces que ya existen siguen funcionando.
7. **Qué ve quien no está emparejado.** `hello` y el descubrimiento solo dicen nombre, huella y versión (ya no la RAM ni la carga). El descubrimiento UDP solo contesta a IPs privadas, locales o de Tailscale. `/pair` acepta 5 solicitudes por dirección cada 10 minutos, y una solicitud pendiente no se puede reemplazar con otras llaves.
8. **Las tareas que llegan son externas.** Se marcan `link.external` y el mensaje a Michael le pide confirmación humana antes de enviar, publicar, pagar o borrar algo fuera de la máquina. Es una instrucción en el prompt, no un permiso aplicado: la guardia del hive sí es real, pero solo cubre las herramientas de archivos.

## NO PROBADO

- Entre dos máquinas físicas distintas: todo lo de arriba se probó con dos oficinas en la misma computadora (también por su IP de Tailscale, `100.115.163.4`).
- En Windows: la librería solo usa módulos de Node y debería funcionar, pero no se ha corrido allí. En Windows sería `node tools\munder\munder link conectar`.
- Delegar automáticamente según la capacidad (el «router de oficinas»): el estado ya trae RAM, CPUs, carga y workers libres para decidirlo, pero la política todavía no existe.
