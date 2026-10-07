# Мост между Telegram Desktop и прокси аккаунта. Windows.
#
# Telegram Desktop не отправляет логин и пароль HTTP-прокси — прокси отвечает
# 407, и клиент не подключается. Desktop ходит в этот мост (SOCKS5 без пароля,
# только 127.0.0.1), а мост добавляет авторизацию и держит связь с прокси.
#
#   powershell -ExecutionPolicy Bypass -File bridge.ps1
#   powershell -ExecutionPolicy Bypass -File bridge.ps1 -Check
param([switch]$Check)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$cfg   = Get-Content -Raw -LiteralPath 'kit.json' -Encoding UTF8 | ConvertFrom-Json
$proxy = $cfg.proxy
$port  = [int]$cfg.listen

# Общий код держим текстом: каждое соединение живёт в своём пространстве
# выполнения, а оно чужих функций не видит — туда их приходится передавать.
$helpers = @'
function Read-Exactly($s, $n) {
  $buf = New-Object byte[] $n; $off = 0
  while ($off -lt $n) {
    $r = $s.Read($buf, $off, $n - $off)
    if ($r -le 0) { throw 'соединение оборвалось' }
    $off += $r
  }
  return $buf
}

function Get-AuthHeader($p) {
  if (-not $p.user) { return '' }
  $raw = [Text.Encoding]::UTF8.GetBytes("$($p.user):$($p.pass)")
  return "Proxy-Authorization: Basic " + [Convert]::ToBase64String($raw) + "`r`n"
}

# Соединение до target:tport через прокси аккаунта. Возвращает TcpClient —
# поток берётся из него.
function Connect-Upstream($p, $target, $tport) {
  $up = New-Object Net.Sockets.TcpClient
  # с таймаутом: без него молчащий прокси держит окно минутами, и человек
  # видит пустоту вместо понятного «прокси не ответил»
  $up.SendTimeout = 20000; $up.ReceiveTimeout = 20000
  if (-not $up.ConnectAsync($p.host, [int]$p.port).Wait(20000)) {
    $up.Close(); throw "прокси $($p.host):$($p.port) не отвечает"
  }
  $us = $up.GetStream()
  try {
    if ("$($p.scheme)".StartsWith('socks')) {
      if ($p.user) {
        $us.Write([byte[]](5, 2, 0, 2), 0, 4)
        $m = Read-Exactly $us 2
        if ($m[1] -eq 2) {
          $u = [Text.Encoding]::UTF8.GetBytes([string]$p.user)
          $w = [Text.Encoding]::UTF8.GetBytes([string]$p.pass)
          $pkt = (,[byte]1) + (,[byte]$u.Length) + $u + (,[byte]$w.Length) + $w
          $us.Write($pkt, 0, $pkt.Length)
          if ((Read-Exactly $us 2)[1] -ne 0) { throw 'прокси не принял логин и пароль' }
        } elseif ($m[1] -ne 0) { throw 'прокси не поддерживает вход по логину и паролю' }
      } else {
        $us.Write([byte[]](5, 1, 0), 0, 3)
        [void](Read-Exactly $us 2)
      }
      # адрес и порт собираем по байту: [byte[]](...) со счётом внутри скобок
      # PowerShell разбирает не как список байтов, а как одно выражение
      $hb = [Text.Encoding]::ASCII.GetBytes($target)
      $hi = [byte][math]::Floor($tport / 256)
      $lo = [byte]($tport % 256)
      $req = [byte[]](5, 1, 0, 3) + (,[byte]$hb.Length) + $hb + (,$hi) + (,$lo)
      $us.Write($req, 0, $req.Length)
      $rep = Read-Exactly $us 4
      if ($rep[1] -ne 0) { throw "прокси отказал: код $($rep[1])" }
      $skip = switch ($rep[3]) { 1 { 4 } 4 { 16 } default { (Read-Exactly $us 1)[0] } }
      [void](Read-Exactly $us ($skip + 2))
    } else {
      $req = "CONNECT ${target}:${tport} HTTP/1.1`r`nHost: ${target}:${tport}`r`n" +
             (Get-AuthHeader $p) + "Proxy-Connection: Keep-Alive`r`n`r`n"
      $b = [Text.Encoding]::ASCII.GetBytes($req)
      $us.Write($b, 0, $b.Length); $us.Flush()
      $line = New-Object Text.StringBuilder          # ответ читаем до пустой строки
      while ($true) {
        $ch = $us.ReadByte()
        if ($ch -lt 0) { throw 'прокси закрыл соединение' }
        [void]$line.Append([char]$ch)
        if ($line.ToString().EndsWith("`r`n`r`n")) { break }
      }
      $status = ($line.ToString() -split "`r`n")[0]
      if ($status -notmatch '^HTTP/1\.[01] 200') { throw "прокси ответил «$status»" }
    }
  } catch {
    $up.Close(); throw
  }
  return $up
}

