@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Telegram - панель

echo === Telegram - панель ===

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Не установлен Node.js. Скачай и поставь: https://nodejs.org
  echo Потом запусти этот файл ещё раз.
  pause
  exit /b 1
)

if not exist "node_modules\playwright" (
  echo Первый запуск - устанавливаю Playwright, это займёт пару минут...
  call npm install playwright >nul 2>nul || (echo Не удалось установить playwright & pause & exit /b 1)
  call npx playwright install chromium || (echo Не удалось скачать браузер & pause & exit /b 1)
)

rem Python - главный движок панели: работа с Telegram идёт через Telethon.
rem Плюс базы Excel (openpyxl) и TDATA (opentele). Ставим один раз в venv-tg.
set PYV=venv-tg\Scripts\python.exe
rem ищем, чем создавать venv: сначала лаунчер py, потом просто python
set PYCMD=
where py >nul 2>nul && set PYCMD=py -3
if not defined PYCMD ( where python >nul 2>nul && set PYCMD=python )
if not exist "%PYV%" (
  if not defined PYCMD (
    echo ВНИМАНИЕ: не найден Python - без него панель работать не будет.
    echo Поставь Python 3.10-3.13 с https://python.org ^(галочка "Add Python to PATH"^).
  ) else (
    echo Первый запуск - ставлю Python-зависимости ^(openpyxl opentele telethon python-socks qrcode^)...
    call %PYCMD% -m venv venv-tg || (echo Не удалось создать venv-tg & pause)
    call "%PYV%" -m pip install -q --upgrade pip
    call "%PYV%" -m pip install -q openpyxl opentele telethon python-socks qrcode || (echo Не удалось поставить зависимости & pause)
    call "%PYV%" patch-opentele.py
  )
) else (
  rem venv с прошлых версий: Telethon туда ещё не ставился - дольём
  "%PYV%" -c "import telethon, qrcode, python_socks" >nul 2>nul || (
    echo Обновляю Python-зависимости ^(Telethon^)...
    call "%PYV%" -m pip install -q openpyxl opentele telethon python-socks qrcode
  )
)

rem ffmpeg - только для голосовых: переводит аудио в формат заметки Telegram.
rem Без него панель работает, голосовое надо грузить готовым .ogg.
where ffmpeg >nul 2>nul || echo Подсказка: для голосовых нужен ffmpeg (ffmpeg.org). Без него грузи .ogg.

rem первый запуск: панель без пароля не поднимается, спрашиваем его здесь
if not exist "auth.json" (
  echo.
  echo Первый запуск - придумай вход в панель.
  set /p PANEL_USER="  Логин: "
  set /p PANEL_PASS="  Пароль (не короче 8 символов): "
  call node set-password.mjs "%PANEL_USER%" "%PANEL_PASS%" || (pause & exit /b 1)
  echo.
)

echo Открываю панель в браузере...
echo Чтобы остановить - закрой это окно.
echo.
node admin.mjs
