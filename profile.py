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

Канал-прокладка — свой маленький публичный канал аккаунта, поставленный в профиль
(«канал в профиле» бесплатен всем, но только СВОЙ канал). В нём закреплённый пост со
ссылкой на основной канал: человек открыл профиль → видит пост → переходит.

    python profile.py --account a1 --channel-title "Недвижимость Екб" \
        --channel-username ekb_notes_a1 --channel-post "Разборы квартир — t.me/+AbC"
    python profile.py --account a1 --channel-post "новый текст"   # тот же канал, новый пост
    python profile.py --account a1 --channel-off                  # убрать канал из профиля
"""
import asyncio
from pathlib import Path

import tglib
from tglib import say


async def bridge_channel(client, acc, title, username, post):
    """
    Канал-прокладка: создать (или взять уже созданный этим аккаунтом), дать
    публичный ник, выложить и закрепить пост со ссылкой, поставить в профиль.
    Повторный вызов с одним постом — тот же канал, новый закреплённый пост.
    """
    from telethon import functions, types
    from telethon.errors import (UsernameOccupiedError, UsernameInvalidError, UserRestrictedError,
                                 ChannelsAdminPublicTooMuchError, ChannelsTooMuchError, FloodWaitError)
    ch = None
    if acc.get("channelId"):
        try:
            ch = await client.get_entity(types.PeerChannel(int(acc["channelId"])))
        except Exception:
            ch = None
            say("прежний канал аккаунта не нашёлся — создам новый")
    try:
        if ch is None:
            if not title:
                say("✗ канала ещё нет — нужно название (--channel-title)")
                return False
            res = await client(functions.channels.CreateChannelRequest(
                title=title, about="", broadcast=True))
            ch = res.chats[0]
            tglib.set_field(acc["id"], channelId=ch.id, channelTitle=title)
            say(f"✓ канал создан: «{title}»")
        elif title and title != acc.get("channelTitle"):
            await client(functions.channels.EditTitleRequest(channel=ch, title=title))
            tglib.set_field(acc["id"], channelTitle=title)
            say(f"✓ название канала: «{title}»")

        if username and username.lstrip("@") != (getattr(ch, "username", None) or acc.get("channel") or ""):
            u = username.lstrip("@")
            if not await client(functions.channels.CheckUsernameRequest(channel=ch, username=u)):
                say(f"✗ @{u} занят или не подходит — канал остался без ника, в профиль не ставлю")
                return True
            await client(functions.channels.UpdateUsernameRequest(channel=ch, username=u))
            tglib.set_field(acc["id"], channel=u)
            say(f"✓ ник канала: @{u}")
        if not (getattr(ch, "username", None) or tglib.resolve(acc["id"]).get("channel")):
            say("✗ у канала нет публичного ника — в профиль Telegram ставит только публичный")
            return True

        if post:
            m = await client.send_message(ch, post, link_preview=True)
            await client(functions.messages.UpdatePinnedMessageRequest(peer=ch, id=m.id, silent=True))
            say("✓ пост выложен и закреплён")

        await client(functions.account.UpdatePersonalChannelRequest(channel=ch))
        tglib.set_field(acc["id"], channelOn=True, channelAt=tglib.now_iso())
        say("✓ канал стоит в профиле: открыли профиль — видят пост")
        return True
    except UserRestrictedError:
        say("✗ Telegram не даёт создавать каналы, пока аккаунт под ограничением SpamBot — "
            "сделай это после снятия")
    except ChannelsAdminPublicTooMuchError:
        say("✗ у аккаунта уже предел публичных каналов — освободи ник у старого")
    except ChannelsTooMuchError:
        say("✗ у аккаунта предел каналов и групп")
    except (UsernameOccupiedError, UsernameInvalidError):
        say(f"✗ ник @{username} не подошёл: 5–32 знака, латиница, цифры и _, не занят")
    except FloodWaitError:
        raise
    return False


async def main():
    acc = tglib.resolve(tglib.arg("account", ""))
    name = tglib.arg("name")
    last = tglib.arg("last")
    about = tglib.arg("about")
    username = tglib.arg("username")
    photo = tglib.arg("photo")
    drop_photos = tglib.flag("drop-photos")
    ch_title = tglib.arg("channel-title")
    ch_user = tglib.arg("channel-username")
    ch_post = tglib.arg("channel-post")
    ch_off = tglib.flag("channel-off")

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
            if about is not None:
                tglib.set_field(acc["id"], about=about)     # панель покажет его в меню
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

        if ch_off:
            await client(functions.account.UpdatePersonalChannelRequest(channel=types.InputChannelEmpty()))
            tglib.set_field(acc["id"], channelOn=False)
            say("✓ канал убран из профиля (сам канал остался)")
            changed = True
        elif ch_title or ch_user or ch_post:
            changed = await bridge_channel(client, acc, ch_title, ch_user, ch_post) or changed

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
