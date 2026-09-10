#!/usr/bin/env python3
"""
Сводка по аккаунту: кто из базы ответил и какие черновики ждут отправки.
Только чтение — ничего не добавляет, не пишет и не отправляет.
Замена stats.mjs.

    python stats.py --account a1
"""
import asyncio
import json
from datetime import datetime, timezone

import tglib
from tglib import say

LIMIT = 200          # сколько последних диалогов смотрим
REPLIES = tglib.DIR / "replies.json"   # сводка для панели: её читает шаг «Результат»


def save(work, drafts, account):
    """
    Кладёт ответы в replies.json, чтобы панель показывала их числом, а не
    просила читать журнал. Файл общий на все аккаунты: у каждого свои чаты,
    поэтому складываем по аккаунтам и суммируем при показе.
    """
    try:
        data = json.loads(REPLIES.read_text("utf-8"))
        if not isinstance(data, dict):
            data = {}
    except Exception:
        data = {}
    data[account] = {
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "replies": [{"who": t, "text": prev, "n": n} for t, prev, n in work],
        "drafts": len(drafts),
    }
    REPLIES.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", "utf-8")


async def main():
    acc = tglib.resolve(tglib.arg("account", ""))
    say(f"аккаунт: {acc['title']}  |  {tglib.proxy_label(acc.get('proxy'))}  |  Telethon")

    # имена и номера людей из базы — по ним отделяем рабочие чаты от личных
    known_names, known_phones = set(), set()
    for r in tglib.read_csv(tglib.RESULTS):
        if r.get("tg") == "true":
            if r.get("name"):
                known_names.add(r["name"].strip().lower())
            known_phones.add(r["phone"].lstrip("+"))

    client = await tglib.connect(acc)
    try:
        dialogs = await client.get_dialogs(limit=LIMIT)
        work, other, drafts = [], [], []
        for d in dialogs:
            title = (d.name or "").strip()
            ours = title.lower() in known_names or \
                (getattr(d.entity, "phone", None) or "").lstrip("+") in known_phones
            text = ""
            if d.draft and (d.draft.text or "").strip():
                text = d.draft.text.strip().replace("\n", " ")[:80]
                drafts.append((title, text))
            if d.unread_count:
                last = (d.message.message if d.message and d.message.message else "")
                item = (title, last.replace("\n", " ")[:80], d.unread_count)
                (work if ours else other).append(item)

        save(work, drafts, acc["id"])
        say(f"\nвсего чатов:        {len(dialogs)}")
        say(f"черновиков готово:  {len(drafts)}")
        say(f"ответов по базе:    {len(work)}")

        if work:
            say("\n— ОТВЕТИЛИ ЛЮДИ ИЗ БАЗЫ —")
            for t, prev, n in sorted(work, key=lambda x: -x[2]):
                say(f"  [{n}] {t}: {prev}")
        else:
            say("\nответов от людей из базы пока нет")

        if drafts:
            say("\n— ЧЕРНОВИКИ ЖДУТ ОТПРАВКИ —")
            for t, prev in drafts:
                say(f"  {t}: {prev}")

        if other:
            msgs = sum(n for *_, n in other)
            say(f"\nпрочие личные чаты: {len(other)} непрочитанных "
                f"({msgs} сообщений) — не по базе")
    finally:
        await tglib.aclose(client)


asyncio.run(main())
