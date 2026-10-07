/**
 * Лента событий — то, что человеку нужно знать о рассылке, без технических
 * строк журнала: кому написали, кто ответил и что панель на это сделала,
 * кто упёрся в лимит, где Telegram поставил паузу.
 *
 * Строки задач панель и так получает построчно (журнал), поэтому события
 * вынимаем из них же, а не заставляем каждый скрипт говорить на втором языке.
 * Прогрев в ленту не идёт — только его остановки и паузы.
 *
 * Лента живёт в events.jsonl рядом с панелью: переживает перезапуск, и после
 * падения видно, что было до него.
 */
import fs from 'node:fs';
import path from 'node:path';

const KEEP = 500;

/** +79506422462 → +7950…2462: номер узнаётся, но не светится целиком. */
const mask = (who) => (/^\+?\d{10,}$/.test(String(who))
  ? String(who).replace(/\+?(\d{4})\d+(\d{4})/, '+$1…$2') : String(who));   // id:… и @ник — как есть

export function makeEvents({ DIR, tz, nameOf = (w) => w }) {
  const FILE = path.join(DIR, 'events.jsonl');
  let list = [];
  try {
    list = fs.readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean).slice(-KEEP)
      .map((l) => JSON.parse(l));
  } catch {}

  const add = (icon, text, who = '') => {
    const e = { t: Date.now(), icon, text, who };
    list.push(e);
    if (list.length > KEEP) list = list.slice(-KEEP);
    try { fs.appendFileSync(FILE, JSON.stringify(e) + '\n'); } catch {}
  };

  // файл растёт только дописыванием — раз в запуск ужимаем до хвоста
  try { fs.writeFileSync(FILE, list.map((e) => JSON.stringify(e)).join('\n') + (list.length ? '\n' : '')); } catch {}

  /** Строка задачи: tag — аккаунт, title — какая задача. */
  function fromTask(tag, title, line) {
    const l = line.trim();
    const warmupTask = /^Прогрев/.test(title);
    let m;
    // про квоту на контакты панель сама пишет, до скольких ждать, — тут не дублируем
    if (/^стоп:.*квот/.test(l)) return;
    if (/^стоп:/.test(l)) return add('⚠', l.replace(/^стоп:\s*/, 'остановился: '), tag);
    if ((m = l.match(/флуд-пауза (\d+)/))) {
      return add('⏳', `Telegram просит паузу ${Math.round(+m[1] / 60)} мин`, tag);
    }
    if (warmupTask) return;
    // только строка «отправлено +7…: «текст»» — итог «отправлено сообщений: 0» письмом не считаем
    if ((m = l.match(/^отправлено ([+@]\S+|id:\S+):/))) return add('✉️', `написал ${mask(m[1])}`, tag);
    if ((m = l.match(/^готово: в Telegram (\d+) из (\d+)(?:, давно не заходили (\d+))?(?:; ещё (\d+) не проверились)?/))) {
      if (m[2] === '0') return;   // ни одного ответа — это упор в квоту, о нём пишет панель
      return add('🔎', `проверил ${m[2]} номеров — в Telegram ${m[1]}` +
        (m[3] ? `, ещё ${m[3]} давно не заходили (им не пишем)` : '') +
        (m[4] ? `; ${m[4]} не проверились — квота` : ''), tag);
    }
    if ((m = l.match(/(\S+) — пропуск: давно не заходил/))) {
      return add('💤', `${mask(m[1])} давно не заходил в Telegram — не пишем`, tag);
    }
    if ((m = l.match(/^завёл в аккаунте папку «(.+?)»/))) return add('📨', `завёл папку «${m[1]}»`, tag);
    if ((m = l.match(/^(\S+) — «(.*)» → (ДА|НЕТ|НЕЯСНО|модель молчит)$/))) {
      const how = { 'ДА': 'да', 'НЕТ': 'нет', 'НЕЯСНО': 'непонятно', 'модель молчит': 'не разобрал' }[m[3]];
      return add('💬', `${mask(m[1])} ответил «${m[2]}» — ${how}`, tag);
    }
    if ((m = l.match(/^ссылка отправлена (\S+):/))) return add('🔗', `${mask(m[1])} получил второе письмо со ссылкой`, tag);
    if ((m = l.match(/^отказ — поставил ([^,\s]+)/))) return add('🤝', `на отказ поставил ${m[1]}, больше не пишем`, tag);
    if (/^не пишу — посмотри этот диалог руками/.test(l)) return add('👀', 'непонятный ответ — посмотри диалог сам', tag);
    if ((m = l.match(/^@SpamBot: (.+)/)) && !/свободен|ограничений нет/i.test(m[1])) {
      return add('⛔', `ограничен Telegram: ${m[1]}`, tag);
    }
  }

  let resumedAt = 0;

  /** Строка самой панели (не задачи). */
  function fromPanel(line) {
    const l = line.trim();
    let m;
    if ((m = l.match(/^⏸ «(.+?)» выбрал дневной предел \((.+?)\)/))) {
      return add('🌙', `выбрал лимит на сегодня (${m[2]}) — продолжит завтра`, m[1]);
    }
    if (/^↺ панель перезапустилась/.test(l)) {
      resumedAt = Date.now();
      return add('↺', 'перезапускалась — прогон продолжен');
    }
    if ((m = l.match(/^■■ автопрогон остановлен: (.+)/))) return add('■', `прогон остановлен: ${m[1]}`);
    // после перезапуска прогон стартует сам — второй строкой это не нужно
    if (/^▶▶ АВТОПРОГОН/.test(l) && Date.now() - resumedAt > 10_000) return add('▶', 'прогон запущен');
    if ((m = l.match(/^⏸ «(.+?)» ограничен Telegram \((.+)\) — вернётся/))) {
      return add('⛔', `ограничен Telegram: ${m[2]}`, m[1]);
    }
  }

  /** Отдельные события, которых нет в журнале строкой. */
  const note = (icon, text, who) => add(icon, text, who);

  const hhmm = (t) => new Intl.DateTimeFormat('ru-RU',
    { timeZone: tz, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }).format(t);

  /**
   * Последние события, свежие первыми, со временем по часовому поясу базы.
   * Аккаунт показываем по имени, а не номером: имя берём на момент показа,
   * так что после переименования в ленте сразу новое.
   */
  const recent = (n = 100) => list.slice(-n).reverse()
    .map((e) => ({ ...e, who: e.who ? nameOf(e.who) : '', time: hhmm(e.t) }));

  /** Текст ответа человека из ленты (для старых ответов, где он не сохранён отдельно). */
  function replyOf(key) {
    const head = mask(key) + ' ответил «';
    for (let i = list.length - 1; i >= 0; i--) {
      const t = list[i].text || '';
      if (list[i].icon === '💬' && t.startsWith(head)) return t.slice(head.length).replace(/» — .*$/, '');
    }
    return '';
  }

  return { fromTask, fromPanel, note, recent, replyOf };
}
