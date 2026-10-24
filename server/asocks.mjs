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

  /**
   * Основа для своих строк: логин кабинета (часть до «-pool»), пароль и порт —
   * из шаблона любого порта; id регионов страны — из справочника. Из этого
   * собирается строка «страна + регион + своя сессия» (server/ownproxy.mjs).
   */
  async function sessionBase(country = 'KZ') {
    if (!key()) throw new Error('Asocks не подключён: на сервере нет ключа API');
    const pr = await get('v2/proxy/ports');
    const t = ((pr.message || {}).proxies || []).map((x) => x.template).find((s) => /-pool-/.test(s || ''));
    const m = t && /^\w+:\/\/([^:]+?)-pool[^:]*:([^@]+)@[^:]+:(\d+)/.exec(t);
    if (!m) throw new Error('в кабинете Asocks нет ни одного порта — не из чего собрать строку');
    const cs = await get('v2/dir/countries');
    const list = Array.isArray(cs) ? cs : (cs.countries || cs.message || []);
    const c = (Array.isArray(list) ? list : []).find((x) => String(x.code || '').toUpperCase() === country);
    if (!c) throw new Error(`Asocks не знает страну ${country}`);
    const st = await get(`v2/dir/states?countryId=${c.id}`);
    const states = (Array.isArray(st) ? st : (st.states || st.message || [])).filter((x) => x && x.id && x.name);
    return { user: m[1], password: m[2], port: m[3], country, states: states.map((x) => ({ id: x.id, name: x.name })) };
  }

  /**
   * Личная ссылка перезапуска модема (refresh) для строки прокси этого порта.
   *
   * Зачем. У мобильного dedicated-порта закреплённое устройство иногда уходит
   * из сети, и порт начинает отвечать «404 Proxy not found in your region» —
   * шлюз жив, а бэкенда под портом нет. refresh переназначает порту живое
   * устройство. Раньше сторож прокси дёргал один ОБЩИЙ линк смены IP (наследие
   * единого пула); для своих портов он пустой, поэтому мёртвый порт мог лежать
   * сутками, а прогон и прогрев — стоять. Теперь у каждого порта своя ссылка:
   * id порта находим по логину (он есть в строке прокси и уникален на порт),
   * а ссылку собираем с ключом кабинета.
   *
   * Индекс портов кэшируем на 5 минут: сторож зовёт это только по лежащему
   * прокси и не чаще раза в 5 минут, лишний раз кабинет не дёргаем.
   */
  let portIdx = { at: 0, byKey: new Map() };
  async function portIndex() {
    if (portIdx.byKey.size && Date.now() - portIdx.at < 5 * 60_000) return portIdx.byKey;
    try {
      const pr = await get('v2/proxy/ports?per_page=500');
      const m = new Map();
      for (const x of ((pr.message || {}).proxies || [])) {
        if (x.login) m.set(String(x.login), x.id);     // по логину — основной путь
        if (x.proxy) m.set(String(x.proxy), x.id);     // по «шлюз:порт» — запасной
      }
      if (m.size) portIdx = { at: Date.now(), byKey: m };
    } catch {}
    return portIdx.byKey;
  }
  async function refreshLinkFor(raw) {
    const k = key();
    if (!k || !raw) return '';
    const mLogin = /:\/\/([^:/@]+):/.exec(String(raw));   // http://ЛОГИН:пароль@…
    // Строка общего пула (в том числе своя сессия «…-pool-…-session-…») — не порт:
    // личного refresh у неё нет. Запасной поиск по шлюз:порт находил для неё
    // порт-шаблон 242130836 (у всех сессий шлюз 190.2.137.56:9999) и рефрешил
    // его — сессию это не лечит, а порт общий. Нет ссылки — нет и refresh.
    if (mLogin && /-pool-/.test(mLogin[1])) return '';
    const mHp = /@([^@/]+:\d+)/.exec(String(raw));        // @шлюз:порт
    const idx = await portIndex();
    const id = (mLogin && idx.get(decodeURIComponent(mLogin[1])))
            || (mHp && idx.get(mHp[1])) || '';
    return id ? `${API}v2/proxy/refresh/${id}?apiKey=${encodeURIComponent(k)}` : '';
  }

  return { snapshot, summary, search, sessionBase, refreshLinkFor, enabled: () => !!key() };
}
