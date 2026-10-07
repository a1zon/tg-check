#!/usr/bin/env python3
"""
Разбор чатов: собирает участников групп и каналов — родным каналом Telegram
(MTProto), тем же аккаунтом и через тот же прокси, что и остальные задачи.

Два режима:

  --chat <ссылка>     один чат;
  --folder chats      ВСЕ чаты из папки Telegram с таким названием.

Второй — основной. Вступать в чаты руками всё равно приходится, а вот
перечислять их панели по одному незачем: сложи их в Telegram в папку (там же,
где «Личные», «Каналы»), и панель пройдёт по ней сама, чат за чатом, пока они
не кончатся или пока не упрётся в предел за заход. Где остановилась — помнит
(chats.json), поэтому следующий заход начинается с неразобранных.

Собранные люди попадают в те же файлы, что и проверенные номера (results.csv),
поэтому дальше их ведёт обычная рассылка: те же брони, те же дневные пределы,
то же «одному человеку пишем один раз».

Кого берём: живых людей. Боты, удалённые аккаунты и сам аккаунт-сборщик
отбрасываются — писать им некому и незачем.

Человека с @username потом может написать ЛЮБОЙ аккаунт панели, а того, у кого
ника нет, — только этот, который его нашёл (access_hash к человеку у каждого
аккаунта свой и лежит в его сессии). Поэтому --only-username берёт только
первых: база выходит меньше, зато рассылка по ней распараллеливается целиком.

    python parse-chat.py --account a1 --folder chats --limit 2000
    python parse-chat.py --account a1 --folder chats --only-username
    python parse-chat.py --account a1 --chat https://t.me/durov_chat
    python parse-chat.py --account a1 --chat https://t.me/+AbCdEf --join
    python parse-chat.py --account a1 --folder chats --again   # заново по всем

Ограничение Telegram: у больших публичных чатов постранично отдаётся первые
~10 000 участников. Больше не даст никакой клиент — это не наш предел.
"""
import asyncio
import csv
import json
import random
import re

import tglib
from tglib import say

PAGE = 200                # столько участников за один запрос — предел Telegram
FLOOD_MAX = 600           # флуд-паузу дольше этой не пересиживаем
# Пауза считается не на страницу, а на людей: 2-3 секунды за каждую сотню
# собранных. Страница в 200 человек — это 4-6 секунд отдыха. Без этого
# большой чат разбирается «в лоб», и Telegram отвечает флуд-паузой, после
# которой заход всё равно встанет — только уже не на секунды.
PAUSE_PER_100 = (2, 3)
CHAT_PAUSE = 3            # между чатами: пауза заметнее, запросов там много

DONE = tglib.DIR / "chats.json"    # какие чаты уже разобраны


# ------------------------------------------------------------------ разное

def chat_ref(raw):
    """
    Ссылка на чат в вид, который понимает Telethon.

    t.me/joinchat/<hash> и t.me/+<hash> — приватные приглашения: по ним
    получить участников можно, только уже будучи внутри, поэтому такие
    возвращаем отдельно (invite), чтобы решить, входить или ругаться.
    """
    s = str(raw or "").strip()
    if not s:
        raise SystemExit("не указан чат: --chat <ссылка | @имя | id>")
    s = re.sub(r"^(https?://)?(www\.)?(t\.me|telegram\.me|telegram\.dog)/", "", s, flags=re.I)
    m = re.match(r"^(?:joinchat/|\+)(.+)$", s)
    if m:
        return None, m.group(1).strip("/")
    s = s.split("?")[0].strip("/")
    # t.me/c/2234656371/12 — приватный канал по внутреннему id. Telethon
    # понимает его как -100<id>; развернуть сможет только аккаунт-участник
    m = re.match(r"^c/(\d+)", s)
    if m:
        return int("-100" + m.group(1)), None
    if re.fullmatch(r"-?\d+", s):
        return int(s), None
    return s.lstrip("@"), None


def person(u, chat_title, by):
    """Строка про человека — то, что кладём в members.csv."""
    name = tglib.cell(" ".join(x for x in [u.first_name, u.last_name] if x))
    return {
        "key": tglib.member_key(u.username, u.id),
        "username": (u.username or ""),
        "name": name,
        "user_id": u.id,
        "chat": chat_title,
        "at": tglib.now_iso(),
        "by": by,
    }


def cap_of(*vals):
    """Наименьший из заданных пределов. 0 (или ничего) — предела нет."""
    live = [int(v) for v in vals if v]
    return min(live) if live else 0


