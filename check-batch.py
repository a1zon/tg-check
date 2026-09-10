#!/usr/bin/env python3
"""
Прогон номеров из numbers.csv через Telegram — родным каналом (MTProto),
без браузера. Замена check-batch.mjs.

Как узнаём: contacts.ImportContacts на один номер. Telegram возвращает
пользователя, если аккаунт есть, и пустой список, если нет. Контакт сразу
удаляется из адресной книги — в записной книжке аккаунта ничего не оседает.

Результат дописывается в тот же results.csv, что и раньше, база делится
теми же бронями (claims.json), поэтому аккаунты можно гонять параллельно.

    python check-batch.py --account a1 --limit 50 --delay 15
"""
import asyncio
import atexit
import random
import signal
import sys
from datetime import datetime, timezone

import claims
import tglib
from tglib import say

MAX_UNKNOWN_IN_ROW = 5        # столько сбоев подряд — и прогон стоит остановить
FLOOD_MAX = 600               # флуд-ожидание дольше этого не пересиживаем
MAX_TRIES = 3                 # столько раз номер не дался — больше не берём
COOLDOWN_FLOOD = 6 * 3600     # после PEER_FLOOD аккаунт отдыхает столько
COOLDOWN_ERRORS = 15 * 60     # после череды сбоев — короткая передышка


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


async def main():
    acc = tglib.resolve(tglib.arg("account", ""))
    limit = int(tglib.arg("limit", 50))
    delay = float(tglib.arg("delay", 15))

    from telethon import functions
    from telethon.tl.types import InputPhoneContact
    from telethon.errors import FloodWaitError, PeerFloodError

    base = tglib.read_csv(tglib.NUMBERS)
    res = tglib.read_csv(tglib.RESULTS)
    # ??? не считается проверенным — такой номер вернётся в очередь
    done = {r["phone"] for r in res if r.get("tg") in ("true", "false")}
    # ...но не бесконечно: номер, который не дался MAX_TRIES раз, откладываем,
    # иначе автопрогон будет вечно долбиться в один и тот же
    tries = tglib.tries_by_phone(res, done)
    free = [r["phone"] for r in base
            if r["phone"] not in done and tries.get(r["phone"], 0) < MAX_TRIES]
    mine = set(claims.take(acc["id"], "check", free, limit))
    todo = [r for r in base if r["phone"] in mine]

    # бронь не должна пережить процесс: иначе упавший прогон запрёт номера на час
    atexit.register(lambda: claims.release_all(acc["id"], "check"))
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: sys.exit(1))

    say(f"аккаунт: {acc['title']}  |  {tglib.proxy_label(acc.get('proxy'))}  |  Telethon")
    say(f"база {len(base)} | уже проверено {len(done)} | сейчас {len(todo)}")
    if not todo:
        tglib.state(done=0, left=len(free))
        return
    tglib.ensure_results_head()

    client = await tglib.connect(acc)
    say(f"сессия активна: {tglib.who(acc)}")

    found = unknown_row = 0
    quota = 0
    ran = 0                  # сколько номеров реально дошли до записи
    stop, cooldown = "", 0   # чем кончилась пачка — это читает автопрогон
    try:
        for i, row in enumerate(todo):
            phone = row["phone"]
            label = phone[-10:]                 # та же метка, что ставил браузерный прогон
            tg, name, username = None, "", ""
            try:
                res = await client(functions.contacts.ImportContactsRequest(
                    [InputPhoneContact(client_id=random.randrange(-2**62, 2**62),
                                       phone=phone, first_name=label, last_name="")]))
                if res.users:
                    u = res.users[0]
                    tg, found, unknown_row, quota = True, found + 1, 0, 0
                    # для приватных контактов Telegram отдаёт НАШУ метку,
                    # а не настоящее имя — такое за имя не выдаём
                    real = " ".join(x for x in [u.first_name, u.last_name] if x).strip()
                    name = "" if real in ("", label, phone) else real
                    username = u.username or ""
                    # из адресной книги убираем сразу: проверка не должна
                    # оставлять за собой контакты
                    await client(functions.contacts.DeleteContactsRequest(id=[u.id]))
                elif res.retry_contacts:
                    # номер не обработан вовсе — это и есть упёршаяся квота
                    quota += 1
                    unknown_row += 1
                    say(f"  ! {phone}: Telegram просит повторить — похоже, кончилась квота на контакты")
                else:
                    # ясный ответ «аккаунта нет» — значит квота ещё жива
                    tg, unknown_row, quota = False, 0, 0
            except FloodWaitError as e:
                if e.seconds > FLOOD_MAX:
                    say(f"\nстоп: Telegram просит подождать {e.seconds} с — на сегодня хватит")
                    stop, cooldown = "flood", e.seconds
                    break
                say(f"  … флуд-пауза {e.seconds} с")
                await asyncio.sleep(e.seconds)
                unknown_row += 1
            except PeerFloodError:
                say("\nстоп: аккаунт ограничен Telegram за слишком частые обращения (PEER_FLOOD).")
                say("  Продолжать нельзя — дай ему отлежаться сутки или работай другим аккаунтом.")
                stop, cooldown = "flood", COOLDOWN_FLOOD
                break
            except Exception as e:
                unknown_row += 1
                say(f"  ! {phone}: {type(e).__name__}: {str(e).splitlines()[0][:100]}")

            mark = "ЕСТЬ" if tg is True else "нет" if tg is False else "???"
            tglib.append_row(tglib.RESULTS,
                             [phone, "" if tg is None else str(tg).lower(), name, username,
                              row.get("calls", ""), row.get("last_call", ""), now_iso(), acc["id"]],
                             tglib.RESULTS_HEAD)
            # бронь НЕ снимаем по номеру: под параллельной работой освобождённый
            # номер успевал перехватить другой аккаунт, пока его список «уже
            # проверено» устарел. Держим до конца прогона — снимет release_all.
            ran += 1
            say(f"[{i + 1}/{len(todo)}] {phone}  {mark}" + (f"  {name}" if name else ""))

            if quota >= 3:
                say("\nстоп: подряд не проходят контакты — квота аккаунта на сегодня кончилась.")
                say("  Это ограничение Telegram, ускорить нельзя: продолжай завтра или другим аккаунтом.")
                stop, cooldown = "quota", tglib.until_tomorrow()
                break
            if unknown_row >= MAX_UNKNOWN_IN_ROW:
                say(f"\nстоп: {MAX_UNKNOWN_IN_ROW} сбоев подряд")
                stop, cooldown = "errors", COOLDOWN_ERRORS
                break
            if i < len(todo) - 1:
                await asyncio.sleep(delay + random.uniform(0, delay * 0.5))
    finally:
        await tglib.aclose(client)

    say(f"\nготово: в Telegram {found} из {len(todo)}")
    say(f"результат: {tglib.RESULTS}")

    # что осталось в базе после этой пачки — считаем заново, по файлу:
    # рядом могли отработать другие аккаунты
    res2 = tglib.read_csv(tglib.RESULTS)
    done2 = {r["phone"] for r in res2 if r.get("tg") in ("true", "false")}
    tries2 = tglib.tries_by_phone(res2, done2)
    left = sum(1 for r in base if r["phone"] not in done2
               and tries2.get(r["phone"], 0) < MAX_TRIES)
    tglib.state(done=ran, left=left, stop=stop, cooldown=cooldown)


asyncio.run(main())
