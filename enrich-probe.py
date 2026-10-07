#!/usr/bin/env python3
"""
Тест-коллектор портретов (read-only, без ИИ, без рассылки).

Для выборки участников чата собирает «досье» так же, как референс LeadAI:
  • bio из профиля (GetFullUser.about)
  • личный канал профиля (personal_channel_id): описание + последние 10 постов
  • сайт из bio/канала: открывает и вытаскивает текст главной

Ничего не пишет людям и никого не трогает — только читает. Троттлинг между
профилями, чтобы не ловить флуд. Идёт через прокси аккаунта (tglib.make_client).

    python enrich-probe.py --account a6 --chat it_ipoteka_chat --limit 15
"""
import asyncio
import json
import random
import re
import urllib.request

import tglib
from tglib import say

from telethon.tl.functions.users import GetFullUserRequest
from telethon.tl.functions.channels import GetFullChannelRequest

PAUSE = (2.5, 4.5)          # пауза между профилями — бережём аккаунт
SITE_CAP = 1500            # сколько символов текста сайта оставляем


def find_url(*texts):
    for t in texts:
        if not t:
            continue
        m = re.search(r"https?://[^\s)>\"]+", t)
        if m and "t.me" not in m.group(0):
            return m.group(0)
    return ""


def fetch_site(url):
    """Текст главной страницы сайта — как «прокликал сайт» у референса (пока только главная)."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        html = urllib.request.urlopen(req, timeout=15).read().decode("utf-8", "ignore")
        html = re.sub(r"(?is)<(script|style|noscript).*?</\1>", " ", html)
        text = re.sub(r"(?s)<[^>]+>", " ", html)
        text = re.sub(r"\s+", " ", text).strip()
        return text[:SITE_CAP]
    except Exception as e:
        return f"(не открылся: {str(e).splitlines()[0][:50]})"


async def portrait(client, u):
    """Собрать досье по одному человеку. Только чтение."""
    name = " ".join(x for x in [getattr(u, "first_name", ""), getattr(u, "last_name", "")] if x)
    d = {"user_id": u.id, "username": getattr(u, "username", "") or "",
         "name": name, "bio": "", "channel_about": "", "channel_posts": [],
         "site_url": "", "site_text": ""}
    try:
        full = await client(GetFullUserRequest(u))
        uf = full.full_user
        d["bio"] = uf.about or ""
        pch = getattr(uf, "personal_channel_id", None)
        if pch:
            ch = next((c for c in full.chats if c.id == pch), None)
            if ch is None:
                try:
                    ch = await client.get_entity(pch)
                except Exception:
                    ch = None
            if ch is not None:
                try:
                    cf = await client(GetFullChannelRequest(ch))
                    d["channel_about"] = cf.full_chat.about or ""
                except Exception:
                    pass
                try:
                    async for m in client.iter_messages(ch, limit=10):
                        if getattr(m, "message", None):
                            d["channel_posts"].append(m.message.strip()[:200])
                except Exception:
                    pass
    except Exception as e:
        d["bio"] = f"(профиль не прочитан: {str(e).splitlines()[0][:50]})"

    url = find_url(d["bio"], d["channel_about"], " ".join(d["channel_posts"]))
    if url:
        d["site_url"] = url
        d["site_text"] = fetch_site(url)
    return d


async def main():
    acc = tglib.resolve(tglib.arg("account", ""))
    chat = str(tglib.arg("chat", "") or "").strip()
    limit = int(tglib.arg("limit", 15) or 15)
    if not chat:
        raise SystemExit("нужен --chat")

    say(f"аккаунт: {acc['title']}  |  {tglib.proxy_label(acc.get('proxy'))}")
    client = await tglib.connect(acc)
    try:
        entity = await client.get_entity(chat)
        say(f"чат: {getattr(entity, 'title', chat)}")

        users = []
        try:
            async for u in client.iter_participants(entity, limit=max(limit * 3, 40)):
                if getattr(u, "bot", False) or getattr(u, "deleted", False):
                    continue
                if not getattr(u, "first_name", None):
                    continue
                users.append(u)
                if len(users) >= limit:
                    break
        except Exception as e:
            say(f"список участников закрыт ({str(e).splitlines()[0][:50]}) — беру авторов сообщений")
            seen = set()
            async for m in client.iter_messages(entity, limit=400):
                s = getattr(m, "sender", None)
                if s and not getattr(s, "bot", False) and getattr(s, "first_name", None) and s.id not in seen:
                    seen.add(s.id)
                    users.append(s)
                    if len(users) >= limit:
                        break

        say(f"беру {len(users)} человек, собираю портреты…\n")
        out = []
        for i, u in enumerate(users, 1):
            d = await portrait(client, u)
            out.append(d)
            uname = ("@" + d["username"]) if d["username"] else f"id:{d['user_id']}"
            say(f"[{i}/{len(users)}] {d['name']} ({uname})")
            say(f"    bio: {d['bio'][:160] or '—'}")
            if d["channel_about"]:
                say(f"    канал: {d['channel_about'][:160]}")
            if d["channel_posts"]:
                say(f"    постов собрано: {len(d['channel_posts'])} · «{d['channel_posts'][0][:120]}»")
            if d["site_url"]:
                say(f"    сайт {d['site_url']}: {d['site_text'][:160]}")
            say("")
            await asyncio.sleep(random.uniform(*PAUSE))

        path = tglib.DIR / "enrich-probe.json"
        path.write_text(json.dumps(out, ensure_ascii=False, indent=1), "utf-8")
        # сводка сигнала
        with_bio = sum(1 for d in out if d["bio"] and not d["bio"].startswith("("))
        with_ch = sum(1 for d in out if d["channel_about"] or d["channel_posts"])
        with_site = sum(1 for d in out if d["site_url"])
        say(f"ГОТОВО: {len(out)} портретов → {path.name}")
        say(f"есть bio: {with_bio} · есть канал: {with_ch} · есть сайт: {with_site}")
    finally:
        await tglib.aclose(client)


if __name__ == "__main__":
    asyncio.run(main())
