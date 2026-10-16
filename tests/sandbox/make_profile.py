"""
Выдуманный профиль панели для песочницы: аккаунты, журналы рассылки, чаты
режима «по чатам» и мир Telegram (world.json) для заглушки.

    venv-tg/bin/python tests/sandbox/make_profile.py <папка>

Папку создаёт с нуля (старую — удаляет, только если в ней лежит метка
песочницы .sandbox). Ни одного настоящего номера, ключа или сессии.
"""
import csv
import json
import shutil
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
NOW = datetime.now(timezone.utc)


def iso(dt):
    return dt.isoformat(timespec="seconds").replace("+00:00", "Z")


def ago(**kw):
    return iso(NOW - timedelta(**kw))


def write_csv(path, head, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(head)
        w.writerows(rows)


def main(dst):
    dst = Path(dst).resolve()
    if dst == REPO or REPO in dst.parents and dst.name != "profile":
        raise SystemExit("папка песочницы не должна быть внутри кода (кроме tests/sandbox/profile)")
    if dst.exists():
        if not (dst / ".sandbox").exists():
            raise SystemExit(f"{dst} существует и это не песочница — не трогаю")
        shutil.rmtree(dst)
    dst.mkdir(parents=True)
    (dst / ".sandbox").write_text("песочница — можно удалять\n", "utf-8")
    (dst / "sessions").mkdir()

    accs = []
    for i in range(1, 5):
        a = {"id": f"a{i}", "title": f"+7000000000{i}", "name": f"Тест {i}", "user_id": 9000 + i,
             "phone": f"7000000000{i}", "role": "send", "authed": True, "proxy": "", "dir": f"accounts/a{i}",
             "warmFrom": ago(days=30), "added": ago(days=30), "graduated": True,
             "spamOk": True, "spam": "Ваш аккаунт свободен от каких-либо ограничений"}
        accs.append(a)
        (dst / "sessions" / f"a{i}.session").write_bytes(b"")
    accs[1]["username"] = "test_two"         # своего можно найти по нику (переписка в прогреве)
    # a4 — временно ограничен SpamBot («жалоба»), как a9 на проде
    accs[3].update({"spamOk": False, "spamKind": "temp", "spamUntil": iso(NOW + timedelta(days=20)),
                    "spam": "временно до … по Екб — жалоба"})
    (dst / "accounts.json").write_text(json.dumps(accs, ensure_ascii=False, indent=2), "utf-8")

    # рассылка: кому писали (номера и ники), id получателей — для сверки в followup
    write_csv(dst / "drafts.csv", ["phone", "account", "ok", "sent", "at"], [
        ["+79000000001", "a1", "true", "true", ago(hours=30)],
        ["+79000000002", "a1", "true", "true", ago(hours=29)],
        ["@lead_three", "a2", "true", "true", ago(days=3)],
        ["+79000000004", "a3", "true", "true", ago(days=12)],   # давно — «тихий» аккаунт
    ])
    write_csv(dst / "sent-ids.csv", ["key", "user_id", "account", "at"], [
        ["+79000000001", "5001", "a1", ago(hours=30)],
        ["+79000000002", "5002", "a1", ago(hours=29)],
        ["@lead_three", "5003", "a2", ago(days=3)],
        ["+79000000004", "5004", "a3", ago(days=12)],
    ])
    # режим «по чатам»: a2 разбирал «Недвижимость Екб», a3 писал участнику «Ипотеки»
    write_csv(dst / "members.csv", ["key", "username", "name", "user_id", "chat", "at", "by"], [
        ["@flat_fan", "flat_fan", "Олег", "6001", "Недвижимость Екб", ago(days=5), "a2"],
        ["@ipo_man", "ipo_man", "Ира", "6002", "Ипотека Екб", ago(days=5), "a1"],
    ])
    write_csv(dst / "chats" / "drafts.csv", ["phone", "account", "ok", "sent", "at"], [
        ["@ipo_man", "a3", "true", "true", ago(days=2)],
    ])
    (dst / "chats.json").write_text(json.dumps({
        "100": {"title": "Недвижимость Екб", "username": "ekb_flat", "at": ago(days=5), "n": 1, "done": True},
        "200": {"title": "Ипотека Екб", "username": "ekb_ipoteka", "at": ago(days=5), "n": 1, "done": True},
        "300": {"title": "Новостройки Урала", "username": "ural_new", "at": ago(days=5), "n": 0, "done": True},
        "400": {"title": "Закрытый клуб", "at": ago(days=5), "n": 0, "done": True},    # без ника
    }, ensure_ascii=False, indent=2), "utf-8")

    (dst / "warmup.json").write_text(json.dumps(
        {"on": True, "rotate": "", "rotateWait": 10, "maxCap": 0, "checkMax": 20, "warmDays": 7,
         "between": True, "per": {}}, ensure_ascii=False, indent=2), "utf-8")
    wl = json.loads((REPO / "warm-list.default.json").read_text("utf-8"))
    wl.setdefault("comments", {})
    wl["comments"].update({"on": True, "typing": [1, 2], "read_pause": [0, 1], "held_accounts": ["a4"],
                           "approve_first": 1})
    (dst / "warm-list.json").write_text(json.dumps(wl, ensure_ascii=False, indent=2), "utf-8")

    # ------------------------------------------------------------ мир Telegram
    users = {}
    for i in range(1, 5):
        users[str(9000 + i)] = {"id": 9000 + i, "first_name": f"Тест {i}",
                                "username": "test_two" if i == 2 else None}
    leads = {5001: ("Анна", None, "79000000001"), 5002: ("Пётр", None, "79000000002"),
             5003: ("Лена", "lead_three", None), 5004: ("Гоша", None, "79000000004")}
    for uid, (n, u, p) in leads.items():
        users[str(uid)] = {"id": uid, "first_name": n, "username": u, "phone": p}
    for uid in range(7001, 7041):                     # посторонние диалоги — «шум»
        users[str(uid)] = {"id": uid, "first_name": f"Знакомый {uid}"}
    for uid, n in ((6001, "Олег"), (6002, "Ира"), (6003, "Марина"), (6004, "Сергей"), (6005, "Бот")):
        users[str(uid)] = {"id": uid, "first_name": n, "username": None, "bot": uid == 6005}

    def dm(texts):
        return [{"id": k + 1, "out": out, "text": t, "date": d, "read": out}
                for k, (out, t, d) in enumerate(texts)]

    dms = {"a1": {}, "a2": {}, "a3": {}, "a4": {}}
    for k, uid in enumerate(range(7001, 7041)):       # 40 старых диалогов у a1
        dms["a1"][str(uid)] = dm([(False, "привет", ago(days=20 + k)), (True, "привет!", ago(days=20 + k))])
    dms["a1"]["5001"] = dm([(True, "Здравствуйте! Помогу с покупкой квартиры…", ago(hours=30)),
                            (False, "да, актуально, двушку ищем", ago(hours=1))])
    dms["a1"]["5002"] = dm([(True, "Здравствуйте! Помогу с покупкой квартиры…", ago(hours=29))])
    dms["a2"]["5003"] = dm([(True, "Здравствуйте! …", ago(days=3)), (False, "не интересно", ago(days=1))])
    dms["a3"]["5004"] = dm([(True, "Здравствуйте! …", ago(days=12))])

    def gm(rows):
        return [{"id": k + 1, "from_id": uid, "text": t, "date": d, **({"reply_to": r} if r else {})}
                for k, (uid, t, d, r) in enumerate(rows)]

    chats = {
        "100": {"id": 100, "title": "Недвижимость Екб", "username": "ekb_flat",
                "members": [6001, 6002, 6003, 9002],
                "messages": gm([(6003, "Всем привет", ago(hours=50), None),
                                (6001, "Подскажите, сколько сейчас торгуются на вторичке на Уралмаше?",
                                 ago(minutes=40), None),
                                (6005, "🔥 Розыгрыш квартиры! Жми t.me/spam", ago(minutes=30), None)])},
        "200": {"id": 200, "title": "Ипотека Екб", "username": "ekb_ipoteka",
                "members": [6002, 6004],
                "messages": gm([(6004, "Сколько обычно банк одобряет ипотеку, если доход белый?",
                                 ago(hours=2), None),
                                (6002, "ок", ago(hours=1), None)])},
        "300": {"id": 300, "title": "Новостройки Урала", "username": "ural_new",
                "members": [6003, 6004],
                "messages": gm([(6003, "Кто брал в ЖК на Широкой речке, как застройщик со сроками?",
                                 ago(hours=3), None),
                                (6004, "смотрите сайт https://example.com там всё", ago(hours=2), None)])},
        "400": {"id": 400, "title": "Закрытый клуб", "private": True, "members": [], "messages": []},
    }
    world = {"accounts": {a["id"]: {"user_id": a["user_id"], "name": a["name"], "phone": a["phone"]}
                          for a in accs},
             "users": users, "dms": dms, "chats": chats, "pinned": {"a1": ["7040"]}}
    (dst / "world.json").write_text(json.dumps(world, ensure_ascii=False, indent=1), "utf-8")
    print(dst)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).parent / "profile"))
