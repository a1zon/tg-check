/** Проверка, жива ли сохранённая сессия: node session-check.mjs */
import { chromium } from 'playwright';
import fs from 'node:fs';
import * as accounts from './accounts.mjs';

const acc = accounts.resolve(accounts.argAccount());
const PROFILE = accounts.profilePath(acc);
console.log(`аккаунт: ${acc.title}  |  ${accounts.proxyLabel(acc.proxy)}`);

if (!fs.existsSync(PROFILE)) {
  console.log('профиль не создан — запусти: node login.mjs');
  process.exit(1);
}
const ctx = await chromium.launchPersistentContext(PROFILE,
  { headless: true, ...accounts.launchOptions(acc) });
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto('https://web.telegram.org/k/');
const ok = await page.locator('#folders-container, .chatlist').first()
  .waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false);
console.log(ok ? '✓ сессия жива' : '✗ сессия не авторизована — запусти: node login.mjs');
await ctx.close();
