#!/usr/bin/env python3
"""
Разовый сбор нишевых чатов для комментинга.

От каналов-семян идём по РОДНЫМ рекомендациям Telegram (channels.GetChannelRecommendations,
бесплатно, свой аккаунт) и обходим граф на несколько уровней. Берём только каналы
С ПУБЛИЧНОЙ ГРУППОЙ ОБСУЖДЕНИЯ (комменты пишутся в неё, и comments.py резолвит её
по @нику) и прошедшие гейты: минимум подписчиков, не офф-топик по названию, и оценка
НИШИ моделью (как scoreTopicRelevance у референса). Находки дозаписываем в chats.json
в том же формате, что читает comments.py ({id: {title, username, at, n}}).

Запуск (разово, лучше с одного аккаунта-искателя; Premium даёт полнее рекомендации):
    python discover-chats.py --account a1 \
        --seeds @ekb_novostroyki,@nedvizhka_ekb \
        --niche "недвижимость, новостройки и аренда в Екатеринбурге" \
        --levels 2 --min-subs 500 --score 0.5 --limit 200 [--dry]

--dry — ничего не писать в chats.json, только показать, что нашлось бы.
"""
import asyncio
import json
import random
import re
from datetime import datetime, timezone

import tglib
import llm
from comments import norm_chat, off_topic, DEFAULTS

CHATS = tglib.DIR / "chats.json"


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


async def niche_score(client, channel, niche):
    """0.0–1.0: насколько канал по заданной нише. Оценивает модель по названию,
    описанию и нескольким последним постам. Непонятный ответ → 0 (отсеять)."""
    title = getattr(channel, "title", "") or ""
    about = ""
    posts = []
    try:
        msgs = await client.get_messages(channel, limit=5)
        posts = [(m.message or "").strip() for m in msgs if getattr(m, "message", None)]
    except Exception:
        pass
    body = "\n".join(f"- {p[:200]}" for p in posts) or "(постов нет)"
    prompt = (
        f"Оцени от 0.0 до 1.0, насколько этот Telegram-канал по теме: «{niche}».\n"
        "0.8–1.0 — почти весь контент по теме; 0.4–0.6 — смежное; 0.0–0.2 — не по теме.\n"
        "Верни ТОЛЬКО число.\n\n"
        f"Название: {title}\nОписание: {about or '(нет)'}\nПоследние посты:\n{body}"
    )
    try:
        out = llm.chat("", prompt, max_tokens=8, temperature=0, model=DEFAULTS.get("model"))
        m = re.search(r"[01](?:\.\d+)?", str(out))
        return max(0.0, min(1.0, float(m.group()))) if m else 0.0
    except Exception:
        return 0.0


async def discussion_group(client, channel):
    """Вернуть (группа_обсуждения, подписчики_канала) или (None, subs), если группы
    нет / она без публичного @ника (такую comments.py не резолвит)."""
    from telethon.tl.functions.channels import GetFullChannelRequest
    full = await client(GetFullChannelRequest(channel=channel))
    subs = getattr(full.full_chat, "participants_count", 0) or 0
    linked = getattr(full.full_chat, "linked_chat_id", None)
    if not linked:
        return None, subs
    grp = next((c for c in full.chats if getattr(c, "id", None) == linked), None)
    if not grp or not getattr(grp, "username", None):
        return None, subs
    return grp, subs


