#!/usr/bin/env python3
"""
Вход в аккаунт по QR — родным каналом Telegram, без браузера.
Замена login.mjs (там QR показывал Telegram Web в окне Playwright).

Код показывается двумя способами сразу:
  • картинкой qr/<id>.svg — её показывает панель;
  • значками прямо в терминале, если запускать руками.

Сканировать: Telegram на телефоне -> Настройки -> Устройства ->
Подключить устройство. Код живёт около минуты и обновляется сам.

    python login-qr.py --account a2 [--password <облачный пароль>] [--wait 180]
"""
import asyncio
import sys

import tglib
from tglib import say

QRDIR = tglib.DIR / "qr"


def draw(url: str, acc_id: str):
    """Кладём QR картинкой для панели и, если это терминал, рисуем значками."""
    import qrcode
    qr = qrcode.QRCode(border=2)
    qr.add_data(url)
    QRDIR.mkdir(exist_ok=True)
    path = QRDIR / f"{acc_id}.svg"
    try:
        from qrcode.image.svg import SvgPathImage
        qr.make_image(image_factory=SvgPathImage).save(str(path))
    except Exception as e:                      # без картинки вход всё равно возможен
        say(f"(картинку QR сделать не вышло: {type(e).__name__})")
        path = None
    if sys.stdout.isatty():
        qr.print_ascii(invert=True)
    return path


async def main():
    acc = tglib.resolve(tglib.arg("account", ""))
    password = tglib.arg("password", "")
    wait_total = float(tglib.arg("wait", 300))

    from telethon import TelegramClient
    from telethon.errors import SessionPasswordNeededError

    dest = tglib.session_path(acc)
    dest.parent.mkdir(parents=True, exist_ok=True)
    say(f"аккаунт: {acc['title']}  |  {tglib.proxy_label(acc.get('proxy'))}  |  Telethon")

    existed = dest.exists()
    client = TelegramClient(str(dest.with_suffix("")), tglib.API_ID, tglib.API_HASH,
                            proxy=tglib.parse_proxy(acc.get("proxy")), **tglib.DEVICE)
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
        qr = await client.qr_login()
        loop = asyncio.get_event_loop()
        deadline = loop.time() + wait_total
        user = None
        while user is None and loop.time() < deadline:
            path = draw(qr.url, acc["id"])
            say(f"QR готов{f' — {path.relative_to(tglib.DIR)}' if path else ''}; "
                f"скан: Telegram -> Настройки -> Устройства -> Подключить устройство")
            say(f"ссылка (если удобнее вручную): {qr.url}")
            try:
                user = await qr.wait(min(50, max(5, deadline - loop.time())))
            except asyncio.TimeoutError:
                await qr.recreate()             # код протух — рисуем следующий
            except SessionPasswordNeededError:
                if not password:
                    say("на аккаунте стоит облачный пароль (2FA) — запусти ещё раз "
                        "с --password <пароль>")
                    raise SystemExit(2)
                user = await client.sign_in(password=password)

        if user is None:
            say("время вышло, код никто не отсканировал — попробуй ещё раз")
            raise SystemExit(1)

        name = tglib.remember(acc, user)
        fields = {"session": str(dest.relative_to(tglib.DIR))}
        if str(acc.get("title", "")).strip().lower().startswith("аккаунт"):
            fields["title"] = name or (f"@{user.username}" if user.username else acc["title"])
        tglib.set_field(acc["id"], **fields)
        ok = True
        say(f"✓ вошли: {name or user.id}  {user.phone or ''}")
    finally:
        await tglib.aclose(client)
        # отработавший код больше не нужен и не должен вводить в заблуждение
        (QRDIR / f"{acc['id']}.svg").unlink(missing_ok=True)
        # вход не состоялся — файла сессии быть не должно, иначе панель
        # покажет аккаунт подключённым, а работать он не сможет
        if not ok and not existed:
            dest.unlink(missing_ok=True)


asyncio.run(main())
