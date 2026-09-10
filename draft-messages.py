#!/usr/bin/env python3
"""
Раскладывает черновики (или отправляет сообщения) найденным в Telegram
номерам — родным каналом, без браузера. Замена draft-messages.mjs.

Для каждого номера: добавить контакт -> положить текст черновиком в чат ->
убедиться, что черновик на месте -> [--send: отправить] -> удалить контакт
из адресной книги. Чат с черновиком остаётся, отправляешь сам.

Без --send получателю не уходит ни сообщение, ни уведомление — это режим
по умолчанию, и он безопасный. С --send сообщение уходит, отозвать нельзя.

    python draft-messages.py --account a1 --limit 2
    python draft-messages.py --account a1 --limit 2 --send
"""
import asyncio
import atexit
import random
import signal
import sys
from datetime import datetime, timezone

import claims
import tglib
from tglib import say

FLOOD_MAX = 600
MAX_TRIES = 3                  # столько раз номер не дался — больше не берём
MAX_FAILS_IN_ROW = 3           # столько сбоев подряд — пачку пора прекращать
COOLDOWN_FLOOD = 12 * 3600     # после PEER_FLOOD на рассылке — отдых подольше
COOLDOWN_ERRORS = 15 * 60


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def compose(tpl, row):
    """Текст письма для конкретного человека: имя и дата его звонка."""
    first = (row.get("name") or "").split(" ")[0].strip()
    name = f", {first}" if first else ""
    date = ".".join(reversed((row.get("last_call") or "")[:10].split("-")))
    return tpl.replace("{name}", name).replace("{date}", date)


async def saved_draft(client, user):
    """Текст черновика, который сейчас лежит в чате с этим человеком."""
    from telethon import functions
    from telethon.tl.types import UpdateDraftMessage, DraftMessage
    res = await client(functions.messages.GetAllDraftsRequest())
    for upd in getattr(res, "updates", []):
        if not isinstance(upd, UpdateDraftMessage):
            continue
        peer_id = getattr(upd.peer, "user_id", None)
        if peer_id == user.id and isinstance(upd.draft, DraftMessage):
            return upd.draft.message or ""
    return ""


