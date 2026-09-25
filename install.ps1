# install.ps1 — setup de Munder Difflin en Windows (carril Windows).
#
# Uso (desde la raiz del checkout):
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Toolchain   # instala VS Build Tools desatendido (GBs)
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -SkipBuild   # solo deps + nativo, sin npm run build
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -NoPath      # no toca el PATH de usuario
#
# Hace, en orden (receta verificada 2026-09-25 en Windows nativo):
#   1. Prereqs: node>=18, npm, py (node-gyp), git, MSVC.
#   2. npm install --ignore-scripts (el postinstall compila better-sqlite3
#      contra el Node del sistema y falla con Node 24+; se recompila luego
#      solo contra el ABI de Electron).
#   3. Descarga del binario Electron (node node_modules/electron/install.js).
#   4. npx electron-rebuild -f (node-pty + better-sqlite3 para Electron).
#   5. tools/ensure-pty-perms.cjs + tools/patch-node-pty-conpty.cjs.
#   6. npm run build (out/main, out/preload, out/renderer).
#   7. Registra esta carpeta en el PATH de usuario -> comando `munder`.
#   8. munder check.
#
# El toolchain C++ NO se instala solo: son GBs. Sin -Toolchain se verifica
# y, si falta, se imprime el comando exacto. Ver GUIA-WINDOWS.md.

param(
    [switch]$Toolchain,
    [switch]$SkipBuild,
    [switch]$NoPath
)

$ErrorActionPreference = 'Stop'
$APP_ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $APP_ROOT

function Say($m) { Write-Output "install: $m" }
function Fail($m) { Write-Output "install: ERROR: $m"; exit 1 }

function Get-VsWhere { Get-Command vswhere.exe -ErrorAction SilentlyContinue }
function Find-Cl {
    $c = Get-ChildItem 'C:\Program Files (x86)\Microsoft Visual Studio\*\*\VC\Tools\MSVC\*\bin\Hostx64\x64\cl.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    return $c
}
function Find-MsvcLibSpectre {
    $d = Get-ChildItem 'C:\Program Files (x86)\Microsoft Visual Studio\*\*\VC\Tools\MSVC\*\lib\spectre' -ErrorAction SilentlyContinue | Select-Object -First 1
    return $d
}

# --- 1. prereqs -------------------------------------------------------------
Say "1/8 prereqs"
$nodeOk = $false
try {
    $nv = (node --version 2>$null).Trim()
    if ($nv -match '^v(\d+)\.') {
        $major = [int]$Matches[1]
        if ($major -ge 18) { $nodeOk = $true; Say "node $nv OK" }
        else { Fail "node $nv < 18 (https://nodejs.org)" }
    }
} catch {}
if (-not $nodeOk) { Fail "falta node >= 18 (https://nodejs.org)" }
try { npm --version 2>$null | Out-Null } catch { Fail "falta npm (viene con node)" }
try { py -c 'import sys' 2>$null } catch { Fail "falta el launcher py / Python 3 (lo usa node-gyp)" }
try { git --version 2>$null | Out-Null } catch { Fail "falta git" }

$cl = Find-Cl
if (-not $cl) {
    Say "MSVC no encontrado."
    if (-not $Toolchain) {
        Say "Instala VS Build Tools 2022 (solo workload C++, sin VS completo):"
        Say '  1. curl.exe -L -o $env:TEMP\vs_BuildTools.exe https://aka.ms/vs/17/release/vs_BuildTools.exe'
        Say '     (OJO: el bootstrapper de winget esta desactualizado y falla con exit 5008;'
        Say '      descarga el actual de aka.ms)'
        Say '  2. & "$env:TEMP\vs_BuildTools.exe" --wait --quiet --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
        Say "O re-ejecuta este script con -Toolchain para hacerlo desatendido."
        Fail "sin compilador C++ no se puede compilar node-pty/better-sqlite3"
    }
    Say "instalando VS Build Tools 2022 desatendido (tarda; varios GB)..."
    curl.exe -L -o "$env:TEMP\vs_BuildTools.exe" 'https://aka.ms/vs/17/release/vs_BuildTools.exe' -sS
    & "$env:TEMP\vs_BuildTools.exe" --wait --quiet --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3010) { Fail "el instalador de Build Tools devolvio $LASTEXITCODE" }
    $cl = Find-Cl
    if (-not $cl) { Fail "tras instalar Build Tools no aparece cl.exe; reinicia la sesion y reintenta" }
}
Say "MSVC OK: $($cl.FullName)"

