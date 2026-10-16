#!/usr/bin/env python3
"""
Дописать публичные ники в chats.json (разобранные чаты режима «по чатам»).

Разбор раньше запоминал чат только по id, а по id чат открывает лишь аккаунт,
который в нём состоит. Комментарии ходят в эти чаты с ДРУГИХ аккаунтов —
им нужен публичный ник. Аккаунт-участник один раз смотрит свои диалоги
(один запрос, ~40 КБ) и дописывает ники тем чатам, где он есть.

    python chat-usernames.py --account a1

Чаты без ника (закрытые) так и остаются без него — комментарии их пропускают.
"""
import asyncio
import json

import tglib
from tglib import say

DONE = tglib.DIR / "chats.json"


async def main():
    acc = tglib.resolve(tglib.arg("account", ""))
    try:
        data = json.loads(DONE.read_text("utf-8"))
    except Exception:
        raise SystemExit("нет chats.json — чаты ещё не разбирали")
    need = {k for k, v in data.items() if not (v or {}).get("username")}
    if not need:
        say("у всех чатов ник уже есть")
        tglib.state(done=0, left=0)
        return
    client = await tglib.connect(acc)
    found = {}
    try:
        for d in await client.get_dialogs(limit=300):
            ent = d.entity
            if str(getattr(ent, "id", "")) in need and getattr(ent, "username", None):
                found[str(ent.id)] = ent.username
    finally:
        await tglib.aclose(client)
    # дописываем под тем же замком, что и разбор (он может идти параллельно)
    try:
        import fcntl
        fh = open(str(DONE) + ".lock", "a")
        fcntl.flock(fh, fcntl.LOCK_EX)
    except ImportError:
        fh = None
    try:
        data = json.loads(DONE.read_text("utf-8"))
        for k, u in found.items():
            if k in data and not data[k].get("username"):
                data[k]["username"] = u
        tmp = DONE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", "utf-8")
        tmp.replace(DONE)
    finally:
        if fh:
            fcntl.flock(fh, fcntl.LOCK_UN)
            fh.close()
    say(f"ники найдены у {len(found)} из {len(need)} чатов без ника "
        f"(остальные закрытые или аккаунт в них не состоит)")
    tglib.state(done=len(found), left=len(need) - len(found))


asyncio.run(main())
