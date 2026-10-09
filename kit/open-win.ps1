# Открыть аккаунт в Telegram Desktop через его прокси. Windows.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$cfg  = Get-Content -Raw -LiteralPath 'kit.json' -Encoding UTF8 | ConvertFrom-Json
$port = [int]$cfg.listen
$work = Join-Path $PSScriptRoot 'workdir'
$self = (Get-Process -Id $PID).Path          # тот же PowerShell, в котором мы сами

function Die($msg) {
  Write-Host ''
  Write-Host $msg -ForegroundColor Red
  Write-Host ''
  Read-Host 'Enter — закрыть'
  exit 1
}

# Telegram Desktop ставится в разные места: у одних в профиль пользователя,
# у других в Program Files, у третьих вообще портативно. Поэтому смотрим все
# обычные места, спрашиваем реестр и PATH — и, если не нашли, честно
# показываем, где искали: так понятно, что делать дальше.
$looked = @(
  "$env:APPDATA\Telegram Desktop\Telegram.exe",
  "$env:LOCALAPPDATA\Programs\Telegram Desktop\Telegram.exe",
  "$env:LOCALAPPDATA\Telegram Desktop\Telegram.exe",
  "$env:ProgramFiles\Telegram Desktop\Telegram.exe",
  "${env:ProgramFiles(x86)}\Telegram Desktop\Telegram.exe",
  "$env:ProgramW6432\Telegram Desktop\Telegram.exe",
  (Join-Path $PSScriptRoot 'Telegram.exe')
) | Where-Object { $_ }

$tg = $looked | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not $tg) {
  # реестр: туда установщик Telegram пишет путь к себе
  foreach ($key in @('HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Telegram.exe',
                     'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Telegram.exe')) {
    try {
      $v = (Get-ItemProperty -Path $key -ErrorAction Stop).'(default)'
      if ($v -and (Test-Path -LiteralPath $v)) { $tg = $v; break }
    } catch {}
  }
}
if (-not $tg) {
  $w = (& where.exe Telegram.exe 2>$null | Select-Object -First 1)
  if ($w -and (Test-Path -LiteralPath $w)) { $tg = $w }
}

if (-not $tg) {
  Die ("Не найден Telegram Desktop. Искал здесь:`n  " + ($looked -join "`n  ") +
       "`n`nЧто делать:`n" +
       "  1. Поставь Telegram Desktop с desktop.telegram.org (версия из Microsoft Store не подходит: она не умеет открывать чужую папку с аккаунтом).`n" +
       "  2. Если он уже стоит — положи этот комплект рядом с Telegram.exe и запусти снова.")
}
Write-Host "Telegram Desktop: $tg"

Write-Host ''
Write-Host "Аккаунт: $($cfg.title)"
Write-Host 'Проверяю прокси…'
try {
  $ip = & $self -NoProfile -ExecutionPolicy Bypass -File 'bridge.ps1' -Check
  Write-Host "  прокси в порядке, наружу видно IP $ip"
} catch {
  Die "Прокси не отвечает: $($_.Exception.Message)`nTelegram без прокси не запускаю — иначе аккаунт выйдет с твоего IP."
}

$bridge = Start-Process -FilePath $self -PassThru -WindowStyle Hidden `
  -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'bridge.ps1'

try {
  $up = $false
  foreach ($i in 1..60) {
    if ($bridge.HasExited) { Die 'Мост не поднялся.' }
    try {
      $probe = New-Object Net.Sockets.TcpClient
      $probe.Connect('127.0.0.1', $port); $probe.Close()
      $up = $true; break
    } catch { Start-Sleep -Seconds 1 }
  }
  if (-not $up) { Die 'Мост не ответил за минуту.' }

  New-Item -ItemType Directory -Force -Path $work | Out-Null
  $tgArgs = @('-workdir', $work, '--', "tg://socks?server=127.0.0.1&port=$port")

  # Первый запуск — ПУСТОЙ Telegram. Ключ у Desktop и у панели один: если
  # Desktop выйдет в сеть с домашнего IP, а панель ходит через прокси, Telegram
  # увидит одну авторизацию из двух стран — с этого начинается отзыв сессии.
  # Поэтому прокси включаем на пустой папке, где светить ещё нечего.
  if (-not (Test-Path -LiteralPath (Join-Path $work 'tdata\settingss'))) {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $work 'tdata')
    Write-Host ''
    Write-Host 'ПЕРВЫЙ ЗАПУСК. Сейчас откроется ПУСТОЙ Telegram — без аккаунта.'
    Write-Host 'В окне подтверди «Включить прокси» (Enable proxy) и закрой окно.'
    Write-Host 'Аккаунт добавится следующим шагом, уже через прокси.'
    Write-Host ''
    Start-Process -FilePath $tg -ArgumentList $tgArgs -Wait
    if (-not (Test-Path -LiteralPath (Join-Path $work 'tdata\settingss'))) {
      Die "Telegram закрылся, ничего не сохранив.`nЗапусти ещё раз и включи прокси, прежде чем закрывать окно."
    }
  }

  # Файлы аккаунта ДОКЛАДЫВАЕМ, а не заменяем папку: рядом лежат настройки
  # Desktop с включённым прокси — потеряем их, и следующий запуск пойдёт напрямую.
  New-Item -ItemType Directory -Force -Path (Join-Path $work 'tdata') | Out-Null
  Copy-Item -Recurse -Force -Path (Join-Path $PSScriptRoot 'tdata\*') -Destination (Join-Path $work 'tdata')

  Write-Host ''
  Write-Host "Открываю «$($cfg.title)». Весь трафик идёт через прокси аккаунта."
  Write-Host 'ИЗ АККАУНТА НЕ ВЫХОДИТЬ — выход отзовёт сессию и панель потеряет аккаунт.'
  Write-Host ''
  Start-Process -FilePath $tg -ArgumentList $tgArgs -Wait
} finally {
  if (-not $bridge.HasExited) { Stop-Process -Id $bridge.Id -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
Write-Host 'Telegram закрыт, мост выключен.'
