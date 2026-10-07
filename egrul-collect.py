#!/usr/bin/env python3
"""
Сбор сведений об организациях через @egrul_bot.

Берёт ИНН из egrul.csv, по одному спрашивает у бота и складывает обратно в тот
же файл: кто руководитель, что за компания, жива ли она. Телефонов в ЕГРЮЛ нет
— если номер всё-таки попадётся в ответе, он тоже сохранится и уедет в базу
номеров, к обычной проверке и рассылке.

Работает ОДИН назначенный аккаунт-сборщик, строго по одному запросу за раз.
За заход — пачка (по умолчанию 20 ИНН), потом панель укладывает аккаунт спать
на полчаса: ровный поток запросов к боту Telegram замечает быстрее всего.

    python egrul-collect.py --account a19
    python egrul-collect.py --account a19 --limit 5 --daily 110

Можно увести сборщик в свой канал, не трогая прокси аккаунта в реестре:

    python egrul-collect.py --account a19 --proxy socks5://127.0.0.1:10808
    python egrul-collect.py --account a19 --nochain --pause 10

--nochain — не спрашивать отдельно про директора (один запрос на строку).
"""
import asyncio
import random
import sys
import time
from datetime import datetime, timedelta, timezone

import tglib
from tglib import say
import egrul

BOT = "@egrul_bot"
HEAD = ["inn", "status", "company", "lpr", "lpr_role", "lpr_inn",
        "phone", "address", "activity", "note", "at", "by"]

PAUSE_MIN, PAUSE_MAX = 15, 25      # сон между запросами, секунды
BATCH = 20                          # ИНН за один заход
REST_MIN, REST_MAX = 1800, 2400     # сон после пачки, секунды (30–40 минут)
DAILY = 110                         # запросов к боту на аккаунт в сутки
ANSWER_WAIT = 70                    # сколько ждём ответ, прежде чем идти дальше
FINAL_WAIT = 120                    # сколько ждём опоздавшие ответы в конце захода

# Отчёты, пришедшие позже, чем мы их ждали. Бот отвечает не мгновенно, и
# ответ по прошлому ИНН может догнать нас уже на следующем — выбрасывать
# его глупо, это оплаченный запрос.
LATE = {}

FILE = tglib.DIR / "egrul.csv"
NUMBERS = tglib.NUMBERS


def rows():
    return tglib.read_csv(FILE)


def done_today(account):
    """
    Сколько запросов к боту этот аккаунт уже сделал за последние сутки.
    Считаем скользящие 24 часа, а не «с полуночи»: для Telegram 60 запросов
    вечером и 60 утром — это 120 подряд, а не два разных дня.

    Запросов на строку бывает два: сперва про компанию, потом про её
    директора — поэтому в счёт идут они, а не разобранные строки.
    """
    since = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    n = 0
    for r in rows():
        if r.get("by") != account or r.get("at", "") < since:
            continue
        if r.get("status") in ("готово", "пусто"):
            n += 2 if r.get("lpr_inn") else 1
    return n


def queue():
    """Что ещё не спрашивали. Сбои уходят в конец — вдруг это была сеть."""
    fresh, failed = [], []
    for r in rows():
        st = (r.get("status") or "").strip()
        if not st:
            fresh.append(r)
        elif st == "сбой":
            failed.append(r)
    return fresh + failed


def save(inn, **kw):
    """
    Строку по ИНН переписываем целиком: файл маленький (сотни строк), а
    дописывать в конец нельзя — иначе при повторе появится второй такой же ИНН.
    """
    all_rows = rows()
    for r in all_rows:
        if r.get("inn") == inn:
            r.update(kw)
            break
    else:
        all_rows.append({"inn": inn, **kw})
    tglib.ensure_head(FILE, HEAD)
    with open(FILE, "w", encoding="utf-8", newline="") as f:
        f.write(",".join(HEAD) + "\n")
        for r in all_rows:
            f.write(",".join(tglib.cell(r.get(k, "")) for k in HEAD) + "\n")


def to_base(phone, who):
    """
    Найденный номер — в ту же базу, по которой работают проверка и рассылка.
    Дубли не плодим: номер мог прийти и из таблицы, и из другого ИНН.
    """
    if not phone:
        return False
    have = {r.get("phone") for r in tglib.read_csv(NUMBERS)}
    if phone in have:
        return False
    tglib.ensure_head(NUMBERS, ["phone", "calls", "last_call", "total_sec"])
    tglib.append_row(NUMBERS, [phone, "", "", ""], ["phone", "calls", "last_call", "total_sec"])
    say(f"    + {phone} в базу номеров ({who})")
    return True


POLL = 3                            # как часто заглядывать в диалог, секунды


