"""
Комментарии в чатах — действие прогрева «comment».

Аккаунт, пока стоит между пачками писем (или уже прогрет и простаивает), заходит
в 1–3 «своих» городских чата, читает новое и, если есть на что ответить по делу,
отвечает одному человеку. Текст пишет модель по образу из comment-persona.txt,
код проверяет его на рекламу, ссылки, штампы и повторы. Ссылок в комментариях
нет никогда: кому интересно — откроет профиль.

Правила, ради которых это отдельный модуль:
  • в одном чате пишет только один наш аккаунт (чаты закрепляются за аккаунтами);
  • аккаунт не комментирует там, откуда сам берёт людей для писем (разбирал чат
    или писал его участникам) — не светимся перед теми, кому пишем в личку;
  • в чат — не чаще раза в chat_rest_hours, ответ — только на свежее сообщение;
  • удалили наш комментарий — чат у этого аккаунта выключается, удалили два
    раза разным аккаунтам — чат выключается насовсем;
  • первые approve_first комментариев ждут одобрения в панели.

Настройки — раздел "comments" в warm-list.json (см. warm-list.default.json).
Файлы профиля: comment-plan.json (чаты и их состояние), comments.csv (журнал),
comments-pending.json (очередь на одобрение), comments-decisions.json (решения
из панели — пишет только панель), comment-persona.txt (образ, правит хозяин).
"""
import asyncio
import contextlib
import hashlib
import json
import random
import re
from datetime import datetime, timedelta, timezone

import llm
import tglib
from tglib import say

PLAN = tglib.DIR / "comment-plan.json"
LOG = tglib.DIR / "comments.csv"
LOG_HEAD = ["at", "account", "chat", "msg_id", "reply_id", "status", "text", "their"]
PENDING = tglib.DIR / "comments-pending.json"
DECISIONS = tglib.DIR / "comments-decisions.json"
PERSONA = tglib.DIR / "comment-persona.txt"
PERSONA_DEFAULT = tglib.CODE / "comment-persona.default.txt"

DEFAULTS = {
    "on": False,               # главный выключатель
    "chats": [],               # свои ссылки/ники; пусто — чаты режима «по чатам» (chats.json, с ником)
    "per_day": [1, 2],         # комментариев в сутки у аккаунта в рассылке/догреве
    "held_accounts": [],       # временно ограниченные, которым можно комментировать
    "held_per_day": [1, 2],
    "approve_first": 50,       # столько первых комментариев ждут одобрения в панели
    "max_age_hours": 12,       # отвечаем только на сообщения не старше
    "chat_rest_hours": 24,     # в один чат — не чаще (продолжение разговора — можно)
    "chats_per_account": 8,    # сколько чатов закрепляем за аккаунтом
    "visit_per_action": 3,     # сколько чатов смотрим за один заход
    "joins_per_day": 2,        # вступлений в новые чаты в сутки
    "thread_depth": 3,         # сколько раз подряд отвечаем в одном разговоре
    "context": 15,             # столько последних сообщений чата видит модель
    "read_pause": [3, 8],      # «читаем» перед ответом, сек
    "typing": [10, 40],        # «печатает…», сек (по длине текста)
    "model": "openai/gpt-6-luna",
}
MIN_LEN = 15                   # короче — реакции и «ок», отвечать не на что
READ_LIMIT = 40                # больше новых сообщений чата за заход не тянем
SHINGLE_DUP = 0.5              # похожесть на прошлые комментарии, выше — повтор

AD_RE = re.compile(r"(https?://|www\.|t\.me/|telegram\.me|@[a-z0-9_]{4,}|\+?\d[\d\s()-]{9,}\d)", re.I)
PROMO_RE = re.compile(r"(подпис|канал|в лс|в личк|пишите мне|напишите мне|обращайтесь|звоните|"
                      r"мой номер|наш агент|скидк|акци[яи]|реклам|переходите)", re.I)
CLICHE_RE = re.compile(r"^(отличный вопрос|хороший вопрос|полностью согласен|как ии|как языковая модель|"
                       r"я не могу|извините, но|к сожалению, я|надеюсь, помог|рекомендую обратиться)", re.I)
LINK_RE = re.compile(r"(https?://|www\.|t\.me/|telegram\.me|@[a-z0-9_]{4,})", re.I)
EMOJI_RE = re.compile("[\U0001F300-\U0001FAFF\u2600-\u27BF]")
PENDING_MAX = 10               # столько неразобранных в панели — новых не плодим


