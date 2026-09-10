/**
 * Достаёт ключ авторизации из браузерного профиля аккаунта.
 *
 * Нужен один раз при переезде на Telethon: аккаунт, который уже вошёл через
 * Telegram Web, переподключать не надо — ключ у него тот же самый, просто
 * лежит в localStorage профиля Chromium (см. session-lib.mjs).
 *
 * Печатает одну строку JSON: {"dcId":2,"authKey":"<hex>","userId":123}
 *
 *   node profile-key.mjs --account a1
 */
import { chromium } from 'playwright';
import * as accounts from './accounts.mjs';
import { ORIGIN } from './session-lib.mjs';

const acc = accounts.resolve(accounts.argAccount());
const ctx = await chromium.launchPersistentContext(accounts.profilePath(acc), {
  headless: true, timeout: 60_000,
});
try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  // страницу не грузим целиком — нужен только домен, чтобы открылось хранилище
  await page.goto(ORIGIN, { waitUntil: 'commit', timeout: 60_000 });
  const data = await page.evaluate(() => {
    const dc = Number(localStorage.getItem('dc') || 0);
    const raw = localStorage.getItem(`dc${dc}_auth_key`) || '';
    let auth = {};
    try { auth = JSON.parse(localStorage.getItem('user_auth') || '{}'); } catch {}
    return { dc, key: raw.replace(/"/g, ''), userId: Number(auth?.id || 0) };
  });
  if (!data.dc || data.key.length !== 512) {
    console.error('в профиле нет ключа авторизации — этот аккаунт в браузер не входил');
    process.exit(1);
  }
  console.log(JSON.stringify({ dcId: data.dc, authKey: data.key, userId: data.userId }));
} finally {
  await ctx.close();
}
