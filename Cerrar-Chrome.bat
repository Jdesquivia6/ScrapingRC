@echo off
chcp 65001 >nul
title Cerrar Chrome + Backend + Worker
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-env.ps1"
