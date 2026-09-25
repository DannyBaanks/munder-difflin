# munder.ps1 — CLI de Munder Difflin para Windows.
# Carril Windows (MANTENEDORES.md): este archivo + munder.cmd + install.ps1.
# Equivalente de start.sh: lanza Electron DESPEGADO de la terminal
# (via .NET ProcessStartInfo con stdio nulo: cerrar la terminal no mata
# la app, y los handles heredados no pueden romperse al salir el shell).
#
# Uso:
#   munder start [--user-data-dir DIR]   lanza la app despegada (recomendado)
#   munder stop                           detiene TODAS las instancias de este build
#   munder restart                        stop + start
#   munder status                         dice si esta corriendo (PIDs)
#   munder logs [-n N]                    ultimas lineas del log vigente
#   munder check                          verifica electron + build
#
# NOTA singleton: el userData (%APPDATA%\munder-difflin) es COMPARTIDO con
# cualquier `npm run dev` de este checkout. No lances ambos a la vez: la
# segunda instancia muere al arrancar (second-instance).
# Sesiones paralelas: cada instancia necesita su PROPIO userData:
#   munder start --user-data-dir "$env:APPDATA\munder-difflin-harness2"
# OJO: no pongas dos sesiones a trabajar sobre los mismos repos a la vez.
#
# Logs: $env:LOCALAPPDATA\munder-difflin\logs\latest.log

$ErrorActionPreference = 'Stop'
$Utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $Utf8
$OutputEncoding = $Utf8
$APP_ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$ELECTRON = Join-Path $APP_ROOT 'node_modules\electron\dist\electron.exe'
$MAIN_ENTRY = Join-Path $APP_ROOT 'out\main\index.js'
$MUNDER_CLI = Join-Path $APP_ROOT 'tools\munder\munder'
$LOG_DIR = Join-Path $env:LOCALAPPDATA 'munder-difflin\logs'

function Say($m) { Write-Output "munder: $m" }

# Nombres de ejecutable que cuentan como "la app": electron.exe (checkout) y
# "Munder Difflin.exe" / "Munder-Difflin-*.exe" (builds empaquetados: portable
# o setup). Sin el segundo patron, `munder stop` no puede parar el portable.
function Get-AppProcesses {
    # electron.exe cuya linea de comando menciona APP_ROOT (el checkout). El
    # filtro por ruta sola daria falsos positivos: cualquier shell que invoque
    # a munder contiene APP_ROOT en su propia linea de comando.
    $dev = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessId -ne $PID -and $_.Name -like 'electron*' -and $_.CommandLine -like "*$APP_ROOT*" })
    # Empaquetados: por nombre de producto, cualquiera que este corriendo.
    $pack = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessId -ne $PID -and ($_.Name -like 'Munder Difflin*' -or $_.Name -like 'Munder-Difflin-*') })
    @($dev + $pack | Sort-Object ProcessId -Unique)
}

function Assert-Prereqs {
    if (-not (Test-Path -LiteralPath $ELECTRON)) {
        Say "Electron no encontrado: $ELECTRON"
        Say "Ejecuta 'npm install' en $APP_ROOT (ver install.ps1)"
        exit 1
    }
    if (-not (Test-Path -LiteralPath $MAIN_ENTRY)) {
        Say "Build de Munder no encontrado: $MAIN_ENTRY"
        Say "Ejecuta 'npm run build' en $APP_ROOT"
        exit 1
    }
}

function Invoke-Check {
    Assert-Prereqs
    $v = & $ELECTRON --version 2>$null
    Say "OK"
    Say "root: $APP_ROOT"
    Say "electron: $ELECTRON ($v)"
    Say "main: $MAIN_ENTRY"
}