async def main():
    acc = tglib.resolve(tglib.arg("account", ""))
    limit = int(tglib.arg("limit", 2))
    delay = float(tglib.arg("delay", 5))
    send = tglib.flag("send")
    voice = tglib.flag("voice")

    from telethon import functions
    from telethon.tl.types import InputPhoneContact, DocumentAttributeAudio
    from telethon.errors import FloodWaitError, PeerFloodError

    # голосовое нельзя положить черновиком — оно уходит сразу, поэтому это
    # всегда режим отправки, и файл должен уже лежать (кладёт панель)
    if voice and not tglib.VOICE.exists():
        say("нет голосового файла — загрузи его в панели (шаг 4)")
        raise SystemExit(1)
    voice_dur = tglib.voice_duration() if voice else 0

    mode = "ГОЛОСОВОЕ" if voice else "РЕЖИМ ОТПРАВКИ" if send else "только черновики"
    say(f"аккаунт: {acc['title']}  |  {mode}"
        f"  |  {tglib.proxy_label(acc.get('proxy'))}  |  Telethon")

    moved = tglib.migrate_drafts_log()
    if moved:
        say(f"лог черновиков переведён на новый формат ({moved} строк)")

    # одному человеку пишем один раз — с любого из аккаунтов. Неудачные попытки
    # (ok=false) не считаются: до них дело не дошло, номер вернётся в очередь.
    # Голосовое учитываем тоже: уже написанному или озвученному повторно не шлём.
    log = tglib.read_csv(tglib.DRAFTS)
    already = {r["phone"] for r in log
               if r.get("ok") == "true" or r.get("sent") == "true"}
    # номер, который не вышло обработать MAX_TRIES раз, откладываем: иначе
    # автопрогон брал бы его снова и снова и стоял бы на месте
    tries = tglib.tries_by_phone(log, already)
    queue = [r for r in tglib.read_csv(tglib.RESULTS)
             if r.get("tg") == "true" and r["phone"] not in already
             and tries.get(r["phone"], 0) < MAX_TRIES]
    mine = set(claims.take(acc["id"], "draft", [r["phone"] for r in queue], limit))
    todo = [r for r in queue if r["phone"] in mine]

    atexit.register(lambda: claims.release_all(acc["id"], "draft"))
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: sys.exit(1))

    tglib.ensure_head(tglib.DRAFTS, tglib.DRAFTS_HEAD)
    say(f"черновиков к раскладке: {len(todo)}")
    if not todo:
        tglib.state(done=0, left=len(queue))
        return
    tpl = tglib.MESSAGE.read_text("utf-8").strip()

    client = await tglib.connect(acc)
    say(f"сессия активна: {tglib.who(acc)}")

    ok_n = sent_n = 0
    fails_row = 0            # сбои подряд: дальше давить бессмысленно
    quota_miss = 0           # подряд не прошедшие контакты — признак кончившейся квоты
    stop, cooldown = "", 0   # чем кончилась пачка — это читает автопрогон
    try:
        for i, row in enumerate(todo):
            phone, label = row["phone"], row["phone"][-10:]
            text = compose(tpl, row)
            good, sent_flag = False, ""
            try:
                res = await client(functions.contacts.ImportContactsRequest(
                    [InputPhoneContact(client_id=random.randrange(-2**62, 2**62),
                                       phone=phone, first_name=label, last_name="")]))
                if not res.users:
                    # Этот номер УЖЕ отмечен «есть в Telegram» на проверке, значит
                    # пустой ответ — не «его нет», а кончившаяся квота на контакты.
                    # Записать его как неудачу нельзя: три такие попытки выкинули бы
                    # живого человека из базы навсегда. Оставляем номер в очереди.
                    quota_miss += 1
                    say(f"[{i + 1}/{len(todo)}] {phone} — контакт не прошёл "
                        f"(похоже, кончилась квота); номер остаётся в очереди")
                    if quota_miss >= 2:
                        say("\nстоп: квота на контакты кончилась — продолжим завтра")
                        stop, cooldown = "quota", tglib.until_tomorrow()
                        break
                    continue          # без записи в drafts.csv: попытка не считается
                quota_miss = 0
                user = res.users[0]

                if voice:
                    # голосовая заметка — «кружок» с микрофоном, а не файл-аудио:
                    # это даёт voice=True в атрибутах; длительность берём из панели,
                    # иначе полоска показала бы 0:00
                    await client.send_file(
                        user, str(tglib.VOICE), voice_note=True,
                        attributes=[DocumentAttributeAudio(duration=voice_dur, voice=True)])
                    good, sent_flag = True, "true"
                    ok_n, sent_n = ok_n + 1, sent_n + 1
                    say(f"[{i + 1}/{len(todo)}] {phone} — голосовое отправлено ({voice_dur}с)")
                else:
                    await client(functions.messages.SaveDraftRequest(peer=user, message=text))
                    back = await saved_draft(client, user)
                    good = bool(back) and back.split("\n")[0][:20] in text
                    say(f"[{i + 1}/{len(todo)}] {phone} — черновик "
                        f"{'на месте' if good else 'НЕ сохранился'}")
                    if good:
                        ok_n += 1

                    if good and send:
                        await client.send_message(user, text)
                        # отправленное письмо не должно остаться ещё и черновиком
                        await client(functions.messages.SaveDraftRequest(peer=user, message=""))
                        sent_flag, sent_n = "true", sent_n + 1
                        say(f"    отправлено: «{text.splitlines()[0][:40]}…»")

                # чат остаётся, из адресной книги контакт убираем
                await client(functions.contacts.DeleteContactsRequest(id=[user.id]))
                fails_row = 0
            except FloodWaitError as e:
                say(f"[{i + 1}/{len(todo)}] {phone} — флуд-пауза {e.seconds} с")
                if e.seconds > FLOOD_MAX:
                    say("стоп: Telegram просит слишком долгую паузу — на сегодня хватит")
                    stop, cooldown = "flood", e.seconds
                    break
                await asyncio.sleep(e.seconds)
                fails_row += 1
            except PeerFloodError:
                say("\nстоп: аккаунт ограничен Telegram за рассылку (PEER_FLOOD).")
                say("  Продолжать нельзя — дай ему отлежаться или работай другим аккаунтом.")
                stop, cooldown = "flood", COOLDOWN_FLOOD
                break
            except Exception as e:
                msg = str(e).splitlines()[0][:120] if str(e) else type(e).__name__
                say(f"[{i + 1}/{len(todo)}] {phone} — {msg}")
                fails_row += 1

            tglib.append_row(tglib.DRAFTS,
                             [phone, acc["id"], str(good).lower(), sent_flag, now_iso()],
                             tglib.DRAFTS_HEAD)
            # бронь держим до конца прогона (release_all в atexit): досрочное
            # снятие под параллельной рассылкой давало повтор одному человеку
            if fails_row >= MAX_FAILS_IN_ROW:
                say(f"\nстоп: {MAX_FAILS_IN_ROW} сбоя подряд — аккаунту нужна передышка")
                stop, cooldown = "errors", COOLDOWN_ERRORS
                break
            if i < len(todo) - 1:
                say(f"    пауза {delay:g} с")
                await asyncio.sleep(delay + random.uniform(0, delay * 0.5))
    finally:
        await tglib.aclose(client)

    if voice:
        say(f"\nготово: голосовых отправлено {sent_n} из {len(todo)}")
    else:
        say(f"\nготово: черновиков разложено {ok_n} из {len(todo)}")
        say(f"отправлено сообщений: {sent_n}" if send
            else "они лежат в чатах — ничего не отправлено")

    # кому ещё не написано — считаем по файлу заново: рядом могли отработать
    # другие аккаунты
    log2 = tglib.read_csv(tglib.DRAFTS)
    already2 = {r["phone"] for r in log2
                if r.get("ok") == "true" or r.get("sent") == "true"}
    tries2 = tglib.tries_by_phone(log2, already2)
    left = sum(1 for r in tglib.read_csv(tglib.RESULTS)
               if r.get("tg") == "true" and r["phone"] not in already2
               and tries2.get(r["phone"], 0) < MAX_TRIES)
    tglib.state(done=ok_n, left=left, stop=stop, cooldown=cooldown)


asyncio.run(main())
