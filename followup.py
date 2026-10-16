#!/usr/bin/env python3
"""
Второй шаг воронки: ссылка уходит только тем, кто ответил на первое сообщение
согласием.

Первое письмо — вопрос без ссылки (его шлёт draft-messages.py, текст в
message.txt). Ссылку в первом же сообщении незнакомому человеку Telegram не
любит, да и человек тоже. Поэтому второе письмо — из message2.txt — уходит
тем, кто ответил, и только если ответ положительный.

Отвечал человек или нет, смотрим по его же чату: если последнее сообщение
в диалоге НЕ наше, значит ответил. Никаких вечно висящих обработчиков событий
тут не нужно: держать живое соединение на каждый аккаунт — это постоянная
активность с одного адреса, ровно то, чего мы избегаем в один поток.

Что именно ответил, решает модель (llm.py): да / нет / неясно. «Нет» — больше
не пишем никогда, только ставим 🤝 на ответ. «Неясно» и сбой модели — не
пишем вовсе: ссылка не должна уйти человеку, который отказался, только
потому что модель промолчала.

Итог по каждому помним в followup.csv — второй раз человек ссылку не получит.

    python followup.py --account a1 --limit 2
    python followup.py --account a1 --limit 2 --send
"""
import asyncio
import json
import random
import re

import llm
import tglib
from tglib import say

DELAY_MIN, DELAY_MAX = 180, 350
DIALOGS = 200                 # столько последних диалогов просматриваем
# text — сам ответ человека (для вкладки «Результаты»: видно, что за «да»)
HEAD = ["key", "account", "sent", "at", "verdict", "msg", "text"]
FILE = tglib.DIR / "followup.csv"
MESSAGE2 = tglib.DIR / "message2.txt"
# когда и что нашёл каждый проход — без этого «0 ответов» не отличить от «не заходили»
RUNS = tglib.DIR / "followup-runs.json"
# тексты ответов, записанных до появления колонки text: дотягиваем по id сообщения
# в отдельный файл — followup.csv дописывают параллельно, переписывать его целиком нельзя
TEXTS = tglib.DIR / "followup-texts.json"
# переписка с ответившими — целиком, от их первого ответа: её показывает вкладка
# «Результаты». Файл на аккаунт: задачи разных аккаунтов идут параллельно
TALKS = tglib.DIR / "talks"
TALK_MAX = 60        # столько последних сообщений диалога храним
TALK_TEXT = 1500     # и столько символов одного сообщения
TALK_READS = 40      # больше диалогов за заход не перечитываем — остальные в следующий


def load_talks(acc_id):
    try:
        d = json.loads((TALKS / f"{acc_id}.json").read_text("utf-8"))
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def save_talks(acc_id, talks):
    TALKS.mkdir(exist_ok=True)
    tmp = TALKS / f"{acc_id}.json.tmp"
    tmp.write_text(json.dumps(talks, ensure_ascii=False) + "\n", "utf-8")
    tmp.replace(TALKS / f"{acc_id}.json")     # разом: панель не прочтёт половину файла


def media_label(m):
    """Что прислали вместо текста (или вместе с ним) — словами."""
    if m.voice:
        return "🎤 голосовое"
    if m.video_note:
        return "⏺ видеосообщение"
    if m.sticker:
        return "стикер"
    if m.gif:
        return "GIF"
    if m.photo:
        return "🖼 фото"
    if m.video:
        return "🎬 видео"
    if m.document:
        return "📎 файл"
    if m.geo or m.venue:
        return "📍 место"
    if m.contact:
        return "👤 контакт"
    return "вложение"


async def read_talk(client, ent):
    """Переписка от первого ответа человека: [[наше 1/0, время unix, текст], …]."""
    msgs = []
    async for m in client.iter_messages(ent, limit=TALK_MAX):
        if m.action:
            continue                  # служебное: «вступил», «звонок» и т.п.
        text = (m.message or "").strip()
        if m.media and not m.web_preview:
            text = f"{text}\n[{media_label(m)}]" if text else f"[{media_label(m)}]"
        msgs.append([1 if m.out else 0, int(m.date.timestamp()), text[:TALK_TEXT]])
    msgs.reverse()
    first = next((i for i, x in enumerate(msgs) if not x[0]), None)
    return msgs[first:] if first is not None else []


