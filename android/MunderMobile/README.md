# Munder Mobile para Android (nativa)

La oficina en tu Android como app nativa (Kotlin + Compose), con la misma cara
pixel-art que el iPhone. Es el mismo protocolo que la PWA de `/app`
(`munder-remote@1`) y que la app de iOS, por el mismo cable:

- **El móvil es solo un sustrato.** Android y iOS pasan por los mismos procesos:
  mismos ops (`hello overview peers answer ask delegate panel.state panel.action`),
  misma autoridad (`OP_AUTHORITY` en `tools/munder/lib-remote.cjs`, fail-closed),
  mismos botones bloqueados (`PANEL_OFF` = `shortcut.install link.phoneAuthority`),
  mismos bytes cripto (X25519, HKDF-SHA256, ChaCha20-Poly1305) y mismos
  `vectors.json`.
- **Las llaves viven en el Keystore cifrado** (`SecureStore.kt`), no en claro.
  Es el Keychain de iOS en Android.
- **Una sola app, en casa y fuera.** Emparejas una vez y la oficina le pasa al
  celular sus direcciones (la de tu red y la de Tailscale). Igual que iOS:
  cada llamada prueba primero la que contestó la última vez.

**Cuesta $0:** el CI compila un APK debug en un runner ubuntu de GitHub
(gratis porque el repo es público). Lo instalas directo, sin tienda.

## 1. Descarga el APK

1. Entra a **Actions → Android (Munder Mobile)** y abre la última corrida en verde de `main`.
2. En **Artifacts** descarga **`MunderMobile-debug-apk`**. Adentro está el `.apk`.
3. En el Android, permite **instalar de fuentes desconocidas** y ábrelo.

## 2. Empareja

En la computadora:

```bash
munder link encender
munder link celular      # te dice las direcciones: red de casa y Tailscale
```

En el Android:

1. Abre **Munder** y escribe la dirección, por ejemplo `192.168.1.64` (el puerto 47831 va solo).
2. Toca **Emparejar**.
3. El celular muestra un código de 6 dígitos. En la computadora, acéptalo solo si es el mismo:
   - desde la app: **Configuración → Munder Link → Solicitudes → Aceptar**;
   - o desde la terminal: `munder link aceptar 123456`.

**Listo.** Igual que iOS: la app ya se sabe también la dirección de Tailscale
de tu oficina. Fuera de casa solo prende Tailscale en el Android. En
**Enlace → Este celular** ves las direcciones, cuál contestó la última y
puedes agregar otra.

## Qué puedes hacer

Lo mismo que el iPhone, en el mismo orden (las 5 pestañas son las mismas):

- **Oficina:** estado de Michael, workers libres, RAM y CPU, pedirle algo a Michael, y el equipo con sus retratos.
- **Preguntas:** contestas las `humanQA` de las tarjetas bloqueadas.
- **Tablero:** tareas bloqueadas, en curso, por hacer y hechas.
- **Enlace:** tus otras oficinas en vivo, delegarles trabajo, y las direcciones de este celular.
- **Panel:** manejar la compu desde el celular (abrir/cerrar Munder, enlace, GPT, revividor). Los botones son los mismos del escritorio y ejecutan lo mismo.

## Si algo no jala

| Pasa esto | Prueba esto |
|---|---|
| «No alcanzo la oficina» en casa | `munder link encender` en la compu. Revisa que el firewall deje pasar el puerto 47831/tcp. |
| En casa funciona y fuera no | Prende Tailscale en el Android. En **Enlace → Este celular** revisa que haya una dirección `tailscale`; si no la hay, agrégala a mano. |
| «La hora no coincide» | Activa la hora automática en el Android y en la compu. |
| «Ya no reconoce este celular» | Lo olvidaron en la compu. En **Enlace**, toca «Olvidar en este celular» y vuelve a emparejar. |

## Panel: la misma puerta que en iOS

**Emparejar NO da ese poder.** El código de 6 dígitos da acceso a la
**oficina**. Para tocar la **computadora** hay que concederlo en la máquina:

```bash
munder link panel <celular>          # concede; acepta nombre o fragmento del id
munder link panel <celular> --quitar # quita
```

Dos botones **no** se pueden desde el celular, por diseño:
**shortcut.install** y el que concede el permiso mismo.

## Para desarrolladores

- **El móvil es sustrato:** `panel.state` y `panel.action` viajan por el mismo
  sello `munder-remote@1` y ejecutan los mismos motores (`tools/munder/lib-panel.cjs`).
  La app no reimplementa la oficina: la pide.
- **Código (espejo de `ios/MunderMobile/`):**
  - `RemoteCrypto.kt` = `Sources/RemoteCrypto.swift` (BouncyCastle en vez de CryptoKit).
  - `Models.kt` = `Sources/Models.swift` (mismos `@SerialName` snake_case).
  - `RemoteClient.kt` + `pairOffice` = `Sources/RemoteClient.swift` (OkHttp, timeouts 3.5 s / 8 s).
  - `SecureStore.kt` = `Sources/Keychain.swift` (EncryptedSharedPreferences + MasterKey).
  - `OfficeStore.kt` = `Sources/OfficeStore.swift` (mismos ops, mismos toasts, mismo `panelRemoteBlocked`).
  - `AppLock.kt` = `Sources/AppLock.swift` (BiometricPrompt, relock 60 s, ventana 30 s).
  - `ui/Pixel.kt` = `App/Pixel.swift` (mismos tokens `--cth`, Press Start 2P, retratos, iconos 12×12).
  - `ui/Screens.kt` = `App/Screens.swift` (mismas 5 pestañas, mismos textos).
  - `MainActivity.kt` = `App/MunderMobileApp.swift` (mismo Root, mismo demo por extras).
- **Assets copiados, no redibujados** (`scripts/check-assets.cjs` lo exige):
  `assets/Media/Cast/*.png`, `assets/Media/Demo/*`, la fuente y
  `src/test/resources/vectors.json` son byte por byte los de iOS.
- **Tests:** el JUnit reproduce los **mismos bytes** que la oficina
  (`RemoteCryptoTest` con `vectors.json`) y que `PANEL_OFF` no divergió
  (`PanelBlockedTest`). El CI además corre `make-assets --check` de iOS primero.
- **Demo:** `adb shell am start -n mx.isyco.munder.mobile.debug/.MainActivity --ez MunderDemo true --ei MunderTab 2`
  abre el tablero de ejemplo sin red (N = 0..4, igual que `-MunderTab N` en iOS).
- **Capturas:** el CI (`screenshots`, espejo del de ios.yml) instala el APK en
  un emulador Pixel 6 y fotografía la oficina demo sin red: `pair-light` más
  `office/questions/board/link/panel/locked` en light y dark (13 PNG en el
  artifact `munder-android-screenshots`). Local, con un emulador corriendo:
  `./scripts/shots.sh`.

Para compilar local:

```bash
cd android/MunderMobile
node scripts/check-assets.cjs
./gradlew :app:assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```
