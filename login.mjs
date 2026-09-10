/**
 * Разовый вход в Telegram Web для одного аккаунта.
 *
 *   node login.mjs                 # первый аккаунт из реестра
 *   node login.mjs --account a2    # конкретный
 *
 * Открывает браузер с профилем этого аккаунта, ты логинишься по QR
 * (Telegram на телефоне -> Настройки -> Устройства -> Подключить устройство).
 * Сессия сохраняется на диск, остальные скрипты стартуют уже авторизованными.
 */
import { chromium } from 'playwright';
import { createTg } from './tg-lib.mjs';
import * as accounts from './accounts.mjs';

const acc = accounts.resolve(accounts.argAccount());
console.log(`аккаунт: ${acc.title}  |  ${accounts.proxyLabel(acc.proxy)}`);

// socks5 с паролем поднимается через локальный мост; процесс выходит — мост гаснет
const __pr = await accounts.openProxy(acc);
const ctx = await chromium.launchPersistentContext(accounts.profilePath(acc), {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: ['--disable-blink-features=AutomationControlled'],
  ...(__pr.proxy ? { proxy: __pr.proxy } : {}),
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto('https://web.telegram.org/k/');

console.log('Открылся Telegram Web.');
console.log('Если видишь QR — отсканируй его телефоном. Жду до 5 минут…\n');

// признак успешного входа: появился список чатов
try {
  await page.locator('#folders-container, .chatlist').first()
    .waitFor({ state: 'visible', timeout: 5 * 60_000 });
  console.log('✓ Вход выполнен, сессия сохранена');
  accounts.setAuthed(acc.id, true);
  await page.waitForTimeout(2500);
  // подписываем аккаунт его настоящим именем — в панели видно, кто есть кто
  const name = await createTg(page).accountName().catch(() => '');
  if (name && accounts.rename(acc.id, name)) console.log(`  аккаунт подписан: ${name}`);
  await page.waitForTimeout(1500);
} catch {
  console.log('✗ Не дождался входа. Нажми «Войти в Telegram» ещё раз.');
}

await ctx.close();
