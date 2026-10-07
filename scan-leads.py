#!/usr/bin/env python3
"""
Поиск горячих лидов в сообщениях чатов.

Читает последние сообщения из подключённых чатов (тем же аккаунтом и прокси,
что и разбор), прогоняет каждое через leadscan (классификация + память +
генерация первого письма) и ведёт карточки в leads.json. Первое сообщение
пишется персонально: с отсылкой на чат, где человека нашли, и на его запрос.

Откуда брать чаты — как у разбора:
  --folder chats          все чаты из папки Telegram «chats» (основной режим);
  --chat <ссылка>         один чат;
  --list <файл>           список ссылок (по строке).

Сколько читать:
  --limit N               последних сообщений на чат (по умолчанию 300);
  --days N                только за последние N дней (по умолчанию 21).

Песок без Telegram:
  --sample messages.json  берёт сообщения из файла (список словарей с полями
                          chat,user_id,username,display_name,message_id,date,text,reply),
                          ничего не шлёт, только классифицирует и пишет карточки.

    python scan-leads.py --account a1 --folder chats
    python scan-leads.py --account a1 --chat https://t.me/ekb_nedvizhka --limit 500
    python scan-leads.py --sample sample.json           # прогон в песке
"""
import asyncio
import csv
import json
import random
import re
import urllib.request
from datetime import datetime, timedelta, timezone

import tglib
from tglib import say
import leadscan

LIMIT_DEFAULT = 300
DAYS_DEFAULT = 21
PAUSE_PER_CHAT = (2, 4)     # пауза между чатами, сек
WARM_SEND_MIN = 50          # для WARM письмо готовим только с этого скора


# ------------------------------------------------------------- чаты (как в разборе)

def chat_ref(raw):
    s = str(raw or "").strip()
    if not s:
        raise SystemExit("не указан чат")
    s = re.sub(r"^(https?://)?(www\.)?(t\.me|telegram\.me|telegram\.dog)/", "", s, flags=re.I)
    m = re.match(r"^(?:joinchat/|\+)(.+)$", s)
    if m:
        return None, m.group(1).strip("/")
    s = s.split("?")[0].strip("/")
    m = re.match(r"^c/(\d+)", s)
    if m:
        return int("-100" + m.group(1)), None
    if re.fullmatch(r"-?\d+", s):
        return int(s), None
    return s.lstrip("@"), None


async def resolve_chat(client, ref, invite, join):
    from telethon import functions
    from telethon.tl.types import ChatInviteAlready, ChatInvitePeek
    if invite:
        res = await client(functions.messages.CheckChatInviteRequest(invite))
        if isinstance(res, (ChatInviteAlready, ChatInvitePeek)):
            return res.chat
        if not join:
            raise SystemExit("приватное приглашение, а аккаунт не в чате — вступи или добавь --join")
        upd = await client(functions.messages.ImportChatInviteRequest(invite))
        return upd.chats[0]
    return await client.get_entity(ref)


async def folder_chats(client, name):
    from telethon import functions
    from telethon.tl.types import (DialogFilter, DialogFilterChatlist,
                                   InputPeerUser, InputPeerSelf)
    res = await client(functions.messages.GetDialogFiltersRequest())
    filters = getattr(res, "filters", res)
    want = str(name).strip().casefold()
    found, names = None, []
    for f in filters:
        if not isinstance(f, (DialogFilter, DialogFilterChatlist)):
            continue
        title = getattr(f.title, "text", f.title)
        names.append(str(title))
        if str(title).strip().casefold() == want:
            found = f
    if found is None:
        have = ", ".join(f"«{n}»" for n in names) if names else "ни одной"
        raise SystemExit(f"нет папки «{name}». Есть: {have}")
    peers, seen = [], set()
    for p in list(getattr(found, "pinned_peers", []) or []) + list(found.include_peers or []):
        if isinstance(p, (InputPeerUser, InputPeerSelf)):
            continue
        key = getattr(p, "channel_id", None) or getattr(p, "chat_id", None)
        if not key or key in seen:
            continue
        seen.add(key)
        peers.append(p)
    return peers


# --------------------------------------------------------------------- память

