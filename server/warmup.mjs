/**
 * Прогрев аккаунтов.
 *
 * Свежекупленный аккаунт, который сразу пишет полусотне незнакомых людей, —
 * это мёртвый аккаунт: Telegram выдаёт PEER_FLOOD в первые же часы. Живые
 * аккаунты так себя не ведут. Поэтому новый сначала отлёживается сутки, а
 * потом наращивает объём постепенно.
 */

/**
 * Сколько человек в сутки можно писать с аккаунта, по его возрасту.
 *
 * Это образец на семь дней. Срок прогрева можно сократить или растянуть —
 * тогда те же ступени раскладываются на выбранное число дней (см. planFor).
 * Первые сутки — отлёжка, их не трогает ничто: это главная защита нового
 * аккаунта, и выгадывать на ней нечего.
 */
export const WARM_PLAN = [
  { day: 0,  cap: 0,  note: 'отлёжка — сутки ничего не делаем' },
  { day: 1,  cap: 2,  note: 'первые шаги: 2 в сутки' },
  { day: 3,  cap: 5,  note: 'разгон: 5 в сутки' },
  { day: 5,  cap: 9,  note: '9 в сутки' },
  { day: 7,  cap: 15, note: 'прогрет: 15 в сутки' },
];

export const WARM_DAYS_BASE = WARM_PLAN[WARM_PLAN.length - 1].day;   // 7
export const WARM_DAYS_MIN = 2;
export const WARM_DAYS_MAX = 21;

/**
 * Лестница прогрева под выбранный срок.
 *
 * Дни ступеней сжимаются или растягиваются пропорционально. Если две ступени
 * при сжатии попадают в один день — остаётся та, что выше: короткий срок и
 * значит «быстрее выходим на объём», а не «дважды топчемся на месте».
 */
export function planFor(days) {
  const d = Math.max(WARM_DAYS_MIN, Math.min(WARM_DAYS_MAX, Math.round(days) || WARM_DAYS_BASE));
  if (d === WARM_DAYS_BASE) return WARM_PLAN.map((p) => ({ ...p }));
  const k = d / WARM_DAYS_BASE;
  const byDay = new Map();
  for (const step of WARM_PLAN) {
    const day = step.day === 0 ? 0 : Math.max(1, Math.min(d, Math.round(step.day * k)));
    const was = byDay.get(day);
    if (!was || step.cap > was.cap) byDay.set(day, { ...step, day });
  }
  const out = [...byDay.values()].sort((a, b) => a.day - b.day);
  // отлёжка — ровно сутки при любом сроке: растягивать «ничего не делаем»
  // смысла нет, а панель считает остаток отлёжки как одни сутки
  if (out[1] && out[1].day > 1) out[1].day = 1;
  // плато всегда приходится ровно на последний день срока
  const last = out[out.length - 1];
  if (last.day !== d) out.push({ ...WARM_PLAN[WARM_PLAN.length - 1], day: d });
  else Object.assign(last, { cap: WARM_PLAN[WARM_PLAN.length - 1].cap,
                             note: WARM_PLAN[WARM_PLAN.length - 1].note });
  return out;
}

/**
 * РАЗГОН РАССЫЛКИ по дню кампании (не по возрасту прогрева): день 0 — первый день
 * реальных сообщений аккаунта. Даже прогретый аккаунт, впервые пошедший в рассылку,
 * стартует с 2/сутки — иначе PEER_FLOOD на запуске. Совпадает с web/app.js:OUTREACH_PLAN.
 */
const OUTREACH_PLAN = [[0, 2], [2, 5], [4, 8], [6, 12], [9, 15]];
export function outreachCap(outreachDay) {
  const d = outreachDay == null || outreachDay < 0 ? 0 : outreachDay;  // не начинали → как день 0
  let c = 2;
  for (const [pd, pc] of OUTREACH_PLAN) if (d >= pd) c = pc;
  return c;
}

