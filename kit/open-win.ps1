# Открыть аккаунт в Telegram Desktop через его прокси. Windows.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

# Окно не должно исчезать молча. Любая непредвиденная ошибка — это «чёрный
# экран мигнул и пропал» на том конце, и разбираться не с чем. Ловим всё,
# что не поймали по дороге, показываем человеку и ждём, пока он прочтёт.
trap {
  Write-Host ''
  Write-Host 'Сбой при запуске:' -ForegroundColor Red
  Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
  if ($_.InvocationInfo) {
    Write-Host "  строка $($_.InvocationInfo.ScriptLineNumber) в $(Split-Path -Leaf $_.InvocationInfo.ScriptName)"
  }
  Write-Host ''
  Write-Host 'Пришли этот текст — по нему сразу видно причину.'
  Write-Host ''
  Read-Host 'Enter — закрыть'
  exit 1
}

$cfg  = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'kit.json') -Encoding UTF8 | ConvertFrom-Json
$port = [int]$cfg.listen
$work = Join-Path $PSScriptRoot 'workdir'
$self = (Get-Process -Id $PID).Path          # тот же PowerShell, в котором мы сами
# Путь к мосту — полный. Set-Location меняет папку только для самого
# PowerShell; у процессов, которые он запускает, рабочая папка остаётся
# прежней, и короткое «bridge.ps1» у них не находится. Пока комплект
# запускают двойным щелчком, это совпадает, а из командной строки — уже нет.
$bridgePs = Join-Path $PSScriptRoot 'bridge.ps1'

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
# Ярлык в меню «Пуск» установщик Telegram создаёт всегда, и в нём записан
# настоящий путь — даже если человек поставил программу в своё место.
if (-not $tg) {
  $lnks = @("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Telegram Desktop\Telegram.lnk",
            "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Telegram Desktop\Telegram.lnk")
  foreach ($l in $lnks) {
    if (-not (Test-Path -LiteralPath $l)) { continue }
    try {
      $target = (New-Object -ComObject WScript.Shell).CreateShortcut($l).TargetPath
      if ($target -and (Test-Path -LiteralPath $target)) { $tg = $target; break }
    } catch {}
  }
}

if (-not $tg) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  # where.exe, ничего не найдя, пишет «INFO: Could not find files...» в поток
  # ошибок и выходит с единицей. При ErrorActionPreference = Stop это не
  # «ничего не нашлось», а обрыв всего скрипта — причём именно у того, у кого
  # Telegram лежит нестандартно, то есть ровно у того, кому нужна подсказка.
  $w = $null
  try { $w = (& where.exe Telegram.exe 2>$null | Select-Object -First 1) } catch {}
  $ErrorActionPreference = $prev
  if ($w -and (Test-Path -LiteralPath $w)) { $tg = $w }
}

if (-not $tg) {
  Die ("Не найден Telegram Desktop. Искал здесь:`n  " + ($looked -join "`n  ") +
       "`n`nЧто делать:`n" +
       "  1. Поставь Telegram Desktop с desktop.telegram.org (версия из Microsoft Store не подходит: она не умеет открывать чужую папку с аккаунтом).`n" +
       "  2. Если он уже стоит — найди, где именно: правой кнопкой по ярлыку Telegram,\n" +
       "     «Расположение файла». Положи эту папку комплекта туда же и запусти снова.")
}
Write-Host "Telegram Desktop: $tg"

Write-Host ''
Write-Host "Аккаунт: $($cfg.title)"

