@echo off
setlocal EnableExtensions
title Orchestra AI - Shutdown

cd /d "%~dp0"

echo.
echo ==========================================
echo          ORCHESTRA AI - SHUTDOWN
echo ==========================================
echo.

where docker >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker CLI was not found. Nothing was stopped.
    pause
    exit /b 1
)

if not exist "docker-compose.yml" (
    echo [ERROR] docker-compose.yml was not found in this folder.
    pause
    exit /b 1
)

echo [INFO] Stopping Orchestra AI containers...
docker compose stop
if errorlevel 1 (
    echo.
    echo [ERROR] Docker Compose could not stop the application.
    echo Check Docker Desktop and try again.
    pause
    exit /b 1
)

echo.
echo [SUCCESS] Orchestra AI has been stopped.
echo Your containers and database volume have been preserved.
echo Run start.bat to start the application again.
echo.
pause
endlocal
