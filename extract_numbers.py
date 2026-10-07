#!/usr/bin/env python3
"""
Готовит numbers.csv из базы: Excel (.xlsx) или CSV.

Колонку с номерами ищет сам — берёт ту, где больше всего похожих на
российские мобильные. Отсеивает дубликаты, немобильные и маскированные
номера (у которых последние цифры обнулены — такие не существуют).

Номеров в файле может не быть вовсе: список участников чата — это @username
и имя, без телефонов. Такой файл тоже принимаем: людей кладём той же дорогой,
что и разбор чата (tglib.add_recipients), и они сразу попадают в очередь на
рассылку — проверять у них нечего.

    python3 extract_numbers.py <файл> [numbers.csv]
"""
import sys, csv, re, collections
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tglib

SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else None
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).parent / "numbers.csv"
if not SRC or not SRC.exists():
    sys.exit(f"не найден файл: {SRC}")


def normalize(raw) -> str | None:
    """'9045435434' | '89045435434' | '+7 904 543-54-34' -> '+79045435434'"""
    d = re.sub(r"\D", "", str(raw or ""))
    if len(d) == 11 and d[0] in "78":
        d = d[1:]
    if len(d) != 10 or not d.startswith("9"):
        return None                      # не мобильный РФ
    if d.endswith("00"):
        return None                      # маскированный оператором
    return "+7" + d


def rows_from(path: Path):
    if path.suffix.lower() in (".xlsx", ".xlsm"):
        try:
            import openpyxl
        except ImportError:
            sys.exit("нужен openpyxl:  ./venv/bin/pip install openpyxl")
        ws = openpyxl.load_workbook(path, read_only=True, data_only=True).worksheets[0]
        return [list(r) for r in ws.iter_rows(values_only=True)]
    with path.open(encoding="utf-8-sig", errors="replace", newline="") as f:
        sample = f.read(4096); f.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
        except csv.Error:
            dialect = csv.excel
        return [r for r in csv.reader(f, dialect)]


USERNAME = re.compile(r"^@?[A-Za-z][A-Za-z0-9_]{4,31}$")
BASE_HEAD = ["phone", "calls", "last_call", "total_sec"]


def restore_people():
    """
    Люди без номера (из разбора чатов и готовых списков) — тоже получатели,
    и новая таблица с номерами их не отменяет. numbers.csv переписывается
    целиком, поэтому возвращаем их обратно: иначе панель считала бы базу
    меньше, чем уже проверено, и полоска прогресса уехала бы за 100%.
    """
    if OUT.resolve() != tglib.NUMBERS.resolve():
        return 0                       # пишем не в базу панели — не наше дело
    have = {r.get("phone") for r in tglib.read_csv(OUT)}
    back = [r["phone"] for r in tglib.read_csv(tglib.RESULTS)
            if r.get("phone") and not tglib.is_phone(r["phone"]) and r["phone"] not in have]
    for key in back:
        tglib.append_row(tglib.NUMBERS, [key, "", "", ""], BASE_HEAD)
    return len(back)


def usernames(rows, head, width) -> bool:
    """
    Файл со списком людей вместо номеров: колонка с @username и, если есть,
    колонка с именем. Такой список отдаёт разбор чата (members.csv) — и такой
    же можно принести со стороны. Пишем людей в ту же очередь, куда их кладёт
    parse-chat.py, поэтому дальше их ведёт обычная рассылка.

    Возвращает True, если людей нашли и записали.
    """
    def col_of(pattern, cells):
        for i, h in enumerate(head):
            if re.search(pattern, h):
                return i
        return cells

    hits = [sum(1 for r in rows if len(r) > c and USERNAME.match(str(r[c] or "").strip()))
            for c in range(width)]
    if max(hits, default=0) == 0:
        return False
    ucol = col_of(r"user ?name|логин|ник", hits.index(max(hits)))
    ncol = col_of(r"^(name|имя|фио|title)$", None)

    # «username» в шапке сам похож на @username — иначе заголовок уехал бы
    # в получатели и панель написала бы несуществующему человеку
    HEADWORD = {"username", "user", "name", "login", "логин", "ник", "имя", "фио"}

    people, seen = [], set()
    for r in rows:
        if len(r) <= ucol:
            continue
        u = str(r[ucol] or "").strip().lstrip("@")
        if not USERNAME.match(u) or u.lower() in seen or u.lower() in HEADWORD:
            continue
        seen.add(u.lower())
        name = str(r[ncol] or "").strip() if ncol is not None and len(r) > ncol else ""
        people.append({"username": u, "name": name})

    if not people:
        return False

    # Список людей базу НЕ заменяет, а дополняет: номера, которые уже загружены,
    # никуда не деваются. add_recipients сам допишет их и в базу, и в очередь —
    # ровно так же, как это делает разбор чатов.
    if OUT.resolve() != tglib.NUMBERS.resolve():
        with OUT.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=BASE_HEAD, lineterminator="\n")
            w.writeheader()
            w.writerows({"phone": "@" + p["username"], "calls": "", "last_call": "", "total_sec": ""}
                        for p in people)
    added, dup = tglib.add_recipients(people, by="файл")

    print(f"файл: {SRC.name}")
    print(f"колонка с @username: №{ucol + 1}" + (f", имя: №{ncol + 1}" if ncol is not None else ""))
    print(f"{'людей в файле':44} {len(people)}")
    print(f"{'добавлено в очередь на рассылку':44} {added}")
    print(f"{'номера в базе не тронуты':44} {len(tglib.read_csv(tglib.NUMBERS)) - added}")
    if dup:
        print(f"{'уже были в очереди':44} {dup}")
    print(f"\nготово -> {OUT.name}")
    return True


