#!/usr/bin/env python3
"""
Разбор ответа @egrul_bot.

Бот присылает «краткий отчёт» одним текстом: реквизиты, адрес, руководитель,
учредители, финансы. Телефонов в ЕГРЮЛ нет и в отчёте их не бывает — поэтому
главная добыча тут не номер, а ЛПР: кто подписывает и чем владеет. Номер, если
он всё-таки встретится в тексте, тоже заберём.

Разбор держим отдельно от задачи-сборщика: его можно гонять на сохранённых
ответах, не трогая живые аккаунты.
"""
import re

# Телефон в тексте: +7/8, скобки и разделители. Доверяем только тому, что
# похоже на российский номер целиком, иначе в улов попадут ИНН и суммы.
PHONE = re.compile(r"(?:\+7|\b8)[\s(\-]*\d{3}[\s)\-]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}\b")

# «ИНН: /780529472710» — бот ставит слэш перед ИНН физлица
INN_IN = re.compile(r"ИНН:\s*/?(\d{10,12})")

# Строка-поле отчёта: «├ ИНН: 7810713362», «🏠 Адрес: ...»
FIELD = re.compile(r"^[├└│•\s]*(?:[^\w\s]+\s*)?([А-ЯЁа-яё ]+):\s*(.+)$")

ROLES = ("ГЕНЕРАЛЬНЫЙ ДИРЕКТОР", "ДИРЕКТОР", "ПРЕЗИДЕНТ", "РУКОВОДИТЕЛЬ",
         "УПРАВЛЯЮЩИЙ", "ЛИКВИДАТОР", "КОНКУРСНЫЙ УПРАВЛЯЮЩИЙ",
         "ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИМАТЕЛЬ", "ГЛАВА")

FIO = re.compile(r"^[А-ЯЁ][А-ЯЁ\-]+\s+[А-ЯЁ][А-ЯЁ\-]+(?:\s+[А-ЯЁ][А-ЯЁ\-]+)?$")


def _clean(s):
    return re.sub(r"\s+", " ", s or "").strip()


def phones(text):
    """Все похожие на телефон строки, приведённые к +7XXXXXXXXXX, без повторов."""
    out = []
    for raw in PHONE.findall(text or ""):
        d = re.sub(r"\D", "", raw)
        if len(d) == 11 and d[0] in "78":
            d = "+7" + d[1:]
        elif len(d) == 10:
            d = "+7" + d
        else:
            continue
        if d not in out:
            out.append(d)
    return out


NO_DATA = ("нет информации", "не указан", "отсутствует", "—", "-")
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")


def contacts(text):
    """
    Блок «Контактная информация» — он есть в отчёте по физлицу и ИП, но не по
    юрлицу. Именно ради него и спрашивают бота второй раз, уже про человека.
    Пустые поля бот заполняет словами «нет информации» — их отбрасываем.
    """
    out = {"phone": "", "email": "", "site": ""}
    block = re.search(r"Контактная информация:(.*?)(?:\n\s*\n|\Z)", text or "", re.S)
    if not block:
        return out
    body = block.group(1)
    for key, title in (("phone", "Телефон"), ("email", "E-?mail"), ("site", "Сайт")):
        m = re.search(rf"{title}:\s*([^\n]+)", body, re.I)
        if not m:
            continue
        val = _clean(re.sub(r"^[├└│•\s]*", "", m.group(1)))
        if not val or val.lower() in NO_DATA:
            continue
        out[key] = val
    if out["phone"]:
        found = phones(out["phone"])
        out["phone"] = found[0] if found else ""
    if out["email"]:
        m = EMAIL.search(out["email"])
        out["email"] = m.group(0).lower() if m else ""
    return out


def is_working(text):
    """Жива ли организация. Бот помечает кружком и словом."""
    if "🟢" in text or "Действующая" in text:
        return True
    if "🔴" in text or "Ликвидирован" in text or "Прекратил" in text:
        return False
    return None


