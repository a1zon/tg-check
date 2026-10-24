/**
 * Прогрев аккаунтов.
 *
 * Свежекупленный аккаунт, который сразу пишет полусотне незнакомых людей, —
 * это мёртвый аккаунт: Telegram выдаёт PEER_FLOOD в первые же часы. Живые
 * аккаунты так себя не ведут. Поэтому новый сначала отлёживается сутки, а
 * потом наращивает объём постепенно.
 */

import { createHash } from 'node:crypto';

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
 * Примерная дата регистрации аккаунта по его Telegram-id.
 *
 * Зачем. Свежий аккаунт Telegram морозит на первом же холодном касании, а
 * старый на том же IP отделывается временным лимитом (проверено: id ~8.6 млрд =
 * 2025 морозятся, id ~7.3 млрд = 2024 — только temp). Значит, длину прогрева
 * лучше ставить от ВОЗРАСТА аккаунта, а возраст виден по id: Telegram выдаёт
 * номера почти по порядку, чем позже регистрация — тем больше число.
 *
 * Точную формулу Telegram не публикует, поэтому оцениваем кусочно-линейной
 * интерполяцией по опорным точкам (id → примерная дата). Это ОЦЕНКА ±пара
 * месяцев — её хватает, чтобы отнести аккаунт к нужной «корзине» прогрева.
 * Опорные точки держать монотонными; при желании уточнить — правятся здесь
 * И в warmup-activity.py (ID_ANCHORS, WARM_BY_AGE): по ним идут сами действия
 * прогрева, срок у панели и у прогрева должен совпадать.
 */
