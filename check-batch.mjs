/**
 * Прогон номеров из numbers.csv по Telegram Web.
 *
 * Сигнал: после нажатия ADD всплывашка закрывается, если аккаунт есть,
 * и остаётся на месте, если аккаунта нет. Факт добавления дополнительно
 * подтверждается поиском контакта в списке — только тогда ставится «ЕСТЬ».
 *
 * Разметка Telegram Web K (проверено вживую):
 *   меню            #column-left button.sidebar-tools-button
 *                   -> .btn-menu.active .btn-menu-item с текстом ' Contacts'
 *   панель контактов #contacts-container (+ своя строка поиска, кнопка «+»)
 *   строки контактов a.chatlist-chat  (список виртуализирован, <li> нет)
 *   всплывашка       .popup-create-contact
 *   поля формы       [0] имя, [1] фамилия, [2] телефон
 *
 *   node check-batch.mjs --limit 100 --delay 15
 *   node check-batch.mjs --calibrate
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as accounts from './accounts.mjs';
import * as claims from './claims.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(DIR, 'numbers.csv');
const OUT = path.join(DIR, 'results.csv');
const acc = accounts.resolve(accounts.argAccount());

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : process.argv[i + 1];
};
const LIMIT = Number(arg('limit', 50));
const DELAY = Number(arg('delay', 15));
const CALIBRATE = process.argv.includes('--calibrate');
const MAX_UNKNOWN_IN_ROW = 5;
const T = 12_000;                       // единый таймаут кликов, без 30-секундных дефолтов

const readCsv = (f) => {
  if (!fs.existsSync(f)) return [];
  const [head, ...lines] = fs.readFileSync(f, 'utf8').trim().split('\n');
  const cols = head.split(',');
  return lines.filter(Boolean).map((l) => {
    const v = l.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, v[i] ?? '']));
  });
};
const esc = (s) => (/[",]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));

const base = readCsv(SRC);
// ??? не считается проверенным — такой номер вернётся в очередь
const done = new Set(readCsv(OUT).filter((r) => r.tg === 'true' || r.tg === 'false').map((r) => r.phone));
// бронируем свою пачку: пока мы её держим, другим аккаунтам она не достанется
const free = base.filter((r) => !done.has(r.phone)).map((r) => r.phone);
const mine = new Set(claims.take(acc.id, 'check', free, CALIBRATE ? 1 : LIMIT));
const todo = base.filter((r) => mine.has(r.phone));

// бронь не должна пережить процесс: иначе упавший прогон запрёт номера на час
process.on('exit', () => { try { claims.releaseAll(acc.id, 'check'); } catch {} });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));

console.log(`аккаунт: ${acc.title}  |  ${accounts.proxyLabel(acc.proxy)}`);
console.log(`база ${base.length} | уже проверено ${done.size} | сейчас ${todo.length}`);
if (!todo.length) process.exit(0);

// колонка by (каким аккаунтом проверено) появилась вместе с мультиаккаунтом —
// у старого файла её нет, дописываем шапку, не теряя результатов
const HEAD = 'phone,tg,name,username,calls,last_call,checked_at,by\n';
if (!fs.existsSync(OUT)) fs.writeFileSync(OUT, HEAD);
else {
  const raw = fs.readFileSync(OUT, 'utf8');
  if (!raw.split('\n')[0].includes(',by')) fs.writeFileSync(OUT, HEAD + raw.split('\n').slice(1).join('\n'));
}

// socks5 с паролем поднимается через локальный мост; процесс выходит — мост гаснет
const __pr = await accounts.openProxy(acc);
const ctx = await chromium.launchPersistentContext(accounts.profilePath(acc), {
  headless: false, viewport: { width: 1280, height: 900 }, timeout: 60_000,
  ...(__pr.proxy ? { proxy: __pr.proxy } : {}),
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.setDefaultTimeout(T);
await page.goto('https://web.telegram.org/k/', { waitUntil: 'domcontentloaded' });

const state = await Promise.race([
  page.locator('#folders-container, .chatlist').first().waitFor({ timeout: 60_000 }).then(() => 'ok'),
  page.locator('#auth-pages').first().waitFor({ timeout: 60_000 }).then(() => 'noauth'),
]).catch(() => 'timeout');
if (state !== 'ok') {
  console.log(state === 'noauth' ? '\nсессия не авторизована — войди в Telegram (шаг 1)'
                                 : '\nTelegram Web не загрузился');
  if (state === 'noauth') accounts.setAuthed(acc.id, false);
  await ctx.close();
  process.exit(1);
}
await page.waitForTimeout(2500);   // даём приложению стать интерактивным
console.log('сессия активна');

// ---------- локаторы ----------
const contacts = page.locator('#contacts-container');
const addBtn = () => contacts.locator('button.btn-circle').first();
const search = () => contacts.locator('input.input-search-input').first();
const popup = page.locator('.popup-create-contact').first();
const fields = () => popup.locator('.input-field-input, [contenteditable="true"]');

const vis = (l) => l.isVisible().catch(() => false);

async function clearSearch() {
  if (await vis(search())) await search().fill('').catch(() => {});
}

/**
 * Открывает боковое меню. Telegram Web восстанавливает состояние из прошлой
 * сессии и может стартовать в режиме поиска — тогда sidebar-tools-button это
 * стрелка «назад», а не гамбургер, и первый клик лишь выходит из поиска.
 * Поэтому жмём до тех пор, пока меню действительно не появится.
 */