def head_name(text):
    """Название из первой строки: «Краткий отчет по ООО "ГОРА"»."""
    m = re.search(r"Краткий отчет по\s+(.+)", text or "")
    # у физлица бот ставит двоеточие в конце строки — оно не часть имени
    return _clean(m.group(1)).rstrip(":").strip() if m else ""


def boss(text):
    """
    Кто подписывает: должность, ФИО и его ИНН. У бота это идёт блоком —
    строка с должностью, следом строка с человеком.
    """
    lines = [l.rstrip() for l in (text or "").split("\n")]
    for i, line in enumerate(lines):
        bare = _clean(re.sub(r"[^\w\s]", " ", line)).upper()
        if not any(bare.startswith(r) or bare == r for r in ROLES):
            continue
        role = next(r for r in ROLES if bare.startswith(r) or bare == r)
        for nxt in lines[i + 1:i + 3]:
            who = _clean(re.sub(r"\(.*?\)", "", nxt))
            if FIO.match(who):
                inn = INN_IN.search(nxt)
                return {"role": role.capitalize(), "name": who.title(),
                        "inn": inn.group(1) if inn else ""}
    return {}


def founders(text):
    """Учредители с долями — те же люди, что принимают решения."""
    out = []
    block = re.search(r"Учредител[ья][^\n]*\n(.*?)(?:\n\s*\n|\Z)", text or "", re.S)
    if not block:
        return out
    for line in block.group(1).split("\n"):
        who = _clean(re.sub(r"\(.*?\)", "", line.lstrip(" •·-")))
        who = re.sub(r"Доля:.*$", "", who).strip()
        if not who:
            continue
        inn = INN_IN.search(line)
        share = re.search(r"Доля:\s*([\d.,]+%?)", line)
        out.append({"name": who.title() if FIO.match(who) else who,
                    "inn": inn.group(1) if inn else "",
                    "share": share.group(1) if share else ""})
    return out


def field(text, title):
    """Значение поля отчёта по его названию: «Адрес», «ИНН», «ОГРН»."""
    m = re.search(rf"{title}:\s*([^\n]+)", text or "")
    return _clean(m.group(1)) if m else ""


def parse(text):
    """Всё, что вытаскиваем из одного ответа бота."""
    t = text or ""
    return {
        "company": head_name(t),
        "working": is_working(t),
        "inn": field(t, "ИНН"),
        "ogrn": field(t, r"ОГРН(?:ИП)?"),
        "address": field(t, "Адрес"),
        # у юрлица «вид деятельности», у физлица и ИП — «ОКВЭД»
        "activity": field(t, "Основной вид деятельности") or field(t, "Основной ОКВЭД"),
        "boss": boss(t),
        "founders": founders(t),
        "contacts": contacts(t),
        # телефоны из блока контактов и из всего остального текста, без повторов
        "phones": list(dict.fromkeys(
            ([contacts(t)["phone"]] if contacts(t)["phone"] else []) + phones(t))),
    }


def is_report(text):
    """Это уже отчёт или ещё «собираю данные…» / приветствие."""
    t = text or ""
    return "Краткий отчет" in t or "Отчет готов" in t or "Отчёт готов" in t


def is_waiting(text):
    return "Собираю данные" in (text or "")


# Бот пускает несколько бесплатных запросов, а дальше просит подписаться на
# свой канал. Подписка разовая — после неё он отвечает как раньше.
WANT_CHANNEL = re.compile(r"[Пп]одпишитесь на канал\s*@?([A-Za-z0-9_]+)")


def needs_channel(text):
    """На какой канал бот просит подписаться. Пусто — значит не просит."""
    m = WANT_CHANNEL.search(text or "")
    return m.group(1) if m else ""


def not_found(text):
    t = (text or "").lower()
    return "не найден" in t or "ничего не найдено" in t or "не нашел" in t or "не нашёл" in t
