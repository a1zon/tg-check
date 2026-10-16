"""
Заглушка Telegram для песочницы: живые аккаунты не трогаются вовсе.

Состояние мира — world.json в папке профиля (TG_PANEL_DIR): люди, личные
переписки аккаунтов, группы с сообщениями, кто где состоит. Клиент умеет ровно
то, чем пользуются задачи панели (диалоги, чтение, отправка, вступление,
реакции, «печатает»), и считает примерный трафик каждого запроса — по размеру
того, что вернул бы Telegram. Так видно, сколько байт съела задача ДО и ПОСЛЕ
правок, не выходя в сеть.

Время сообщений — ISO в UTC. Сообщения новее «сейчас» не бывают.
"""
import json
import os
import random
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

DIR = Path(os.environ["TG_PANEL_DIR"]).resolve()
WORLD = DIR / "world.json"

# Сколько примерно весит в ответе Telegram: диалог с последним сообщением и
# собеседником, одно сообщение, накладные расходы запроса. Цифры грубые, но
# одинаковые до и после правок — для сравнения этого достаточно.
B_REQ_UP, B_REQ_DOWN = 120, 90
B_DIALOG, B_MSG, B_ENTITY = 230, 160, 140


def load():
    return json.loads(WORLD.read_text("utf-8"))


def save(w):
    tmp = WORLD.with_suffix(".tmp")
    tmp.write_text(json.dumps(w, ensure_ascii=False, indent=1), "utf-8")
    tmp.replace(WORLD)


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _dt(s):
    return datetime.fromisoformat(str(s).replace("Z", "+00:00"))


def _user(w, uid):
    u = w["users"].get(str(uid)) or {"id": int(uid), "first_name": f"user{uid}"}
    return SimpleNamespace(id=int(u["id"]), first_name=u.get("first_name", ""), last_name="",
                           username=u.get("username"), phone=u.get("phone"), bot=bool(u.get("bot")),
                           deleted=False, is_self=False)


def _chat(w, cid, me_uid):
    c = w["chats"][str(cid)]
    joined = me_uid in c.get("members", [])
    return SimpleNamespace(id=int(c["id"]), title=c.get("title", ""), username=c.get("username"),
                           megagroup=not c.get("broadcast"), broadcast=bool(c.get("broadcast")),
                           left=not joined,
                           default_banned_rights=None, slowmode_enabled=bool(c.get("slowmode")))


def _msg(w, m, me_uid, chat=None, peer_user=None):
    """Сообщение в виде, похожем на Telethon: id, out, message/text, date, sender…"""
    from_id = int(m.get("from_id") or (me_uid if m.get("out") else (peer_user or 0)))
    out = bool(m.get("out")) or from_id == me_uid
    reply = SimpleNamespace(reply_to_msg_id=int(m["reply_to"])) if m.get("reply_to") else None
    return SimpleNamespace(
        id=int(m["id"]), out=out, message=m.get("text", ""), text=m.get("text", ""),
        raw_text=m.get("text", ""), date=_dt(m["date"]), sender_id=from_id,
        sender=_user(w, from_id), reply_to=reply, action=None, media=None, fwd_from=None,
        voice=None, video_note=None, photo=None, video=None, document=None, sticker=None,
        chat_id=int(chat) if chat else from_id, via_bot_id=None, post=False,
    )


