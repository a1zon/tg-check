/**
 * Раскладывает черновики по найденным контактам.
 *
 * Для каждого номера: добавить контакт -> открыть чат -> положить текст
 * в поле ввода -> уйти из чата (Telegram сохранит черновик) -> проверить,
 * что черновик на месте -> [--send: нажать кнопку отправки] -> удалить
 * контакт из адресной книги.
 *
 * Без --send ничего не отправляется: получателю не уходит ни сообщение,
 * ни push. Чаты с черновиками остаются в списке — отправляешь сам.
 * С --send панель жмёт ту же кнопку, что и человек, — сообщение уходит.
 *
 *   node draft-messages.mjs --limit 2
 *   node draft-messages.mjs --limit 2 --send --account a2
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTg } from './tg-lib.mjs';
import * as accounts from './accounts.mjs';
import * as claims from './claims.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const LIMIT = Number(arg('limit', 2));
const DELAY = Number(arg('delay', 5));   // пауза между контактами, сек
const SEND = process.argv.includes('--send');

const acc = accounts.resolve(accounts.argAccount());
console.log(`аккаунт: ${acc.title}${SEND ? '  |  РЕЖИМ ОТПРАВКИ' : '  |  только черновики'}  |  ${accounts.proxyLabel(acc.proxy)}`);

const readCsv = (f) => {
  if (!fs.existsSync(f)) return [];
  const [head, ...lines] = fs.readFileSync(f, 'utf8').trim().split('\n');
  const cols = head.split(',');
  return lines.filter(Boolean).map((l) => {
    const v = l.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, v[i] ?? '']));
  });
};

const LOG = path.join(DIR, 'drafts.csv');
const moved = accounts.migrateDraftsLog();
if (moved) console.log(`лог черновиков переведён на новый формат (${moved} строк)`);

// одному человеку пишем один раз — с любого из аккаунтов.
// Неудачные попытки (ok=false) не считаются: до них дело не дошло, ничего
// не отправлено, и такой номер должен вернуться в очередь.
const already = new Set(readCsv(LOG).filter((r) => r.ok === 'true').map((r) => r.phone));
const queue = readCsv(path.join(DIR, 'results.csv'))
  .filter((r) => r.tg === 'true' && !already.has(r.phone));
// бронируем свою пачку: два аккаунта не должны написать одному человеку
const mine = new Set(claims.take(acc.id, 'draft', queue.map((r) => r.phone), LIMIT));
const todo = queue.filter((r) => mine.has(r.phone));

process.on('exit', () => { try { claims.releaseAll(acc.id, 'draft'); } catch {} });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));

console.log(`черновиков к раскладке: ${todo.length}`);
if (!todo.length) process.exit(0);

const tpl = fs.readFileSync(path.join(DIR, 'message.txt'), 'utf8').trim();

// socks5 с паролем поднимается через локальный мост; процесс выходит — мост гаснет
const __pr = await accounts.openProxy(acc);
const ctx = await chromium.launchPersistentContext(accounts.profilePath(acc), {
  headless: false, viewport: { width: 1280, height: 900 }, timeout: 60_000,
  ...(__pr.proxy ? { proxy: __pr.proxy } : {}),
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.setDefaultTimeout(12_000);
await page.goto('https://web.telegram.org/k/', { waitUntil: 'domcontentloaded' });
const tg = createTg(page);
if ((await tg.ready()) !== 'ok') {
  console.log(`нет сессии для «${acc.title}» — войди в Telegram (шаг 1)`);
  accounts.setAuthed(acc.id, false);
  await ctx.close(); process.exit(1);
}
console.log('сессия активна');

let ok = 0, sentN = 0;
for (const [i, r] of todo.entries()) {
  const label = r.phone.slice(-10);
  // имя подставляется как «, Евгения»; если его нет — приветствие просто без имени
  const first = (r.name || '').split(' ')[0].trim();
  const name = first ? `, ${first}` : '';
  const date = (r.last_call || '').slice(0, 10).split('-').reverse().join('.');
  const text = tpl.replaceAll('{name}', name).replaceAll('{date}', date);
  let good = false, sent = '';

  try {
    await tg.resetUi();               // прошлая итерация могла оставить открытый поиск
    if (!(await tg.addContact(r.phone, label))) throw new Error('нет в Telegram');
    const row = await tg.findRow(label);
    if (!row) {
      // диагностика: что реально в выдаче поиска и где мы находимся
      const all = tg.contacts.locator('a.chatlist-chat');
      const n = await all.count();
      const names = [];
      for (let k = 0; k < Math.min(n, 4); k++) {
        names.push((await all.nth(k).innerText().catch(() => '')).trim().split('\n')[0]);
      }
      const q = await tg.contacts.locator('input.input-search-input').first().inputValue().catch(() => '?');
      const chat = (await page.locator('#column-center .peer-title').first().innerText().catch(() => 'нет')).trim();
      console.log(`    диагностика: строк=${n} [${names.join(', ')}] запрос="${q}" открыт чат="${chat}"`);
      throw new Error('контакт не создался');
    }
    await row.click({ timeout: 12_000 });
    await page.waitForTimeout(1500);

    await tg.draftMessage(text);
    // readDraft заново открывает чат — текст снова в поле ввода, чат активен
    const back = await tg.readDraft(label);
    good = !!back && back.includes(text.split('\n')[0].slice(0, 20));
    console.log(`[${i + 1}/${todo.length}] ${r.phone} — черновик ${good ? 'на месте' : 'НЕ сохранился'}`);
    if (good) ok++;

    if (good && SEND) {
      const res = await tg.sendCurrent();
      sent = String(res.sent);
      if (res.sent) { sentN++; console.log(`    отправлено (${res.how}): «${res.text.split('\n')[0].slice(0, 40)}…»`); }
      else console.log('    ОТПРАВИТЬ НЕ УДАЛОСЬ — текст остался черновиком');
    }

    await tg.deleteContact(label);          // чат остаётся, из адресной книги убираем
  } catch (e) {
    console.log(`[${i + 1}/${todo.length}] ${r.phone} — ${e.message.split('\n')[0]}`);
    await page.screenshot({ path: path.join(DIR, `debug-draft-${label}.png`) }).catch(() => {});
    await tg.resetUi();
  }
  fs.appendFileSync(LOG, `${r.phone},${acc.id},${good},${sent},${new Date().toISOString()}\n`);
  claims.release(acc.id, r.phone);         // записан — бронь снимаем
  if (i < todo.length - 1) {
    console.log(`    пауза ${DELAY}с`);
    await page.waitForTimeout(DELAY * 1000);
  }
}
console.log(`\nготово: черновиков разложено ${ok} из ${todo.length}`);
console.log(SEND ? `отправлено сообщений: ${sentN}`
                 : 'они лежат в чатах — ничего не отправлено');
await ctx.close();
