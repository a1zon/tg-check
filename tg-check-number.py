#!/usr/bin/env python3
"""
Проверка: есть ли у номера Telegram — через Telethon (contacts.ImportContacts).

Для follow-up своей базы: по номеру видно, есть ли аккаунт и имя, чтобы писать
в Telegram тем, у кого он есть, а не вслепую. Импортированный контакт сразу
удаляется из книжки аккаунта.

    python tg-check-number.py --session <файл> [--proxy ...] --phones +7..,+7..

Сессия аккаунта панели (sessions/ основного профиля или profiles/<имя>) идёт
как в задачах: через СВОЙ прокси аккаунта, со своим api_id и отпечатком, страна
выхода — до подключения и пока идёт проверка. Чужая сессия — только с --proxy
(прямой выход нарочно — TG_ALLOW_DIRECT=1).

На каждый номер печатает JSON-строку:
    {"phone":"+7..","tg":true,"name":"..","username":".."}
    {"phone":"+7..","tg":false}
"""
import argparse
import asyncio
import json
import os
import random
import sys
from pathlib import Path


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", required=True)
    ap.add_argument("--proxy", default="")
    ap.add_argument("--phones", required=True)
    ap.add_argument("--delay", type=float, default=3.0)
    return ap.parse_args()


A = parse_args()
SESSION = Path(A.session.removesuffix(".session") + ".session").expanduser()


def use_profile_of(session):
    """Сессия лежит в sessions/ профиля панели — читаем его реестр (TG_PANEL_DIR)."""
    code, d = Path(__file__).resolve().parent, session.resolve().parent.parent
    if (not os.environ.get("TG_PANEL_DIR") and session.resolve().parent.name == "sessions"
            and (d == code or d.parent == code / "profiles") and (d / "accounts.json").exists()):
        os.environ["TG_PANEL_DIR"] = str(d)


use_profile_of(SESSION)
import tglib  # noqa: E402 — после выбора профиля: tglib читает TG_PANEL_DIR при импорте

# сторож страны выхода пишет через tglib.say (stdout) — а stdout тут только JSON
tglib.say = lambda *a: print(*a, file=sys.stderr, flush=True)


def out(d):
    print(json.dumps(d, ensure_ascii=False), flush=True)


def panel_account(session):
    """Аккаунт панели с этим файлом сессии, None — сессия чужая."""
    p = session.resolve()
    for a in tglib.load_accounts():
        try:
            if tglib.session_path(a).resolve() == p:
                return a
        except Exception:
            continue
    return None


async def gate(acc, raw, label):
    """
    Прокси и страна выхода — ДО Telegram, как tglib.connect. Аккаунт панели
    идёт только через свой прокси (одна строка — один аккаунт); нет своего —
    через переданный. Возвращает (кого сторожит guard_exit, страна).
    """
    own = str((acc or {}).get("proxy") or "").strip()
    if acc and tglib.full_rest_left(acc) > 0:
        raise SystemExit(f"«{acc.get('title', acc['id'])}» на полном отдыхе после заморозки — к Telegram не подключаю")
    if own:
        if raw.strip() and raw.strip() != own:
            print("у аккаунта в панели свой прокси — иду через него, а не через переданный", file=sys.stderr)
        g = acc
    else:
        # не свой прокси аккаунта — отметки «выход из X» в реестр не пишем (id нет)
        g = {"id": "", "title": (acc or {}).get("title") or label, "proxy": raw.strip()}
    _, country = await tglib.require_country(g)
    return g, country


async def main():
    from telethon import TelegramClient, functions
    from telethon.tl.types import InputPhoneContact
    from telethon.errors import FloodWaitError

    if not SESSION.exists():
        out({"error": f"нет файла сессии {SESSION}"})
        sys.exit(2)
    phones = [p.strip() for p in A.phones.split(",") if p.strip()]
    acc = panel_account(SESSION)
    try:
        g, country = await gate(acc, A.proxy, SESSION.stem)
        if acc:
            client = tglib.make_client({**acc, "proxy": g["proxy"]})
            client._tg_acc = {**acc, "proxy": g["proxy"]}     # трафик — в traffic.csv аккаунта
        else:
            client = TelegramClient(str(SESSION.with_suffix("")), tglib.DEFAULT_API_ID,
                                    tglib.DEFAULT_API_HASH, proxy=tglib.client_proxy(g),
                                    connection_retries=3, timeout=20, **tglib.DEVICE)
    except SystemExit as e:
        out({"error": str(e)})
        sys.exit(2)

    try:
        await client.connect()
        if country:
            # номеров бывает много, с паузами — проверка идёт минутами
            tglib.guard_exit(client, g, country)
        if not await client.is_user_authorized():
            out({"error": "session_dead"})
            return

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
                    out({"phone": phone, "tg": True, "name": name, "username": u.username or ""})
                    await client(functions.contacts.DeleteContactsRequest(id=[u.id]))
                else:
                    out({"phone": phone, "tg": False})
            except FloodWaitError as e:
                out({"phone": phone, "flood_wait": e.seconds})
                await asyncio.sleep(e.seconds)
                continue
            except tglib.ExitDrift as e:
                # прокси ушёл из страны посреди проверки — сторож оборвал связь
                out({"error": str(e)})
                raise
            except Exception as e:
                out({"phone": phone, "error": f"{type(e).__name__}: {str(e)[:80]}"})
                if tglib.is_frozen_error(e):
                    # заморожен: каждый следующий номер упадёт так же — стоп и отметка
                    if acc:
                        req = getattr(e, "request", None)
                        method = type(req).__name__.removesuffix("Request") if req is not None else "ImportContacts"
                        try:
                            tglib.mark_frozen(acc["id"], f"{type(e).__name__}: {e}", f"tg-check-number:{method}")
                        except Exception:
                            pass
                    out({"error": "frozen"})
                    break
                if isinstance(e, ConnectionError) and not client.is_connected():
                    out({"error": "связь с Telegram оборвана"})
                    break
            if i < len(phones) - 1:
                await asyncio.sleep(A.delay + random.uniform(0, A.delay))
    finally:
        await tglib.aclose(client)


asyncio.run(main())