def load_leads():
    try:
        d = json.loads(tglib.LEADS.read_text("utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def save_leads(profiles):
    tglib.LEADS.write_text(json.dumps(profiles, ensure_ascii=False, indent=1), "utf-8")


LOG_HEAD = ["at", "chat", "user_id", "username", "category", "score", "reason", "quote"]


def log_message(chat, msg, cls):
    """Аудит: строка на каждое НЕ-холодное сообщение (hot/warm/skip-agent)."""
    if cls["category"] == "COLD":
        return
    tglib.append_row(tglib.LEADS_LOG, [
        tglib.now_iso(), tglib.cell(chat), str(msg.get("user_id") or ""),
        tglib.cell(msg.get("username") or ""), cls["category"], cls["score"],
        tglib.cell(cls["reason"]), tglib.cell(str(msg.get("text") or "")[:120]),
    ], LOG_HEAD)


def landing_url():
    base = tglib.current_link()
    if not base:
        return ""
    return base + ("&" if "?" in base else "?") + "src=lead"


SHEET_URL_FILE = tglib.DIR / "leads-sheet.txt"


def _sheet_url():
    """URL Google-таблицы (тот же, куда шлёт форма сайта). Нет файла — не пушим."""
    try:
        u = SHEET_URL_FILE.read_text("utf-8").strip()
        return u if u.startswith("http") else ""
    except Exception:
        return ""


def _lead_contact(p):
    if p.get("username"):
        return "@" + str(p["username"]).lstrip("@")
    return "id:" + str(p.get("user_id") or "")


def _lead_request(p):
    """Что человек ищет + его последняя цитата — чтобы риелтор сразу понял."""
    parts = []
    if p.get("what_looking_for"):
        parts.append(str(p["what_looking_for"]))
    ev = p.get("evidence") or []
    if ev:
        q = ev[-1].get("quote", "") if isinstance(ev[-1], dict) else str(ev[-1])
        if q:
            parts.append("«" + q[:200] + "»")
    return " — ".join(parts) or "запрос на покупку квартиры"


def push_hot_to_sheet(profiles):
    """Горячие лиды падают в ту же таблицу, куда ведёт форма сайта. Один лид —
    один раз (флаг pushed_to_sheet). URL берём из leads-sheet.txt; нет — молчим."""
    url = _sheet_url()
    if not url:
        return 0
    pushed = 0
    for p in profiles.values():
        if p.get("status") != "hot" or p.get("pushed_to_sheet"):
            continue
        chat = p.get("found_chat") or ""
        payload = {
            "type": "lead",
            "sid": "panel",
            "name": p.get("display_name") or _lead_contact(p),
            "contact": _lead_contact(p),
            "channel": "Telegram",
            "request": _lead_request(p),
            "ads": "нет",
            "src": "горячий лид из панели · чат: " + (chat or "—"),
            "rooms": p.get("rooms") or "",
            "budget": p.get("budget") or "",
            "page": chat,
            "date": datetime.now().strftime("%d.%m.%Y %H:%M"),
        }
        try:
            req = urllib.request.Request(
                url, data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"}, method="POST")
            urllib.request.urlopen(req, timeout=30).read()
            p["pushed_to_sheet"] = True
            pushed += 1
        except Exception as e:
            say(f"  не отправил в таблицу {_lead_contact(p)}: {str(e).splitlines()[0][:70]}")
    if pushed:
        say(f"в таблицу лидов (куда ведёт сайт) добавлено горячих: {pushed}")
    return pushed


def refresh_outreach(profiles):
    """Генерим/обновляем письмо для тех, кому пишем и кому ещё не написали."""
    link = landing_url()
    ready = 0
    for p in profiles.values():
        if p.get("message_sent"):
            continue
        st, sc = p.get("status"), int(p.get("score") or 0)
        want = st == "hot" or (st == "warm" and sc >= WARM_SEND_MIN)
        if want:
            p["outreach"] = leadscan.generate_outreach(p, link)
            ready += 1
        elif p.get("outreach") and not want:
            p["outreach"] = None
    return ready


# ------------------------------------------------------------------- сообщения

def msg_dict(chat_title, m, by):
    """Из объекта сообщения Telethon — плоский словарь для leadscan."""
    s = getattr(m, "sender", None)
    if s is None or getattr(s, "bot", False):
        return None
    # только люди: у канала/чата нет first_name
    if not hasattr(s, "first_name"):
        return None
    name = " ".join(x for x in [getattr(s, "first_name", ""), getattr(s, "last_name", "")] if x)
    reply = ""
    return {
        "chat": chat_title, "by": by,
        "user_id": getattr(m, "sender_id", None) or getattr(s, "id", None),
        "username": getattr(s, "username", "") or "",
        "display_name": name,
        "message_id": getattr(m, "id", None),
        "date": (m.date.isoformat() if getattr(m, "date", None) else tglib.now_iso()),
        "text": getattr(m, "message", "") or "",
        "reply": reply,
    }


def digest(profiles, added_ids):
    """Короткая сводка: сколько кого нашли за этот заход."""
    hot = sum(1 for p in profiles.values() if p.get("status") == "hot")
    warm = sum(1 for p in profiles.values() if p.get("status") == "warm")
    new_hot = sum(1 for u in added_ids if profiles.get(u, {}).get("status") == "hot")
    return hot, warm, new_hot


async def scan_chat(client, entity, by, limit, since, profiles, touched):
    title = tglib.cell(getattr(entity, "title", None) or getattr(entity, "id", "чат"))
    seen = 0
    async for m in client.iter_messages(entity, limit=limit):
        if getattr(m, "date", None) and since and m.date < since:
            break
        if not (getattr(m, "message", "") or "").strip():
            continue
        d = msg_dict(title, m, by)
        if not d:
            continue
        seen += 1
        cls = leadscan.classify(d["text"], d.get("reply"))
        log_message(title, d, cls)
        if cls["category"] in ("HOT", "WARM") or str(d["user_id"]) in profiles:
            leadscan.update_profile(profiles, d, cls)
            touched.add(str(d["user_id"]))
    say(f"  «{title}» — прочитал {seen} сообщений")
    return seen


# --------------------------------------------------------------------- офлайн

def run_sample(path):
    """Прогон в песке: сообщения из файла, без Telegram."""
    data = json.loads(open(path, encoding="utf-8").read())
    profiles = load_leads()
    touched = set()
    for d in data:
        d.setdefault("chat", "тест-чат")
        d.setdefault("by", "sample")
        cls = leadscan.classify(d.get("text", ""), d.get("reply"))
        log_message(d["chat"], d, cls)
        if cls["category"] in ("HOT", "WARM") or str(d.get("user_id")) in profiles:
            leadscan.update_profile(profiles, d, cls)
            touched.add(str(d.get("user_id")))
    ready = refresh_outreach(profiles)
    push_hot_to_sheet(profiles)
    save_leads(profiles)
    hot, warm, new_hot = digest(profiles, touched)
    say(f"песок: {len(data)} сообщений → лидов hot={hot} warm={warm}, писем готово {ready}")
    print(json.dumps({"hot": hot, "warm": warm, "ready": ready,
                      "profiles": len(profiles)}, ensure_ascii=False))


# ---------------------------------------------------------------------- главный

async def main():
    sample = str(tglib.arg("sample", "") or "").strip()
    if sample:
        run_sample(sample)
        return

    acc = tglib.resolve(tglib.arg("account", ""))
    folder = str(tglib.arg("folder", "") or "").strip()
    chat = str(tglib.arg("chat", "") or "").strip()
    list_file = str(tglib.arg("list", "") or "").strip()
    limit = int(tglib.arg("limit", LIMIT_DEFAULT) or LIMIT_DEFAULT)
    days = int(tglib.arg("days", DAYS_DEFAULT) or DAYS_DEFAULT)
    join = tglib.flag("join")
    if not (folder or chat or list_file):
        raise SystemExit("укажи откуда читать: --folder chats | --chat <ссылка> | --list <файл>")

    since = datetime.now(timezone.utc) - timedelta(days=days) if days else None
    say(f"аккаунт: {acc['title']}  |  {tglib.proxy_label(acc.get('proxy'))}  |  "
        f"читаю по {limit} сообщений/чат за {days} дн.")

    client = await tglib.connect(acc)
    profiles = load_leads()
    touched = set()
    try:
        # какие чаты обходим
        targets = []
        if folder:
            # резолвим каждый пир из папки: у сырого InputPeer нет .title/.id,
            # иначе все лиды помечаются чатом «чат» и персонализация ломается
            for peer in await folder_chats(client, folder):
                try:
                    targets.append(await client.get_entity(peer))
                except Exception as e:
                    say(f"  пропускаю чат из папки: {str(e).splitlines()[0][:60]}")
        elif chat:
            ref, invite = chat_ref(chat)
            targets = [await resolve_chat(client, ref, invite, join)]
        else:
            for line in open(list_file, encoding="utf-8"):
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                ref, invite = chat_ref(line)
                try:
                    targets.append(await resolve_chat(client, ref, invite, join))
                except Exception as e:
                    say(f"  пропускаю {line}: {str(e).splitlines()[0][:60]}")

        total = 0
        for entity in targets:
            try:
                total += await scan_chat(client, entity, acc["id"], limit, since, profiles, touched)
            except Exception as e:
                say(f"  чат пропущен: {str(e).splitlines()[0][:80]}")
            await asyncio.sleep(random.uniform(*PAUSE_PER_CHAT))
    finally:
        await tglib.aclose(client)

    ready = refresh_outreach(profiles)
    push_hot_to_sheet(profiles)
    save_leads(profiles)
    hot, warm, new_hot = digest(profiles, touched)
    say(f"готово: прочитал {total} сообщений, лидов сейчас hot={hot} warm={warm} "
        f"(новых горячих за заход: {new_hot}), писем готово {ready}")
    tglib.state(done=new_hot, left=0, note=f"hot {hot} / warm {warm}")


if __name__ == "__main__":
    asyncio.run(main())
