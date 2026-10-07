#!/usr/bin/env python3
"""
Убирает из адресной книги контакты, заведённые прогоном (имя = 10 цифр
номера). Замена cleanup-contacts.mjs — без браузера, одним запросом.

Обычно чистить нечего: и проверка, и рассылка удаляют контакт сразу.
Скрипт нужен после сбоя — когда процесс упал между «добавил» и «удалил».

    python cleanup-contacts.py --account a1          # все метки-номера
    python cleanup-contacts.py --account a1 9018557772 9014131729
"""
import asyncio
import re
import sys

import tglib
from tglib import say

LABEL = re.compile(r"^\d{10}$")


async def main():
    acc = tglib.resolve(tglib.arg("account", ""))
    wanted = {a for a in sys.argv[1:] if LABEL.match(a)}
    say(f"аккаунт: {acc['title']}  |  {tglib.proxy_label(acc.get('proxy'))}  |  Telethon")

    from telethon import functions
    from telethon.tl.types import contacts as contacts_types

    client = await tglib.connect(acc)
    try:
        res = await client(functions.contacts.GetContactsRequest(hash=0))
        if isinstance(res, contacts_types.ContactsNotModified):
            say("Telegram ответил «список не менялся» — чистить нечего")
            return
        # метка-из-цифр — наш след; чужие контакты (с настоящими именами)
        # не трогаем ни при каких условиях
        # ждущих письма (их оставила проверка) не трогаем, если только их
        # номер не назвали явно
        keep = tglib.kept_waiting(acc["id"])
        victims = [u for u in res.users
                   if LABEL.match((u.first_name or "").strip())
                   and not (u.last_name or "").strip()
                   and (not wanted or (u.first_name or "").strip() in wanted)
                   and (wanted or "".join(ch for ch in str(u.phone or "") if ch.isdigit()) not in keep)]
        if keep and not wanted:
            say(f"ждут письма и остаются в контактах: {len(keep)}")
        say(f"контактов всего: {len(res.users)} | наших меток: {len(victims)}")
        if not victims:
            return
        await client(functions.contacts.DeleteContactsRequest(id=victims))
        for u in victims:
            say(f"  удалён {u.first_name}")
        say(f"\nудалено: {len(victims)}")
    finally:
        await tglib.aclose(client)


asyncio.run(main())