async def backfill_texts(client, acc_id, dialogs, by_key, by_id):
    """Ответы без текста у этого аккаунта — достаём само сообщение по сохранённому msg id."""
    try:
        texts = json.loads(TEXTS.read_text("utf-8"))
        if not isinstance(texts, dict):
            texts = {}
    except Exception:
        texts = {}
    need = {r["key"]: r.get("msg", "") for r in tglib.read_csv(FILE)
            if r.get("account") == acc_id and not r.get("text") and r.get("key") not in texts}
    if not need:
        return
    got = 0
    for d in dialogs:
        if not d.is_user:
            continue
        k = whose(d.entity, by_key, by_id)
        if k not in need or not str(need[k]).isdigit():
            continue
        try:
            m = await client.get_messages(d.entity, ids=int(need[k]))
        except Exception:
            continue
        if m and m.message:
            texts[k] = tglib.cell(m.message)[:300]
            got += 1
    if got:
        TEXTS.write_text(json.dumps(texts, ensure_ascii=False, indent=2) + "\n", "utf-8")
        say(f"восстановил тексты старых ответов: {got}")


def mark_run(account, dialogs, answered, fresh):
    try:
        data = json.loads(RUNS.read_text("utf-8"))
        if not isinstance(data, dict):
            data = {}
    except Exception:
        data = {}
    data[account] = {"at": tglib.now_iso(), "dialogs": dialogs, "answered": answered, "fresh": fresh}
    RUNS.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", "utf-8")

VERDICT_SYS = (
    "Риелтор из Екатеринбурга написал человеку первым: предложил помощь с покупкой "
    "квартиры и консультацию, попросил ответить, если это актуально, а если нет — "
    "так и написать, и он больше не побеспокоит. Риелтор ведёт не только покупку: "
    "продажа, обмен, ипотека — тоже его работа.\n"
    "Тебе дан ответ человека. Определи, есть ли смысл продолжать разговор.\n"
    "ДА — покупка актуальна, интересно, задаёт вопросы по делу (цены, варианты, ипотека), "
    "просит прислать или рассказать. Короткое «да», «ага», «+», «актуально» — тоже ДА.\n"
    "НЕТ — человек закрывает разговор целиком: неактуально, уже купил, не интересует, "
    "просит не писать, ругается.\n"
    "НЕЯСНО — непонятно, кто пишет, ответ не по теме, только приветствие, автоответ бота. "
    "Сюда же — человек отказывается именно от ПОКУПКИ, но разговор не закрывает: "
    "«покупкой не занимаюсь», «я продаю», «сам риелтор», «интересует другое». "
    "С продажей и обменом риелтор тоже помогает, такой диалог разбирают руками.\n"
    "Ответь ОДНИМ словом: ДА, НЕТ или НЕЯСНО. Без рассуждений."
)
VERDICT_RE = re.compile(r"\b(НЕЯСНО|НЕТ|ДА|UNCLEAR|YES|NO)\b", re.I)
VERDICT_MAP = {"да": "yes", "yes": "yes", "нет": "no", "no": "no",
               "неясно": "unclear", "unclear": "unclear"}


def recipients(ours):
    """
    Как узнать в диалоге того, кому писали. Ключ в журнале — номер, @ник или
    id:<id>, а Telegram в диалоге отдаёт другое:
      • ник в настоящем регистре, а в журнале — как набрали в таблице
        (на тестовом профиле 16.10 так «не видно» было 4 диалога из 6);
      • номер — только если человек его открыл: контакт после письма мы
        удаляем, и у скрывшего номер его в диалоге нет;
      • ник человек мог сменить или убрать.
    Поэтому ник и номер сверяем без учёта регистра, а по id — где он известен:
    его пишет рассылка при отправке (sent-ids.csv) и разбор чатов (members.csv).
    Для старых писем по номеру — ник, который видела проверка номеров.
    """
    by_key = {k.lower(): k for k in ours}
    for f in (tglib.DIR / "results.csv", tglib.CHATS_DIR / "results.csv"):
        for r in tglib.read_csv(f):
            u = (r.get("username") or "").lstrip("@").lower()
            if u and r.get("phone") in ours:
                by_key.setdefault("@" + u, r["phone"])
    by_id = {}
    for f in (tglib.MEMBERS, tglib.SENT_IDS):
        for r in tglib.read_csv(f):
            if r.get("user_id") and r.get("key") in ours:
                by_id[str(r["user_id"])] = r["key"]
    return by_key, by_id


def whose(entity, by_key, by_id):
    """Ключ из журнала для собеседника — или None, если мы ему не писали."""
    phone = "+" + str(entity.phone) if getattr(entity, "phone", None) else ""
    for k in (phone, tglib.member_key(getattr(entity, "username", None), entity.id)):
        if k and k.lower() in by_key:
            return by_key[k.lower()]
    return by_id.get(str(entity.id))


def written_by_us():
    """Кому мы уже писали первое письмо — по журналам рассылки обоих наборов:
    второе письмо не зависит от того, какой режим сейчас выбран в панели."""
    return {r["phone"] for f in tglib.ALL_DRAFTS for r in tglib.read_csv(f)
            if r.get("sent") == "true" or r.get("ok") == "true"}


