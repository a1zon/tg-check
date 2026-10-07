#!/usr/bin/env python3
"""
Демо ИИ-синтеза портрета (на данных enrich-probe.json, без рассылки).

По каждому «богатому» портрету делает 2 вызова LLM:
  1) квалификация → JSON {niche, segment, motive}
  2) персональное первое сообщение от лица риелтора, с опорой на портрет

Только показывает результат в лог — ничего никому не шлёт.
    python ai-synth-probe.py --limit 4
"""
import json
import random
import re
import time

import tglib
import llm
from tglib import say


def leaked(text):
    """Похоже, что модель вывалила рассуждения вместо готового письма."""
    if not text:
        return False
    if re.search(r"the user wants|drafting|strategy:|key details|\boption\b", text, re.I):
        return True
    lat = len(re.findall(r"[A-Za-z]", text))
    cyr = len(re.findall(r"[А-Яа-я]", text))
    return cyr and lat > cyr * 0.5


def clean_leak(text):
    """Аварийно вытащить последний русский черновик из «мыслей» (последний абзац с кириллицей)."""
    cands = [p.strip(" «»\"") for p in re.split(r"\n+", text) if len(re.findall(r"[А-Яа-я]", p)) > 30]
    return cands[-1] if cands else text


def extract_json(text):
    """Достаём {…} из ответа, даже если модель налила рассуждений вокруг."""
    if not text:
        return None
    m = re.search(r"\{[^{}]*\"niche\"[^{}]*\}", text, re.S)
    if not m:
        m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None

QUALIFY_SYS = (
    "Ты квалифицируешь лида для риелтора из Екатеринбурга. По досье человека верни "
    "СТРОГО JSON без пояснений: {\"niche\":\"...\",\"segment\":\"...\",\"motive\":\"...\"}. "
    "niche — чем человек занимается (коротко). segment — тип (предприниматель / айтишник / "
    "инвестор / наёмный специалист / другое). motive — с какой зацепкой риелтору к нему заходить "
    "(одна фраза, по делу). Верни ТОЛЬКО JSON, без рассуждений и преамбул."
)
MSG_SYS = (
    "Ты — риелтор из Екатеринбурга. Напиши ПЕРВОЕ короткое сообщение в Telegram незнакомому "
    "человеку, опираясь на его портрет: зацепи конкретикой из его дела и мягко подведи к теме "
    "недвижимости или инвестиций в квартиры. Живой человеческий русский, без канцелярита, без "
    "клише и без ссылок. 2–4 предложения. Пиши сразу сообщение, без рассуждений и вступлений."
)


def dossier(p):
    parts = [f"Имя: {p.get('name') or '—'}"]
    if p.get("bio"):
        parts.append(f"Био профиля: {p['bio']}")
    if p.get("channel_about"):
        parts.append(f"Описание канала: {p['channel_about']}")
    if p.get("channel_posts"):
        parts.append("Последние посты: " + " | ".join(p["channel_posts"][:5]))
    if p.get("site_text"):
        parts.append(f"Сайт ({p.get('site_url')}): {p['site_text'][:800]}")
    return "\n".join(parts)


def main():
    limit = int(tglib.arg("limit", 4) or 4)
    data = json.loads((tglib.DIR / "enrich-probe.json").read_text("utf-8"))
    rich = [p for p in data if p.get("bio") or p.get("channel_about")
            or p.get("channel_posts") or p.get("site_text")]
    rich = rich[:limit]
    say(f"модель: {llm._cfg('LLM_MODEL')}  |  прокси: {bool(llm._cfg('LLM_PROXY'))}")
    say(f"портретов с сигналом: {len(rich)} (из {len(data)})\n")

    ok = 0
    for i, p in enumerate(rich, 1):
        d = dossier(p)
        uname = ("@" + p["username"]) if p.get("username") else f"id:{p.get('user_id')}"
        say(f"━━━ [{i}/{len(rich)}] {p.get('name')} ({uname}) ━━━")
        q = llm.chat(QUALIFY_SYS, d, max_tokens=700, temperature=0.2)
        if not q:
            say(f"  ⚠ квалификация не удалась: {llm.LAST_ERR}\n")
            continue
        j = extract_json(q)
        if j:
            say(f"  НИША: {j.get('niche','—')}  ·  СЕГМЕНТ: {j.get('segment','—')}")
            say(f"  МОТИВ: {j.get('motive','—')}")
        else:
            say(f"  КВАЛИФИКАЦИЯ (сырое): {q[:200]}")
        m = llm.chat(MSG_SYS, d, max_tokens=400, temperature=0.85)
        if m and leaked(m):   # reasoning-модель залила «мысли» — жёсткий ретрай
            m = llm.chat(MSG_SYS + " ВАЖНО: не рассуждай, не пиши по-английски. Только готовое сообщение на русском.",
                         d, max_tokens=300, temperature=0.7)
            if m and leaked(m):
                m = clean_leak(m)
        if m:
            ok += 1
            say(f"  ПИСЬМО: {m}")
        else:
            say(f"  ⚠ письмо не удалось: {llm.LAST_ERR}")
        say("")
        time.sleep(random.uniform(1.0, 2.0))

    say(f"ГОТОВО: полностью синтезировано {ok}/{len(rich)}")


if __name__ == "__main__":
    main()
