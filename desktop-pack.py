#!/usr/bin/env python3
"""
Собирает ОДНУ папку tdata сразу с несколькими аккаунтами — чтобы открыть
Telegram Desktop и переключаться между ними прямо в приложении.

Telegram Desktop держит максимум 3 аккаунта в одной папке (kMaxAccounts),
поэтому больше трёх за раз не берём.

Важно: используется UseCurrentSession — тот же ключ, которым работает панель.
Новых авторизаций не создаётся, лишних «устройств» в Telegram не появляется.
Подключение идёт через прокси аккаунта, как и вся остальная работа.

    python desktop-pack.py --accounts a1,a2,a3 --out desktop/pack
"""
import asyncio
import shutil
import sys
from pathlib import Path

import tglib
from tglib import say

MAX = 3


async def main():
    ids = [x.strip() for x in str(tglib.arg("accounts", "")).split(",") if x.strip()]
    out = Path(tglib.arg("out", "desktop/pack"))
    if not out.is_absolute():
        out = tglib.DIR / out
    if not ids:
        raise SystemExit("нечего собирать: --accounts a1,a2")
    if len(ids) > MAX:
        say(f"Telegram Desktop держит максимум {MAX} аккаунта в одной папке — "
            f"беру первые {MAX} из {len(ids)}")
        ids = ids[:MAX]

    from opentele.td import TDesktop
    from opentele.api import UseCurrentSession

    base = None
    done, failed = [], []
    for acc_id in ids:
        acc = tglib.resolve(acc_id)
        title = acc.get("title") or acc_id
        if not tglib.has_session(acc):
            say(f"{title}: нет сессии — пропускаю")
            failed.append(title)
            continue
        say(f"{title}: беру ключ ({tglib.proxy_label(acc.get('proxy'))})…")
        try:
            client = tglib.make_client(acc)
            await client.connect()
            if not await client.is_user_authorized():
                say(f"{title}: сессия мертва — пропускаю")
                failed.append(title)
                await tglib.aclose(client)
                continue
            tdesk = await TDesktop.FromTelethon(client, flag=UseCurrentSession)
            await tglib.aclose(client)
        except Exception as e:
            say(f"{title}: не вышло — {type(e).__name__}: {str(e).splitlines()[0][:90]}")
            failed.append(title)
            continue

        if base is None:
            base = tdesk
        else:
            # Каждый аккаунт пришёл главным в своей папке, поэтому у всех index=0
            # и при сохранении они писались бы в один файл, затирая друг друга.
            # Выдаём свой номер и пересобираем имя файла: сеттер keyFile делает
            # это сам, из index. Ключ под общую папку перевыдаст _addSingleAccount.
            acct = tdesk.mainAccount
            acct.index = base.accountsCount
            acct.keyFile = acct.keyFile
            base._addSingleAccount(acct)
        done.append(title)
        say(f"{title}: добавлен ({len(done)}/{len(ids)})")

    if not base:
        raise SystemExit("ни одного аккаунта собрать не удалось")

    tdata = out / "tdata"
    if tdata.exists():
        shutil.rmtree(tdata)
    out.mkdir(parents=True, exist_ok=True)
    base.SaveTData(str(tdata))

    say(f"\nготово: {len(done)} аккаунт(ов) в одной папке — {', '.join(done)}")
    if failed:
        say(f"не попали: {', '.join(failed)}")
    say(f"папка: {out}")
    say("В Telegram Desktop переключение — по аватарке слева внизу.")


asyncio.run(main())
