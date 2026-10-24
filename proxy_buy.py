#!/usr/bin/env python3
"""
Прокси новому аккаунту через Asocks API — до первого входа в Telegram.

Нужно, чтобы импорт НИКОГДА не входил без прокси: вход при импорте идёт сразу в
Telegram, и с IP сервера (не KZ) KZ-сессия сбрасывается. Поэтому если у аккаунта
прокси не задан, import-account.py вызывает own_session() и ставит СВОЮ строку
Asocks ДО подключения — ту же, что раздаёт панель (server/ownproxy.mjs): регион
из списка профиля, proxyOwn, запись в asocks-sessions.json. Дальше такую строку
сторожит и при смерти сама меняет панель — режим один на всех.

asocks-sessions.json пишут оба (панель и импорт): перечитываем перед записью,
свои временные файлы, верхние ключи не теряем. Строка нового аккаунта — первая
выдача, в историю смен IP (changes, предел смен в сутки) она не идёт.

buy_dedicated() — прежняя покупка dedicated-порта (Almaty/Astana мимо регионов
профиля и мимо своих строк). Импорт её больше не зовёт, оставлена на ручной случай.

Ключ API — asocks.json рядом с кодом (у второго профиля своей копии нет),
запасной путь — папка данных профиля.
"""
import base64
import contextlib
import json
import os
import re
import secrets
import socket
import subprocess
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import tglib

API = "https://api.asocks.com/v2"


def _key():
    for d in (tglib.CODE, tglib.DIR):
        f = d / "asocks.json"
        if f.exists():
            return str(json.loads(f.read_text("utf-8"))["apiKey"]).strip()
    raise SystemExit("нет ключа Asocks: asocks.json не нашёлся ни рядом с кодом, ни в папке профиля")


def _req(ep, method="GET", body=None):
    k = _key()
    r = urllib.request.Request(
        f"{API}/{ep}{'&' if '?' in ep else '?'}apiKey={k}",
        data=json.dumps(body).encode() if body else None,
        headers={"Content-Type": "application/json"} if body else {}, method=method)
    return json.load(urllib.request.urlopen(r, timeout=40))


def _proxy_url(raw):
    """Строка прокси как URL для curl: «host:port:логин:пароль» тоже понимаем."""
    p = tglib.parse_proxy(raw)
    if not p:
        return ""
    cred = f"{p[4]}:{p[5]}@" if len(p) > 4 and p[4] else ""
    return f"{p[0]}://{cred}{p[1]}:{p[2]}"


def _curl(proxy, url, m):
    # Прокси — переменными окружения, не аргументом: аргументы процесса видны
    # в ps всем, а в строке логин и пароль. Без прокси не ходим вовсе — это был
    # бы IP сервера.
    try:
        px = _proxy_url(proxy)
    except SystemExit:
        return ""
    if not px:
        return ""
    env = {k: v for k, v in os.environ.items() if k.lower() != "no_proxy"}
    env.update(http_proxy=px, https_proxy=px, HTTPS_PROXY=px, ALL_PROXY=px, all_proxy=px)
    try:
        return subprocess.run(["curl", "-s", "-m", str(m), url], env=env,
                              capture_output=True, text=True, timeout=m + 5).stdout.strip()
    except Exception:
        return ""


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


def check_given(raw):
    """Прокси, заданный заранее, тоже проверяем до входа: молчит или выходит не из
    той страны — не подключаемся (Telegram увидел бы вход из-за границы, а
    неизвестная страна — то же самое, только вслепую). Страна — TG_REQUIRE_COUNTRY,
    как у tglib.require_country; off — лишь бы отвечал. Возвращает (ip, страна).
    Импорт страну проверяет самим require_country, сюда — только при off."""
    need = tglib.need_country()
    ip, c = _exit_ip(raw, m=15)
    if not ip:
        raise SystemExit("прокси аккаунта не отвечает — к Telegram не подключаю. "
                         "Почини или смени прокси и повтори импорт")
    if need and c != need:
        raise SystemExit(f"прокси аккаунта выходит из {c or 'неизвестной страны'}, а не из {need} — "
                         "к Telegram не подключаю (вход из-за границы Telegram считает угоном). "
                         "Смени IP и повтори импорт")
    return ip, c


