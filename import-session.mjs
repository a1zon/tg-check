/**
 * Подключение аккаунта готовым файлом .session (плюс .json рядом).
 * QR не нужен — авторизация уже лежит в файле.
 *
 *   node import-session.mjs --account a2 --session 79001234567.session
 *   node import-session.mjs --account a2 --session acc.session --json acc.json
 *
 * .session — это база SQLite. Формат внутри бывает двух видов, оба читаем:
 *   Telethon:  sessions(dc_id, server_address, port, auth_key, takeout_id)
 *   Pyrogram:  sessions(dc_id, api_id, test_mode, auth_key, date, user_id, is_bot)
 *
 * Свой номер аккаунта (user_id) у Telethon в файле не лежит — тогда берём
 * его из .json, который обычно продаётся в паре. Без него Telegram Web
 * не считает вход выполненным.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import * as accounts from './accounts.mjs';
import { applyToProfile } from './session-lib.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
let SESSION = arg('session', '');
let JSONF = arg('json', '');

if (!SESSION) {
  console.log('как пользоваться:  node import-session.mjs --account a2 --session файл.session|.zip [--json файл.json]');
  process.exit(1);
}
if (!fs.existsSync(SESSION)) { console.log(`✕ нет файла: ${SESSION}`); process.exit(1); }

/**
 * .session часто продают в архиве вместе с .json. Если дали .zip или папку —
 * находим внутри нужную пару сами, чтобы грузить одним файлом из панели.
 */
function unpackIfNeeded(p) {
  let dir = p;
  if (fs.statSync(p).isFile() && /\.zip$/i.test(p)) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'));
    execFileSync('unzip', ['-qo', p, '-d', dir]);
  } else if (fs.statSync(p).isFile()) {
    return { session: p, json: JSONF };   // обычный .session
  }
  // ищем первый .session в папке (рекурсивно, но неглубоко)
  const walk = (d, depth = 0) => {
    if (depth > 4) return [];
    return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(d, e.name);
      return e.isDirectory() ? walk(full, depth + 1) : [full];
    });
  };
  const files = walk(dir);
  const session = files.find((f) => /\.session$/i.test(f));
  if (!session) throw new Error('в архиве нет файла .session');
  const json = JSONF || files.find((f) => /\.json$/i.test(f)) || '';
  return { session, json };
}

try {
  const found = unpackIfNeeded(SESSION);
  SESSION = found.session;
  JSONF = found.json;
} catch (e) {
  console.log(`✕ ${e.message}`);
  process.exit(1);
}

const acc = accounts.resolve(accounts.argAccount());
console.log(`аккаунт: ${acc.title}  |  ${accounts.proxyLabel(acc.proxy)}`);

/** Достаёт ключ авторизации и номер дата-центра из .session. */
function readSession(file) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (e) {
    throw new Error(`это не похоже на .session: ${e.message.split('\n')[0]}`);
  }
  try {
    const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
    if (!cols.length) throw new Error('внутри нет таблицы sessions');
    if (!cols.includes('auth_key')) throw new Error('внутри нет ключа авторизации');

    const rows = db.prepare('SELECT * FROM sessions').all();
    // рабочая строка — та, где ключ на месте; пустые заготовки пропускаем
    const row = rows.find((r) => r.auth_key && r.auth_key.length >= 256);
    if (!row) throw new Error('ключ авторизации пуст — сессия не активирована');
    return {
      dcId: row.dc_id,
      authKey: Buffer.from(row.auth_key),
      userId: row.user_id || 0,          // есть у Pyrogram, у Telethon нет
      kind: cols.includes('api_id') ? 'Pyrogram' : 'Telethon',
    };
  } finally {
    db.close();
  }
}

/** Номер аккаунта из .json — поле называют по-разному, поэтому перебираем. */
function readJson(file) {
  if (!file) return {};
  if (!fs.existsSync(file)) { console.log(`⚠ файла ${file} нет, беру только .session`); return {}; }
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.log(`⚠ .json не читается (${e.message.split('\n')[0]}) — беру только .session`); return {}; }
  const userId = Number(j.user_id ?? j.id ?? j.userId ?? j.tg_id ?? 0) || 0;
  return { userId, phone: j.phone || j.phone_number || '', twoFa: j.twoFA || j.two_fa || j.password || '' };
}

// .json ищем рядом с .session, если явно не указан
const jsonPath = JSONF || (fs.existsSync(SESSION.replace(/\.session$/i, '.json'))
  ? SESSION.replace(/\.session$/i, '.json') : '');

const s = readSession(SESSION);
const j = readJson(jsonPath);
const userId = s.userId || j.userId;

console.log(`файл: ${path.basename(SESSION)} (${s.kind}), дата-центр ${s.dcId}`);
if (jsonPath) console.log(`пара: ${path.basename(jsonPath)}${j.phone ? `, номер ${j.phone}` : ''}`);
if (!userId) {
  console.log('\n✕ не нашёл номер аккаунта (user_id).');
  console.log('  У Telethon его в .session нет — нужен .json рядом с полем user_id.');
  process.exit(1);
}
if (j.twoFa) console.log('⚠ у аккаунта включён облачный пароль — держи его под рукой');

console.log('\nпереношу сессию в профиль…');
const { state, name } = await applyToProfile(acc, { dcId: s.dcId, authKey: s.authKey, userId });

if (state === 'ok') {
  if (name && accounts.rename(acc.id, name)) console.log(`  аккаунт подписан: ${name}`);
  accounts.setAuthed(acc.id, true);
  console.log('\n✓ сессия принята, аккаунт на связи — входить по QR не нужно');
} else {
  accounts.setAuthed(acc.id, false);
  // отличить мёртвый ключ от недоступного Telegram нельзя: и то и другое
  // выглядит как бесконечное «Reconnect», поэтому называем обе причины
  console.log(state === 'rejected'
    ? '\n✕ Telegram отказал: ключ отозван'
    : '\n✕ сессия не поднялась. Либо ключ мёртв или уже отозван,\n' +
      '  либо до Telegram не достучались — проверь прокси кнопкой «Проверить IP».');
  process.exitCode = 1;
}
