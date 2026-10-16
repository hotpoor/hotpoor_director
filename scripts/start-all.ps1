[CmdletBinding()]
param([string]$ComfyRoot, [switch]$DryRun, [switch]$EnableTriton)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (!$ComfyRoot) { $ComfyRoot = Join-Path $root '..\ComfyUI' }
$ComfyRoot = [IO.Path]::GetFullPath($ComfyRoot)
$python = Join-Path $ComfyRoot 'python_embeded\python.exe'
$main = Join-Path $ComfyRoot 'main.py'
$origin = 'http://127.0.0.1:8188'
function Get-ComfyProcesses {
    @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -eq $python -and $_.CommandLine -match '(?i)(?:^|\s|["\\/])main\.py(?:"|\s|$)'
    })
}
function Get-ComfyListener {
    @(Get-NetTCPConnection -State Listen -LocalPort 8188 -ErrorAction SilentlyContinue)
}
try {
    foreach ($path in @($python, $main)) {
        if (!(Test-Path -LiteralPath $path)) { throw "Missing ComfyUI file: $path" }
    }
    $launchConfig = Join-Path $root '.local\comfy-launch.json'
    if (Test-Path -LiteralPath $launchConfig) {
        $launch = Get-Content -LiteralPath $launchConfig -Raw | ConvertFrom-Json
        if ($null -ne $launch.enable_triton_backend) {
            if ($launch.enable_triton_backend -isnot [bool]) { throw 'enable_triton_backend must be a boolean.' }
            if (!$EnableTriton) { $EnableTriton = $launch.enable_triton_backend }
        }
    }
    if ($EnableTriton) {
        & $python -c 'import triton'
        if ($LASTEXITCODE -ne 0) { throw 'Triton was requested but is unavailable in the ComfyUI Python environment.' }
    }
    Write-Host ("ComfyUI Triton backend: " + [bool]$EnableTriton)
    $existing = @(Get-ComfyProcesses)
    foreach ($listener in Get-ComfyListener) {
        if ($listener.OwningProcess -notin $existing.ProcessId) { throw 'Port 8188 belongs to another process. Startup stopped without closing it.' }
    }
    Write-Host "ComfyUI: $ComfyRoot"
    Write-Host ('Matched ComfyUI process IDs: ' + ($existing.ProcessId -join ', '))
    if ($DryRun) {
        & "$PSScriptRoot\restart-dev.ps1" -DryRun
        exit $LASTEXITCODE
    }
    New-Item -ItemType Directory -Path "$root\.local" -Force | Out-Null
    $lock = [IO.File]::Open("$root\.local\start-all.lock", 'OpenOrCreate', 'ReadWrite', 'None')
    if ((Get-ComfyListener).Count -gt 0) {
        Write-Host 'Waiting for ComfyUI jobs to finish (up to 10 minutes)...'
        $deadline = (Get-Date).AddMinutes(10)
        do {
            $queue = Invoke-RestMethod "$origin/queue" -TimeoutSec 5
            if (@($queue.queue_running).Count -eq 0 -and @($queue.queue_pending).Count -eq 0) { break }
            if ((Get-Date) -gt $deadline) { throw 'ComfyUI is still busy. Retry after jobs finish.' }
            Start-Sleep -Seconds 2
        } while ($true)
    }
    Write-Host 'Stopping matched ComfyUI processes...'
    foreach ($item in Get-ComfyProcesses) {
        $process = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
        if ($process -and $process.Path -eq $python) {
            $process | Stop-Process -Force
            $process.WaitForExit(15000) | Out-Null
        }
    }
    if ((Get-ComfyProcesses).Count -gt 0 -or (Get-ComfyListener).Count -gt 0) { throw 'ComfyUI has not released port 8188.' }
    $logs = Join-Path $root '.local\restart-logs'
    New-Item -ItemType Directory -Path $logs -Force | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $stdout = Join-Path $logs "$stamp.comfy.stdout.log"
    $stderr = Join-Path $logs "$stamp.comfy.stderr.log"
    Write-Host 'Starting ComfyUI on GPU 0...'
    $comfyArguments = @('-s', ('"' + $main + '"'), '--windows-standalone-build', '--cuda-device', '0', '--reserve-vram', '2', '--listen', '0.0.0.0', '--port', '8188')
    if ($EnableTriton) { $comfyArguments += '--enable-triton-backend' }
    $app = Start-Process -FilePath $python -ArgumentList $comfyArguments -WorkingDirectory $ComfyRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $deadline = (Get-Date).AddMinutes(6)
    do {
        $app.Refresh()
        if ($app.HasExited) { throw "ComfyUI exited. Check $stderr" }
        try { $null = Invoke-RestMethod "$origin/system_stats" -TimeoutSec 3; $ready = $true } catch { $ready = $false }
        if ($ready) { break }
        if ((Get-Date) -gt $deadline) { throw "ComfyUI startup timed out. Check $stderr" }
        Start-Sleep -Seconds 1
    } while ($true)
    Write-Host "ComfyUI ready: $origin" -ForegroundColor Green
    & "$PSScriptRoot\restart-dev.ps1"
    if ($LASTEXITCODE -ne 0) { throw 'Director restart failed. ComfyUI remains available.' }
    Write-Host 'ComfyUI and Director are ready.' -ForegroundColor Green
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
} finally {
    if ($lock) { $lock.Dispose() }
}
