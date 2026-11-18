@echo off
setlocal EnableExtensions
title Orchestra AI - Startup
cd /d "%~dp0"

echo.
echo ==================================================
echo       ORCHESTRA AI - SPLIT SERVICE STARTUP
echo ==================================================
echo.

echo [1/7] Checking Docker CLI...
where docker >nul 2>&1
if errorlevel 1 (
    echo [FAIL] Docker CLI not found. Install Docker Desktop and retry.
    pause
    exit /b 1
)
echo [PASS] Docker CLI found.

echo.
echo [2/7] Checking environment configuration...
if not exist ".env" (
    if exist ".env.example" (
        copy ".env.example" ".env" >nul
        echo [ACTION REQUIRED] Created .env from .env.example.
        echo Add your API keys, save the file, and run start.bat again.
        pause
        exit /b 1
    ) else (
        echo [FAIL] .env and .env.example are both missing.
        pause
        exit /b 1
    )
)
echo [PASS] .env file found. Secret values will not be displayed.

echo.
echo [3/7] Checking Docker Engine...
docker info >nul 2>&1
if errorlevel 1 (
    echo [INFO] Starting Docker Desktop...
    if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" (
        start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
    ) else if exist "%ProgramFiles(x86)%\Docker\Docker\Docker Desktop.exe" (
        start "" "%ProgramFiles(x86)%\Docker\Docker\Docker Desktop.exe"
    ) else (
        echo [FAIL] Docker Desktop executable not found. Start it manually.
        pause
        exit /b 1
    )
    echo [INFO] Waiting up to 90 seconds for Docker Engine...
    set "DOCKER_READY="
    for /L %%I in (1,1,45) do (
        if not defined DOCKER_READY (
            docker info >nul 2>&1
            if not errorlevel 1 (set "DOCKER_READY=1") else (timeout /t 2 /nobreak >nul)
        )
    )
    if not defined DOCKER_READY (
        echo [FAIL] Docker Engine did not become ready.
        pause
        exit /b 1
    )
)
echo [PASS] Docker Engine is ready.

echo.
echo [4/7] Validating split frontend/backend Compose configuration...
docker compose config --quiet
if errorlevel 1 (
    echo [FAIL] Docker Compose configuration is invalid.
    pause
    exit /b 1
)
echo [PASS] Compose configuration is valid.

echo.
echo [5/7] Building and starting BACKEND + FRONTEND containers...
docker compose up --build -d --remove-orphans backend frontend
if errorlevel 1 (
    echo [FAIL] One or more services failed to start.
    echo [INFO] Inspect with: docker compose logs --tail=100 backend frontend
    pause
    exit /b 1
)
echo [PASS] Both service startup commands were accepted.

echo.
echo [6/7] Waiting for backend API health (up to 120 seconds)...
set "BACKEND_READY="
for /L %%I in (1,1,60) do (
    if not defined BACKEND_READY (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-RestMethod -Uri 'http://localhost:3000/api/health' -TimeoutSec 3; if ($r.status -eq 'ok' -and $r.database -eq 'connected') { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
        if not errorlevel 1 (set "BACKEND_READY=1") else (timeout /t 2 /nobreak >nul)
    )
)
if not defined BACKEND_READY (
    echo [FAIL] Backend/database health check did not pass.
    docker compose logs --tail=80 backend
    pause
    exit /b 1
)
echo [PASS] Backend API and SQLite are healthy.

echo.
echo [7/7] Checking frontend and opening separate log windows...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:5173/' -TimeoutSec 10; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
    echo [FAIL] Frontend did not return HTTP 200.
    docker compose logs --tail=80 frontend
    pause
    exit /b 1
)
echo [PASS] Frontend is responding.

echo [INFO] Opening Backend CMD and Frontend CMD windows...
start "Orchestra AI - BACKEND" cmd /k "cd /d ""%~dp0"" && title Orchestra AI - BACKEND && echo ==== BACKEND API + LANGGRAPH LOGS ==== && docker compose logs --follow --no-color backend"
start "Orchestra AI - FRONTEND" cmd /k "cd /d ""%~dp0"" && title Orchestra AI - FRONTEND && echo ==== FRONTEND VITE + HMR LOGS ==== && docker compose logs --follow --no-color frontend"
start "" "http://localhost:5173"

echo.
echo ==================================================
echo          ORCHESTRA AI STARTUP COMPLETE
echo ==================================================
echo Frontend:  http://localhost:5173
echo Backend:   http://localhost:3000
echo API health: http://localhost:3000/api/health
echo Backend and frontend logs are in separate CMD windows.
echo.
echo Use stop.bat to stop both services. SQLite data is preserved.
echo ==================================================
echo.
pause
endlocal