async def main():
    acc = tglib.resolve(tglib.arg("account", ""))
    # терпимо к формату: широкое ＠(U+FF20), обычный @, ссылки t.me/…, запятые/пробелы
    seeds = []
    for s in str(tglib.arg("seeds", "")).replace("＠", "@").replace(",", " ").split():
        s = re.sub(r"^(https?://)?(www\.)?(t\.me|telegram\.me)/", "", s.strip(), flags=re.I).strip("/")
        s = s.lstrip("@").strip()
        if s:
            seeds.append(s)
    niche = str(tglib.arg("niche", "")).strip()
    levels = int(tglib.arg("levels", 2))
    min_subs = int(tglib.arg("min-subs", 500))
    threshold = float(tglib.arg("score", 0.5))
    limit = int(tglib.arg("limit", 200))
    max_seen = int(tglib.arg("max-seen", 1500))   # потолок осмотренных каналов (анти-флуд/время)
    dry = tglib.flag("dry")
    if not seeds:
        raise SystemExit("нужны семена: --seeds @канал1,@канал2")
    if not niche:
        raise SystemExit("нужна ниша для оценки: --niche \"...\"")

    cfg = {"skip_title": DEFAULTS["skip_title"]}
    existing = {}
    try:
        existing = json.loads(CHATS.read_text("utf-8"))
    except Exception:
        existing = {}
    have_users = {norm_chat((r or {}).get("username")) for r in existing.values()}
    have_users.discard("")

    from telethon.tl.functions.channels import GetChannelRecommendationsRequest
    from telethon.errors import FloodWaitError

    client = await tglib.connect(acc)
    found = {}          # id(str) -> запись чата
    seen = set()        # id каналов, которые уже осматривали (recommendations)
    examined = 0

    async def gentle():
        await asyncio.sleep(random.uniform(2, 5))

    async def recommend(entity):
        try:
            res = await client(GetChannelRecommendationsRequest(channel=entity))
            return list(res.chats or [])
        except FloodWaitError as e:
            if e.seconds <= 120:
                tglib.say(f"флуд-пауза {e.seconds}с"); await asyncio.sleep(e.seconds)
                try:
                    res = await client(GetChannelRecommendationsRequest(channel=entity)); return list(res.chats or [])
                except Exception:
                    return []
            tglib.say(f"флуд {e.seconds}с (>2 мин) — останавливаю обход"); raise SystemExit(0)
        except Exception:
            return []

    try:
        # очередь обхода: (канал-entity, уровень)
        frontier = []
        for s in seeds:
            try:
                frontier.append((await client.get_entity(s), 0))
            except Exception as e:
                tglib.say(f"семя {s} не открылось: {type(e).__name__}")
            await gentle()

        while frontier and len(found) < limit and examined < max_seen:
            entity, lvl = frontier.pop(0)
            cid = getattr(entity, "id", None)
            if cid in seen:
                continue
            seen.add(cid)

            recs = await recommend(entity)
            await gentle()
            for ch in recs:
                if len(found) >= limit or examined >= max_seen:
                    break
                if getattr(ch, "id", None) in seen:
                    continue
                examined += 1
                title = getattr(ch, "title", "") or ""
                if off_topic(title, cfg):
                    continue
                try:
                    grp, subs = await discussion_group(client, ch)
                except FloodWaitError as e:
                    if e.seconds <= 120:
                        await asyncio.sleep(e.seconds); continue
                    tglib.say(f"флуд {e.seconds}с — стоп"); break
                except Exception:
                    continue
                await gentle()
                if grp is None or subs < min_subs:
                    continue
                uname = norm_chat(grp.username)
                if not uname or uname in have_users or uname in {norm_chat(v.get("username")) for v in found.values()}:
                    continue
                sc = await niche_score(client, ch, niche)
                await gentle()
                if sc < threshold:
                    continue
                gid = str(getattr(grp, "id", uname))
                found[gid] = {"title": getattr(grp, "title", title) or title,
                              "username": grp.username, "at": _now(), "n": 0,
                              "score": round(sc, 2), "via": getattr(entity, "username", "") or str(cid)}
                tglib.say(f"+ @{grp.username} · {found[gid]['title'][:40]} · subs {subs} · ниша {sc:.2f}")
                # глубже: рекомендованный канал тоже семя на следующий уровень
                if lvl + 1 < levels:
                    frontier.append((ch, lvl + 1))
    finally:
        await tglib.aclose(client)

    tglib.say(f"\nитог: осмотрено каналов {examined}, подошло чатов {len(found)}")
    if not found:
        tglib.say("ничего нового не нашлось (или всё уже в chats.json)")
        return
    if dry:
        tglib.say("--dry: в chats.json ничего не записал")
        return
    merged = dict(existing)
    merged.update(found)
    tmp = CHATS.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(merged, ensure_ascii=False, indent=0), "utf-8")
    tmp.replace(CHATS)
    tglib.say(f"записал в chats.json: было {len(existing)}, стало {len(merged)} (+{len(found)})")


if __name__ == "__main__":
    asyncio.run(main())