# ------------------------------------------------------------------ файлы

@contextlib.contextmanager
def locked(path):
    """Тот же замок, что у разбора чатов: комментируют несколько аккаунтов сразу."""
    try:
        import fcntl
    except ImportError:          # Windows: там всё идёт по одному
        yield
        return
    with open(str(path) + ".lock", "a") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def _read_json(path, default):
    try:
        v = json.loads(path.read_text("utf-8"))
        return v if isinstance(v, type(default)) else default
    except Exception:
        return default


def _write_json(path, data):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", "utf-8")
    tmp.replace(path)


def now():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


def hours_since(s):
    t = parse_iso(s)
    return (now() - t).total_seconds() / 3600 if t else 1e9


# ------------------------------------------------------------------ настройки

def config(data):
    c = dict(DEFAULTS)
    c.update((data or {}).get("comments") or {})
    return c


def norm_chat(x):
    """Публичный ник чата из ссылки/@ника; приглашения (+хеш) не берём."""
    s = str(x or "").strip()
    s = re.sub(r"^(https?://)?(www\.)?(t\.me|telegram\.me)/", "", s, flags=re.I).split("?")[0].strip("/")
    if not s or s.startswith("+") or s.lower().startswith("joinchat") or "/" in s:
        return ""
    s = s.lstrip("@")
    return s.lower() if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{3,31}", s) else ""


def chat_pool(cfg):
    """{ник: заголовок} — где можно комментировать."""
    out = {}
    for x in cfg.get("chats") or []:
        u = norm_chat(x)
        if u:
            out[u] = u
    if not cfg.get("chats"):
        for rec in _read_json(tglib.DIR / "chats.json", {}).values():
            u = norm_chat((rec or {}).get("username"))
            if u:
                out[u] = (rec or {}).get("title") or u
    return out


def letter_chats():
    """
    {заголовок чата (нижний регистр): {аккаунты}} — где аккаунт сам берёт людей
    для писем: разбирал чат (members.csv, by) или писал его участникам.
    """
    key_chats, out = {}, {}
    for r in tglib.read_csv(tglib.MEMBERS):
        t = (r.get("chat") or "").strip().lower()
        if not t:
            continue
        if r.get("key"):
            key_chats.setdefault(r["key"], set()).add(t)
        if r.get("by"):
            out.setdefault(t, set()).add(r["by"])
    for r in tglib.read_csv(tglib.CHATS_DIR / "drafts.csv"):
        if r.get("sent") == "true" or r.get("ok") == "true":
            for t in key_chats.get(r.get("phone"), ()):
                out.setdefault(t, set()).add(r.get("account"))
    return out


def persona(acc_id):
    """Образ (общий для всех — кэшируется у модели) + манера этого аккаунта."""
    if not PERSONA.exists() and PERSONA_DEFAULT.exists():
        PERSONA.write_text(PERSONA_DEFAULT.read_text("utf-8"), "utf-8")
    text = PERSONA.read_text("utf-8") if PERSONA.exists() else PERSONA_DEFAULT.read_text("utf-8")
    head, _, tail = text.partition("## Манеры")
    manners = [ln[2:].strip() for ln in tail.splitlines() if ln.startswith("- ")]
    if manners:
        k = int(hashlib.sha256(acc_id.encode()).hexdigest()[:8], 16) % len(manners)
        head = head.rstrip() + f"\n\nТвоя манера: {manners[k]}."
    return head.strip()


# ------------------------------------------------------------------ закрепление чатов

def assign(plan, pool, acc, cfg, busy):
    """
    Чаты этого аккаунта. Не хватает до chats_per_account — добираем из
    свободных, где он не берёт людей для писем и откуда его ещё не выгоняли.
    Закреплённое не перекидываем: аккаунт, скачущий по новым чатам, — та же
    накрутка.
    """
    mine = [u for u, st in plan.items() if st.get("account") == acc["id"] and not st.get("off")]
    want = int(cfg["chats_per_account"]) - len(mine)
    if want > 0:
        free = [u for u in pool if not (plan.get(u) or {}).get("account")
                and not (plan.get(u) or {}).get("off")
                and acc["id"] not in (plan.get(u) or {}).get("excluded", [])
                and acc["id"] not in busy.get(str(pool[u]).strip().lower(), set())]
        random.shuffle(free)
        for u in free[:want]:
            st = plan.setdefault(u, {})
            st.update({"account": acc["id"], "since": iso(now()), "title": pool[u]})
            mine.append(u)
    return mine