const ID_ANCHORS = [
  [  200_000_000, Date.parse('2017-06-01')],
  [  800_000_000, Date.parse('2020-10-01')],
  [1_500_000_000, Date.parse('2022-02-01')],
  [2_500_000_000, Date.parse('2022-10-01')],
  [4_000_000_000, Date.parse('2023-06-01')],
  [5_500_000_000, Date.parse('2023-12-01')],
  [6_500_000_000, Date.parse('2024-03-01')],
  [7_300_000_000, Date.parse('2024-07-01')],
  [8_200_000_000, Date.parse('2025-01-01')],
  [8_600_000_000, Date.parse('2025-06-01')],
  [9_200_000_000, Date.parse('2025-12-01')],
];
export function regDateFromId(userId) {
  const id = Number(userId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const A = ID_ANCHORS;
  // до первой опоры — берём первую дату; дальше — линейная интерполяция, за
  // последней опорой экстраполируем по наклону последнего отрезка
  if (id <= A[0][0]) return A[0][1];
  for (let i = 1; i < A.length; i++) {
    if (id <= A[i][0]) {
      const [x0, t0] = A[i - 1], [x1, t1] = A[i];
      return t0 + (t1 - t0) * (id - x0) / (x1 - x0);
    }
  }
  const [x0, t0] = A[A.length - 2], [x1, t1] = A[A.length - 1];
  return t0 + (t1 - t0) * (id - x0) / (x1 - x0);
}

/**
 * Рекомендованная длина прогрева (дней) по возрасту аккаунта.
 *
 * Свежий греем дольше (его и морозят), старый доверенный — быстрее выходит на
 * объём. Пороги (мес. → дней) легко менять; результат в тех же рамках, что и
 * ручная настройка (WARM_DAYS_MIN..MAX). null — если возраст не определить.
 */
const WARM_BY_AGE = [[3, 12], [8, 10], [18, 8], [36, 7]];
export function warmDaysForAge(userId, now = Date.now()) {
  const d = regDateFromId(userId);
  if (d == null) return null;
  const months = (now - d) / (2629800000);   // ≈30.44 суток
  for (const [m, days] of WARM_BY_AGE) if (months < m) return days;
  return 5;   // старше последнего порога — минимальное доверие по умолчанию
}

/**
 * ЗРЕЛЫЙ аккаунт — уже в рассылке (role=send), выпущен из прогрева (graduated)
 * или пришёл поработавшим (prewarmed). Ему день по календарю, общий срок и без
 * сдвига ступеней. То же определение — mature() в warmup-activity.py.
 */
export function isMature(acc) {
  return acc?.graduated === true || acc?.role === 'send' || acc?.prewarmed === true;
}

/**
 * ЗАЩИЩЁННЫЙ — старый аккаунт хозяина: только явный acc.protect === true (список
 * хозяина). Зрелость не в счёт: выпускник прогрева (graduated) остаётся в кругу
 * покупных. Прогрев не связывает защищённого перепиской с остальными: они ему не
 * пишут, он — им, круги собеседников внутри своей группы. То же — protected() в
 * warmup-activity.py.
 */
export function isProtected(acc) {
  return acc?.protect === true;
}

/**
 * РАЗНОС ПАРТИИ: на сколько активных дней (0–2) у аккаунта сдвинуты ступени
 * прогрева. Партия, залитая одним импортом, шла по прогреву в ногу и в один
 * час перешла к переписке и знакомству по номерам друг с другом — отпечаток
 * фермы (номера в контакты прогрев с тех пор не добавляет вовсе: своим пишет
 * по открытому диалогу или @нику, ник аккаунт заводит сам). Сдвиг по хэшу id —
 * не скачет. Та же формула — warm_lag в warmup-activity.py: по ней идут сами
 * действия, здесь — срок и выпуск.
 */
export const WARM_LAG_MAX = 2;
export function warmLag(id) {
  const h = createHash('sha256').update(`${id}:lag`).digest('hex');
  return parseInt(h.slice(0, 8), 16) % (WARM_LAG_MAX + 1);
}

/**
 * РАЗГОН РАССЫЛКИ по дню кампании (не по возрасту прогрева): день 0 — первый день
 * реальных сообщений аккаунта. Даже прогретый аккаунт, впервые пошедший в рассылку,
 * стартует с 2/сутки — иначе PEER_FLOOD на запуске. Совпадает с web/app.js:OUTREACH_PLAN.
 */
const OUTREACH_PLAN = [[0, 2], [2, 5], [4, 8], [6, 12], [9, 15]];
/**
 * Конец последнего отдыха без рассылки (после ограничения или заморозки), мс.
 * Разгон писем после него начинается заново: день рассылки считаем от первого
 * письма после этой отметки, а не от самого первого письма аккаунта.
 */
export function restEnd(acc) {
  return Math.max(Date.parse(acc?.sendHoldUntil || '') || 0, Date.parse(acc?.fullRestUntil || '') || 0);
}

export function outreachCap(outreachDay) {
  const d = outreachDay == null || outreachDay < 0 ? 0 : outreachDay;  // не начинали → как день 0
  let c = 2;
  for (const [pd, pc] of OUTREACH_PLAN) if (d >= pd) c = pc;
  return c;
}

/**
 * СКОЛЬКО НОМЕРОВ ПРОВЕРЯЕМ ЗА СУТКИ — столько же, сколько пишем писем.
 *
 * Проверка — это «добавить номер в контакты», та же операция, с которой
 * начинается письмо, и лимит у Telegram на неё общий. Отдельная лестница для
 * проверки означала, что аккаунт с двумя письмами в день трогал контакты
 * десять раз: восемь из них — впустую, просто «посмотреть».
 *
 * Теперь предел один: сколько писем в сутки по графику разгона, столько и
 * проверок. Поле «максимум проверок» осталось верхней планкой — опустить
 * ниже можно, поднять выше дневного предела писем нельзя.
 */
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
   * Сколько номеров аккаунт проверил за последние 24 часа и сколько ещё можно.
   * Считаем скользящие сутки, а не «с полуночи»: иначе 10 проверок вечером и
   * 20 утром — это «разные дни», а для Telegram — 30 подряд.
   */
  function checksOf(id) {
    const since = new Date(Date.now() - 864e5).toISOString();
    let today = 0;
    for (const r of readCsv('results.csv')) {
      // только номера: люди из разбора чатов в контакты не добавлялись
      if (r.by !== id || !r.checked_at || !/^\+?\d{10,}$/.test(r.phone)) continue;
      if (r.checked_at >= since) today++;
    }
    const acc = accounts.list().find((a) => a.id === id);
    // столько же, сколько писем в сутки: на отлёжке — ноль, у новичка в
    // рассылке — два, у прогретого — его плато
    const cap = Math.min(acc ? warm(acc).cap : 0, checkMax);
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
   * РЕАЛЬНЫЕ ДНИ ПРОГРЕВА — в какие даты аккаунт правда что-то делал.
   *
   * Зачем. Зрелость прогрева раньше считалась по календарю: «прошли сутки —
   * +1 день, полоса растёт». Но если аккаунт простоял (лёг прокси, пауза),
   * он за эти сутки не сделал ничего, а полоса всё равно росла — панель
   * показывала «день 3», когда аккаунт только-только начал. Честно считать
   * прогресс по ДНЯМ С ДЕЙСТВИЕМ: дата с хотя бы одним успешным действием
   * прогрева (warmup.csv, note=ok; завести @ник — тоже) или отправленным/
   * черновиком письма (drafts.csv). Пустой день прогресс не двигает: отказы и
   * пустые заходы («пусто», «ники заняты» и пр.) в журнале есть, но не в счёт.
   * Вопрос к SpamBot — не
   * действие: его задают и простаивающему, и замороженному (у партии 18.10
   * день с одним SpamBot засчитывался). Так же считает warmup-activity.py.
   *
   * Дату берём по Екб (UTC+5), чтобы «день» совпадал с окном прогрева.
   * Кэш на 30с: список аккаунтов панель опрашивает каждые 2с, а гранулярность
   * тут суточная — чаще пересчитывать весь журнал незачем.
   */
  // карта: id -> набор Екб-дат, когда аккаунт реально что-то делал. Фильтр
  // «с начала прогрева» делаем в warm() (там знаем warmFrom), а строим карту раз.
  // Сторож кэша по времени построения (не по map.size): пустую карту тоже кэшируем,
  // иначе на старте кампании (журналы ещё без успехов) warm() строил бы её на
  // КАЖДЫЙ аккаунт при опросе раз в 2с. readCsv здесь = readAll — оба набора.
  let activeCache = { at: 0, map: null };
  function activeDaysMap() {
    if (activeCache.map && Date.now() - activeCache.at < 30_000) return activeCache.map;
    const map = new Map();
    const add = (id, iso) => {
      const t = Date.parse(iso || '');
      if (!id || !t) return;
      const d = new Date(t + 5 * 3600_000).toISOString().slice(0, 10);   // дата по Екб
      let s = map.get(id); if (!s) map.set(id, s = new Set());
      s.add(d);
    };
    for (const r of readCsv('warmup.csv')) if (r.note === 'ok' && r.action !== 'spam') add(r.account, r.at);
    for (const r of readCsv('drafts.csv')) if (r.ok === 'true' || r.sent === 'true') add(r.account, r.at);
    activeCache = { at: Date.now(), map };
    return map;
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
    // prewarmed — «пришёл уже поработавшим»: зрелость такому считаем по
    // календарю, а не по активным дням (у него их в наших журналах может и не
    // быть). Без флага он завис бы на ранней ступени и не выпускался.
    accounts.setField(acc.id, { warmFrom: from, prewarmed: worked });
    acc.warmFrom = from; acc.prewarmed = worked;   // текущий вызов warm() уже видит
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
    const calDay = Math.floor(age);            // по календарю (как было)
    const restDone = age >= 1;                 // отлёжка — ровно сутки по часам
    // РЕАЛЬНЫЙ день прогрева: сколько РАЗНЫХ дней аккаунт правда что-то делал —
    // но только С НАЧАЛА ТЕКУЩЕГО прогрева (даты >= warmFrom). Простой (лёг
    // прокси, пауза) зрелость не двигает; а сброс warmFrom (активация резерва,
    // ручной возврат) честно начинает счёт заново — старая история не засчитывается.
    const fromDate = new Date(from + 5 * 3600_000).toISOString().slice(0, 10);   // дата warmFrom по Екб
    const set = activeDaysMap().get(acc.id);
    const active = set ? [...set].filter((d) => d >= fromDate).length : 0;
    // ЗРЕЛЫЙ аккаунт (isMature): зрелость по активным дням НЕ пересчитываем, иначе
    // бурстовая отправка, работа в другом наборе или простой прокси задним числом
    // срезали бы дневной лимит с плато до ступени разгона. Ему — календарный день.
    const mature = isMature(acc);
    // греющийся — по реальным дням активности, но НЕ опережая календарь (защита от
    // «двух дат за сутки» на границе полуночи); зрелый — по календарю.
    const day = !restDone ? 0
      : mature ? calDay
      : Math.min(calDay, Math.max(active || 1, 0));
    const idleDays = mature ? 0 : Math.max(0, calDay - day);   // сколько суток простоя не в счёт
    // ДЛИНА ПРОГРЕВА от возраста аккаунта: свежий (его и морозят на холодном
    // касании) греем дольше, старый доверенный — быстрее. Ручная настройка
    // аккаунта (acc.warmDays) главнее всего; у зрелых берём общий срок, чтобы
    // расширение не сдвинуло их плато и не срезало дневной лимит задним числом.
    const regDate = regDateFromId(acc.user_id);
    const autoDays = warmDaysForAge(acc.user_id);
    const effDays = Number(acc.warmDays) > 0 ? Number(acc.warmDays)
      : mature ? warmDays
      : (autoDays || warmDays);
    const steps = planFor(effDays);
    // РАЗНОС ПАРТИИ: у греющегося ступени сдвинуты на 0–2 активных дня (warmLag),
    // ровно как в warmup-activity.py, — и «прогрет» он на столько же позже.
    // Зрелому сдвига нет: его лимит и выпуск не трогаем
    const lag = mature ? 0 : warmLag(acc.id);
    const planDay = day > 0 ? Math.max(1, day - lag) : 0;
    let step = steps[0];
    for (const p of steps) if (planDay >= p.day) step = p;
    const resting = step.cap === 0;
    const lastStep = steps[steps.length - 1];
    const fullDay = lastStep.day + lag;   // когда «прогрет» (активный день)
    let cap = step.cap;
    // общий потолок меняет только ПЛАТО (созревший аккаунт) — разгон не трогаем
    if (maxCap > 0 && step === lastStep) cap = maxCap;
    // РАЗГОН РАССЫЛКИ: даже прогретый по возрасту аккаунт, впервые пошедший в
    // рассылку, шлёт по дню кампании (2→…→15), а не по возрастному плато. Это тот же
    // разгон, что показывает калькулятор — теперь он применяется и к реальной отправке.
    if (!resting) {
      const from = restEnd(acc);
      const first = readCsv('drafts.csv')
        .filter((r) => r.account === acc.id && (r.ok === 'true' || r.sent === 'true') && r.at
                && Date.parse(r.at) >= from)
        .reduce((m, r) => (!m || r.at < m ? r.at : m), '');
      const outreachDay = first ? Math.floor((Date.now() - Date.parse(first)) / 864e5) : -1;
      cap = Math.min(cap, outreachCap(outreachDay));
    }
    // на аккаунт — плоский предел для теста, сильнее всего (кроме отлёжки)
    const perAcc = Number(acc.dailyCap) > 0 ? Number(acc.dailyCap) : 0;
    if (perAcc > 0 && !resting) cap = perAcc;
    const manual = !resting && (perAcc > 0 || (maxCap > 0 && step === lastStep));
    return {
      day, age, calDay, idleDays, fullDay, cap, resting, manual, atMax: step === lastStep,
      // примерная дата регистрации (по TG-id) и откуда взялась длина прогрева —
      // для показа в панели; auto=по возрасту, manual=ручная, default=общий срок
      regDate: regDate ? new Date(regDate).toISOString() : null,
      daysSrc: Number(acc.warmDays) > 0 ? 'manual' : (!mature && autoDays ? 'auto' : 'default'),
      note: perAcc > 0 && !resting ? `тест: ${cap} в сутки` : step.note,
      // прогресс прогрева, 0..100 — по РЕАЛЬНЫМ дням (day), а не по календарю:
      // в простое полоса стоит, как и день
      pct: Math.min(100, Math.round((day / fullDay) * 100)),
      restLeft: !restDone ? Math.max(0, Math.ceil((from + 864e5 - Date.now()) / 1000)) : 0,
      left: Math.max(0, cap - (done ?? doneToday(acc.id))),
    };
  }

  return { doneToday, doneTodayAll, warmFrom, warm, setMaxCap, getMaxCap, getPlan,
           checksOf, setCheckMax, getCheckMax, setWarmDays, getWarmDays };
}