# node-pty exige las libs con mitigacion Spectre (si no: error MSB8040).
if (-not (Find-MsvcLibSpectre)) {
    Say "AVISO: faltan las libs Spectre de MSVC (node-pty falla con MSB8040)."
    Say "Agregalas con el instalador (componente versionado, p. ej.):"
    Say '  & "$env:TEMP\vs_BuildTools.exe" modify --installPath "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools" --wait --quiet --norestart --add Microsoft.VisualStudio.Component.VC.14.44.17.14.x86.x64.Spectre'
    Say "El ID exacto depende de tu MSVC; buscalo en el catalogo del canal:"
    Say '  py -c "import json,glob; d=json.load(open(glob.glob(r''C:\ProgramData\Microsoft\VisualStudio\Packages\_Channels\*\catalog.json'')[0],encoding=''utf-8'')); print([p[''id''] for p in d[''packages''] if p.get(''type'')==''Component'' and ''spectre'' in p[''id''].lower() and ''x86.x64'' in p[''id'']])"'
} else {
    Say "libs Spectre OK"
}

# --- 2. deps (sin scripts: el build nativo va contra Electron, no contra tu node)
Say "2/8 npm install --ignore-scripts (puede tardar)"
npm install --ignore-scripts
if ($LASTEXITCODE -ne 0) { Fail "npm install fallo" }

# --- 3. binario Electron ------------------------------------------------------
Say "3/8 descarga del binario Electron"
node node_modules/electron/install.js
if (-not (Test-Path -LiteralPath 'node_modules\electron\dist\electron.exe')) { Fail "no quedo electron.exe" }

# --- 4. rebuild nativo contra el ABI de Electron ------------------------------
Say "4/8 electron-rebuild -f (node-pty + better-sqlite3; varios minutos)"
npx electron-rebuild -f
if ($LASTEXITCODE -ne 0) {
    Say "electron-rebuild fallo. Causas vistas:"
    Say " - MSB8040 = faltan libs Spectre (ver aviso arriba)."
    Say " - MSBuild no encontrado = sesion sin entorno VS (reabre la terminal)."
    Fail "electron-rebuild fallo"
}

# --- 5. postinstall del repo --------------------------------------------------
Say "5/8 postinstall del repo"
node tools/ensure-pty-perms.cjs
node tools/patch-node-pty-conpty.cjs

# --- 6. build -----------------------------------------------------------------
if (-not $SkipBuild) {
    Say "6/8 npm run build"
    npm run build
    if ($LASTEXITCODE -ne 0) { Fail "npm run build fallo" }
} else {
    Say "6/8 build omitido (-SkipBuild)"
}

# --- 7. PATH de usuario -> comando `munder` -----------------------------------
if (-not $NoPath) {
    Say "7/8 PATH de usuario"
    $cur = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($cur -split ';') -notcontains $APP_ROOT) {
        [Environment]::SetEnvironmentVariable('Path', ($cur.TrimEnd(';') + ';' + $APP_ROOT), 'User')
        Say "agregado al PATH: $APP_ROOT (aplica en terminales NUEVAS)"
    } else {
        Say "ya estaba en el PATH"
    }
} else {
    Say "7/8 PATH omitido (-NoPath)"
}

# --- 8. check -----------------------------------------------------------------
Say "8/8 munder check"
& "$APP_ROOT\munder.cmd" check
Say "listo. Arranca con: munder start"
