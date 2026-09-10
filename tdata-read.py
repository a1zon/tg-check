#!/usr/bin/env python3
"""
Достаёт ключи авторизации из папки tdata (Telegram Desktop).

Печатает JSON в stdout, всё остальное — в stderr, чтобы вызывающая сторона
читала только данные:

    {"accounts": [{"dc_id": 2, "auth_key": "<hex>", "user_id": 123}]}

    python tdata-read.py <папка tdata | архив .zip> [пароль от tdata]

Формат tdata закрытый и зашифрованный, поэтому разбираем его библиотекой
opentele (порт кода самого Telegram Desktop). На Python 3.13+ ей нужна
правка совместимости — её ставит patch-opentele.py.
"""
import sys, json, zipfile, tempfile, shutil
from pathlib import Path


def say(*a):
    print(*a, file=sys.stderr)


def find_tdata(root: Path) -> Path:
    """Папка tdata может лежать в архиве на любом уровне — ищем её."""
    if root.name.lower() == "tdata" and root.is_dir():
        return root
    if (root / "tdata").is_dir():
        return root / "tdata"
    for p in root.rglob("tdata"):
        if p.is_dir():
            return p
    # иногда кладут содержимое tdata без самой папки
    if (root / "key_datas").exists():
        return root
    raise SystemExit("не нашёл папку tdata внутри")


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("как пользоваться: python tdata-read.py <папка tdata | .zip> [пароль]")

    src = Path(sys.argv[1]).expanduser()
    passcode = sys.argv[2] if len(sys.argv) > 2 else None
    if not src.exists():
        raise SystemExit(f"нет такого пути: {src}")

    tmp = None
    try:
        if src.is_file() and zipfile.is_zipfile(src):
            tmp = Path(tempfile.mkdtemp(prefix="tdata-"))
            say(f"распаковываю {src.name}…")
            with zipfile.ZipFile(src) as z:
                z.extractall(tmp)
            base = find_tdata(tmp)
        else:
            base = find_tdata(src)

        say(f"читаю {base}")
        try:
            from opentele.td import TDesktop
        except BaseException as e:
            raise SystemExit(
                "не работает opentele: " + str(e).split("\n")[0] +
                "\nпоставь и почини:  pip install opentele && python patch-opentele.py")

        desk = TDesktop(str(base), passcode=passcode)
        if not desk.isLoaded():
            raise SystemExit(
                "tdata не открылась. Обычно это значит, что на ней стоит "
                "локальный пароль — передай его вторым аргументом.")

        out = []
        for acc in desk.accounts:
            key = getattr(acc.authKey, "key", None)
            if not key:
                continue
            out.append({
                "dc_id": int(acc.MainDcId),
                "auth_key": bytes(key).hex(),
                "user_id": int(acc.UserId or 0),
            })
        if not out:
            raise SystemExit("внутри tdata нет ни одного авторизованного аккаунта")

        say(f"аккаунтов в tdata: {len(out)}")
        json.dump({"accounts": out}, sys.stdout)
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
