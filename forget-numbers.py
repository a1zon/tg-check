#!/usr/bin/env python3
"""
Забыть, что этим номерам уже писали, — чтобы потренироваться на них ещё раз.

Панель пишет человеку один раз: номер, отмеченный в drafts.csv, в очередь
больше не вернётся. Для настоящей базы это защита от повторов, а для тренировки
на своих же номерах — помеха. Скрипт убирает отметки, и номера снова попадают
в очередь на черновики.

С --checks убирает и результат проверки — тогда номер придётся проверять заново.

    python forget-numbers.py                              # все, кому писали
    python forget-numbers.py --numbers +79045439815       # только этот
    python forget-numbers.py --checks                     # и проверку тоже

На чужой базе так делать не стоит: человек получит второе сообщение.
"""
import csv
from pathlib import Path

import tglib
from tglib import say


def plural(n, one, few, many):
    if n % 10 == 1 and n % 100 != 11:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


def strip(path, head, phones):
    """Оставляет в файле всё, кроме строк с этими номерами. Возвращает, сколько убрал."""
    rows = tglib.read_csv(path)
    if not rows:
        return 0
    keep = [r for r in rows if phones and r.get("phone") not in phones]
    gone = len(rows) - len(keep)
    if not gone:
        return 0
    with Path(path).open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=head, extrasaction="ignore")
        w.writeheader()
        w.writerows(keep)
    return gone


def main():
    raw = tglib.arg("numbers", "")
    picked = {n.strip() for n in raw.replace(" ", ",").split(",") if n.strip()}

    log = tglib.read_csv(tglib.DRAFTS)
    phones = picked or {r["phone"] for r in log if r.get("phone")}
    if not phones:
        say("в drafts.csv никого нет — забывать нечего")
        return

    gone = strip(tglib.DRAFTS, tglib.DRAFTS_HEAD, phones)
    say(f"убрал отметок «писали»: {gone} "
        f"({len(phones)} {plural(len(phones), 'номер', 'номера', 'номеров')})"
        " — они снова в очереди на черновики")

    if tglib.flag("checks"):
        gone = strip(tglib.RESULTS, tglib.RESULTS_HEAD, phones)
        say(f"убрал результатов проверки: {gone} — эти номера панель проверит заново")

    say("\nсами чаты и черновики в Telegram остались — панель ведёт только свой учёт")


main()