async def drain(client, bot, seen):
    """
    Забрать из диалога всё новое и разложить отчёты по ИНН, который в них
    указан: бот отвечает не мгновенно и не по порядку, ответ по прошлой
    компании запросто приходит после следующей. Запрос уже потрачен — терять
    такой отчёт нельзя.

    Заглядываем раз в несколько секунд, а не каждую: за частое чтение истории
    Telegram придерживает запросы, и ответы начинают доходить с опозданием.
    """
    note = ""
    for m in reversed(await client.get_messages(bot, limit=15)):
        if m.id in seen or m.out or not m.message:
            continue
        seen.add(m.id)
        if egrul.is_waiting(m.message):
            continue
        if egrul.is_report(m.message):
            got = egrul.field(m.message, "ИНН")
            if got:
                LATE[got] = m.message
            continue
        if egrul.needs_channel(m.message):
            note = "подписка:" + egrul.needs_channel(m.message)
            continue
        if egrul.not_found(m.message):
            note = note or "не найден"
            continue
        note = note or ("бот ответил: " + " ".join(m.message.split())[:70])
    return note


async def join(client, channel):
    """
    Подписаться на канал бота: после нескольких бесплатных запросов он просит
    подписку, и без неё вместо отчёта приходит напоминание. Делаем это один
    раз за заход и продолжаем с того же ИНН.
    """
    from telethon.tl.functions.channels import JoinChannelRequest
    await client(JoinChannelRequest(channel))
    say(f"  подписался на @{channel} — бот этого требует для продолжения")


