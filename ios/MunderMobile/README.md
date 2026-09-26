# Munder Mobile para iPhone (nativa)

La oficina en tu iPhone como app nativa (SwiftUI), en el mismo pixel art de Munder. Es el mismo protocolo que la PWA de `/app` (`munder-remote@1`), pero:

- **Las llaves viven en el Keychain de iOS,** no en el almacenamiento del navegador.
- **Una sola app, en casa y fuera.** Emparejas una vez y la oficina le pasa al celular sus direcciones (la de tu red y la de Tailscale). Cada llamada prueba primero la que contestó la última vez: en casa entra por la red local sin Tailscale, y fuera entra por Tailscale.

**Cuesta $0:** el CI compila un `.ipa` sin firmar en un runner de macOS de GitHub (gratis porque el repo es público), y lo instalas con tu Apple ID gratuito.

## 1. Descarga el `.ipa`

1. Entra a **Actions → iOS (Munder Mobile)** y abre la última corrida en verde de `main`.
2. En **Artifacts** descarga **`MunderMobile-unsigned-ipa`**. Es un `.zip`; adentro está `MunderMobile-unsigned.ipa`.

## 2. Instálala con tu Apple ID gratis

Cualquiera de estas tres funciona. Todas firman el `.ipa` con tu Apple ID:

| Herramienta | Desde | Nota |
|---|---|---|
| **iloader** | Windows o Linux | La misma que usas con OpencodeNative. |
| **SideStore** | el propio iPhone | Renueva la firma sola, sin computadora. |
| **AltStore** | Windows o Mac | Renueva mientras AltServer esté abierto en la compu. |

**Límites de la cuenta gratis de Apple:**
- **Caduca a los 7 días.** Vuelve a firmar, o deja que SideStore o AltStore la renueven.
- **Máximo 3 apps firmadas a la vez.**

En el iPhone: **Ajustes → General → VPN y administración de dispositivos → confía en tu Apple ID**. En iOS 16 o más nuevo, activa también **Modo de desarrollador** (Ajustes → Privacidad y seguridad).

## 3. Empareja

En la computadora:

```bash
munder link encender
munder link celular      # te dice las direcciones: red de casa y Tailscale
```

En el iPhone:

1. Abre **Munder** y escribe la dirección, por ejemplo `192.168.1.64` (el puerto 47831 va solo).
2. Toca **Emparejar**. La primera vez iOS pregunta si Munder puede usar tu **red local**: di que sí.
3. El celular muestra un código de 6 dígitos. En la computadora, acéptalo solo si es el mismo:
   - desde la app: **Configuración → Munder Link → Solicitudes → Aceptar**;
   - o desde la terminal: `munder link aceptar 123456`.

**Listo.** La app ya se sabe también la dirección de Tailscale de tu oficina. Fuera de casa solo prende Tailscale en el iPhone. En **Enlace → Este celular** ves las direcciones, cuál contestó la última y puedes agregar otra.

## Qué puedes hacer

- **Oficina:** estado de Michael, workers libres, RAM y CPU, pedirle algo a Michael, y el equipo con sus retratos.
- **Preguntas:** contestas las `humanQA` de las tarjetas bloqueadas. La respuesta queda en la tarjeta y le llega a Michael.
- **Tablero:** tareas bloqueadas, en curso, por hacer y hechas.
- **Enlace:** tus otras oficinas en vivo, delegarles trabajo, y las direcciones de este celular.

## Si algo no jala

| Pasa esto | Prueba esto |
|---|---|
| «No alcanzo la oficina» en casa | `munder link encender` en la compu. Revisa que el firewall deje pasar el puerto 47831/tcp. |
| En casa funciona y fuera no | Prende Tailscale en el iPhone. En **Enlace → Este celular** revisa que haya una dirección `tailscale`; si no la hay, agrégala a mano. |
| La red local nunca contesta | **Ajustes → Privacidad y seguridad → Red local → Munder** tiene que estar encendido. |
| «La hora no coincide» | Activa la hora automática en el iPhone y en la compu. |
| «Ya no reconoce este celular» | Lo olvidaron en la compu. En **Enlace**, toca «Olvidar en este celular» y vuelve a emparejar. |
| La app no abre después de unos días | Caducó la firma de 7 días: vuelve a firmarla con tu herramienta. |

## Panel: manejar la compu desde el celular

La app puede ser también el Panel: abrir y cerrar Munder, prender y apagar el enlace, encender GPT, apagar y revivir la oficina. Los botones son los mismos y ejecutan lo mismo que los de escritorio; lo que cambia es quién los puede pulsar.

**Emparejar NO da ese poder.** El código de 6 dígitos da acceso a la **oficina** (el tablero, las preguntas, la gente). Para tocar la **computadora** hay que concederlo en la máquina:

```bash
munder link panel <celular>          # concede; acepta nombre o fragmento del id
munder link panel <celular> --quitar # quita
```

O desde el Panel de escritorio: en **Celulares**, el botón de permisos de cada uno.

**Si ves «este celular puede manejar la oficina, no la computadora»**, es la puerta funcionando, no un error. Pídele a Michael que lo conceda, o concédelo tú en la compu.

Dos botones **no** se pueden desde el celular, por diseño: **shortcut.install** (escribe un archivo en el escritorio que el celular no ve) y el que concede el permiso mismo (un teléfono no se amplía su propia autoridad).

> **Mide la distancia:** apagar y prender tu Munder desde el celular es real, no un simulacro. Concédelo solo a celulares que controlas.

## Para desarrolladores

- **El Panel como estrato:** `panel.state` y `panel.action` viajan por el mismo sello `munder-remote@1` y ejecutan los mismos motores que el Panel de escritorio (`tools/munder/lib-panel.cjs` `ACTIONS`). La app no reimplementa la oficina: la pide. La clase de autoridad de cada op está en `OP_AUTHORITY` (`tools/munder/lib-remote.cjs`) y es **fail-closed**: un op no declarado se trata como `machine`.

- **Código:**
  - `Sources/` es el núcleo sin UI: el protocolo con CryptoKit (X25519, HKDF-SHA256, ChaCha20-Poly1305), el cliente que prueba varias direcciones, el Keychain y el estado.
  - `App/` son las pantallas en SwiftUI.
- **Generado por `scripts/make-assets.cjs`** con el mismo código de la oficina; el CI falla si algo quedó viejo:
  - `Media/Cast/*.png` (retratos, desde `avatar-engine.cjs`);
  - el ícono;
  - `Tests/vectors.json` y `Tests/overview.json`;
  - `Media/Demo/*`.

  Para regenerarlos: `node ios/MunderMobile/scripts/make-assets.cjs`.
- **Tests:** comprueban en el simulador que el Swift produce **los mismos bytes** que la oficina: la llave de sesión, el código SAS, los sobres sellados en las dos direcciones y la decodificación de un `overview` real.
- **Modo demo:** `-MunderDemo -MunderTab N` abre la oficina de ejemplo sin red. El CI lo usa para las capturas del simulador.
- **Proyecto:** `project.yml` es de XcodeGen, siguiendo el mismo patrón que DannyBaanks/OpencodeNative.
