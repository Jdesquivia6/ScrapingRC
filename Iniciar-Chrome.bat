@echo off
chcp 65001 >nul
title Iniciar Chrome + Backend + Worker
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-env.ps1"