async def ask(client, bot, inn, seen, wait=ANSWER_WAIT):
    """
    Спросить про ИНН и дождаться ответа именно по нему. Не дождались — ответ
    подберёт хвост захода, строка заполнится позже.
    """
    note = await drain(client, bot, seen)
    if inn in LATE:
        return LATE.pop(inn), ""
    await client.send_message(bot, inn)
    for _ in range(max(1, wait // POLL)):
        await asyncio.sleep(POLL)
        note = await drain(client, bot, seen) or note
        if inn in LATE:
            return LATE.pop(inn), ""
        if note.startswith("подписка:"):
            return None, note
    return None, note or "ответ ещё не пришёл"


async def main():
    acc = tglib.resolve(tglib.arg("account", ""))
    limit = int(tglib.arg("limit", BATCH))
    daily = int(tglib.arg("daily", DAILY))
    nochain = tglib.flag("nochain")
    pause_min = float(tglib.arg("pause", PAUSE_MIN))
    pause_max = max(pause_min, float(tglib.arg("pause-max", PAUSE_MAX if pause_min == PAUSE_MIN else pause_min + 5)))
    # свой канал для сборщика: реестр аккаунтов не трогаем, прокси живёт
    # только в этом запуске
    own = tglib.arg("proxy", "")
    if own:
        acc = dict(acc, proxy=own)

    tglib.ensure_head(FILE, HEAD)
    left_all = queue()
    if not left_all:
        say("в таблице не осталось строк без ответа")
        tglib.state(done=0, left=0, note="таблица разобрана")
        return

    today = done_today(acc["id"])
    if today >= daily:
        say(f"на сегодня хватит: {today} из {daily} за сутки")
        tglib.state(done=0, left=len(left_all), stop="quota",
                    cooldown=tglib.until_tomorrow(), note="суточный предел")
        return

    say(f"аккаунт: {acc['title']}  |  ЕГРЮЛ  |  {tglib.proxy_label(acc.get('proxy'))}")
    say(f"в очереди {len(left_all)}, сегодня уже {today} из {daily}")
    tglib.state(done=0, left=len(left_all))

    client = await tglib.connect(acc)
    done = 0
    subscribed = False
    stop = cooldown = note = ""
    try:
        bot = await client.get_entity(BOT)
        seen = {m.id for m in await client.get_messages(bot, limit=15)}
        for r in left_all[:limit]:
            if today + done >= daily:
                stop, cooldown, note = "quota", tglib.until_tomorrow(), "суточный предел"
                break
            inn = (r.get("inn") or "").strip()
            if not inn.isdigit() or len(inn) not in (10, 12):
                save(inn, status="пусто", note="это не ИНН", at=tglib.now_iso(), by=acc["id"])
                continue

            say(f"\n{inn} — спрашиваю")
            tglib.state(done=done, left=len(left_all) - done, act=f"спрашиваю про {inn}", phase="doing")
            try:
                text, why = await ask(client, bot, inn, seen)
                # попросил подписку — подписываемся и спрашиваем этот же ИНН снова
                if why.startswith("подписка:") and not subscribed:
                    await join(client, why.split(":", 1)[1])
                    subscribed = True
                    await asyncio.sleep(random.uniform(5, 9))
                    text, why = await ask(client, bot, inn, seen)
            except Exception as e:
                msg = str(e)
                wait = getattr(e, "seconds", 0)
                if wait:
                    say(f"  Telegram просит подождать {wait} с")
                    stop, cooldown, note = "flood", wait + 30, "Telegram придержал"
                    break
                say(f"  сбой: {msg.splitlines()[0][:90]}")
                save(inn, status="сбой", note=msg.splitlines()[0][:80],
                     at=tglib.now_iso(), by=acc["id"])
                continue

            if not text:
                say(f"  {why}")
                # «ответ ещё не пришёл» — это не сбой: строка остаётся в
                # очереди, а ответ подберём в конце захода или в следующий раз
                save(inn, status="" if why.startswith("ответ ещё") else
                     ("пусто" if why == "не найден" else "сбой"),
                     note=why, at=tglib.now_iso(), by=acc["id"])
            else:
                d = egrul.parse(text)
                boss = d["boss"] or (d["founders"][0] if d["founders"] else {})
                # у ИП отчёт и есть отчёт по человеку: он сам себе ЛПР,
                # отдельной строки с должностью бот не присылает
                if not boss.get("name") and len(inn) == 12 and d["company"]:
                    boss = {"name": d["company"].title(), "role": "ИП", "inn": inn}
                phone = d["phones"][0] if d["phones"] else ""
                say(f"  {d['company'][:60]}")
                say(f"  ЛПР: {boss.get('role','')} {boss.get('name','') or '—'}")
                done += 1

                # Второй шаг: в отчёте по юрлицу контактов нет, а в отчёте по
                # человеку есть. Поэтому спрашиваем бота ещё раз — уже про
                # личный ИНН директора.
                if boss.get("inn") and not phone and not nochain and today + done < daily:
                    await asyncio.sleep(random.uniform(pause_min, pause_max))
                    say(f"  спрашиваю про человека: {boss['inn']}")
                    try:
                        text2, _ = await ask(client, bot, boss["inn"], seen)
                    except Exception as e:
                        text2 = ""
                        say(f"    не вышло: {str(e).splitlines()[0][:70]}")
                    if text2:
                        d2 = egrul.parse(text2)
                        phone = d2["contacts"]["phone"] or (d2["phones"][0] if d2["phones"] else "")
                        say(f"    телефон: {phone or '—'}")
                    done += 1

                save(inn, status="готово", company=d["company"],
                     lpr=boss.get("name", ""), lpr_role=boss.get("role", ""),
                     lpr_inn=boss.get("inn", ""), phone=phone,
                     address=d["address"], activity=d["activity"],
                     note="" if d["working"] is not False else "не действует",
                     at=tglib.now_iso(), by=acc["id"])
                if phone:
                    to_base(phone, d["company"][:40])
                else:
                    say("  телефона нет ни у компании, ни у человека")

            if done < limit * 2 and done + today < daily:
                pause = random.uniform(pause_min, pause_max)
                say(f"  пауза {pause:.0f} с")
                await asyncio.sleep(pause)
        # Хвост: бот ещё думает над последними запросами. Подождём их тут —
        # иначе строка останется пустой, а запрос всё равно потрачен.
        if True:
            say("\nжду опоздавшие ответы…")
            for _ in range(FINAL_WAIT // POLL):
                await asyncio.sleep(POLL)
                await drain(client, bot, seen)
                for got, text in list(LATE.items()):
                    row = next((r for r in rows() if r.get("inn") == got), None)
                    if not row or row.get("status") == "готово":
                        LATE.pop(got, None)
                        continue
                    d = egrul.parse(text)
                    boss = d["boss"] or (d["founders"][0] if d["founders"] else {})
                    if not boss.get("name") and len(got) == 12 and d["company"]:
                        boss = {"name": d["company"].title(), "role": "ИП", "inn": got}
                    phone = d["phones"][0] if d["phones"] else ""
                    save(got, status="готово", company=d["company"],
                         lpr=boss.get("name", ""), lpr_role=boss.get("role", ""),
                         lpr_inn=boss.get("inn", ""), phone=phone,
                         address=d["address"], activity=d["activity"],
                         note="" if d["working"] is not False else "не действует",
                         at=tglib.now_iso(), by=acc["id"])
                    say(f"  догнал ответ по {got}: {d['company'][:44]}"
                        + (f"  тел: {phone}" if phone else ""))
                    if phone:
                        to_base(phone, d["company"][:40])
                    LATE.pop(got, None)
    finally:
        await tglib.aclose(client)

    left = len(queue())
    if not stop and left:
        # пачка кончилась — аккаунт уходит спать, чтобы запросы не шли ровным
        # потоком: такой поток Telegram замечает раньше, чем объём
        cooldown = random.randint(REST_MIN, REST_MAX)
        note = f"пачка из {done} — отдых {cooldown // 60} мин"
    say(f"\nготово: разобрано {done}, осталось {left}")
    tglib.state(done=done, left=left, stop=stop, cooldown=cooldown, note=note, phase="done")


asyncio.run(main())
