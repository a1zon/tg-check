#!/usr/bin/env python3
"""
Независимая проверка живости .session — напрямую через Telethon, минуя
Telegram Web. Нужна, чтобы отличить мёртвый ключ аккаунта от проблемы
в переносе сессии в браузер.

    python session-live.py <файл.session> [socks5://user:pass@host:port]

Печатает одну строку: authorized=True/False и, если получилось, кто это.
Прокси берётся тем же, что стоит у аккаунта в панели.
"""
import sys, asyncio
from urllib.parse import urlparse

if len(sys.argv) < 2:
    sys.exit("как пользоваться: python session-live.py <файл.session> [прокси]")

SESSION = sys.argv[1].removesuffix(".session")
PROXY = sys.argv[2] if len(sys.argv) > 2 else ""

# публичные тестовые api_id/hash Telegram Desktop — только чтобы установить
# соединение; на живость ключа они не влияют
API_ID, API_HASH = 2040, "b18441a1ff607e10a989891a5462e627"


def parse_proxy(raw):
    if not raw:
        return None
    u = urlparse(raw if "://" in raw else "socks5://" + raw)
    scheme = (u.scheme or "socks5").lower()
    kind = "socks5" if "socks5" in scheme else "socks4" if "socks4" in scheme else "http"
    return (kind, u.hostname, u.port, True, u.username, u.password) if u.username \
        else (kind, u.hostname, u.port)


async def main():
    from telethon import TelegramClient
    proxy = parse_proxy(PROXY)
    client = TelegramClient(SESSION, API_ID, API_HASH, proxy=proxy)
    try:
        await client.connect()
        ok = await client.is_user_authorized()
        if ok:
            me = await client.get_me()
            who = f"@{me.username}" if me.username else str(me.id)
            print(f"authorized=True  {who}  phone={me.phone}")
        else:
            print("authorized=False  ключ не зарегистрирован (мёртв или отозван)")
    except Exception as e:
        print(f"error  {type(e).__name__}: {str(e).splitlines()[0][:100]}")
        sys.exit(2)
    finally:
        await client.disconnect()


asyncio.run(main())