# ------------------------------------------- своя строка Asocks (как ownproxy.mjs)

GATEWAY = "190.2.137.56:9999"          # до Telegram доходит только этот шлюз
TG_DC = "149.154.167.51:443"           # DC2: прокси должен пускать к нему (MTProto)
# запасной список, если панель не передала регионы профиля (TG_ASOCKS_REGIONS);
# тот же, что KZ_REGIONS в server/ownproxy.mjs
KZ_REGIONS = ["Almaty", "Shymkent", "Karaganda", "Pavlodar Region", "Qostanay Oblysy",
              "Atyrau Oblysy", "Aktyubinskaya Oblast'", "North Kazakhstan", "Zhambyl Oblysy",
              "Mangistauskaya Oblast'", "Qyzylorda Oblysy", "Abai Region"]
ESCAPE_TRIES = 3                       # свой регион не дал IP — по 3 строки в соседних
ESCAPE_REGIONS = 3                     # и не больше трёх соседних
BASE_TTL = 24 * 3600 * 1000            # логин/пароль/регионы кабинета — раз в сутки (мс, как у Node)
CHANGES_KEEP = 7 * 864e5               # история смен IP: неделя и не больше 20 записей — как у Node
CHANGES_MAX = 20


def _dormant(a):
    """Замороженный или выведенный — как ownDormant в server/ownproxy.mjs: его IP
    занятым не считаем и в загрузку регионов не пишем (к Telegram он почти не ходит)."""
    return a.get("spamKind") == "frozen" or bool(a.get("retired"))


def profile_dirs():
    """Папки данных всех профилей: основной (папка кода) и profiles/* — как
    otherProfilesProxies в admin.mjs. Свой профиль тоже в списке."""
    out = []
    for d in (tglib.CODE, *sorted((tglib.CODE / "profiles").glob("*")), tglib.DIR):
        d = d.resolve()
        if d not in out and (d / "accounts.json").exists():
            out.append(d)
    return out


def accounts_of(d):
    try:
        lst = json.loads((d / "accounts.json").read_text("utf-8"))
        return lst if isinstance(lst, list) else []
    except Exception:
        return []


def _sessions(d):
    try:
        x = json.loads((d / "asocks-sessions.json").read_text("utf-8"))
        return x if isinstance(x, dict) else {}
    except Exception:
        return {}


def _stamp(f):
    """Отпечаток файла (inode, mtime, размер); None — файла нет."""
    try:
        s = f.stat()
    except FileNotFoundError:
        return None
    return s.st_ino, s.st_mtime_ns, s.st_size


def _update_sessions(fn, tries=5):
    """
    Правка asocks-sessions.json профиля. Тот же файл пишет панель
    (server/ownproxy.mjs, её временный файл — .tmp.<pid>), поэтому:
      • перечитываем прямо перед записью, fn правит только свой ключ — base,
        assigned, changes и всё прочее на верхнем уровне остаётся как было;
      • пишем во СВОЙ временный файл (.tmp.py<pid>) и os.replace;
      • файл сменился, пока готовили запись (панель успела записать), —
        перечитываем и правим заново, а не затираем её запись.
    Файл есть, но не разбирается — не пишем вовсе: иначе одним своим ключом
    затёрли бы всё остальное. Внутри пароль кабинета — права 600, как у Node.
    Возвращает, записали ли.
    """
    f = tglib.DIR / "asocks-sessions.json"
    tmp = f.with_name(f"{f.name}.tmp.py{os.getpid()}")
    for _ in range(tries):
        st = _stamp(f)
        try:
            d = json.loads(f.read_text("utf-8")) if st and st[2] else {}
        except FileNotFoundError:
            continue
        except Exception:
            d = None
        if not isinstance(d, dict):
            tglib.say("⚠ asocks-sessions.json не разобрать — запись выдачи пропускаю, файл не трогаю")
            return False
        fn(d)
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as w:
                w.write(json.dumps(d, ensure_ascii=False, indent=1) + "\n")
                w.flush()
                os.fsync(w.fileno())
            if _stamp(f) != st:
                continue
            os.replace(tmp, f)
            return True
        finally:
            with contextlib.suppress(OSError):
                tmp.unlink()
    tglib.say("⚠ asocks-sessions.json всё время меняется — запись выдачи пропускаю")
    return False