# Жив ли прокси и принял ли он пароль. Через HTTP-прокси заодно спрашиваем,
# какой IP видно снаружи. Через socks ограничиваемся открытым туннелем до
# Telegram: читать ответ сквозь туннель PowerShell не умеет без зависаний,
# а доказать нужно одно — прокси работает и пускает.
function Test-Proxy($p) {
  if ("$($p.scheme)".StartsWith('socks')) {
    (Connect-Upstream $p 'api.telegram.org' 443).Close()
    return 'соединение до Telegram открылось'
  }
  $c = New-Object Net.Sockets.TcpClient
  $c.SendTimeout = 20000; $c.ReceiveTimeout = 20000
  if (-not $c.ConnectAsync($p.host, [int]$p.port).Wait(20000)) {
    $c.Close(); throw "прокси $($p.host):$($p.port) не отвечает"
  }
  $s = $c.GetStream()
  $req = "GET http://api.ipify.org/ HTTP/1.1`r`nHost: api.ipify.org`r`n" +
         (Get-AuthHeader $p) + "Connection: close`r`n`r`n"
  $b = [Text.Encoding]::ASCII.GetBytes($req)
  $s.Write($b, 0, $b.Length); $s.Flush()
  $all = (New-Object IO.StreamReader($s)).ReadToEnd()
  $c.Close()
  if ($all -notmatch '(?m)^HTTP/1\.[01] 200') { throw "прокси ответил: $(($all -split "`r`n")[0])" }
  return 'наружу видно IP ' + ($all -split "`r`n`r`n", 2)[-1].Trim()
}
'@
Invoke-Expression $helpers

if ($Check) { Test-Proxy $proxy; exit 0 }

try {
  $ip = Test-Proxy $proxy
  Write-Host "  прокси в порядке: $ip"
} catch {
  Write-Host "  прокси не ответил: $($_.Exception.Message)"
  Write-Host "  Telegram без прокси не запускаю — иначе аккаунт выйдет с твоего IP."
  exit 2
}

$handler = {
  param($client, $p, $helpers)
  Invoke-Expression $helpers
  $up = $null
  try {
    $cs = $client.GetStream()
    $hello = Read-Exactly $cs 2                      # привет SOCKS5
    [void](Read-Exactly $cs $hello[1])
    $cs.Write([byte[]](5, 0), 0, 2)                  # без пароля — мы на 127.0.0.1

    $head = Read-Exactly $cs 4
    if ($head[1] -ne 1) { throw 'мост умеет только обычное соединение' }
    switch ($head[3]) {
      1 { $target = ([Net.IPAddress](Read-Exactly $cs 4)).ToString() }
      3 { $ln = (Read-Exactly $cs 1)[0]
          $target = [Text.Encoding]::ASCII.GetString((Read-Exactly $cs $ln)) }
      4 { $target = ([Net.IPAddress](Read-Exactly $cs 16)).ToString() }
      default { throw 'непонятный адрес' }
    }
    $pb = Read-Exactly $cs 2
    $tport = [int]$pb[0] * 256 + [int]$pb[1]

    $up = Connect-Upstream $p $target $tport
    $us = $up.GetStream()
    $cs.Write([byte[]](5, 0, 0, 1, 0, 0, 0, 0, 0, 0), 0, 10)

    $t1 = $cs.CopyToAsync($us)
    $t2 = $us.CopyToAsync($cs)
    [void][Threading.Tasks.Task]::WaitAny(@($t1, $t2))
  } catch {
    try { $cs.Write([byte[]](5, 1, 0, 1, 0, 0, 0, 0, 0, 0), 0, 10) } catch {}
  } finally {
    if ($up) { $up.Close() }
    $client.Close()
  }
}

$pool = [runspacefactory]::CreateRunspacePool(1, 24)
$pool.Open()
$listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $port)
$listener.Start()
Write-Host "  мост слушает 127.0.0.1:$port"

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    $ps = [powershell]::Create()
    $ps.RunspacePool = $pool
    [void]$ps.AddScript($handler).AddArgument($client).AddArgument($proxy).AddArgument($helpers)
    [void]$ps.BeginInvoke()
  }
} finally {
  $listener.Stop(); $pool.Close()
}
