$backendDir = $PSScriptRoot
$logFile = Join-Path $backendDir "iniciar_log.txt"

function Log($msg) {
    "$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')) - $msg" | Out-File -FilePath $logFile -Append
}

Log "Iniciando entorno"

# Verificar Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Log "ERROR: Node.js no encontrado en PATH"
    Write-Host "ERROR: Node.js no encontrado en PATH"
    pause
    exit 1
}

# Verificar Chrome de autocore
$chromeExistente = Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like '*chrome-autocore*' }
if ($chromeExistente) {
    Log "Chrome de autocore ya esta corriendo"
    Write-Host "Chrome de autocore ya esta corriendo. Cierralo primero."
    pause
    exit 1
}

# Limpiar PIDs viejos
Remove-Item "$backendDir\backend.pid" -ErrorAction SilentlyContinue
Remove-Item "$backendDir\worker.pid" -ErrorAction SilentlyContinue
Remove-Item "$backendDir\chrome.pid" -ErrorAction SilentlyContinue

# Iniciar backend
Log "Iniciando backend"
$backend = Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "cd /d `"$backendDir`" && npm run start" -WindowStyle Normal -PassThru
$backend.Id | Out-File "$backendDir\backend.pid" -Encoding ASCII -NoNewline
Log "Backend PID: $($backend.Id)"
Start-Sleep -Seconds 4

# Iniciar worker
Log "Iniciando worker"
$worker = Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "cd /d `"$backendDir`" && npm run worker:local" -WindowStyle Normal -PassThru
$worker.Id | Out-File "$backendDir\worker.pid" -Encoding ASCII -NoNewline
Log "Worker PID: $($worker.Id)"
Start-Sleep -Seconds 2

# Iniciar Chrome
Log "Iniciando Chrome"
$chromeProc = Start-Process -FilePath "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList "--remote-debugging-port=9222", "--user-data-dir=C:\chrome-autocore", "--start-maximized", "--disable-features=PrivateNetworkAccess" -PassThru
$chromeProc.Id | Out-File "$backendDir\chrome.pid" -Encoding ASCII -NoNewline
Log "Chrome PID: $($chromeProc.Id)"

Log "Entorno iniciado correctamente"
Write-Host "Todo iniciado. Puedes cerrar esta ventana."
pause
