#!/usr/bin/env bash
#
# Установка панели на сервер (Ubuntu 22.04+ / Debian 12+).
#
# Кладём панель в папку, заходим в неё и запускаем:
#
#     sudo bash deploy/install.sh
#
# Скрипт ставит Node и Python, собирает окружение, спрашивает вход в панель
# и заводит службу systemd — дальше панель поднимается сама при перезагрузке
# сервера и переживает падения.
#
# Панель слушает ТОЛЬКО 127.0.0.1: наружу её отдаёт туннель или nginx с
# сертификатом. Открытый порт в интернет — это пароль от ваших аккаунтов
# Telegram на виду, поэтому так по умолчанию не делается.
#
#   --tdata        доставить opentele и PyQt5 (импорт TDATA; +300 МБ)
#   --voice        доставить ffmpeg (рассылка голосовыми)
#   --port 8787    другой порт
#   --no-password  не спрашивать вход в панель: его задаст хозяин сам, своими
#                  руками. Служба тогда заводится, но не стартует — пароль
#                  нужен ей для запуска
#   --no-service   не заводить systemd (для проверки в контейнере)
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=8787
WITH_TDATA=0
WITH_VOICE=0
WITH_SERVICE=1
ASK_PASSWORD=1
START_NOW=1
SERVICE=tg-panel

while [ $# -gt 0 ]; do
  case "$1" in
    --tdata) WITH_TDATA=1 ;;
    --voice) WITH_VOICE=1 ;;
    --no-service) WITH_SERVICE=0 ;;
    --no-password) ASK_PASSWORD=0 ;;
    --port) PORT="${2:-8787}"; shift ;;
    *) echo "не знаю ключ: $1"; exit 1 ;;
  esac
  shift
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# запустить от имени владельца папки. runuser есть в любой Debian/Ubuntu
# (util-linux), а вот sudo на голом сервере может и не стоять
as_owner() {
  if [ "$OWNER" = root ]; then "$@"
  elif command -v runuser >/dev/null 2>&1; then runuser -u "$OWNER" -- "$@"
  else sudo -u "$OWNER" "$@"
  fi
}

[ "$(id -u)" = 0 ] || die "нужен root: sudo bash deploy/install.sh"
[ -f "$DIR/router.mjs" ] || die "запускать из папки панели: рядом должен лежать router.mjs"

# от чьего имени будет работать панель: владелец папки, но не root —
# службе ни к чему права, которых она не использует
OWNER="$(stat -c %U "$DIR" 2>/dev/null || echo root)"
[ "$OWNER" = root ] && OWNER="${SUDO_USER:-root}"
id "$OWNER" >/dev/null 2>&1 || die "не нашёл пользователя «$OWNER» — кому принадлежит папка?"

say "1/5  Системные пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl python3-venv python3-pip >/dev/null
[ "$WITH_VOICE" = 1 ] && apt-get install -y -qq ffmpeg >/dev/null && echo "  ffmpeg — есть"

# Node из репозитория дистрибутива бывает древним (Ubuntu 22.04 — 12.x),
# а панели нужен хотя бы 18-й. Старый — доливаем из NodeSource.
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge 18 ] && NODE_OK=1
fi
if [ "$NODE_OK" = 0 ]; then
  echo "  ставлю Node.js 20 LTS…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
echo "  node $(node -v)  ·  $(python3 -V)"

# На самых дешёвых тарифах памяти в обрез, а панель держит по процессу на
# каждый работающий аккаунт. Без подкачки ядро просто убивает задачу посреди
# рассылки — файл подкачки это лечит и стоит ноль.
RAM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
SWAP_MB="$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
if [ "$RAM_MB" -gt 0 ] && [ "$RAM_MB" -lt 2048 ] && [ "$SWAP_MB" -lt 512 ]; then
  say "1.5/5  Подкачка (памяти на сервере ${RAM_MB} МБ — маловато)"
  if fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 2>/dev/null; then
    # хвост «|| echo» обязателен: без него неудачный swapon уронил бы весь
    # установщик (set -e), хотя подкачка — дело желательное, а не обязательное
    if chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile 2>/dev/null; then
      grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
      echo "  добавлено 2 ГБ подкачки (переживёт перезагрузку)"
    else
      rm -f /swapfile
      echo "  подкачку включить не дали — не страшно, но следи за памятью"
    fi
  else
    echo "  подкачку сделать не вышло — не страшно, но следи за памятью"
  fi
fi

say "2/5  Python-окружение панели"
if [ ! -x "$DIR/venv-tg/bin/python" ]; then
  as_owner python3 -m venv "$DIR/venv-tg"
