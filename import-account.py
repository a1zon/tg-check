#!/usr/bin/env python3
"""
Подключение аккаунта к Telethon готовой сессией: TDATA, .session или ключ.
QR не нужен — авторизация уже лежит в файле.

    python import-account.py --account a2 --session файл.session|.zip
    python import-account.py --account a2 --tdata папка|архив.zip
    python import-account.py --account a2 --key <hex> --dc 2 [--user-id 123]
    python import-account.py --account a1 --from-profile     # из браузерного профиля

Внутри и у TDATA, и у .session лежит одно и то же — ключ авторизации и номер
дата-центра. Разобрав их, складываем свою сессию в sessions/<id>.session.

Живость проверяется по-настоящему: подключение засчитывается, только когда
Telegram отдал данные аккаунта. Мёртвый ключ не сохраняем — иначе он тихо
осядет в реестре и потом гадай, почему аккаунт молчит.
"""
import asyncio
import json
import sqlite3
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

import tglib
from tglib import say


def read_session_file(path: Path):
    """
    Ключ из .session. Формат внутри бывает двух видов, оба читаем:
      Telethon:  sessions(dc_id, server_address, port, auth_key, takeout_id)
      Pyrogram:  sessions(dc_id, api_id, test_mode, auth_key, date, user_id, is_bot)
    """
    db = sqlite3.connect(path)
    try:
        cols = [r[1] for r in db.execute("PRAGMA table_info(sessions)")]
        for row in db.execute("SELECT * FROM sessions").fetchall():
            rec = dict(zip(cols, row))
            key = rec.get("auth_key")
            if key and len(key) >= 256:
                return int(rec["dc_id"]), bytes(key), int(rec.get("user_id") or 0)
        raise SystemExit("в .session нет живого ключа")
    finally:
        db.close()


def unpack(path: Path, tmp: Path):
    """.session часто продают в архиве вместе с .json — находим пару сами."""
    if path.is_file() and zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            z.extractall(tmp)
        path = tmp
    if path.is_file():
        return path
    found = sorted(path.rglob("*.session"))
    if not found:
        raise SystemExit("в архиве нет файла .session")
    return found[0]


def read_tdata(path: str):
    """Ключ из tdata — тем же tdata-read.py (opentele), офлайн."""
    out = subprocess.run([sys.executable, str(tglib.DIR / "tdata-read.py"), path],
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(out.stderr.strip() or "не прочитал tdata")
    a = json.loads(out.stdout)["accounts"][0]
    return int(a["dc_id"]), bytes.fromhex(a["auth_key"]), int(a["user_id"] or 0)


def read_profile(acc_id: str):
    """
    Ключ из браузерного профиля: аккаунт, который уже вошёл через Telegram Web,
    не нужно подключать заново — ключ там тот же самый, лежит в localStorage.
    Достаёт его profile-key.mjs (Playwright уже стоит для старых скриптов).
    """
    out = subprocess.run(["node", str(tglib.DIR / "profile-key.mjs"), "--account", acc_id],
                         capture_output=True, text=True, cwd=tglib.DIR)
    if out.returncode != 0:
        raise SystemExit((out.stderr.strip() or out.stdout.strip() or
                          "не прочитал профиль браузера").splitlines()[-1])
    d = json.loads(out.stdout.strip().splitlines()[-1])
    return int(d["dcId"]), bytes.fromhex(d["authKey"]), int(d.get("userId") or 0)


def write_session(dest: Path, dc: int, key: bytes):
    from telethon.crypto import AuthKey
    from telethon.sessions import SQLiteSession
    if len(key) != 256:
        raise SystemExit(f"ключ авторизации должен быть 256 байт, а тут {len(key)}")
    if dc not in tglib.DC_IP:
        raise SystemExit(f"номер дата-центра должен быть от 1 до 5, а пришёл «{dc}»")
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()
    s = SQLiteSession(str(dest.with_suffix("")))
    s.set_dc(dc, tglib.DC_IP[dc], 443)
    s.auth_key = AuthKey(key)
    s.save()
    s.close()


async def main():
    acc_id = tglib.arg("account", "")
    acc = tglib.resolve(acc_id)
    src_session = tglib.arg("session")
    src_tdata = tglib.arg("tdata")
    src_key = tglib.arg("key")

    tmp = Path(tempfile.mkdtemp(prefix="import-"))
    if src_tdata:
        dc, key, uid = read_tdata(src_tdata)
        kind = "TDATA"
    elif src_session:
        dc, key, uid = read_session_file(unpack(Path(src_session).expanduser(), tmp))
        kind = "session"
    elif src_key:
        dc, key, uid = int(tglib.arg("dc", 0)), bytes.fromhex(src_key), int(tglib.arg("user-id", 0))
        kind = "ключ"
    elif tglib.flag("from-profile"):
        dc, key, uid = read_profile(acc["id"])
        kind = "браузерный профиль"
    else:
        raise SystemExit("нужно --session, --tdata, --key + --dc или --from-profile")

    say(f"аккаунт: {acc['title']}  |  {tglib.proxy_label(acc.get('proxy'))}")
    say(f"источник: {kind}, dc{dc}, ключ {len(key)} байт" + (f", user_id {uid}" if uid else ""))

    dest = tglib.session_path(acc)
    existed = dest.exists()
    write_session(dest, dc, key)

    # проверяем живьём: сессия засчитывается, только если Telegram ответил
    client = tglib.make_client(acc)
    try:
        try:
            await client.connect()
        except (OSError, asyncio.TimeoutError) as e:
            # связи нет — про ключ ничего не известно. Непроверенную сессию
            # не оставляем: панель показала бы аккаунт рабочим. Файл-источник
            # никуда не делся, попробуешь снова, когда появится связь.
            if not existed:
                dest.unlink(missing_ok=True)
            raise SystemExit(f"{type(e).__name__}: " + tglib.NO_NET % acc["id"])
        if not await client.is_user_authorized():
            dest.unlink(missing_ok=True)
            tglib.set_field(acc["id"], authed=False)
            raise SystemExit("Telegram не принял ключ: сессия мертва или отозвана")
        me = await client.get_me()
        name = tglib.remember(acc, me)
    finally:
        await tglib.aclose(client)

    fields = {"session": str(dest.relative_to(tglib.DIR))}
    # имя по умолчанию («Аккаунт 2») заменяем на настоящее — так в панели
    # видно, кто есть кто; заданное человеком имя не трогаем
    if str(acc.get("title", "")).strip().lower().startswith("аккаунт"):
        fields["title"] = name or (f"@{me.username}" if me.username else me.phone or acc["title"])
    tglib.set_field(acc["id"], **fields)

    who = f"@{me.username}" if me.username else str(me.id)
    say(f"✓ подключено: {name or who}  {me.phone or ''}  ({who})")
    say(f"сессия: {dest.relative_to(tglib.DIR)}")


asyncio.run(main())
