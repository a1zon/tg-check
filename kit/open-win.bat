@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-win.ps1"
if errorlevel 1 (
  echo.
  echo Что-то пошло не так. Весь текст выше — пришли его, по нему видно причину.
  echo.
  pause
)