def load_done():
    """Разобранные чаты: id -> когда и сколько взяли."""
    try:
        data = json.loads(DONE.read_text("utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_chat(chat_id, rec):
    data = load_done()
    data[str(chat_id)] = rec
    DONE.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", "utf-8")


def mark_done(chat_id, title, n):
    """Чат пройден ДО КОНЦА — больше не берём его в следующие заходы."""
    _save_chat(chat_id, {"title": title, "at": tglib.now_iso(), "n": n, "done": True, "offset": 0})


def mark_progress(chat_id, title, n, offset):
    """
    Чат обрезан пределом/флудом — запоминаем offset, чтобы следующий заход
    продолжил С ЭТОГО МЕСТА, а не с начала (иначе крупный чат вечно перечитывал
    бы первую страницу и участники за пределом не собирались никогда).
    """
    _save_chat(chat_id, {"title": title, "at": tglib.now_iso(), "n": n, "done": False, "offset": int(offset or 0)})


def save_members(rows):
    """
    members.csv — полный список того, что разобрали: его можно скачать из
    панели и открыть в Excel. Файл переписываем целиком, чтобы люди из разных
    чатов не задваивались: ключ у человека один.
    """
    old = {r.get("key"): r for r in tglib.read_csv(tglib.MEMBERS) if r.get("key")}
    fresh = 0
    for r in rows:
        if r["key"] not in old:
            fresh += 1
        old[r["key"]] = r
    # перевод строки строго "\n": панель читает CSV простым разрезанием строк,
    # и \r от Windows-конца прилип бы к последней колонке
    # пишем во временный файл и подменяем атомарно (os.replace) — иначе при
    # параллельном разборе двумя аккаунтами две перезаписи затирают друг друга
    import os
    tmp = tglib.MEMBERS.with_suffix(".csv.tmp")
    with tmp.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=tglib.MEMBERS_HEAD, lineterminator="\n")
        w.writeheader()
        for r in old.values():
            w.writerow({k: r.get(k, "") for k in tglib.MEMBERS_HEAD})
    os.replace(tmp, tglib.MEMBERS)
    return fresh, len(old)


# ----------------------------------------------------------------- чем брать

async def resolve_chat(client, ref, invite, join):
    """Сущность чата: по ссылке, по @имени или по приглашению."""
    from telethon import functions
    from telethon.tl.types import ChatInviteAlready, ChatInvitePeek

    if invite:
        res = await client(functions.messages.CheckChatInviteRequest(invite))
        if isinstance(res, (ChatInviteAlready, ChatInvitePeek)):
            return res.chat
        if not join:
            raise SystemExit(
                "это приватное приглашение, а аккаунт в чате не состоит.\n"
                "Участников закрытого чата видно только изнутри — вступи сам "
                "или добавь --join (в панели — галочка «вступить, если нужно»).")
        say("аккаунта в чате нет — вступаю по приглашению")
        upd = await client(functions.messages.ImportChatInviteRequest(invite))
        return upd.chats[0]

    try:
        return await client.get_entity(ref)
    except ValueError:
        raise SystemExit(f"не нашёл такой чат: {ref}. Проверь ссылку — "
                         "у публичного чата она вида t.me/имя")


async def folder_chats(client, name):
    """
    Чаты из папки Telegram с таким названием. Папки — это то же самое, что
    человек видит слева от списка чатов; панель берёт из папки ровно те чаты,
    которые в неё добавлены поимённо.
    """
    from telethon import functions
    from telethon.tl.types import (DialogFilter, DialogFilterChatlist,
                                   InputPeerUser, InputPeerSelf)

    res = await client(functions.messages.GetDialogFiltersRequest())
    filters = getattr(res, "filters", res)      # старые слои отдавали список
    want = str(name).strip().casefold()
    found, names = None, []
    for f in filters:
        # «Все чаты» — не папка, у неё и названия нет
        if not isinstance(f, (DialogFilter, DialogFilterChatlist)):
            continue
        title = getattr(f.title, "text", f.title)   # в новых слоях это объект
        names.append(str(title))
        if str(title).strip().casefold() == want:
            found = f

    if found is None:
        have = ", ".join(f"«{n}»" for n in names) if names else "ни одной"
        raise SystemExit(
            f"в Telegram у этого аккаунта нет папки «{name}».\n"
            f"Есть: {have}.\n"
            "Заведи папку в Telegram (Настройки -> Папки), сложи в неё чаты "
            "и запусти снова.")

    if getattr(found, "groups", False) or getattr(found, "broadcasts", False):
        say("⚠ в папке включены «все группы/каналы» скопом — панель берёт только "
            "те чаты, что добавлены в неё поимённо")

    peers, seen = [], set()
    for p in list(getattr(found, "pinned_peers", []) or []) + list(found.include_peers or []):
        if isinstance(p, (InputPeerUser, InputPeerSelf)):
            continue                     # личная переписка — не чат с участниками
        key = getattr(p, "channel_id", None) or getattr(p, "chat_id", None)
        if not key or key in seen:
            continue
        seen.add(key)
        peers.append(p)
    return peers


async def pull(client, entity, limit, only_user=False, start_offset=0):
    """
    Участники постранично. У супергрупп и каналов — channels.GetParticipants:
    по 200 человек за раз, сдвигая offset, пока страницы не кончатся. Старые
    маленькие группы этого запроса не знают — там Telethon сам сходит за
    полным составом.

    Возвращает (люди, пауза): пауза больше нуля — Telegram попросил столько
    подождать, чат не дособран, и столько же отдыхает аккаунт.
    """
    from telethon.tl.functions.channels import GetParticipantsRequest
    from telethon.tl.types import Channel, ChannelParticipantsSearch
    from telethon.errors import FloodWaitError

    me = await client.get_me()
    out, seen = [], set()

    def keep(u):
        if u.bot or u.deleted or u.id == me.id or u.id in seen:
            return False
        if only_user and not u.username:
            return False        # такого напишет только этот аккаунт — не берём
        seen.add(u.id)
        return True

    if not isinstance(entity, Channel):
        async for u in client.iter_participants(entity):
            if keep(u):
                out.append(u)
                if limit and len(out) >= limit:
                    return out, 0, 0, False        # обрезали пределом — не дочитан
        return out, 0, 0, True                     # маленькая группа прочитана целиком

    offset = int(start_offset or 0)
    finished = False
    while True:
        try:
            part = await client(GetParticipantsRequest(
                channel=entity,
                filter=ChannelParticipantsSearch(""),
                offset=offset,
                limit=PAGE,
                hash=0,
            ))
        except FloodWaitError as e:
            if e.seconds > FLOOD_MAX:
                say(f"  стоп: Telegram просит подождать {e.seconds} с — "
                    f"собрано {len(out)}, остальное в следующий заход")
                return out, e.seconds, offset, False
            say(f"  … флуд-пауза {e.seconds} с")
            await asyncio.sleep(e.seconds)
            continue

        if not part.users:
            finished = True
            break
        for u in part.users:
            if keep(u):
                out.append(u)
        # сдвигаемся на ВСЕХ, кого отдал Telegram, а не на тех, кого оставили:
        # offset — это его счётчик, и пропуск ботов сбил бы страницы
        offset += len(part.users)
        say(f"  собрано {len(out)} (просмотрено {offset})")
        if limit and len(out) >= limit:
            return out[:limit], 0, offset, False       # обрезали пределом — не дочитан
        if len(part.users) < PAGE:
            finished = True
            break
        rest = len(part.users) / 100 * random.uniform(*PAUSE_PER_100)
        say(f"  пауза {rest:.0f} с")
        await asyncio.sleep(rest)

    return out, 0, offset, finished


async def take(client, entity, acc_id, cap, only_user=False, start_offset=0):
    """
    Один чат целиком: собрать, записать, отчитаться. Пишем сразу после чата,
    а не в конце всего прогона: иначе флуд-пауза на пятом чате обнулила бы
    работу по четырём предыдущим.
    """
    title = tglib.cell(getattr(entity, "title", None)
                       or getattr(entity, "username", "") or str(entity.id))
    say(f"\n▸ {title}")
    users, wait, offset, finished = await pull(client, entity, cap, only_user, start_offset)
    people = [p for p in (person(u, title, acc_id) for u in users) if p["key"]]
    fresh, _ = save_members(people)
    added, dup = tglib.add_recipients(people, by=acc_id)
    say(f"  участников {len(people)} · новых в списке {fresh} · "
        f"в очередь на рассылку {added}" + (f" · уже были {dup}" if dup else ""))
    return title, people, added, wait, offset, finished


# ------------------------------------------------------------------- прогон

async def main():
    acc = tglib.resolve(tglib.arg("account", ""))
    limit = int(tglib.arg("limit", 0) or 0)            # людей за весь заход
    per_chat = int(tglib.arg("per-chat", 0) or 0)      # людей с одного чата
    folder = str(tglib.arg("folder", "") or "").strip()
    chat = str(tglib.arg("chat", "") or "").strip()
    list_file = str(tglib.arg("list", "") or "").strip()
    join = tglib.flag("join")
    again = tglib.flag("again")
    only_user = tglib.flag("only-username")

    if not folder and not chat and not list_file:
        raise SystemExit("укажи, откуда брать людей: --chat <ссылка>, --list <файл> или --folder <папка>")

    say(f"аккаунт: {acc['title']}  |  разбор чатов"
        f"{' (только с @username)' if only_user else ''}  |  "
        f"{tglib.proxy_label(acc.get('proxy'))}  |  Telethon")

    client = await tglib.connect(acc)
    say(f"сессия активна: {tglib.who(acc)}")

    from telethon.errors import (ChatAdminRequiredError, ChannelPrivateError,
                                 FloodWaitError)

    total_added = total_people = total_solo = 0
    chats_done = 0
    left_chats = 0
    wait = 0            # сколько Telegram просит отдыхать, 0 — не просил
    try:
        # ---- собираем источники в единую очередь ----
        # folder — объекты-пиры из папки Telegram; chat/list — ссылки строками.
        # Дальше всё идёт одним циклом: разобрали, записали, пауза, следующий.
        if folder:
            items = await folder_chats(client, folder)
            kind = "folder"
        elif list_file:
            raw = open(list_file, encoding="utf-8").read()
            items = [ln.strip() for ln in raw.splitlines()
                     if ln.strip() and not ln.strip().startswith("#")]
            kind = "links"
        else:
            items = [chat]
            kind = "links"

        done = {} if again else load_done()
        say(f"источников: {len(items)}"
            + (f", уже разобрано раньше {sum(1 for _ in done)}" if done else ""))
        if limit:
            say(f"предел за этот заход: {limit} человек")

        for i, item in enumerate(items):
            if limit and total_added >= limit:      # считаем НОВЫХ, а не сырой сбор с дублями
                left_chats = len(items) - i
                say(f"\nпредел за заход выбран — осталось источников: {left_chats}")
                break

            # получить сущность чата: из пира (папка) или из ссылки (список)
            try:
                if kind == "folder":
                    entity = await client.get_entity(item)
                else:
                    ref, invite = chat_ref(item)
                    entity = await resolve_chat(client, ref, invite, join)
            except FloodWaitError as e:
                say(f"\n▸ {item} — флуд-пауза {e.seconds} с, на сегодня хватит")
                wait, left_chats = e.seconds, len(items) - i
                break
            except SystemExit as e:
                say(f"\n▸ {item} — пропускаю: {str(e).splitlines()[0][:100]}")
                continue
            except Exception as e:
                say(f"\n▸ {item} — пропускаю: {str(e).splitlines()[0][:100] or type(e).__name__}")
                continue

            entry = done.get(str(entity.id))
            if entry and entry.get("done", True):     # старые записи без флага = дочитаны
                continue
            start_offset = int(entry.get("offset", 0)) if entry else 0

            cap = cap_of(limit - total_added if limit else 0, per_chat)
            try:
                title, people, added, wait, offset, finished = await take(
                    client, entity, acc["id"], cap, only_user, start_offset)
            except ChatAdminRequiredError:
                say("  список участников закрыт настройками чата — пропускаю")
                mark_done(entity.id, tglib.cell(getattr(entity, "title", entity.id)), 0)
                continue
            except ChannelPrivateError:
                say("  чат приватный, аккаунт в нём не состоит — пропускаю")
                continue
            except FloodWaitError as e:
                say(f"  Telegram просит паузу {e.seconds} с — на сегодня хватит")
                wait, left_chats = e.seconds, len(items) - i
                break
            except Exception as e:
                say(f"  не вышло: {str(e).splitlines()[0][:120] or type(e).__name__}")
                continue

            total_people += len(people)
            total_added += added
            total_solo += sum(1 for x in people if not x["username"])
            chats_done += 1
            # дочитан до конца — помечаем done; обрезан пределом/флудом — сохраняем
            # offset, чтобы следующий заход продолжил С ЭТОГО МЕСТА (а не с нуля)
            if finished:
                mark_done(entity.id, title, len(people))
            else:
                mark_progress(entity.id, title, len(people), offset)
            if wait:
                left_chats = len(items) - i
                break
            if i < len(items) - 1:
                await asyncio.sleep(CHAT_PAUSE)
    finally:
        await tglib.aclose(client)

    say(f"\nитого: чатов разобрано {chats_done} · участников {total_people} · "
        f"в очередь на рассылку добавлено {total_added}")
    if left_chats:
        say(f"осталось чатов: {left_chats} — запусти разбор ещё раз, "
            "панель продолжит с неразобранных")
    if total_added:
        say("им можно писать сразу — проверять номера тут нечего")
    if total_solo:
        say(f"из них без @username: {total_solo} — этих напишет только "
            f"«{acc['title']}», остальным аккаунтам они не видны "
            "(--only-username берёт лишь тех, кого напишет любой)")
    # flood — единственная причина, по которой аккаунту стоит отлежаться;
    # выбранный предел за заход отдыха не требует
    tglib.state(done=total_added, left=left_chats,
                stop="flood" if wait else "", cooldown=wait)


asyncio.run(main())
