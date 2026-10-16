/**
 * Свой IP каждому аккаунту — отдельные мобильные сессии Asocks.
 *
 * Зачем. Пока у всех аккаунтов одна строка прокси, панель водит их строго по
 * одному (ownProxyEach), а Telegram видит пачку аккаунтов за одним адресом.
 * У Asocks есть готовый список мобильных сессий страны (v2/proxy/search): у
 * каждой свой логин и, как правило, свой постоянный IP оператора. Сессии ничего
 * не стоят — платим за трафик, сколько бы их ни было.
 *
 * Как выдаём. Берём ещё никем не занятую сессию (ни в этом профиле, ни в
 * соседних) и проверяем её: ответила, выход из нужной страны, IP не скачет между
 * двумя запросами, шлюз пускает к дата-центру Telegram, такого IP ещё нет у
 * другого аккаунта. Не прошла — следующая. Прошла — строка прокси аккаунта
 * меняется, прежняя остаётся в proxyPrev (откатить можно руками).
 *
 * Шлюз в строке всегда 190.2.137.56:9999: списки отдают другой адрес, а до
 * Telegram доходит только этот (проверено 16.10).
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

export const ASOCKS_GATEWAY = '190.2.137.56:9999';
const TG_DC = '149.154.167.51:443';       // DC2: прокси должен пускать к нему (MTProto)
const CACHE_TTL = 30 * 60_000;            // список сессий перезапрашиваем не чаще
const PROBE_URL = 'http://ipinfo.io/json'; // http, без TLS: ~1 КБ трафика на проверку

export function makeOwnProxy({ dir, asocks, gateway = ASOCKS_GATEWAY, listAccounts, otherProxies = () => [],
                               setProxy, note = () => {} }) {
  const FILE = path.join(dir, 'asocks-sessions.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; } };
  const save = (d) => {
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(d, null, 1) + '\n');
    fs.renameSync(FILE + '.tmp', FILE);
  };

  /** Шлюз — тот, что пускает к Telegram; логин и пароль сессии — как есть. */
  const normalize = (s) => String(s).trim().replace(/@[^:/@]+:\d+\/?$/, '@' + gateway);
  /** Логин сессии — её id: по нему сверяем, не занята ли она. */
  const sessionId = (s) => {
    try { return decodeURIComponent(new URL(String(s)).username) || String(s); } catch { return String(s); }
  };

  async function sessions(country, force = false) {
    const d = load();
    const c = (d.cache || {})[country];
    if (!force && c && Date.now() - c.at < CACHE_TTL && c.list?.length) return c.list;
    const list = (await asocks.search(country)).map(normalize);
    d.cache = { ...(d.cache || {}), [country]: { at: Date.now(), list } };
    save(d);
    return list;
  }

  /** Выход через прокси: { ip, country, org } или {} — не ответил. */
  function exitIp(raw) {
    return new Promise((done) => {
      const c = spawn('curl', ['-s', '--max-time', '20', '-x', raw, PROBE_URL]);
      let out = '';
      c.stdout.on('data', (b) => { out += b; });
      c.on('error', () => done({}));
      c.on('close', () => {
        try {
          const j = JSON.parse(out);
          done(j.ip ? { ip: j.ip, country: j.country || '', org: String(j.org || '').slice(0, 40) } : {});
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

  /** Годится ли сессия: { ok, ip, country, org } или { ok:false, why }. */
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
   * Раздать сессии аккаунтам ids. Возвращает [{ id, ok, ip, org, why, tries }].
   * Одновременно идёт одна раздача: две параллельные выдали бы одну сессию двоим.
   */
  async function assign({ ids, country = 'KZ', maxTries = 6 }) {
    if (busy) throw new Error('раздача уже идёт — дождись её');
    busy = true;
    try {
      const all = listAccounts();
      const targets = all.filter((a) => ids.includes(a.id));
      // занятые: у всех аккаунтов (и у тех, кому меняем, — им нужна ДРУГАЯ сессия) и в соседних профилях
      const used = new Set([...all.map((a) => a.proxy), ...otherProxies()].filter(Boolean).map(sessionId));
      const d0 = load();
      // IP, которые уже стоят у ДРУГИХ аккаунтов — их не повторяем
      const usedIps = new Set(Object.entries(d0.assigned || {})
        .filter(([id]) => !ids.includes(id)).map(([, v]) => v.ip).filter(Boolean));
      const pool = (await sessions(country)).filter((s) => !used.has(sessionId(s)));
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      const res = [];
      for (const a of targets) {
        let got = null, why = '', tries = 0;
        while (pool.length && tries < maxTries) {
          const s = pool.pop();
          tries++;
          const c = await check(s, country);
          if (!c.ok) { why = c.why; continue; }
          if (usedIps.has(c.ip)) { why = 'такой IP уже у другого аккаунта'; continue; }
          got = { s, ...c };
          break;
        }
        if (!got) {
          res.push({ id: a.id, ok: false, why: pool.length ? `${tries} сессий подряд не подошли (${why})` : 'свободные сессии кончились', tries });
          continue;
        }
        setProxy(a.id, got.s, a.proxy || '');
        usedIps.add(got.ip);
        const d = load();
        d.assigned = { ...(d.assigned || {}),
          [a.id]: { session: sessionId(got.s), ip: got.ip, org: got.org, country: got.country, at: new Date().toISOString() } };
        save(d);
        note(a, got);
        res.push({ id: a.id, ok: true, ip: got.ip, org: got.org, tries });
      }
      return res;
    } finally {
      busy = false;
    }
  }

  return { sessions, check, assign, normalize, sessionId, exitIp, reachesTelegram,
           assigned: () => load().assigned || {}, busy: () => busy };
}