async function openMenu() {
  for (let i = 0; i < 3; i++) {
    if (i > 0) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
    }
    await page.locator('#column-left button.sidebar-tools-button').first().click({ timeout: T });
    await page.waitForTimeout(700);
    if (await vis(page.locator('.btn-menu.active').first())) return true;
  }
  return false;
}

/**
 * Раздел «Контакты». Готовность проверяем по кнопке «+», а не по контейнеру:
 * #contacts-container висит в DOM и когда панель не показана, и isVisible()
 * на нём даёт ложное «уже там» — из-за этого падала первая итерация.
 */
async function goContacts() {
  if (await vis(addBtn())) return;
  if (!(await openMenu())) throw new Error('боковое меню не открылось');
  await page.locator('.btn-menu.active .btn-menu-item').filter({ hasText: 'Contacts' })
    .first().click({ timeout: T });
  await addBtn().waitFor({ state: 'visible', timeout: T });
}

async function openPopup() {
  if (await vis(popup)) return;
  await goContacts();
  await clearSearch();
  await addBtn().click({ timeout: T });
  await popup.waitFor({ state: 'visible', timeout: T });
}

async function setField(idx, value) {
  const el = fields().nth(idx);
  await el.click({ timeout: T });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
  await page.keyboard.press('Backspace');
  await el.fill(value).catch(() => page.keyboard.type(value, { delay: 25 }));
}

async function submit(phone, label) {
  await setField(0, label);   // имя
  await setField(2, phone);   // телефон
  await popup.getByRole('button', { name: /^(Add|Добавить)$/i }).first().click({ timeout: T });
}

/** Всплывашка исчезла -> контакт добавлен. */
const popupClosed = (ms = 10_000) =>
  popup.waitFor({ state: 'hidden', timeout: ms }).then(() => true).catch(() => false);

/** Ищем через поиск панели: список виртуализирован, перебор не работает. */
async function findRow(label) {
  await goContacts();
  await search().click({ timeout: T });
  await search().fill(label);
  await page.waitForTimeout(1000);
  // строку берём ТОЛЬКО если её текст содержит искомую метку:
  // иначе непрошедший фильтр вернул бы чужой контакт — и ложное «ЕСТЬ»,
  // и риск удалить настоящий контакт пользователя
  const row = contacts.locator('a.chatlist-chat').filter({ hasText: label }).first();
  return (await row.count()) > 0 ? row : null;
}

/**
 * Удаляет контакт. Путь проверен вживую:
 *   строка контакта -> карточка профиля -> карандаш Edit -> Delete Contact -> подтверждение
 * В меню «…» чата пункта удаления нет — там только Mute/Call/Block и т.п.
 */
