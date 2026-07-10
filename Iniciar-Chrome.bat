@echo off
chcp 65001 >nul
title Iniciar Chrome + Backend + Worker

:: BACKEND_DIR es la carpeta donde esta este archivo .bat
set BACKEND_DIR=%~dp0
set BACKEND_DIR=%BACKEND_DIR:~0,-1%

echo ==========================================
echo  Iniciando entorno de liquidaciones
echo ==========================================
echo.

:: Verificar que la carpeta del backend exista
if not exist "%BACKEND_DIR%" (
    echo No se encontro la carpeta del backend:
    echo %BACKEND_DIR%
    echo.
    echo Verifica la ruta y vuelve a intentar.
    pause
    exit /b 1
)

:: Verificar si Chrome ya esta corriendo
tasklist /FI "IMAGENAME eq chrome.exe" 2>NUL | find /I "chrome.exe" >NUL
if "%ERRORLEVEL%"=="0" (
    echo Chrome ya esta corriendo.
    echo Cierra Chrome y vuelve a ejecutar este archivo.
    echo.
    pause
    exit /b 1
)

:: Iniciar backend
echo Iniciando backend...
start "Backend - ScrapingRC" /d "%BACKEND_DIR%" cmd /k node server.js
timeout /t 3 /nobreak >nul

:: Iniciar worker
echo Iniciando worker...
start "Worker - ScrapingRC" /d "%BACKEND_DIR%" cmd /k node scripts/worker.local.js
timeout /t 2 /nobreak >nul

:: Iniciar Chrome
echo Iniciando Chrome con debugging...
start "Chrome - Autocore" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\chrome-autocore" --start-maximized

echo.
echo Todo iniciado. Puedes cerrar esta ventana.
echo.
pause
