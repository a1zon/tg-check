#!/usr/bin/env bash
#
# Заливка панели на сервер и установка там — с этого компьютера, одной командой.
#
#     bash deploy/push.sh root@1.2.3.4
#     bash deploy/push.sh panel@example.com --key ~/.ssh/id_ed25519 --port 2222 --voice
#
# Что уезжает: код панели. Что НЕ уезжает никогда: сессии Telegram, реестр
# аккаунтов, пароль от панели, базы и результаты. Это же правило делает
# безопасным повторный запуск — обновление кода не затирает данные на сервере.
#
#   --key <файл>    ключ SSH (иначе — как настроено в ~/.ssh/config)
#   --port <порт>   порт SSH (по умолчанию 22)
#   --dir <путь>    куда ставить на сервере (по умолчанию /opt/tg-panel)
#   --tdata         доставить opentele/PyQt5 (импорт TDATA)
#   --voice         доставить ffmpeg (голосовые)
#   --no-password   не спрашивать вход в панель — его задаст хозяин сам
#   --code-only     только обновить код и перезапустить службу, без установки
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET=""
PORT=22
KEY=""
REMOTE=/opt/tg-panel
FLAGS=""
CODE_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="${2:?нужен путь к ключу}"; shift ;;
    --port) PORT="${2:?нужен порт}"; shift ;;
    --dir) REMOTE="${2:?нужен путь}"; shift ;;
    --tdata|--voice|--no-password) FLAGS="$FLAGS $1" ;;
    --code-only) CODE_ONLY=1 ;;
    -*) echo "не знаю ключ: $1"; exit 1 ;;
    *) TARGET="$1" ;;
  esac
  shift
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ -n "$TARGET" ] || die "куда ставим? bash deploy/push.sh root@адрес-сервера"
[ -f "$DIR/router.mjs" ] || die "запускать из папки панели"

SSH=(ssh -p "$PORT" -o ConnectTimeout=15)
[ -n "$KEY" ] && SSH+=(-i "$KEY")

say "1/3  Проверяю связь с $TARGET"
# Пароль по SSH запрещаем явно: ему не место ни в скрипте, ни в переписке.
# А вот «сервер видим впервые, принять его ключ?» спросить можно — на новом
# сервере это первое, что спрашивает ssh, и молча падать тут незачем.
if ! "${SSH[@]}" -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no \
     "$TARGET" true; then
  die "не пускает по ключу.
  Вход по паролю тут не годится — пароли не место в скриптах и переписке.
  Заведи ключ и положи его на сервер:
      ssh-keygen -t ed25519            (если ключа ещё нет)
      ssh-copy-id -p $PORT $TARGET     (спросит пароль сервера один раз)
  и запусти push.sh снова."
fi
USER_REMOTE="$("${SSH[@]}" "$TARGET" 'id -un')"
echo "  вошли как $USER_REMOTE"

say "2/3  Копирую код в $REMOTE"
# Готовим место. Под root заводим отдельного пользователя: службе ни к чему
# права, которых она не использует.
OWNER_REMOTE="$("${SSH[@]}" "$TARGET" '
  if [ "$(id -u)" = 0 ]; then
    id tgpanel >/dev/null 2>&1 || useradd -m -s /bin/bash tgpanel
    echo tgpanel
  else
    id -un
  fi')"
[ -n "$OWNER_REMOTE" ] || die "не смог завести пользователя на сервере"
"${SSH[@]}" "$TARGET" "\$( [ \"\$(id -u)\" = 0 ] || echo sudo ) mkdir -p '$REMOTE'"
echo "  папка готова, владелец $OWNER_REMOTE"

# tar на macOS иначе тащит служебные метки Apple, а tar на сервере ругается
# на них десятком строк за файл — в выводе тонет всё остальное
TAR_EXTRA=()
tar --no-mac-metadata --version >/dev/null 2>&1 && TAR_EXTRA+=(--no-mac-metadata)
tar --no-xattrs --version >/dev/null 2>&1 && TAR_EXTRA+=(--no-xattrs)

