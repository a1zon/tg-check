#!/usr/bin/env python3
"""
Делёжка базы между аккаунтами — тот же механизм, что в claims.mjs, и тот же
файл claims.json. Формат общий намеренно: пока часть задач ещё на Playwright,
а часть уже на Telethon, они обязаны видеть брони друг друга — иначе двое
пройдут по одному номеру и напишут человеку дважды.

Бронь протухает через час: упавший процесс не должен запереть номера навсегда.
"""
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

DIR = Path(__file__).resolve().parent
FILE = DIR / "claims.json"
LOCK = DIR / "claims.lock"
TTL = 60 * 60           # сколько живёт бронь, сек
LOCK_STALE = 15         # замок дольше этого — от упавшего процесса
WAIT_MAX = 20           # дольше не ждём: значит что-то совсем не так


def _now_iso():
    # ISO с Z — ровно как пишет Node, файл читают оба
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _parse_at(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


class _Lock:
    """Критическая секция поверх файла: создание с O_EXCL атомарно."""

    def __enter__(self):
        start = time.time()
        while True:
            try:
                self.fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                return self
            except FileExistsError:
                try:
                    if time.time() - LOCK.stat().st_mtime > LOCK_STALE:
                        LOCK.unlink()
                        continue
                except FileNotFoundError:
                    continue
                if time.time() - start > WAIT_MAX:
                    raise SystemExit("не дождался доступа к броням")
                time.sleep(0.06)

    def __exit__(self, *exc):
        try:
            os.close(self.fd)
        except OSError:
            pass
        try:
            LOCK.unlink()
        except FileNotFoundError:
            pass
        return False


def _read():
    try:
        data = json.loads(FILE.read_text("utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write(obj):
    FILE.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", "utf-8")


def _fresh(obj):
    now = time.time()
    return {k: v for k, v in obj.items() if now - _parse_at(v.get("at")) < TTL}


def take(account, task, candidates, n):
    """
    Забронировать до n номеров из candidates (в их порядке).
    Возвращает те, что достались нам: занятые другими пропускаются.
    """
    with _Lock():
        all_ = _fresh(_read())
        mine = []
        for phone in candidates:
            if len(mine) >= n:
                break
            # живая бронь блокирует всех, включая её владельца: она означает
            # «номер в работе». Иначе второй запуск того же аккаунта выдал бы
            # те же номера ещё раз.
            if phone in all_:
                continue
            all_[phone] = {"account": account, "task": task, "at": _now_iso()}
            mine.append(phone)
        _write(all_)
        return mine


def release(account, phone):
    """Снять бронь с номера: он уже отработан и записан в результаты."""
    with _Lock():
        all_ = _read()
        if all_.get(phone, {}).get("account") == account:
            del all_[phone]
        _write(all_)


def release_all(account, task=None):
    """Снять все брони аккаунта — на выходе из прогона, в том числе аварийном."""
    with _Lock():
        all_ = _read()
        for phone, v in list(all_.items()):
            if v.get("account") == account and (task is None or v.get("task") == task):
                del all_[phone]
        _write(all_)


def active():
    """Кто что держит прямо сейчас — для панели."""
    by = {}
    for v in _fresh(_read()).values():
        key = (v.get("account", ""), v.get("task", ""))
        by[key] = by.get(key, 0) + 1
    return [{"account": a, "task": t, "n": n} for (a, t), n in by.items()]
