#!/usr/bin/env python3
"""
Независимая проверка живости .session — напрямую через Telethon, минуя
Telegram Web. Нужна, чтобы отличить мёртвый ключ аккаунта от проблемы
в переносе сессии в браузер.

    python session-live.py <файл.session> [socks5://user:pass@host:port]

Печатает одну строку: authorized=True/False и, если получилось, кто это.

Сессия аккаунта панели (sessions/ основного профиля или profiles/<имя>) идёт
как в задачах: через СВОЙ прокси аккаунта, со своим api_id и отпечатком, и
страна выхода проверяется до подключения. Чужая сессия — только через прокси
из второго аргумента: без прокси не подключаемся (прямой выход нарочно —
TG_ALLOW_DIRECT=1).
"""
import asyncio
import os
import sys
from pathlib import Path

if len(sys.argv) < 2:
    sys.exit("как пользоваться: python session-live.py <файл.session> [прокси]")

SESSION = Path(sys.argv[1].removesuffix(".session") + ".session").expanduser()
PROXY = sys.argv[2] if len(sys.argv) > 2 else ""


def use_profile_of(session):
    """Сессия лежит в sessions/ профиля панели — читаем его реестр (TG_PANEL_DIR)."""
    code, d = Path(__file__).resolve().parent, session.resolve().parent.parent
    if (not os.environ.get("TG_PANEL_DIR") and session.resolve().parent.name == "sessions"
            and (d == code or d.parent == code / "profiles") and (d / "accounts.json").exists()):
        os.environ["TG_PANEL_DIR"] = str(d)


use_profile_of(SESSION)
import tglib  # noqa: E402 — после выбора профиля: tglib читает TG_PANEL_DIR при импорте


def panel_account(session):
    """Аккаунт панели с этим файлом сессии, None — сессия чужая."""
    p = session.resolve()
    for a in tglib.load_accounts():
        try:
            if tglib.session_path(a).resolve() == p:
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
            print("у аккаунта в панели свой прокси — иду через него, а не через переданный", file=sys.stderr)
        g = acc
    else:
        # не свой прокси аккаунта — отметки «выход из X» в реестр не пишем (id нет)
        g = {"id": "", "title": (acc or {}).get("title") or label, "proxy": raw.strip()}
    _, country = await tglib.require_country(g)
    return g, country


async def main():
    if not SESSION.exists():
        print(f"error  нет файла сессии {SESSION}")
        sys.exit(2)
    from telethon import TelegramClient
    acc = panel_account(SESSION)
    try:
        g, country = await gate(acc, PROXY, SESSION.stem)
        if acc:
            client = tglib.make_client({**acc, "proxy": g["proxy"]})
            client._tg_acc = {**acc, "proxy": g["proxy"]}     # трафик — в traffic.csv аккаунта
        else:
            client = TelegramClient(str(SESSION.with_suffix("")), tglib.DEFAULT_API_ID,
                                    tglib.DEFAULT_API_HASH, proxy=tglib.client_proxy(g),
                                    connection_retries=3, timeout=20, **tglib.DEVICE)
    except SystemExit as e:
        print(f"error  {e}")
        sys.exit(2)
    try:
        await client.connect()
        if country:
            tglib.guard_exit(client, g, country)
        ok = await client.is_user_authorized()
        if ok:
            me = await client.get_me()
            who = f"@{me.username}" if me.username else str(me.id)
            print(f"authorized=True  {who}  phone={me.phone}")
        else:
            print("authorized=False  ключ не зарегистрирован (мёртв или отозван)")
    except (Exception, tglib.ExitDrift) as e:
        print(f"error  {type(e).__name__}: {(str(e).splitlines() or [''])[0][:100]}")
        sys.exit(2)
    finally:
        await tglib.aclose(client)


asyncio.run(main())
