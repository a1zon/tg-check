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

Печатает JSON: {"state":"ok|dead|error", "user_id":..., "name":..., "phone":...}
Всё лишнее — в stderr.
"""
import sys, json, argparse, asyncio, subprocess
from pathlib import Path
from urllib.parse import urlparse

# боевые адреса дата-центров Telegram (нужны, чтобы поднять сессию из ключа)
DC_IP = {1: "149.154.175.53", 2: "149.154.167.51", 3: "149.154.175.100",
         4: "149.154.167.91", 5: "91.108.56.130"}
# api_id/hash Telegram Desktop — совпадают с устройством, на котором жила tdata
API_ID, API_HASH = 2040, "b18441a1ff607e10a989891a5462e627"


def say(*a):
    print(*a, file=sys.stderr)


def parse_proxy(raw):
    if not raw:
        return None
    u = urlparse(raw if "://" in raw else "socks5://" + raw)
    kind = "socks5" if "socks5" in (u.scheme or "") else \
           "socks4" if "socks4" in (u.scheme or "") else "http"
    return (kind, u.hostname, u.port, True, u.username, u.password) if u.username \
        else (kind, u.hostname, u.port)


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


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key"); ap.add_argument("--dc", type=int)
    ap.add_argument("--session"); ap.add_argument("--tdata")
    ap.add_argument("--proxy", default="")
    ap.add_argument("--user-id", type=int, default=0)
    a = ap.parse_args()

    if a.tdata:
        # ключ из tdata достаёт тот же tdata-read.py (opentele), офлайн
        here = Path(__file__).parent
        out = subprocess.run([sys.executable, str(here / "tdata-read.py"), a.tdata],
                             capture_output=True, text=True)
        if out.returncode != 0:
            raise SystemExit(out.stderr.strip() or "не прочитал tdata")
        acc0 = json.loads(out.stdout)["accounts"][0]
        dc, key, uid = acc0["dc_id"], bytes.fromhex(acc0["auth_key"]), acc0["user_id"]
    elif a.session:
        dc, key, uid = read_session_key(a.session)
    elif a.key and a.dc:
        dc, key, uid = a.dc, bytes.fromhex(a.key), a.user_id
    else:
        raise SystemExit("нужно --tdata, либо --session, либо --key + --dc")

    from telethon import TelegramClient
    from telethon.sessions import MemorySession
    from telethon.crypto import AuthKey

    sess = MemorySession()
    sess.set_dc(dc, DC_IP[dc], 443)
    sess.auth_key = AuthKey(key)

    proxy = parse_proxy(a.proxy)
    say(f"dc{dc}, ключ {len(key)} байт, прокси {'да' if proxy else 'нет'}")
    client = TelegramClient(sess, API_ID, API_HASH, proxy=proxy,
                            device_model="Desktop", system_version="Windows 10",
                            connection_retries=2, timeout=20)
    try:
        await client.connect()
        if await client.is_user_authorized():
            me = await client.get_me()
            name = " ".join(x for x in [me.first_name, me.last_name] if x) or ""
            print(json.dumps({"state": "ok", "user_id": me.id,
                              "name": name, "phone": me.phone,
                              "username": me.username}))
        else:
            print(json.dumps({"state": "dead"}))
    except Exception as e:
        print(json.dumps({"state": "error", "error": f"{type(e).__name__}: {str(e).splitlines()[0][:120]}"}))
        sys.exit(2)
    finally:
        await client.disconnect()


asyncio.run(main())
