#!/usr/bin/env python3
"""
Нативная проверка/подключение аккаунта через Telethon (MTProto), в обход
Telegram Web. Прикидываемся тем же десктопом, с которого сделана сессия —
для купленных tdata это родной канал, где ключ должен подниматься, даже если
веб-логин его сбрасывает.

Источник ключа — tdata или .session; сам ключ собираем в сессию в памяти,
сеть нужна только на connect().

    python tg-native.py --tdata <папка|.zip> [--proxy socks5://u:p@h:port]
    python tg-native.py --session <файл.session> [--proxy ...]
    python tg-native.py --key <hex> --dc <n> [--proxy ...]

Прокси можно отдать и через TG_NATIVE_PROXY (так его передаёт native-check.py:
строку с паролем в аргументах видно в ps). Ключ аккаунта панели (тот же файл
сессии или тот же user_id в реестре профиля) идёт как в задачах: через СВОЙ
прокси аккаунта, со своим api_id и отпечатком. Страна выхода проверяется до
подключения всегда; без прокси не подключаемся (прямой выход нарочно —
TG_ALLOW_DIRECT=1).

Печатает JSON: {"state":"ok|dead|error", "user_id":..., "name":..., "phone":...}
Всё лишнее — в stderr.
"""
import argparse
import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key"); ap.add_argument("--dc", type=int)
    ap.add_argument("--session"); ap.add_argument("--tdata")
    ap.add_argument("--proxy", default="")
    ap.add_argument("--user-id", type=int, default=0)
    return ap.parse_args()


A = parse_args()


def use_profile_of(session):
    """Сессия лежит в sessions/ профиля панели — читаем его реестр (TG_PANEL_DIR)."""
    code, d = Path(__file__).resolve().parent, session.resolve().parent.parent
    if (not os.environ.get("TG_PANEL_DIR") and session.resolve().parent.name == "sessions"
            and (d == code or d.parent == code / "profiles") and (d / "accounts.json").exists()):
        os.environ["TG_PANEL_DIR"] = str(d)


if A.session:
    use_profile_of(Path(A.session).expanduser())
import tglib  # noqa: E402 — после выбора профиля: tglib читает TG_PANEL_DIR при импорте


def say(*a):
    print(*a, file=sys.stderr, flush=True)


# сторож страны выхода пишет через tglib.say (stdout) — а stdout тут только JSON
tglib.say = say


def fail(msg):
    print(json.dumps({"state": "error", "error": msg}))
    sys.exit(2)


def read_session_key(path):
    import sqlite3
    db = sqlite3.connect(path)
    try:
        cols = [r[1] for r in db.execute("PRAGMA table_info(sessions)")]
        rows = db.execute("SELECT * FROM sessions").fetchall()
        for row in rows:
            rec = dict(zip(cols, row))
            key = rec.get("auth_key")
            if key and len(key) >= 256:
                return int(rec["dc_id"]), bytes(key), int(rec.get("user_id") or 0)
        raise SystemExit("в .session нет живого ключа")
    finally:
        db.close()


def panel_account(session, uid):
    """Аккаунт панели с этим ключом: тот же файл сессии или тот же user_id. None — чужой."""
    p = Path(session).expanduser().resolve() if session else None
    for a in tglib.load_accounts():
        if uid and str(a.get("user_id") or "") == str(uid):
            return a
        try:
            if p and tglib.session_path(a).resolve() == p:
                return a
        except Exception:
            continue
    return None


async def gate(acc, raw, label):
    """
    Прокси и страна выхода — ДО Telegram, как tglib.connect. Аккаунт панели
    идёт только через свой прокси (одна строка — один аккаунт); нет своего —
    через переданный. Возвращает (кого сторожит guard_exit, страна).
    """
    own = str((acc or {}).get("proxy") or "").strip()
    if acc and tglib.full_rest_left(acc) > 0:
        raise SystemExit(f"«{acc.get('title', acc['id'])}» на полном отдыхе после заморозки — к Telegram не подключаю")
    if own:
        if raw.strip() and raw.strip() != own:
            say("у аккаунта в панели свой прокси — иду через него, а не через переданный")
        g = acc
    else:
        # не свой прокси аккаунта — отметки «выход из X» в реестр не пишем (id нет)
        g = {"id": "", "title": (acc or {}).get("title") or label, "proxy": raw.strip()}
    _, country = await tglib.require_country(g)
    return g, country


async def main():
    if A.tdata:
        # ключ из tdata достаёт тот же tdata-read.py (opentele), офлайн
        here = Path(__file__).parent
        out = subprocess.run([sys.executable, str(here / "tdata-read.py"), A.tdata],
                             capture_output=True, text=True)
        if out.returncode != 0:
            raise SystemExit(out.stderr.strip() or "не прочитал tdata")
        acc0 = json.loads(out.stdout)["accounts"][0]
        dc, key, uid = acc0["dc_id"], bytes.fromhex(acc0["auth_key"]), acc0["user_id"]
    elif A.session:
        dc, key, uid = read_session_key(A.session)
    elif A.key and A.dc:
        dc, key, uid = A.dc, bytes.fromhex(A.key), A.user_id
    else:
        raise SystemExit("нужно --tdata, либо --session, либо --key + --dc")

    from telethon import TelegramClient
    from telethon.sessions import MemorySession
    from telethon.crypto import AuthKey

    sess = MemorySession()
    sess.set_dc(dc, tglib.DC_IP[dc], 443)
    sess.auth_key = AuthKey(key)

    raw = A.proxy or os.environ.get("TG_NATIVE_PROXY", "")
    acc = panel_account(A.session, uid)
    label = Path(A.tdata or A.session or f"dc{dc}").stem
    try:
        g, country = await gate(acc, raw, label)
        proxy = tglib.client_proxy(g)
        # аккаунт панели — с его api_id и отпечатком (как make_client), чужой —
        # публичный 2040 и десктоп: на нём жила tdata
        api_id, api_hash = tglib.api_for(acc) if acc else (tglib.DEFAULT_API_ID, tglib.DEFAULT_API_HASH)
        dev = tglib.device_for(acc) if acc else dict(tglib.DEVICE)
    except SystemExit as e:
        fail(str(e))
    say(f"dc{dc}, ключ {len(key)} байт, прокси {'да' if proxy else 'нет'}"
        + (f", аккаунт панели «{acc.get('title', acc.get('id'))}»" if acc else ""))
    client = TelegramClient(sess, api_id, api_hash, proxy=proxy,
                            connection_retries=2, timeout=20, **dev)
    if acc:
        client._tg_acc = {**acc, "proxy": g["proxy"]}     # трафик — в traffic.csv аккаунта
    try:
        await client.connect()
        if country:
            tglib.guard_exit(client, g, country)
        if await client.is_user_authorized():
            me = await client.get_me()
            name = " ".join(x for x in [me.first_name, me.last_name] if x) or ""
            print(json.dumps({"state": "ok", "user_id": me.id,
                              "name": name, "phone": me.phone,
                              "username": me.username}))
        else:
            print(json.dumps({"state": "dead"}))
    except (Exception, tglib.ExitDrift) as e:
        print(json.dumps({"state": "error", "error": f"{type(e).__name__}: {(str(e).splitlines() or [''])[0][:120]}"}))
        sys.exit(2)
    finally:
        await tglib.aclose(client)


asyncio.run(main())
