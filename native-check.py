#!/usr/bin/env python3
"""
Пакетная проверка аккаунтов НАТИВНО, через Telethon (MTProto) — родной канал
десктопа, в обход Telegram Web. Отвечает на вопрос «аккаунт реально живой или
это веб-канал его отверг».

Находит в папке все аккаунты (.zip с tdata, папки tdata, .session) и по
каждому печатает: жив / мёртв / ошибка.

    python native-check.py <папка> [socks5://user:pass@host:port]
    TG_NATIVE_PROXY=socks5://user:pass@host:port python native-check.py <папка>

ВАЖНО про сеть: нужен доступ к дата-центрам Telegram (MTProto). Если Telegram
у провайдера режется (как в РФ) — нужен прокси, который пропускает Telegram
(не любой: многие прокси блокируют дата-центры Telegram, оставляя только веб).

Без прокси не подключаемся (как и задачи панели): аккаунты панели идут через
свои прокси, остальным нужен общий (прямой выход нарочно — TG_ALLOW_DIRECT=1).
Страна выхода проверяется перед каждым подключением (tg-native.py).
"""
import os, sys, json, subprocess, zipfile, tempfile, shutil
from pathlib import Path

HERE = Path(__file__).parent
PY = sys.executable


def find_accounts(root: Path):
    """Возвращает список (метка, вид, путь) — что можно скормить tg-native.py."""
    out = []
    for p in sorted(root.rglob("*")):
        if p.suffix.lower() == ".zip":
            out.append((p.stem, "tdata/zip", ("--tdata", str(p))))
        elif p.suffix.lower() == ".session":
            out.append((p.stem, "session", ("--session", str(p))))
    # голые папки tdata (без архива)
    for p in sorted(root.rglob("tdata")):
        if p.is_dir():
            out.append((p.parent.name, "tdata", ("--tdata", str(p))))
    # убираем дубли по пути
    seen, uniq = set(), []
    for label, kind, args in out:
        if args[1] in seen:
            continue
        seen.add(args[1]); uniq.append((label, kind, args))
    return uniq


def check(args, proxy):
    cmd = [PY, str(HERE / "tg-native.py"), *args]
    env = dict(os.environ)
    if proxy:
        env["TG_NATIVE_PROXY"] = proxy     # не аргументом: строку с паролем видно в ps
    r = subprocess.run(cmd, capture_output=True, text=True, env=env)
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        return {"state": "error", "error": (r.stderr.strip().splitlines()[-1:] or ["нет ответа"])[0]}


def main():
    if len(sys.argv) < 2:
        sys.exit("как пользоваться: python native-check.py <папка> [прокси]")
    root = Path(sys.argv[1]).expanduser()
    proxy = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("TG_NATIVE_PROXY", "")
    if not root.exists():
        sys.exit(f"нет папки: {root}")

    accs = find_accounts(root)
    if not accs:
        sys.exit("не нашёл ни .zip, ни .session, ни папок tdata")

    import tglib
    direct = os.environ.get("TG_ALLOW_DIRECT") == "1"
    print(f"найдено аккаунтов: {len(accs)}" + (
        f", прокси: {tglib.proxy_label(proxy)}" if proxy
        else ", без общего прокси — аккаунты панели через свои, остальные "
             + ("напрямую (TG_ALLOW_DIRECT=1)" if direct else "не подключаю")))
    print("-" * 60)
    alive = 0
    nonet = [0]
    refused = 0
    for label, kind, args in accs:
        res = check(args, proxy)
        st = res.get("state")
        if st == "ok":
            alive += 1
            who = res.get("username") or res.get("name") or res.get("user_id")
            print(f"✓ ЖИВ    {label:22} [{kind}]  {who}  {res.get('phone','')}")
        elif st == "dead":
            print(f"✕ мёртв  {label:22} [{kind}]  ключ отозван")
        else:
            err = res.get("error", "")
            netfail = "failed" in err or "timed out" in err or "ConnectionError" in err
            hint = "нет связи с Telegram (нужен VPN/прокси)" if netfail else err
            print(f"?  {'НЕТ СВЯЗИ' if netfail else 'ошибка  '} {label:22} [{kind}]  {hint}")
            if netfail:
                nonet[0] += 1
            refused += "не задан прокси" in err
    print("-" * 60)
    if refused:
        print(f"⚠ {refused} аккаунт(ов) без прокси — не подключал. Дай общий прокси вторым "
              "аргументом или TG_NATIVE_PROXY (прямой выход нарочно — TG_ALLOW_DIRECT=1).")
    if nonet[0]:
        print(f"⚠ {nonet[0]} аккаунт(ов) не проверить — Telegram недоступен по MTProto.")
        print("  Это НЕ значит, что они мёртвые. Включи VPN или прокси, пропускающий")
        print("  Telegram, и запусти снова. «мёртв» и «жив» — только когда связь есть.")
    print(f"живых: {alive} из {len(accs)}")


if __name__ == "__main__":
    main()