# Секреты и тяжёлое не возим. Данные на сервере — его собственные, и повторный
# запуск их не трогает: ни одного файла с данными в списке ниже нет.
#
# Тексты писем и список прогрева тоже остаются на сервере: их правят прямо
# в панели, и обновление кода не должно откатывать эту правку. С кодом едет
# только образец warm-list.default.json — рабочий список панель заведёт из него
# сама, если его ещё нет.
tar -C "$DIR" "${TAR_EXTRA[@]}" -czf - \
  --exclude='./venv' --exclude='./venv-tg' --exclude='./node_modules' \
  --exclude='./.git' --exclude='./__pycache__' --exclude='*.pyc' \
  --exclude='./sessions' --exclude='./accounts' --exclude='./desktop' \
  --exclude='./qr' --exclude='./uploads' --exclude='./tg-profile' \
  --exclude='./accounts.json' --exclude='./auth.json' --exclude='./claims.json' \
  --exclude='./numbers.csv' --exclude='./results.csv' --exclude='./drafts.csv' \
  --exclude='./members.csv' --exclude='./chats.json' --exclude='./base.json' \
  --exclude='./replies.json' --exclude='./stats-cache.json' \
  --exclude='./voice.ogg' --exclude='./voice.json' \
  --exclude='./followup.csv' --exclude='./warmup.csv' --exclude='./warmup.json' \
  --exclude='./message-parts.json' --exclude='./message.txt' --exclude='./message2.txt' \
  --exclude='./warm-list.json' --exclude='./leads.json' --exclude='./leads-log.csv' \
  --exclude='*.xlsx' --exclude='*.session' --exclude='./_backup_*' \
  --exclude='./_reset_backup_*' --exclude='.DS_Store' \
  . | "${SSH[@]}" "$TARGET" "tar xzf - --no-same-owner -C '$REMOTE'"
# tar под root восстановил бы владельца из архива — то есть номер пользователя
# с ЭТОГО компьютера, которого на сервере нет. Поэтому и --no-same-owner,
# и явный chown: иначе установка спотыкается о владельца «UNKNOWN».
"${SSH[@]}" "$TARGET" "\$( [ \"\$(id -u)\" = 0 ] || echo sudo ) chown -R '$OWNER_REMOTE' '$REMOTE'"
# Папку закрываем от посторонних: внутри сессии Telegram и реестр аккаунтов.
# Это же разделяет профили — соседняя панель работает от другого пользователя
# и в эту папку не заглянет.
"${SSH[@]}" "$TARGET" "\$( [ \"\$(id -u)\" = 0 ] || echo sudo ) chmod 700 '$REMOTE'"
echo "  код на месте"

if [ "$CODE_ONLY" = 1 ]; then
  say "3/3  Перезапускаю службу"
  "${SSH[@]}" "$TARGET" "\$( [ \"\$(id -u)\" = 0 ] || echo sudo ) systemctl restart tg-panel && \
    \$( [ \"\$(id -u)\" = 0 ] || echo sudo ) systemctl is-active tg-panel"
  echo "  готово — данные на сервере не тронуты"
  exit 0
fi

say "3/3  Ставлю панель на сервере"
case "$FLAGS" in
  *--no-password*) echo "  Пароль от панели не спрашиваю — задашь его сам, команда будет ниже." ;;
  *) echo "  Сейчас сервер спросит логин и пароль для входа в панель — набирай их"
     echo "  здесь, они никуда больше не уходят." ;;
esac
"${SSH[@]}" -t "$TARGET" "cd '$REMOTE' && \$( [ \"\$(id -u)\" = 0 ] || echo sudo ) bash deploy/install.sh$FLAGS"

cat <<TXT

  Панель стоит на сервере и слушает 127.0.0.1:8787 — снаружи её пока не видно.
  Открыть доступ (на сервере):

      cloudflared tunnel --url http://localhost:8787

  Обновить код потом:  bash deploy/push.sh $TARGET --code-only

TXT
