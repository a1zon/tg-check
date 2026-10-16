/**
 * Учёт платного прокси Asocks (оплата за гигабайт).
 *
 * API Asocks знает только общий итог: баланс и «всего потрачено трафика»,
 * без разбивки по дням и без «за что». Поэтому раз в полчаса снимаем эти два
 * числа и складываем снимки в asocks-usage.jsonl: по разнице между снимками
 * видно, сколько ушло за сутки, неделю, месяц и на сколько хватит баланса.
 * «За что» считают сами задачи — каждая пишет свой трафик в traffic.csv.
 *
 * Деньги считаем по падению баланса (пополнение — скачок вверх — пропускаем):
 * так не нужно знать цену гигабайта, она бывает выше заявленной на сайте.
 *
 * Ключ лежит в asocks.json рядом с кодом на сервере (в git его нет):
 *   {"apiKey": "..."}
 */
import fs from 'node:fs';
import path from 'node:path';

// ASOCKS_API/ASOCKS_KEY — только для песочницы (поддельный Asocks); на сервере не заданы
const API = process.env.ASOCKS_API || 'https://api.asocks.com/';
export const ASOCKS_EVERY = 30 * 60_000;    // как часто снимаем баланс и итог трафика

export function makeAsocks({ dir }) {
  const KEY_FILE = path.join(dir, 'asocks.json');
  const LOG = path.join(dir, 'asocks-usage.jsonl');
  const PORTS = path.join(dir, 'asocks-ports.json');    // расход по портам — последний снимок

  const key = () => {
    if (process.env.ASOCKS_KEY) return process.env.ASOCKS_KEY;
    try { return String(JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')).apiKey || '').trim(); }
    catch { return ''; }
  };

  async function get(ep) {
    const k = key();
    const url = `${API}${ep}${ep.includes('?') ? '&' : '?'}apiKey=${encodeURIComponent(k)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`Asocks ответил ${r.status}`);
    const j = await r.json();
    if (j && j.success === false) throw new Error(j.message || 'Asocks: отказ');
    return j;
  }

  /** Снять баланс и итог трафика, дописать снимок. Без ключа — молча ничего. */
  async function snapshot() {
    if (!key()) return null;
    const [b, t] = await Promise.all([get('v2/user/balance'), get('v2/proxy/total-spent-traffic')]);
    const rec = {
      at: new Date().toISOString(),
      balance: Number(b.balance) || 0,
      bytes: Number(t.total_spent_traffic) || 0,
    };
    fs.appendFileSync(LOG, JSON.stringify(rec) + '\n');
    // у прода и теста разные порты (разные логины) — Asocks считает каждый отдельно
    try {
      const pr = await get('v2/proxy/ports');
      const list = ((pr.message || {}).proxies || []).map((x) => ({
        id: x.id, name: x.name || String(x.id),
        bytes: Number(x.spent_traffic_month) || 0, usd: Number(x.spent_money_month) || 0,
      }));
      fs.writeFileSync(PORTS, JSON.stringify({ at: rec.at, ports: list }) + '\n');
    } catch {}
    return rec;
  }

  function ports() {
    try { return JSON.parse(fs.readFileSync(PORTS, 'utf8')); } catch { return null; }
  }

  function history() {
    try {
      return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((r) => r && r.at);
    } catch { return []; }
  }

  /** Сколько трафика и денег ушло с момента since (мс): по снимкам. */
  function spentSince(h, since) {
    let bytes = 0, usd = 0;
    for (let i = 1; i < h.length; i++) {
      if (Date.parse(h[i].at) <= since) continue;
      const a = h[i - 1], b = h[i];
      bytes += Math.max(0, b.bytes - a.bytes);
      const drop = a.balance - b.balance;     // рост баланса — это пополнение, не расход
      if (drop > 0) usd += drop;
    }
    return { bytes, usd };
  }

  function summary() {
    const h = history();
    if (!key()) return { on: false };
    if (!h.length) return { on: true, empty: true };
    const now = Date.now();
    const last = h[h.length - 1];
    const day = spentSince(h, now - 864e5);
    const week = spentSince(h, now - 7 * 864e5);
    const month = spentSince(h, now - 30 * 864e5);
    // средний расход в сутки — по неделе, если данных меньше, — по тому, что есть
    const spanDays = Math.max(1 / 24, Math.min(7, (now - Date.parse(h[0].at)) / 864e5));
    const perDay = week.usd / spanDays;
    return {
      on: true, at: last.at, balance: last.balance, totalBytes: last.bytes,
      day, week, month, perDayUsd: perDay,
      usdPerGb: week.bytes > 1e6 ? week.usd / (week.bytes / 1e9) : null,
      runwayDays: perDay > 0 ? last.balance / perDay : null,
      since: h[0].at,
      ports: ports(),
    };
  }

  /**
   * Готовые мобильные сессии страны (v2/proxy/search): строки
   * http://логин:пароль@шлюз:порт, у каждой свой логин и обычно свой IP.
   * Ничего не создаёт и не стоит денег — платим только за трафик.
   */
  async function search(country = 'KZ') {
    if (!key()) throw new Error('Asocks не подключён: на сервере нет ключа API');
    const j = await get(`v2/proxy/search?country=${encodeURIComponent(country)}&types[]=mobile&limit=5000`);
    const list = (Array.isArray(j) ? j : (j.message || j.data || [])).filter((x) => typeof x === 'string');
    if (!list.length) throw new Error(`Asocks не отдал ни одной мобильной сессии для ${country}`);
    return list;
  }

  return { snapshot, summary, search, enabled: () => !!key() };
}
