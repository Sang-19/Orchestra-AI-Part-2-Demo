@echo off
setlocal EnableExtensions
title Orchestra AI - Stop Frontend and Backend

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

echo [INFO] Stopping the separate frontend and backend services...
docker compose stop frontend backend
if errorlevel 1 (
    echo.
    echo [ERROR] Docker Compose could not stop the application.
    echo Check Docker Desktop and try again.
    pause
    exit /b 1
)

echo.
echo [SUCCESS] Frontend and backend have both been stopped.
echo Your containers and SQLite database volume have been preserved.
echo Run start.bat to start the application again.
echo.
pause
endlocal