def main() -> None:
    rows = rows_from(SRC)
    if not rows:
        sys.exit("файл пустой")

    width = max(len(r) for r in rows)
    # шапка, если она есть: по ней забираем длительность и число звонков.
    # Без этого повторный разбор уже собранной базы (наш же отчёт
    # «База_Telegram.xlsx») обнулял бы «Длит. всего» — колонку, которую
    # потом печатает make_base.py.
    head = [str(x or "").strip().lower() for x in rows[0]]
    def col_by(pattern):
        for i, h in enumerate(head):
            if re.search(pattern, h):
                return i
        return None
    dur_col = col_by(r"длит|duration|total_sec")
    calls_col = col_by(r"^(звонк\w*|calls)$")
    # колонка с номерами = где больше всего валидных мобильных
    scores = [sum(1 for r in rows if len(r) > c and normalize(r[c])) for c in range(width)]
    col = scores.index(max(scores))
    if max(scores) == 0:
        # номеров нет — может, это список участников чата (@username, имя)
        if usernames(rows, head, width):
            return
        sys.exit("не нашёл ни номеров, ни @username — проверь файл")

    # колонка с датой: где больше всего похожего на дату, рядом справа
    date_col = None
    for c in range(width):
        hits = sum(1 for r in rows[:200] if len(r) > c and re.search(r"\d{1,4}[.\-/]\d{1,2}[.\-/]\d{1,4}", str(r[c] or "")))
        if hits > len(rows[:200]) * 0.5:
            date_col = c; break

    stats = collections.Counter()
    seen: dict[str, dict] = {}
    for r in rows:
        if len(r) <= col:
            continue
        stats["строк"] += 1
        phone = normalize(r[col])
        if not phone:
            stats["отброшено (маска / не мобильный / заголовок)"] += 1
            continue
        rec = seen.setdefault(phone, {"phone": phone, "calls": 0, "last_call": "", "total_sec": 0})

        def num(c, default):
            if c is None or len(r) <= c:
                return default
            try:
                return int(float(r[c]))
            except (TypeError, ValueError):
                return default

        rec["calls"] += max(1, num(calls_col, 1))
        rec["total_sec"] += max(0, num(dur_col, 0))
        d = str(r[date_col] or "")[:19] if date_col is not None and len(r) > date_col else ""
        if d > rec["last_call"]:
            rec["last_call"] = d

    out = sorted(seen.values(), key=lambda x: x["last_call"], reverse=True)
    stats["номеров к проверке"] = len(out)

    with OUT.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=BASE_HEAD, lineterminator="\n")
        w.writeheader(); w.writerows(out)
    kept = restore_people()
    if kept:
        stats["людей из чатов оставлено в базе"] = kept

    print(f"файл: {SRC.name}")
    print(f"колонка с номерами: №{col + 1}" + (f", дата: №{date_col + 1}" if date_col is not None else ""))
    for k, v in stats.items():
        print(f"{k:44} {v}")
    print(f"\nготово -> {OUT.name}")


if __name__ == "__main__":
    main()
