#!/usr/bin/env python3
"""
Прогрев поведением: аккаунт ведёт себя как живой человек, а не как свежий
номер, который сразу пошёл писать незнакомым.

За один запуск делается РОВНО ОДНО действие. Пачками нельзя: подписаться на
пять каналов одним вызовом — это ровно та картинка, по которой Telegram
раздаёт ограничения. Паузы между действиями держит панель, она же решает,
когда аккаунту пора сделать следующий шаг и когда уйти спать на пару часов.

Что умеет:
  подписаться на канал · почитать ленту и поставить реакцию · проголосовать
  в опросе · вступить в открытую группу · запустить бота, который потом сам
  шлёт уведомления · написать своему же аккаунту и ответить ему · завести
  себе @ник · спросить у @SpamBot, нет ли ограничений

Сколько чего в сутки — зависит от дня прогрева (см. PLAN). День считается
по дням с действием, а не по календарю (age_days), срок — по возрасту
аккаунта (eff_warm_days), ступени у каждого сдвинуты на 0–2 дня (warm_lag):
партия, купленная одним днём, не идёт в ногу. Предел на сегодня у каждого
аккаунта свой: он выбирается из вилки один раз в сутки и не скачет от
запуска к запуску. В предел идёт КАЖДАЯ попытка, удачная или нет
(done_today), а после FAIL_DAY отказов за день прогрев встаёт до завтра и
просит панель спросить SpamBot (fails_today). Первые сутки аккаунт не делает
НИЧЕГО — это отлёжка, её же соблюдает и рассылка.

Чего прогрев не делает никогда: не добавляет номера в контакты. Своим пишет
только в уже открытый диалог или по @нику из реестра (сверив id), поэтому
аккаунт без ника сам заводит его (do_nick). Покупные и защищённые (protected:
только acc.protect: true из списка хозяина, зрелость не в счёт) друг с другом
не переписываются. Первые CHANNELS_ONLY активных дней реакции — только в
каналах, не на сообщения людей в группах.

    python warmup-activity.py --account a1
    python warmup-activity.py --account a1 --what sub    # только подписка
"""
import asyncio
import hashlib
import json
import math
import random
import re
from datetime import datetime, timedelta, timezone

import comments
import tglib
from tglib import say

READ_MIN, READ_MAX = 5, 15        # сколько «читаем» пост, прежде чем реагировать
# Трафик (прокси платный за ГБ): живой человек листает 5–10 последних постов,
# а не 20, и в начале захода видит верх списка чатов, а не сотню диалогов.
HISTORY = 8                       # столько последних постов смотрим в канале
OWN_DIALOGS = 40                  # столько верхних диалогов смотрим, ища письма своих
DM_DIALOGS = 100                  # и столько — для переписки (было 200, см. do_dm)

# Возраст аккаунта в днях -> сколько ЧЕГО можно за сутки (вилка «от-до»).
# Числа намеренно скромные: прогрев нужен, чтобы аккаунт дожил до работы,
# а не чтобы быстрее отчитаться. Считаются попытки, а не удачи (done_today).
# dm — только свои по открытому диалогу или @нику, номера в контакты не
# добавляем ни на какой ступени. @ник (nick) — вне лестницы: раз в сутки, пока
# его нет (nick_due).
PLAN = [
    (1, {"sub": (1, 2), "chat": (0, 0), "react": (2, 3), "dm": (0, 0), "bot": (0, 1)}),
    (4, {"sub": (2, 3), "chat": (1, 2), "react": (3, 5), "dm": (2, 3), "bot": (1, 2)}),
    (7, {"sub": (4, 5), "chat": (3, 3), "react": (5, 7), "dm": (3, 5), "bot": (1, 2)}),
]
PLAN_DAYS = PLAN[-1][0]          # на сколько дней расписан образец выше

# ДОГРЕВ — для тех, кто прогрев уже прошёл.
#
# Прогрев нужен, чтобы довести новый аккаунт до рабочего объёма. Когда срок
# вышел, водить его по той же программе незачем: цель достигнута, а лишние
# действия — это лишние запросы через общий прокси и лишний риск. Но и замирать
# насовсем нельзя: аккаунт, который месяц ничего не делает и вдруг начинает
# писать незнакомым, выглядит ровно как купленный. Поэтому остаётся редкая
# фоновая жизнь — одно-два действия в сутки.
# одно-два действия: чтение с реакцией — самое безобидное, переписка со
# своими — самое человеческое. Подписок и групп тут уже не нужно.
TOP_UP = {"sub": (0, 0), "chat": (0, 0), "react": (1, 1), "dm": (0, 1), "bot": (0, 0)}

# ДОГРЕВ МЕЖДУ ПАЧКАМИ — для тех, кто сейчас в рассылке (панель зовёт с --between).
#
# TOP_UP выбирается к обеду, а вечером, пока аккаунт пишет людям, между
# порциями писем он по полчаса молчит — со стороны это «только холодные
# письма, больше ничего». Панель зовёт этот режим в глубоком сне между
# порциями: одно лёгкое действие на промежуток. Потолок суточный и включает
# утренний догрев (done_today считает всё за день), поэтому утро остаётся
# прежним, а вечером остаётся запас на два-три действия.
BETWEEN = {"sub": (0, 0), "chat": (0, 0), "react": (3, 4), "dm": (1, 2), "bot": (0, 0)}
BETWEEN_KINDS = ("react", "dm", "comment")   # подписки, группы и боты посреди рассылки ни к чему

# ДОГРЕВ ПОСЛЕ ЗАМОРОЗКИ — аккаунт «без рассылки» (sendHoldUntil): людям не
# пишет, а живёт как обычный человек — читает каналы и ставит реакции,
# переписывается со своими. Больше, чем TOP_UP (там 1–2 действия в сутки):
# ему надо заново набрать историю, но без новых подписок, групп и ботов —
# всё, что похоже на «накрутку» сразу после блокировки, ни к чему.
REWARM = {"sub": (0, 0), "chat": (0, 0), "react": (3, 5), "dm": (2, 3), "bot": (0, 0)}
REWARM_KINDS = ("react", "dm", "comment")  # комментарии — только тем, кого разрешили (comments.held_accounts)


def warm_days():
    """
    За сколько дней аккаунт выходит на полный объём. Срок задаётся в панели
    (вкладка «Прогрев») и лежит в warmup.json — тот же файл читает и панель.
    """
    try:
        n = int(json.loads((tglib.DIR / "warmup.json").read_text("utf-8")).get("warmDays") or 0)
    except Exception:
        return PLAN_DAYS
    return max(2, min(21, n)) if n else PLAN_DAYS


def plan_for(days):
    """
    Та же лестница, разложенная на выбранный срок. Сжали срок — ступени
    сходятся, и из двух на одном дне остаётся старшая: короткий прогрев
    значит «быстрее выходим на объём», а не «дважды топчемся на месте».
    """
    if days == PLAN_DAYS:
        return PLAN
    k = days / PLAN_DAYS
    out = {}
    for since, step in PLAN:
        day = max(1, min(days, round(since * k)))
        out[day] = step               # старшая ступень затирает младшую
    if days not in out:
        out[days] = PLAN[-1][1]
    first = min(out)
    if first > 1:                     # после отлёжки аккаунт работает сразу
        out[1] = out.pop(first)
    return sorted(out.items())


# Примерная дата регистрации по TG-id и длина прогрева по возрасту. Опоры и
# пороги — ТЕ ЖЕ, что в server/warmup.mjs (ID_ANCHORS, WARM_BY_AGE): панель по
# ним считает срок и выпускает из прогрева, а здесь по ним идут сами действия.
# Раньше WARM_BY_AGE до прогрева не доходил: панель писала «8 дней», а аккаунт
# грелся по общим 7. Правятся в паре.
ID_ANCHORS = [
    (200_000_000, "2017-06-01"), (800_000_000, "2020-10-01"),
    (1_500_000_000, "2022-02-01"), (2_500_000_000, "2022-10-01"),
    (4_000_000_000, "2023-06-01"), (5_500_000_000, "2023-12-01"),
    (6_500_000_000, "2024-03-01"), (7_300_000_000, "2024-07-01"),
    (8_200_000_000, "2025-01-01"), (8_600_000_000, "2025-06-01"),
    (9_200_000_000, "2025-12-01"),
]
WARM_BY_AGE = [(3, 12), (8, 10), (18, 8), (36, 7)]   # моложе N мес. -> столько дней
WARM_BY_AGE_OLD = 5                                   # старше последнего порога


def reg_date(user_id):
    """Примерная дата регистрации (секунды UTC) по TG-id, None — не понять. Как regDateFromId."""
    try:
        uid = float(user_id)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(uid) or uid <= 0:
        return None
    pts = [(x, datetime.fromisoformat(d).replace(tzinfo=timezone.utc).timestamp())
           for x, d in ID_ANCHORS]
    if uid <= pts[0][0]:
        return pts[0][1]
    for (x0, t0), (x1, t1) in zip(pts, pts[1:]):
        if uid <= x1:
            return t0 + (t1 - t0) * (uid - x0) / (x1 - x0)
    (x0, t0), (x1, t1) = pts[-2], pts[-1]     # за последней опорой — по наклону
    return t0 + (t1 - t0) * (uid - x0) / (x1 - x0)