def release(st, acc_id, reason):
    """Чат больше не у этого аккаунта: выгнали, удалили комментарий, закрыт."""
    st["excluded"] = sorted(set(st.get("excluded", [])) | {acc_id})
    st["account"] = ""
    st["last_off"] = reason


# ------------------------------------------------------------------ проверка текста

def _shingles(text):
    w = re.findall(r"\w+", text.lower())
    return {" ".join(w[i:i + 3]) for i in range(max(1, len(w) - 2))}


def check_reply(text, their, recent):
    """(текст, None) — годится; (None, причина) — нет."""
    t = (text or "").strip().strip('"«»').strip()
    if not t or t.lower() in ("null", "none"):
        return None, "модель промолчала"
    if len(t) < 3 or len(t) > 280:
        return None, f"длина {len(t)}"
    if AD_RE.search(t):
        return None, "ссылка, @ник или телефон"
    if PROMO_RE.search(t):
        return None, "похоже на рекламу"
    if CLICHE_RE.search(t):
        return None, "штамп или отказ модели"
    if len([s for s in re.split(r"[.!?…]+", t) if s.strip()]) > 3:
        return None, "длиннее трёх предложений"
    if len(EMOJI_RE.findall(t)) > 1:
        return None, "много смайликов"
    if t.lower() == (their or "").strip().lower():
        return None, "повторяет собеседника"
    sh = _shingles(t)
    for old in recent:
        o = _shingles(old)
        if sh and o and len(sh & o) / len(sh | o) >= SHINGLE_DUP:
            return None, "повтор прошлого комментария"
    return t, None


def recent_texts(limit=200):
    rows = [r for r in tglib.read_csv(LOG) if r.get("status") in ("sent", "pending")]
    return [r.get("text", "") for r in rows[-limit:]]


# ------------------------------------------------------------------ модель

PROMPT_TAIL = (
    "\n\nВыбери ОДНО сообщение из помеченных [id=…], на которое тебе есть что сказать по делу, "
    "и напиши ответ в своём образе. Если отвечать не на что или нечего добавить по существу — "
    "верни null.\nВерни ТОЛЬКО JSON: {\"id\": <число или null>, \"reply\": \"<текст или null>\"}"
)


