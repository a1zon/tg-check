#!/bin/bash
# Автоскан лидов (lead-watch.timer, раз в 15 мин). Прокси у всех аккаунтов один,
# панель гоняет задачи строго по одной и меняет IP между аккаунтами — поэтому
# скан встаёт в ту же очередь: не стартует поверх задачи панели и на время
# работы держит .lead-watch.lock, который панель уважает (не запускает задачи
# и не меняет IP, пока скан идёт).
cd /opt/tg-panel
# выключено кнопкой в панели («Горячие лиды» → «Выключить автопоиск»)
[ -f lead-watch.off ] && exit 0
LOCK=.lead-watch.lock
if pgrep -f "^/opt/tg-panel/venv-tg/bin/python /opt/tg-panel/" >/dev/null; then
  echo "$(date '+%F %T') пропуск: в панели идёт задача — общий прокси, ждём следующего захода" >> lead-watch.log
  exit 0
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT
# панель могла стартовать задачу в ту же секунду — проверяем ещё раз уже под замком
sleep 3
if pgrep -f "^/opt/tg-panel/venv-tg/bin/python /opt/tg-panel/" >/dev/null; then
  echo "$(date '+%F %T') пропуск: панель успела начать задачу" >> lead-watch.log
  exit 0
fi
ACCS=(a4 a5 a6 a7 a8 a9)
IDXF=.lead-watch-idx
i=$(cat $IDXF 2>/dev/null || echo 0)
acc=${ACCS[$((i % ${#ACCS[@]}))]}
echo $(( (i+1) % 1000 )) > $IDXF
venv-tg/bin/python scan-leads.py --account "$acc" --list lead-chats.txt --limit 90 --days 2 >> lead-watch.log 2>&1
