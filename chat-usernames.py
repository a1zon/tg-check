#!/usr/bin/env python3
"""
Дописать публичные ники в chats.json (разобранные чаты режима «по чатам»).

Разбор раньше запоминал чат только по id, а по id чат открывает лишь аккаунт,
который в нём состоит. Комментарии ходят в эти чаты с ДРУГИХ аккаунтов —
им нужен публичный ник. Аккаунт-разборщик берёт чаты по id из памяти своей
сессии (один запрос на 50 чатов) и дописывает ники тем, у кого они есть.

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
        # Чаты берём прямо по id из памяти сессии: аккаунт, разбиравший чат, его
        # «видел», и ключ доступа лежит в сессии. Список диалогов не годится — у
        # аккаунтов рассылки сотни личных переписок, и группы в первые 300 не
        # попадают (16.10 так не нашлось ни одного ника из 92). Одним запросом на
        # 50 чатов — трафика почти нет.
        from telethon import functions, types
        known = []
        for k in sorted(need):
            try:
                known.append((k, await client.get_input_entity(types.PeerChannel(int(k)))))
            except (ValueError, TypeError):
                pass                       # эту группу сессия не встречала
        for i in range(0, len(known), 50):
            part = known[i:i + 50]
            try:
                res = await client(functions.channels.GetChannelsRequest(id=[e for _, e in part]))
            except Exception as e:
                say(f"не прочитал пачку чатов: {type(e).__name__}")
                continue
            for ch in res.chats:
                if str(ch.id) in need and getattr(ch, "username", None):
                    found[str(ch.id)] = ch.username
        say(f"сессия знает {len(known)} из {len(need)} чатов без ника")
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
