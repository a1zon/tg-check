#!/usr/bin/env python3
"""
Общее для всех задач на Telethon: аккаунты, сессии, прокси, чтение баз.

Раньше вся работа шла через Telegram Web в Playwright — кликами по разметке.
Теперь то же самое делается родным каналом Telegram (MTProto): быстрее,
без браузера и без гадания по вёрстке. Реестр аккаунтов остался общий
(accounts.json), поэтому панель видит одни и те же аккаунты в обоих режимах.

Ключ авторизации у Telethon лежит в своём файле:  sessions/<id>.session
Папки профилей Chromium (tg-profile, accounts/<id>) не трогаем — они всё
ещё нужны старым скриптам на Playwright.
"""
import asyncio
import csv
import json
import logging
import sys
from datetime import datetime, timedelta
from pathlib import Path


DIR = Path(__file__).resolve().parent
ACCOUNTS = DIR / "accounts.json"
SESSIONS = DIR / "sessions"
NUMBERS = DIR / "numbers.csv"
RESULTS = DIR / "results.csv"
DRAFTS = DIR / "drafts.csv"
MESSAGE = DIR / "message.txt"
VOICE = DIR / "voice.ogg"          # голосовое для рассылки (ogg/opus)
VOICE_META = DIR / "voice.json"    # его имя и длительность

# api_id/hash Telegram Desktop: то же устройство, с которого сняты купленные
# tdata. Свои значения тут только навредят — Telegram увидит смену клиента.
API_ID, API_HASH = 2040, "b18441a1ff607e10a989891a5462e627"
DEVICE = dict(device_model="Desktop", system_version="Windows 10",
              app_version="4.9.9", lang_code="ru", system_lang_code="ru")

# боевые адреса дата-центров: нужны, когда сессию собираем из голого ключа
DC_IP = {1: "149.154.175.53", 2: "149.154.167.51", 3: "149.154.175.100",
         4: "149.154.167.91", 5: "91.108.56.130"}

RESULTS_HEAD = ["phone", "tg", "name", "username", "calls", "last_call", "checked_at", "by"]
DRAFTS_HEAD = ["phone", "account", "ok", "sent", "at"]


# ---------------------------------------------------------------- аккаунты

# Telethon сам пишет в лог каждую неудачную попытку соединения; в журнале
# панели это выглядит паникой на ровном месте — оставляем только настоящие
# ошибки, а причину недоступности объясняем своими словами (NO_NET).
logging.getLogger("telethon").setLevel(logging.ERROR)