class FakeAction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class FakeClient:
    def __init__(self, acc):
        self.acc = acc
        w = load()
        self.me_uid = int(w["accounts"][acc["id"]]["user_id"])
        self.up = self.down = 0
        self.calls = []
        self._tg_acc = acc

    # ------------------------------------------------------------- учёт
    def _count(self, what, down=0, up=0):
        self.calls.append(what)
        self.up += B_REQ_UP + up
        self.down += B_REQ_DOWN + down

    # ------------------------------------------------------------- база
    async def get_me(self):
        self._count("get_me", B_ENTITY)
        w = load()
        a = w["accounts"][self.acc["id"]]
        return SimpleNamespace(id=self.me_uid, first_name=a.get("name", self.acc["id"]),
                               last_name="", username=a.get("username"), phone=a.get("phone"),
                               bot=False, premium=bool(a.get("premium")))

    async def is_user_authorized(self):
        return True

    def is_connected(self):
        return True

    async def disconnect(self):
        return None

    async def download_profile_photo(self, *a, **kw):
        return None

    def action(self, entity, action):
        self.calls.append(f"action:{action}")
        return FakeAction()

    # ------------------------------------------------------------- сущности
    def _resolve(self, w, x):
        """→ ('user', uid) | ('chat', cid)"""
        if hasattr(x, "channel_id") and not isinstance(x, SimpleNamespace):    # types.PeerChannel
            if str(x.channel_id) not in w["chats"]:
                raise ValueError("Could not find the input entity for PeerChannel")
            return "chat", int(x.channel_id)
        if isinstance(x, SimpleNamespace):
            if hasattr(x, "megagroup"):
                return "chat", int(x.id)
            return "user", int(x.id)
        if isinstance(x, int):
            if str(x) in w["chats"]:
                return "chat", x
            return "user", x
        s = str(x).strip().lstrip("@")
        s = s.replace("https://t.me/", "").replace("t.me/", "")
        for cid, c in w["chats"].items():
            if (c.get("username") or "").lower() == s.lower():
                return "chat", int(cid)
        for uid, u in w["users"].items():
            if (u.get("username") or "").lower() == s.lower():
                return "user", int(uid)
        raise ValueError(f'No user has "{s}" as username')

    async def get_entity(self, x):
        w = load()
        kind, i = self._resolve(w, x)
        self._count("get_entity", B_ENTITY)
        return _chat(w, i, self.me_uid) if kind == "chat" else _user(w, i)

    async def get_input_entity(self, x):
        return await self.get_entity(x)

    # ------------------------------------------------------------- диалоги
    def _dialogs(self, w):
        out = []
        for uid, msgs in (w["dms"].get(self.acc["id"]) or {}).items():
            if not msgs:
                continue
            last = msgs[-1]
            unread = sum(1 for m in msgs if not m.get("out") and not m.get("read"))
            ent = _user(w, uid)
            out.append(SimpleNamespace(is_user=True, is_group=False, is_channel=False, entity=ent,
                                       message=_msg(w, last, self.me_uid, peer_user=int(uid)),
                                       date=_dt(last["date"]), unread_count=unread, pinned=False,
                                       name=ent.first_name, id=ent.id))
        for cid, c in w["chats"].items():
            if self.me_uid not in c.get("members", []) or not c.get("messages"):
                continue
            last = c["messages"][-1]
            ent = _chat(w, cid, self.me_uid)
            out.append(SimpleNamespace(is_user=False, is_group=True, is_channel=True, entity=ent,
                                       message=_msg(w, last, self.me_uid, chat=cid),
                                       date=_dt(last["date"]), unread_count=0, pinned=False,
                                       name=ent.title, id=ent.id))
        # «закреплённые» сверху, дальше по дате последнего сообщения — как у Telegram
        pinned = set(map(str, (w.get("pinned") or {}).get(self.acc["id"], [])))
        for d in out:
            d.pinned = str(d.entity.id) in pinned
        out.sort(key=lambda d: (not d.pinned, -d.date.timestamp()))
        return out

    async def get_dialogs(self, limit=100, **kw):
        w = load()
        ds = self._dialogs(w)[:limit]
        self._count(f"get_dialogs({limit})", len(ds) * B_DIALOG)
        return ds

    # ------------------------------------------------------------- сообщения
    def _thread(self, w, kind, i):
        if kind == "chat":
            return w["chats"][str(i)]["messages"], i, None
        return (w["dms"].setdefault(self.acc["id"], {}).setdefault(str(i), []), None, i)

    async def get_messages(self, entity, limit=None, ids=None, min_id=0, max_id=0, **kw):
        w = load()
        kind, i = self._resolve(w, entity)
        msgs, chat, peer = self._thread(w, kind, i)
        if ids is not None:
            one = not isinstance(ids, (list, tuple))
            want = [ids] if one else list(ids)
            got = []
            for mid in want:
                m = next((x for x in msgs if int(x["id"]) == int(mid) and not x.get("deleted")), None)
                got.append(_msg(w, m, self.me_uid, chat=chat, peer_user=peer) if m else None)
            self._count("get_messages(ids)", B_MSG * len(want))
            return got[0] if one else got
        sel = [m for m in msgs if int(m["id"]) > int(min_id or 0) and not m.get("deleted")
               and (not max_id or int(m["id"]) < int(max_id))]
        sel = list(reversed(sel))[: (limit if limit is not None else 1)]
        self._count(f"get_messages({limit},min_id={min_id})", B_MSG * len(sel) + B_ENTITY)
        return [_msg(w, m, self.me_uid, chat=chat, peer_user=peer) for m in sel]

    async def iter_messages(self, entity, limit=None, **kw):
        for m in await self.get_messages(entity, limit=limit or 100, **kw):
            yield m

    async def send_message(self, entity, text, reply_to=None, link_preview=True, **kw):
        w = load()
        kind, i = self._resolve(w, entity)
        if kind == "chat":
            c = w["chats"][str(i)]
            if self.acc["id"] in c.get("write_forbidden", []):
                from telethon.errors import ChatWriteForbiddenError
                raise ChatWriteForbiddenError(request=None)
            if self.me_uid not in c.get("members", []):
                from telethon.errors import ChatWriteForbiddenError
                raise ChatWriteForbiddenError(request=None)
        msgs, chat, peer = self._thread(w, kind, i)
        mid = (max([int(m["id"]) for m in msgs]) + 1) if msgs else 1
        m = {"id": mid, "from_id": self.me_uid, "out": True, "text": text, "date": now_iso()}
        if reply_to:
            m["reply_to"] = int(reply_to)
        msgs.append(m)
        save(w)
        self._count("send_message", B_MSG, up=len(text.encode()) + 60)
        return _msg(w, m, self.me_uid, chat=chat, peer_user=peer)

    async def send_read_acknowledge(self, entity, message=None, max_id=None, **kw):
        w = load()
        kind, i = self._resolve(w, entity)
        if kind == "user":
            for m in (w["dms"].get(self.acc["id"]) or {}).get(str(i), []):
                m["read"] = True
            save(w)
        self._count("read_ack")

    # ------------------------------------------------------------- запросы
    async def __call__(self, req):
        name = type(req).__name__
        w = load()
        if name == "JoinChannelRequest":
            kind, i = self._resolve(w, req.channel)
            c = w["chats"][str(i)]
            if c.get("private"):
                from telethon.errors import ChannelPrivateError
                raise ChannelPrivateError(request=None)
            if self.me_uid not in c.setdefault("members", []):
                c["members"].append(self.me_uid)
                save(w)
            self._count("join", B_ENTITY * 2)
            return SimpleNamespace(chats=[_chat(w, i, self.me_uid)])
        if name in ("SendReactionRequest", "SendVoteRequest", "SetTypingRequest",
                    "DeleteContactsRequest"):
            self._count(name)
            return SimpleNamespace()
        if name == "CreateChannelRequest":
            cid = max([int(k) for k in w["chats"]] + [1000]) + 1
            w["chats"][str(cid)] = {"id": cid, "title": req.title, "broadcast": bool(req.broadcast),
                                    "members": [self.me_uid], "messages": [], "owner": self.acc["id"]}
            save(w)
            self._count(name, B_ENTITY * 2)
            return SimpleNamespace(chats=[_chat(w, cid, self.me_uid)])
        if name == "CheckUsernameRequest":
            taken = {(c.get("username") or "").lower() for c in w["chats"].values()} | \
                    {(u.get("username") or "").lower() for u in w["users"].values()}
            self._count(name)
            return req.username.lower() not in taken
        if name == "UpdateUsernameRequest" and hasattr(req, "channel"):
            kind, i = self._resolve(w, req.channel)
            w["chats"][str(i)]["username"] = req.username
            save(w)
            self._count(name)
            return True
        if name == "EditTitleRequest":
            kind, i = self._resolve(w, req.channel)
            w["chats"][str(i)]["title"] = req.title
            save(w)
            self._count(name)
            return SimpleNamespace()
        if name == "UpdatePinnedMessageRequest":
            kind, i = self._resolve(w, req.peer)
            w["chats"][str(i)]["pinned"] = req.id
            save(w)
            self._count(name)
            return SimpleNamespace()
        if name == "UpdatePersonalChannelRequest":
            ch = req.channel
            w.setdefault("personal", {})[self.acc["id"]] = (
                None if type(ch).__name__ == "InputChannelEmpty" else self._resolve(w, ch)[1])
            save(w)
            self._count(name)
            return True
        if name == "UpdateProfileRequest":
            if getattr(req, "about", None) is not None:
                w["accounts"][self.acc["id"]]["about"] = req.about
                save(w)
            self._count(name, B_ENTITY)
            return SimpleNamespace()
        if name == "ImportContactsRequest":
            self._count(name, B_ENTITY)
            return SimpleNamespace(users=[], imported=[])
        if name == "GetFullUserRequest":
            self._count(name, B_ENTITY * 3)
            return SimpleNamespace(full_user=SimpleNamespace(about=""), users=[])
        self._count(name)
        return SimpleNamespace()


