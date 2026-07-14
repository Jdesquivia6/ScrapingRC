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

:: Verificar que node y npm esten disponibles
where node >nul 2>nul
if "%ERRORLEVEL%"=="1" (
    echo ERROR: No se encontro Node.js en el PATH.
    echo Instala Node.js o agregalo al PATH.
    pause
    exit /b 1
)

where npm >nul 2>nul
if "%ERRORLEVEL%"=="1" (
    echo ERROR: No se encontro npm en el PATH.
    echo Instala Node.js o agregalo al PATH.
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
start "Backend - ScrapingRC" /d "%BACKEND_DIR%" cmd /k npm run start
timeout /t 4 /nobreak >nul

:: Iniciar worker
echo Iniciando worker...
start "Worker - ScrapingRC" /d "%BACKEND_DIR%" cmd /k npm run worker:local
timeout /t 2 /nobreak >nul

:: Iniciar Chrome
echo Iniciando Chrome con debugging...
start "Chrome - Autocore" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\chrome-autocore" --start-maximized

echo.
echo Todo iniciado. Puedes cerrar esta ventana.
echo.
pause
