#!/usr/bin/env python3
"""
Профиль аккаунта прямо из панели: имя, фамилия, «о себе», @username, аватарка.

Почему не «открыть аккаунт в браузере»: сессия Telethon — это ключ MTProto,
браузеру он не подходит. Чтобы зайти в Telegram Web, аккаунту пришлось бы
логиниться заново по QR — то есть заводить вторую сессию на тот же номер.
Здесь всё делается тем же ключом, которым панель уже работает: безопасно
и без лишних входов, которые Telegram считает подозрительными.

    python profile.py --account a1 --name Андрей --last Петров
    python profile.py --account a1 --about "Подбор техники"
    python profile.py --account a1 --username andrey_boldo
    python profile.py --account a1 --photo /путь/avatar.jpg
    python profile.py --account a1 --drop-photos        # убрать все старые фото
    python profile.py --account a1                       # просто показать, что сейчас
"""
import asyncio
from pathlib import Path

import tglib
from tglib import say


async def main():
    acc = tglib.resolve(tglib.arg("account", ""))
    name = tglib.arg("name")
    last = tglib.arg("last")
    about = tglib.arg("about")
    username = tglib.arg("username")
    photo = tglib.arg("photo")
    drop_photos = tglib.flag("drop-photos")

    from telethon import functions, types
    from telethon.errors import (UsernameOccupiedError, UsernameInvalidError,
                                 FloodWaitError)

    say(f"аккаунт: {acc['title']}  |  {tglib.proxy_label(acc.get('proxy'))}")
    client = await tglib.connect(acc)
    try:
        me = await client.get_me()
        say(f"сейчас: {me.first_name or ''} {me.last_name or ''}".rstrip()
            + (f"  @{me.username}" if me.username else "  (без @)"))

        changed = False

        if name is not None or last is not None or about is not None:
            kw = {}
            if name is not None:
                kw["first_name"] = name
            if last is not None:
                kw["last_name"] = last
            if about is not None:
                kw["about"] = about
            await client(functions.account.UpdateProfileRequest(**kw))
            say("✓ имя/описание обновлены")
            changed = True

        if username is not None:
            try:
                await client(functions.account.UpdateUsernameRequest(username=username))
                say(f"✓ @{username} занят за аккаунтом")
                changed = True
            except UsernameOccupiedError:
                say(f"✗ @{username} уже кем-то занят — придумай другой")
            except UsernameInvalidError:
                say(f"✗ @{username} не подходит: 5–32 знака, латиница, цифры и _")

        # Купленные аккаунты приезжают с чужими фотографиями прежнего хозяина.
        # Новая аватарка их не отменяет: она просто встаёт первой, а старые
        # остаются в профиле — их видно, если нажать на аватар. Люди это
        # замечают и спрашивают, почему у «Егора» две фотографии девушки.
        if drop_photos:
            got = await client(functions.photos.GetUserPhotosRequest(
                user_id="me", offset=0, max_id=0, limit=100))
            if got.photos:
                await client(functions.photos.DeletePhotosRequest(
                    id=[types.InputPhoto(id=ph.id, access_hash=ph.access_hash,
                                         file_reference=ph.file_reference) for ph in got.photos]))
                say(f"✓ убрал старые фотографии: {len(got.photos)}")
                changed = True
            else:
                say("старых фотографий нет")

        if photo:
            p = Path(photo)
            if not p.exists():
                say(f"✗ файл не найден: {p}")
            else:
                f = await client.upload_file(str(p))
                await client(functions.photos.UploadProfilePhotoRequest(file=f))
                say(f"✓ аватарка поставлена ({p.name})")
                changed = True

        if changed:
            me = await client.get_me()
            tglib.remember(acc, me)
            await tglib.save_avatar(client, acc, me, force=True)
            say(f"\nтеперь: {me.first_name or ''} {me.last_name or ''}".rstrip()
                + (f"  @{me.username}" if me.username else ""))
        else:
            say("\nничего не меняли — только посмотрели")
    except FloodWaitError as e:
        say(f"Telegram просит подождать {e.seconds} с — профиль меняли слишком часто")
    finally:
        await tglib.aclose(client)


asyncio.run(main())
