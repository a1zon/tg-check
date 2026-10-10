#!/bin/sh
# Убрать аккаунт с этого компьютера. macOS и Linux.
#
# Telegram хранит аккаунт в файлах, а не «в программе»: стереть файлы — и на
# этом компьютере аккаунта больше нет. Выход из аккаунта в самом Telegram для
# этого НЕ годится и прямо вреден: ключ у Desktop и у панели один, выход
# отзовёт сессию целиком, и панель потеряет аккаунт.
set -e
cd "$(dirname "$0")"
HERE="$PWD"

TITLE="этот аккаунт"
if command -v python3 >/dev/null 2>&1 && [ -f kit.json ]; then
  TITLE="$(python3 -c "import json;print(json.load(open('kit.json')).get('title') or 'этот аккаунт')" 2>/dev/null || echo "этот аккаунт")"
fi

printf '\nУберу «%s» с этого компьютера.\n\n' "$TITLE"
printf 'Что будет сделано:\n'
printf '  • закроется Telegram, запущенный из этой папки;\n'
printf '  • удалятся файлы аккаунта и настройки — папки tdata и workdir.\n\n'
printf 'Из аккаунта НЕ выходим: в панели он продолжит работать как ни в чём\n'
printf 'не бывало. Пропадёт только копия на этом компьютере.\n\n'
printf 'Убираем? Напиши да и нажми Enter: '
read -r ok
case "$ok" in
  да|ДА|da|DA|yes|y|д|ok|ок|+) ;;   # и латиницей: раскладку могут не переключить
  *) printf 'Ничего не трогал.\n'; exit 0 ;;
esac

# Закрываем только тот Telegram, который открыт из этой папки: личный
# Telegram человека трогать нельзя.
if pkill -f "workdir.*$HERE|$HERE.*workdir" 2>/dev/null; then
  printf '  закрыл Telegram, жду 5 секунд…\n'
  sleep 5
fi

for p in workdir tdata kit.json; do
  rm -rf "$HERE/$p" 2>/dev/null || true
  if [ -e "$HERE/$p" ]; then printf '  %s: НЕ УДАЛИЛОСЬ\n' "$p"; else printf '  %s: удалено\n' "$p"; fi
done

printf '\n'
if [ -e "$HERE/tdata" ]; then
  printf 'Что-то осталось — похоже, Telegram ещё держит файлы.\n'
  printf 'Закрой его полностью и запусти этот файл снова.\n'
else
  printf 'Готово: аккаунта на этом компьютере больше нет.\n'
  printf 'Осталось удалить саму папку — перетащи её в корзину.\n'
fi
printf '\nОкно можно закрыть.\n'
