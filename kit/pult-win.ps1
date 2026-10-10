# Пульт: меню по аккаунтам. Каждый аккаунт — обычный комплект в папке
# akkaunty\, со своей папкой данных. Меню только запускает «Открыть аккаунт»
# нужной подпапки, поэтому всё, что проверено для одного аккаунта, работает и
# здесь, а у каждого своё окно — ограничения в три аккаунта на окно нет.
$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $PSScriptRoot
$base = Join-Path $PSScriptRoot 'akkaunty'

function Title($dir) {
  $t = Split-Path -Leaf $dir
  try {
    $cfg = Get-Content -Raw -LiteralPath (Join-Path $dir 'kit.json') -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.title) { $t = $cfg.title }
  } catch {}
  return $t
}

while ($true) {
  $kits = @(Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name)
  if (-not $kits.Count) {
    Write-Host ''
    Write-Host 'В папке «akkaunty» нет ни одного аккаунта.' -ForegroundColor Red
    Read-Host 'Enter — закрыть'; exit 1
  }

  Write-Host ''
  Write-Host '════════ АККАУНТЫ ════════' -ForegroundColor Cyan
  $map = @{}
  for ($i = 0; $i -lt $kits.Count; $i++) {
    $n = $i + 1
    $map[$n] = $kits[$i].FullName
    $open = Test-Path -LiteralPath (Join-Path $kits[$i].FullName 'workdir\tdata')
    $mark = if ($open) { '  (уже заходили)' } else { '' }
    Write-Host ("  {0}. {1}{2}" -f $n, (Title $kits[$i].FullName), $mark)
  }
  Write-Host ''
  Write-Host '  номер — открыть аккаунт'
  Write-Host '  У + номер — убрать аккаунт с компьютера (например: У2)'
  Write-Host '  0 — выход'
  Write-Host ''
  $c = (Read-Host 'Что делаем').Trim()

  if ($c -eq '0' -or $c -eq '') { exit 0 }

  # убрать аккаунт: У2 / U2 / у 2
  $m = [regex]::Match($c, '^[УуUu]\s*(\d+)$')
  if ($m.Success) {
    $n = [int]$m.Groups[1].Value
    if ($map.ContainsKey($n)) {
      $bat = Join-Path $map[$n] 'Убрать аккаунт с компьютера.bat'
      if (Test-Path -LiteralPath $bat) { & $bat } else { Write-Host 'в этом аккаунте нет файла очистки' -ForegroundColor Red }
    } else { Write-Host 'нет такого номера' -ForegroundColor Red }
    continue
  }

  # открыть аккаунт. Запускаем ОТДЕЛЬНЫМ окном и сразу возвращаемся в меню —
  # так можно открыть сколько угодно аккаунтов, каждый в своём окне.
  if ($c -match '^\d+$' -and $map.ContainsKey([int]$c)) {
    $bat = Join-Path $map[[int]$c] 'Открыть аккаунт.bat'
    if (Test-Path -LiteralPath $bat) {
      Write-Host ("Открываю «" + (Title $map[[int]$c]) + "» — окно появится отдельно.") -ForegroundColor Green
      Start-Process -FilePath $bat
      Start-Sleep -Seconds 2
    } else {
      Write-Host 'в этом аккаунте нет файла запуска' -ForegroundColor Red
    }
  } else {
    Write-Host 'не понял — введи номер из списка, или 0' -ForegroundColor Red
  }
}