def history():
    """
    Что уже решили по каждому: ссылка ушла или отказ — это навсегда; «неясно»
    запоминаем вместе с id последнего сообщения, чтобы не гонять модель по тому
    же ответу каждые полчаса, но переспросить, когда человек допишет.
    """
    final, unclear = set(), {}
    for r in tglib.read_csv(FILE):
        if r.get("sent") == "true" or r.get("verdict") in ("no", "yes"):
            final.add(r["key"])
        elif r.get("verdict") == "unclear":
            unclear[r["key"]] = r.get("msg", "")
    return final, unclear


def classify(reply):
    """yes / no / unclear, либо None — модель не ответила, решим в следующий раз."""
    # модель изредка отдаёт пустой ответ — это не «неясно», просто спросим ещё раз
    for _ in range(3):
        out = llm.chat(VERDICT_SYS, reply, max_tokens=600, temperature=0)
        # reasoning-модель может налить рассуждений — итог обычно в конце
        found = VERDICT_RE.findall(out or "")
        if found:
            return VERDICT_MAP[found[-1].lower()]
    return None


async def shake_hands(client, ent, msg_id):
    """
    На «нет» не пишем ничего — обещали же больше не беспокоить. Но и молча
    бросить нельзя: реакция 🤝 на ответ — вежливое «понял, спасибо» без
    нового сообщения. Если в этом чате 🤝 недоступна — ставим 👍.
    """
    from telethon import functions, types
    for emo in ("🤝", "👍"):
        try:
            await client(functions.messages.SendReactionRequest(
                peer=ent, msg_id=msg_id, reaction=[types.ReactionEmoji(emoticon=emo)]))
            await client.send_read_acknowledge(ent)
            say(f"    отказ — поставил {emo}, больше не пишем")
            return
        except Exception as e:
            err = str(e).splitlines()[0][:90]
    say(f"    отказ — реакция не встала ({err}), больше не пишем")


async def their_reply(client, ent):
    """Всё, что человек написал после нашего последнего сообщения, — одним текстом."""
    parts = []
    async for m in client.iter_messages(ent, limit=15):
        if m.out:
            break
        if m.message:
            parts.append(m.message)
    return "\n".join(reversed(parts))


