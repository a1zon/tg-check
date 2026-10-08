#!/usr/bin/env python3
"""
Прогрев поведением: аккаунт ведёт себя как живой человек, а не как свежий
номер, который сразу пошёл писать незнакомым.

За один запуск делается РОВНО ОДНО действие. Пачками нельзя: подписаться на
пять каналов одним вызовом — это ровно та картинка, по которой Telegram
раздаёт ограничения. Паузы между действиями держит панель, она же решает,
когда аккаунту пора сделать следующий шаг и когда уйти спать на пару часов.

Что умеет:
  подписаться на канал · почитать ленту и поставить реакцию · проголосовать
  в опросе · вступить в открытую группу · запустить бота, который потом сам
  шлёт уведомления · написать своему же аккаунту и ответить ему · спросить
  у @SpamBot, нет ли ограничений

Сколько чего в сутки — зависит от возраста аккаунта (см. PLAN). Предел на
сегодня у каждого аккаунта свой: он выбирается из вилки один раз в сутки и
не скачет от запуска к запуску. Первые сутки аккаунт не делает НИЧЕГО —
это отлёжка, её же соблюдает и рассылка.

    python warmup-activity.py --account a1
    python warmup-activity.py --account a1 --what sub    # только подписка
"""
import asyncio
import hashlib
import json
import random
from datetime import datetime, timezone

import tglib
from tglib import say

READ_MIN, READ_MAX = 5, 15        # сколько «читаем» пост, прежде чем реагировать
HISTORY = 20                      # столько последних постов смотрим в канале

# Возраст аккаунта в днях -> сколько ЧЕГО можно за сутки (вилка «от-до»).
# Числа намеренно скромные: прогрев нужен, чтобы аккаунт дожил до работы,
# а не чтобы быстрее отчитаться.
PLAN = [
    (1, {"sub": (1, 2), "chat": (0, 0), "react": (2, 3), "dm": (0, 0), "bot": (0, 1)}),
    (4, {"sub": (2, 3), "chat": (1, 2), "react": (3, 5), "dm": (2, 3), "bot": (1, 2)}),
    (7, {"sub": (4, 5), "chat": (3, 3), "react": (5, 7), "dm": (3, 5), "bot": (1, 2)}),
]
PLAN_DAYS = PLAN[-1][0]          # на сколько дней расписан образец выше

# ДОГРЕВ — для тех, кто прогрев уже прошёл.
#
# Прогрев нужен, чтобы довести новый аккаунт до рабочего объёма. Когда срок
# вышел, водить его по той же программе незачем: цель достигнута, а лишние
# действия — это лишние запросы через общий прокси и лишний риск. Но и замирать
# насовсем нельзя: аккаунт, который месяц ничего не делает и вдруг начинает
# писать незнакомым, выглядит ровно как купленный. Поэтому остаётся редкая
# фоновая жизнь — одно-два действия в сутки.
# одно-два действия: чтение с реакцией — самое безобидное, переписка со
# своими — самое человеческое. Подписок и групп тут уже не нужно.
TOP_UP = {"sub": (0, 0), "chat": (0, 0), "react": (1, 1), "dm": (0, 1), "bot": (0, 0)}


def warm_days():
    """
    За сколько дней аккаунт выходит на полный объём. Срок задаётся в панели
    (вкладка «Прогрев») и лежит в warmup.json — тот же файл читает и панель.
    """
    try:
        n = int(json.loads((tglib.DIR / "warmup.json").read_text("utf-8")).get("warmDays") or 0)
    except Exception:
        return PLAN_DAYS
    return max(2, min(21, n)) if n else PLAN_DAYS


def plan_for(days):
    """
    Та же лестница, разложенная на выбранный срок. Сжали срок — ступени
    сходятся, и из двух на одном дне остаётся старшая: короткий прогрев
    значит «быстрее выходим на объём», а не «дважды топчемся на месте».
    """
    if days == PLAN_DAYS:
        return PLAN
    k = days / PLAN_DAYS
    out = {}
    for since, step in PLAN:
        day = max(1, min(days, round(since * k)))
        out[day] = step               # старшая ступень затирает младшую
    if days not in out:
        out[days] = PLAN[-1][1]
    first = min(out)
    if first > 1:                     # после отлёжки аккаунт работает сразу
        out[1] = out.pop(first)
    return sorted(out.items())

KINDS = ("sub", "chat", "react", "dm", "bot")

