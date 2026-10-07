/**
 * Числа, которые показывает панель: сколько проверено, найдено, написано,
 * сколько людей ответило — и накопительная сводка, переживающая чистку.
 */
import fs from 'node:fs';
import path from 'node:path';

const KEYS = ['checked', 'found', 'none', 'drafts', 'sent'];
const KEEP_WIPES = 20;   // столько последних чисток помним

export function makeStats({ DIR, readCsv }) {
  const CACHE = path.join(DIR, 'stats-cache.json');
  const REPLIES = path.join(DIR, 'replies.json');
  const RUNS = path.join(DIR, 'followup-runs.json');

  /** Текущие числа по файлам. */
  function counts() {
    const res = readCsv('results.csv');
    const dr = readCsv('drafts.csv');
    return {
      checked: res.filter((r) => ['true', 'false', 'idle'].includes(r.tg)).length,
      found: res.filter((r) => r.tg === 'true').length,
      none: res.filter((r) => r.tg === 'false').length,
      // есть в Telegram, но давно не заходят — им не пишем
      idle: res.filter((r) => r.tg === 'idle').length,
      drafts: dr.filter((r) => r.ok === 'true').length,
      sent: dr.filter((r) => r.sent === 'true').length,
    };
  }

  const cacheRead = () => {
    try {
      const o = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
      return { checked: 0, found: 0, none: 0, drafts: 0, sent: 0, since: '', wipes: [], ...o };
    } catch {
      return { checked: 0, found: 0, none: 0, drafts: 0, sent: 0, since: '', wipes: [] };
    }
  };

  /**
   * Прибавить к кешу то, что сейчас в файлах, и запомнить саму чистку.
   * Вызывать ДО того, как файлы унесут: иначе числа пропадут вместе с ними.
   */
  function fold(now, about) {
    const c = cacheRead();
    for (const k of KEYS) c[k] += now[k];
    if (!c.since) c.since = about.at;
    c.wipes = [{ ...about, ...now }, ...c.wipes].slice(0, KEEP_WIPES);
    fs.writeFileSync(CACHE, JSON.stringify(c, null, 2) + '\n');
    return c;
  }

  /** «За всё время» = кеш плюс нынешние файлы. */
  function total(now) {
    const c = cacheRead();
    const t = {};
    for (const k of KEYS) t[k] = c[k] + now[k];
    return { ...t, since: c.since, last: c.wipes[0] || null, wipes: c.wipes.length };
  }

  /**
   * Кто ответил. Главный источник — followup.csv: его раз в полчаса пополняет
   * автопрогон («Смотрит ответы»). replies.json пишет только ручная «Сводка»,
   * поэтому по нему одному счётчик неделями стоял на месте.
   * checkedAt — когда автопрогон последний раз заходил в диалоги
   * (followup-runs.json): так «0 ответов» отличается от «ещё не проверяли».
   */
  function replies() {
    const seen = new Map();
    let at = '';
    for (const r of readCsv('followup.csv')) {
      if (!r.key || seen.has(r.key)) continue;
      seen.set(r.key, { who: r.key, text: r.text || '', verdict: r.verdict, account: r.account, at: r.at });
      if (r.at > at) at = r.at;
    }
    try {
      const data = JSON.parse(fs.readFileSync(REPLIES, 'utf8')) || {};
      for (const v of Object.values(data)) {
        if (v?.at && v.at > at) at = v.at;
        for (const r of v?.replies || []) if (r?.who && !seen.has(r.who)) seen.set(r.who, r);
      }
    } catch {}
    let runs = {};
    try { runs = JSON.parse(fs.readFileSync(RUNS, 'utf8')) || {}; } catch {}
    const checks = Object.values(runs).map((v) => v?.at).filter(Boolean).sort();
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    return {
      n: seen.size, at, list: [...seen.values()].slice(-30).reverse(),
      checkedAt: checks.at(-1) || '',
      checkedLastHour: checks.filter((t) => t >= hourAgo).length,
      runs,
    };
  }

  return { counts, fold, total, replies };
}
