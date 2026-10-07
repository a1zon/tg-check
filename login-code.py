#!/usr/bin/env python3
"""
Вход в аккаунт по номеру телефона и коду из Telegram — родным каналом,
без браузера. Третий способ входа рядом с QR (login-qr.py) и готовой сессией
(import-account.py): у кого нет второго устройства под рукой, тому проще
получить код.

Код нельзя спросить в терминале, когда задачу запускает панель: у дочернего
процесса нет собеседника. Поэтому обмен идёт через файл рядом с QR-картинками:

    qr/<id>.code-wait   пишем мы: «жду код, спроси его у человека»
    qr/<id>.code        пишет панель: {"code": "12345", "password": "…"}

Оба файла временные и удаляются, чем бы дело ни кончилось. Пароль (2FA)
спрашивается тем же файлом — Telegram сообщает о нём только после кода.

    python login-code.py --account a2 --phone +79001112233 [--wait 300]
"""
import asyncio
import json
import re

import tglib
from tglib import say

QRDIR = tglib.DIR / "qr"
POLL = 1.0                      # как часто смотрим, не ввели ли код


def clean_phone(raw):
    """
    Номер в международном виде. Восьмёрку в начале российского номера меняем
    на семёрку: Telegram знает только +7, а люди пишут привычное 8.
    """
    d = re.sub(r"\D", "", str(raw or ""))
    if not d:
        raise SystemExit("не указан номер: --phone +79001112233")
    if len(d) == 11 and d[0] == "8":
        d = "7" + d[1:]
    if len(d) < 7:
        raise SystemExit(f"это не похоже на номер: {raw}")
    return "+" + d


_asked = [0]


async def ask(acc_id, deadline, what):
    """
    Ждём, пока панель положит файл с кодом. Возвращает словарь или None,
    если время вышло. Файл сразу убираем: второй раз тот же код не годится.

    К просьбе приписан номер захода: панель спрашивает человека, только когда
    просьба сменилась, — иначе после неверного кода она бы промолчала, решив,
    что этот вопрос уже задавала.
    """
    wait_file = QRDIR / f"{acc_id}.code-wait"
    code_file = QRDIR / f"{acc_id}.code"
    QRDIR.mkdir(exist_ok=True)
    code_file.unlink(missing_ok=True)
    _asked[0] += 1
    wait_file.write_text(f"{what} #{_asked[0]}", "utf-8")
    say(f"жду {what} — панель спросит его прямо в окне")
    try:
        loop = asyncio.get_event_loop()
        while loop.time() < deadline:
            if code_file.exists():
                try:
                    data = json.loads(code_file.read_text("utf-8"))
                except Exception:
                    data = {}
                code_file.unlink(missing_ok=True)
                return data
            await asyncio.sleep(POLL)
        return None
    finally:
        wait_file.unlink(missing_ok=True)


async def main():
    acc = tglib.resolve(tglib.arg("account", ""))
    phone = clean_phone(tglib.arg("phone", acc.get("phone", "")))
    wait_total = float(tglib.arg("wait", 600))

    from telethon import TelegramClient
    from telethon.errors import (PhoneCodeInvalidError, PhoneCodeExpiredError,
                                 PhoneNumberInvalidError, SessionPasswordNeededError,
                                 PasswordHashInvalidError)

    dest = tglib.session_path(acc)
    dest.parent.mkdir(parents=True, exist_ok=True)
    say(f"аккаунт: {acc['title']}  |  вход по коду на {phone}  |  "
        f"{tglib.proxy_label(acc.get('proxy'))}  |  Telethon")

    dev = tglib.device_for(acc)
    say(f"устройство: {dev['device_model']} · {dev['system_version']} · Telegram {dev['app_version']}")
    existed = dest.exists()
    client = TelegramClient(str(dest.with_suffix("")), tglib.API_ID, tglib.API_HASH,
                            proxy=tglib.parse_proxy(acc.get("proxy")), **dev)
    try:
        await client.connect()
    except (OSError, asyncio.TimeoutError) as e:
        await tglib.aclose(client)
        # пустой файл сессии, заведённый ради этой попытки, оставлять нельзя:
        # панель приняла бы его за подключённый аккаунт
        if not existed:
            dest.unlink(missing_ok=True)
        raise SystemExit(f"{type(e).__name__}: " + tglib.NO_NET % acc["id"])
    if await client.is_user_authorized():
        say("этот аккаунт уже подключён — вход не нужен")
        await tglib.aclose(client)
        return

    ok = False
    try:
        try:
            sent = await client.send_code_request(phone)
        except PhoneNumberInvalidError:
            raise SystemExit(f"Telegram не знает такой номер: {phone}")
        say("код отправлен — он придёт в Telegram на другом устройстве, "
            "а если войти больше некуда, то сообщением")

        loop = asyncio.get_event_loop()
        deadline = loop.time() + wait_total
        user = None
        while user is None:
            got = await ask(acc["id"], deadline, "код")
            if got is None:
                say("время вышло, код так и не ввели — попробуй ещё раз")
                raise SystemExit(1)
            code = re.sub(r"\D", "", str(got.get("code", "")))
            password = str(got.get("password", "")).strip()
            if not code:
                say("код пустой — жду ещё раз")
                continue
            try:
                user = await client.sign_in(phone, code, phone_code_hash=sent.phone_code_hash)
            except PhoneCodeInvalidError:
                say("код не подошёл — введи ещё раз")
            except PhoneCodeExpiredError:
                say("код протух, запрашиваю новый")
                sent = await client.send_code_request(phone)
            except SessionPasswordNeededError:
                # облачный пароль Telegram называет только после кода
                while user is None:
                    if not password:
                        more = await ask(acc["id"], deadline, "облачный пароль (2FA)")
                        if more is None:
                            say("время вышло, пароль так и не ввели")
                            raise SystemExit(1)
                        password = str(more.get("password") or more.get("code") or "").strip()
                    try:
                        user = await client.sign_in(password=password)
                    except PasswordHashInvalidError:
                        say("пароль не подошёл — введи ещё раз")
                        password = ""

        name = tglib.remember(acc, user)
        fields = {"session": str(dest.relative_to(tglib.DIR))}
        if str(acc.get("title", "")).strip().lower().startswith("аккаунт"):
            fields["title"] = name or (f"@{user.username}" if user.username else acc["title"])
        tglib.set_field(acc["id"], **fields)
        ok = True
        say(f"✓ вошли: {name or user.id}  {user.phone or ''}")
    finally:
        await tglib.aclose(client)
        (QRDIR / f"{acc['id']}.code-wait").unlink(missing_ok=True)
        (QRDIR / f"{acc['id']}.code").unlink(missing_ok=True)
        # вход не состоялся — файла сессии быть не должно, иначе панель
        # покажет аккаунт подключённым, а работать он не сможет
        if not ok and not existed:
            dest.unlink(missing_ok=True)


asyncio.run(main())
