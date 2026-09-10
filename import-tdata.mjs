/**
 * Подключение аккаунта папкой tdata от Telegram Desktop. QR не нужен.
 *
 *   node import-tdata.mjs --account a2 --tdata /путь/к/tdata
 *   node import-tdata.mjs --account a2 --tdata аккаунт.zip --passcode 1234
 *   node import-tdata.mjs --account a2 --tdata tdata --index 1
 *
 * Сам формат tdata читает tdata-read.py (opentele) — он же распаковывает
 * архив. Сюда приходит уже готовый ключ авторизации, дальше всё как у
 * .session: кладём его в профиль и проверяем, принял ли Telegram.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as accounts from './accounts.mjs';
import { applyToProfile } from './session-lib.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const TDATA = arg('tdata', '');
const PASSCODE = arg('passcode', '');
const INDEX = Number(arg('index', 0));

if (!TDATA) {
  console.log('как пользоваться:  node import-tdata.mjs --account a2 --tdata <папка tdata | .zip> [--passcode ****]');
  process.exit(1);
}
if (!fs.existsSync(TDATA)) { console.log(`✕ нет такого пути: ${TDATA}`); process.exit(1); }

const acc = accounts.resolve(accounts.argAccount());
console.log(`аккаунт: ${acc.title}  |  ${accounts.proxyLabel(acc.proxy)}`);

/** Питон, которым читаем tdata: своя венв для opentele, иначе системный. */
function python() {
  const win = process.platform === 'win32';
  const cands = [
    path.join(DIR, 'venv-tg', win ? 'Scripts\\python.exe' : 'bin/python'),
    path.join(DIR, 'venv', win ? 'Scripts\\python.exe' : 'bin/python'),
  ];
  for (const p of cands) if (fs.existsSync(p)) return p;
  return win ? 'python' : 'python3';
}

const args = [path.join(DIR, 'tdata-read.py'), TDATA];
if (PASSCODE) args.push(PASSCODE);
const r = spawnSync(python(), args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

if (r.error) {
  console.log(`✕ не запустился Python: ${r.error.message}`);
  console.log('  Для tdata нужен Python и opentele — смотри README, раздел «TDATA».');
  process.exit(1);
}
// stderr у скрипта — это его рассказ о ходе дела, показываем как есть
String(r.stderr || '').split('\n').filter(Boolean).forEach((l) => console.log(`  ${l}`));
if (r.status !== 0) process.exit(1);

let list;
try { list = JSON.parse(r.stdout).accounts; }
catch { console.log('✕ не понял ответ от tdata-read.py'); process.exit(1); }

if (INDEX < 0 || INDEX >= list.length) {
  console.log(`✕ в tdata ${list.length} аккаунт(ов), а запрошен номер ${INDEX}`);
  process.exit(1);
}
const a = list[INDEX];
if (list.length > 1) {
  console.log(`  в tdata несколько аккаунтов, беру №${INDEX} (остальные — через --index)`);
}
console.log(`дата-центр ${a.dc_id}${a.user_id ? `, номер аккаунта ${a.user_id}` : ''}`);
if (!a.user_id) {
  console.log('\n✕ в tdata нет номера аккаунта — без него Telegram Web не считает вход выполненным');
  process.exit(1);
}

console.log('\nпереношу сессию в профиль…');
const { state, name } = await applyToProfile(acc, {
  dcId: a.dc_id, authKey: a.auth_key, userId: a.user_id,
});

if (state === 'ok') {
  if (name && accounts.rename(acc.id, name)) console.log(`  аккаунт подписан: ${name}`);
  accounts.setAuthed(acc.id, true);
  console.log('\n✓ сессия принята, аккаунт на связи — входить по QR не нужно');
} else {
  accounts.setAuthed(acc.id, false);
  console.log(state === 'rejected'
    ? '\n✕ Telegram отказал: ключ отозван'
    : '\n✕ сессия не поднялась. Либо ключ мёртв или уже отозван,\n' +
      '  либо до Telegram не достучались — проверь прокси кнопкой «Проверить IP».');
  process.exitCode = 1;
}
