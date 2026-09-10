/**
 * Сводка по аккаунту: непрочитанные чаты и черновики. Только чтение —
 * ничего не добавляет, не пишет и не отправляет.
 *
 *   node stats.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as accounts from './accounts.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const acc = accounts.resolve(accounts.argAccount());
console.log(`аккаунт: ${acc.title}  |  ${accounts.proxyLabel(acc.proxy)}`);
// socks5 с паролем поднимается через локальный мост; процесс выходит — мост гаснет
const __pr = await accounts.openProxy(acc);
const ctx = await chromium.launchPersistentContext(accounts.profilePath(acc), {
  headless: true, viewport: { width: 1280, height: 900 }, timeout: 60_000,
  ...(__pr.proxy ? { proxy: __pr.proxy } : {}),
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.setDefaultTimeout(15_000);
await page.goto('https://web.telegram.org/k/', { waitUntil: 'domcontentloaded' });

const st = await Promise.race([
  page.locator('#folders-container, .chatlist').first().waitFor({ timeout: 40_000 }).then(() => 'ok'),
  page.locator('#auth-pages').first().waitFor({ timeout: 40_000 }).then(() => 'noauth'),
]).catch(() => 'timeout');
if (st !== 'ok') { console.log(st === 'noauth' ? 'не авторизован' : 'не загрузился'); await ctx.close(); process.exit(1); }
await page.waitForTimeout(2000);

const rows = page.locator('#folders-container a.chatlist-chat');
const total = await rows.count();

// имена людей из базы — по ним отделяем рабочие чаты от личных
const known = new Set();
const rp = path.join(DIR, 'results.csv');
if (fs.existsSync(rp)) {
  const [head, ...lines] = fs.readFileSync(rp, 'utf8').trim().split('\n');
  const ci = head.split(',');
  for (const l of lines.filter(Boolean)) {
    const v = l.split(',');
    const r = Object.fromEntries(ci.map((c, i) => [c, v[i] ?? '']));
    if (r.tg === 'true' && r.name) known.add(r.name.trim().toLowerCase());
  }
}

const work = [], other = [], drafts = [];
for (let i = 0; i < Math.min(total, 40); i++) {
  const r = rows.nth(i);
  const title = (await r.locator('.peer-title').first().innerText().catch(() => '')).trim();
  const prev = (await r.locator('.dialog-subtitle, .row-subtitle').first().innerText()
    .catch(() => '')).trim().replace(/\s+/g, ' ');
  const badge = (await r.locator('.dialog-subtitle-badge-unread').first().innerText().catch(() => '')).trim();
  const isDraft = /^Draft:/i.test(prev);

  if (isDraft) drafts.push({ title, prev: prev.replace(/^Draft:\s*/i, '').slice(0, 80) });
  if (badge) {
    const item = { title, prev: prev.slice(0, 80), n: /^\d+$/.test(badge) ? +badge : 1 };
    (known.has(title.toLowerCase()) ? work : other).push(item);
  }
}

console.log(`\nвсего чатов:        ${total}`);
console.log(`черновиков готово:  ${drafts.length}`);
console.log(`ответов по базе:    ${work.length}`);

if (work.length) {
  console.log('\n— ОТВЕТИЛИ ЛЮДИ ИЗ БАЗЫ —');
  for (const u of work.sort((a, b) => b.n - a.n)) console.log(`  [${u.n}] ${u.title}: ${u.prev}`);
} else {
  console.log('\nответов от людей из базы пока нет');
}

if (drafts.length) {
  console.log('\n— ЧЕРНОВИКИ ЖДУТ ОТПРАВКИ —');
  for (const d of drafts) console.log(`  ${d.title}: ${d.prev}`);
}

if (other.length) {
  const msgs = other.reduce((s, o) => s + o.n, 0);
  console.log(`\nпрочие личные чаты: ${other.length} непрочитанных (${msgs} сообщений) — не по базе`);
}
await ctx.close();
