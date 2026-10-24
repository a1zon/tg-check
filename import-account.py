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

Прокси — раньше всего: нет её — своя строка Asocks (proxy_buy.own_session),
потом страна выхода тем же гейтом, что у задач (tglib.require_country). Не
вышло — импорт стоп, сессия на диск не ложится. Строка нового ключа — первая
выдача, не смена IP. Один вход на ключ: повторный импорт того же ключа чужие
сеансы не сбрасывает.
"""
import asyncio
import hashlib
import json
import os
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


def session_key(path: Path):
    """Ключ из уже лежащей сессии, только чтением; None — нет или не прочитали."""
    try:
        db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    except Exception:
        return None
    try:
        for (key,) in db.execute("SELECT auth_key FROM sessions"):
            if key and len(key) >= 256:
                return bytes(key)
    except Exception:
        pass
    finally:
        db.close()
    return None


def key_holder(acc, key, dest: Path):
    """
    Кто ещё держит этот же ключ — в любом профиле, кроме самого аккаунта.
    Два клиента на одном ключе Telegram видит как AUTH_KEY_DUPLICATED и
    закрывает оба входа, поэтому такой импорт не делаем вовсе. (аккаунт, папка) или None.
    """
    import proxy_buy
    for d in proxy_buy.profile_dirs():
        for a in proxy_buy.accounts_of(d):
            if d == tglib.DIR and a.get("id") == acc["id"]:
                continue
            raw = a.get("session")
            p = Path(raw) if raw else Path("sessions") / f"{a.get('id')}.session"
            p = p if p.is_absolute() else d / p
            if p.exists() and p.resolve() != dest.resolve() and session_key(p) == key:
                return a, d
    return None


# Как продавцы называют поля устройства в своих .json — у каждого авторегера
# свой словарь, поэтому смотрим на все ходовые написания
DEV_KEYS = {
    "device_model": ("device_model", "device", "model"),
    "system_version": ("system_version", "sdk", "system", "os"),
    "app_version": ("app_version", "app", "version"),
    "lang_code": ("lang_code", "lang", "language"),
    "system_lang_code": ("system_lang_code", "system_lang"),
}


def device_from_json(path: Path):
    """
    Родные параметры устройства из .json, который идёт рядом с .session.

    Заходить купленной сессией под другим устройством нельзя: для Telegram
    это тот же аккаунт, внезапно сменивший телефон. Поэтому, если продавец
    приложил родные данные, берём их, а не придумываем свои.
    """
    try:
        raw = json.loads(path.read_text("utf-8"))
    except Exception:
        return {}
    if not isinstance(raw, dict):
        return {}
    out = {}
    for field, names in DEV_KEYS.items():
        for n in names:
            v = raw.get(n)
            if isinstance(v, (str, int)) and str(v).strip():
                out[field] = str(v).strip()
                break
    return out


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
    """Ключ из tdata — тем же tdata-read.py (opentele), офлайн. Скрипт — рядом
    с кодом: в папке второго профиля его нет."""
    out = subprocess.run([sys.executable, str(tglib.CODE / "tdata-read.py"), path],
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
    out = subprocess.run(["node", str(tglib.CODE / "profile-key.mjs"), "--account", acc_id],
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
        sess = unpack(Path(src_session).expanduser(), tmp)
        dc, key, uid = read_session_file(sess)
        kind = "session"
        # рядом с .session продавцы кладут .json с родными (десктопными) параметрами
        # устройства. На ДЕСКТОПНОМ api_id (2040) берём их как есть — так честнее.
        # В МОБИЛЬНОМ режиме (свой api_id) десктопный отпечаток продавца не годится
        # (рассинхрон «десктоп на телефоне») — пропускаем, Android поставит ensure_device.
        if not tglib.is_mobile(acc):
            for cand in (sess.with_suffix(".json"), *sorted(sess.parent.rglob("*.json"))):
                dev = device_from_json(cand) if cand.exists() else {}
                if dev.get("device_model"):
                    tglib.set_field(acc["id"], device=dev)
                    acc["device"] = dev
                    tglib.say(f"устройство из {cand.name}: {dev['device_model']} · "
                              f"{dev.get('system_version', '?')} · Telegram {dev.get('app_version', '?')}")
                    break
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
    # Один вход на аккаунт. Тот же ключ у этого же аккаунта — повторный импорт:
    # сессию не переписываем и чужие сеансы второй раз не сбрасываем (18.10 пачку
    # c-аккаунтов так входили по 3–4 раза за 50 минут, каждый раз с
    # ResetAuthorizations). Отпечаток ключа (importKey) — не сам ключ, а хэш.
    # Тот же ключ у ДРУГОГО аккаунта (любой профиль) — стоп.
    fp = hashlib.sha256(key).hexdigest()[:16]
    same_file = existed and session_key(dest) == key
    again = acc.get("importKey") == fp or (same_file and not acc.get("importKey"))
    other = key_holder(acc, key, dest)
    if other:
        a, d = other
        raise SystemExit(f"этот ключ уже подключён у «{a.get('title') or a.get('id')}» "
                         f"({a.get('id')}, профиль {'основной' if d == tglib.CODE else d.name}). Два клиента на одном "
                         "ключе Telegram видит как AUTH_KEY_DUPLICATED и закрывает оба — сначала убери сессию там")

    # Прокси ОБЯЗАТЕЛЬНА до входа и даже до записи сессии: без неё вход идёт с IP
    # сервера (не KZ), и Telegram сбрасывает KZ-сессию (так сжигаются аккаунты).
    # Нет прокси — своя строка Asocks, как кнопка «свой IP» в панели: регион
    # профиля, proxyOwn, запись в asocks-sessions.json. Задана заранее — проверяем
    # выход. Не вышло — стоп: сессия на диск не ложится, к Telegram не идём.
    import proxy_buy
    own = False
    if not acc.get("proxy") and os.environ.get("TG_ALLOW_DIRECT") == "1":
        say("прокси не задан, прямой выход нарочно (TG_ALLOW_DIRECT=1) — свою строку не выдаю")
    elif not acc.get("proxy"):
        say("прокси не задан — выдаю свою строку Asocks в регионе профиля…")
        # новый ключ — первая выдача, в предел смен IP за сутки не идёт; тот же
        # ключ без прокси — для Telegram смена IP, в историю смен пишем
        s, got, region = proxy_buy.own_session(acc["id"], reason="импорт заново, прокси не было" if again else "")
        # в ЭТОТ же словарь: его берут require_country и make_client (client_proxy),
        # без строки в нём — отказ «не задан прокси»
        acc.update(proxy=s, proxyOwn=True, proxyPrev="")
        own = True
        city = f", {got['city']}" if got["city"] and got["city"] != region else ""
        say(f"свой IP {got['ip']} ({region}{city}, {got['org'] or got['country']})  ({tglib.proxy_label(s)})")

    # Страна выхода — тем же гейтом, что у всех задач (tglib.require_country), до
    # записи сессии и до клиента: без прокси, чужая или неузнанная страна — стоп
    # (чужую страну панель увидит по driftCountry). Проверка страны выключена
    # (TG_REQUIRE_COUNTRY=off) — заданный прокси хотя бы должен отвечать.
    try:
        tglib.parse_proxy(acc.get("proxy"))
    except SystemExit:
        # текст ошибки разбора — со строкой целиком, а в ней пароль: в журнал не пускаем
        raise SystemExit("прокси аккаунта записан с ошибкой (нужно host:port, схема://логин:пароль@host:port "
                         "или host:port:логин:пароль) — к Telegram не подключаю. Поправь прокси и повтори импорт") from None
    ip, c = await tglib.require_country(acc)
    if c:
        say(f"прокси отвечает: выход {ip or '?'} ({c})")
    elif acc.get("proxy") and not own:
        ip, c = proxy_buy.check_given(acc["proxy"])
        say(f"прокси отвечает: выход {ip} ({c or '?'}), страну не сверяю (TG_REQUIRE_COUNTRY=off)")

    if not same_file:
        write_session(dest, dc, key)

    # проверяем живьём: сессия засчитывается, только если Telegram ответил
    from telethon.errors.common import AuthKeyNotFound

    tglib.quiet_telethon()
    tglib.ensure_device(acc)   # свой отпечаток ДО входа (если не из JSON продавца)
    client = tglib.make_client(acc)
    try:
        try:
            await client.connect()
        except AuthKeyNotFound:
            # Telegram отвечает «такого ключа не знаю»: сессия мертва, отозвана
            # в «Устройствах» или аккаунт забанен. Это НЕ повод показывать
            # трейсбек и уж тем более не повод оставлять мёртвый файл — иначе
            # панель считает аккаунт подключённым, а войти им нельзя.
            dest.unlink(missing_ok=True)
            tglib.set_field(acc["id"], authed=False)
            raise SystemExit(
                "Telegram не знает этот ключ — сессия мертва.\n"
                "Так бывает, если её отозвали в «Устройствах», аккаунт забанен "
                "или файл уже использовали в другом софте.")
        except (OSError, asyncio.TimeoutError) as e:
            # связи нет — про ключ ничего не известно. Непроверенную сессию
            # не оставляем: панель показала бы аккаунт рабочим. Файл-источник
            # никуда не делся, попробуешь снова, когда появится связь.
            if not existed:
                dest.unlink(missing_ok=True)
            raise SystemExit(f"{type(e).__name__}: " + tglib.NO_NET % acc["id"])
        except Exception as e:
            # что угодно ещё: без объяснения оставлять нельзя, и мёртвую
            # сессию на диске — тоже
            if not existed:
                dest.unlink(missing_ok=True)
            raise SystemExit(f"не вышло подключить сессию — "
                             f"{type(e).__name__}: {str(e).splitlines()[0][:120]}")
        if not await client.is_user_authorized():
            dest.unlink(missing_ok=True)
            tglib.set_field(acc["id"], authed=False)
            raise SystemExit("Telegram не принял ключ: сессия мертва или отозвана")
        me = await client.get_me()
        name = tglib.remember(acc, me)
        if again:
            say("этот ключ уже подключали — чужие сеансы второй раз не сбрасываю (один вход на аккаунт)")
        elif os.environ.get("TG_KEEP_OTHER_SESSIONS") == "1":
            say("чужие сеансы не трогаю (TG_KEEP_OTHER_SESSIONS=1)")
        else:
            await tglib.harden_account(client, acc)   # завершить чужие сеансы — один раз на ключ
    finally:
        await tglib.aclose(client)

    if not again:
        # ключ этому id впервые — его IP первый: история смен под id (прежнего
        # хозяина id или выдачи до входа) в предел смен в сутки идти не должна
        try:
            if proxy_buy.first_assignment(acc["id"]):
                say("история смен IP под этим id снята: для нового аккаунта это первый адрес")
        except Exception as e:
            say(f"⚠ историю смен IP не снял ({type(e).__name__}) — панель посчитает её в предел смен")

    fields = {"session": str(dest.relative_to(tglib.DIR)), "importKey": fp}
    # имя по умолчанию («Аккаунт 2») заменяем на настоящее — так в панели
    # видно, кто есть кто; заданное человеком имя не трогаем
    if str(acc.get("title", "")).strip().lower().startswith("аккаунт"):
        fields["title"] = name or (f"@{me.username}" if me.username else me.phone or acc["title"])
    tglib.set_field(acc["id"], **fields)

    who = f"@{me.username}" if me.username else str(me.id)
    say(f"✓ подключено: {name or who}  {me.phone or ''}  ({who})")
    say(f"сессия: {dest.relative_to(tglib.DIR)}")


asyncio.run(main())
