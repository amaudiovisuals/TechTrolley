# refresh_environment.ps1 - Automate Tech Trolley Asset Tracker Setup

$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "   Tech Trolley Environment Refresh" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# 1. Detect Python
Write-Host "`n[1/4] Detecting Python..." -ForegroundColor Yellow
$PythonCmd = "python"
$KnownPath = "C:\Users\amoff\AppData\Local\Programs\Python\Python312\python.exe"

if (Test-Path $KnownPath) {
    $PythonCmd = $KnownPath
}
else {
    try {
        & py -3.12 --version | Out-Null
        $PythonCmd = "py -3.12"
    }
    catch {
        try {
            & python --version | Out-Null
        }
        catch {
            Write-Error "Python 3.12 not found! Please ensure it is installed."
            exit 1
        }
    }
}
Write-Host "Using: $(& $PythonCmd --version)" -ForegroundColor Green

# 2. Backend Dependencies
Write-Host "`n[2/4] Updating Backend Dependencies..." -ForegroundColor Yellow
& $PythonCmd -m pip install -r backend/requirements.txt
if ($LASTEXITCODE -ne 0) { Write-Error "Failed to install backend dependencies."; exit 1 }

# 3. Frontend Dependencies
Write-Host "`n[3/4] Updating Frontend Dependencies..." -ForegroundColor Yellow
npm install --legacy-peer-deps
if ($LASTEXITCODE -ne 0) { Write-Error "Failed to install frontend dependencies."; exit 1 }

# 4. Database Migrations
Write-Host "`n[4/4] Running Database Migrations..." -ForegroundColor Yellow
& $PythonCmd backend/manage.py migrate
if ($LASTEXITCODE -ne 0) { Write-Error "Failed to run migrations."; exit 1 }

Write-Host "`n==========================================" -ForegroundColor Cyan
Write-Host "       Environment Ready for Action!" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Run 'start_app.bat' to launch the app."
