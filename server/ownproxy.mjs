/**
 * Свой IP каждому аккаунту — своя постоянная строка Asocks.
 *
 * Зачем. Пока у всех аккаунтов одна строка прокси, панель водит их строго по
 * одному (ownProxyEach), а Telegram видит пачку аккаунтов за одним адресом.
 *
 * Как устроено (с 16.10, после замеров). Сначала брали готовые сессии из
 * v2/proxy/search — это чужие телефоны: за 2.5 минуты у 5 из 18 сменился IP, а
 * одна «казахская» сессия вышла из Колумбии. Теперь каждому аккаунту собираем
 * СВОЮ строку: страна + регион + своя сессия —
 *     <логин>-pool-mobile-country-KZ-state-<регион>-session-<метка>
 * Asocks держит на такой строке один IP, а если устройство пропало — даёт другое
 * в том же регионе: страна и регион не меняются никогда. Регион у аккаунта
 * закреплён навсегда (при замене меняется только метка сессии).
 *
 * Перед выдачей строка проверяется: ответила, выход из нужной страны, IP одинаковый
 * на двух запросах, шлюз пускает CONNECT к дата-центру Telegram, такого IP нет у
 * другого аккаунта. Не прошла — новая метка. Прежний прокси — в proxyPrev.
 * Шлюз в строке всегда 190.2.137.56:9999: до Telegram доходит только он.
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const ASOCKS_GATEWAY = '190.2.137.56:9999';
export const OWN_COUNTRY = 'KZ';
// регионы с самым большим мобильным пулом; аккаунты раскладываются по ним по кругу
// проверенные регионы KZ с живым мобильным пулом (16.10 прогон по всем 21:
// Astana в тот момент без IP, East Kazakhstan выходил из Германии — их тут нет).
// Аккаунты раскладываются по этим городам по кругу → разные операторы/узлы, совпадений IP почти нет.
const KZ_REGIONS = ['Almaty', 'Shymkent', 'Karaganda', 'Pavlodar Region', 'Qostanay Oblysy',
  'Atyrau Oblysy', "Aktyubinskaya Oblast'", 'North Kazakhstan', 'Zhambyl Oblysy', "Mangistauskaya Oblast'",
  'Qyzylorda Oblysy', 'Abai Region'];
export const OWN_REGIONS = (process.env.TG_ASOCKS_REGIONS
  ? process.env.TG_ASOCKS_REGIONS.split(',').map((s) => s.trim()).filter(Boolean)
  : KZ_REGIONS);
// Регион не дал свободного IP за maxTries — пробуем самые свободные соседние
// регионы профиля (по ESCAPE_TRIES строк в каждом). Замер 24.10, 8 новых сессий:
// Karaganda дала 3 разных IP, Almaty — 7. Привязка к тонкому региону без выхода
// сажала аккаунты на одни и те же модемы.
const ESCAPE_TRIES = 3;
const ESCAPE_REGIONS = 3;
const TG_DC = '149.154.167.51:443';       // DC2: прокси должен пускать к нему (MTProto)
const BASE_TTL = 24 * 3600_000;           // логин/пароль/регионы кабинета перечитываем раз в сутки
const PROBE_URL = 'http://ipinfo.io/json'; // http, без TLS: ~1 КБ трафика на проверку
const OTHERS_FRESH = 2 * 60_000;          // снимок IP соседнего профиля старше — пробуем заново
const CHANGES_KEEP = 7 * 864e5;           // историю смен IP аккаунта держим неделю
const CHANGES_MAX = 20;                   // и не больше стольких записей на аккаунт
const PRUNE_AFTER = 3600_000;             // запись аккаунта, которого нет в реестре, старше — вычищаем

// Замороженный и выведенный из работы к Telegram почти не ходят: их строку не
// меняем, а их IP занятым не считаем — в тонком пуле он отнимал адрес у живых
// (замороженный c5 держал за собой IP Караганды и получил ещё 3 новые строки).
export const ownDormant = (a) => a?.spamKind === 'frozen' || !!a?.retired;

// hasSession(a) — есть ли у аккаунта сессия Telegram. Нет — строка ему первая
// выдача до входа (Telegram этот IP ещё не видел): в историю смен (changes) не
// пишем, как proxy_buy.first_assignment при импорте. Не передали — у всех есть.
export function makeOwnProxy({ dir, asocks, gateway = ASOCKS_GATEWAY, listAccounts, otherProxies = () => [],
                               liveIp = () => '', setProxy, note = () => {}, regions = OWN_REGIONS,
                               hasSession = () => true }) {
  const FILE = path.join(dir, 'asocks-sessions.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; } };
  const save = (d) => {
    // временный файл — свой у процесса: тот же файл пишет и импорт (Python)
    const tmp = `${FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(d, null, 1) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  };

  /**
   * Записи аккаунтов, которых больше нет в реестре: их IP блокировали выдачу
   * (c1/c4/c5/n2 месяц спустя), а новый аккаунт с тем же id унаследовал бы чужой
   * регион. Свежие (до часа) не трогаем — импорт пишет запись раньше, чем
   * аккаунт появляется в реестре. Возвращает, вычистили ли что-нибудь.
   */
  function prune(d) {
    const ids = new Set(listAccounts().map((a) => a.id));
    const old = Date.now() - PRUNE_AFTER;
    let cut = false;
    for (const [id, v] of Object.entries(d.assigned || {})) {
      if (!ids.has(id) && !(Date.parse(v?.at || '') > old)) { delete d.assigned[id]; cut = true; }
    }
    for (const [id, h] of Object.entries(d.changes || {})) {
      const last = Array.isArray(h) && h.length ? Date.parse(h[h.length - 1].at || '') : 0;
      if (!ids.has(id) && !(last > old)) { delete d.changes[id]; cut = true; }
    }
    return cut;
  }

  /** Сколько раз аккаунтам меняли IP начиная с since (мс): id -> число. Переживает перезапуск. */
  function changes(since) {
    const out = new Map();
    for (const [id, h] of Object.entries(load().changes || {})) {
      out.set(id, (Array.isArray(h) ? h : []).filter((x) => Date.parse(x.at || '') >= since).length);
    }
    return out;
  }

  /** Логин строки — по нему сверяем, не занята ли она. */
  const sessionId = (s) => {
    try { return decodeURIComponent(new URL(String(s)).username) || String(s); } catch { return String(s); }
  };

  async function base(country) {
    const d = load();
    const b = (d.base || {})[country];
    if (b && Date.now() - b.at < BASE_TTL && b.states?.length) return b;
    const fresh = { ...(await asocks.sessionBase(country)), at: Date.now() };
    d.base = { ...(d.base || {}), [country]: fresh };
    save(d);
    return fresh;
  }

  /** Новая строка: регион аккаунта + новая метка сессии. */
  const build = (b, stateId) =>
    `http://${b.user}-pool-mobile-country-${b.country}-state-${stateId}-session-${crypto.randomBytes(4).toString('hex')}` +
    `:${b.password}@${gateway}`;

  /** Выход через прокси: { ip, country, city, org } или {} — не ответил. */
  function exitIp(raw) {
    return new Promise((done) => {
      // прокси — через окружение, а не аргументом: в списке процессов пароль не
      // светится (как в стороже). no_proxy убираем: с ним curl пошёл бы напрямую
      const env = { ...process.env, http_proxy: raw, https_proxy: raw, HTTPS_PROXY: raw, ALL_PROXY: raw };
      delete env.no_proxy; delete env.NO_PROXY;
      const c = spawn('curl', ['-s', '--max-time', '20', PROBE_URL], { env });
      let out = '';
      c.stdout.on('data', (b) => { out += b; });
      c.on('error', () => done({}));
      c.on('close', () => {
        try {
          const j = JSON.parse(out);
          done(j.ip ? { ip: j.ip, country: j.country || '', city: j.city || '', org: String(j.org || '').slice(0, 40) } : {});
        } catch { done({}); }
      });
    });
  }

  /** Пускает ли шлюз к дата-центру Telegram: CONNECT до DC2, ответ 200. */
  function reachesTelegram(raw) {
    return new Promise((done) => {
      let u;
      try { u = new URL(raw); } catch { return done(false); }
      const auth = u.username
        ? 'Proxy-Authorization: Basic ' + Buffer.from(
          `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64') + '\r\n'
        : '';
      const sock = net.connect(Number(u.port) || 80, u.hostname);
      let buf = '';
      const end = (ok) => { sock.destroy(); done(ok); };
      sock.setTimeout(15_000, () => end(false));
      sock.on('error', () => end(false));
      sock.on('connect', () => sock.write(`CONNECT ${TG_DC} HTTP/1.1\r\nHost: ${TG_DC}\r\n${auth}\r\n`));
      sock.on('data', (b) => {
        buf += b.toString('latin1');
        if (buf.includes('\r\n')) end(/^HTTP\/1\.[01] 200/.test(buf));
      });
    });
  }

  /** Годится ли строка: { ok, ip, country, city, org } или { ok:false, why }. */
  async function check(raw, country) {
    const a = await exitIp(raw);
    if (!a.ip) return { ok: false, why: 'не ответила' };
    if (country && a.country && a.country !== country) return { ok: false, why: `выход из ${a.country}, а не ${country}` };
    const b = await exitIp(raw);
    if (b.ip !== a.ip) return { ok: false, why: 'IP скачет между запросами' };
    if (!(await reachesTelegram(raw))) return { ok: false, why: 'шлюз не пускает к Telegram' };
    return { ok: true, ...a };
  }

  let busy = false;
  /**
   * Выдать своим строкам аккаунтам ids. Возвращает [{ id, ok, ip, org, region, why, tries }].
   * Одновременно идёт одна выдача: две параллельные могли бы дать двоим один IP.
   *   reasons    — id -> почему меняем (уходит в историю смен IP);
   *   keepRegion — эти id меняем только внутри закреплённого региона, без выхода
   *                в соседние (замена из-за дубля: см. ниже).
   */
  async function assign({ ids, country = OWN_COUNTRY, maxTries = 6, reasons = {}, keepRegion = [] }) {
    if (busy) throw new Error('раздача уже идёт — дождись её');
    busy = true;
    try {
      const b = await base(country);
      const all = listAccounts();
      const targets = all.filter((a) => ids.includes(a.id));
      const d0 = load();
      const prevAssigned = d0.assigned || {};
      // Занятые IP — по ЖИВЫМ данным сторожа, запись из выдачи только запасом:
      // Asocks сам меняет устройство под строкой, записанный IP устаревает, и
      // сверка по нему пропускала новую строку на адрес, который уже держит сосед.
      const usedIps = new Set();
      for (const a of all) {
        if (ids.includes(a.id) || !a.proxy || ownDormant(a)) continue;
        const ip = liveIp(a.proxy) || prevAssigned[a.id]?.ip;
        if (ip) usedIps.add(ip);
      }
      // и IP соседнего профиля, вживую: регионы у профилей разные, но пулы
      // Asocks на краях пересекаются (Almaty иногда выходит через Павлодар).
      // Выдача с выходом в соседние регионы идёт минутами, а сосед за это время
      // может уехать на новый адрес — снимок старше OTHERS_FRESH пробуем заново
      let otherIps = new Set(), othersAt = 0;
      const othersHave = async (ip) => {
        if (Date.now() - othersAt >= OTHERS_FRESH) {
          const r = await Promise.all(otherProxies().map((p) => exitIp(p)));
          otherIps = new Set(r.map((x) => x.ip).filter(Boolean));
          othersAt = Date.now();
        }
        return otherIps.has(ip);
      };
      const byName = new Map(b.states.map((s) => [s.name, s]));
      const pool = regions.filter((r) => byName.has(r));
      if (!pool.length) throw new Error(`ни одного из регионов ${regions.join(', ')} нет у Asocks для ${country}`);
      // сколько аккаунтов уже сидит в каждом регионе профиля (кроме тех, кого меняем)
      const regionLoad = new Map(pool.map((r) => [r, 0]));
      for (const a of all) {
        const r = prevAssigned[a.id]?.region;
        if (!ids.includes(a.id) && !ownDormant(a) && regionLoad.has(r)) regionLoad.set(r, regionLoad.get(r) + 1);
      }
      const byLoad = () => [...pool].sort((x, y) => regionLoad.get(x) - regionLoad.get(y));
      const res = [];
      for (const a of targets) {
        // регион закреплён, пока он в списке профиля; выпал из списка или его не
        // было — самый свободный. Не нашли свободный IP в своём — соседние.
        // Но не для дубля (keepRegion): живой аккаунт, который лишь делит модем
        // с соседом, за 1000 км ради уникальности не переносим — стабильный IP
        // важнее, а одновременно с одного адреса панель их и так не водит
        const was = prevAssigned[a.id]?.region;
        const pinned = !!was && pool.includes(was);
        const first = pinned ? was : byLoad()[0];
        const order = pinned && keepRegion.includes(a.id) ? [first]
          : [first, ...byLoad().filter((r) => r !== first)].slice(0, 1 + ESCAPE_REGIONS);
        let got = null, why = '', tries = 0, region = first;
        for (const [k, r] of order.entries()) {
          const st = byName.get(r);
          for (let n = 0; n < (k === 0 ? maxTries : ESCAPE_TRIES); n++) {
            tries++;
            const s = build(b, st.id);
            const c = await check(s, country);
            if (!c.ok) { why = c.why; continue; }
            if (usedIps.has(c.ip) || await othersHave(c.ip)) { why = 'такой IP уже у другого аккаунта'; continue; }
            got = { s, ...c };
            region = r;
            break;
          }
          if (got) break;
        }
        if (!got) { res.push({ id: a.id, ok: false, region: first, why: `${tries} строк подряд не подошли (${why})`, tries }); continue; }
        setProxy(a.id, got.s, a.proxy || '');
        usedIps.add(got.ip);
        regionLoad.set(region, regionLoad.get(region) + 1);
        const d = load();     // перечитываем перед записью: файл пишет и импорт
        const at = new Date().toISOString();
        d.assigned = { ...(d.assigned || {}),
          [a.id]: { session: sessionId(got.s), region, ip: got.ip, city: got.city, org: got.org, country: got.country,
                    at } };
        // история смен IP: по ней панель держит предел смен в сутки, и он
        // переживает перезапуск панели. Без сессии — первая выдача, не смена
        if (hasSession(a)) {
          const hist = ((d.changes || {})[a.id] || []).filter((x) => Date.parse(x.at || '') > Date.now() - CHANGES_KEEP);
          hist.push({ at, ip: got.ip, region, why: String(reasons[a.id] || '').slice(0, 80) });
          d.changes = { ...(d.changes || {}), [a.id]: hist.slice(-CHANGES_MAX) };
        }
        prune(d);
        save(d);
        note(a, got, region);
        res.push({ id: a.id, ok: true, ip: got.ip, org: got.org, region, tries });
      }
      // ни одной удачной — записи удалённых всё равно вычищаем
      if (!res.some((x) => x.ok)) { const d = load(); if (prune(d)) save(d); }
      return res;
    } finally {
      busy = false;
    }
  }

  return { check, assign, sessionId, exitIp, reachesTelegram, changes,
           assigned: () => load().assigned || {}, busy: () => busy };
}
