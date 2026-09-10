#!/usr/bin/env python3
"""
Проверка: есть ли у номера Telegram — через Telethon (contacts.ImportContacts).

Для follow-up своей базы: по номеру видно, есть ли аккаунт и имя, чтобы писать
в Telegram тем, у кого он есть, а не вслепую. Импортированный контакт сразу
удаляется из книжки аккаунта.

    python tg-check-number.py --session <файл> [--proxy ...] --phones +7..,+7..

На каждый номер печатает JSON-строку:
    {"phone":"+7..","tg":true,"name":"..","username":".."}
    {"phone":"+7..","tg":false}
"""
import sys, json, argparse, asyncio, random
from urllib.parse import urlparse

API_ID, API_HASH = 2040, "b18441a1ff607e10a989891a5462e627"


def parse_proxy(raw):
    if not raw:
        return None
    u = urlparse(raw if "://" in raw else "socks5://" + raw)
    kind = "socks5" if "socks5" in (u.scheme or "") else \
           "socks4" if "socks4" in (u.scheme or "") else "http"
    return (kind, u.hostname, u.port, True, u.username, u.password) if u.username \
        else (kind, u.hostname, u.port)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", required=True)
    ap.add_argument("--proxy", default="")
    ap.add_argument("--phones", required=True)
    ap.add_argument("--delay", type=float, default=3.0)
    a = ap.parse_args()

    from telethon import TelegramClient, functions
    from telethon.tl.types import InputPhoneContact
    from telethon.errors import FloodWaitError

    phones = [p.strip() for p in a.phones.split(",") if p.strip()]
    client = TelegramClient(a.session.removesuffix(".session"), API_ID, API_HASH,
                            proxy=parse_proxy(a.proxy),
                            device_model="Desktop", system_version="Windows 10")
    await client.connect()
    if not await client.is_user_authorized():
        print(json.dumps({"error": "session_dead"})); return

    for i, phone in enumerate(phones):
        try:
            res = await client(functions.contacts.ImportContactsRequest(
                [InputPhoneContact(client_id=random.randrange(-2**62, 2**62),
                                   phone=phone, first_name=phone, last_name="")]))
            if res.users:
                u = res.users[0]
                # для приватных контактов Telegram возвращает НАШУ метку (phone),
                # а не настоящее имя — такое за имя не выдаём
                real = " ".join(x for x in [u.first_name, u.last_name] if x) or ""
                name = "" if real == phone else real
                print(json.dumps({"phone": phone, "tg": True,
                                  "name": name, "username": u.username or ""},
                                 ensure_ascii=False))
                await client(functions.contacts.DeleteContactsRequest(id=[u.id]))
            else:
                print(json.dumps({"phone": phone, "tg": False}))
        except FloodWaitError as e:
            print(json.dumps({"phone": phone, "flood_wait": e.seconds}))
            await asyncio.sleep(e.seconds)
            continue
        except Exception as e:
            print(json.dumps({"phone": phone, "error": f"{type(e).__name__}: {str(e)[:80]}"},
                             ensure_ascii=False))
        sys.stdout.flush()
        if i < len(phones) - 1:
            await asyncio.sleep(a.delay + random.uniform(0, a.delay))

    await client.disconnect()


asyncio.run(main())