# Комплект собран без прокси: мост не нужен, аккаунт открывается сразу.
# Каким адресом он выйдет, решает сам компьютер — обычно это VPN у человека.
if (-not $cfg.proxy) {
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $work 'tdata') | Out-Null
  Copy-Item -Recurse -Force -Path (Join-Path $PSScriptRoot 'tdata\*') -Destination (Join-Path $work 'tdata')
  Write-Host 'Прокси в комплекте нет — выйдет тем адресом, что сейчас у компьютера.'
  Write-Host 'Если нужен другой адрес, включи свой VPN ДО запуска.'
  Write-Host ''
  Write-Host "Открываю «$($cfg.title)»."
  Write-Host 'ИЗ АККАУНТА НЕ ВЫХОДИТЬ — выход отзовёт сессию и панель потеряет аккаунт.'
  Write-Host ''
  Start-Process -FilePath $tg -ArgumentList @('-workdir', "`"$work`"") -Wait
  Write-Host ''
  Write-Host 'Telegram закрыт.'
  exit 0
}

Write-Host 'Проверяю прокси…'
# Отдельный процесс падением не «бросается»: PowerShell не делает из чужого
# кода ошибку, как бы ни был настроен ErrorActionPreference. Поэтому смотрим
# код возврата сами — иначе мёртвый прокси проскакивал бы молча, а человек
# видел бы потом невнятное «мост не поднялся».
#
# А вот слить его ругань к себе (2>&1) при ErrorActionPreference = Stop нельзя
# в лоб: каждая строка чужого stderr превращается в ошибку, которая обрывает
# скрипт прямо здесь. Человек вместо понятного «прокси не отвечает» получал
# простыню из .NET. Поэтому на время вызова поблажка.
# Мобильный прокси раз в несколько минут меняет адрес, и на это время модем
# уходит из сети: шлюз отвечает 502, соединения рвутся. Длится это полминуты.
# Сдаваться с первой попытки — значит гонять человека «запусти ещё раз»
# ровно тогда, когда достаточно подождать.
$out = $null; $code = 1
foreach ($try in 1..3) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = & $self -NoProfile -ExecutionPolicy Bypass -File $bridgePs -Check 2>&1
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($code -eq 0) { break }
  if ($try -lt 3) {
    Write-Host "  не ответил (попытка $try из 3) — похоже, модем меняет адрес. Жду 20 секунд…"
    Start-Sleep -Seconds 20
  }
}
if ($code -ne 0) {
  Die ("Прокси не отвечает: " + (($out | Out-String).Trim()) +
       "`n`nTelegram без прокси не запускаю — иначе аккаунт выйдет с твоего IP." +
       "`nПробовал три раза за минуту. Подожди пару минут и запусти снова.")
}
Write-Host "  прокси в порядке: $(($out | Select-Object -Last 1))"

$bridge = Start-Process -FilePath $self -PassThru -WindowStyle Hidden `
  -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$bridgePs`""

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
  # Путь в кавычках. Start-Process склеивает аргументы через пробел и сам
  # ничего не заключает в кавычки: комплект, распакованный в «Рабочий стол»
  # или любую папку с пробелом в имени, разъезжался на два аргумента, и
  # Telegram открывался СО СВОЕЙ обычной папкой — без нашего аккаунта.
  $tgArgs = @('-workdir', "`"$work`"", '--', "tg://socks?server=127.0.0.1&port=$port")

  # Первый запуск — ПУСТОЙ Telegram. Ключ у Desktop и у панели один: если
  # Desktop выйдет в сеть с домашнего IP, а панель ходит через прокси, Telegram
  # увидит одну авторизацию из двух стран — с этого начинается отзыв сессии.
  # Поэтому прокси включаем на пустой папке, где светить ещё нечего.
  if (-not (Test-Path -LiteralPath (Join-Path $work 'tdata\settingss'))) {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $work 'tdata')
    Write-Host ''
    Write-Host 'ПЕРВЫЙ ЗАПУСК. Сейчас откроется ПУСТОЙ Telegram — без аккаунта.'
    Write-Host 'Так задумано: прокси надо включить ДО того, как в него попадёт аккаунт.'
    Write-Host ''
    Write-Host 'В окне Telegram сделай это один раз:' -ForegroundColor Yellow
    Write-Host '  Settings (шестерёнка) → Advanced → Connection type →'
    Write-Host '  Use custom proxy → Add proxy → SOCKS5'
    Write-Host "     Hostname: 127.0.0.1"
    Write-Host "     Port:     $port"
    Write-Host '  Save. Логин и пароль не нужны.'
    Write-Host ''
    Write-Host 'Потом закрой окно Telegram — аккаунт добавится следующим шагом.'
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
