# ─────────────────────────────────────────────────────────────────────────
#  Запуск браузера с открытым портом отладки (для cdp.py) — вариант для
#  PowerShell. То же самое делает browser-debug.cmd, и его проще запустить:
#  .ps1 может быть заблокирован политикой запуска скриптов.
#
#  Запуск:  powershell -ExecutionPolicy Bypass -File .\browser-debug.ps1
# ─────────────────────────────────────────────────────────────────────────
$port = 9222
$browser = Join-Path $env:LOCALAPPDATA 'Vivaldi\Application\vivaldi.exe'

if (-not (Test-Path $browser)) {
    Write-Host "[!] Не найден браузер: $browser" -ForegroundColor Red
    Write-Host "    Поправьте путь в переменной browser в этом файле."
    exit 1
}

if (Get-Process vivaldi -ErrorAction SilentlyContinue) {
    Write-Host "[!] Браузер уже запущен — флаг будет проигнорирован." -ForegroundColor Yellow
    Write-Host "    Закройте Vivaldi полностью (все окна) и запустите скрипт снова."
    exit 1
}

Write-Host "Запускаю браузер с портом отладки $port..."
Start-Process $browser -ArgumentList "--remote-debugging-port=$port"

# даём браузеру подняться и проверяем, что порт действительно открылся
Start-Sleep -Seconds 5
$listening = (Test-NetConnection -ComputerName 127.0.0.1 -Port $port -WarningAction SilentlyContinue).TcpTestSucceeded
if ($listening) {
    Write-Host "[ok] Порт $port слушает. Теперь работают скрипты проекта:" -ForegroundColor Green
    Write-Host "     python cdp.py tabs"
} else {
    Write-Host "[!] Порт $port не открылся. Проверьте, что браузер запустился." -ForegroundColor Red
}
