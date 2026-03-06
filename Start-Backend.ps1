$BackendDir = Join-Path $PSScriptRoot "backend"
$PythonPath = Join-Path $BackendDir "venv\Scripts\python.exe"

Write-Host "Starting Django Backend using Python 3.12..." -ForegroundColor Green
Set-Location $BackendDir

& $PythonPath manage.py runserver 0.0.0.0:8000


