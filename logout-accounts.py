#!/usr/bin/env python3
"""
Выход из всех аккаунтов панели — по-настоящему, на стороне Telegram.

Обычное «Отключить» в списке только удаляет сессию с этого компьютера:
в самом Telegram она остаётся висеть в «Устройствах». Здесь мы просим
Telegram её отозвать — после этого ключ мёртв у всех, и вернуть аккаунт
можно будет только новым входом (QR или телефон). Залитый TDATA после
такого выхода тоже становится бесполезен.

Скрипт запускает панель при полной чистке; сам по себе он ничего не удаляет
из реестра — это делает панель, когда он отработает.

    python logout-accounts.py
"""
import asyncio

import tglib
from tglib import say


async def main():
    lst = tglib.load_accounts()
    if not lst:
        say("аккаунтов нет — выходить не из кого")
        return

    out = kept = 0
    for acc in lst:
        title = acc.get("title") or acc.get("id")
        if not tglib.has_session(acc):
            say(f"{title}: сессии на этом компьютере нет — просто уберём из панели")
            continue
        try:
            client = await tglib.connect(acc)
        except SystemExit as e:
            # мёртвый ключ или нет связи: отзывать нечего или нечем
            kept += 1
            say(f"{title}: {str(e).splitlines()[0]}")
            continue
        try:
            # log_out() сам отключается и стирает файл сессии
            await client.log_out()
            out += 1
            say(f"{title}: вышел — сессия отозвана в Telegram")
        except Exception as e:
            kept += 1
            say(f"{title}: выйти не вышло — {type(e).__name__}: {str(e).splitlines()[0][:100]}")
            await tglib.aclose(client)

    say(f"\nготово: вышли из {out}" +
        (f", не удалось у {kept} (их сессии уедут в бэкап, не пропадут)" if kept else ""))


asyncio.run(main())