async def connect(acc, **kw):
    """Подмена tglib.connect: те же проверки отдыха, что у настоящего."""
    import tglib
    rest = tglib.full_rest_left(acc)
    if rest > 0:
        raise SystemExit(f"«{acc.get('title', acc['id'])}» на полном отдыхе — к Telegram не подключаю")
    c = FakeClient(acc)
    c._count("connect+config", 6000, up=900)     # рукопожатие и конфиг — как у живого
    return c


async def aclose(client):
    """Подмена tglib.aclose: пишем «трафик» задачи в traffic.csv, как настоящий."""
    import sys
    import tglib
    task = Path(sys.argv[0]).stem
    tglib.append_row(tglib.TRAFFIC, [tglib.now_iso(), client.acc.get("id", ""), task, "sandbox",
                                     client.up, client.down], tglib.TRAFFIC_HEAD)
    log = DIR / "sandbox-calls.log"
    with log.open("a", encoding="utf-8") as f:
        f.write(f"{task} {client.acc.get('id')}: up={client.up} down={client.down} "
                f"calls={client.calls}\n")


def fake_llm_chat(system, user, max_tokens=400, temperature=0.8, tries=5, model=None):
    """
    Подмена llm.chat. Для комментариев отвечает JSON — выбирает первое
    подходящее сообщение (строка «id=N …» в запросе); для разбора ответов
    followup отвечает «НЕЯСНО». Сценарий «модель промолчала» — TG_FAKE_LLM=null.
    """
    import re
    mode = os.environ.get("TG_FAKE_LLM", "ok")
    if mode == "null":
        return None
    if "JSON" in system or "JSON" in user:
        ids = re.findall(r"^\[id=(\d+)\]", user, re.M)
        if not ids or mode == "skip":
            return '{"id": null, "reply": null}'
        if mode == "bad":
            return json.dumps({"id": int(ids[-1]), "reply": "Подписывайтесь на наш канал t.me/x"},
                              ensure_ascii=False)
        return json.dumps({"id": int(ids[-1]),
                           "reply": random.choice(["по вторичке на Уралмаше сейчас торг 3–5% нормально идёт",
                                                   "одобрение по ипотеке обычно 1–3 дня, если доход белый"])},
                          ensure_ascii=False)
    return "НЕЯСНО"