# Кого зовём чаще. Чтение с реакцией — самое безобидное и самое «человеческое»,
# подписки и вступления реже. Переписку зовём чаще, чем раньше: разговор из
# одного сообщения в сутки — не разговор, собеседник ждёт ответа днями.
WEIGHT = {"react": 5, "sub": 2, "chat": 1, "dm": 3, "bot": 2}

# Человеческие фразы для панели: что аккаунт делает сейчас / что сделал.
# Их показывает прогресс-бар — чтобы было видно живое действие, а не сухой лог.
DOING = {
    "sub": "подписывается на канал", "chat": "вступает в группу",
    "react": "читает ленту и ставит реакцию", "dm": "пишет своему аккаунту",
    "bot": "запускает бота", "spam": "спрашивает у SpamBot про лимиты",
}
DONE = {
    "sub": "подписался на канал", "chat": "вступил в группу",
    "react": "почитал ленту, поставил реакцию", "dm": "написал своему аккаунту",
    "bot": "запустил бота", "spam": "проверил лимиты у SpamBot",
}


def now_iso():
    return tglib.now_iso()


def load_list():
    """
    Куда водим аккаунты. Рабочий файл — warm-list.json, его правит хозяин
    панели. Образец warm-list.default.json приезжает с кодом; если рабочего
    ещё нет, делаем его из образца. Дальше обновления кода рабочий файл не
    трогают — иначе правки на сервере затирались бы при каждой выгрузке.
    """
    if not tglib.WARM_LIST.exists() and tglib.WARM_LIST_DEFAULT.exists():
        tglib.WARM_LIST.write_text(tglib.WARM_LIST_DEFAULT.read_text("utf-8"), "utf-8")
        say(f"завёл {tglib.WARM_LIST.name} из образца — правь его, он твой")
    try:
        return json.loads(tglib.WARM_LIST.read_text("utf-8"))
    except Exception as e:
        raise SystemExit(f"не читается {tglib.WARM_LIST.name}: {e}")