def _push_change(d, acc_id, ip, region, why):
    """Строка в историю смен IP (changes) — в том же виде, что пишет панель."""
    old = time.time() * 1000 - CHANGES_KEEP
    hist = [x for x in ((d.get("changes") or {}).get(acc_id) or [])
            if isinstance(x, dict) and _ms(x.get("at")) > old]
    hist.append({"at": tglib.now_iso(), "ip": ip, "region": region, "why": str(why)[:80]})
    d["changes"] = {**(d.get("changes") or {}), acc_id: hist[-CHANGES_MAX:]}


def _ms(iso):
    """ISO-время (как пишет Node) в мс; не разобрали — 0."""
    from datetime import datetime
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp() * 1000
    except Exception:
        return 0


def first_assignment(acc_id):
    """
    Новый аккаунт (ключ этому id впервые): его строка — первая выдача, а не
    смена IP. История смен (changes) под этим id — от прежнего хозяина id или
    от выдачи до первого входа, когда Telegram этот IP ещё не видел; по ней
    панель держит предел смен в сутки (OWN_DAY_MAX), и новый аккаунт упёрся бы
    в чужой счёт. Снимаем её. Возвращает, было ли что снимать.
    """
    if acc_id not in (_sessions(tglib.DIR).get("changes") or {}):
        return False

    def drop(d):
        ch = d.get("changes")
        if isinstance(ch, dict) and acc_id in ch:
            d["changes"] = {k: v for k, v in ch.items() if k != acc_id}
    return _update_sessions(drop)


def _api(ep):
    j = _req(ep)
    if isinstance(j, dict) and j.get("success") is False:
        raise SystemExit(f"Asocks: {j.get('message') or 'отказ'}")
    return j


def _session_base(country):
    """Основа своих строк (как sessionBase в server/asocks.mjs): логин кабинета
    (часть до «-pool»), пароль и порт — из шаблона любого -pool- порта, id
    регионов — из справочника. Кэш общий с панелью: base[страна] в asocks-sessions.json."""
    b = (_sessions(tglib.DIR).get("base") or {}).get(country)
    if (isinstance(b, dict) and b.get("states") and b.get("user") and b.get("password")
            and time.time() * 1000 - (b.get("at") or 0) < BASE_TTL):
        return b
    pr = _api("proxy/ports")
    pr = pr if isinstance(pr, dict) else {}
    tpl = next((x.get("template") for x in ((pr.get("message") or {}).get("proxies") or [])
                if isinstance(x, dict) and re.search(r"-pool-", x.get("template") or "")), None)
    m = tpl and re.match(r"^\w+://([^:]+?)-pool[^:]*:([^@]+)@[^:]+:(\d+)", tpl)
    if not m:
        raise SystemExit("в кабинете Asocks нет ни одного порта — не из чего собрать строку")
    cs = _api("dir/countries")
    lst = cs if isinstance(cs, list) else (cs.get("countries") or cs.get("message") or [])
    c = next((x for x in (lst if isinstance(lst, list) else [])
              if isinstance(x, dict) and str(x.get("code") or "").upper() == country), None)
    if not c:
        raise SystemExit(f"Asocks не знает страну {country}")
    st = _api(f"dir/states?countryId={c['id']}")
    sts = st if isinstance(st, list) else (st.get("states") or st.get("message") or [])
    fresh = {"user": m.group(1), "password": m.group(2), "port": m.group(3), "country": country,
             "states": [{"id": x["id"], "name": x["name"]} for x in sts
                        if isinstance(x, dict) and x.get("id") and x.get("name")],
             "at": int(time.time() * 1000)}
    _update_sessions(lambda d: d.__setitem__("base", {**(d.get("base") or {}), country: fresh}))
    return fresh


