/**
 * Прогрев аккаунтов.
 *
 * Свежекупленный аккаунт, который сразу пишет полусотне незнакомых людей, —
 * это мёртвый аккаунт: Telegram выдаёт PEER_FLOOD в первые же часы. Живые
 * аккаунты так себя не ведут. Поэтому новый сначала отлёживается сутки, а
 * потом наращивает объём постепенно.
 */

/** Сколько человек в сутки можно писать с аккаунта, по его возрасту. */
export const WARM_PLAN = [
  { day: 0,  cap: 0,  note: 'отлёжка — сутки ничего не делаем' },
  { day: 1,  cap: 2,  note: 'первые шаги: 2 в сутки' },
  { day: 3,  cap: 5,  note: 'разгон: 5 в сутки' },
  { day: 5,  cap: 8,  note: '8 в сутки' },
  { day: 7,  cap: 12, note: '12 в сутки' },
  { day: 10, cap: 15, note: 'прогрет: 15 в сутки' },
];

/**
 * Собирает функции прогрева поверх нужных зависимостей.
 * readCsv и accounts приходят снаружи — модуль не лезет к файлам сам.
 */
export function makeWarmup({ readCsv, accounts }) {
  /**
   * Сколько этот аккаунт СЕГОДНЯ уже написал людям. Считаем и черновики, и
   * отправленные: рискует аккаунт одинаково — в обоих случаях он добавляет
   * контакт и заводит чат, а Telegram смотрит именно на это.
   */
  function doneToday(id) {
    const today = new Date().toDateString();
    return readCsv('drafts.csv').filter((r) => r.account === id
      && (r.ok === 'true' || r.sent === 'true')
      && new Date(r.at).toDateString() === today).length;
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

  /** Состояние прогрева: возраст, дневной предел, отдыхает ли ещё. */
  function warm(acc) {
    const from = warmFrom(acc);
    const day = Math.floor((Date.now() - from) / 864e5);
    let step = WARM_PLAN[0];
    for (const p of WARM_PLAN) if (day >= p.day) step = p;
    const resting = step.cap === 0;
    return {
      day, cap: step.cap, note: step.note, resting,
      restLeft: resting ? Math.max(0, Math.ceil((from + 864e5 - Date.now()) / 1000)) : 0,
      left: Math.max(0, step.cap - doneToday(acc.id)),
    };
  }

  return { doneToday, warmFrom, warm };
}
