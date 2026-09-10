/**
 * Перенос готовой сессии Telegram в профиль аккаунта.
 *
 * Панель работает через Telegram Web K, а он держит авторизацию в localStorage
 * своего домена. Формат снят с живой сессии (node inspect-session.mjs), а не
 * угадан:
 *
 *   dc                    номер дата-центра
 *   dc<N>_auth_key        512 hex-символов, строкой JSON
 *   dc<N>_server_salt     16 hex, необязательно — Telegram выдаст свою
 *   auth_key_fingerprint  первые 8 hex ключа
 *   user_auth             {"dcID":N,"date":unix,"id":userId}
 *   account1              тот же набор одним объектом (мультиаккаунт Web K)
 *
 * И у TDATA, и у .session внутри лежит одно и то же — ключ авторизации
 * и номер дата-центра. Разбор форматов живёт в import-session.mjs и
 * import-tdata.mjs, сюда приходит уже общий вид.
 */
import { chromium } from 'playwright';
import * as accounts from './accounts.mjs';

export const ORIGIN = 'https://web.telegram.org/k/';

/** Ключ авторизации: 256 байт. Проверяем до записи, чтобы не класть в профиль мусор. */
export function normalize({ dcId, authKey, userId }) {
  const dc = Number(dcId);
  if (!Number.isInteger(dc) || dc < 1 || dc > 5) {
    throw new Error(`номер дата-центра должен быть от 1 до 5, а пришёл «${dcId}»`);
  }
  const hex = Buffer.isBuffer(authKey) ? authKey.toString('hex')
            : String(authKey || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (hex.length !== 512) {
    throw new Error(`ключ авторизации должен быть 256 байт, а в файле ${hex.length / 2}`);
  }
  const id = Number(userId || 0);
  return { dcId: dc, authKeyHex: hex, userId: Number.isInteger(id) && id > 0 ? id : 0 };
}

/** Пары ключ-значение ровно того вида, в котором их держит Web K. */
export function storagePayload({ dcId, authKeyHex, userId }) {
  const j = (v) => JSON.stringify(v);
  const fingerprint = authKeyHex.slice(0, 8);
  const date = Math.floor(Date.now() / 1000);

  const account = {
    [`dc${dcId}_auth_key`]: authKeyHex,
    auth_key_fingerprint: fingerprint,
    dcId,
    date,
  };
  if (userId) account.userId = userId;

  const out = {
    dc: String(dcId),
    [`dc${dcId}_auth_key`]: j(authKeyHex),
    auth_key_fingerprint: j(fingerprint),
    number_of_accounts: '1',
    account1: j(account),
  };
  // без user_auth Web K считает, что вход не сделан
  if (userId) out.user_auth = j({ dcID: dcId, date, id: userId });
  return out;
}

/**
 * Жив ли ключ. Проверять по появлению списка чатов НЕЛЬЗЯ: с мёртвым ключом
 * Web K всё равно рисует пустую оболочку и молча висит в «Reconnect in 2s»,
 * а страницу входа не показывает (проверено вживую). Поэтому ждём
 * положительного признака — данных, которые могли прийти только с сервера:
 * список чатов или имя аккаунта в боковом меню.
 *
 * При сомнении отвечаем «не принята»: лучше лишний раз переспросить, чем
 * записать мёртвый аккаунт в рабочие и потом гадать, почему он молчит.
 */
export async function verify(page, timeout = 50_000) {
  const { createTg } = await import('./tg-lib.mjs');
  const deadline = Date.now() + timeout;
  let sawData = 0;

  const look = () => page.evaluate(() => {
    const auth = document.querySelector('#auth-pages');
    const head = document.querySelector('#column-left')?.innerText || '';
    return {
      // отказ Telegram: показалась страница входа ИЛИ приложение стёрло user_auth.
      // Второе — самый надёжный признак: живой ключ его не трогает, мёртвый
      // обнуляется, как только приходит AUTH_KEY_UNREGISTERED.
      rejected: (!!auth && getComputedStyle(auth).display !== 'none')
                || localStorage.getItem('user_auth') === null,
      connecting: /Reconnect|Connecting|Waiting for network|Обновление|Подключение/i.test(head),
      chats: document.querySelectorAll('#folders-container a.chatlist-chat').length,
    };
  }).catch(() => null);

  while (Date.now() < deadline) {
    const st = await look();
    if (st?.rejected) return { state: 'rejected', name: '' };
    // «ок» только по данным С СЕРВЕРА: есть чаты, соединение не висит, user_auth цел.
    // Имя из меню раньше давало ложное «принято» — оно успевает мелькнуть до
    // того, как Telegram отвергнет ключ, поэтому на него больше не опираемся.
    if (st && !st.connecting && st.chats > 0) {
      if (++sawData >= 2) {
        return { state: 'ok', name: (await createTg(page).accountName().catch(() => '')) || '' };
      }
    } else {
      sawData = 0;
    }
    await page.waitForTimeout(1500);
  }

  // время вышло без явного отказа и без чатов — возможен живой аккаунт вообще
  // без единого чата. Берём его, только если user_auth уцелел и связь не висит.
  const fin = await look();
  if (fin && !fin.rejected && !fin.connecting) {
    return { state: 'ok', name: (await createTg(page).accountName().catch(() => '')) || '' };
  }
  return { state: 'timeout', name: '' };
}

/**
 * Пишет ключи в профиль аккаунта и проверяет, приняла ли их Telegram.
 *
 * Сначала подсовываем пустую страницу на нужном домене: если дать
 * приложению загрузиться, оно само начнёт писать в то же хранилище и
 * затрёт наше. Записали — и только потом пускаем приложение.
 */
export async function applyToProfile(acc, data, { headless = true, timeout = 60_000 } = {}) {
  const payload = storagePayload(normalize(data));
  const pr = await accounts.openProxy(acc);   // socks5+auth поднимет локальный мост
  const ctx = await chromium.launchPersistentContext(accounts.profilePath(acc), {
    headless, viewport: { width: 1280, height: 900 }, timeout: 60_000,
    ...(pr.proxy ? { proxy: pr.proxy } : {}),
  });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());

    await page.route('**/*', (r) =>
      r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<html></html>' }));
    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
    await page.evaluate((kv) => {
      localStorage.clear();
      for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
    }, payload);
    await page.unroute('**/*');

    // теперь приложение поднимается уже с нашей авторизацией
    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
    return await verify(page, timeout);
  } finally {
    await ctx.close().catch(() => {});
    await pr.close();
  }
}