def build_prompt(title, context, candidates, ours):
    """Лента чата (старые сверху), отвечать можно только на [id=…]."""
    lines = [f"Чат: «{title}»", "Последние сообщения (старые сверху):"]
    cand = {m.id for m in candidates}
    for m in context:
        name = tglib.cell(getattr(m.sender, "first_name", "") or "участник")[:24]
        text = tglib.cell(m.message or "")[:300]
        if m.id in cand:
            mins = int((now() - m.date).total_seconds() // 60)
            to_us = " (ответ на твоё сообщение)" if m.id in ours else ""
            lines.append(f"[id={m.id}] {name}, {mins} мин назад{to_us}: {text}")
        elif m.out:
            lines.append(f"- ты: {text}")
        else:
            lines.append(f"- {name}: {text}")
    return "\n".join(lines) + PROMPT_TAIL


def ask_model(system, prompt, cfg):
    out = llm.chat(system, prompt, max_tokens=300, temperature=0.8, model=cfg.get("model"))
    if not out:
        return None, None, llm.LAST_ERR or "модель не ответила"
    m = re.search(r"\{.*\}", out, re.S)
    try:
        d = json.loads(m.group(0)) if m else {}
    except Exception:
        return None, None, "модель ответила не JSON"
    mid = d.get("id")
    try:
        mid = int(mid) if mid not in (None, "null", "") else None
    except Exception:
        mid = None
    return mid, d.get("reply"), None


# ------------------------------------------------------------------ одобрение

def queue_review(item):
    with locked(PENDING):
        data = _read_json(PENDING, [])
        data.append(item)
        _write_json(PENDING, data[-500:])


def reviewed_count():
    """Сколько комментариев уже прошло через одобрение (решено в панели)."""
    dec = _read_json(DECISIONS, {})
    return sum(1 for v in dec.values() if isinstance(v, dict) and v.get("ok") in (True, False))


def approved_for(acc_id, max_age):
    """Одобренные в панели и ещё не отправленные комментарии этого аккаунта."""
    dec = _read_json(DECISIONS, {})
    out = []
    for it in _read_json(PENDING, []):
        d = dec.get(it.get("id")) or {}
        if it.get("account") == acc_id and it.get("status") == "pending" and d.get("ok") is True:
            it = dict(it, reply=(d.get("text") or it.get("reply")))
            out.append((it, hours_since(it.get("their_at")) <= max_age * 2))
    return out


def has_approved(acc_id):
    """Есть ли у аккаунта одобренный и ещё не отправленный комментарий."""
    dec = _read_json(DECISIONS, {})
    return any(it.get("account") == acc_id and it.get("status") == "pending"
               and (dec.get(it.get("id")) or {}).get("ok") is True
               for it in _read_json(PENDING, []))


def mark_item(item_id, status):
    with locked(PENDING):
        data = _read_json(PENDING, [])
        for it in data:
            if it.get("id") == item_id:
                it["status"] = status
                it["done_at"] = iso(now())
        _write_json(PENDING, data)


def undecided_count():
    dec = _read_json(DECISIONS, {})
    return sum(1 for it in _read_json(PENDING, [])
               if it.get("status") == "pending" and it.get("id") not in dec)


def drop_rejected():
    """Отклонённые в панели — снимаем из очереди."""
    dec = _read_json(DECISIONS, {})
    with locked(PENDING):
        data = _read_json(PENDING, [])
        changed = False
        for it in data:
            if it.get("status") == "pending" and (dec.get(it.get("id")) or {}).get("ok") is False:
                it["status"] = "rejected"
                changed = True
        if changed:
            _write_json(PENDING, data)


# ------------------------------------------------------------------ Telegram

async def _send(client, ent, text, reply_to, cfg):
    """«Печатает…» по длине текста, потом ответ на сообщение."""
    lo, hi = cfg["typing"]
    t = max(lo, min(hi, len(text) / 8)) * random.uniform(0.8, 1.2)
    try:
        async with client.action(ent, "typing"):
            await asyncio.sleep(t)
    except Exception:
        await asyncio.sleep(t)
    return await client.send_message(ent, text, reply_to=reply_to, link_preview=False)


def log_row(acc_id, chat, msg_id, reply_id, status, text, their):
    tglib.append_row(LOG, [iso(now()), acc_id, chat, msg_id or "", reply_id or "", status,
                           tglib.cell(text)[:300], tglib.cell(their)[:200]], LOG_HEAD)


async def check_deleted(client, ent, st, acc_id):
    """
    Живы ли наши прошлые комментарии в этом чате (старше двух часов, ещё не
    проверенные). Удалили — значит, чату мы не нравимся.
    """
    todo = [c for c in st.get("comments", []) if not c.get("checked") and hours_since(c.get("at")) >= 2]
    if not todo:
        return 0
    got = await client.get_messages(ent, ids=[int(c["id"]) for c in todo])
    gone = 0
    for c, m in zip(todo, got if isinstance(got, list) else [got]):
        c["checked"] = True
        if m is None:
            c["deleted"] = True
            gone += 1
    return gone


async def visit(client, acc, u, st, cfg, own_ids, system, recent, allow_join, review):
    """
    Один чат: вступить (если ещё не там), прочитать новое, ответить одному.
    → ("sent"|"queued"|"joined"|"none"|"off", пояснение)
    """
    from telethon.errors import (ChannelPrivateError, ChatWriteForbiddenError, UserBannedInChannelError,
                                 ChatAdminRequiredError, SlowModeWaitError, UsernameNotOccupiedError,
                                 UsernameInvalidError, InviteRequestSentError, ChannelsTooMuchError)
    from telethon.tl.functions.channels import JoinChannelRequest

    try:
        ent = await client.get_entity(u)
    except (UsernameNotOccupiedError, UsernameInvalidError, ValueError):
        st["off"] = "нет такого чата"
        return "off", "нет такого чата"
    if not getattr(ent, "megagroup", False) and getattr(ent, "broadcast", False):
        st["off"] = "это канал, а не группа"
        return "off", st["off"]
    if getattr(ent, "left", False):
        if not allow_join:
            return "none", "надо вступить — сегодня уже вступали"
        try:
            await client(JoinChannelRequest(ent))
        except (ChannelPrivateError, InviteRequestSentError):
            release(st, acc["id"], "закрытый")
            return "off", "закрытый чат"
        except ChannelsTooMuchError:
            return "none", "у аккаунта предел групп"
        st["joined_at"] = iso(now())
        st["last_visit"] = iso(now())
        return "joined", "вступил — сначала почитаем"

    gone = await check_deleted(client, ent, st, acc["id"])
    if gone:
        st["deleted_total"] = int(st.get("deleted_total", 0)) + gone
        if st["deleted_total"] >= 2:
            st["off"] = "удаляют наши комментарии"
        release(st, acc["id"], "удалили комментарий")
        return "off", f"удалили наш комментарий ({gone})"

    msgs = await client.get_messages(ent, limit=READ_LIMIT, min_id=int(st.get("last_seen") or 0))
    st["last_visit"] = iso(now())
    if not msgs:
        return "none", "нового нет"
    st["last_seen_before"] = int(st.get("last_seen") or 0)
    st["last_seen"] = max(m.id for m in msgs)
    with contextlib.suppress(Exception):
        await client.send_read_acknowledge(ent, max_id=st["last_seen"])

    ours = {int(c["id"]): int(c.get("depth", 1)) for c in st.get("comments", [])}
    fresh = sorted(msgs, key=lambda m: m.id)
    max_age = timedelta(hours=float(cfg["max_age_hours"]))
    rest_ok = hours_since(st.get("last_comment")) >= float(cfg["chat_rest_hours"])
    cands, replies_to_us = [], set()
    for m in fresh:
        text = (m.message or "").strip()
        if m.out or m.sender_id in own_ids or getattr(m.sender, "bot", False) or m.fwd_from:
            continue
        if len(text) < MIN_LEN or not re.search(r"[A-Za-zА-Яа-яЁё]", text) or LINK_RE.search(text):
            continue
        if now() - m.date > max_age:
            continue
        to = getattr(m.reply_to, "reply_to_msg_id", None)
        if to in ours:
            if ours[to] >= int(cfg["thread_depth"]):
                continue
            replies_to_us.add(m.id)
        elif not rest_ok:
            continue
        cands.append(m)
    if not cands:
        return "none", "отвечать не на что"

    # мало нового — подтягиваем чуть старше, чтобы модель видела разговор
    need = int(cfg["context"]) - len(fresh)
    if need > 0 and int(st.get("last_seen_before") or 0):
        with contextlib.suppress(Exception):
            older = await client.get_messages(ent, limit=need, max_id=min(m.id for m in fresh))
            fresh = sorted(list(older) + fresh, key=lambda m: m.id)
    # «читаем»
    lo, hi = cfg["read_pause"]
    await asyncio.sleep(random.uniform(lo, hi))
    context = fresh[-int(cfg["context"]):]
    mid, reply, err = ask_model(system, build_prompt(st.get("title") or u, context, cands, replies_to_us), cfg)
    if err:
        return "none", err
    target = next((m for m in cands if m.id == mid), None)
    if not target:
        return "none", "модель решила промолчать" if mid is None else "модель выбрала не то сообщение"
    text, why = check_reply(reply, target.message, recent)
    if not text:
        log_row(acc["id"], u, target.id, "", "rejected", str(reply or ""), target.message)
        return "none", f"текст не прошёл проверку: {why}"
    to = getattr(target.reply_to, "reply_to_msg_id", None)
    depth = ours.get(to, 0) + 1 if target.id in replies_to_us else 1

    if review:
        item_id = hashlib.sha256(f"{acc['id']}:{u}:{target.id}".encode()).hexdigest()[:12]
        queue_review({"id": item_id, "account": acc["id"], "chat": u, "chat_title": st.get("title") or u,
                      "msg_id": target.id, "their": tglib.cell(target.message)[:400],
                      "their_name": tglib.cell(getattr(target.sender, "first_name", ""))[:40],
                      "their_at": iso(target.date), "reply": text, "depth": depth,
                      "created": iso(now()), "status": "pending"})
        log_row(acc["id"], u, target.id, "", "pending", text, target.message)
        st["last_comment"] = iso(now())     # и не мучаем чат, пока ждём решения
        return "queued", f"ждёт одобрения в панели: «{text}»"

    try:
        sent = await _send(client, ent, text, target.id, cfg)
    except (ChatWriteForbiddenError, UserBannedInChannelError, ChatAdminRequiredError, ChannelPrivateError):
        release(st, acc["id"], "писать нельзя")
        return "off", "в этом чате писать нельзя"
    except SlowModeWaitError as e:
        st["last_comment"] = iso(now() + timedelta(seconds=e.seconds))
        return "none", f"медленный режим {e.seconds} с"
    st.setdefault("comments", []).append({"id": sent.id, "at": iso(now()), "depth": depth})
    st["comments"] = st["comments"][-30:]
    st["last_comment"] = iso(now())
    log_row(acc["id"], u, target.id, sent.id, "sent", text, target.message)
    return "sent", f"ответил в «{st.get('title') or u}»: «{text}»"


async def send_approved(client, acc, plan, cfg):
    """Одобренное в панели — отправить (если сообщение ещё свежее)."""
    for it, fresh in approved_for(acc["id"], float(cfg["max_age_hours"])):
        if not fresh:
            mark_item(it["id"], "expired")
            log_row(acc["id"], it["chat"], it["msg_id"], "", "expired", it["reply"], it.get("their"))
            continue
        st = plan.setdefault(it["chat"], {})
        try:
            ent = await client.get_entity(it["chat"])
            sent = await _send(client, ent, it["reply"], int(it["msg_id"]), cfg)
        except Exception as e:
            from telethon.errors import FloodWaitError, PeerFloodError
            if isinstance(e, (FloodWaitError, PeerFloodError)):
                raise
            mark_item(it["id"], "failed")
            log_row(acc["id"], it["chat"], it["msg_id"], "", "failed", it["reply"], str(e)[:120])
            continue
        mark_item(it["id"], "sent")
        st.setdefault("comments", []).append({"id": sent.id, "at": iso(now()), "depth": it.get("depth", 1)})
        st["last_comment"] = iso(now())
        log_row(acc["id"], it["chat"], it["msg_id"], sent.id, "sent", it["reply"], it.get("their"))
        return f"отправил одобренный комментарий в «{it.get('chat_title') or it['chat']}»", it["chat"]
    return None, None


async def do_comment(client, acc, data, joined_today):
    """
    Действие прогрева → (итог, что было, чат). Итог: True — комментарий ушёл
    (или встал на одобрение), None — отвечать было не на что, False — не вышло.
    «Что было»: sent | queued | joined | none. FloodWait и PeerFlood поднимает
    наверх — их обрабатывает прогрев (отлёжка).
    """
    cfg = config(data)
    if not cfg["on"]:
        say("комментарии выключены (warm-list.json → comments.on)")
        return None, "none", ""
    pool = chat_pool(cfg)
    if not pool:
        say("нет чатов для комментариев: в chats.json нет ников, а свой список пуст")
        return None, "none", ""
    drop_rejected()
    own_ids = {int(a["user_id"]) for a in tglib.load_accounts() if a.get("user_id")}
    with locked(PLAN):
        plan = _read_json(PLAN, {})
        mine = assign(plan, pool, acc, cfg, letter_chats())
        _write_json(PLAN, plan)
    if not mine:
        say("свободных чатов для этого аккаунта нет (заняты другими или тут он берёт людей для писем)")
        return None, "none", ""

    got, chat = await send_approved(client, acc, plan, cfg)
    if got:
        _save_states(plan, mine + [chat])
        say(got)
        return True, "sent", chat

    review = reviewed_count() < int(cfg["approve_first"])
    if review and undecided_count() >= PENDING_MAX:
        say(f"в панели ждут одобрения {PENDING_MAX}+ комментариев — новые не пишу, пока не разберёшь")
        return None, "none", ""
    system = persona(acc["id"])
    recent = recent_texts()
    order = sorted(mine, key=lambda u: plan[u].get("last_visit") or "")
    joins_left = int(cfg["joins_per_day"]) - joined_today
    result = (None, "none", "")
    for u in order[: int(cfg["visit_per_action"])]:
        st = plan[u]
        kind, why = await visit(client, acc, u, st, cfg, own_ids, system, recent, joins_left > 0, review)
        say(f"  {st.get('title') or u}: {why}")
        if kind == "joined":
            result = (True, "joined", u)
            break                        # вступил — на этот заход хватит, комментируем потом
        if kind in ("sent", "queued"):
            result = (True, kind, u)
            break
        await asyncio.sleep(random.uniform(2, 6))
    _save_states(plan, mine)
    return result


def _save_states(plan, mine):
    """Состояние своих чатов — обратно в общий план (под замком, поверх свежего)."""
    with locked(PLAN):
        cur = _read_json(PLAN, {})
        for u in mine:
            if u in plan:
                cur[u] = plan[u]
        _write_json(PLAN, cur)


def joined_today(acc_id):
    """Сколько чатов аккаунт уже вступил сегодня (по плану)."""
    day = now().date()
    return sum(1 for st in _read_json(PLAN, {}).values()
               if (st.get("joined_at") or "") and parse_iso(st["joined_at"]).date() == day
               and acc_id in (st.get("account"), *st.get("excluded", [])))
