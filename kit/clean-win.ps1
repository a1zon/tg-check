# Убрать аккаунт с этого компьютера. Windows.
#
# Telegram хранит аккаунт в файлах, а не «в программе»: стереть файлы — и на
# этом компьютере аккаунта больше нет. Выход из аккаунта в самом Telegram для
# этого НЕ годится и прямо вреден: ключ у Desktop и у панели один, выход
# отзовёт сессию целиком, и панель потеряет аккаунт.
$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $PSScriptRoot

$title = 'этот аккаунт'
try {
  $cfg = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'kit.json') -Encoding UTF8 | ConvertFrom-Json
  if ($cfg.title) { $title = $cfg.title }
} catch {}

Write-Host ''
Write-Host "Уберу «$title» с этого компьютера." -ForegroundColor Yellow
Write-Host ''
Write-Host 'Что будет сделано:'
Write-Host '  • закроется Telegram, запущенный из этой папки;'
Write-Host '  • удалятся файлы аккаунта и настройки — папки tdata и workdir.'
Write-Host ''
Write-Host 'Из аккаунта НЕ выходим: в панели он продолжит работать как ни в чём'
Write-Host 'не бывало. Пропадёт только копия на этом компьютере.'
Write-Host ''
$ok = Read-Host 'Убираем? Напиши да и нажми Enter'
# принимаем и латиницей: человек может не переключить раскладку
if ($ok -notmatch '^\s*(да|da|yes|y|д|ok|ок|\+)\s*$') {
  Write-Host 'Ничего не трогал.'
  Read-Host 'Enter — закрыть'
  exit 0
}

# Закрываем только тот Telegram, который открыт из этой папки: чужой личный
# Telegram человека трогать нельзя.
$mine = 0
try {
  Get-CimInstance Win32_Process -Filter "Name='Telegram.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($PSScriptRoot) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $mine++ }
} catch {}
if ($mine) { Write-Host "  закрыл Telegram ($mine шт.), жду 5 секунд…"; Start-Sleep -Seconds 5 }

foreach ($p in @('workdir', 'tdata', 'kit.json')) {
  $full = Join-Path $PSScriptRoot $p
  if (Test-Path -LiteralPath $full) {
    Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-Host ("  " + $p + ": " + $(if (Test-Path -LiteralPath $full) { 'НЕ УДАЛИЛОСЬ' } else { 'удалено' }))
}

Write-Host ''
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'tdata')) {
  Write-Host 'Что-то осталось — похоже, Telegram ещё держит файлы.' -ForegroundColor Red
  Write-Host 'Закрой его полностью (значок у часов → Quit) и запусти этот файл снова.'
} else {
  Write-Host 'Готово: аккаунта на этом компьютере больше нет.' -ForegroundColor Green
  Write-Host 'Осталось удалить саму папку — перетащи её в корзину.'
}
Write-Host ''
Read-Host 'Enter — закрыть'
