@echo off
chcp 65001 >nul
rem ─────────────────────────────────────────────────────────────────────────
rem  Все проверки проекта разом.
rem
rem  Как пользоваться: двойной клик по этому файлу. Ничего не меняется и никуда
rem  не пишется — ни база ответов, ни файлы расширения; проверки на то и
rem  проверки, чтобы их можно было гонять сколько угодно.
rem
rem  Что проверяется:
rem    test_norm_parity.py    — правила сравнения текста совпадают в браузере
rem                             (normalize.js) и в скриптах (qa_norm.py)
rem    test_content_logic.js  — поиск вопроса на странице: кавычки, формулы,
rem                             примерное совпадение
rem    test_popup_logic.js    — окно расширения считает ключ той же функцией,
rem                             что и страница
rem    test_scripts_fixture.py — слияние и чистка базы на КОПИИ базы
rem ─────────────────────────────────────────────────────────────────────────
setlocal
cd /d "%~dp0.."

where python >nul 2>&1
if errorlevel 1 (
    echo [!] Не найден python. Установите Python и добавьте его в PATH.
    pause
    exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
    echo [!] Не найден node. Проверки расширения без него не запустить.
    pause
    exit /b 1
)

set failed=0

echo === Паритет правил: браузер и скрипты ===================================
python tests\test_norm_parity.py || set failed=1
echo.

echo === Поиск ответа на странице ============================================
node tests\test_content_logic.js || set failed=1
echo.

echo === Окно расширения =====================================================
node tests\test_popup_logic.js || set failed=1
echo.

echo === Слияние и чистка базы ===============================================
python tests\test_scripts_fixture.py || set failed=1
echo.

if "%failed%"=="1" (
    echo [!] Что-то не сошлось — смотрите пометки ❌ выше.
) else (
    echo Всё сошлось.
)
echo.
pause
