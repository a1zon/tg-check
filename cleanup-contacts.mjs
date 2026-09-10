/**
 * Удаляет контакты, созданные прогоном (имя = 10 цифр номера).
 *
 * Путь удаления в Telegram Web K (найден вживую):
 *   контакт -> карточка профиля -> карандаш Edit -> Delete Contact -> подтверждение
 * В меню «…» чата пункта удаления НЕТ.
 *
 *   node cleanup-contacts.mjs            # все, у кого в results.csv tg=true
 *   node cleanup-contacts.mjs 9018557772 9014131729
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as accounts from './accounts.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const T = 12_000;
const acc = accounts.resolve(accounts.argAccount());
console.log(`аккаунт: ${acc.title}  |  ${accounts.proxyLabel(acc.proxy)}`);

let labels = process.argv.slice(2).filter((a) => /^\d{10}$/.test(a));
if (!labels.length) {
  const f = path.join(DIR, 'results.csv');
  if (!fs.existsSync(f)) { console.log('нет results.csv'); process.exit(1); }
  const [head, ...lines] = fs.readFileSync(f, 'utf8').trim().split('\n');
  const cols = head.split(',');
  labels = lines.filter(Boolean).map((l) => Object.fromEntries(cols.map((c, i) => [c, l.split(',')[i]])))
    .filter((r) => r.tg === 'true').map((r) => r.phone.slice(-10));
}
console.log(`к удалению: ${labels.length}`);
if (!labels.length) process.exit(0);

// socks5 с паролем поднимается через локальный мост; процесс выходит — мост гаснет
const __pr = await accounts.openProxy(acc);
const ctx = await chromium.launchPersistentContext(accounts.profilePath(acc), {
  headless: false, viewport: { width: 1280, height: 900 }, timeout: 60_000,
  ...(__pr.proxy ? { proxy: __pr.proxy } : {}),
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.setDefaultTimeout(T);
await page.goto('https://web.telegram.org/k/', { waitUntil: 'domcontentloaded' });
await page.locator('#folders-container, .chatlist').first().waitFor({ timeout: 60_000 });
await page.waitForTimeout(2500);

const contacts = page.locator('#contacts-container');
const addBtn = () => contacts.locator('button.btn-circle').first();
const search = () => contacts.locator('input.input-search-input').first();
const vis = (l) => l.isVisible().catch(() => false);

async function goContacts() {
  if (await vis(addBtn())) return;
  for (let i = 0; i < 3; i++) {
    if (i > 0) { await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(500); }
    await page.locator('#column-left button.sidebar-tools-button').first().click({ timeout: T });
    await page.waitForTimeout(800);
    if (await vis(page.locator('.btn-menu.active').first())) {
      await page.locator('.btn-menu.active .btn-menu-item').filter({ hasText: 'Contacts' })
        .first().click({ timeout: T });
      await addBtn().waitFor({ state: 'visible', timeout: T });
      return;
    }
  }
  throw new Error('не удалось открыть контакты');
}

async function findRow(label) {
  await goContacts();
  await search().click({ timeout: T });
  await search().fill(label);
  await page.waitForTimeout(1100);
  // строку берём ТОЛЬКО если её текст содержит искомую метку:
  // иначе непрошедший фильтр вернул бы чужой контакт — и ложное «ЕСТЬ»,
  // и риск удалить настоящий контакт пользователя
  const row = contacts.locator('a.chatlist-chat').filter({ hasText: label }).first();
  return (await row.count()) > 0 ? row : null;
}

async function removeOne(label) {
  const row = await findRow(label);
  if (!row) return 'не найден';
  await row.click({ timeout: T });
  await page.waitForTimeout(1400);
  await page.locator('#column-center .peer-title').first().click({ timeout: T });
  await page.waitForTimeout(1600);
  // карандаш Edit: единственная видимая btn-icon.rp в правой колонке
  await page.locator('#column-right button.btn-icon.rp:not(.hide)').first().click({ timeout: T });
  await page.waitForTimeout(1400);
  await page.getByText(/^Delete Contact$/i).first().click({ timeout: T });
  await page.waitForTimeout(900);
  await page.locator('.popup-button').filter({ hasText: /^(Delete|Удалить|DELETE)$/i })
    .first().click({ timeout: T });
  await page.waitForTimeout(1400);
  await page.locator('#column-right button.sidebar-close-button').first()
    .click({ timeout: 5000 }).catch(() => {});
  return (await findRow(label)) ? 'ОСТАЛСЯ' : 'удалён';
}

let ok = 0;
for (const [i, label] of labels.entries()) {
  try {
    const r = await removeOne(label);
    if (r === 'удалён') ok++;
    console.log(`[${i + 1}/${labels.length}] ${label} — ${r}`);
  } catch (e) {
    console.log(`[${i + 1}/${labels.length}] ${label} — ошибка: ${e.message.split('\n')[0]}`);
    await page.screenshot({ path: path.join(DIR, `debug-del-${label}.png`) }).catch(() => {});
    for (let k = 0; k < 3; k++) await page.keyboard.press('Escape').catch(() => {});
  }
  await page.waitForTimeout(800);
}
console.log(`\nудалено: ${ok} из ${labels.length}`);
await ctx.close();
