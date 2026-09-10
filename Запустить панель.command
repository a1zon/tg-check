#!/bin/bash
# Двойной клик по этому файлу поднимает панель. Терминал не нужен.
cd "$(dirname "$0")" || exit 1

echo "=== Telegram — пульт ==="

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Не установлен Node.js. Скачай и поставь: https://nodejs.org"
  echo "Потом запусти этот файл ещё раз."
  read -n1 -r -p "Нажми любую клавишу…"
  exit 1
fi

# первый запуск на новой машине: доставляем зависимости
if [ ! -d node_modules/playwright ]; then
  echo "Первый запуск — устанавливаю Playwright, это займёт пару минут…"
  npm install playwright >/dev/null 2>&1 || { echo "Не удалось установить playwright"; read -n1 -r; exit 1; }
  npx playwright install chromium || { echo "Не удалось скачать браузер"; read -n1 -r; exit 1; }
fi

# Python — главный движок панели: вся работа с Telegram идёт через Telethon.
# Плюс базы Excel (openpyxl) и импорт TDATA (opentele). Ставим один раз
# в venv-tg, системный Python не трогаем.
PYV="venv-tg/bin/python"
if [ ! -x "$PYV" ]; then
  PY=""
  for c in python3.13 python3.12 python3.11 python3.10 python3; do
    command -v "$c" >/dev/null 2>&1 && { PY="$c"; break; }
  done
  if [ -z "$PY" ]; then
    echo "ВНИМАНИЕ: не найден Python — без него панель работать не будет:"
    echo "проверка номеров и рассылка идут через него."
    echo "Поставь Python 3.10-3.13 с https://python.org и запусти файл заново."
    echo
  else
    echo "Первый запуск — ставлю Python-зависимости (openpyxl opentele telethon python-socks qrcode)…"
    "$PY" -m venv venv-tg && \
      "$PYV" -m pip install -q --upgrade pip && \
      "$PYV" -m pip install -q openpyxl opentele telethon python-socks qrcode && \
      "$PYV" patch-opentele.py || echo "Не удалось поставить Python-зависимости"
  fi
# venv с прошлых версий: Telethon и QR туда ещё не ставились — дольём
elif ! "$PYV" -c "import telethon, qrcode, python_socks" >/dev/null 2>&1; then
  echo "Обновляю Python-зависимости (Telethon)…"
  "$PYV" -m pip install -q openpyxl opentele telethon python-socks qrcode || echo "Не удалось обновить Python-зависимости"
fi

# ffmpeg — только для голосовых: переводит любой аудиофайл в формат заметки
# Telegram. Без него панель работает, просто голосовое надо грузить готовым .ogg.
if ! command -v ffmpeg >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "Ставлю ffmpeg (для голосовых)…"
    brew install ffmpeg >/dev/null 2>&1 || echo "ffmpeg не поставился — голосовое можно грузить готовым .ogg"
  else
    echo "Подсказка: для голосовых нужен ffmpeg (brew install ffmpeg). Без него грузи .ogg."
  fi
fi

# первый запуск: панель без пароля не поднимается, спрашиваем его здесь
if [ ! -f auth.json ]; then
  echo
  echo "Первый запуск — придумай вход в панель."
  read -r -p "  Логин: " PANEL_USER
  read -rs -p "  Пароль (не короче 8 символов): " PANEL_PASS; echo
  node set-password.mjs "$PANEL_USER" "$PANEL_PASS" || { read -n1 -r -p "Нажми любую клавишу…"; exit 1; }
  echo
fi

# освобождаем порт от забытого прошлого запуска
lsof -ti tcp:8787 | xargs kill 2>/dev/null

echo "Открываю панель в браузере…"
echo "Чтобы остановить — закрой это окно."
echo
node admin.mjs
