@echo off
setlocal EnableExtensions
title Orchestra AI - Startup Diagnostics
cd /d "%~dp0"

echo.
echo ==================================================
echo           ORCHESTRA AI - STARTUP CHECKS
echo ==================================================
echo.

echo [1/8] Checking Docker CLI...
where docker >nul 2>&1
if errorlevel 1 (
    echo [FAIL] Docker CLI not found. Install Docker Desktop and retry.
    pause
    exit /b 1
)
echo [PASS] Docker CLI found.

echo.
echo [2/8] Checking environment configuration...
if not exist ".env" (
    if exist ".env.example" (
        copy ".env.example" ".env" >nul
        echo [ACTION REQUIRED] Created .env from .env.example.
        echo Add your GEMINI_API_KEY, save the file, and run start.bat again.
    ) else (
        echo [FAIL] .env and .env.example are both missing.
    )
    pause
    exit /b 1
)
echo [PASS] .env file found. (Secret values are not displayed.)

echo.
echo [3/8] Checking Docker Engine...
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
echo [4/8] Validating Docker Compose configuration...
docker compose config --quiet
if errorlevel 1 (
    echo [FAIL] docker-compose.yml or .env configuration is invalid.
    pause
    exit /b 1
)
echo [PASS] Compose configuration is valid.

echo.
echo [5/8] Building frontend and backend container...
echo [INFO] Build output will appear below.
docker compose up --build -d
if errorlevel 1 (
    echo [FAIL] Image build or container startup failed.
    echo [TIP] Review the Docker error above. You can also run: docker compose logs
    pause
    exit /b 1
)
echo [PASS] Docker Compose accepted the build and startup command.

echo.
echo [6/8] Checking container state...
docker compose ps

echo.
echo [7/8] Waiting for backend and database health (up to 120 seconds)...
set "APP_READY="
for /L %%I in (1,1,60) do (
    if not defined APP_READY (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-RestMethod -Uri 'http://localhost:3000/api/health' -TimeoutSec 3; if ($r.status -eq 'ok' -and $r.database -eq 'connected') { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
        if not errorlevel 1 (set "APP_READY=1") else (timeout /t 2 /nobreak >nul)
    )
)
if not defined APP_READY (
    echo [FAIL] Backend/database health check did not pass.
    echo [INFO] Recent container logs:
    docker compose logs --tail=80
    pause
    exit /b 1
)
echo [PASS] Backend API responds and database query succeeded.

echo.
echo [8/8] Opening application and live backend logs...
echo [PASS] Frontend is being served by the backend at http://localhost:3000
start "" "http://localhost:3000"
start "Orchestra AI - Live Logs" cmd /k "cd /d ""%~dp0"" && docker compose logs --follow --no-color"

echo.
echo ==================================================
echo          ORCHESTRA AI STARTUP COMPLETE
echo ==================================================
echo Frontend:  http://localhost:3000
echo API check: http://localhost:3000/api/health
echo Live logs: Separate CMD window
echo.
echo Note: Startup checks confirm service readiness, not every AI feature.
echo Run a sample research workflow to verify Gemini, Tavily, RAG and agents.
echo Close the live-log window when finished. Use stop.bat to stop services.
echo.
pause
endlocal
