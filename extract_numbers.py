#!/usr/bin/env python3
"""
Готовит numbers.csv из базы: Excel (.xlsx) или CSV.

Колонку с номерами ищет сам — берёт ту, где больше всего похожих на
российские мобильные. Отсеивает дубликаты, немобильные и маскированные
номера (у которых последние цифры обнулены — такие не существуют).

    python3 extract_numbers.py <файл> [numbers.csv]
"""
import sys, csv, re, collections
from pathlib import Path

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
        sys.exit("не нашёл ни одного мобильного номера — проверь файл")

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
        w = csv.DictWriter(f, fieldnames=["phone", "calls", "last_call", "total_sec"])
        w.writeheader(); w.writerows(out)

    print(f"файл: {SRC.name}")
    print(f"колонка с номерами: №{col + 1}" + (f", дата: №{date_col + 1}" if date_col is not None else ""))
    for k, v in stats.items():
        print(f"{k:44} {v}")
    print(f"\nготово -> {OUT.name}")


if __name__ == "__main__":
    main()
