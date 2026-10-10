#!/usr/bin/env python3
"""
Доступ к аккаунту для человека: отдельный вход, который можно отозвать.

Зачем это вместо копии tdata панели. У панели и у человека был ОДИН ключ:
выйти нельзя (отзовётся и у панели), убрать можно только стиранием файлов,
а файлы расползаются копиями. Здесь панель создаёт аккаунту ВТОРУЮ,
самостоятельную авторизацию — ту же, что появляется при входе с нового
компьютера, — и отдаёт человеку её. Дальше это обычное устройство в списке:
видно в панели, выгоняется одной кнопкой, и панели это не мешает.

Как создаётся вход: тем же обменом, которым Telegram логинит по QR-коду.
Новый клиент просит токен, панель своей живой сессией его подтверждает,
новый клиент получает собственный ключ. Человеку ничего вводить не надо.

    python access.py --account a11 --out /tmp/tdata   # сделать вход
    python access.py --account a11 --list             # устройства аккаунта
    python access.py --account a11 --kill <hash>      # выгнать устройство
    python access.py --account a11 --kill-others      # выгнать всех, кроме панели
"""
import asyncio
import json
import shutil
import sys
from pathlib import Path

import tglib
from tglib import say

# Сколько ждём подтверждения входа. Через мобильный прокси обмен занимает
# пару секунд, но модем умеет уходить из сети на полминуты.
WAIT_STEPS = 12
WAIT_PAUSE = 3


def device_of(a):
    """Строка устройства для человека: что это и откуда заходили."""
    return {
        "hash": str(a.hash),
        "panel": a.hash == 0,
        "device": a.device_model or "",
        "app": f"{a.app_name or ''} {a.app_version or ''}".strip(),
        "place": ", ".join(x for x in (a.country, a.region) if x),
        "ip": a.ip or "",
        "at": a.date_active.isoformat() if a.date_active else "",
    }


async def devices(client):
    from telethon.tl.functions.account import GetAuthorizationsRequest
    r = await client(GetAuthorizationsRequest())
    return [device_of(a) for a in r.authorizations]


async def new_login(client, proxy, out: Path):
    """Новая авторизация и её tdata в папке out."""
    from telethon import TelegramClient
    from telethon.sessions import StringSession
    from telethon.tl import types as t
    from telethon.tl.functions.auth import (ExportLoginTokenRequest,
                                            ImportLoginTokenRequest,
                                            AcceptLoginTokenRequest)
    from opentele.td import TDesktop
    from opentele.api import UseCurrentSession

    # Представляемся обычным Telegram Desktop: именно так человек и выглядит
    # в списке устройств, и именно такой вход Telegram считает нормальным.
    fresh = TelegramClient(StringSession(), tglib.API_ID, tglib.API_HASH, proxy=proxy,
                           device_model="Windows", system_version="10",
                           app_version="5.7.3", connection_retries=5, timeout=30)
    await fresh.connect()

    r = await fresh(ExportLoginTokenRequest(tglib.API_ID, tglib.API_HASH, []))
    if isinstance(r, t.auth.LoginTokenMigrateTo):
        await fresh._switch_dc(r.dc_id)
        r = await fresh(ImportLoginTokenRequest(r.token))
    if isinstance(r, t.auth.LoginToken):
        await client(AcceptLoginTokenRequest(r.token))
        for _ in range(WAIT_STEPS):
            await asyncio.sleep(WAIT_PAUSE)
            r = await fresh(ExportLoginTokenRequest(tglib.API_ID, tglib.API_HASH, []))
            if isinstance(r, t.auth.LoginTokenMigrateTo):
                await fresh._switch_dc(r.dc_id)
                r = await fresh(ImportLoginTokenRequest(r.token))
            if isinstance(r, t.auth.LoginTokenSuccess):
                break

    if not await fresh.is_user_authorized():
        await fresh.disconnect()
        raise SystemExit("Telegram не подтвердил новый вход — попробуй ещё раз через минуту")

    # UseCurrentSession: берём ключ ИМЕННО нового клиента, не создавая ещё одну
    # авторизацию поверх только что созданной.
    tdesk = await TDesktop.FromTelethon(fresh, flag=UseCurrentSession)
    shutil.rmtree(out, ignore_errors=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    tdesk.SaveTData(str(out))
    await fresh.disconnect()
    return len([p for p in out.rglob("*") if p.is_file()])


async def main():
    acc = tglib.resolve(tglib.arg("account", ""))
    out = tglib.arg("out", "")
    want_list = tglib.flag("list")
    kill = str(tglib.arg("kill", "") or "")
    kill_others = tglib.flag("kill-others")

    client = tglib.make_client(acc)
    await client.connect()
    if not await client.is_user_authorized():
        raise SystemExit("сессия панели мертва — аккаунт сначала надо вернуть в панель")

    try:
        if want_list:
            lst = await devices(client)
            print(json.dumps(lst, ensure_ascii=False))
            return

        if kill or kill_others:
            from telethon.tl.functions.account import ResetAuthorizationRequest
            lst = await devices(client)
            goners = [d for d in lst if not d["panel"] and (kill_others or d["hash"] == kill)]
            for d in goners:
                await client(ResetAuthorizationRequest(hash=int(d["hash"])))
                say(f"выгнал: {d['device']} / {d['app']} — {d['place']}")
            if not goners:
                say("выгонять некого: кроме панели устройств нет")
            print(json.dumps(await devices(client), ensure_ascii=False))
            return

        if not out:
            raise SystemExit("нечего делать: нужен --out, --list или --kill")
        say(f"{acc.get('title')}: создаю отдельный вход ({tglib.proxy_label(acc.get('proxy'))})…")
        n = await new_login(client, tglib.parse_proxy(acc.get("proxy")), Path(out))
        say(f"готово: вход создан, файлов в tdata {n}")
        say("в списке устройств аккаунта он виден как обычный Telegram Desktop — "
            "выгоняется из панели одной кнопкой")
    finally:
        await tglib.aclose(client)


asyncio.run(main())
