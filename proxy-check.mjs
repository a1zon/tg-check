/**
 * Проверка прокси аккаунта: сравнивает свой адрес и адрес, с которым
 * в интернет выходит браузер этого аккаунта.
 *
 * Запускать ДО входа по QR: если прокси не работает, вход всё равно
 * не пройдёт, а сессия привяжется к неправильному адресу.
 *
 *   node proxy-check.mjs --account a2
 */
import { chromium } from 'playwright';
import * as accounts from './accounts.mjs';

const IPURL = 'https://api.ipify.org?format=json';
const acc = accounts.resolve(accounts.argAccount());
console.log(`аккаунт: ${acc.title}`);
console.log(`прокси:  ${accounts.proxyLabel(acc.proxy)}`);
const warn = accounts.proxyWarning(acc.proxy);
if (warn) console.log(`⚠ ${warn}`);

/** Наш собственный адрес — без прокси, напрямую. */
const mine = await fetch(IPURL, { signal: AbortSignal.timeout(15_000) })
  .then((r) => r.json()).then((j) => j.ip).catch((e) => `не узнать (${e.message})`);
console.log(`\nсвой адрес:      ${mine}`);

if (!acc.proxy) {
  console.log('\nпрокси не задан — аккаунт ходит с вашего адреса.');
  console.log('Чтобы завести второй аккаунт с другого IP, впиши ему прокси в панели.');
  process.exit(0);
}

// проверяем ровно тем же способом, каким потом пойдёт сам аккаунт
// (для socks5 с паролем внутри поднимется локальный мост)
let browser, pr = { close: () => {} };
try {
  pr = await accounts.openProxy(acc);
  browser = await chromium.launch({ headless: true, ...(pr.proxy ? { proxy: pr.proxy } : {}) });
  const page = await browser.newPage();
  await page.goto(IPURL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const through = JSON.parse(await page.locator('body').innerText()).ip;
  console.log(`через прокси:    ${through}`);

  if (through === mine) {
    console.log('\n✕ адрес не изменился — трафик идёт мимо прокси.');
    process.exitCode = 1;
  } else {
    console.log('\n✓ прокси работает: аккаунт будет виден Telegram с этого адреса.');
  }
} catch (e) {
  const m = e.message || '';
  const why = /ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED/.test(m)
      ? 'прокси не отвечает — проверь адрес и порт'
    : /ERR_PROXY_AUTH|407/.test(m)
      ? 'прокси требует логин с паролем — впиши их: host:port:логин:пароль'
    : /ERR_NAME_NOT_RESOLVED/.test(m)
      ? 'не находится такой хост — опечатка в адресе прокси'
    : /Timeout|timeout/.test(m)
      // с неверным логином Chromium не показывает 407, а молча висит —
      // на глаз это неотличимо от мёртвого прокси, поэтому говорим про оба
      ? (accounts.parseProxy(acc.proxy).username
          ? 'прокси не ответил: либо он мёртв, либо не подошли логин с паролем'
          : 'прокси не ответил вовремя — скорее всего мёртвый')
      : m.split('\n')[0];
  console.log(`через прокси:    не получилось\n\n✕ ${why}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await pr.close();
}
