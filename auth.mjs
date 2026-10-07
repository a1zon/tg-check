/**
 * Вход в панель по логину и паролю.
 *
 * Пароль на диске не лежит: хранится scrypt-хэш со своей солью
 * (auth.json). Сессия — подписанная кука, подпись на случайном секрете
 * оттуда же, поэтому перезапуск панели не разлогинивает.
 *
 * Задать логин с паролем:  node set-password.mjs <логин> <пароль>
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Папка данных профиля (вход в панель): её задаёт панель через TG_PANEL_DIR,
// иначе — там же, где код.
const DIR = process.env.TG_PANEL_DIR
  ? path.resolve(process.env.TG_PANEL_DIR)
  : path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(DIR, 'auth.json');
const DAYS = 14;                       // сколько живёт вход
export const COOKIE = 'tgpanel';

const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; } };

export const configured = () => !!read()?.hash;

const hash = (pass, salt) => crypto.scryptSync(String(pass), salt, 64, { N: 16384, r: 8, p: 1 });

export function setPassword(user, pass) {
  return setPasswordIn(DIR, user, pass);
}

/** То же, но для папки другого профиля: у каждого свой вход. */
export function setPasswordIn(dir, user, pass) {
  const u = String(user || '').trim();
  if (!u) throw new Error('пустой логин');
  if (String(pass || '').length < 8) throw new Error('пароль короче восьми символов');
  const salt = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({
    user: u,
    salt,
    hash: hash(pass, salt).toString('hex'),
    // секрет подписи кук: меняется вместе с паролем, поэтому смена пароля
    // разлогинивает всех, кто уже сидел в панели
    secret: crypto.randomBytes(32).toString('hex'),
    at: new Date().toISOString(),
  }, null, 2) + '\n', { mode: 0o600 });
  return u;
}

/** Сверка пароля. Сравниваем за постоянное время — иначе подбор по задержке. */
export function check(user, pass) {
  return checkWith(read(), user, pass);
}

/**
 * Сверка входа другого профиля: его auth.json лежит в своей папке с данными.
 * Нужна привратнику — он один спрашивает логин, а профилей у него несколько.
 */
export function checkIn(dir, user, pass) {
  try {
    return checkWith(JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')), user, pass);
  } catch { return false; }
}

function checkWith(a, user, pass) {
  if (!a?.hash) return false;
  const userOk = crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(user || '')).digest(),
    crypto.createHash('sha256').update(a.user).digest());
  let passOk = false;
  try {
    passOk = crypto.timingSafeEqual(hash(pass, a.salt), Buffer.from(a.hash, 'hex'));
  } catch { passOk = false; }
  return userOk && passOk;
}

const sign = (data, secret) =>
  crypto.createHmac('sha256', secret).update(data).digest('base64url');

export function issue() {
  const a = read();
  if (!a) return '';
  const payload = Buffer.from(JSON.stringify({
    u: a.user, exp: Date.now() + DAYS * 864e5,
  })).toString('base64url');
  return `${payload}.${sign(payload, a.secret)}`;
}

export function valid(token) {
  const a = read();
  if (!a || !token) return false;
  const [payload, sig] = String(token).split('.');
  if (!payload || !sig) return false;
  const want = sign(payload, a.secret);
  if (sig.length !== want.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return false;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return p.u === a.user && p.exp > Date.now();
  } catch { return false; }
}

export const cookieFrom = (header) => Object.fromEntries(
  String(header || '').split(';').map((c) => {
    const i = c.indexOf('=');
    return i === -1 ? [c.trim(), ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()];
  }));

/**
 * Задержка перед ответом на неудачный вход. Считаем по адресу: восемь
 * промахов — и адрес отдыхает пять минут. Подбор пароля становится бесполезен.
 */
const fails = new Map();
export function blocked(ip) {
  const f = fails.get(ip);
  if (!f) return 0;
  if (Date.now() > f.until) { fails.delete(ip); return 0; }
  return f.n >= 8 ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
export function noteFail(ip) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n += 1;
  f.until = Date.now() + 5 * 60_000;
  fails.set(ip, f);
}
export const noteOk = (ip) => fails.delete(ip);
