@echo off
setlocal EnableExtensions
title Orchestra AI - Startup

cd /d "%~dp0"

echo.
echo ==========================================
echo          ORCHESTRA AI - STARTUP
echo ==========================================
echo.

where docker >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker CLI was not found.
    echo Install Docker Desktop and make sure it is added to PATH.
    pause
    exit /b 1
)

if not exist ".env" (
    echo [ERROR] .env file was not found.
    if exist ".env.example" (
        echo Creating .env from .env.example...
        copy ".env.example" ".env" >nul
        echo.
        echo [ACTION REQUIRED] Add your GEMINI_API_KEY to the new .env file,
        echo then run start.bat again. You can use Ollama instead if configured.
    ) else (
        echo No .env.example was found. Create a valid .env file first.
    )
    pause
    exit /b 1
)

REM Start Docker Desktop when it is installed but not already running.
docker info >nul 2>&1
if errorlevel 1 (
    echo [INFO] Docker Engine is not ready. Starting Docker Desktop...
    if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" (
        start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
    ) else if exist "%ProgramFiles(x86)%\Docker\Docker\Docker Desktop.exe" (
        start "" "%ProgramFiles(x86)%\Docker\Docker\Docker Desktop.exe"
    ) else (
        echo [ERROR] Docker Desktop executable was not found.
        echo Start Docker Desktop manually, wait until it is ready, then retry.
        pause
        exit /b 1
    )

    echo [INFO] Waiting for Docker Engine...
    set "DOCKER_READY="
    for /L %%I in (1,1,45) do (
        docker info >nul 2>&1
        if not errorlevel 1 (
            set "DOCKER_READY=1"
            goto :docker_ready
        )
        timeout /t 2 /nobreak >nul
    )
    :docker_ready
    if not defined DOCKER_READY (
        echo [ERROR] Docker Engine did not become ready within 90 seconds.
        echo Open Docker Desktop, resolve any startup issue, and retry.
        pause
        exit /b 1
    )
)

echo.
echo [INFO] Building and starting Orchestra AI with Docker Compose...
docker compose up --build -d
if errorlevel 1 (
    echo.
    echo [ERROR] Docker Compose could not build or start Orchestra AI.
    echo Check the error above. The current Dockerfile uses "npm ci",
    echo but this repository currently contains bun.lock and no package-lock.json.
    echo The Docker configuration was intentionally not changed by this PR.
    pause
    exit /b 1
)

echo.
echo [INFO] Waiting for the application health endpoint...
set "APP_READY="
for /L %%I in (1,1,60) do (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3000/api/health' -TimeoutSec 3; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
    if not errorlevel 1 (
        set "APP_READY=1"
        goto :app_ready
    )
    timeout /t 2 /nobreak >nul
)
:app_ready

if not defined APP_READY (
    echo [WARNING] The container started, but the health endpoint did not respond.
    echo Check logs with: docker compose logs -f
    pause
    exit /b 1
)

echo.
echo [SUCCESS] Orchestra AI is running.
echo URL: http://localhost:3000
echo Opening your default browser...
start "" "http://localhost:3000"
echo.
echo To stop Orchestra AI, run stop.bat.
echo Your database volume will be preserved.
echo.
pause
endlocal