fi
PY="$DIR/venv-tg/bin/python"
as_owner "$PY" -m pip install -q --upgrade pip
as_owner "$PY" -m pip install -q telethon python-socks qrcode openpyxl
echo "  telethon, python-socks, qrcode, openpyxl — есть"
if [ "$WITH_TDATA" = 1 ]; then
  echo "  доставляю opentele (импорт TDATA)…"
  # Собирается из исходников: tgcrypto, который тянет opentele, готовых
  # колёс под свежие Python не выкладывает, а без компилятора и заголовков
  # установка обрывается на полуслове.
  apt-get install -y -qq build-essential python3-dev >/dev/null 2>&1
  as_owner "$PY" -m pip install -q tgcrypto PyQt5 || true
  as_owner "$PY" -m pip install -q --no-deps opentele || true
  # opentele постарше новых Python: на 3.13+ он падает ещё на импорте,
  # правка идёт вместе с панелью
  as_owner "$PY" "$DIR/patch-opentele.py" 2>&1 | tail -1 | sed 's/^/  /' || true
  if as_owner "$PY" -c "from opentele.td import TDesktop" >/dev/null 2>&1; then
    echo "  TDATA читается"
  else
    echo "  ⚠ opentele так и не завёлся — .zip с TDATA приниматься не будет"
    echo "    (.session, вход по QR и по коду от этого не зависят)"
  fi
else
  echo "  opentele/PyQt5 пропущены — .zip с TDATA приниматься не будет"
  echo "  (нужен — переустанови с ключом --tdata; .session и вход по QR/коду работают и так)"
fi

say "3/5  Вход в панель"
if [ -f "$DIR/auth.json" ]; then
  echo "  auth.json уже есть — оставляю как есть"
  echo "  (сменить: node set-password.mjs <логин> <пароль>)"
elif [ "$ASK_PASSWORD" = 0 ]; then
  # пароль задаёт хозяин панели и никто другой: за ним стоят живые аккаунты
  START_NOW=0
  echo "  не задан — это делаешь ты сам, своей рукой:"
  echo
  echo "      cd $DIR && sudo -u $OWNER node set-password.mjs <логин> <пароль>"
  echo "      sudo systemctl start $SERVICE"
  echo
  echo "  Без пароля панель не поднимается, поэтому службу пока не запускаю."
else
  echo "  Придумай вход. Пароль от домашней панели сюда переносить не надо."
  read -r -p "  Логин: " PANEL_USER
  read -rs -p "  Пароль (не короче 8 символов): " PANEL_PASS; echo
  ( cd "$DIR" && as_owner node set-password.mjs "$PANEL_USER" "$PANEL_PASS" )
fi

say "4/5  Служба"
if [ "$WITH_SERVICE" = 0 ]; then
  echo "  пропущено (--no-service)"
elif ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
  # контейнер, WSL без systemd и прочие места, где службы заводить нечем
  echo "  systemd тут не работает — службу не завожу."
  echo "  Запускать панель руками:  node router.mjs --port $PORT --no-open"
else
  cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=Telegram — панель
Documentation=file://$DIR/README.md
After=network-online.target
Wants=network-online.target
# Предел перезапусков: если панель падает сразу после старта (испорченный
# файл, занятый порт, пропавший Python), systemd попробует пять раз за пять
# минут и остановится. Без этого она крутила бы бесконечный цикл, забивая
# журнал и пряча настоящую причину.
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=$OWNER
WorkingDirectory=$DIR
# --no-open: на сервере нет рабочего стола, открывать браузер нечем
ExecStart=$(command -v node) $DIR/router.mjs --port $PORT --no-open
Restart=on-failure
RestartSec=5
# панель запускает Python-задачи по одной на аккаунт — им нужен свой предел
LimitNOFILE=8192

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1 || true
  if [ "$START_NOW" = 0 ]; then
    echo "  служба $SERVICE заведена, но не запущена — ждёт, пока задашь пароль"
  else
    systemctl restart "$SERVICE"
    sleep 2
    systemctl is-active --quiet "$SERVICE" \
      && echo "  служба $SERVICE запущена (сама поднимется после перезагрузки)" \
      || { systemctl status "$SERVICE" --no-pager -l | tail -20; die "служба не поднялась"; }
  fi
fi

say "5/5  Готово"
cat <<TXT

  Панель работает на http://127.0.0.1:$PORT — только внутри сервера.
  Чтобы открыть её из браузера, выбери одно:

  · Cloudflare Tunnel — бесплатно, HTTPS и адрес сразу, порт наружу не нужен:
        curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \\
          | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
        echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] \\
          https://pkg.cloudflare.com/cloudflared any main" \\
          > /etc/apt/sources.list.d/cloudflared.list
        apt-get update && apt-get install -y cloudflared
        cloudflared tunnel --url http://localhost:$PORT
    Постоянный адрес на своём домене — «cloudflared tunnel login» и туннель
    с именем; тогда он тоже живёт службой и переживает перезагрузку.

  · Tailscale — если панель нужна только тебе, без публичного адреса:
        curl -fsSL https://tailscale.com/install.sh | sh && tailscale up
    Потом с телефона или ноутбука — http://<имя-сервера>:$PORT

  Команды службы:
        systemctl status $SERVICE        что с ней
        systemctl restart $SERVICE       перезапустить (после обновления кода)
        journalctl -u $SERVICE -f        смотреть журнал живьём

  Дальше — в панель: заведи аккаунты (QR или код на телефон) и ПОСТАВЬ ИМ
  ПРОКСИ. С адреса дата-центра Telegram банит аккаунты куда охотнее.

TXT
