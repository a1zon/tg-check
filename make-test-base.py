#!/usr/bin/env python3
"""
Тестовая база — чтобы потренироваться на панели, никого не задев.

Номера берёт СВОИ: те, что уже отмечены в results.csv как «есть в Telegram».
Чужие сюда подставлять нельзя — черновик ляжет живому человеку в чат,
а с галочкой «отправлять сразу» ему же и уйдёт. Поэтому случайных номеров
скрипт не выдумывает: хочешь добавить свои — перечисли их сам.

Кроме рабочих строк кладёт заведомо негодные (городской, маскированный,
обрезанный, текст вместо номера) — панель должна их отбросить при разборе.
Дойти до Telegram они не могут: их отсеивает extract_numbers.py.

Второй способ — отрезать кусок от большой базы: так пробуют настоящие номера,
но небольшой пачкой. Тех, кого уже проверяли или кому уже писали, скрипт
выбрасывает сам — и по учёту рядом с исходником, и по учёту самой панели.
Иначе человек получил бы второе сообщение.

    python make-test-base.py
    python make-test-base.py --numbers +79045439815,+79120479425
    python make-test-base.py --from ~/Desktop/база/numbers.csv --take 50
    python make-test-base.py --out моя-тест-база.csv --rows 3
"""
import csv
import re
import sys
from datetime import date, timedelta
from pathlib import Path

import tglib

DIR = Path(__file__).resolve().parent

HEAD = ["Номер", "Дата звонка", "Звонков", "Длит. всего, с", "Комментарий"]

# заведомо негодные строки: панель обязана их выбросить при разборе базы
JUNK = [
    ["8 495 123-45-67", "2026-09-07", 1, 40, "городской — не мобильный, отбросится"],
    ["+7 904 543 45 00", "2026-09-07", 1, 55, "маска оператора (нули в конце), отбросится"],
    ["123", "2026-09-07", 1, 5, "обрезанный номер, отбросится"],
    ["нет номера", "2026-09-06", 1, 0, "текст вместо номера, отбросится"],
    ["", "", "", "", "пустая строка, отбросится"],
]


def found_in(path):
    return [r["phone"] for r in tglib.read_csv(path) if r.get("tg") == "true"]


def own_numbers():
    """
    Свои — те, у кого уже подтверждён Telegram: им черновик писать безопасно.
    После чистки панели results.csv пуст, поэтому смотрим ещё и в последний
    бэкап: номера-то остались теми же, заново их вспоминать незачем.
    """
    mine = found_in(tglib.RESULTS)
    if mine:
        return mine
    backups = sorted(DIR.glob("_*backup_*"), key=lambda p: p.name, reverse=True)
    for b in backups:
        mine = found_in(b / "results.csv")
        if mine:
            print(f"свои номера взял из бэкапа {b.name}")
            return mine
    return []


# ---------------------------------------------------- кусок от большой базы

def normalize(raw):
    """Тот же разбор номера, что и при загрузке базы в панель."""
    d = re.sub(r"\D", "", str(raw or ""))
    if len(d) == 11 and d[0] in "78":
        d = d[1:]
    if len(d) != 10 or not d.startswith("9") or d.endswith("00"):
        return None
    return "+7" + d


def rows_of(path):
    """Строки файла: xlsx или csv — как их видит панель."""
    if path.suffix.lower() in (".xlsx", ".xlsm"):
        import openpyxl
        ws = openpyxl.load_workbook(path, read_only=True, data_only=True).worksheets[0]
        return [list(r) for r in ws.iter_rows(values_only=True)]
    with path.open(encoding="utf-8-sig", errors="replace", newline="") as f:
        sample = f.read(4096)
        f.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
        except csv.Error:
            dialect = csv.excel
        return [r for r in csv.reader(f, dialect)]


def slice_base(src, take, skip):
    """
    Свежие `take` номеров из большой базы, кроме тех, что в skip.
    Колонки ищем так же, как панель: номера — где их больше всего,
    дата — первая колонка, похожая на дату.
    """
    rows = rows_of(src)
    if not rows:
        sys.exit(f"пусто: {src}")
    width = max(len(r) for r in rows)
    scores = [sum(1 for r in rows if len(r) > c and normalize(r[c])) for c in range(width)]
    col = scores.index(max(scores))
    if not max(scores):
        sys.exit(f"в файле нет мобильных номеров: {src}")
    head = [str(x or "").strip().lower() for x in rows[0]]

    def col_by(pattern, default=None):
        for i, h in enumerate(head):
            if re.search(pattern, h):
                return i
        return default

    date_col = col_by(r"last_call|дата|звонил")
    if date_col is None:
        for c in range(width):
            hits = sum(1 for r in rows[:200] if len(r) > c
                       and re.search(r"\d{1,4}[.\-/]\d{1,2}[.\-/]\d{1,4}", str(r[c] or "")))
            if hits > len(rows[:200]) * 0.5:
                date_col = c
                break
    calls_col = col_by(r"^(звонк\w*|calls)$")
    dur_col = col_by(r"длит|duration|total_sec")

    def cell(r, c, default=""):
        return r[c] if c is not None and len(r) > c and r[c] is not None else default

    seen, out, dropped = set(), [], set()
    for r in rows:
        phone = normalize(cell(r, col)) if len(r) > col else None
        if not phone or phone in seen:
            continue
        if phone in skip:
            dropped.add(phone)      # уже проверяли или писали — мимо
            continue
        seen.add(phone)
        out.append([phone, str(cell(r, date_col))[:19], cell(r, calls_col, 1), cell(r, dur_col, 0),
                    ""])
    # свежие сверху: перезванивать в первую очередь тем, кто звонил недавно
    out.sort(key=lambda x: x[1], reverse=True)
    return out[:take], len(seen), len(dropped)


