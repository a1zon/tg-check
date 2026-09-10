#!/usr/bin/env python3
"""
Правка совместимости opentele с Python 3.13+.

В 3.13 у классов появились служебные поля __firstlineno__ и
__static_attributes__. Декоратор @extend_class в opentele видит их как
чужие атрибуты и падает ещё на импорте. Дописываем их в список
игнорируемых — правка идемпотентная, повторный запуск ничего не меняет.

    python patch-opentele.py
"""
import sys, io
from pathlib import Path

OLD = '["__abstractmethods__", "__module__", "_abc_impl", "__doc__"]'
NEW = ('["__abstractmethods__", "__module__", "_abc_impl", "__doc__",\n'
       '                      "__firstlineno__", "__static_attributes__"]')

try:
    import opentele  # noqa: F401  — если импортируется, править нечего
    print("opentele работает, правка не нужна")
    sys.exit(0)
except BaseException:
    pass

found = [p for p in map(Path, sys.path) if (p / "opentele" / "utils.py").exists()]
if not found:
    sys.exit("не нашёл opentele — поставь: pip install opentele")

f = found[0] / "opentele" / "utils.py"
src = io.open(f, encoding="utf-8").read()
if "__firstlineno__" in src:
    print("правка уже стоит")
elif OLD not in src:
    sys.exit(f"не узнал файл {f} — видимо, версия opentele другая")
else:
    io.open(f, "w", encoding="utf-8").write(src.replace(OLD, NEW, 1))
    print(f"поправил {f}")

try:
    from opentele.td import TDesktop  # noqa: F401
    print("opentele импортируется")
except BaseException as e:
    sys.exit(f"всё равно не работает: {e}")
