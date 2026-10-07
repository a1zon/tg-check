/**
 * Сторож прокси: раз в минуту проверяет каждый прокси аккаунтов.
 *
 * Зачем. Мобильный прокси ложится целиком — модем уходит из сети, шлюз
 * провайдера отвечает 502. Без сторожа панель этого не замечает: задачи падают
 * одна за другой, аккаунты набирают «сбои подряд» и выбывают из прогона, а
 * смена IP трижды не проходит и останавливает его совсем. Хотя аккаунты ни
 * при чём — лежит прокси.
 *
 * Поэтому: прокси не ответил два раза подряд — объявляем его лежащим. Задачи
 * на нём не запускаются, сбои аккаунтам не засчитываются. Пока лежит, проверяем
 * чаще и раз в 5 минут дёргаем ссылку смены IP — у мобильных прокси она
 * перезапускает модем и часто сама его поднимает. Поднялся — работа идёт дальше.
 *
 * Проверка — один короткий запрос через curl. Прокси передаём через окружение,
 * а не аргументом: в списке процессов его пароль не светится.
 */
import { spawn } from 'node:child_process';

const EVERY_OK = 60_000;       // прокси жив — проверяем раз в минуту
const EVERY_DOWN = 30_000;     // лежит — чаще, чтобы не прозевать подъём
const DOWN_AFTER = 2;          // столько неудач подряд — значит лежит, а не моргнул
const REVIVE_EVERY = 5 * 60_000;
const PROBE_URL = 'https://api.ipify.org';
const PROBE_TIMEOUT = 15;

/** Что значит ответ шлюза — словами, которые помогают понять, куда смотреть. */
function why(connect, exit) {
  if (connect === '502' || connect === '503') return 'модем прокси не в сети (шлюз отвечает ' + connect + ')';
  if (connect === '407') return 'прокси не принял логин и пароль';
  if (exit === 28) return `прокси не ответил за ${PROBE_TIMEOUT} с`;
  if (exit === 7) return 'шлюз прокси не принимает соединения';
  if (exit === 5 || exit === 6) return 'не нашли адрес прокси';
  return `проверка не прошла (curl ${exit}${connect && connect !== '000' ? `, шлюз ${connect}` : ''})`;
}

export function makeProxyGuard({ parseProxy, label, proxies, rotateLink, rotateIp, note }) {
  const st = new Map();       // строка прокси -> состояние
  let timer = null;

  const stateOf = (p) => {
    if (!st.has(p)) st.set(p, { down: false, fails: 0, ip: '', reason: '', since: 0,
                               checkedAt: 0, revivedAt: 0, checking: null });
    return st.get(p);
  };

  function probe(raw) {
    let p;
    try { p = parseProxy(raw); } catch (e) { return Promise.resolve({ ok: false, reason: e.message }); }
    const cred = p.username
      ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password || '')}@` : '';
    const url = p.server.replace('://', `://${cred}`);
    const env = { ...process.env, https_proxy: url, HTTPS_PROXY: url, ALL_PROXY: url };
    return new Promise((done) => {
      const c = spawn('curl', ['-s', '--max-time', String(PROBE_TIMEOUT),
        '-w', '\n%{http_code} %{http_connect}', PROBE_URL], { env });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.on('error', (e) => done({ ok: false, reason: 'не запустился curl: ' + e.message }));
      c.on('close', (exit) => {
        const lines = out.trim().split('\n');
        const [code, connect] = (lines.pop() || '').split(' ');
        const ip = lines.join('').trim();
        if (exit === 0 && code === '200' && /^[\d.:a-f]+$/i.test(ip)) return done({ ok: true, ip });
        done({ ok: false, reason: why(connect, exit) });
      });
    });
  }

  /**
   * Проверить сейчас: true — прокси ответил. Одновременные вызовы по одному
   * прокси ждут одну проверку.
   */
  function check(raw) {
    if (!raw) return Promise.resolve(true);     // без прокси — нечего сторожить
    const s = stateOf(raw);
    if (s.checking) return s.checking;
    s.checking = probe(raw).then((r) => {
      s.checking = null;
      s.checkedAt = Date.now();
      if (r.ok) {
        if (s.down) {
          const lay = Math.round((Date.now() - s.since) / 60_000);
          note('✅', `прокси снова работает (IP ${r.ip}) — лежал ${lay} мин, продолжаю`);
        }
        Object.assign(s, { down: false, fails: 0, ip: r.ip, reason: '', since: Date.now() });
        return true;
      }
      s.fails++;
      s.reason = r.reason;
      if (!s.down && s.fails >= DOWN_AFTER) {
        Object.assign(s, { down: true, since: Date.now(), revivedAt: Date.now() });
        note('⛔', `прокси ${label(raw)} лежит: ${r.reason}. Прогон и прогрев на паузе, ` +
          'аккаунтам это сбоем не считается. Проверяю каждые 30 с и раз в 5 минут перезапускаю модем');
      }
      return false;
    });
    return s.checking;
  }

  async function revive(raw, s) {
    const link = rotateLink();
    if (!link || Date.now() - s.revivedAt < REVIVE_EVERY) return;
    s.revivedAt = Date.now();
    const r = await rotateIp(link);
    note('🔄', r.ok ? 'попросил провайдера перезапустить модем — жду, проверю через 30 с'
                    : `перезапустить модем не вышло: ${r.reason}`);
  }

  async function tick() {
    const now = Date.now();
    for (const raw of new Set(proxies())) {
      const s = stateOf(raw);
      if (now - s.checkedAt < (s.down ? EVERY_DOWN : EVERY_OK)) continue;
      await check(raw);
      if (s.down) await revive(raw, s);
    }
  }

  return {
    start() { if (!timer) { timer = setInterval(tick, 10_000); tick(); } },
    check,
    /** Лежит ли прокси этого аккаунта прямо сейчас. */
    down: (raw) => !!raw && !!st.get(raw)?.down,
    /** Для шапки панели: без паролей. */
    summary: () => [...new Set(proxies())].map((raw) => {
      const s = stateOf(raw);
      return { label: label(raw), ok: !s.down, checked: !!s.checkedAt, ip: s.ip,
               reason: s.down ? s.reason : '', since: s.since };
    }),
  };
}
