# Убрать аккаунт с этого компьютера. Windows.
#
# Telegram хранит аккаунт в файлах, а не «в программе»: стереть файлы — и на
# этом компьютере аккаунта больше нет. Выход из аккаунта в самом Telegram для
# этого НЕ годится и прямо вреден: ключ у Desktop и у панели один, выход
# отзовёт сессию целиком, и панель потеряет аккаунт.
$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $PSScriptRoot

$title = 'этот аккаунт'
$kitId = ''
try {
  $cfg = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'kit.json') -Encoding UTF8 | ConvertFrom-Json
  if ($cfg.title) { $title = $cfg.title }
  if ($cfg.id) { $kitId = $cfg.id }
} catch {}

Write-Host ''
Write-Host "Уберу «$title» с этого компьютера." -ForegroundColor Yellow
Write-Host ''
Write-Host 'Что будет сделано:'
Write-Host '  • закроется Telegram, запущенный из этой папки;'
Write-Host '  • удалятся файлы аккаунта и настройки — папки tdata и workdir;'
Write-Host '  • найдётся и удалится скачанный архив комплекта, если он ещё лежит.'
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

# Закрываем Telegram и мост, открытые ИЗ ЭТОЙ ПАПКИ. Личный Telegram
# человека не трогаем — у него другой путь в командной строке.
function Stop-Mine {
  $n = 0
  foreach ($name in @('Telegram', 'powershell')) {
    try {
      Get-CimInstance Win32_Process -Filter "Name='$name.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($PSScriptRoot) -and $_.ProcessId -ne $PID } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }
    } catch {}
  }
  return $n
}
$mine = Stop-Mine
if ($mine) { Write-Host "  закрыл программы этой папки ($mine шт.), жду 5 секунд…"; Start-Sleep -Seconds 5 }

# Windows не отдаёт файл, пока его держит программа, а Telegram отпускает
# его не мгновенно. Поэтому несколько подходов с паузой, а не один.
function Remove-Hard($full) {
  foreach ($try in 1..5) {
    if (-not (Test-Path -LiteralPath $full)) { return $true }
    Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $full)) { return $true }
    [void](Stop-Mine)
    Start-Sleep -Seconds 2
  }
  return (-not (Test-Path -LiteralPath $full))
}

$left = @()
foreach ($p in @('workdir', 'tdata', 'kit.json')) {
  $full = Join-Path $PSScriptRoot $p
  if (Remove-Hard $full) { Write-Host "  $p : удалено" }
  else { Write-Host "  $p : занято" -ForegroundColor Red; $left += $full }
}

# Совсем упрямые файлы (Telegram не отпускает, антивирус держит) помечаем
# на удаление при перезагрузке — это делает сама Windows, без программ.
if ($left.Count) {
  Write-Host ''
  Write-Host 'Часть файлов занята прямо сейчас. Помечаю их на удаление при перезагрузке…'
  try {
    Add-Type -Namespace W -Name F -MemberDefinition @'
[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern bool MoveFileEx(string a, string b, int f);
'@
    foreach ($f in $left) {
      Get-ChildItem -LiteralPath $f -Recurse -Force -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending |
        ForEach-Object { [void][W.F]::MoveFileEx($_.FullName, $null, 4) }
      [void][W.F]::MoveFileEx($f, $null, 4)
    }
    Write-Host 'Готово: после перезагрузки компьютера они исчезнут сами.' -ForegroundColor Yellow
  } catch {
    Write-Host "Не вышло пометить: $($_.Exception.Message)" -ForegroundColor Red
  }
}

# Копий аккаунта на компьютере обычно несколько: папку распаковывали не раз
# («tg-a2-win (1)»), архив лежит в «Загрузках», внутри папки — ещё одна папка.
# Чистим всё, что относится К ЭТОМУ ЖЕ аккаунту: имя копий начинается с его
# номера, чужие папки под это не попадают.
if ($kitId) {
  $where = @((Split-Path -Parent $PSScriptRoot), "$env:USERPROFILE\Downloads",
             "$env:USERPROFILE\Desktop", "$env:USERPROFILE\OneDrive\Desktop",
             "$env:USERPROFILE\OneDrive\Рабочий стол",
             "$env:USERPROFILE\Загрузки", "$env:USERPROFILE\Рабочий стол") |
           Where-Object { $_ } | Select-Object -Unique

  $found = 0
  foreach ($dir in $where) {
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    # архивы комплекта
    foreach ($z in @(Get-ChildItem -LiteralPath $dir -Filter "tg-$kitId-*.zip" -File -ErrorAction SilentlyContinue)) {
      $found++
      Remove-Item -LiteralPath $z.FullName -Force -ErrorAction SilentlyContinue
      Write-Host ("  архив " + $z.FullName + ": " +
                  $(if (Test-Path -LiteralPath $z.FullName) { 'НЕ УДАЛИЛСЯ' } else { 'удалён' }))
    }
    # другие распаковки того же комплекта, кроме той, из которой нас запустили
    foreach ($f in @(Get-ChildItem -LiteralPath $dir -Filter "tg-$kitId-*" -Directory -ErrorAction SilentlyContinue)) {
      if ($f.FullName -eq $PSScriptRoot) { continue }
      $found++
      if (Remove-Hard $f.FullName) { Write-Host ("  папка " + $f.FullName + ": удалена") }
      else { Write-Host ("  папка " + $f.FullName + ": занята") -ForegroundColor Red; $left += $f.FullName }
    }
  }
  # вложенная копия внутри нашей же папки
  foreach ($f in @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter "tg-$kitId-*" -Directory -ErrorAction SilentlyContinue)) {
    $found++
    if (Remove-Hard $f.FullName) { Write-Host ("  папка " + $f.FullName + ": удалена") }
    else { Write-Host ("  папка " + $f.FullName + ": занята") -ForegroundColor Red; $left += $f.FullName }
  }
  if (-not $found) { Write-Host '  других копий этого аккаунта рядом не нашёл' }
}

Write-Host ''
if ($left.Count) {
  Write-Host 'Аккаунт работать уже не будет, но для чистоты перезагрузи компьютер' -ForegroundColor Yellow
  Write-Host 'и удали папку. Если не хочешь ждать: Ctrl+Shift+Esc → найди Telegram.exe'
  Write-Host '→ «Снять задачу» → запусти этот файл снова.'
} else {
  Write-Host 'Готово: аккаунта на этом компьютере больше нет.' -ForegroundColor Green
  Write-Host 'Осталось удалить саму папку — перетащи её в корзину.'
}
Write-Host ''
Write-Host 'Если архив с комплектом лежит ещё где-то (почта, флешка, другая папка) —'
Write-Host 'удали и его: распакуешь заново, и аккаунт снова окажется на компьютере.'
Write-Host ''
Write-Host 'Из аккаунта мы НЕ выходили: в панели он работает как работал.'
Write-Host ''
Read-Host 'Enter — закрыть'
