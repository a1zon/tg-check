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

// Трафик: прокси платный за гигабайт. Проверка раз в минуту по https стоила
// ~9 КБ (рукопожатие TLS) × 1440 в сутки ≈ 13 МБ на КАЖДЫЙ прокси — четверть
// всего счёта прода, а при своём прокси у каждого аккаунта вышла бы главной
// статьёй. Теперь — простой http-запрос (~0.8 КБ) и раз в 10 минут: живость
// между проверками ловит сама работа — упавшая задача тут же зовёт check().
const EVERY_OK = 4 * 60_000;   // прокси жив — переопрашиваем раз в 4 минуты: чем
                               // чаще, тем быстрее замечаем смерть мобильного
                               // бэкенда (цена — ~10 МБ/сутки на проб, копейки)
const EVERY_DOWN = 30_000;     // лежит — чаще, чтобы не прозевать подъём
const DOWN_AFTER = 2;          // столько неудач подряд — значит лежит, а не моргнул
const REVIVE_EVERY = 2 * 60_000;   // лежит — дёргаем refresh раз в 2 минуты
// ipinfo по http: кроме IP отдаёт страну — по ней панель замечает, что своя строка «уехала»
// из Казахстана (16.10 одна такая сессия вышла из Колумбии)
const PROBE_URL = 'http://ipinfo.io/json';
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

export function makeProxyGuard({ parseProxy, label, proxies, rotateLink, rotateIp, note,
                                 switching = () => false }) {
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
    // curl берёт для http:// только строчную http_proxy (заглавную — нет, из
    // соображений безопасности); ALL_PROXY — запасной путь для socks
    const env = { ...process.env, http_proxy: url, https_proxy: url, HTTPS_PROXY: url, ALL_PROXY: url };
    return new Promise((done) => {
      const c = spawn('curl', ['-s', '--max-time', String(PROBE_TIMEOUT),
        '-w', '\n%{http_code} %{http_connect}', PROBE_URL], { env });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.on('error', (e) => done({ ok: false, reason: 'не запустился curl: ' + e.message }));
      c.on('close', (exit) => {
        const lines = out.trim().split('\n');
        const [code, connect] = (lines.pop() || '').split(' ');
        const body = lines.join('').trim();
        let ip = '', country = '';
        try { const j = JSON.parse(body); ip = String(j.ip || ''); country = String(j.country || ''); } catch { ip = body; }
        // Падение — это когда не достучались до САМОГО прокси: curl не завершился
        // (таймаут/отказ), шлюз не принял логин (407) или модем не в сети (502/503).
        // А вот если сайт ОТВЕТИЛ любым кодом (в т.ч. 429 rate-limit по общему
        // мобильному IP) — прокси работает, его трогать нельзя (иначе встанет
        // прогон и сторож зря сменит строку). IP/страну берём только из 200+JSON.
        const GW_DOWN = ['407', '502', '503', '504'];   // шлюз/модем прокси не отработал
        // Мёртвый мобильный порт Asocks отвечает 404 «Proxy not found in your
        // region» — это ПАДЕНИЕ порта (бэкенд отвалился), а не ответ сайта. По
        // коду 404 неотличимо от реального 404 сайта, поэтому ловим по телу: иначе
        // сторож считает порт живым и самолечение (refresh) не запускается.
        const asocksDead = /not found in your region|proxy not found/i.test(body);
        const proxyBad = exit !== 0 || asocksDead || GW_DOWN.includes(connect) || GW_DOWN.includes(code) || code === '000';
        // сайт ответил нормальным кодом (200, а также 429 rate-limit, 403, 404…) —
        // значит прокси ДОВЁЛ запрос, он живой; IP/страну берём только из 200+JSON
        if (!proxyBad && /^[234]\d\d$/.test(code || '')) {
          return done(code === '200' && /^[\d.:a-f]+$/i.test(ip) ? { ok: true, ip, country } : { ok: true });
        }
        done({ ok: false, reason: asocksDead ? 'порт Asocks без бэкенда (404 not found in region) — нужен refresh'
                                             : why(connect && connect !== '000' ? connect : code, exit) });
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
        // при «живой, но без свежего IP» (сайт отдал 429) прежние ip/страну не теряем
        Object.assign(s, { down: false, fails: 0, reason: '', since: Date.now() });
        if (r.ip) { s.ip = r.ip; s.country = r.country || ''; s.ipAt = Date.now(); }
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
    // интервал проверяем ДО поиска ссылки: у своих портов ссылка личная и
    // достаётся запросом в кабинет (с кэшем) — незачем дёргать его каждый тик
    if (Date.now() - s.revivedAt < REVIVE_EVERY) return;
    // личная ссылка перезапуска именно этого порта (у мобильного dedicated
    // бэкенд отваливается поштучно); если её нет — общий линк смены IP
    const link = await rotateLink(raw);
    if (!link) return;
    s.revivedAt = Date.now();
    const r = await rotateIp(link);
    note('🔄', r.ok ? 'попросил провайдера перезапустить модем — жду, проверю через 30 с'
                    : `перезапустить модем не вышло: ${r.reason}`);
  }

  async function tick() {
    const now = Date.now();
    // идёт смена IP — модем сейчас и не должен отвечать, это не падение
    if (switching()) return;
    for (const raw of new Set(proxies())) {
      const s = stateOf(raw);
      // моргнул один раз (fails > 0) — перепроверяем через 30 с, а не через 10 минут:
      // иначе «лежит» (две неудачи подряд) выяснялось бы только через 10–20 минут
      if (now - s.checkedAt < (s.down || s.fails ? EVERY_DOWN : EVERY_OK)) continue;
      await check(raw);
      if (s.down) await revive(raw, s);
    }
  }

  return {
    start() { if (!timer) { timer = setInterval(tick, 10_000); tick(); } },
    check,
    /** Лежит ли прокси этого аккаунта прямо сейчас. */
    down: (raw) => !!raw && !!st.get(raw)?.down,
    /** Что сторож видел на этом прокси последним: IP и страна выхода. */
    info: (raw) => { const s = raw && st.get(raw); return s ? { ip: s.ip, country: s.country || '', down: !!s.down, ipAt: s.ipAt || 0 } : {}; },
    /** Для шапки панели: без паролей. */
    summary: () => [...new Set(proxies())].map((raw) => {
      const s = stateOf(raw);
      return { label: label(raw), ok: !s.down, checked: !!s.checkedAt, ip: s.ip,
               reason: s.down ? s.reason : '', since: s.since };
    }),
  };
}