def _ipinfo(proxy, m=20):
    """Выход через прокси по ipinfo, как у панели: {ip, country, city, org} или {}."""
    try:
        j = json.loads(_curl(proxy, "http://ipinfo.io/json", m) or "{}")
    except Exception:
        return {}
    if not isinstance(j, dict) or not j.get("ip"):
        return {}
    return {"ip": j["ip"], "country": j.get("country") or "", "city": j.get("city") or "",
            "org": str(j.get("org") or "")[:40]}


def _reaches_telegram(raw, t=15):
    """Пускает ли шлюз к дата-центру Telegram: CONNECT до DC2, ответ 200. Только
    туннель — MTProto не шлём, вход в Telegram это не делает."""
    try:
        u = urllib.parse.urlsplit(raw)
        auth = ""
        if u.username:
            cred = f"{urllib.parse.unquote(u.username)}:{urllib.parse.unquote(u.password or '')}"
            auth = "Proxy-Authorization: Basic " + base64.b64encode(cred.encode()).decode() + "\r\n"
        with socket.create_connection((u.hostname, u.port or 80), timeout=t) as s:
            s.settimeout(t)
            s.sendall(f"CONNECT {TG_DC} HTTP/1.1\r\nHost: {TG_DC}\r\n{auth}\r\n".encode("latin1"))
            buf = b""
            while b"\r\n" not in buf and len(buf) < 4096:
                chunk = s.recv(1024)
                if not chunk:
                    break
                buf += chunk
        return bool(re.match(rb"^HTTP/1\.[01] 200", buf))
    except Exception:
        return False


def _check(raw, country):
    """Годится ли строка: ({ip, country, city, org}, "") или (None, почему). Страна
    строго нужная: неизвестную не пропускаем — это тот же вход вслепую."""
    a = _ipinfo(raw)
    if not a:
        return None, "не ответила"
    if a["country"] != country:
        return None, f"выход из {a['country'] or 'неизвестной страны'}, а не {country}"
    if _ipinfo(raw).get("ip") != a["ip"]:
        return None, "IP скачет между запросами"
    if not _reaches_telegram(raw):
        return None, "шлюз не пускает к Telegram"
    return a, ""


def taken_ips(skip_id=""):
    """Живые выходные IP всех прочих аккаунтов обоих профилей. Прокси пробуем
    параллельно с коротким таймаутом (одна строка у нескольких — проба одна);
    не ответил — берём IP из записи выдачи, запасом, как панель. Замороженных
    и выведенных не считаем — как панель (ownDormant)."""
    targets = {}                       # строка прокси -> IP из записи выдачи
    for d in profile_dirs():
        assigned = _sessions(d).get("assigned") or {}
        for a in accounts_of(d):
            if (d == tglib.DIR and a.get("id") == skip_id) or _dormant(a):
                continue
            p = str(a.get("proxy") or "").strip()
            if p:
                targets.setdefault(p, set()).add((assigned.get(a.get("id")) or {}).get("ip") or "")
    ips = set()
    with ThreadPoolExecutor(max_workers=16) as ex:
        for p, live in zip(targets, ex.map(lambda p: _ipinfo(p, m=8).get("ip", ""), targets)):
            if live:
                ips.add(live)
            else:
                ips.update(x for x in targets[p] if x)
    return ips


@contextlib.contextmanager
def _issue_lock(wait=15 * 60):
    """Одна выдача за раз на оба профиля: пачка импортов разом иначе видит одни
    и те же занятые IP и одну загрузку регионов — и берёт IP на двоих. flock
    снимается сам, если процесс упал."""
    try:
        import fcntl
    except ImportError:              # не Unix — без замка, как раньше
        yield
        return
    with open(tglib.CODE / ".own-proxy.lock", "a") as f:
        t0, said = time.time(), False
        while True:
            try:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if not said:
                    tglib.say("жду: другой импорт сейчас выдаёт свой IP")
                    said = True
                if time.time() - t0 > wait:
                    raise SystemExit("15 минут ждал очереди на выдачу IP — другой импорт завис; "
                                     "к Telegram не подключаю, повтори позже")
                time.sleep(2)
        yield