function Invoke-Status {
    $p = Get-AppProcesses
    if ($p.Count -eq 0) { Say "detenido"; exit 0 }
    $main = $p | Where-Object { $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1
    Say ("en marcha ({0} procesos electron)" -f $p.Count)
    foreach ($x in $p) { Say ("  pid {0}  {1}" -f $x.ProcessId, $x.Name) }
    if ($main) { Say ("  main pid: {0}" -f $main.ProcessId) }
}

function Stop-App {
    $p = Get-AppProcesses
    if ($p.Count -eq 0) { Say "no hay procesos corriendo"; return }
    # 1) cierre amable de ventanas principales
    foreach ($x in $p) {
        try {
            $proc = Get-Process -Id $x.ProcessId -ErrorAction SilentlyContinue
            if ($proc -and $proc.MainWindowHandle -ne 0) { $proc.CloseMainWindow() | Out-Null }
        } catch {}
    }
    Start-Sleep -Seconds 5
    # 2) lo que quede, TERM forzado
    $rest = Get-AppProcesses
    foreach ($x in $rest) {
        try { Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
    }
    Start-Sleep -Seconds 2
    $final = Get-AppProcesses
    if ($final.Count -eq 0) { Say ("detenidos {0} procesos" -f $p.Count) }
    else { Say ("quedan {0} procesos (pids: {1})" -f $final.Count, (($final | ForEach-Object { $_.ProcessId }) -join ', ')); exit 1 }
}

function Start-App($userDataDir) {
    Assert-Prereqs
    $already = Get-AppProcesses
    if ($already.Count -gt 0 -and -not $userDataDir) {
        Say "ya hay una instancia corriendo (singleton compartido) - no lanzo otra"
        Say ("  pids: {0}" -f (($already | ForEach-Object { $_.ProcessId }) -join ', '))
        exit 0
    }
    New-Item -ItemType Directory -Path $LOG_DIR -Force | Out-Null
    $stamp = Get-Date -Format 'yyyyMMddTHHmmss'
    $runLog = Join-Path $LOG_DIR "run-$stamp.log"
    $latest = Join-Path $LOG_DIR 'latest.log'
    # Lanzamiento via .NET (NO Start-Process): UseShellExecute=false +
    # CreateNoWindow=true + stdio nulo. Verificado 6/6 arranques sanos.
    # Start-Process (con o sin -Redirect*) deja al hijo con handles stdio
    # atados al shell que lanza: al salir ese shell el proximo console.*
    # de la app revienta y el proceso muere con exit 1 (intermitente,
    # 2-6 s). Con stdio nulo no hay nada que romper.
    # La app escribe sus propios logs en %APPDATA%\munder-difflin
    # (updater.log); este run-*.log es del lanzador: pid, tiempos, exit.
    $ela = @("`"$APP_ROOT`"")
    if ($userDataDir) { $ela = @("--user-data-dir=`"$userDataDir`"") + $ela }
    $argLine = $ela -join ' '
    "$(Get-Date -Format o) start electron=$ELECTRON args=$argLine" | Out-File -LiteralPath $runLog -Encoding utf8
    Say "lanzando despegada (cerrar la terminal no la mata)"
    $psi = New-Object Diagnostics.ProcessStartInfo($ELECTRON, $argLine)
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $APP_ROOT
    $pr = [Diagnostics.Process]::Start($psi)
    "$(Get-Date -Format o) launched pid=$($pr.Id)" | Out-File -LiteralPath $runLog -Encoding utf8 -Append
    Copy-Item -LiteralPath $runLog -Destination $latest -Force
    # Ventana de vigilancia (~8 s): si muere, queda el exit code en el log.
    $dead = $pr.WaitForExit(8000)
    if ($dead) {
        $code = $pr.ExitCode
        # exit 0 = la app se cerro sola y limpia: casi siempre el singleton
        # electron la cerro porque YA HAY OTRA INSTANCIA (p. ej. el portable
        # del release con el MISMO userData). No es un fallo del launcher.
        $otras = Get-AppProcesses
        if ($code -eq 0 -and $otras.Count -gt 0) {
            "$(Get-Date -Format o) exit 0 con $($otras.Count) proceso(s) electron vivos -> singleton: otra instancia toma el userData compartido" | Out-File -LiteralPath $runLog -Encoding utf8 -Append
            Copy-Item -LiteralPath $runLog -Destination $latest -Force
            Say "otra instancia ya esta corriendo (mismo userData compartido) - no lanzo otra"
            Say ("  pids: {0}" -f (($otras | ForEach-Object { $_.ProcessId }) -join ', '))
            Say "parar la que corre: munder stop   (para sesiones paralelas: --user-data-dir)"
            exit 0
        }
        "$(Get-Date -Format o) DIED exit=$code (ver %APPDATA%\munder-difflin\updater.log; diagnostico: lanzar en primer plano)" | Out-File -LiteralPath $runLog -Encoding utf8 -Append
        Copy-Item -LiteralPath $runLog -Destination $latest -Force
        Say "la app termino de forma inesperada (exit $code); ver log: $runLog"
        exit 1
    }
    "$(Get-Date -Format o) healthy pid=$($pr.Id)" | Out-File -LiteralPath $runLog -Encoding utf8 -Append
    Copy-Item -LiteralPath $runLog -Destination $latest -Force
    Say ("en marcha (pid main: {0})" -f $pr.Id)
    Say "log del lanzador: $runLog"
    Say "parar: munder stop"
}

function Show-Logs($n) {
    $latest = Join-Path $LOG_DIR 'latest.log'
    if (-not (Test-Path -LiteralPath $latest)) { Say "sin logs todavia en $LOG_DIR"; exit 1 }
    Say "log: $latest"
    Get-Content -LiteralPath $latest -Tail $n
    $upd = Join-Path $env:APPDATA 'munder-difflin\updater.log'
    if (Test-Path -LiteralPath $upd) { Say "updater: $upd" }
}

function Show-Help {
    Write-Output @"
munder — CLI de Munder Difflin (checkout: $APP_ROOT)

  munder start [--user-data-dir DIR]   arranca la app despegada
  munder stop                           detiene todas las instancias
  munder restart                        stop + start
  munder status                         en marcha o detenido (PIDs)
  munder logs [-n N]                    ultimas N lineas del log (def. 30)
  munder check                          verifica electron + build compilado
"@
}

function Invoke-Link($rest) {
    if (-not (Test-Path -LiteralPath $MUNDER_CLI)) {
        Say "Munder Link no encontrado: $MUNDER_CLI"
        exit 1
    }
    & node $MUNDER_CLI 'link' @rest
    exit $LASTEXITCODE
}

# --- dispatch ---
$cmd = $args[0]
$rest = @()
if ($args.Count -gt 1) { $rest = $args[1..($args.Count - 1)] }

switch ($cmd) {
    'link' { Invoke-Link $rest }
    'start' {
        $udd = $null
        for ($i = 0; $i -lt $rest.Count; $i++) {
            if ($rest[$i] -eq '--user-data-dir' -and ($i + 1) -lt $rest.Count) { $udd = $rest[$i + 1]; $i++ }
            elseif ($rest[$i] -like '--user-data-dir=*') { $udd = $rest[$i].Substring(17) }
        }
        Start-App $udd
    }
    'stop' { Stop-App }
    'restart' { Stop-App; Start-App $null }
    'status' { Invoke-Status }
    'logs' {
        $n = 30
        $ni = [array]::IndexOf($rest, '-n')
        if ($ni -ge 0 -and ($ni + 1) -lt $rest.Count) { $n = [int]$rest[$ni + 1] }
        Show-Logs $n
    }
    'check' { Invoke-Check }
    default { Show-Help }
}
