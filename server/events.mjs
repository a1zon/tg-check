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

/** 1 номер, 3 номера, 5 номеров. */
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

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

  const curChat = new Map();   // аккаунт → какой чат он сейчас разбирает

  /** Разбор чатов: по строке на каждый чат и итог — иначе непонятно, что он делает. */
  function fromParse(tag, l) {
    let m;
    if ((m = l.match(/^источников: (\d+)(?:, уже разобрано раньше (\d+))?/))) {
      return add('🔎', `разбор чатов: в списке ${m[1]}`, tag);
    }
    if ((m = l.match(/^▸ (.+?) — уже разобран/))) return add('⏭', `«${m[1]}» уже разобран раньше — пропускаю`, tag);
    if ((m = l.match(/^▸ (.+?) — пропускаю: (.+)/))) return add('⚠', `«${m[1]}» пропущен: ${m[2]}`, tag);
    if ((m = l.match(/^▸ (.+)/))) { curChat.set(tag, m[1]); return; }
    const chat = `«${curChat.get(tag) || 'чат'}»`;
    if (/^участники скрыты — читаю/.test(l)) return add('📖', `${chat}: участники скрыты — беру тех, кто писал в чат`, tag);
    if ((m = l.match(/^участников (\d+) · новых в списке \d+ · в очередь на рассылку (\d+)/))) {
      return add('📥', `${chat}: нашёл ${m[1]}, в очередь ${m[2]}` +
        (+m[1] > +m[2] ? ` (остальные уже были в очереди)` : ''), tag);
    }
    if (/^список участников закрыт/.test(l)) return add('⚠', `${chat}: список участников закрыт — пропущен`, tag);
    if (/^чат приватный/.test(l)) return add('⚠', `${chat}: аккаунт в нём не состоит — пропущен`, tag);
    if ((m = l.match(/^не вышло: (.+)/))) return add('⚠', `${chat}: не вышло — ${m[1]}`, tag);
    if ((m = l.match(/^итого: чатов разобрано (\d+) · участников (\d+) · в очередь на рассылку добавлено (\d+)/))) {
      return add('✅', `разбор закончен: чатов ${m[1]}, людей ${m[2]}, новых в очереди ${m[3]}`, tag);
    }
    // в скобках — почему остановился: предел «человек за заход» или пауза Telegram,
    // иначе штатная остановка на пределе выглядела как сбой
    if ((m = l.match(/^осталось чатов: (\d+)(?: \(([^)]*)\))?/))) {
      return add('⏳', `не дошёл до ${m[1]} чатов${m[2] ? ` — ${m[2]}` : ''}; запусти разбор ещё раз`, tag);
    }
    if ((m = l.match(/^разбор остановлен \(([^)]*)\)/))) {
      return add('⏳', `остановил разбор: ${m[1]}; остальные чаты — у других аккаунтов`, tag);
    }
  }

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
    if (/^Разбор чатов/.test(title)) return fromParse(tag, l);
    // только строка «отправлено +7…: «текст»» — итог «отправлено сообщений: 0» письмом не считаем
    if ((m = l.match(/^отправлено ([+@]\S+|id:\S+):/))) return add('✉️', `написал ${mask(m[1])}`, tag);
    if ((m = l.match(/^готово: проверено (\d+): живых в Telegram (\d+), давно не заходили (\d+), нет в Telegram (\d+)(?:; ещё (\d+) не проверились)?/))) {
      const [total, alive, idle, none] = m.slice(1, 5).map(Number);
      if (!total) return;   // ни одного ответа — это упор в квоту, о нём пишет панель
      // давно не заходившие — тоже в Telegram: показываем их частью найденных,
      // а не «ещё N», иначе один номер читается как два
      return add('🔎', `проверил ${total} ${plural(total, 'номер', 'номера', 'номеров')}: в Telegram ${alive + idle}` +
        (idle ? `, из них ${idle} давно не ${idle === 1 ? 'заходил' : 'заходили'} — не пишем` : '') +
        (none ? `; нет в Telegram ${none}` : '') +
        (m[5] ? `; ${m[5]} не проверились — квота` : ''), tag);
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
