#!/usr/bin/env python3
"""
Авто-покупка своей dedicated-прокси для аккаунта через Asocks API.

Нужно, чтобы импорт НИКОГДА не входил без прокси: вход при импорте идёт сразу в
Telegram, и с IP сервера (не KZ) KZ-сессия сбрасывается. Поэтому если у аккаунта
прокси не задан, import-account.py вызывает buy_dedicated() и ставит свою
уникальную KZ-прокси ДО подключения.

Ключ API — в asocks.json рядом с данными (тот же, что у панели).
"""
import json
import subprocess
import time
import urllib.request

import tglib

API = "https://api.asocks.com/v2"


def _key():
    return str(json.loads((tglib.DIR / "asocks.json").read_text("utf-8"))["apiKey"]).strip()


def _req(ep, method="GET", body=None):
    k = _key()
    r = urllib.request.Request(
        f"{API}/{ep}{'&' if '?' in ep else '?'}apiKey={k}",
        data=json.dumps(body).encode() if body else None,
        headers={"Content-Type": "application/json"} if body else {}, method=method)
    return json.load(urllib.request.urlopen(r, timeout=40))


def _curl(proxy, url, m):
    return subprocess.run(["curl", "-s", "-m", str(m), "-x", proxy, url],
                          capture_output=True, text=True).stdout.strip()


def _exit_ip(proxy, m=25):
    """Выходной IP и страна (ISO-2) порта. Пробуем сервисы по очереди — один
    может лимитить запросами или лежать, тогда берём ответ у следующего. Так
    None уже не путается с «порт мёртв» (как было, когда один ipinfo лимитил)."""
    # ipinfo: country=ISO2
    try:
        d = json.loads(_curl(proxy, "http://ipinfo.io/json", m))
        if d.get("ip"):
            return d["ip"], d.get("country")
    except Exception:
        pass
    # ip-api: построчно query\ncountryCode (ISO2)
    p = _curl(proxy, "http://ip-api.com/line/?fields=query,countryCode", m).split()
    if len(p) >= 2 and p[0][:1].isdigit():
        return p[0], p[1]
    # ifconfig.co: country_iso=ISO2
    try:
        d = json.loads(_curl(proxy, "https://ifconfig.co/json", m))
        if d.get("ip"):
            return d["ip"], d.get("country_iso")
    except Exception:
        pass
    return None, None


def existing_ips():
    """Выходные IP аккаунтов, у кого уже есть прокси (best-effort, короткий таймаут) —
    чтобы не выдать новому аккаунту тот же IP."""
    ips = set()
    for a in tglib.load_accounts():
        p = a.get("proxy")
        if not p:
            continue
        ip, _ = _exit_ip(p, m=8)
        if ip:
            ips.add(ip)
    return ips


def buy_dedicated(avoid=frozenset(), city="Almaty", need=3, tries=6):
    """Создать свою dedicated мобильную KZ-прокси и отдать её, ТОЛЬКО убедившись,
    что порт СТАБИЛЕН: подряд `need` проб дают один и тот же KZ-IP. Порт, который
    оживает на секунду и тут же отваливается (бывает у Asocks — так сгорел n2
    18.10), так отсекается: раньше хватало одной удачной пробы. Город чередуем
    (Almaty/Astana) — если пул одного сейчас отдаёт мёртвые порты, берём у другого.
    IP не должен дублировать уже занятые (avoid). Неподошедшее удаляем. (строка, ip)."""
    avoid = set(avoid)
    cities = [city] + [c for c in ("Astana", "Almaty") if c != city]
    for attempt in range(tries):
        cty = cities[attempt % len(cities)]
        d = _req("proxy/create-port", "POST", {"name": "auto", "country_code": "KZ", "state": cty,
                 "proxy_type_id": 3, "type_id": 1, "server_port_type_id": 1})["data"]
        s = f"http://{d['login']}:{d['password']}@{d['server']}:{d['port']}"
        reads = []
        bad = False
        for i in range(10):           # порт живёт не сразу — поллинг с набором сходящихся проб
            time.sleep(12 if i == 0 else 6)
            ip, c = _exit_ip(s)
            if ip and c == "KZ":
                reads.append(ip)
                if len(reads) >= need:
                    break
            elif ip and c and c != "KZ":
                bad = True            # вышли не из KZ — сразу брак, не ждём
                break
        stable = len(reads) >= need and len(set(reads)) == 1
        if not bad and stable and reads[0] not in avoid:
            return s, reads[0]
        try:
            _req(f"proxy/delete-port?id={d['id']}", "DELETE")
        except Exception:
            pass
    raise SystemExit("не удалось купить СТАБИЛЬНУЮ уникальную KZ-прокси через Asocks — попробуй ещё раз")