async function deleteContact(label) {
  try {
    const row = await findRow(label);
    if (!row) return false;
    await row.click({ timeout: T });
    await page.waitForTimeout(1400);
    await page.locator('#column-center .peer-title').first().click({ timeout: T });
    await page.waitForTimeout(1600);
    // карандаш Edit — единственная видимая btn-icon.rp в правой колонке
    await page.locator('#column-right button.btn-icon.rp:not(.hide)').first().click({ timeout: T });
    await page.waitForTimeout(1400);
    await page.getByText(/^Delete Contact$/i).first().click({ timeout: T });
    await page.waitForTimeout(900);
    await page.locator('.popup-button').filter({ hasText: /^(Delete|Удалить|DELETE)$/i })
      .first().click({ timeout: T });
    await page.waitForTimeout(1400);
    await page.locator('#column-right button.sidebar-close-button').first()
      .click({ timeout: 5000 }).catch(() => {});
    const still = await findRow(label);
    await clearSearch();
    return !still;
  } catch {
    for (let k = 0; k < 3; k++) await page.keyboard.press('Escape').catch(() => {});
    await clearSearch();
    return false;
  }
}

// ---------- калибровка ----------
if (CALIBRATE) {
  await openPopup();
  const n = await fields().count();
  console.log(`\nполей во всплывашке: ${n}`);
  for (let i = 0; i < n; i++) {
    console.log(`  [${i}] text="${(await fields().nth(i).innerText().catch(() => '')).trim()}"`);
  }
  await page.screenshot({ path: path.join(DIR, 'debug-popup.png') });
  console.log('скриншот: debug-popup.png');
  await ctx.close();
  process.exit(0);
}

// ---------- прогрев: первая навигация до цикла ----------
try {
  await goContacts();
  console.log('панель контактов открыта');
} catch (e) {
  console.log('не удалось открыть контакты:', e.message.split('\n')[0]);
  await page.screenshot({ path: path.join(DIR, 'debug-nav.png') }).catch(() => {});
  await ctx.close();
  process.exit(1);
}

// ---------- цикл ----------
let found = 0, notDeleted = 0, unknownRow = 0;

for (const [i, row] of todo.entries()) {
  const phone = row.phone;
  const label = phone.slice(-10);
  let tg = null, name = '';

  try {
    await openPopup();
    await submit(phone, label);

    if (await popupClosed()) {
      const hit = await findRow(label);
      if (hit) {
        tg = true; found++; unknownRow = 0;
        // настоящее имя профиля: в списке и шапке Telegram показывает его,
        // а не заданную нами метку из цифр
        await hit.click({ timeout: T }).catch(() => {});
        await page.waitForTimeout(1200);
        const pn = (await page.locator('#column-center .peer-title').first()
          .innerText().catch(() => '')).trim();
        if (pn && pn !== label) name = pn;
        if (!(await deleteContact(label))) notDeleted++;
      } else {
        unknownRow++;                       // закрылась, но контакта нет
        await clearSearch();
      }
    } else {
      tg = false; unknownRow = 0;           // всплывашка на месте — аккаунта нет
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(400);
    }
  } catch (e) {
    unknownRow++;
    console.log(`  ! ${phone}: ${e.message.split('\n')[0]}`);
    await page.screenshot({ path: path.join(DIR, `debug-${label}.png`) }).catch(() => {});
    for (let k = 0; k < 3; k++) await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(600);
  }

  const mark = tg === true ? 'ЕСТЬ' : tg === false ? 'нет' : '???';
  fs.appendFileSync(OUT, [phone, tg ?? '', name, '', row.calls ?? '', row.last_call ?? '',
                          new Date().toISOString(), acc.id].map(esc).join(',') + '\n');
  claims.release(acc.id, phone);            // отработан и записан — бронь больше не нужна
  console.log(`[${i + 1}/${todo.length}] ${phone}  ${mark}`);

  if (unknownRow >= MAX_UNKNOWN_IN_ROW) {
    console.log(`\nстоп: ${MAX_UNKNOWN_IN_ROW} сбоев подряд — смотри debug-*.png`);
    break;
  }
  if (i < todo.length - 1) await page.waitForTimeout((DELAY + Math.random() * DELAY * 0.5) * 1000);
}

console.log(`\nготово: в Telegram ${found} из ${todo.length}`);
if (notDeleted) console.log(`не удалось удалить контактов: ${notDeleted} — почисти вручную`);
console.log(`результат: ${OUT}\nдальше: ./venv/bin/python make_base.py`);
await ctx.close();
