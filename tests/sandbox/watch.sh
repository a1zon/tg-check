#!/bin/bash
# Сторож для прогонов песочницы: убивает процесс, если он ест больше
# MAX_MB памяти или живёт дольше MAX_S секунд (16.10 тест съел 64 ГБ за 25 с).
#   MAX_S=60 tests/sandbox/watch.sh venv-tg/bin/python tests/sandbox/run.py followup.py --account a1
MAX_MB=${MAX_MB:-1500}
MAX_S=${MAX_S:-90}
"$@" &
pid=$!
start=$(date +%s)
while kill -0 "$pid" 2>/dev/null; do
  rss=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')
  if [ -n "$rss" ] && [ "$rss" -gt $((MAX_MB * 1024)) ]; then
    echo "СТОРОЖ: ${rss} КБ памяти — убиваю" >&2; kill -9 "$pid"; exit 137
  fi
  if [ $(( $(date +%s) - start )) -gt "$MAX_S" ]; then
    echo "СТОРОЖ: дольше ${MAX_S} с — убиваю" >&2; kill -9 "$pid"; exit 124
  fi
  sleep 0.2
done
wait "$pid"