async def main():
    acc = tglib.resolve(tglib.arg("account", ""))
    limit = int(tglib.arg("limit", 2))
    delay = float(tglib.arg("delay", DELAY_MIN))
    delay_max = float(tglib.arg("delay-max", max(delay, DELAY_MAX)))
    send = tglib.flag("send")

    # полный отдых после заморозки — даже не читаем диалоги (это тоже подключение)
    rest = tglib.full_rest_left(acc)
    if rest > 0:
        say(f"«{acc['title']}» на полном отдыхе после заморозки ещё "
            f"{rest // 3600} ч {rest % 3600 // 60} мин — ответы не смотрю")
        tglib.state(done=0, left=0)
        return
    # «без рассылки» — ответы смотреть можно, а второе письмо людям не шлём
    if send and tglib.send_hold_left(acc) > 0:
        say("аккаунт без рассылки после заморозки — только смотрю ответы, второе письмо не шлю")
        send = False

    # Текст второго письма нужен, только чтобы ЕГО отправлять. Просто смотреть,
    # кто ответил (для статистики и ручной работы), можно и без него.
    text2_raw = tglib.fix_placeholders(MESSAGE2.read_text("utf-8").strip()) if MESSAGE2.exists() else ""
    # во втором письме подставляется только ссылка — остальное ушло бы со скобками
    bad2 = tglib.bad_placeholders(text2_raw, ("LINK", "link"))
    if send and bad2:
        say(f"во втором письме непонятные подстановки: {', '.join(bad2)} — второе письмо "
            "не шлю, только смотрю ответы (поправь текст в панели)")
        send = False
    if send and not text2_raw:
        say("нет текста второго письма — напиши его в панели (шаг «Что напишем»)")
        raise SystemExit(1)

    say(f"аккаунт: {acc['title']}  |  второй шаг воронки"
        f"{'' if send else ' (только смотрю, ничего не шлю)'}  |  "
        f"{tglib.proxy_label(acc.get('proxy'))}")

    ours, (final, unclear) = written_by_us(), history()
    by_key, by_id = recipients(ours)
    client = await tglib.connect(acc)
    tglib.ensure_head(FILE, HEAD)
    # у старого файла нет колонки text — дописываем шапку, строки не трогаем
    raw = FILE.read_text("utf-8")
    if raw.split("\n", 1)[0].split(",") != HEAD:
        FILE.write_text(",".join(HEAD) + "\n" + (raw.split("\n", 1)[1] if "\n" in raw else ""), "utf-8")

    replied = []
    talks, talk_reads, talks_new = load_talks(acc["id"]), 0, False
    try:
        dialogs = await client.get_dialogs(limit=DIALOGS)
        answered = 0
        for d in dialogs:
            if not d.is_user or d.entity.bot:
                continue
            who = whose(d.entity, by_key, by_id)
            if not who:
                continue
            last = d.message
            # Переписку целиком — для «Результатов» — перечитываем, только когда в
            # диалоге появилось новое. Впервые — у тех, кто уже отвечал
            known = talks.get(who)
            spoke = known or who in final or who in unclear or (last and not last.out)
            if (last and spoke and (not known or known.get("last_id") != last.id)
                    and talk_reads < TALK_READS):
                talk_reads += 1
                try:
                    msgs = await read_talk(client, d.entity)
                except Exception as e:
                    msgs = []
                    say(f"  переписку {who} не прочитал: {type(e).__name__}")
                if msgs:
                    talks[who] = {"last_id": last.id, "msgs": msgs}
                    talks_new = True
                await asyncio.sleep(random.uniform(0.3, 0.7))
            # ответил — значит последнее слово в диалоге не наше
            if not last or last.out:
                continue
            answered += 1
            if who in final or unclear.get(who) == str(last.id):
                continue
            replied.append((who, d.entity, last.id))

        if talks_new:
            save_talks(acc["id"], talks)
        mark_run(acc["id"], len(dialogs), answered, len(replied))
        await backfill_texts(client, acc["id"], dialogs, by_key, by_id)
        say(f"проверил ответы: диалогов {len(dialogs)}, ответили из базы {answered}, новых {len(replied)}")
        say(f"ответили и ещё не разобраны: {len(replied)}")
        if not replied:
            tglib.state(done=0, left=0)
            return

        sent_n = yes_n = 0
        for who, ent, last_id in replied:
            if yes_n >= limit:
                break
            reply = await their_reply(client, ent)
            verdict = classify(reply) if reply.strip() else "unclear"
            preview = " ".join(reply.split())[:80]
            label = {"yes": "ДА", "no": "НЕТ", "unclear": "НЕЯСНО"}.get(verdict, "модель молчит")
            say(f"{who} — «{preview}» → {label}")
            if verdict is None:
                say(f"    пропускаю до следующего захода: {llm.LAST_ERR}")
                continue
            # Ответ фиксируем ВСЕГДА — для статистики и чтобы оператор дальше
            # работал руками. Второе письмо шлём отдельно, только если включено.
            if verdict != "yes":
                if send and verdict == "no":
                    await shake_hands(client, ent, last_id)
                tglib.append_row(FILE, [who, acc["id"], "false", tglib.now_iso(),
                                        verdict, str(last_id), tglib.cell(reply)[:300]], HEAD)
                if verdict == "unclear":
                    say("    не пишу — посмотри этот диалог руками")
                continue
            yes_n += 1
            if not send:
                # второе письмо выключено — просто фиксируем «да», дальше руками
                tglib.append_row(FILE, [who, acc["id"], "false", tglib.now_iso(),
                                        "yes", str(last_id), tglib.cell(reply)[:300]], HEAD)
                say("    ответил «да» — записал, дальше руками")
                continue
            # на каждого — свой вариант и свежая ссылка-зеркало; метка src
            # попадает в таблицу заявок сайта — видно, что человек пришёл отсюда
            link = tglib.current_link()
            if link:
                link += ("&" if "?" in link else ("?" if link.endswith("/") else "/?")) + "src=tg-followup"
            text2 = tglib.spin(text2_raw).replace("{LINK}", link).replace("{link}", link)
            try:
                # превью ссылки тут не нужно — см. draft-messages.py
                await client.send_message(ent, text2, link_preview=False)
                await client.send_read_acknowledge(ent)
            except Exception as e:
                say(f"    не ушло: {str(e).splitlines()[0][:90]}")
                continue
            tglib.append_row(FILE, [who, acc["id"], "true", tglib.now_iso(),
                                    verdict, str(last_id), tglib.cell(reply)[:300]], HEAD)
            sent_n += 1
            say(f"    ссылка отправлена {who}: «{' '.join(text2.split())}»")
            if yes_n < limit:
                wait = random.uniform(delay, max(delay, delay_max))
                say(f"    пауза {wait:.0f} с")
                await asyncio.sleep(wait)
    finally:
        await tglib.aclose(client)

    say(f"\nготово: вторых писем отправлено {sent_n if send else 0}"
        + ("" if send else " (режим просмотра — ничего не ушло)"))
    tglib.state(done=sent_n if send else 0, left=max(0, len(replied) - (limit if send else 0)))


asyncio.run(main())