def own_session(acc_id, country="KZ", max_tries=6, reason=""):
    """
    Своя строка Asocks аккаунту, как ownProxy.assign в панели:
        <логин>-pool-mobile-country-KZ-state-<регион>-session-<метка>
    Регион — закреплённый за аккаунтом, если он в списке профиля, иначе самый
    свободный из TG_ASOCKS_REGIONS (по записям assigned профиля). Строка годится,
    если: два ответа ipinfo с одним IP и страной KZ, шлюз пускает CONNECT к
    Telegram, такого IP сейчас нет ни у кого в обоих профилях. До max_tries меток
    в своём регионе, потом по ESCAPE_TRIES в соседних. Подошла — пишем proxy +
    proxyOwn + proxyPrev="" и assigned[id]. Не подошла ни одна — SystemExit:
    подключаться без прокси нельзя. Возвращает (строка, {ip, country, city, org}, регион).

    reason пустой — это первая выдача новому аккаунту: в историю смен IP (changes)
    не пишем, в предел смен в сутки она не идёт. reason задан (тот же ключ, а
    прокси не было) — для Telegram это смена IP, пишем, как панель.
    """
    with _issue_lock():
        try:
            b = _session_base(country)
        except SystemExit:
            raise
        except Exception as e:
            raise SystemExit(f"Asocks не отдал основу для своей строки — {type(e).__name__}: "
                             f"{str(e).splitlines()[0][:120] if str(e) else ''}")
        by_name = {s["name"]: s for s in b["states"]}
        env = os.environ.get("TG_ASOCKS_REGIONS", "")
        regions = [s.strip() for s in env.split(",") if s.strip()] or KZ_REGIONS
        pool = [r for r in regions if r in by_name]
        if not pool:
            raise SystemExit(f"ни одного из регионов {', '.join(regions)} нет у Asocks для {country}")
        assigned = _sessions(tglib.DIR).get("assigned") or {}
        load = {r: 0 for r in pool}
        for a in tglib.load_accounts():
            r = (assigned.get(a.get("id")) or {}).get("region")
            if a.get("id") != acc_id and not _dormant(a) and r in load:
                load[r] += 1
        by_load = sorted(pool, key=lambda r: load[r])
        was = (assigned.get(acc_id) or {}).get("region")
        first = was if was in pool else by_load[0]
        order = ([first] + [r for r in by_load if r != first])[:1 + ESCAPE_REGIONS]
        used = taken_ips(acc_id)
        tglib.say(f"регион {first} (занято по профилю: " +
                  ", ".join(f"{r} {n}" for r, n in load.items()) + f"); занятых IP в обоих профилях {len(used)}")
        gw = os.environ.get("TG_ASOCKS_GATEWAY") or GATEWAY
        tries, why = 0, ""
        for k, r in enumerate(order):
            for _ in range(max_tries if k == 0 else ESCAPE_TRIES):
                tries += 1
                s = (f"http://{b['user']}-pool-mobile-country-{country}-state-{by_name[r]['id']}"
                     f"-session-{secrets.token_hex(4)}:{b['password']}@{gw}")
                got, why = _check(s, country)
                if got and got["ip"] in used:
                    got, why = None, "такой IP уже у другого аккаунта"
                if not got:
                    continue
                tglib.set_field(acc_id, proxy=s, proxyOwn=True, proxyPrev="")
                rec = {"session": urllib.parse.unquote(urllib.parse.urlsplit(s).username or ""),
                       "region": r, "ip": got["ip"], "city": got["city"], "org": got["org"],
                       "country": got["country"], "at": tglib.now_iso()}

                def put(d, r=r, ip=got["ip"]):
                    d["assigned"] = {**(d.get("assigned") or {}), acc_id: rec}
                    if reason:
                        _push_change(d, acc_id, ip, r, reason)
                # не записалось (файл не разобрать) — строка у аккаунта уже стоит,
                # панель лишь не знает её региона: возьмёт самый свободный
                _update_sessions(put)
                return s, got, r
        raise SystemExit(f"не нашёл аккаунту рабочий свободный {country}-IP: {tries} строк подряд не подошли "
                         f"({why}). Без прокси к Telegram не подключаю — повтори импорт позже")
