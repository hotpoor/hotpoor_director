param([string]$Python = 'python', [string]$VCRuntimeDir = '')
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
& $Python -m venv .venv
if ($LASTEXITCODE -ne 0) { throw 'Python 3.12+ is required' }
& ./.venv/Scripts/python.exe -m pip install -r requirements-dev.txt
if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed' }
if (!(Test-Path runtime/pgsql/bin/postgres.exe)) {
    New-Item -ItemType Directory -Force downloads,runtime | Out-Null
    Invoke-WebRequest 'https://sbp.enterprisedb.com/getfile.jsp?fileid=1260488' -OutFile downloads/postgresql-windows-x64.zip
    Expand-Archive downloads/postgresql-windows-x64.zip runtime -Force
}
if ($VCRuntimeDir) { Copy-Item (Join-Path $VCRuntimeDir '*140*.dll') runtime/pgsql/bin/ }
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'Node dependency installation failed' }
& ./.venv/Scripts/python.exe -m backend init-db
if ($LASTEXITCODE -ne 0) { throw 'Database initialization failed' }
Write-Output 'Ready. Run npm run user:create, then npm start.'
