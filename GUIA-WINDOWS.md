# Munder Difflin en Windows — guía del mantenedor (carril Windows)

## 1. El comando para el que viniste

```powershell
munder start
```

## 2. La regla de oro

**Una sola instancia por userData.** El userData (`%APPDATA%\munder-difflin`) es
compartido entre el checkout y los builds empaquetados (portable/setup). Si hay
una corriendo, `munder start` **no** lanza otra: avisa y listo. Para dos sesiones
en paralelo, cada una con su userData:

```powershell
munder start --user-data-dir "$env:APPDATA\munder-difflin-harness2"
```

No pongas dos sesiones a trabajar sobre los mismos repos a la vez.

## 3. Comandos, uno a uno, con su salida real

Todo lo de abajo se ejecutó en esta máquina el 2026-09-25 (Windows nativo,
PowerShell 5.1, Node v24.18.0, build `0.5.2-ISyCo.1` compilado del source).

### 3.1 Setup completo (checkout → compilado + comando `munder` en PATH)

```powershell
cd "C:\Development\ISyCo Git\munder-difflin"
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Salida real (extracto; el build de vite es larguísimo):

```
install: 1/8 prereqs
install: node v24.18.0 OK
install: MSVC OK: C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64\cl.exe
install: libs Spectre OK
install: 2/8 npm install --ignore-scripts (puede tardar)
added 870 packages, and audited 871 packages in 1m
install: 3/8 descarga del binario Electron
install: 4/8 electron-rebuild -f (node-pty + better-sqlite3; varios minutos)
✔ Rebuild Complete
install: 5/8 postinstall del repo
[patch-node-pty-conpty] guarded conpty_console_list_agent against AttachConsole crash
install: 6/8 npm run build
✓ built in 49.50s
install: 7/8 PATH de usuario
install: ya estaba en el PATH
install: 8/8 munder check
munder: OK
munder: root: C:\Development\ISyCo Git\munder-difflin
munder: electron: C:\Development\ISyCo Git\munder-difflin\node_modules\electron\dist\electron.exe ()
munder: main: C:\Development\ISyCo Git\munder-difflin\out\main\index.js
install: listo. Arranca con: munder start
```

El PATH es de **usuario** y aplica en terminales **nuevas**. En la terminal
actual puede que `munder` no resuelva todavía: usa
`& "C:\ruta\del\checkout\munder.cmd" start` o abre otra terminal.

### 3.2 Arrancar

```powershell
munder start
```

```
munder: lanzando despegada (cerrar la terminal no la mata)
munder: en marcha (pid main: 26848)
munder: log del lanzador: C:\Users\progr\AppData\Local\munder-difflin\logs\run-20260925T024253.log
munder: parar: munder stop
```

### 3.3 Estado

```powershell
munder status
```

Encendiendo (checkout):

```
munder: en marcha (4 procesos electron)
munder:   pid 8648  electron.exe
munder:   pid 15352  electron.exe
munder:   pid 23568  electron.exe
munder:   pid 26848  electron.exe
munder:   main pid: 26848
```

Encendiendo con el portable del release abierto:

```
munder: en marcha (5 procesos electron)
munder:   pid 24484  Munder Difflin.exe
munder:   pid 24560  Munder-Difflin-0.5.2-ISyCo.1-win-x64-portable.exe
munder:   pid 26376  Munder Difflin.exe
munder:   pid 27788  Munder Difflin.exe
munder:   pid 28052  Munder Difflin.exe
munder:   main pid: 24560
```

Parado:

```
munder: detenido
```

### 3.4 Parar (también baja el portable/setup)

```powershell
munder stop
```

```
munder: detenidos 5 procesos
munder: detenido
```

Cierra las ventanas primero (amable) y a los ~5 s fuerza el resto. Devuelve
código 1 si algún proceso sobrevive, con los pids.

### 3.5 Reiniciar

```powershell
munder restart
```

### 3.6 Logs

```powershell
munder logs
munder logs -n 100
```

`run-*.log` (del lanzador: pid, tiempos, exit) en
`%LOCALAPPDATA%\munder-difflin\logs\`. Los logs propios de la app:
`%APPDATA%\munder-difflin\updater.log`.

## 4. Cómo leer la salida

| Lo que ves | Qué significa | Qué hacer |
|---|---|---|
| `munder: en marcha (N procesos electron)` | la app está viva (N = main + GPU + renderers + red) | nada |
| `munder: detenido` | no hay procesos | `munder start` |
| `ya hay una instancia corriendo (singleton compartido)` | otro build (p. ej. el portable) tiene el userData | usa esa, o `munder stop` y arranca esta |
| `otra instancia ya esta corriendo (mismo userData compartido)` | lo mismo, detectado en el arranque (la app cerró sola con exit 0) | idem |
| `la app termino de forma inesperada (exit N)` con N≠0 | crash real | `munder logs`, y `%APPDATA%\munder-difflin\updater.log` |
| `quedan N procesos (pids: ...)` en `stop` | algo sobrevivió | `taskkill /PID <pid> /F` a mano, luego `munder status` |
| `Electron no encontrado` / `Build de Munder no encontrado` | falta `npm install` / `npm run build` | `.\install.ps1` otra vez |
| `munder: ERROR: electron-rebuild fallo` en install | falta MSVC o libs Spectre | ver trampas 5.2/5.3 |
| `exit 0` + `native check failed: ... latest.yml ... 404` en `updater.log` | el release no subió `latest.yml`; **solo** el auto-updater, la app arranca bien | avisar al carril Linux (bug conocido) |

## 5. Trampas (las que cuestan 20 minutos)

### 5.1 `npm install` a pelo falla con Node 24

```
error ... MSBuild.exe failed with exit code: 1
```

`better-sqlite3` intenta compilar contra el Node del sistema (V8 demasiado
nuevo). Por eso `install.ps1` usa `npm install --ignore-scripts` y luego
`npx electron-rebuild -f`, que compila solo lo nativo contra el ABI de
**Electron**. Si instalaste a mano: `npm install` normal, a secas, no funciona.

### 5.2 `MSB8040: requiere las bibliotecas con mitigaciones de Spectre`

El componente de Spectre es **versionado** y el ID de `winget`/docs no siempre
existe. Se agrega con el instalador y el ID exacto de tu MSVC:

```powershell
& "$env:TEMP\vs_BuildTools.exe" modify --installPath "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools" --wait --quiet --norestart --add Microsoft.VisualStudio.Component.VC.14.44.17.14.x86.x64.Spectre
```

Para descubrir el ID de tu versión (salida real de esta máquina):

```powershell
py -c "import json,glob; d=json.load(open(glob.glob(r'C:\ProgramData\Microsoft\VisualStudio\Packages\_Channels\*\catalog.json')[0],encoding='utf-8')); print([p['id'] for p in d['packages'] if p.get('type')=='Component' and 'spectre' in p['id'].lower() and 'x86.x64' in p['id']])"
```

```
['Microsoft.VisualStudio.Component.VC.14.44.17.14.x86.x64.Spectre']
```

### 5.3 El bootstrapper de `winget` está desactualizado (exit 5008)

```
Installation failed with a custom installer error. ... exit code: 5008
```

El bootstrapper que trae winget (3.14) es anterior al mínimo (4.10) y se niega
a instalar. Descarga el actual de aka.ms y lánzalo tú:

```powershell
curl.exe -L -o "$env:TEMP\vs_BuildTools.exe" https://aka.ms/vs/17/release/vs_BuildTools.exe
& "$env:TEMP\vs_BuildTools.exe" --wait --quiet --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended
```

O `.\install.ps1 -Toolchain` (lo hace desatendido).

### 5.4 La app muere a los 2-6 s con `exit 1` si la lanzas con `Start-Process`

`Start-Process` (con o sin `-RedirectStandardOutput`) deja al hijo con handles
de **entrada/salida atados al shell que lanza**. Al salir ese shell, el próximo
`console.*` de la app revienta y el proceso muere con `exit 1` — intermitente,
medido 2/3 y 2/5 arranques. Con `.NET ProcessStartInfo` + `UseShellExecute=false`
+ `CreateNoWindow=true` + **stdio nulo**: 6/6 y 3/3 arranques sanos. `munder.ps1`
usa ese camino; no lo cambies por `Start-Process`.

### 5.5 `munder stop` no paraba el portable (arreglado)

El launcher filtraba solo `electron.exe`, y el portable corre como
`Munder Difflin.exe` / `Munder-Difflin-<versión>.exe`. Ahora coincide por nombre
de producto y los baja también.

### 5.6 `git clone` se corta a mitad (curl 56 / early EOF)

Clone largo + red intermitente: reintenta, o
`git clone --branch v0.5.2-ISyCo.1 --depth 1` (una sola rama, sin historia).
Aviso: el tag apunta a un tag-object que no es commit, git lo resuelve solo
(`Note: switching to ...`).

### 5.7 `npm audit` con 22 vulnerabilidades

Vienen de las dependencias del upstream (glob@7, multer 1.x, etc.). No las
arregla este carril: son del carril compartido (`package.json`), y
`npm audit fix --force` rompería el build. Se reporta, no se toca.

### 5.8 Doble instancia: el aviso correcto es exit 0

Si el portable ya tiene el userData, el proceso del checkout cierra limpio con
`exit 0` y el singleton se queda. Antes eso se reportaba como "la app terminó de
forma inesperada"; ahora `start` lo detecta por los procesos vivos y lo dice
como lo que es.

## 6. Verificación del build del release (sin compilar)

Los assets del USB/release se pueden verificar y arrancar sin toolchain:

```powershell
certutil -hashfile .\Munder-Difflin-0.5.2-ISyCo.1-win-x64-portable.exe SHA256
```

Salida real (coincide con `SHA256SUMS.txt` del release y del USB):

```
SHA256 hash of .\Munder-Difflin-0.5.2-ISyCo.1-win-x64-portable.exe:
950c9a7cf52b440f4b4e386a70ecd75a8ec5d559ac7d9007e0bf168ae9c07c18
```

Portable = **probado en máquina real** (arrancó, `last-run-version` =
`0.5.2-ISyCo.1`, updater.log escrito). Setup = no ejecutado.
Munder Link entre 2 máquinas = NO PROBADO.
