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

  /** Текущие числа по файлам. */
  function counts() {
    const res = readCsv('results.csv');
    const dr = readCsv('drafts.csv');
    return {
      checked: res.filter((r) => r.tg === 'true' || r.tg === 'false').length,
      found: res.filter((r) => r.tg === 'true').length,
      none: res.filter((r) => r.tg === 'false').length,
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
   * Кто ответил. Считает stats.py и кладёт в replies.json по аккаунтам —
   * панель показывает это числом, чтобы не заставлять читать журнал.
   */
  function replies() {
    let data = {};
    try { data = JSON.parse(fs.readFileSync(REPLIES, 'utf8')) || {}; }
    catch { return { n: 0, list: [], at: '' }; }
    const seen = new Map();
    let at = '';
    for (const v of Object.values(data)) {
      if (v?.at && v.at > at) at = v.at;
      for (const r of v?.replies || []) if (r?.who && !seen.has(r.who)) seen.set(r.who, r);
    }
    return { n: seen.size, at, list: [...seen.values()].slice(0, 30) };
  }

  return { counts, fold, total, replies };
}