def warm_days_for_age(user_id):
    """Срок прогрева по возрасту аккаунта, None — возраст не определить. Как warmDaysForAge."""
    d = reg_date(user_id)
    if d is None:
        return None
    months = (datetime.now(timezone.utc).timestamp() - d) / 2629800   # ≈30.44 суток
    for m, days in WARM_BY_AGE:
        if months < m:
            return days
    return WARM_BY_AGE_OLD


def mature(acc):
    """
    Зрелый аккаунт — уже в рассылке, выпущен из прогрева или пришёл поработавшим.
    Ему всё по-старому: день по календарю, общий срок, без сдвига ступеней и без
    своего часа начала — так же решает панель (server/warmup.mjs warm()), и
    объём у него прежний.
    """
    return (acc.get("graduated") is True or acc.get("role") == "send"
            or acc.get("prewarmed") is True)


def protected(acc):
    """
    Защищённый — старый аккаунт хозяина: только явный acc.protect: true (список
    хозяина, как isProtected в server/warmup.mjs). Зрелость сюда не входит:
    выпущенный из прогрева покупной (graduated) остаётся в кругу покупных, а не
    переходит к старым. Свежие защищённому не пишут, и он свежим не пишет:
    переписка связывает аккаунты, и заморозка партии новичков не должна тянуть
    за собой старые. Круги переписки — внутри своей группы (dm_peers).
    """
    return acc.get("protect") is True


def eff_warm_days(acc):
    """
    Срок прогрева ЭТОГО аккаунта — как effDays в server/warmup.mjs warm():
    ручной (acc.warmDays) главнее всего; зрелому — общий из warmup.json;
    остальным — по возрасту (свежий греем дольше), если его видно по id.
    """
    try:
        own = float(acc.get("warmDays") or 0)
    except (TypeError, ValueError):
        own = 0
    n = (own if own > 0 else warm_days() if mature(acc)
         else warm_days_for_age(acc.get("user_id")) or warm_days())
    return max(2, min(21, int(n + 0.5)))


LAG_MAX = 2     # на сколько активных дней самое большее сдвигаем ступени аккаунта


def warm_lag(acc):
    """
    РАЗНОС ПАРТИИ. Аккаунты, залитые одним импортом, шли по прогреву в ногу:
    18.10 вся партия в один и тот же час перешла к переписке и знакомству по
    номерам друг с другом — отпечаток фермы, и через сутки её морозили подряд
    (номера с тех пор прогрев не трогает вовсе, см. find_peer).
    Теперь у каждого ступени сдвинуты на 0–2 активных дня: первая переписка,
    группы и боты у партии расходятся на три дня. Сдвиг по хэшу id — не скачет
    между заходами. Та же формула в server/warmup.mjs (warmLag): панель по ней
    показывает срок и выпускает из прогрева. Зрелым — без сдвига.
    """
    if mature(acc):
        return 0
    h = hashlib.sha256(f"{acc['id']}:lag".encode()).hexdigest()
    return int(h[:8], 16) % (LAG_MAX + 1)


DAY_FROM = 8        # с какого часа по Екб панель вообще греет (admin.mjs LIVELY_FROM)
DAY_SPREAD = 150    # в пределах стольких минут после него у аккаунта свой час начала


def day_start(acc_id):
    """
    Когда у аккаунта сегодня начинается день (по Екб). Панель будит всех около
    8 утра, и партия разом шла к SpamBot и в первые действия. Свой час — у
    каждого аккаунта и на каждый день свой, но между заходами не скачет.
    """
    now = datetime.now(EKB)
    h = hashlib.sha256(f"{acc_id}:{now.date().isoformat()}:start".encode()).hexdigest()
    return (now.replace(hour=DAY_FROM, minute=0, second=0, microsecond=0)
            + timedelta(minutes=int(h[:8], 16) % (DAY_SPREAD + 1)))


KINDS = ("sub", "chat", "react", "dm", "bot", "comment")   # nick — вне лестницы, см. nick_due

# Кого зовём чаще. Чтение с реакцией — самое безобидное и самое «человеческое»,
# подписки и вступления реже. Переписку зовём чаще, чем раньше: разговор из
# одного сообщения в сутки — не разговор, собеседник ждёт ответа днями.
WEIGHT = {"react": 5, "sub": 2, "chat": 1, "dm": 3, "bot": 2, "comment": 3}

# Человеческие фразы для панели: что аккаунт делает сейчас / что сделал.
# Их показывает прогресс-бар — чтобы было видно живое действие, а не сухой лог.
DOING = {
    "sub": "подписывается на канал", "chat": "вступает в группу",
    "react": "читает ленту и ставит реакцию", "dm": "пишет своему аккаунту",
    "bot": "запускает бота", "spam": "спрашивает у SpamBot про лимиты",
    "comment": "читает чаты и отвечает по делу", "nick": "заводит себе @ник",
}
DONE = {
    "sub": "подписался на канал", "chat": "вступил в группу",
    "react": "почитал ленту, поставил реакцию", "dm": "написал своему аккаунту",
    "bot": "запустил бота", "spam": "проверил лимиты у SpamBot",
    "comment": "ответил в чате", "nick": "завёл себе @ник",
}


def now_iso():
    return tglib.now_iso()


def load_list():
    """
    Куда водим аккаунты. Рабочий файл — warm-list.json, его правит хозяин
    панели. Образец warm-list.default.json приезжает с кодом; если рабочего
    ещё нет, делаем его из образца. Дальше обновления кода рабочий файл не
    трогают — иначе правки на сервере затирались бы при каждой выгрузке.
    """
    if not tglib.WARM_LIST.exists() and tglib.WARM_LIST_DEFAULT.exists():
        tglib.WARM_LIST.write_text(tglib.WARM_LIST_DEFAULT.read_text("utf-8"), "utf-8")
        say(f"завёл {tglib.WARM_LIST.name} из образца — правь его, он твой")
    try:
        return json.loads(tglib.WARM_LIST.read_text("utf-8"))
    except Exception as e:
        raise SystemExit(f"не читается {tglib.WARM_LIST.name}: {e}")


EKB = timezone(timedelta(hours=5))   # «день» прогрева — по Екб, как в панели


def ekb_date(iso):
    """Дата по Екб (ГГГГ-ММ-ДД) из метки ISO; '' — если не разобрать."""
    try:
        t = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except Exception:
        return ""
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return t.astimezone(EKB).date().isoformat()


def age_days(acc, rows):
    """
    День прогрева. Отметку warmFrom ставит панель — возраст у прогрева и
    рассылки общий, и считаем его так же, как она (server/warmup.mjs warm()).

    Раньше день шёл по календарю от warmFrom. Партия 18.10 трое суток простояла
    (лёг прокси), а календарь шёл: на «4-й день» она, сделав по 2–4 действия,
    разом пошла переписываться и знакомиться по номерам — и замёрзла. Теперь
    пустой день прогрев не двигает: день — это число разных дат (по Екб), когда
    аккаунт правда что-то делал (действие прогрева, SpamBot не в счёт, или
    письмо), с начала текущего прогрева, плюс сегодняшняя — заход ради действия
    и идёт. Календарь — только потолок, отлёжка — ровно сутки по часам.
    Зрелому — по календарю, как было.
    """
    return active_days(acc, rows, calendar=mature(acc))


