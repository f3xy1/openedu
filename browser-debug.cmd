@echo off
rem ─────────────────────────────────────────────────────────────────────────
rem  Запуск браузера с открытым портом отладки (для cdp.py).
rem
rem  Зачем: скрипты проекта проверяют заполнение заданий на живой странице и
rem  подключаются к вкладке через Chrome DevTools Protocol. Порт слушается
rem  только на localhost и только пока браузер запущен этим скриптом.
rem
rem  ВАЖНО: флаг читается только при СТАРТЕ браузера. Если он уже запущен,
rem  новая команда просто откроет окно в текущем процессе, и порт не
rem  появится — поэтому скрипт сначала проверяет, не запущен ли браузер.
rem ─────────────────────────────────────────────────────────────────────────
setlocal
set PORT=9222
set BROWSER=%LOCALAPPDATA%\Vivaldi\Application\vivaldi.exe

if not exist "%BROWSER%" (
    echo [!] Не найден браузер: "%BROWSER%"
    echo     Поправьте путь в переменной BROWSER в этом файле.
    pause
    exit /b 1
)

tasklist /FI "IMAGENAME eq vivaldi.exe" 2>nul | find /I "vivaldi.exe" >nul
if not errorlevel 1 (
    echo [!] Браузер уже запущен — флаг будет проигнорирован.
    echo     Закройте Vivaldi полностью ^(все окна^) и запустите скрипт снова.
    pause
    exit /b 1
)

echo Запускаю браузер с портом отладки %PORT%...
start "" "%BROWSER%" --remote-debugging-port=%PORT%

rem даём браузеру подняться и проверяем, что порт действительно открылся
timeout /t 5 /nobreak >nul
netstat -ano | findstr /R /C:"LISTENING.*:%PORT% " >nul
if errorlevel 1 (
    echo [!] Порт %PORT% не открылся. Проверьте, что браузер запустился.
) else (
    echo [ok] Порт %PORT% слушает. Теперь работают скрипты проекта:
    echo      python cdp.py tabs
)
pause