def load_accounts():
    try:
        data = json.loads(ACCOUNTS.read_text("utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def save_accounts(lst):
    ACCOUNTS.write_text(json.dumps(lst, ensure_ascii=False, indent=2) + "\n", "utf-8")


def resolve(acc_id=""):
    """id -> запись аккаунта. Без id берём первый: запуск из терминала без --account."""
    lst = load_accounts()
    if not lst:
        raise SystemExit("нет ни одного аккаунта — заведи его в панели (шаг 1)")
    if not acc_id:
        return lst[0]
    for a in lst:
        if a.get("id") == acc_id:
            return a
    raise SystemExit(f"аккаунт «{acc_id}» не найден")


def session_path(acc) -> Path:
    """Файл сессии Telethon. Своё поле в реестре важнее умолчания."""
    SESSIONS.mkdir(exist_ok=True)
    raw = acc.get("session")
    if raw:
        p = Path(raw)
        return p if p.is_absolute() else DIR / p
    return SESSIONS / f"{acc['id']}.session"


def set_field(acc_id, **fields):
    """Правит запись аккаунта в реестре, не трогая остальные поля."""
    lst = load_accounts()
    for a in lst:
        if a.get("id") == acc_id:
            a.update(fields)
            save_accounts(lst)
            return True
    return False


def remember(acc, me):
    """
    Запоминает, кто на самом деле стоит за аккаунтом: имя, @ и телефон.
    Панель показывает это в списке — иначе после добавления видно только
    придуманное название, и понять, вошёл аккаунт или нет, нельзя.
    Переданный словарь обновляем тоже: вызывающий работает с ним дальше.
    """
    name = " ".join(x for x in [me.first_name, me.last_name] if x).strip()
    fields = {"authed": True, "name": name, "username": me.username or "",
              "phone": me.phone or "", "user_id": me.id}
    acc.update(fields)
    set_field(acc["id"], **fields)
    return name


def who(acc):
    """Аккаунт одной строкой: то, что видно и в панели, и в журнале."""
    parts = [acc.get("name") or "", f"@{acc['username']}" if acc.get("username") else "",
             f"+{str(acc['phone']).lstrip('+')}" if acc.get("phone") else ""]
    return " · ".join(p for p in parts if p) or str(acc.get("user_id") or "")


def has_session(acc) -> bool:
    return session_path(acc).exists()


# ------------------------------------------------------------------ прокси

def parse_proxy(raw):
    """
    Строка прокси -> кортеж для Telethon (python_socks).

    Понимаем всё, чем их обычно продают:
        1.2.3.4:8000                 (без схемы считаем socks5)
        1.2.3.4:8000:логин:пароль
        socks5://логин:пароль@1.2.3.4:1080
        http://логин:пароль@1.2.3.4:8000
    Пустая строка -> None: аккаунт ходит с вашего адреса.
    """
    s = str(raw or "").strip()
    if not s:
        return None
    scheme, rest = "socks5", s
    if "://" in s:
        scheme, rest = s.split("://", 1)
        scheme = scheme.lower()
    user = password = None
    if "@" in rest:
        cred, rest = rest.rsplit("@", 1)
        user, _, password = cred.partition(":")
    parts = rest.split(":")
    if len(parts) == 4:                       # host:port:user:pass
        host, port, user, password = parts
    elif len(parts) == 2:
        host, port = parts
    else:
        raise SystemExit(f"не разобрал прокси «{s}» — нужно host:port")
    if not host or not port.isdigit():
        raise SystemExit(f"не разобрал прокси «{s}» — нужно host:port")
    kind = "socks5" if "socks5" in scheme else "socks4" if "socks4" in scheme else "http"
    if user:
        return (kind, host, int(port), True, user, password or "")
    return (kind, host, int(port))


def proxy_label(raw):
    """Как показать прокси человеку: без пароля."""
    try:
        p = parse_proxy(raw)
    except SystemExit:
        return "прокси задан с ошибкой"
    if not p:
        return "прямой IP"
    who = f" ({p[4]}:***)" if len(p) > 4 else ""
    return f"{p[0]}://{p[1]}:{p[2]}{who}"


# ------------------------------------------------------------------ клиент

def make_client(acc, **kw):
    """Клиент Telethon для аккаунта: своя сессия, свой прокси, вид десктопа."""
    from telethon import TelegramClient
    path = session_path(acc)
    if not path.exists():
        raise SystemExit(
            f"у аккаунта «{acc.get('title', acc.get('id'))}» нет сессии Telethon.\n"
            f"Подключи её: python import-account.py --account {acc['id']} --session файл.session\n"
            f"или, если он уже входил в браузере: "
            f"python import-account.py --account {acc['id']} --from-profile")
    opts = dict(DEVICE)
    opts.update(kw)
    return TelegramClient(str(path.with_suffix("")), API_ID, API_HASH,
                          proxy=parse_proxy(acc.get("proxy")),
                          connection_retries=3, timeout=20, **opts)


NO_NET = ("не достучаться до Telegram по MTProto.\n"
          "Обычно это блокировка провайдера: включи VPN или пропиши аккаунту прокси,\n"
          "через который проходит Telegram (проверить: python proxy-check.py --account %s).")


async def aclose(client):
    """
    Отключение, глотающее ошибки уборки. На Python 3.13 Telethon 1.44 иногда
    падает на disconnect() («attempt to write a readonly database» при
    сохранении состояния) — это шаг уборки уже ПОСЛЕ вердикта, и он не должен
    ни ронять задачу, ни маскировать настоящую причину трейсбеком.
    """
    try:
        await client.disconnect()
    except Exception:
        pass


async def connect(acc, **kw):
    """
    Подключение с проверкой живости. Мёртвый ключ помечаем в реестре: панель
    покажет «нет входа», и аккаунт не пойдёт в работу молча.

    Отсутствие связи и мёртвый ключ — разные вещи, и путать их нельзя:
    из-за первого аккаунт нельзя записывать в нерабочие.
    """
    client = make_client(acc, **kw)
    try:
        await client.connect()
    except (OSError, asyncio.TimeoutError) as e:
        await aclose(client)
        raise SystemExit(f"{type(e).__name__}: " + NO_NET % acc["id"])
    if not await client.is_user_authorized():
        set_field(acc["id"], authed=False)
        await aclose(client)
        raise SystemExit(f"сессия «{acc.get('title', acc['id'])}» мертва или отозвана — подключи заново")
    remember(acc, await client.get_me())
    return client


# --------------------------------------------------------------------- CSV

def read_csv(path):
    """Список словарей. Нет файла — пустой список, как в старых скриптах."""
    p = Path(path)
    if not p.exists():
        return []
    with p.open(newline="", encoding="utf-8") as f:
        return [dict(r) for r in csv.DictReader(f) if any(v for v in r.values())]


def _csv_line(values):
    """Одна строка CSV как текст — чтобы записать её единым write()."""
    import io
    buf = io.StringIO()
    csv.writer(buf, lineterminator="\n").writerow(values)
    return buf.getvalue()


def ensure_head(path, head):
    """
    Заводит файл с шапкой, если его ещё нет. Вызывать ДО параллельной дозаписи:
    тогда сама дозапись шапкой не занимается и гонки за неё нет.
    """
    p = Path(path)
    if not p.exists() or p.stat().st_size == 0:
        p.write_text(_csv_line(head), "utf-8")


def append_row(path, row, head):
    """
    Дописывает строку. По одному файлу пишут сразу несколько процессов
    (проверка/рассылка идут параллельно), поэтому строку кладём ОДНИМ write()
    в режиме дозаписи: O_APPEND делает такую запись атомарной — строки не
    смешиваются, и файловый замок (который на этой связке ФС мог вставать
    намертво) не нужен. Шапку заводит ensure_head() до параллельного прогона;
    если файла всё же нет, первую строку предваряем шапкой в том же write().
    """
    p = Path(path)
    line = _csv_line(row)
    if not p.exists() or p.stat().st_size == 0:
        line = _csv_line(head) + line
    with p.open("a", encoding="utf-8") as f:
        f.write(line)


def ensure_results_head():
    """
    Колонка by (каким аккаунтом проверено) появилась вместе с мультиаккаунтом.
    У старого файла её нет — дописываем шапку, не теряя результатов.
    """
    if not RESULTS.exists():
        RESULTS.write_text(",".join(RESULTS_HEAD) + "\n", "utf-8")
        return
    raw = RESULTS.read_text("utf-8")
    first = raw.split("\n", 1)[0]
    if ",by" not in first:
        rest = raw.split("\n", 1)[1] if "\n" in raw else ""
        RESULTS.write_text(",".join(RESULTS_HEAD) + "\n" + rest, "utf-8")


def migrate_drafts_log():
    """
    Лог черновиков раньше был phone,ok,at — без аккаунта и без отметки отправки.
    Дописываем недостающие колонки, приписывая старые строки первому аккаунту.
    Возвращает число переведённых строк.
    """
    head = ",".join(DRAFTS_HEAD) + "\n"
    if not DRAFTS.exists():
        DRAFTS.write_text(head, "utf-8")
        return 0
    raw = DRAFTS.read_text("utf-8").strip()
    if not raw:
        DRAFTS.write_text(head, "utf-8")
        return 0
    lines = raw.split("\n")
    # переводим ТОЛЬКО ровно старую шапку: прогон по уже новому файлу
    # сдвинул бы колонки и стёр отметки времени
    if lines[0].strip() != "phone,ok,at":
        return 0
    first = (load_accounts() or [{}])[0].get("id", "")
    out = []
    for line in lines[1:]:
        if not line.strip():
            continue
        v = (line.split(",") + ["", "", ""])[:3]
        out.append(f"{v[0]},{first},{v[1]},,{v[2]}")
    DRAFTS.write_text(head + "\n".join(out) + ("\n" if out else ""), "utf-8")
    return len(out)


# ------------------------------------------------------------------- прочее

def voice_duration():
    """Длительность голосового в секундах — её пишет панель при загрузке."""
    try:
        return int(json.loads(VOICE_META.read_text("utf-8")).get("duration", 0))
    except Exception:
        return 0


def arg(name, default=None, argv=None):
    """--имя значение из командной строки."""
    argv = argv if argv is not None else sys.argv
    key = f"--{name}"
    return argv[argv.index(key) + 1] if key in argv and argv.index(key) + 1 < len(argv) else default


def flag(name, argv=None):
    argv = argv if argv is not None else sys.argv
    return f"--{name}" in argv


def say(*a):
    """Печать без буфера: панель читает вывод построчно, пока задача идёт."""
    print(*a, flush=True)


# Итог пачки — панели, а не человеку. Автопрогон по нему решает, звать ли этот
# аккаунт снова, дать ли отлежаться и сколько. В журнал строка не попадает.
STATE_MARK = "\u2301STATE"


def state(done=0, left=0, stop="", cooldown=0, note=""):
    """
    stop: "" — всё в порядке, можно звать снова;
          "flood"  — Telegram придержал аккаунт (PEER_FLOOD или долгая пауза);
          "quota"  — кончилась дневная квота на контакты;
          "errors" — подряд идут сбои, дальше давить бессмысленно.
    cooldown — сколько секунд аккаунту отдыхать, прежде чем пробовать снова.
    """
    print(f"{STATE_MARK} " + json.dumps(
        {"done": done, "left": left, "stop": stop,
         "cooldown": int(cooldown), "note": note}, ensure_ascii=False), flush=True)


def until_tomorrow():
    """Секунд до начала следующих суток: столько ждать после «квота кончилась»."""
    now = datetime.now()
    start = (now + timedelta(days=1)).replace(hour=0, minute=5, second=0, microsecond=0)
    return max(60, int((start - now).total_seconds()))


def tries_by_phone(rows, spent):
    """
    Сколько раз номер уже брали в работу без толку. Нужно автопрогону: без
    этого номер, который не выходит обработать (нет квоты, странная ошибка),
    возвращался бы в очередь вечно и крутил бы прогон на месте.
    spent — номера, с которыми всё уже решено: их не считаем.
    """
    n = {}
    for r in rows:
        phone = r.get("phone", "")
        if phone and phone not in spent:
            n[phone] = n.get(phone, 0) + 1
    return n