def active_days(acc, rows, calendar=False):
    """
    Активные дни с начала прогрева (см. age_days); calendar — просто по
    календарю. Без calendar — и у зрелого: «первые CHANNELS_ONLY активных
    дней» у выпущенного из прогрева не должны идти по календарю.
    """
    from_ = acc.get("warmFrom") or acc.get("added") or now_iso()
    try:
        started = datetime.fromisoformat(str(from_).replace("Z", "+00:00"))
    except Exception:
        return 0
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    cal = max(0, int((datetime.now(timezone.utc) - started).total_seconds() // 86400))
    if cal < 1 or calendar:
        return cal
    since, today = ekb_date(started.isoformat()), datetime.now(EKB).date().isoformat()
    dates = {ekb_date(r.get("at")) for r in rows
             if r.get("note") == "ok" and r.get("action") != "spam"}
    for path in tglib.ALL_DRAFTS:
        dates |= {ekb_date(r.get("at")) for r in tglib.read_csv(path)
                  if r.get("account") == acc["id"]
                  and (r.get("ok") == "true" or r.get("sent") == "true")}
    past = sum(1 for d in dates if d and since <= d < today)
    return min(cal, past + 1)


def caps(acc_id, day, between=False, rewarm=False, lively=False, days=None):
    """
    Предел на сегодня по каждому виду действий. Из вилки выбираем одно число
    на сутки — но так, чтобы оно не менялось между запусками: иначе аккаунт
    то «уже всё сделал», то «ещё может», и лимит перестаёт быть лимитом.
    day — день по ступеням (со сдвигом warm_lag), days — срок этого аккаунта.
    """
    days = days or warm_days()
    if rewarm:
        step = REWARM            # после заморозки — свой режим, при любом возрасте
    elif day >= days:
        # прогрев пройден, остаётся догрев; аккаунт в рассылке («живой день» или
        # между пачками) — потолок побольше: живёт весь день, а не 1–2 действия
        step = BETWEEN if (between or lively) else TOP_UP
    else:
        step = {}
        for since, plan in plan_for(days):
            if day >= since:
                step = plan
    out = {}
    today = datetime.now().strftime("%Y-%m-%d")
    for kind, (lo, hi) in step.items():
        if hi <= lo:
            out[kind] = lo
            continue
        h = hashlib.sha256(f"{acc_id}:{today}:{kind}".encode()).hexdigest()
        out[kind] = lo + int(h[:8], 16) % (hi - lo + 1)
    return out


def pick_daily(acc_id, kind, lo, hi):
    """Одно число из вилки на сутки — как в caps(): не скачет между запусками."""
    lo, hi = int(lo), int(hi)
    if hi <= lo:
        return max(0, lo)
    today = datetime.now().strftime("%Y-%m-%d")
    h = hashlib.sha256(f"{acc_id}:{today}:{kind}".encode()).hexdigest()
    return lo + int(h[:8], 16) % (hi - lo + 1)


def comment_cap(acc, day, rewarm, held, cfg, days=None):
    """
    Сколько комментариев сегодня. Только прогретым (во время прогрева — ноль) и
    только при comments.on. Временно ограниченным и «без рассылки» после
    ограничения — лишь тем, кто явно в comments.held_accounts.
    """
    days = days or warm_days()
    if not cfg["on"]:
        return 0
    # коммент-пул: если задан список comments.only — комментируют ТОЛЬКО эти аккаунты
    # (отдельный пул органики, чтобы не грузить холодовиков). Пусто — все прогретые.
    only = cfg.get("only") or []
    if only and acc["id"] not in only:
        return 0
    allowed_held = acc["id"] in (cfg.get("held_accounts") or [])
    # под ограничением SpamBot (любым) — только если разрешили, и только временным
    restricted = acc.get("spamOk") is False or acc.get("spamKind") in ("temp", "perm", "frozen")
    if held or restricted:
        if not allowed_held or acc.get("spamKind") in ("perm", "frozen"):
            return 0
        return pick_daily(acc["id"], "comment", *cfg["held_per_day"])
    if rewarm:
        return pick_daily(acc["id"], "comment", *cfg["held_per_day"]) if allowed_held else 0
    if day < days:
        return 0
    return pick_daily(acc["id"], "comment", *cfg["per_day"])


def history(acc_id):
    return [r for r in tglib.read_csv(tglib.WARMUP) if r.get("account") == acc_id]


def _since_midnight():
    m = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    return m.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def done_today(rows, kind):
    """
    Сколько попыток этого вида сегодня — удачных И НЕТ. Раньше в предел шли
    только удачи, и аккаунт, которому Telegram отказывал, бился об отказы весь
    день: предел не убывал. Рискует сам запрос, а не то, чем он кончился.
    Заход без действия (NO_TRY: писать некому, это группа) — не попытка: ни
    одного запроса к цели не было, а у старых аккаунтов иначе срезалась бы
    переписка в дни, когда свои отвечают медленно.
    """
    since = _since_midnight()
    return sum(1 for r in rows if r.get("action") == kind and r.get("at", "") >= since
               and r.get("note") not in NO_TRY)


def tried_today(rows, kind):
    """
    Был ли сегодня ХОТЬ ОДИН заход этого вида, удачный или нет. Нужно для
    похода к боту: если он не ответил, а мы считаем только удачи, прогрев
    будет ломиться к нему снова и снова и не сделает больше ничего.
    """
    since = _since_midnight()
    return any(r.get("action") == kind and r.get("at", "") >= since for r in rows)


def note(acc_id, action, target, result):
    tglib.append_row(tglib.WARMUP,
                     [acc_id, action, tglib.cell(target), result, now_iso()],
                     tglib.WARMUP_HEAD)


FROZE = "заморожен"          # пометка в журнале: дальше аккаунт уже заморожен
GONE = "получатель удалён"   # свой аккаунт Telegram показал удалённым — не наша вина
STRANGER = "чужой ник"       # ник из реестра сейчас у постороннего — не пишем
NO_NICK = "ник не найден"    # ника из реестра больше нет (свой сменил или убрал)
EMPTY = "пусто"              # заход был, а делать нечего: никто не ждёт, свежих постов нет
NO_REACT = "без реакций"     # канал не принимает реакции — к нему за реакцией не ходим
NOT_CHANNEL = "не канал"     # первые дни реакции только в каналах, а это группа
NICK_BUSY = "ники заняты"    # все варианты @ника заняты — завтра другие
SUBS_FULL = "предел подписок"  # у аккаунта предел каналов в Telegram — цель ни при чём

OK_NOTES = ("ok", "заявка")
# Не отказ Telegram аккаунту — в счёт отказов (fails_today) не идёт: виноват
# реестр, цель или пустая лента. В предел (done_today) идёт, кроме NO_TRY
NEUTRAL = (FROZE, GONE, STRANGER, NO_NICK, EMPTY, NO_REACT, NOT_CHANNEL, NICK_BUSY)
NO_TRY = (EMPTY, NOT_CHANNEL)   # заход без действия: к цели не было ни одного запроса
DM_IDLE = 90 * 60     # переписка оказалась пустой — столько секунд её не выбираем


def dm_idle(rows):
    """
    Переписка недавно (DM_IDLE) оказалась пустой — свои ещё не ответили или
    пока без @ника. Тогда её пока не выбираем: заход не сгорит впустую на
    чтении диалогов, а позже, когда ответят, она вернётся (в предел пустой
    заход не идёт).
    """
    since = (datetime.now(timezone.utc) - timedelta(seconds=DM_IDLE)).isoformat(
        timespec="milliseconds").replace("+00:00", "Z")
    return any(r.get("action") == "dm" and r.get("note") == EMPTY and r.get("at", "") >= since
               for r in rows)


def struck(rows, kind):
    """
    Цели этого вида, к которым аккаунт больше не возвращается.

    Раньше вычёркивалась любая цель с хоть одной строкой в журнале — и та, что
    отказала, пока аккаунт был ЗАМОРОЖЕН: замороженный перестаёт находить живые
    каналы и ботов («нет такого», «не вышло»), у c1 и c4 так за день ушло по
    десятку живых целей. Теперь отказ вычёркивает цель, только когда после него
    аккаунт что-то сделал удачно (значит, сам был жив и дело в цели). Отказы
    перед пометкой «заморожен» — не в счёт. Флуд — сигнал аккаунту, не цели.
    """
    out, pending = set(), set()
    for r in rows:
        mark, act = r.get("note") or "", r.get("action")
        if mark == FROZE:
            pending.clear()
        elif act == "spam":
            continue
        elif mark in OK_NOTES:
            out |= pending
            pending.clear()
            if act == kind:
                out.add(r.get("target"))
        elif act == kind and not mark.startswith("флуд") and mark != SUBS_FULL:
            pending.add(r.get("target"))
    return out


FAIL_DAY = 4        # столько отказов за день — прогрев до завтра стоит
FAIL_WHY = f"{FAIL_DAY} отказа за день"   # и с этой причиной просим панель спросить SpamBot


def fails_today(rows):
    """
    Сколько действий прогрева сегодня кончились отказом Telegram. Так
    выглядит заморозка или лимит изнутри: c1 и c4 23.10 до утра собрали по
    12–16 отказов. Теперь на FAIL_DAY-м прогрев встаёт до завтра (main), а
    панель спрашивает SpamBot (fail_stop). Вопрос к SpamBot — не действие;
    пустой заход, удалённый свой или устаревший ник — не отказ (NEUTRAL).
    """
    since = _since_midnight()
    return sum(1 for r in rows if r.get("at", "") >= since and r.get("action") != "spam"
               and (r.get("note") or "") not in OK_NOTES + NEUTRAL)


def fail_stop(acc, before):
    """
    Этот заход довёл отказы до FAIL_DAY (до него было before) — просим панель
    спросить SpamBot. Один раз: дальше прогрев до завтра стоит и отказов не
    прибавится. Возвращает True, если порог перейдён сейчас.
    """
    if before >= FAIL_DAY or fails_today(history(acc["id"])) < FAIL_DAY:
        return False
    say(f"{FAIL_WHY} — прогрев до завтра стоит, прошу панель спросить SpamBot")
    try:
        tglib.request_spam_recheck(acc["id"], FAIL_WHY)
    except Exception as e:
        say(f"попросить проверку не вышло: {type(e).__name__}")
    return True


class Frozen(Exception):
    """Аккаунт заморожен — в этом заходе больше ничего не делаем."""


NET_ERRORS = (OSError, asyncio.TimeoutError)   # связь (в т.ч. обрыв сторожем страны), не отказ


def check_frozen(e):
    """
    Ошибка FROZEN_* (FROZEN_METHOD_INVALID и родня) — это приговор аккаунту, а
    не неудача действия. Раньше её глотали вместе с прочими («не вышло»), и
    замороженный бился об отказы до утреннего SpamBot (у c8 — ImportContacts
    трижды). Теперь — стоп захода, отметку ставит main.

    Обрыв связи (прокси, сторож страны в tglib рвёт её ConnectionError) — тоже
    не неудача действия: пробрасываем, в журнал отказом он не ляжет.
    """
    if tglib.is_frozen_error(e):
        raise Frozen(str(e)) from e
    if isinstance(e, NET_ERRORS):
        raise e


def frozen_now(acc_id):
    """Стоит ли в реестре заморозка (свежий взгляд: её мог поставить SpamBot-чек)."""
    cur = next((a for a in tglib.load_accounts() if a.get("id") == acc_id), {})
    return cur.get("spamKind") == "frozen"


def is_peer_gone(e):
    """
    Отправка своему аккаунту упала «The specified user was deleted»
    (INPUT_USER_DEACTIVATED) — так другим виден замороженный. USER_DEACTIVATED
    (401) сюда не относится: это про НАШ аккаунт, не про получателя.
    """
    s = (type(e).__name__ + " " + str(e)).upper()
    return ("INPUTUSERDEACTIVATED" in s or "INPUT_USER_DEACTIVATED" in s
            or "SPECIFIED USER WAS DELETED" in s)


def peer_gone(acc, peer):
    """
    Свой аккаунт виден удалённым — сам он узнает о заморозке только утром у
    SpamBot. Просим панель спросить SpamBot за него сейчас (уже висящую
    просьбу tglib не перебивает).
    """
    try:
        if tglib.request_spam_recheck(peer["id"], f"user deleted при DM от {acc['id']}"):
            say(f"{peer.get('title') or peer['id']}: попросил панель проверить его у SpamBot")
    except Exception as e:
        say(f"попросить проверку {peer.get('title') or peer['id']} не вышло: {type(e).__name__}")


# ------------------------------------------------------------------ действия

async def do_sub(client, acc, rows, data, kind="sub"):
    """Подписка на канал (или вступление в открытую группу — то же действие)."""
    from telethon.tl.functions.channels import JoinChannelRequest
    from telethon.errors import (ChannelsTooMuchError, FloodWaitError,
                                 UsernameNotOccupiedError, UsernameInvalidError,
                                 ChannelPrivateError, InviteRequestSentError)

    pool = data["channels" if kind == "sub" else "chats"]
    seen = struck(rows, kind)
    left = [c for c in pool if c not in seen]
    if not left:
        say(f"в списке не осталось нового ({'каналов' if kind == 'sub' else 'чатов'}) — пропускаю")
        return False

    target = random.choice(left)
    try:
        ent = await client.get_entity(target)
        await client(JoinChannelRequest(ent))
    except (UsernameNotOccupiedError, UsernameInvalidError, ValueError):
        note(acc["id"], kind, target, "нет такого")
        say(f"@{target} — такого не нашлось, больше к нему не вернусь")
        return False
    except ChannelPrivateError:
        note(acc["id"], kind, target, "закрыт")
        say(f"@{target} — закрытый, пропускаю его насовсем")
        return False
    except InviteRequestSentError:
        note(acc["id"], kind, target, "заявка")
        say(f"@{target} — по заявке; заявку оставил, ждать не буду")
        return True
    except ChannelsTooMuchError:
        # попытка была — в журнал: иначе прогрев выбирал бы подписку снова и снова
        note(acc["id"], kind, target, SUBS_FULL)
        say("у аккаунта уже предел подписок в Telegram — подписки пока пропускаю")
        return False
    except FloodWaitError as e:
        note(acc["id"], kind, target, f"флуд {e.seconds}")
        say(f"Telegram просит подождать {e.seconds} с — на сегодня хватит")
        raise

    note(acc["id"], kind, target, "ok")
    say(f"подписался: @{target}")
    return True


CHANNELS_ONLY = 14   # столько первых активных дней реакции — только в каналах


def react_targets(rows, channels_only=False):
    """
    Где аккаунт может читать и реагировать: каналы (sub), а позже и группы
    (chat), куда он вступил. Первые CHANNELS_ONLY активных дней — только каналы:
    реакция в канале анонимна, а в группе она на сообщение незнакомого
    человека и видна ему — для новичка это касание чужих. Каналы, где реакций
    не принимают (или это оказалась группа), больше не выбираем; не открылся —
    сегодня к нему не возвращаемся, а насовсем вычеркнем, если после отказа
    аккаунт что-то сделал удачно (сам жив — значит, дело в канале, как struck).
    """
    kinds = ("sub",) if channels_only else ("sub", "chat")
    since, bad, pending = _since_midnight(), set(), set()
    for r in rows:
        t, mark = str(r.get("target", "")).split("#")[0], r.get("note") or ""
        if r.get("action") == "react" and mark in (NO_REACT, NOT_CHANNEL):
            bad.add(t)
        elif r.get("action") == "react" and mark == "не вышло":
            pending.add(t)
            if r.get("at", "") >= since:
                bad.add(t)
        elif mark == FROZE:
            pending.clear()
        elif mark in OK_NOTES and r.get("action") != "spam":
            bad |= pending
            pending.clear()
    out = []
    for r in rows:
        t = r.get("target")
        if r.get("action") in kinds and r.get("note") == "ok" and t not in bad and t not in out:
            out.append(t)
    return out


async def do_react(client, acc, rows, data, channels_only=False):
    """
    Почитать ленту и отреагировать. Именно в таком порядке: реакция сразу
    после входа в канал выглядит как робот, поэтому сначала «читаем».
    channels_only — первые дни: только каналы (react_targets).
    """
    from telethon.tl import functions, types
    from telethon.errors import FloodWaitError

    mine = react_targets(rows, channels_only)
    if not mine:
        say("пока не на что реагировать — сначала нужны подписки"
            + (" на каналы" if channels_only else ""))
        return False

    target = random.choice(mine)
    try:
        ent = await client.get_entity(target)
        if channels_only and not (isinstance(ent, types.Channel) and getattr(ent, "broadcast", False)):
            # в списке каналов оказалась группа: там реакция — на сообщение человека
            note(acc["id"], "react", target, NOT_CHANNEL)
            say(f"@{target}: это группа, а не канал — реакции пока только в каналах")
            return False
        posts = await client.get_messages(ent, limit=HISTORY)
    except FloodWaitError:
        raise
    except Exception as e:
        check_frozen(e)
        note(acc["id"], "react", target, "не вышло")
        say(f"@{target}: {str(e).splitlines()[0][:80]}")
        return False

    posts = [m for m in posts if m and not m.action]
    if not posts:
        note(acc["id"], "react", target, EMPTY)
        say(f"@{target}: свежих постов нет")
        return False

    # «читаем»: отмечаем прочитанным и держим паузу, как живой человек
    try:
        await client.send_read_acknowledge(ent)
    except Exception:
        pass
    dwell = random.uniform(READ_MIN, READ_MAX)
    say(f"читаю @{target} ({dwell:.0f} с)")
    await asyncio.sleep(dwell)

    # опрос попался — голосуем: это тоже обычное поведение читателя
    poll = next((m for m in posts if isinstance(m.media, types.MessageMediaPoll)
                 and not m.media.poll.closed and not m.media.poll.quiz), None)
    if poll and random.random() < 0.5:
        try:
            choice = random.choice(poll.media.poll.answers).option
            await client(functions.messages.SendVoteRequest(peer=ent, msg_id=poll.id,
                                                            options=[choice]))
            note(acc["id"], "react", f"{target}#{poll.id}", "ok")
            say(f"проголосовал в опросе @{target}")
            return True
        except FloodWaitError:
            raise
        except Exception as e:
            check_frozen(e)
            # опрос не дался — просто поставим реакцию

    post = random.choice(posts)
    for emo in data["reactions"]:
        try:
            await client(functions.messages.SendReactionRequest(
                peer=ent, msg_id=post.id, reaction=[types.ReactionEmoji(emoticon=emo)]))
            note(acc["id"], "react", f"{target}#{post.id}", "ok")
            say(f"поставил {emo} посту в @{target}")
            return True
        except FloodWaitError:
            raise
        except Exception as e:
            check_frozen(e)
            continue      # канал не принимает такую реакцию — пробуем следующую
    note(acc["id"], "react", target, NO_REACT)
    say(f"@{target}: реакции тут не принимают — сюда за реакцией больше не хожу")
    return False


FOCUS_DM = 8        # сколько переписки в сутки у аккаунта в фокусе
FOCUS_WEIGHT = 10   # и насколько чаще он выбирает переписку среди действий
FOCUS_PEER_DM = 3   # переписка в сутки у его собеседников (если она им вообще положена)


def focus_ids(data):
    """
    Аккаунты, которые надо догреть перепиской побыстрее. Пока не вышел срок,
    остальные в первую очередь пишут и отвечают им, а сами они больше
    переписываются. Задаётся в warm-list.json:
        "dm_focus": {"accounts": ["a2"], "until": "2026-09-27T02:00:00Z"}
    """
    f = data.get("dm_focus") or {}
    if str(f.get("until", "")) <= now_iso():
        return set()
    return set(f.get("accounts") or [])


def dm_peers(acc):
    """
    Свои аккаунты, с которыми можно переписываться. Только из своей группы:
    покупные (свежие и выпускники) — с покупными, защищённые (protected, явный
    acc.protect) — с защищёнными, ни ответов, ни писем через границу. Нужен
    user_id: по нему узнаём своих в диалогах и
    сверяем, что ник из реестра ведёт к нашему, а не к постороннему.
    """
    # замороженному писать бессмысленно (не ответит) и вредно: переписка с ним
    # связывает живой аккаунт с замороженным. Временно ограниченные — остаются
    mine = protected(acc)
    return [a for a in tglib.load_accounts()
            if a.get("id") != acc["id"] and a.get("spamKind") != "frozen"
            and a.get("user_id") and protected(a) == mine]


PARTNERS = (2, 3)   # столько постоянных собеседников у аккаунта (вилка, своя у каждого)


def partners(acc, peers):
    """
    С кем аккаунт САМ заводит переписку — 2–3 постоянных своих, а не все подряд.

    Раньше первым писали тем, с кем ещё не говорили, и за неделю каждый
    переписывался с каждым: партия 18.10 — сплошная сеть ImportContacts друг на
    друга, ровно картинка фермы. Теперь у аккаунта узкий круг: выбор по хэшу
    ПАРЫ id (у обоих один и тот же — круги сходятся и разговор взаимный), не
    скачет между заходами; заморозили собеседника — его место займёт следующий.
    Сначала те, кто сам греется и ответит (читатель, резерв и списанные — в
    конце), и из другой партии (другая дата добавления): своя партия друг с
    другом — тот же отпечаток. peers — уже своя группа (dm_peers): свежий в
    круг защищённого не попадёт и наоборот. Отвечать можно всем своим, кто
    написал. Собеседник без @ника и без диалога ждёт, пока заведёт ник (do_nick).
    """
    me, batch = acc["id"], str(acc.get("added") or "")[:10]
    k = PARTNERS[0] + int(hashlib.sha256(f"{me}:partners".encode()).hexdigest()[:8], 16) \
        % (PARTNERS[1] - PARTNERS[0] + 1)

    def rank(p):
        pair = "|".join(sorted((me, str(p.get("id")))))
        quiet = p.get("role") == "read" or bool(p.get("reserve")) or bool(p.get("retired"))
        same = bool(batch) and str(p.get("added") or "")[:10] == batch
        return quiet, same, hashlib.sha256(pair.encode()).hexdigest()

    return sorted(peers, key=rank)[:k]


def talk_lines(data):
    """
    Фразы делятся на «начать разговор» и «ответить». Одна общая куча давала
    «ясно, буду иметь в виду» первым сообщением и по три раза подряд. Если в
    warm-list.json разделения ещё нет — делим старый список: вопросы и
    приветствия открывают разговор, остальное годится в ответ.
    """
    talk = [t for t in data.get("talk", []) if t.strip()]
    opens = data.get("talk_open") or [t for t in talk if "?" in t or t.lower().startswith("привет")]
    replies = data.get("talk_reply") or [t for t in talk if t not in opens]
    return opens or talk, replies or talk


def pick(lines, last):
    """Случайная фраза, но не та же, что ушла этому человеку в прошлый раз."""
    fresh = [t for t in lines if t != last]
    return random.choice(fresh or lines)


def nick_of(peer):
    """@ник своего из реестра (tglib обновляет его из get_me при каждом входе), '' — нет."""
    return str(peer.get("username") or "").strip().lstrip("@")


async def find_peer(client, peer, known):
    """
    Сущность своего аккаунта для первого сообщения: (сущность, None) или
    (None, почему). Диалог уже есть — берём из него; иначе по @нику из реестра.

    НОМЕРОМ — НИКОГДА. Знакомство по номеру (ImportContacts) — та же операция,
    с которой начинается холодное письмо: партия 18.10 на «4-й день» разом
    импортировала номера друг друга, и её заморозили подряд. Своего без ника и
    без диалога просто нет среди собеседников, пока он не заведёт ник (do_nick).

    Найденного по нику сверяем с user_id из реестра: ник мог смениться, и
    письмо ушло бы постороннему (STRANGER). Ника больше нет — NO_NICK.
    """
    from telethon.errors import UsernameNotOccupiedError, UsernameInvalidError

    uid = int(peer.get("user_id") or 0)
    if uid in known:
        return known[uid], None
    nick = nick_of(peer)
    if not nick or not uid:
        return None, NO_NICK
    try:
        ent = await client.get_entity(nick)
    except (UsernameNotOccupiedError, UsernameInvalidError, ValueError):
        return None, NO_NICK
    if getattr(ent, "id", 0) != uid:
        say(f"@{nick} сейчас не у нашего аккаунта ({peer.get('title') or peer['id']}) — по нику не пишу")
        return None, STRANGER
    return ent, None


async def read_own(client, acc):
    """
    Прочитать, что написали свои аккаунты. Раньше аккаунт отмечал переписку
    прочитанной, только когда сам отвечал: написали двое, ответил одному —
    второй диалог висел непрочитанным днями, как у брошенного аккаунта.
    Живой человек, открыв Telegram, первым делом читает новые сообщения —
    так и делаем в начале каждого захода, с паузой на «прочитать».
    Возвращает, сколько диалогов прочитал.
    """
    own = {int(p["user_id"]) for p in dm_peers(acc) if p.get("user_id")}
    n = 0
    # свежее всегда наверху; глубже — дочитаем, когда будем отвечать (do_dm)
    for d in await client.get_dialogs(limit=OWN_DIALOGS):
        if d.is_user and d.entity.id in own and d.unread_count:
            await asyncio.sleep(random.uniform(2, 6))
            await client.send_read_acknowledge(d.entity)
            n += 1
    return n


async def do_dm(client, acc, rows, data):
    """
    Переписка со своими же аккаунтами. Живой аккаунт кому-то пишет и кому-то
    отвечает — с этого и начинается нормальная история переписки. Ссылок и
    ничего коммерческого тут быть не может: это разговор, а не рассылка.

    Своих узнаём по user_id, а не по @username: ника у половины аккаунтов нет,
    и раньше им никто не мог ответить — они только писали в пустоту.
    Порядок: сначала отвечаем тем, кто ждёт; первыми пишем только своему
    узкому кругу (partners) и только тем, кому мы не писали последними —
    второе сообщение подряд без ответа не шлём. Первое сообщение — только в
    уже открытый диалог или по @нику из реестра (find_peer), номера в контакты
    не добавляем никогда. Свои — только из своей группы (dm_peers).
    """
    from telethon.errors import FloodWaitError

    # None — «отправлять было нечего» (никто не ждёт ответа, писать первым
    # некому), False — попытались и не вышло. Вызывающий различает их.
    # Пустой заход тоже пишем в журнал (EMPTY): он идёт в предел, иначе
    # переписка выбиралась бы снова и снова и жгла заходы впустую
    peers = dm_peers(acc)
    if not peers:
        say("писать некому: в панели нет других аккаунтов из своей группы")
        return None
    by_id = {int(p["user_id"]): p for p in peers}
    opens, replies = talk_lines(data)
    focus = focus_ids(data)
    # ник, который сегодня уже вёл к чужому или пропал, до завтра не трогаем
    since = _since_midnight()
    dud = {str(r.get("target", "")) for r in rows if r.get("action") == "dm"
           and r.get("note") in (STRANGER, NO_NICK) and r.get("at", "") >= since}

    known, last_out, waiting = {}, {}, []
    for d in await client.get_dialogs(limit=DM_DIALOGS):
        if not d.is_user or d.entity.id not in by_id or not d.message:
            continue
        if getattr(d.entity, "deleted", False):
            # свой аккаунт Telegram показывает удалённым — так виден замороженный:
            # писать ему незачем, а панели стоит спросить о нём SpamBot
            peer_gone(acc, by_id[d.entity.id])
            continue
        known[d.entity.id] = d.entity
        if d.message.out:
            last_out[d.entity.id] = d.message.message or ""
        else:
            waiting.append(d)

    if waiting:
        # аккаунту в фокусе отвечаем первым, дальше — кто дольше всех ждёт
        d = min(waiting, key=lambda x: (by_id[x.entity.id]["id"] not in focus, x.message.date))
        ent, peer = d.entity, by_id[d.entity.id]
        async for m in client.iter_messages(ent, limit=10):
            if m.out:
                last_out[ent.id] = m.message or ""
                break
        text = pick(replies, last_out.get(ent.id))
        verb = "ответил"
    else:
        free = [p for p in peers if int(p["user_id"]) not in last_out]
        if not free:
            note(acc["id"], "dm", "", EMPTY)
            say("все свои молчат в ответ на наши сообщения — новых не шлём, ждём ответов")
            return None
        # первыми пишем только своему кругу (и аккаунту в фокусе — его задал хозяин)
        circle = {p["id"] for p in partners(acc, peers)}
        free = [p for p in free if p["id"] in circle or p["id"] in focus]
        # только те, с кем диалог уже есть, и те, кого видно по @нику из реестра
        free = [p for p in free if int(p["user_id"]) in known
                or (nick_of(p) and "@" + nick_of(p) not in dud)]
        if not free:
            note(acc["id"], "dm", "", EMPTY)
            say("свой круг переписки уже ждёт нашего ответа или пока без @ника — новых не заводим")
            return None
        # аккаунт в фокусе — первым; потом те, с кем ещё ни разу не говорили
        hot = [p for p in free if p["id"] in focus]
        fresh = [p for p in free if int(p["user_id"]) not in known]
        peer = random.choice(hot or fresh or free)
        tag = "@" + nick_of(peer) if nick_of(peer) else (peer.get("title") or peer["id"])
        try:
            ent, why = await find_peer(client, peer, known)
        except FloodWaitError:
            raise
        except Exception as e:
            check_frozen(e)
            ent, why = None, "ошибка"
            say(f"{tag}: {str(e).splitlines()[0][:80]}")
        if ent is None:
            # чужой или пропавший ник — вина реестра, не аккаунта: в отказы не идёт
            note(acc["id"], "dm", tag, why)
            if why == NO_NICK:
                say(f"{tag}: такого ника больше нет — до завтра {peer.get('title') or peer['id']} не пишу")
            return None if why in (STRANGER, NO_NICK) else False
        if getattr(ent, "deleted", False):
            note(acc["id"], "dm", tag, GONE)
            peer_gone(acc, peer)
            return None
        if int(peer["user_id"]) not in known:
            # диалог мог уйти глубже верхних DM_DIALOGS (раньше смотрели 200):
            # если последнее слово наше — второе подряд без ответа не шлём
            try:
                last = await client.get_messages(ent, limit=1)
            except FloodWaitError:
                raise
            except Exception as e:
                check_frozen(e)
                last = []
            if last and last[0].out:
                note(acc["id"], "dm", tag, EMPTY)
                say(f"{tag}: последнее сообщение наше — ждём ответа")
                return None
        text = pick(opens, None)
        verb = "написал"

    who = "@" + nick_of(peer) if nick_of(peer) else (peer.get("title") or peer.get("id"))
    try:
        await asyncio.sleep(random.uniform(READ_MIN, READ_MAX))   # «печатает»
        await client.send_message(ent, text, link_preview=False)
        # отметка «прочитано» — мелочь: если не встала, письмо-то уже ушло и
        # должно записаться как ok, а не «ошибка»
        try:
            await client.send_read_acknowledge(ent)
        except FloodWaitError:
            raise
        except Exception:
            pass
    except FloodWaitError:
        raise
    except Exception as e:
        check_frozen(e)
        if is_peer_gone(e):
            # не наша неудача: получатель (свой) виден удалённым — его и проверяем
            note(acc["id"], "dm", who, GONE)
            say(f"{who}: Telegram говорит «аккаунт удалён» — у своих так выглядит заморозка")
            peer_gone(acc, peer)
            return None
        note(acc["id"], "dm", who, "ошибка")
        say(f"{who}: {str(e).splitlines()[0][:80]}")
        return False

    note(acc["id"], "dm", who, "ok")
    say(f"{verb} {who}: «{text}»")
    return True


async def do_bot(client, acc, rows, data):
    """
    Запустить бота из списка.

    Смысл не в самом боте, а в том, что он потом пишет САМ: напоминалки,
    игровые события, ответы нейросети. Входящие сообщения аккаунт себе не
    нарисует, а для Telegram это как раз признак живого — с человеком
    разговаривают, а не только он.
    """
    from telethon.errors import FloodWaitError

    pool = data.get("bots") or []
    seen = struck(rows, "bot")
    left = [b for b in pool if b not in seen]
    if not left:
        say("все боты из списка уже запущены — пропускаю")
        return False

    target = random.choice(left)
    try:
        ent = await client.get_entity(target)
        await client.send_message(ent, "/start")
        await asyncio.sleep(random.uniform(READ_MIN, READ_MAX))   # ждём ответа, как человек
        await client.send_read_acknowledge(ent)
    except FloodWaitError:
        raise
    except Exception as e:
        check_frozen(e)
        note(acc["id"], "bot", target, "не вышло")
        say(f"@{target}: {str(e).splitlines()[0][:80]}")
        return False

    note(acc["id"], "bot", target, "ok")
    say(f"запустил бота @{target} — дальше он пишет сам")
    return True


# ------------------------------------------------------------------ @ник

NICK_FROM = 2          # с какого активного дня аккаунт заводит себе @ник
NICK_DAYS = 3          # в пределах скольких дней после него — у каждого свой день
NICK_SPREAD = 180      # в пределах стольких минут после начала его дня — свой час
NICK_TRIES = (3, 5)    # столько вариантов перебирает за раз (своё число у каждого)

_LAT = dict(zip("абвгдеёжзийклмнопрстуфхцчшщъыьэюя", (
    "a", "b", "v", "g", "d", "e", "e", "zh", "z", "i", "y", "k", "l", "m", "n", "o", "p",
    "r", "s", "t", "u", "f", "kh", "ts", "ch", "sh", "shch", "", "y", "", "e", "yu", "ya")))
# как зовут в жизни — для варианта «короткое имя + фамилия»; нет тут — первая буква
_SHORT = {
    "александр": "sasha", "александра": "sasha", "алексей": "lesha", "анастасия": "nastya",
    "анна": "anya", "артем": "tema", "владимир": "vova", "владислав": "vlad", "вячеслав": "slava",
    "виктория": "vika", "григорий": "grisha", "дарья": "dasha", "дмитрий": "dima",
    "евгений": "zhenya", "евгения": "zhenya", "екатерина": "katya", "елена": "lena",
    "иван": "vanya", "ирина": "ira", "константин": "kostya", "ксения": "ksyusha",
    "максим": "max", "мария": "masha", "михаил": "misha", "наталья": "natasha",
    "наталия": "natasha", "николай": "kolya", "ольга": "olya", "павел": "pasha",
    "роман": "roma", "светлана": "sveta", "сергей": "serega", "станислав": "stas",
    "татьяна": "tanya", "юлия": "yulya",
}
_NICK_OK = re.compile(r"[a-z][a-z0-9_]{3,30}[a-z0-9]")   # 5–32, с буквы, не на «_»


def translit(word):
    """Русское слово латиницей, как пишут в никах (ж→zh, х→kh, я→ya); прочее — прочь."""
    out = []
    for ch in str(word or "").lower():
        if ch in _LAT:
            out.append(_LAT[ch])
        elif "a" <= ch <= "z" or ch in "0123456789":
            out.append(ch)
    return "".join(out)


def nick_candidates(name, acc_id, attempt=0):
    """
    3–5 естественных вариантов @ника из имени и фамилии — так их придумывает
    человек: имя_фамилия, фамилия_имя, короткое имя + фамилия; две цифры (как
    год рождения) — только у поздних вариантов. Порядок у каждого аккаунта
    свой, а в следующий раз (attempt — сколько раз уже пробовал) — другой и с
    другими цифрами: партия не ставит ники по одной схеме.
    """
    words = str(name or "").split()
    first = translit(words[0]) if words else ""
    last = translit(words[-1]) if len(words) > 1 else ""
    if not first:
        first, last = last, ""
    if not first:
        return []
    rnd = random.Random(f"{acc_id}:nick:{attempt}")
    short = _SHORT.get(words[0].lower().replace("ё", "е"), "") if words else ""
    if last:
        base = [f"{first}_{last}", f"{last}_{first}", f"{first}{last}",
                f"{short}_{last}" if short else f"{first[0]}{last}"]
    else:
        base = [first, short]
    base = [b for b in base if b]
    rnd.shuffle(base)
    k = NICK_TRIES[0] + rnd.randrange(NICK_TRIES[1] - NICK_TRIES[0] + 1)
    # первый раз — сначала без цифр; дальше простые варианты уже заняты
    plain = base[:max(1, k - 1)] if attempt == 0 else base[:1]
    years = list(range(75, 100)) + list(range(0, 8))
    out = []
    for u in plain + [f"{b}{rnd.choice(years):02d}" for b in base + base]:
        if _NICK_OK.fullmatch(u) and "__" not in u and u not in out:
            out.append(u)
    return out[:k]


def nick_time(acc_id):
    """Когда у аккаунта сегодня «руки дошли» до ника: свой час после начала его дня."""
    h = hashlib.sha256(f"{acc_id}:{datetime.now(EKB).date().isoformat()}:nick".encode()).hexdigest()
    return day_start(acc_id) + timedelta(minutes=int(h[:8], 16) % (NICK_SPREAD + 1))


def nick_due(acc, rows, day):
    """
    Пора ли сейчас заводить @ник. Ника в реестре нет (tglib держит его по
    get_me), аккаунт не заморожен, сегодня ещё не пробовал (раз в сутки,
    удачно или нет), и настали его день и час: у каждого свой активный день
    (NICK_FROM + 0..NICK_DAYS-1) и свой час — партия не ставит ники в один
    день и в одну минуту.
    """
    if nick_of(acc) or acc.get("spamKind") == "frozen":
        return False
    if not nick_candidates(acc.get("name"), acc["id"]):
        return False                     # из имени ника не сложить — и не пробуем
    h = int(hashlib.sha256(f"{acc['id']}:nick".encode()).hexdigest()[:8], 16)
    if day < NICK_FROM + h % NICK_DAYS or done_today(rows, "nick"):
        return False
    return datetime.now(EKB) >= nick_time(acc["id"])


async def do_nick(client, acc, rows):
    """
    Завести себе @ник. Без ника своим аккаунт не найти (номера в контакты
    прогрев не добавляет), а живой человек ник обычно заводит. Как человек и
    делает: перебирает варианты из своего имени (приложение проверяет каждый,
    пока его набирают, — account.checkUsername), ставит первый свободный.
    """
    from telethon.tl import functions
    from telethon.errors import (FloodWaitError, UsernameInvalidError, UsernameNotModifiedError,
                                 UsernameOccupiedError, UsernamePurchaseAvailableError)

    if nick_of(acc):          # connect() обновил реестр из get_me: ник уже завели руками
        say(f"ник уже есть: @{nick_of(acc)}")
        return None
    attempt = sum(1 for r in rows if r.get("action") == "nick")
    for u in nick_candidates(acc.get("name"), acc["id"], attempt):
        await asyncio.sleep(random.uniform(2, 6))        # «набирает»
        try:
            free = await client(functions.account.CheckUsernameRequest(username=u))
        except FloodWaitError:
            raise
        except (UsernameInvalidError, UsernameOccupiedError, UsernamePurchaseAvailableError):
            continue                                     # не годится или на продаже — как занят
        except Exception as e:
            check_frozen(e)
            note(acc["id"], "nick", f"@{u}", "не вышло")
            say(f"проверить @{u} не вышло: {str(e).splitlines()[0][:80]}")
            return False
        if not free:
            continue
        await asyncio.sleep(random.uniform(READ_MIN, READ_MAX))
        try:
            await client(functions.account.UpdateUsernameRequest(username=u))
        except FloodWaitError:
            raise
        except UsernameNotModifiedError:
            pass                                         # он уже и стоит
        except (UsernameOccupiedError, UsernameInvalidError, UsernamePurchaseAvailableError):
            continue                                     # заняли, пока думал
        except Exception as e:
            check_frozen(e)
            note(acc["id"], "nick", f"@{u}", "не вышло")
            say(f"поставить @{u} не вышло: {str(e).splitlines()[0][:80]}")
            return False
        acc["username"] = u
        tglib.set_field(acc["id"], username=u)
        note(acc["id"], "nick", f"@{u}", "ok")
        say(f"завёл себе ник @{u}")
        return True
    note(acc["id"], "nick", "", NICK_BUSY)
    say("все варианты ника заняты — завтра попробую другие")
    return False


async def ask_spam_bot(client, acc, data, force=False):
    """
    Спросить у @SpamBot, нет ли на аккаунте ограничений. Ответ кладём в реестр —
    панель покажет его в строке аккаунта, чтобы не гадать, живой он или уже
    придержан. Заморожен — так и пишем в журнал прогрева: по этой пометке
    отказы перед ней не вычёркивают цели (struck). force — мимо получасового
    кэша чистого ответа (внеплановый вопрос по просьбе, spamRecheckAt).
    """
    ok, said = await tglib.spam_check(client, acc, force=force)
    if ok is None:
        note(acc["id"], "spam", tglib.SPAM_BOT, "ошибка")
        say(f"@{tglib.SPAM_BOT}: {said}")
        return False
    froze = ok is False and frozen_now(acc["id"])
    note(acc["id"], "spam", tglib.SPAM_BOT, FROZE if froze else "ok")
    say(f"@{tglib.SPAM_BOT}: {said[:120]}")
    return True


# ------------------------------------------------------------------- выбор

async def main():
    acc = tglib.resolve(tglib.arg("account", ""))
    want = tglib.arg("what", "")
    between = tglib.flag("between")     # догрев между пачками рассылки
    lively = tglib.flag("lively")       # «живой день»: аккаунт из рассылки греется весь день
    held = tglib.flag("held")           # временно ограничен SpamBot: только комментарии, если разрешено
    # внеплановый вопрос к SpamBot по просьбе (spamRecheckAt, панель зовёт с --what spam):
    # мимо «сегодня уже спрашивали» и мимо получасового кэша чистого ответа
    recheck = tglib.flag("recheck")

    # полный отдых после заморозки — ни одного действия, даже SpamBot
    rest = tglib.full_rest_left(acc)
    if rest > 0:
        say(f"«{acc['title']}» на полном отдыхе после заморозки ещё "
            f"{rest // 3600} ч {rest % 3600 // 60} мин — прогрев не трогает")
        tglib.state(done=0, left=0, note="отдых после заморозки")
        return
    # «без рассылки» после заморозки — догрев: реакции, каналы, переписка со своими
    rewarm = tglib.send_hold_left(acc) > 0

    data = load_list()
    rows = history(acc["id"])
    day = age_days(acc, rows)                  # дни с действием (зрелому — календарь)
    days, lag = eff_warm_days(acc), warm_lag(acc)
    step_day = max(1, day - lag) if day >= 1 else 0   # день по ступеням, со сдвигом партии

    done = step_day >= days
    mode = ("догрев после заморозки (людям не пишет)" if rewarm
            else "догрев (прогрев пройден)" if done
            else f"прогрев, день {day} из {days + lag}"
                 + (f" (ступени позже на {lag} дн.)" if lag else ""))
    say(f"аккаунт: {acc['title']}  |  {mode}"
        f"{'  |  между пачками рассылки' if between else ''}  |  "
        f"{tglib.proxy_label(acc.get('proxy'))}")

    if day < 1:
        say("первые сутки аккаунт не трогаем вовсе — это отлёжка")
        tglib.state(done=0, left=0, note="отлёжка")
        return

    ccfg = comments.config(data)
    cap = {} if held else caps(acc["id"], step_day, between, rewarm, lively, days)
    cap["comment"] = comment_cap(acc, step_day, rewarm, held, ccfg, days)
    focus = focus_ids(data)
    focused = acc["id"] in focus
    if focused:
        cap["dm"] = max(cap.get("dm", 0), FOCUS_DM)
        say(f"в фокусе переписки: до {FOCUS_DM} сообщений своим сегодня")
    elif focus and cap.get("dm", 0) > 0:
        # собеседники того, кто в фокусе: им и отвечать ему в первую очередь —
        # при 1–2 переписках в сутки разговора бы не вышло
        cap["dm"] = max(cap["dm"], FOCUS_PEER_DM)
    # хозяин (или панель) выключил аккаунту переписку до срока — ни писем
    # своим, ни ответов; остальное прогрев делает как обычно
    no_dm = tglib._until_left(acc, "warmNoDmUntil") > 0
    if no_dm and cap.get("dm"):
        cap["dm"] = 0
        say(f"переписка со своими выключена до {acc['warmNoDmUntil']}")
    left = {k: cap.get(k, 0) - done_today(rows, k) for k in KINDS}
    say("на сегодня осталось: " + ", ".join(
        f"{k} {max(0, v)}/{cap.get(k, 0)}" for k, v in left.items()))

    # у греющегося аккаунта свой час начала дня — партия не выходит в одну
    # минуту. До него не подключаемся вовсе; панель зайдёт позже, как после
    # обычной сессии (без note — иначе она отложила бы аккаунт до завтра)
    if want == "" and not done and not (between or rewarm or held) and not mature(acc):
        start = day_start(acc["id"])
        if datetime.now(EKB) < start:
            say(f"день у этого аккаунта сегодня начинается в {start:%H:%M} по Екб — пока не трогаю")
            tglib.state(done=0, left=sum(max(0, v) for v in left.values()))
            return

    # раз в сутки спрашиваем у SpamBot, всё ли в порядке. Между пачками не
    # спрашиваем: рассылка сама спрашивает его перед каждой порцией.
    # Внеплановый вопрос — по просьбе (tglib.request_spam_recheck: свои видят
    # аккаунт удалённым, FAIL_DAY отказов за день): пока просьба висит
    # (spam_recheck_pending), «сегодня уже спрашивали» не держит. Панель зовёт
    # с --what spam [--recheck] и сама считает повторы; обычный заход закрывает
    # просьбу, только если после неё бота ещё не спрашивали
    pending = tglib.spam_recheck_pending(acc)
    asked = str(acc.get("spamRecheckAt") or "")
    asked_after = pending and any(r.get("action") == "spam" and r.get("at", "") >= asked for r in rows)
    if want in ("", "spam") and not between and (
            recheck or not tried_today(rows, "spam")
            or (pending and (want == "spam" or not asked_after))):
        tglib.state(act=DOING["spam"], phase="doing")
        client = await tglib.connect(acc)
        try:
            await ask_spam_bot(client, acc, data, force=recheck or pending)
        finally:
            await tglib.aclose(client)
        tglib.state(done=1, left=sum(max(0, v) for v in left.values()),
                    act=DONE["spam"], phase="done")
        return
    if want == "spam":
        # панель просила только SpamBot (замороженный аккаунт), а сегодня уже
        # спрашивали — других действий ему не положено
        say("SpamBot сегодня уже спрашивали")
        tglib.state(done=0, left=0, note="дневной предел прогрева")
        return

    # FAIL_DAY отказов за день — прогрев до завтра стоит (вопрос к SpamBot выше
    # остаётся: его и просили, fail_stop). Раньше отказы шли весь день: c1 и c4
    # 23.10 собрали по 12–16, и каждый засвечивал общий IP
    fails = fails_today(rows)
    if fails >= FAIL_DAY:
        say(f"отказов Telegram сегодня уже {fails} (предел {FAIL_DAY}) — прогрев до завтра стоит")
        tglib.state(done=0, left=0, note=FAIL_WHY)
        return

    # одобренный в панели комментарий уже посчитан (когда встал в очередь) —
    # отправляем его первым делом, мимо суточного предела. НО только если
    # комментарии этому аккаунту вообще положены сейчас (cap>0): иначе
    # аккаунт, получивший ограничение после постановки в очередь, опубликовал
    # бы одобренный комментарий в обход запрета.
    approved = ccfg["on"] and cap.get("comment", 0) > 0 and comments.has_approved(acc["id"])
    if approved and want in ("", "comment"):
        want = "comment"
        left["comment"] = max(1, left.get("comment", 0))
    if want == "comment" and left.get("comment", 0) <= 0:
        say("комментариев на сегодня хватит" if cap.get("comment") else "комментарии этому аккаунту сейчас не положены")
        tglib.state(done=0, left=0, note="дневной предел прогрева")
        return
    # @ник — раз в сутки в свой день и час, пока его нет (nick_due). Не между
    # пачками, не в догреве после заморозки и не у ограниченного (там свои
    # узкие наборы действий); заморожен — никогда
    if want == "nick":
        why = ("ник уже есть" if nick_of(acc) else "аккаунт заморожен" if acc.get("spamKind") == "frozen"
               else "сегодня уже пробовал" if done_today(rows, "nick") else "")
        if why:
            say(f"@ник: {why}")
            tglib.state(done=0, left=0, note="дневной предел прогрева")
            return
        nick = True
    else:
        nick = want == "" and not (between or rewarm or held) and nick_due(acc, rows, day)
    kinds = [k for k, v in left.items() if v > 0] if not want else [want]
    if want == "":
        if not data.get("chats"):
            kinds = [k for k in kinds if k != "chat"]     # вступать некуда
        if not data.get("bots"):
            kinds = [k for k in kinds if k != "bot"]      # и запускать некого
        # переписываться аккаунт может только со своими (из своей группы). Нет
        # таких в панели — писать некому, и выбирать это действие значит
        # впустую сжечь заход
        if not dm_peers(acc):
            kinds = [k for k in kinds if k != "dm"]
    if between:
        kinds = [k for k in kinds if k in BETWEEN_KINDS]
    if rewarm:
        kinds = [k for k in kinds if k in REWARM_KINDS]
    if held:
        kinds = [k for k in kinds if k == "comment"]
    if no_dm:
        kinds = [k for k in kinds if k != "dm"]
    idle = want == "" and "dm" in kinds and dm_idle(rows)
    if idle:
        kinds = [k for k in kinds if k != "dm"]
    if not kinds and not nick:
        if idle:
            # осталась только переписка, а свои ещё молчат — зайдём позже
            # (без note: иначе панель отложила бы аккаунт до завтра)
            say("осталась переписка, а свои ещё не ответили — зайду позже")
            tglib.state(done=0, left=max(0, left.get("dm", 0)))
            return
        say("на сегодня всё — аккаунт своё отработал")
        tglib.state(done=0, left=0, note="дневной предел прогрева")
        return

    # первые CHANNELS_ONLY активных дней реакции — только в каналах (анонимно),
    # не на сообщения незнакомых людей в группах. Дни — активные и у выпущенного
    # из прогрева (у зрелого day — календарный)
    young = (day if not mature(acc) else active_days(acc, rows)) < CHANNELS_ONLY
    if nick:
        kind = "nick"
    else:
        weight = dict(WEIGHT, dm=FOCUS_WEIGHT) if focused else WEIGHT
        kind = random.choices(kinds, weights=[weight[k] for k in kinds])[0]
    # реагировать пока не на что: аккаунт ещё ни на что не подписан. Менять
    # действие на подписку, а не тратить впустую целый заход — между заходами
    # у аккаунта минуты, и разбрасываться ими незачем
    if kind == "react" and not react_targets(rows, young):
        # между пачками не подписываемся — лучше напишем своим
        kind = ("sub" if left.get("sub", 0) > 0 and not between
                else "dm" if left.get("dm", 0) > 0 and "dm" in kinds else kind)
    # сообщаем панели, что аккаунт делает прямо сейчас — до долгой части
    tglib.state(act=DOING.get(kind, "работает"), phase="doing")
    client = await tglib.connect(acc)
    try:
        try:
            got = await read_own(client, acc)
            if got:
                say(f"прочитал сообщения от своих: {got}")
        except Exception as e:
            check_frozen(e)
            # не прочитали — не беда, основное действие важнее
        if kind == "nick":
            ok = await do_nick(client, acc, rows)
        elif kind == "react":
            ok = await do_react(client, acc, rows, data, young)
        elif kind == "dm":
            ok = await do_dm(client, acc, rows, data)
        elif kind == "bot":
            ok = await do_bot(client, acc, rows, data)
        elif kind == "comment":
            # в новые чаты вступаем только в обычном прогреве; между пачками,
            # в догреве после заморозки и у ограниченного — только свои чаты
            may_join = not (between or rewarm or held)
            ok, what, chat = await comments.do_comment(
                client, acc, data, comments.joined_today(acc["id"]), may_join=may_join)
            if what in ("sent", "queued"):
                note(acc["id"], "comment", chat, "ok")
            elif what == "joined":
                # вступление в группу — это «chat» прогрева: по ней потом и реакции
                note(acc["id"], "chat", chat, "ok")
                kind = "chat"
            elif ok is None and (lively or between) and left.get("react", 0) > 0 and not held:
                # отвечать было не на что — заход не пропадает, как у переписки
                kind = "react"
                tglib.state(act=DOING["react"], phase="doing")
                ok = await do_react(client, acc, rows, data, young)
        else:
            ok = await do_sub(client, acc, rows, data, kind)
        # Писать было некому (свои ещё не ответили или пока без @ника) или ник
        # уже завели руками — заход не пропадает: почитаем ленту и поставим
        # реакцию. Только при None («делать нечего»), не после отказа: после
        # сигнала Telegram продолжать не надо
        if ok is None and kind in ("dm", "nick") and left.get("react", 0) > 0 and not held:
            kind = "react"
            tglib.state(act=DOING["react"], phase="doing")
            ok = await do_react(client, acc, rows, data, young)
    except Exception as e:
        from telethon.errors import FloodWaitError, PeerFloodError
        if isinstance(e, Frozen) or tglib.is_frozen_error(e):
            # заморожен: в реестр сразу (панель увидит в этот же час, а не утром
            # у SpamBot) и больше ничего в этом заходе — любое действие упадёт
            # тем же FROZEN_* и только засветит IP. Цель тут ни при чём: в
            # журнале — пометка без цели, она же снимает отказы перед ней (struck)
            note(acc["id"], kind, "", FROZE)
            try:
                tglib.mark_frozen(acc["id"], str(e), "warmup")
            except Exception as x:
                say(f"отметить заморозку в реестре не вышло: {type(x).__name__}: {x}")
            say(f"\nстоп: аккаунт заморожен ({str(e).splitlines()[0][:80]}) — "
                "в этом заходе больше ничего не делаю")
            tglib.state(done=0, left=0, note="заморожен")
            return
        if isinstance(e, FloodWaitError):
            fail_stop(acc, fails)
            say(f"\nстоп: Telegram просит паузу {e.seconds} с")
            tglib.state(done=0, left=0, stop="flood", cooldown=e.seconds)
            return
        if isinstance(e, PeerFloodError):
            # Telegram придержал аккаунт за активность с незнакомыми — как в
            # рассылке: отлёжка 12 часов, комментарий в журнале прогрева
            note(acc["id"], kind, "", "peer_flood")
            fail_stop(acc, fails)
            say("\nстоп: PEER_FLOOD — Telegram придержал аккаунт, отлёжка 12 ч")
            tglib.state(done=0, left=0, stop="flood", cooldown=12 * 3600)
            return
        if isinstance(e, NET_ERRORS):
            # связь оборвалась (прокси, сторож страны) — не отказ аккаунту
            # и не поломка задачи: панель зайдёт ещё раз
            raise SystemExit(f"связь с Telegram оборвалась ({type(e).__name__}: "
                             f"{str(e).splitlines()[0][:80] if str(e) else '—'}) — действие не засчитано")
        raise
    finally:
        await tglib.aclose(client)

    rows = history(acc["id"])
    still = sum(max(0, cap.get(k, 0) - done_today(rows, k)) for k in left)
    if fail_stop(acc, fails):
        # этот отказ — FAIL_DAY-й за день: до завтра панели звать незачем
        tglib.state(done=1 if ok else 0, left=0, note=FAIL_WHY,
                    act=DONE.get(kind, "") if ok else "", phase="done")
        return
    tglib.state(done=1 if ok else 0, left=still,
                act=DONE.get(kind, "") if ok else "", phase="done")


asyncio.run(main())
