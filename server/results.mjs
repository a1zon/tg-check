/**
 * Итоги рассылки для вкладки «Результаты»: сколько проверили, нашли, написали,
 * сколько ответили и что именно — да, нет, непонятно — и чем панель ответила.
 *
 * Считаем по файлам, которые пишут задачи, ничего своего не храним:
 *   results.csv  — проверка номеров (tg: true / false / idle — давно не заходит)
 *   drafts.csv   — первые письма (sent=true — ушло; ok=skip — пропущен, давно не заходил)
 *   followup.csv — ответы: verdict yes/no/unclear; sent=true — ушло второе письмо
 * Наборы «по номерам» и «по чатам» считаются отдельно, как и в рассылке.
 */
import path from 'node:path';

export function makeResults({ readRaw, tz, replyOf = () => '', oldTexts = () => ({}) }) {
  const dayOf = (iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t)
      ? new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(t) : '';
  };
  const file = (set, name) => (set === 'chats' ? path.join('chats', name) : name);
  const isPhone = (k) => /^\+?\d{10,}$/.test(k || '');

  function compute(set, titles) {
    const res = readRaw(file(set, 'results.csv'));
    const drafts = readRaw(file(set, 'drafts.csv'));
    const follow = readRaw('followup.csv');

    const days = new Map();
    const accs = new Map();
    const bump = (map, key, field) => {
      if (!key) return;
      if (!map.has(key)) map.set(key, {});
      const o = map.get(key);
      o[field] = (o[field] || 0) + 1;
    };
    const t = {};
    const inc = (f) => { t[f] = (t[f] || 0) + 1; };

    // проверка: у человека может быть несколько строк (попытки) — берём последнюю
    const last = new Map();
    for (const r of res) if (r.tg) last.set(r.phone, r);
    for (const r of last.values()) {
      // у людей из разбора чатов «проверки» не было — считаем их только найденными
      if (isPhone(r.phone)) { inc('checked'); bump(days, dayOf(r.checked_at), 'checked'); bump(accs, r.by, 'checked'); }
      if (r.tg === 'true') inc('found');
      else if (r.tg === 'idle') inc('idle');
      else if (r.tg === 'false') inc('none');
    }

    // первые письма
    const mine = new Set();
    for (const r of drafts) {
      if (r.sent === 'true') {
        mine.add(r.phone);
        inc('sent'); bump(days, dayOf(r.at), 'sent'); bump(accs, r.account, 'sent');
      } else if (r.ok === 'skip') inc('skipped');
    }

    // ответы — только тех, кому писали из этого набора; по человеку — последний итог
    const verdict = new Map();
    for (const r of follow) if (mine.has(r.key)) verdict.set(r.key, r);
    // все «да» и «непонятно» — с текстом: по одному числу не видно, что «да»
    // бывает и шуткой («100 кв. м за 2 млн»)
    const when = (iso) => { const t = Date.parse(iso); return Number.isFinite(t)
      ? new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit',
          hour: '2-digit', minute: '2-digit' }).format(t) : ''; };
    const texts = oldTexts();
    const answers = [...verdict.values()]
      .filter((r) => r.verdict === 'yes' || r.verdict === 'unclear')
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .map((r) => ({ who: r.key, account: titles(r.account), accountId: r.account, at: when(r.at),
                     verdict: r.verdict, link: r.sent === 'true',
                     text: r.text || texts[r.key] || replyOf(r.key) }));
    for (const r of verdict.values()) {
      const v = r.verdict === 'yes' ? 'yes' : r.verdict === 'no' ? 'no' : 'unclear';
      inc('replied'); inc(v);
      bump(days, dayOf(r.at), 'replied'); bump(days, dayOf(r.at), v);
      bump(accs, r.account, 'replied'); bump(accs, r.account, v);
      if (r.sent === 'true') { inc('second'); bump(days, dayOf(r.at), 'second'); }
    }

    return {
      set,
      totals: t,
      days: [...days.entries()].sort((a, b) => b[0].localeCompare(a[0]))
        .map(([day, o]) => ({ day, ...o })),
      accounts: [...accs.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        .map(([id, o]) => ({ id, title: titles(id), ...o })),
      answers,
    };
  }

  return { compute };
}
