#!/usr/bin/env python3
"""
Авто-дедуп выходных IP прокси — чтобы два аккаунта не выходили с одного адреса.

Зачем. У аккаунтов dedicated-порты Asocks. Когда пачка портов падает разом
(мёртвый мобильный бэкенд) и сторож/рука рефрешат их все сразу, часть из тонкого
KZ-пула хватает один и тот же текущий IP → дубли. Два аккаунта с одного IP
Telegram считает связкой. Сторож в панели держит порты ЖИВЫМИ (dead → refresh),
а этот скрипт держит их УНИКАЛЬНЫМИ: раз в N минут по cron ищет дубли и рефрешит
лишние, пока не разойдутся. При отсутствии дублей ничего не делает (тихо).

Деньги не тратит: refresh мобильного порта бесплатен (платим за трафик).

Свои строки Asocks (`…-pool-…-session-<метка>`, с 23.10 — у всех) — не порты:
refresh у них нет, а проверка через каждую стоит платного трафика. Их скрипт
пропускает (дубли таких строк разводит замена в самой панели) и, если других
не осталось, молча выходит, не трогая ни прокси, ни кабинет.

Запуск: cd /opt/tg-panel && venv-tg/bin/python dedup-proxies.py
cron:   */30 * * * * cd /opt/tg-panel && flock -n /tmp/dedup.lock venv-tg/bin/python dedup-proxies.py >> dedup.log 2>&1
"""
import json, re, subprocess, collections, urllib.request, time, sys, os
from datetime import datetime, timezone, timedelta

CODE = os.path.dirname(os.path.abspath(__file__))
# 2, не 4: больше 2 попыток за один прогон = холостая смена IP аккаунту, если
# тонкий KZ-пул держит один «ходовой» адрес (refresh возвращает тот же IP).
# Развести реальный дубль обычно хватает 1-2 попыток; залипший на популярном IP
# подождёт следующего cron — к тому времени пул чаще подкидывает другой адрес.
ROUNDS = 2
PROFILES = [("prod", "accounts.json"),
            ("vtoroy", "profiles/vtoroy/accounts.json")]


def log(msg):
    t = (datetime.now(timezone.utc) + timedelta(hours=5)).strftime("%d.%m %H:%M")
    print(f"{t} {msg}", flush=True)


def api_key():
    return str(json.load(open(os.path.join(CODE, "asocks.json")))["apiKey"]).strip()


def port_index(k):
    url = f"https://api.asocks.com/v2/proxy/ports?page=1&per_page=500&apiKey={k}"
    ps = json.loads(urllib.request.urlopen(url, timeout=30).read()).get("message", {}).get("proxies", [])
    return {p.get("login"): p["id"] for p in ps if p.get("login")}


def own_session(proxy):
    """Своя строка Asocks (логин …-session-<метка>): это не порт, refresh у неё нет."""
    m = re.match(r"\w+://([^:@/]+)", proxy or "")
    return bool(m) and "-session-" in m.group(1)


def exit_ip(proxy):
    # прокси — через окружение, а не аргументом: пароль не светится в списке
    # процессов; no_proxy убираем, иначе curl пошёл бы напрямую
    env = {k: v for k, v in os.environ.items() if k.lower() != "no_proxy"}
    env.update(http_proxy=proxy, https_proxy=proxy, HTTPS_PROXY=proxy, ALL_PROXY=proxy)
    try:
        out = subprocess.run(["curl", "-s", "--max-time", "18", "https://api.ipify.org"],
                             capture_output=True, text=True, timeout=24, env=env).stdout.strip()
        return out if re.match(r"\d+\.\d+\.\d+\.\d+$", out) else "DOWN"
    except Exception:
        return "DOWN"


def refresh(proxy, idmap, k):
    m = re.match(r"https?://([^:]+):", proxy)
    pid = idmap.get(m.group(1)) if m else None
    if not pid:
        return False
    try:
        urllib.request.urlopen(f"https://api.asocks.com/v2/proxy/refresh/{pid}?apiKey={k}", timeout=30).read()
        return True
    except Exception:
        return False


def main():
    prox = {}
    for prof, fn in PROFILES:
        path = os.path.join(CODE, fn)
        if not os.path.exists(path):
            continue
        for a in json.load(open(path)):
            # свои строки Asocks не трогаем: refresh у них нет — проба только жжёт трафик
            if a.get("proxy") and not own_session(a["proxy"]):
                prox[f"{prof}/{a['id']}"] = a["proxy"]
    if not prox:
        return 0          # рефрешить нечего — тихо, без кабинета и без проб
    try:
        k = api_key()
        idmap = port_index(k)
    except Exception as e:
        log(f"нет ключа/портов Asocks: {e}")
        return 1
    cur = {a: exit_ip(p) for a, p in prox.items()}
    acted = False
    for _ in range(ROUNDS):
        cnt = collections.Counter(v for v in cur.values() if v != "DOWN")
        dups = {ip for ip, c in cnt.items() if c > 1}
        if not dups:
            break
        acted = True
        # оставляем prod с меньшим номером, рефрешим остальных из группы
        seen, torefresh = set(), set()
        for a in sorted(cur, key=lambda x: (0 if x.startswith("prod/") else 1, x)):
            if cur[a] in dups:
                if cur[a] in seen:
                    torefresh.add(a)
                else:
                    seen.add(cur[a])
        for a in torefresh:
            refresh(prox[a], idmap, k)
        time.sleep(12)
        for a in torefresh:
            cur[a] = exit_ip(prox[a])
    cnt = collections.Counter(v for v in cur.values() if v != "DOWN")
    dups = [ip for ip, c in cnt.items() if c > 1]
    if acted or dups:
        log(f"дедуп: уникальных {len(set(v for v in cur.values() if v != 'DOWN'))}/{len(prox)}, "
            f"дубли {dups or 'нет'}, DOWN {sum(1 for v in cur.values() if v == 'DOWN')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