/**
 * РАЗГОН ПРОВЕРКИ НОМЕРОВ. Проверка — это «добавить номер в контакты», и на
 * это у Telegram свой лимит: упрёшься — квота кончается, а частые упоры портят
 * аккаунту репутацию. Поэтому у проверки свой дневной предел, тоже с разгоном:
 * день 0 — первый день, когда аккаунт вообще проверял номера.
 */
const CHECK_PLAN = [[0, 10], [2, 15], [4, Infinity]];   // Infinity — до «максимума проверок»
// 50 оказалось много: реальный потолок у этих аккаунтов — 20–30 добавлений за сутки
export const CHECK_MAX_DEFAULT = 20;

/**
 * Собирает функции прогрева поверх нужных зависимостей.
 * readCsv и accounts приходят снаружи — модуль не лезет к файлам сам.
 */
export function makeWarmup({ readCsv, accounts }) {
  // потолок сообщений в день после разгона (плато). 0 — как в WARM_PLAN (15).
  let maxCap = 0;
  function setMaxCap(n) { maxCap = Math.max(0, Number(n) || 0); }
  function getMaxCap() { return maxCap; }
  // за сколько дней аккаунт выходит на полный объём
  let warmDays = WARM_DAYS_BASE;
  function setWarmDays(n) {
    warmDays = Math.max(WARM_DAYS_MIN, Math.min(WARM_DAYS_MAX, Math.round(Number(n)) || WARM_DAYS_BASE));
  }
  const getWarmDays = () => warmDays;
  const plan = () => planFor(warmDays);

  // потолок проверок номеров в день после разгона
  let checkMax = CHECK_MAX_DEFAULT;
  function setCheckMax(n) { checkMax = Math.max(1, Number(n) || CHECK_MAX_DEFAULT); }
  function getCheckMax() { return checkMax; }

  /**
   * Сколько номеров аккаунт проверил за последние 24 часа и в какой день
   * проверок он сейчас. Считаем скользящие сутки, а не «с полуночи»: иначе
   * 10 проверок вечером и 20 утром — это «разные дни», а для Telegram — 30 подряд.
   */
  function checksOf(id) {
    const since = new Date(Date.now() - 864e5).toISOString();
    let today = 0, first = '';
    for (const r of readCsv('results.csv')) {
      // только номера: люди из разбора чатов в контакты не добавлялись
      if (r.by !== id || !r.checked_at || !/^\+?\d{10,}$/.test(r.phone)) continue;
      if (r.checked_at >= since) today++;
      if (!first || r.checked_at < first) first = r.checked_at;
    }
    const day = first ? Math.floor((Date.now() - Date.parse(first)) / 864e5) : 0;
    let cap = 10;
    for (const [d, c] of CHECK_PLAN) if (day >= d) cap = Math.min(c, checkMax);
    return { today, cap, left: Math.max(0, cap - today) };
  }
  // эффективное расписание с учётом заданного потолка — для показа в панели
  function getPlan() {
    const steps = plan();
    const last = steps.length - 1;
    return steps.map((p, i) => ({ day: p.day, cap: (maxCap > 0 && i === last) ? maxCap : p.cap, note: p.note }));
  }
  /**
   * Сколько этот аккаунт СЕГОДНЯ уже написал людям. Считаем и черновики, и
   * отправленные: рискует аккаунт одинаково — в обоих случаях он добавляет
   * контакт и заводит чат, а Telegram смотрит именно на это.
   */
  /**
   * Начало сегодняшнего дня как метка времени в том же виде, в каком её пишут
   * задачи (UTC, ISO). Сравнивать строки дешевле, чем разбирать сто тысяч дат
   * в объекты Date: на большой истории разница видна невооружённым глазом,
   * а смысл тот же — «записано сегодня по местному времени».
   */
  function sinceMidnight() {
    const m = new Date();
    m.setHours(0, 0, 0, 0);
    return m.toISOString();
  }

  function doneToday(id, rows) {
    const since = sinceMidnight();
    return (rows || readCsv('drafts.csv')).filter((r) => r.account === id
      && (r.ok === 'true' || r.sent === 'true')
      && r.at >= since).length;
  }

  /**
   * Сколько каждый аккаунт написал за сегодня — одним проходом по истории.
   * Список аккаунтов панель опрашивает каждые две секунды, и считать это
   * заново для КАЖДОГО аккаунта значило перебирать всю историю по разу на
   * каждого: на полусотне аккаунтов набегали секунды.
   */
  function doneTodayAll(rows) {
    const since = sinceMidnight();
    const n = new Map();
    for (const r of rows || readCsv('drafts.csv')) {
      if ((r.ok === 'true' || r.sent === 'true') && r.at >= since) {
        n.set(r.account, (n.get(r.account) || 0) + 1);
      }
    }
    return n;
  }

  /**
   * С какого момента считать возраст. Ставим один раз и запоминаем в реестре.
   * Аккаунт, который успел поработать до появления прогрева, в отлёжку не
   * загоняем — он своё «детство» прожил, ему засчитываем зрелый возраст.
   */
  function warmFrom(acc) {
    if (acc.warmFrom) return Date.parse(acc.warmFrom);
    const worked = readCsv('drafts.csv').some((r) => r.account === acc.id
      && (r.ok === 'true' || r.sent === 'true'));
    const from = worked
      ? new Date(Date.now() - 10 * 864e5).toISOString()
      : (acc.added || new Date().toISOString());
    accounts.setField(acc.id, { warmFrom: from });
    return Date.parse(from);
  }

  /**
   * Состояние прогрева: возраст, дневной предел, отдыхает ли ещё.
   * done — сколько аккаунт написал сегодня; если посчитано снаружи одним
   * проходом, передаём сюда и не считаем заново.
   */
  function warm(acc, done) {
    const from = warmFrom(acc);
    const age = (Date.now() - from) / 864e5;   // возраст в сутках, дробный
    const day = Math.floor(age);
    const steps = plan();
    let step = steps[0];
    for (const p of steps) if (day >= p.day) step = p;
    const resting = step.cap === 0;
    const lastStep = steps[steps.length - 1];
    const fullDay = lastStep.day;   // когда «прогрет»
    let cap = step.cap;
    // общий потолок меняет только ПЛАТО (созревший аккаунт) — разгон не трогаем
    if (maxCap > 0 && step === lastStep) cap = maxCap;
    // РАЗГОН РАССЫЛКИ: даже прогретый по возрасту аккаунт, впервые пошедший в
    // рассылку, шлёт по дню кампании (2→…→15), а не по возрастному плато. Это тот же
    // разгон, что показывает калькулятор — теперь он применяется и к реальной отправке.
    if (!resting) {
      const first = readCsv('drafts.csv')
        .filter((r) => r.account === acc.id && (r.ok === 'true' || r.sent === 'true') && r.at)
        .reduce((m, r) => (!m || r.at < m ? r.at : m), '');
      const outreachDay = first ? Math.floor((Date.now() - Date.parse(first)) / 864e5) : -1;
      cap = Math.min(cap, outreachCap(outreachDay));
    }
    // на аккаунт — плоский предел для теста, сильнее всего (кроме отлёжки)
    const perAcc = Number(acc.dailyCap) > 0 ? Number(acc.dailyCap) : 0;
    if (perAcc > 0 && !resting) cap = perAcc;
    const manual = !resting && (perAcc > 0 || (maxCap > 0 && step === lastStep));
    return {
      day, age, fullDay, cap, resting, manual, atMax: step === lastStep,
      note: perAcc > 0 && !resting ? `тест: ${cap} в сутки` : step.note,
      // общий прогресс прогрева, 0..100: от покупки до «прогрет»
      pct: Math.min(100, Math.round((age / fullDay) * 100)),
      restLeft: resting ? Math.max(0, Math.ceil((from + 864e5 - Date.now()) / 1000)) : 0,
      left: Math.max(0, cap - (done ?? doneToday(acc.id))),
    };
  }

  return { doneToday, doneTodayAll, warmFrom, warm, setMaxCap, getMaxCap, getPlan,
           checksOf, setCheckMax, getCheckMax, setWarmDays, getWarmDays };
}
