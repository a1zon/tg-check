@echo off
chcp 65001 >nul
if exist "%~dp0pult-win.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pult-win.ps1"
  if errorlevel 1 pause
) else (
  echo.
  echo  СТОП: этот файл запущен прямо из архива.
  echo  Windows вытащил только его, а аккаунт и скрипты остались внутри архива.
  echo.
  echo  Как правильно:
  echo    1. Закрой это окно.
  echo    2. Правой кнопкой по скачанному архиву — «Извлечь все...» — «Извлечь».
  echo    3. Откроется распакованная папка — запусти этот же файл уже в ней.
  echo.
  pause
)
