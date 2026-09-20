[CmdletBinding()]
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$python = Join-Path $root '.venv\Scripts\python.exe'
$pgCtl = Join-Path $root 'runtime\pgsql\bin\pg_ctl.exe'
$dataDirectory = Join-Path $root '.local'
$savedDirectory = Join-Path $env:APPDATA 'hotpoor-director'
if ($env:DIRECTOR_DATA_DIR) {
    $dataDirectory = [IO.Path]::GetFullPath($env:DIRECTOR_DATA_DIR)
} elseif (!(Test-Path "$dataDirectory\config.json") -and (Test-Path "$savedDirectory\config.json")) {
    $dataDirectory = $savedDirectory
}

function Get-DirectorProcesses {
    @(Get-CimInstance Win32_Process | Where-Object {
        ($_.ExecutablePath -eq $electron) -or
        ($_.ExecutablePath -eq $python -and $_.CommandLine -match '(?i)\s-m\s+backend\s+serve(?:\s|$)')
    })
}

function Wait-DirectorExit([int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        if (@(Get-DirectorProcesses).Count -eq 0) { return $true }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return $false
}

try {
    Set-Location -LiteralPath $root
    foreach ($required in @($electron, $python)) {
        if (!(Test-Path -LiteralPath $required)) { throw "Missing $required. Run scripts\setup.ps1 first." }
    }
    $embedded = $true
    if (Test-Path "$dataDirectory\config.json") {
        $config = Get-Content -LiteralPath "$dataDirectory\config.json" -Raw | ConvertFrom-Json
        $embedded = $config.postgres.mode -eq 'embedded'
    }
    if ($embedded -and !(Test-Path -LiteralPath $pgCtl)) { throw "Missing PostgreSQL: $pgCtl" }
    $existing = @(Get-DirectorProcesses)
    Write-Host "Project: $root"
    Write-Host "Data:    $dataDirectory"
    Write-Host ('Matched process IDs: ' + (($existing | ForEach-Object { $_.ProcessId }) -join ', '))
    if ($DryRun) {
        Write-Host 'Dry run: close desktop -> stop remaining backend -> stop embedded database -> launch desktop and wait for readiness.'
        exit 0
    }

    # Hold a project-local lock for the entire restart, including readiness.
    $lockPath = Join-Path $root '.restart-dev.lock'
    $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
    Write-Host '[1/4] Closing desktop and waiting for normal backend/database shutdown...'
    foreach ($item in $existing | Where-Object { $_.ExecutablePath -eq $electron }) {
        $process = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
        if ($process -and $process.MainWindowHandle -ne 0) { [void]$process.CloseMainWindow() }
    }
    if ($existing.Count -gt 0 -and !(Wait-DirectorExit 165)) {
        Write-Warning 'Normal shutdown timed out. Stopping remaining project desktop/backend processes.'
        # Re-query exact executable paths; never kill Python/Electron by image name.
        foreach ($item in Get-DirectorProcesses) {
            $process = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
            if ($process -and $process.Path -eq $item.ExecutablePath) { $process | Stop-Process -Force }
        }
        if (!(Wait-DirectorExit 15)) { throw 'Project processes are still running; restart aborted.' }
    }

    Write-Host '[2/4] Checking embedded PostgreSQL...'
    $pgData = Join-Path $dataDirectory 'postgres'
    if ($embedded -and (Test-Path -LiteralPath "$pgData\PG_VERSION")) {
        & $pgCtl -D $pgData status
        $pgStatus = $LASTEXITCODE
        if ($pgStatus -eq 0) {
            & $pgCtl -D $pgData -m fast -t 120 -w stop
            if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL did not stop cleanly; restart aborted.' }
        } elseif ($pgStatus -ne 3) {
            throw "Cannot determine PostgreSQL status (exit $pgStatus); restart aborted."
        }
    }

    Write-Host '[3/4] Starting database -> backend -> desktop through Electron...'
    $logDirectory = Join-Path $root '.local\restart-logs'
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $stdout = Join-Path $logDirectory "$stamp.stdout.log"
    $stderr = Join-Path $logDirectory "$stamp.stderr.log"
    $env:ELECTRON_RUN_AS_NODE = $null
    $appProcess = Start-Process -FilePath $electron -ArgumentList '.', '--dev' -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    Write-Host '[4/4] Waiting for the desktop to finish loading (up to 6 minutes)...'
    $deadline = (Get-Date).AddSeconds(370)
    $ready = $false
    do {
        $appProcess.Refresh()
        if ($appProcess.HasExited) { throw "Desktop exited before ready. Check $stderr" }
        if (Test-Path -LiteralPath $stdout) {
            $output = Get-Content -LiteralPath $stdout -Raw
            if ($output -match 'Source development workspace ready:\s*(http://127\.0\.0\.1:\d+)') {
                $origin = $Matches[1]
                $ready = $true
                break
            }
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    if (!$ready) { throw "Startup timed out. Check $stderr and the application's error window." }
    Write-Host "Ready: $origin" -ForegroundColor Green
    Write-Host "Logs: $logDirectory"
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
} finally {
    if ($lock) { $lock.Dispose() }
}
