#!/usr/bin/env python3
"""
Отправка первого письма горячему лиду.

Пишет одному человеку из leads.json персональный текст (вариант A или B, либо
свой, переданный через --text). Пишет тем аккаунтом, который этого человека
НАШЁЛ (profile.by): у него в сессии уже есть доступ к юзеру из чата — значит
можно написать даже тому, у кого нет @username.

    python send-lead.py --user @anna_ekb --variant a
    python send-lead.py --user id:202 --variant b
    python send-lead.py --user @anna_ekb --text "свой текст"

После отправки в карточке ставится message_sent=true — второй раз тому же
человеку панель не напишет.
"""
import asyncio
import json

import tglib
from tglib import say


def load_leads():
    try:
        return json.loads(tglib.LEADS.read_text("utf-8"))
    except Exception:
        return {}


def save_leads(d):
    tglib.LEADS.write_text(json.dumps(d, ensure_ascii=False, indent=1), "utf-8")


def find_profile(leads, user):
    """user: @username, id:<n> или просто <user_id>. Возвращает (key, profile)."""
    u = str(user or "").strip()
    if u.startswith("id:"):
        u = u[3:]
    u = u.lstrip("@")
    for key, p in leads.items():
        if str(p.get("user_id")) == u or (p.get("username") and p["username"].lower() == u.lower()):
            return key, p
    return None, None


async def main():
    user = tglib.arg("user", "")
    variant = str(tglib.arg("variant", "a") or "a").lower()
    override = tglib.arg("text", "")

    leads = load_leads()
    key, p = find_profile(leads, user)
    if not p:
        raise SystemExit(f"не нашёл лида {user} в leads.json")
    if p.get("message_sent"):
        say("этому лиду уже писали — пропускаю")
        tglib.state(done=0, left=0, note="уже написано")
        return

    text = override or (p.get("outreach") or {}).get(f"variant_{variant}") or ""
    if not text.strip():
        raise SystemExit("нет текста письма (сначала прогони поиск лидов, чтобы сгенерить)")

    # пишем аккаунтом-нашедшим: у него в сессии есть доступ к юзеру из чата
    acc = tglib.resolve(p.get("by") or tglib.arg("account", ""))
    say(f"пишу лиду {p.get('display_name') or user} от {acc['title']} (вариант {variant.upper()})")

    client = await tglib.connect(acc)
    try:
        if p.get("username"):
            peer = await client.get_entity("@" + p["username"].lstrip("@"))
        else:
            # без ника — по id из кэша сессии того же аккаунта (он видел его в чате)
            peer = await client.get_input_entity(int(p["user_id"]))
        # link_preview=False — ссылка-квиз не растягивает письмо картинкой
        await client.send_message(peer, text, link_preview=False)
    except Exception as e:
        from telethon.errors import FloodWaitError
        if isinstance(e, FloodWaitError):
            say(f"Telegram просит паузу {e.seconds} c — не отправил")
            tglib.state(done=0, left=0, stop="flood", cooldown=e.seconds)
            return
        say(f"не отправил: {str(e).splitlines()[0][:100]}")
        tglib.state(done=0, left=0, note="ошибка отправки")
        return
    finally:
        await tglib.aclose(client)

    p["message_sent"] = True
    p["sent_at"] = tglib.now_iso()
    p["sent_variant"] = variant
    save_leads(leads)
    # в журнал рассылки — чтобы счётчики «написано» двигались
    tglib.ensure_head(tglib.DRAFTS, tglib.DRAFTS_HEAD)
    tglib.append_row(tglib.DRAFTS,
                     [tglib.member_key(p.get("username"), p.get("user_id")),
                      acc["id"], "true", "true", tglib.now_iso()],
                     tglib.DRAFTS_HEAD)
    say("отправлено, карточка помечена")
    tglib.state(done=1, left=0, note="отправлено")


if __name__ == "__main__":
    asyncio.run(main())
