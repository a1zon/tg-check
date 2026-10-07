#!/usr/bin/env python3
"""
Загрузка готовой базы брендов в профиль панели.

Таблица у тебя уже собрана: бренд, ЛПР, контакт, ИНН и ГОТОВОЕ ПИСЬМО под
каждого. Этот скрипт раскладывает её по тем файлам, с которыми панель уже
умеет работать:

  --what phones    колонка «Телефон»  -> numbers.csv (набор «по номерам»).
                   Дальше обычный путь: проверка «есть ли Telegram» -> письма.

  --what telegram  колонка «Telegram» -> набор «по чатам» (chats/): там люди
                   лежат уже с пометкой «в Telegram есть», проверять их не
                   нужно и квота на добавление контактов не тратится.

Письма из колонки «Сообщение» складываются в messages.csv: контакт -> текст.
Панель шлёт один общий текст на всех, а здесь у каждого свой — этот файл
нужен, чтобы персональные письма не потерялись.

    python import-outreach.py --file 1_telefony.csv --what phones
    python import-outreach.py --file 2_telegram.csv --what telegram
"""
import csv
import io
import re
from pathlib import Path

import tglib
from tglib import say

MESSAGES = tglib.DIR / "messages.csv"
MESSAGES_HEAD = ["key", "brand", "lpr", "inn", "text"]

PHONE = re.compile(r"(?:\+7|\b8)[\s(\-]*\d{3}[\s)\-]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}\b")


def rows_of(path):
    raw = Path(path).read_bytes().decode("utf-8-sig", "replace")
    head = raw.split("\n", 1)[0]
    sep = max(";,\t", key=head.count) if any(c in head for c in ";,\t") else ","
    return list(csv.DictReader(io.StringIO(raw), delimiter=sep))


def first_phone(s):
    """Первый номер из ячейки: их там бывает два через косую черту."""
    for raw in PHONE.findall(s or ""):
        d = re.sub(r"\D", "", raw)
        if len(d) == 11 and d[0] in "78":
            return "+7" + d[1:]
        if len(d) == 10:
            return "+7" + d
    return ""


def col(row, *names):
    for n in names:
        for k, v in row.items():
            if k and k.strip().lower() == n:
                return (v or "").strip()
    return ""


def save_message(seen, key, row, text):
    if not text or key in seen:
        return
    seen.add(key)
    tglib.append_row(MESSAGES, [key, col(row, "бренд"), col(row, "лпр"),
                                col(row, "инн"), tglib.cell(text)], MESSAGES_HEAD)


def main():
    path = tglib.arg("file", "")
    what = tglib.arg("what", "")
    if not path or not Path(path).exists():
        raise SystemExit("нужен --file с таблицей")
    if what not in ("phones", "telegram"):
        raise SystemExit("нужен --what phones или --what telegram")

    rows = rows_of(path)
    if not rows:
        raise SystemExit("таблица пустая")
    tglib.ensure_head(MESSAGES, MESSAGES_HEAD)
    had_msg = {r.get("key") for r in tglib.read_csv(MESSAGES)}

    if what == "phones":
        base = tglib.DIR / "numbers.csv"
        tglib.ensure_head(base, ["phone", "calls", "last_call", "total_sec"])
        have = {r.get("phone") for r in tglib.read_csv(base)}
        added = dup = empty = 0
        for r in rows:
            phone = first_phone(col(r, "телефон"))
            if not phone:
                empty += 1
                continue
            save_message(had_msg, phone, r, col(r, "сообщение"))
            if phone in have:
                dup += 1
                continue
            have.add(phone)
            tglib.append_row(base, [phone, "", "", ""],
                             ["phone", "calls", "last_call", "total_sec"])
            added += 1
        say(f"строк в таблице: {len(rows)}")
        say(f"в базу номеров добавлено: {added}; уже были: {dup}; без телефона: {empty}")
        say("дальше обычным путём: «Проверить базу» -> письма")
        tglib.state(done=added, left=0, note=f"номеров добавлено {added}")
        return

    people, empty = [], 0
    for r in rows:
        nick = col(r, "telegram", "телеграм", "куда писать").lstrip("@").strip()
        if not nick or " " in nick:
            empty += 1
            continue
        save_message(had_msg, "@" + nick, r, col(r, "сообщение"))
        people.append({"username": nick, "name": col(r, "бренд") or col(r, "лпр")})
    added, dup = tglib.add_recipients(people, by="импорт")
    say(f"строк в таблице: {len(rows)}")
    say(f"в набор «по чатам» добавлено: {added}; уже были: {dup}; без ника: {empty}")
    say("проверять их не нужно — они уже в Telegram, можно сразу писать")
    tglib.state(done=added, left=0, note=f"получателей добавлено {added}")


main()