def age_days(acc):
    """Сколько суток аккаунту по меркам прогрева. Ставит отметку тот же код,
    что и у рассылки, — возраст у них общий."""
    from_ = acc.get("warmFrom") or acc.get("added") or now_iso()
    try:
        started = datetime.fromisoformat(str(from_).replace("Z", "+00:00"))
    except Exception:
        return 0
    return max(0, int((datetime.now(timezone.utc) - started).total_seconds() // 86400))


def caps(acc_id, day):
    """
    Предел на сегодня по каждому виду действий. Из вилки выбираем одно число
    на сутки — но так, чтобы оно не менялось между запусками: иначе аккаунт
    то «уже всё сделал», то «ещё может», и лимит перестаёт быть лимитом.
    """
    if day >= warm_days():
        step = TOP_UP            # прогрев пройден, остаётся догрев
    else:
        step = {}
        for since, plan in plan_for(warm_days()):
            if day >= since:
                step = plan
    out = {}
    today = datetime.now().strftime("%Y-%m-%d")
    for kind, (lo, hi) in step.items():
        if hi <= lo:
            out[kind] = lo
            continue
        h = hashlib.sha256(f"{acc_id}:{today}:{kind}".encode()).hexdigest()
        out[kind] = lo + int(h[:8], 16) % (hi - lo + 1)
    return out


def history(acc_id):
    return [r for r in tglib.read_csv(tglib.WARMUP) if r.get("account") == acc_id]


def _since_midnight():
    m = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    return m.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def done_today(rows, kind):
    """Сколько удачных действий этого вида уже сделано сегодня."""
    since = _since_midnight()
    return sum(1 for r in rows if r.get("action") == kind and r.get("note") == "ok"
               and r.get("at", "") >= since)


def tried_today(rows, kind):
    """
    Был ли сегодня ХОТЬ ОДИН заход этого вида, удачный или нет. Нужно для
    похода к боту: если он не ответил, а мы считаем только удачи, прогрев
    будет ломиться к нему снова и снова и не сделает больше ничего.
    """
    since = _since_midnight()
    return any(r.get("action") == kind and r.get("at", "") >= since for r in rows)


def note(acc_id, action, target, result):
    tglib.append_row(tglib.WARMUP,
                     [acc_id, action, tglib.cell(target), result, now_iso()],
                     tglib.WARMUP_HEAD)


# ------------------------------------------------------------------ действия

async def do_sub(client, acc, rows, data, kind="sub"):
    """Подписка на канал (или вступление в открытую группу — то же действие)."""
    from telethon.tl.functions.channels import JoinChannelRequest
    from telethon.errors import (ChannelsTooMuchError, FloodWaitError,
                                 UsernameNotOccupiedError, UsernameInvalidError,
                                 ChannelPrivateError, InviteRequestSentError)

    pool = data["channels" if kind == "sub" else "chats"]
    seen = {r["target"] for r in rows if r.get("action") == kind}
    left = [c for c in pool if c not in seen]
    if not left:
        say(f"в списке не осталось нового ({'каналов' if kind == 'sub' else 'чатов'}) — пропускаю")
        return False

    target = random.choice(left)
    try:
        ent = await client.get_entity(target)
        await client(JoinChannelRequest(ent))
    except (UsernameNotOccupiedError, UsernameInvalidError, ValueError):
        note(acc["id"], kind, target, "нет такого")
        say(f"@{target} — такого не нашлось, больше к нему не вернусь")
        return False
    except ChannelPrivateError:
        note(acc["id"], kind, target, "закрыт")
        say(f"@{target} — закрытый, пропускаю его насовсем")
        return False
    except InviteRequestSentError:
        note(acc["id"], kind, target, "заявка")
        say(f"@{target} — по заявке; заявку оставил, ждать не буду")
        return True
    except ChannelsTooMuchError:
        say("у аккаунта уже предел подписок в Telegram — подписки пока пропускаю")
        return False
    except FloodWaitError as e:
        note(acc["id"], kind, target, f"флуд {e.seconds}")
        say(f"Telegram просит подождать {e.seconds} с — на сегодня хватит")
        raise

    note(acc["id"], kind, target, "ok")
    say(f"подписался: @{target}")
    return True


async def do_react(client, acc, rows, data):
    """
    Почитать ленту и отреагировать. Именно в таком порядке: реакция сразу
    после входа в канал выглядит как робот, поэтому сначала «читаем».
    """
    from telethon.tl import functions, types
    from telethon.errors import FloodWaitError

    mine = [r["target"] for r in rows
            if r.get("action") in ("sub", "chat") and r.get("note") == "ok"]
    if not mine:
        say("пока не на что реагировать — сначала нужны подписки")
        return False

    target = random.choice(mine)
    try:
        ent = await client.get_entity(target)
        posts = await client.get_messages(ent, limit=HISTORY)
    except Exception as e:
        say(f"@{target}: {str(e).splitlines()[0][:80]}")
        return False

    posts = [m for m in posts if m and not m.action]
    if not posts:
        say(f"@{target}: свежих постов нет")
        return False

    # «читаем»: отмечаем прочитанным и держим паузу, как живой человек
    try:
        await client.send_read_acknowledge(ent)
    except Exception:
        pass
    dwell = random.uniform(READ_MIN, READ_MAX)
    say(f"читаю @{target} ({dwell:.0f} с)")
    await asyncio.sleep(dwell)

    # опрос попался — голосуем: это тоже обычное поведение читателя
    poll = next((m for m in posts if isinstance(m.media, types.MessageMediaPoll)
                 and not m.media.poll.closed and not m.media.poll.quiz), None)
    if poll and random.random() < 0.5:
        try:
            choice = random.choice(poll.media.poll.answers).option
            await client(functions.messages.SendVoteRequest(peer=ent, msg_id=poll.id,
                                                            options=[choice]))
            note(acc["id"], "react", f"{target}#{poll.id}", "ok")
            say(f"проголосовал в опросе @{target}")
            return True
        except FloodWaitError:
            raise
        except Exception:
            pass          # опрос не дался — просто поставим реакцию

    post = random.choice(posts)
    for emo in data["reactions"]:
        try:
            await client(functions.messages.SendReactionRequest(
                peer=ent, msg_id=post.id, reaction=[types.ReactionEmoji(emoticon=emo)]))
            note(acc["id"], "react", f"{target}#{post.id}", "ok")
            say(f"поставил {emo} посту в @{target}")
            return True
        except FloodWaitError:
            raise
        except Exception:
            continue      # канал не принимает такую реакцию — пробуем следующую
    say(f"@{target}: реакции тут не принимают")
    return False


FOCUS_DM = 8        # сколько переписки в сутки у аккаунта в фокусе
FOCUS_WEIGHT = 10   # и насколько чаще он выбирает переписку среди действий


def focus_ids(data):
    """
    Аккаунты, которые надо догреть перепиской побыстрее. Пока не вышел срок,
    остальные в первую очередь пишут и отвечают им, а сами они больше
    переписываются. Задаётся в warm-list.json:
        "dm_focus": {"accounts": ["a2"], "until": "2026-09-27T02:00:00Z"}
    """
    f = data.get("dm_focus") or {}
    if str(f.get("until", "")) <= now_iso():
        return set()
    return set(f.get("accounts") or [])


def dm_peers(acc):
    """Свои аккаунты, с которыми можно переписываться: найти их можно по id,
    @username или номеру — хоть по чему-то одному."""
    return [a for a in tglib.load_accounts()
            if a.get("id") != acc["id"] and (a.get("user_id") or a.get("username") or a.get("phone"))]


def talk_lines(data):
    """
    Фразы делятся на «начать разговор» и «ответить». Одна общая куча давала
    «ясно, буду иметь в виду» первым сообщением и по три раза подряд. Если в
    warm-list.json разделения ещё нет — делим старый список: вопросы и
    приветствия открывают разговор, остальное годится в ответ.
    """
    talk = [t for t in data.get("talk", []) if t.strip()]
    opens = data.get("talk_open") or [t for t in talk if "?" in t or t.lower().startswith("привет")]
    replies = data.get("talk_reply") or [t for t in talk if t not in opens]
    return opens or talk, replies or talk


def pick(lines, last):
    """Случайная фраза, но не та же, что ушла этому человеку в прошлый раз."""
    fresh = [t for t in lines if t != last]
    return random.choice(fresh or lines)


async def find_peer(client, peer, known):
    """
    Сущность своего аккаунта для первого сообщения. Диалог уже есть — берём
    из него; иначе @username; иначе номер: на минуту кладём в контакты, чтобы
    Telegram отдал человека, и после отправки убираем обратно (второй элемент
    ответа — кого удалить из книжки).
    """
    from telethon import functions
    from telethon.tl.types import InputPhoneContact

    uid = int(peer.get("user_id") or 0)
    if uid in known:
        return known[uid], None
    if peer.get("username"):
        try:
            return await client.get_entity(peer["username"]), None
        except Exception:
            pass
    phone = str(peer.get("phone") or "").lstrip("+")
    if not phone:
        return None, None
    res = await client(functions.contacts.ImportContactsRequest(
        [InputPhoneContact(client_id=random.randrange(-2**62, 2**62),
                           phone=phone, first_name=peer.get("name") or phone, last_name="")]))
    if not res.users:
        return None, None
    return res.users[0], res.users[0]


async def read_own(client, acc):
    """
    Прочитать, что написали свои аккаунты. Раньше аккаунт отмечал переписку
    прочитанной, только когда сам отвечал: написали двое, ответил одному —
    второй диалог висел непрочитанным днями, как у брошенного аккаунта.
    Живой человек, открыв Telegram, первым делом читает новые сообщения —
    так и делаем в начале каждого захода, с паузой на «прочитать».
    Возвращает, сколько диалогов прочитал.
    """
    own = {int(p["user_id"]) for p in dm_peers(acc) if p.get("user_id")}
    n = 0
    for d in await client.get_dialogs(limit=100):
        if d.is_user and d.entity.id in own and d.unread_count:
            await asyncio.sleep(random.uniform(2, 6))
            await client.send_read_acknowledge(d.entity)
            n += 1
    return n


async def do_dm(client, acc, rows, data):
    """
    Переписка со своими же аккаунтами. Живой аккаунт кому-то пишет и кому-то
    отвечает — с этого и начинается нормальная история переписки. Ссылок и
    ничего коммерческого тут быть не может: это разговор, а не рассылка.

    Своих узнаём по user_id, а не по @username: ника у половины аккаунтов нет,
    и раньше им никто не мог ответить — они только писали в пустоту.
    Порядок: сначала отвечаем тем, кто ждёт; первыми пишем только тем, кому
    мы не писали последними — второе сообщение подряд без ответа не шлём.
    """
    from telethon import functions
    from telethon.errors import FloodWaitError

    peers = dm_peers(acc)
    if not peers:
        say("писать некому: в панели нет других аккаунтов")
        return False
    by_id = {int(p["user_id"]): p for p in peers if p.get("user_id")}
    opens, replies = talk_lines(data)
    focus = focus_ids(data)

    known, last_out, waiting = {}, {}, []
    for d in await client.get_dialogs(limit=200):
        if not d.is_user or d.entity.id not in by_id or not d.message:
            continue
        known[d.entity.id] = d.entity
        if d.message.out:
            last_out[d.entity.id] = d.message.message or ""
        else:
            waiting.append(d)

    drop = None
    if waiting:
        # аккаунту в фокусе отвечаем первым, дальше — кто дольше всех ждёт
        d = min(waiting, key=lambda x: (by_id[x.entity.id]["id"] not in focus, x.message.date))
        ent, peer = d.entity, by_id[d.entity.id]
        async for m in client.iter_messages(ent, limit=10):
            if m.out:
                last_out[ent.id] = m.message or ""
                break
        text = pick(replies, last_out.get(ent.id))
        verb = "ответил"
    else:
        free = [p for p in peers if int(p.get("user_id") or 0) not in last_out]
        if not free:
            say("все свои молчат в ответ на наши сообщения — новых не шлём, ждём ответов")
            return False
        # аккаунт в фокусе — первым; потом те, с кем ещё ни разу не говорили
        hot = [p for p in free if p["id"] in focus]
        fresh = [p for p in free if int(p.get("user_id") or 0) not in known]
        peer = random.choice(hot or fresh or free)
        try:
            ent, drop = await find_peer(client, peer, known)
        except FloodWaitError:
            raise
        except Exception as e:
            ent = None
            say(f"{peer.get('title')}: {str(e).splitlines()[0][:80]}")
        if not ent:
            note(acc["id"], "dm", peer.get("title", ""), "ошибка")
            say(f"не нашёл {peer.get('title')} ни по нику, ни по номеру")
            return False
        text = pick(opens, None)
        verb = "написал"

    who = "@" + peer["username"] if peer.get("username") else (peer.get("title") or peer.get("id"))
    try:
        await asyncio.sleep(random.uniform(READ_MIN, READ_MAX))   # «печатает»
        await client.send_message(ent, text, link_preview=False)
        await client.send_read_acknowledge(ent)
    except FloodWaitError:
        raise
    except Exception as e:
        note(acc["id"], "dm", who, "ошибка")
        say(f"{who}: {str(e).splitlines()[0][:80]}")
        return False
    finally:
        # диалог остался — контакт больше не нужен, а книжка с чужими
        # номерами и есть та примета, по которой аккаунты ловят
        if drop:
            try:
                await client(functions.contacts.DeleteContactsRequest(id=[drop]))
            except Exception:
                pass

    note(acc["id"], "dm", who, "ok")
    say(f"{verb} {who}: «{text}»")
    return True


async def do_bot(client, acc, rows, data):
    """
    Запустить бота из списка.

    Смысл не в самом боте, а в том, что он потом пишет САМ: напоминалки,
    игровые события, ответы нейросети. Входящие сообщения аккаунт себе не
    нарисует, а для Telegram это как раз признак живого — с человеком
    разговаривают, а не только он.
    """
    from telethon.errors import FloodWaitError

    pool = data.get("bots") or []
    seen = {r["target"] for r in rows if r.get("action") == "bot"}
    left = [b for b in pool if b not in seen]
    if not left:
        say("все боты из списка уже запущены — пропускаю")
        return False

    target = random.choice(left)
    try:
        ent = await client.get_entity(target)
        await client.send_message(ent, "/start")
        await asyncio.sleep(random.uniform(READ_MIN, READ_MAX))   # ждём ответа, как человек
        await client.send_read_acknowledge(ent)
    except FloodWaitError:
        raise
    except Exception as e:
        note(acc["id"], "bot", target, "не вышло")
        say(f"@{target}: {str(e).splitlines()[0][:80]}")
        return False

    note(acc["id"], "bot", target, "ok")
    say(f"запустил бота @{target} — дальше он пишет сам")
    return True


async def ask_spam_bot(client, acc, data):
    """
    Спросить у @SpamBot, нет ли на аккаунте ограничений. Ответ кладём в реестр —
    панель покажет его в строке аккаунта, чтобы не гадать, живой он или уже
    придержан.
    """
    ok, said = await tglib.spam_check(client, acc)
    if ok is None:
        note(acc["id"], "spam", tglib.SPAM_BOT, "ошибка")
        say(f"@{tglib.SPAM_BOT}: {said}")
        return False
    note(acc["id"], "spam", tglib.SPAM_BOT, "ok")
    say(f"@{tglib.SPAM_BOT}: {said[:120]}")
    return True


# ------------------------------------------------------------------- выбор

async def main():
    acc = tglib.resolve(tglib.arg("account", ""))
    want = tglib.arg("what", "")
    data = load_list()
    day = age_days(acc)

    done = day >= warm_days()
    say(f"аккаунт: {acc['title']}  |  "
        f"{'догрев (прогрев пройден)' if done else f'прогрев, день {day} из {warm_days()}'}  |  "
        f"{tglib.proxy_label(acc.get('proxy'))}")

    if day < 1:
        say("первые сутки аккаунт не трогаем вовсе — это отлёжка")
        tglib.state(done=0, left=0, note="отлёжка")
        return

    rows = history(acc["id"])
    cap = caps(acc["id"], day)
    focused = acc["id"] in focus_ids(data)
    if focused:
        cap["dm"] = max(cap.get("dm", 0), FOCUS_DM)
        say(f"в фокусе переписки: до {FOCUS_DM} сообщений своим сегодня")
    left = {k: cap.get(k, 0) - done_today(rows, k) for k in KINDS}
    say("на сегодня осталось: " + ", ".join(
        f"{k} {max(0, v)}/{cap.get(k, 0)}" for k, v in left.items()))

    # раз в сутки спрашиваем у SpamBot, всё ли в порядке
    if want in ("", "spam") and not tried_today(rows, "spam"):
        tglib.state(act=DOING["spam"], phase="doing")
        client = await tglib.connect(acc)
        try:
            await ask_spam_bot(client, acc, data)
        finally:
            await tglib.aclose(client)
        tglib.state(done=1, left=sum(max(0, v) for v in left.values()),
                    act=DONE["spam"], phase="done")
        return

    kinds = [k for k, v in left.items() if v > 0] if not want else [want]
    if want == "":
        if not data.get("chats"):
            kinds = [k for k in kinds if k != "chat"]     # вступать некуда
        if not data.get("bots"):
            kinds = [k for k in kinds if k != "bot"]      # и запускать некого
        # переписываться аккаунт может только со своими. Один аккаунт в
        # панели — писать некому, и выбирать это действие значит впустую
        # сжечь заход
        if not dm_peers(acc):
            kinds = [k for k in kinds if k != "dm"]
    if not kinds:
        say("на сегодня всё — аккаунт своё отработал")
        tglib.state(done=0, left=0, note="дневной предел прогрева")
        return

    weight = dict(WEIGHT, dm=FOCUS_WEIGHT) if focused else WEIGHT
    kind = random.choices(kinds, weights=[weight[k] for k in kinds])[0]
    # реагировать пока не на что: аккаунт ещё ни на что не подписан. Менять
    # действие на подписку, а не тратить впустую целый заход — между заходами
    # у аккаунта минуты, и разбрасываться ими незачем
    subbed = any(r.get("action") in ("sub", "chat") and r.get("note") == "ok" for r in rows)
    if kind == "react" and not subbed:
        kind = "sub" if left.get("sub", 0) > 0 else ("dm" if left.get("dm", 0) > 0 else kind)
    # сообщаем панели, что аккаунт делает прямо сейчас — до долгой части
    tglib.state(act=DOING.get(kind, "работает"), phase="doing")
    client = await tglib.connect(acc)
    try:
        try:
            got = await read_own(client, acc)
            if got:
                say(f"прочитал сообщения от своих: {got}")
        except Exception:
            pass    # не прочитали — не беда, основное действие важнее
        if kind == "react":
            ok = await do_react(client, acc, rows, data)
        elif kind == "dm":
            ok = await do_dm(client, acc, rows, data)
        elif kind == "bot":
            ok = await do_bot(client, acc, rows, data)
        else:
            ok = await do_sub(client, acc, rows, data, kind)
    except Exception as e:
        from telethon.errors import FloodWaitError
        if isinstance(e, FloodWaitError):
            say(f"\nстоп: Telegram просит паузу {e.seconds} с")
            tglib.state(done=0, left=0, stop="flood", cooldown=e.seconds)
            return
        raise
    finally:
        await tglib.aclose(client)

    rows = history(acc["id"])
    still = sum(max(0, cap.get(k, 0) - done_today(rows, k)) for k in left)
    tglib.state(done=1 if ok else 0, left=still,
                act=DONE.get(kind, "") if ok else "", phase="done")


asyncio.run(main())
