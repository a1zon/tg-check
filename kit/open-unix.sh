#!/bin/sh
# Открыть аккаунт в Telegram Desktop через его прокси. macOS и Linux.
#
# Что делает: поднимает мост (прокси с паролем -> SOCKS5 для Desktop), первый
# раз запускает ПУСТОЙ Telegram, чтобы прокси включился до того, как аккаунт
# выйдет в сеть, и только потом кладёт в папку сам аккаунт.
set -e
cd "$(dirname "$0")"
WORK="$PWD/workdir"

say() { printf '%s\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n\n' "$*" >&2; printf 'Окно можно закрыть.\n'; exit 1; }

PY=""
for c in python3 /usr/bin/python3 /usr/local/bin/python3 /opt/homebrew/bin/python3; do
  command -v "$c" >/dev/null 2>&1 && { PY="$c"; break; }
done
[ -n "$PY" ] || die "Не найден Python 3 — без него не поднять мост до прокси.
  macOS:  xcode-select --install
  Linux:  sudo apt install python3"

read_cfg() { "$PY" -c "import json,sys;print(json.load(open('kit.json')).get(sys.argv[1],''))" "$1"; }
PORT="$(read_cfg listen)"
TITLE="$(read_cfg title)"

# ── где Telegram Desktop ─────────────────────────────────────────────────────
# На маке важно не спутать с нативным клиентом Telegram для macOS: он формата
# tdata не понимает и -workdir не умеет, поэтому сверяем идентификатор.
TG=""
if [ "$(uname -s)" = "Darwin" ]; then
  for app in "/Applications/Telegram Desktop.app" "/Applications/Telegram.app" \
             "$HOME/Applications/Telegram Desktop.app" "$HOME/Applications/Telegram.app"; do
    bin="$app/Contents/MacOS/Telegram"
    [ -x "$bin" ] || continue
    id="$(defaults read "$app/Contents/Info.plist" CFBundleIdentifier 2>/dev/null || true)"
    [ "$id" = "com.tdesktop.Telegram" ] && { TG="$bin"; break; }
  done
  [ -n "$TG" ] || die "Не найден Telegram Desktop.
Если стоит «Telegram» из App Store — это другое приложение, оно tdata не читает.
Поставь именно Telegram Desktop:
    brew install --cask telegram-desktop
или скачай с desktop.telegram.org и положи в «Программы»."
else
  for c in telegram-desktop Telegram telegram /opt/Telegram/Telegram \
           /usr/bin/telegram-desktop /snap/bin/telegram-desktop; do
    p="$(command -v "$c" 2>/dev/null || true)"
    [ -n "$p" ] && { TG="$p"; break; }
    [ -x "$c" ] && { TG="$c"; break; }
  done
  if [ -z "$TG" ] && command -v flatpak >/dev/null 2>&1 &&
     flatpak info org.telegram.desktop >/dev/null 2>&1; then
    TG="flatpak-telegram"
  fi
  [ -n "$TG" ] || die "Не найден Telegram Desktop. Поставь его:
    sudo snap install telegram-desktop
или скачай с desktop.telegram.org и распакуй в /opt/Telegram."
fi

run_tg() {
  if [ "$TG" = "flatpak-telegram" ]; then
    flatpak run org.telegram.desktop -- -workdir "$WORK" -- "tg://socks?server=127.0.0.1&port=$PORT"
  else
    "$TG" -workdir "$WORK" -- "tg://socks?server=127.0.0.1&port=$PORT"
  fi
}

# ── мост ─────────────────────────────────────────────────────────────────────
say ""
say "Аккаунт: $TITLE"
say "Поднимаю мост до прокси…"
"$PY" bridge.py &
BRIDGE=$!
trap 'kill "$BRIDGE" 2>/dev/null || true' EXIT INT TERM

i=0
while [ "$i" -lt 60 ]; do
  kill -0 "$BRIDGE" 2>/dev/null || die "Мост не поднялся — смотри строки выше."
  "$PY" -c "import socket,sys;s=socket.socket();s.settimeout(1);sys.exit(s.connect_ex(('127.0.0.1',$PORT)))" \
    && break
  i=$((i + 1)); sleep 1
done
[ "$i" -lt 60 ] || die "Мост не ответил за минуту."

mkdir -p "$WORK"

# ── шаг 1: пустой Telegram, чтобы включить прокси ────────────────────────────
# Ключ у Desktop и у панели один. Если Desktop выйдет в Telegram с домашнего IP,
# а панель ходит через прокси, Telegram увидит одну авторизацию из двух стран —
# с этого обычно и начинается отзыв сессии. Поэтому прокси включаем на пустой
# папке, где светить ещё нечего.
if [ ! -f "$WORK/tdata/settingss" ]; then
  rm -rf "$WORK/tdata"
  say ""
  say "ПЕРВЫЙ ЗАПУСК. Сейчас откроется ПУСТОЙ Telegram — без аккаунта."
  say "В окне подтверди «Включить прокси» (Enable proxy) и закрой окно: ⌘Q или Ctrl+Q."
  say "Аккаунт добавится следующим шагом, уже через прокси."
  say ""
  run_tg || true
  [ -f "$WORK/tdata/settingss" ] || die "Telegram закрылся, ничего не сохранив.
Запусти ещё раз и в окне включи прокси, прежде чем закрывать."
fi

# ── шаг 2: кладём аккаунт и запускаем ────────────────────────────────────────
# Файлы аккаунта ДОКЛАДЫВАЕМ, а не заменяем папку: рядом лежат настройки
# Desktop (settingss) с включённым прокси — потеряем их, и следующий запуск
# пойдёт напрямую.
mkdir -p "$WORK/tdata"
cp -R tdata/. "$WORK/tdata/"
say ""
say "Открываю «$TITLE». Весь трафик идёт через прокси аккаунта."
say "Закрывать окно только через ⌘Q / Ctrl+Q. ИЗ АККАУНТА НЕ ВЫХОДИТЬ —"
say "выход отзовёт сессию и панель потеряет аккаунт."
say ""
run_tg || true

say ""
say "Telegram закрыт, мост выключен."
