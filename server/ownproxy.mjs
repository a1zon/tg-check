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
const TG_DC = '149.154.167.51:443';       // DC2: прокси должен пускать к нему (MTProto)
const BASE_TTL = 24 * 3600_000;           // логин/пароль/регионы кабинета перечитываем раз в сутки
const PROBE_URL = 'http://ipinfo.io/json'; // http, без TLS: ~1 КБ трафика на проверку

export function makeOwnProxy({ dir, asocks, gateway = ASOCKS_GATEWAY, listAccounts, otherProxies = () => [],
                               setProxy, note = () => {}, regions = OWN_REGIONS }) {
  const FILE = path.join(dir, 'asocks-sessions.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; } };
  const save = (d) => {
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(d, null, 1) + '\n', { mode: 0o600 });
    fs.renameSync(FILE + '.tmp', FILE);
  };

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
      const c = spawn('curl', ['-s', '--max-time', '20', '-x', raw, PROBE_URL]);
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
   */
  async function assign({ ids, country = OWN_COUNTRY, maxTries = 6 }) {
    if (busy) throw new Error('раздача уже идёт — дождись её');
    busy = true;
    try {
      const b = await base(country);
      const all = listAccounts();
      const targets = all.filter((a) => ids.includes(a.id));
      const d0 = load();
      const prevAssigned = d0.assigned || {};
      const usedIps = new Set(Object.entries(prevAssigned)
        .filter(([id]) => !ids.includes(id)).map(([, v]) => v.ip).filter(Boolean));
      const byName = new Map(b.states.map((s) => [s.name, s]));
      const pool = regions.filter((r) => byName.has(r));
      if (!pool.length) throw new Error(`ни одного из регионов ${regions.join(', ')} нет у Asocks для ${country}`);
      // регион аккаунта закреплён: был — тот же; нового раскладываем по кругу (по месту в списке)
      const res = [];
      for (const a of targets) {
        const was = prevAssigned[a.id]?.region;
        const region = was && byName.has(was) ? was : pool[Math.max(0, all.findIndex((x) => x.id === a.id)) % pool.length];
        const st = byName.get(region);
        let got = null, why = '', tries = 0;
        while (tries < maxTries) {
          tries++;
          const s = build(b, st.id);
          const c = await check(s, country);
          if (!c.ok) { why = c.why; continue; }
          if (usedIps.has(c.ip)) { why = 'такой IP уже у другого аккаунта'; continue; }
          got = { s, ...c };
          break;
        }
        if (!got) { res.push({ id: a.id, ok: false, region, why: `${tries} строк подряд не подошли (${why})`, tries }); continue; }
        setProxy(a.id, got.s, a.proxy || '');
        usedIps.add(got.ip);
        const d = load();
        d.assigned = { ...(d.assigned || {}),
          [a.id]: { session: sessionId(got.s), region, ip: got.ip, city: got.city, org: got.org, country: got.country,
                    at: new Date().toISOString() } };
        save(d);
        note(a, got, region);
        res.push({ id: a.id, ok: true, ip: got.ip, org: got.org, region, tries });
      }
      return res;
    } finally {
      busy = false;
    }
  }

  return { check, assign, sessionId, exitIp, reachesTelegram,
           assigned: () => load().assigned || {}, busy: () => busy };
}