def known(paths):
    """Номера, которых уже касались: проверяли или писали."""
    out = set()
    for p in paths:
        for r in tglib.read_csv(p):
            if r.get("phone"):
                out.add(r["phone"])
    return out


def build(numbers, rows_per):
    """Строки будущего файла. Один номер — несколько звонков в разные дни:
    панель их склеит в одну запись, сложит звонки и возьмёт последнюю дату."""
    out = [HEAD]
    today = date.today()
    for i, phone in enumerate(numbers):
        for k in range(rows_per):
            when = today - timedelta(days=2 + k * 3 + i)
            out.append([phone, when.isoformat(), k + 1, 60 + 30 * k,
                        f"свой номер №{i + 1}, звонок {k + 1}"])
    out.extend(JUNK)
    return out


def write_xlsx(path, rows):
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "звонки"
    for r in rows:
        ws.append(r)
    for col, width in zip("ABCDE", (18, 14, 10, 16, 42)):
        ws.column_dimensions[col].width = width
    # номер как текст: иначе Excel съест плюс и покажет 7.9E+10
    for cell in ws["A"]:
        cell.number_format = "@"
    wb.save(path)


def write_csv(path, rows):
    with Path(path).open("w", newline="", encoding="utf-8-sig") as f:
        csv.writer(f, delimiter=";").writerows(rows)


def main():
    src = tglib.arg("from", "")
    if src:
        return from_base(src)
    raw = tglib.arg("numbers", "")
    numbers = [n.strip() for n in raw.replace(" ", ",").split(",") if n.strip()] or own_numbers()
    if not numbers:
        sys.exit("Не нашёл ни одного своего номера (в results.csv нет отметок «есть в Telegram»).\n"
                 "Перечисли их сам:  python make-test-base.py --numbers +79045439815,+79120479425\n"
                 "Чужие номера сюда класть нельзя — черновик ляжет живому человеку.")
    rows_per = max(1, int(tglib.arg("rows", 2)))
    out = Path(tglib.arg("out", "тест-база.xlsx"))
    if not out.is_absolute():
        out = DIR / out

    rows = build(numbers, rows_per)
    if out.suffix.lower() in (".csv", ".tsv", ".txt"):
        write_csv(out, rows)
    else:
        write_xlsx(out, rows)

    print(f"номеров: {len(numbers)} — {', '.join(numbers)}")
    print(f"строк со звонками: {len(numbers) * rows_per}  |  негодных (панель отбросит): {len(JUNK)}")
    print(f"\nготово -> {out}")
    print("Дальше: перетащи файл в панель (шаг 2) либо укажи путь к нему там же.")


def out_path(default):
    out = Path(tglib.arg("out", default))
    return out if out.is_absolute() else DIR / out


def save(out, rows):
    if out.suffix.lower() in (".csv", ".tsv", ".txt"):
        write_csv(out, rows)
    else:
        write_xlsx(out, rows)


def from_base(src):
    """Отрезать от большой базы небольшую пачку — на пробу."""
    src = Path(src.replace("~", str(Path.home()), 1) if src.startswith("~") else src)
    if src.is_dir():
        found = next((src / n for n in ("numbers.csv",) if (src / n).exists()), None)
        src = found or sys.exit(f"в папке {src} нет numbers.csv — укажи файл базы")
    if not src.exists():
        sys.exit(f"не найден файл: {src}")

    raw_take = str(tglib.arg("take", 50)).strip().lower()
    take = 10 ** 9 if raw_take in ("all", "все", "всё") else max(1, int(raw_take))
    # учёт и рядом с исходником, и в самой панели: человек мог получить
    # черновик в прошлый заход, и второй раз ему писать нельзя
    skip = set()
    if not tglib.flag("all"):
        watch = [src.parent / "results.csv", src.parent / "drafts.csv",
                 tglib.RESULTS, tglib.DRAFTS]
        # и в бэкапах чисток: панель их обнуляет, а люди помнят, что им писали
        for b in sorted(DIR.glob("_*backup_*")):
            watch += [b / "results.csv", b / "drafts.csv"]
        skip = known(watch)

    rows, total, dropped = slice_base(src, take, skip)
    if not rows:
        sys.exit("после отсева не осталось ни одного номера")
    out = out_path(f"база-{len(rows)}.xlsx")
    save(out, [HEAD] + rows)

    print(f"исходник: {src}")
    print(f"номеров в нём годных: {total + dropped}")
    print(f"пропущено (уже проверяли или писали): {dropped}")
    print(f"взято свежих: {len(rows)}  |  звонки с {rows[-1][1][:10]} по {rows[0][1][:10]}")
    print(f"\nготово -> {out}")
    print("Дальше: перетащи файл в панель (шаг 2) либо укажи путь к нему там же.")


main()
