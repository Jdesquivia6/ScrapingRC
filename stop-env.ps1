$backendDir = $PSScriptRoot

function KillByPidFile($name) {
    $file = Join-Path $backendDir "$name.pid"
    if (Test-Path $file) {
        $pidValue = (Get-Content $file -Raw).Trim()
        if ($pidValue -match '^\d+$') {
            Write-Host "Cerrando $name (PID $pidValue)..."
            Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
        }
        Remove-Item $file -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host "Archivo $name.pid no encontrado, usando fallback..."
    }
}

Write-Host "Cerrando entorno de liquidaciones..."

KillByPidFile "backend"
KillByPidFile "worker"
KillByPidFile "chrome"

# Fallback: cerrar ventanas CMD por titulo
Get-WmiObject Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and ($_.CommandLine -like '*Backend - ScrapingRC*' -or $_.CommandLine -like '*Worker - ScrapingRC*') } | ForEach-Object {
    Write-Host "Cerrando CMD fallback PID $($_.ProcessId)..."
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

# Fallback: cerrar Chrome autocore
Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like '*chrome-autocore*' } | ForEach-Object {
    Write-Host "Cerrando Chrome autocore PID $($_.ProcessId)..."
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

# Fallback: cerrar Node huerfanos
Get-WmiObject Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and ($_.CommandLine -like '*server.js*' -or $_.CommandLine -like '*worker.local.js*') } | ForEach-Object {
    Write-Host "Cerrando Node orphan PID $($_.ProcessId)..."
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

Write-Host "Entorno cerrado correctamente."
pause
