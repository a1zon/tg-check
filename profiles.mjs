/**
 * Профили панели: завести, посмотреть, сменить вход, убрать.
 *
 * Профиль — это отдельная папка с данными и свой вход. Аккаунты, сессии, база,
 * результаты, лиды и прогрев у каждого свои; код общий. Кто в каком профиле —
 * решает логин: привратник пускает человека только в его папку.
 *
 *     node profiles.mjs список
 *     node profiles.mjs завести <имя> "<название>" <логин> <пароль>
 *     node profiles.mjs вход <имя> <логин> <пароль>
 *     node profiles.mjs убрать <имя>
 *
 * После «завести» и «убрать» перезапусти панель: процессы профилей поднимает
 * привратник при старте.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as auth from './auth.mjs';

const CODE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.TG_PANEL_BASE ? path.resolve(process.env.TG_PANEL_BASE) : CODE;
const FILE = path.join(BASE, 'profiles.json');
const FIRST_PORT = 8801;

const die = (m) => { console.error(`\n${m}\n`); process.exit(1); };

function read() {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(list) && list.length) return list;
  } catch {}
  return [{ id: 'main', title: 'Основной', dir: '.', port: FIRST_PORT }];
}
const write = (list) => fs.writeFileSync(FILE, JSON.stringify(list, null, 1) + '\n');
const dirOf = (p) => path.resolve(BASE, p.dir || path.join('profiles', p.id));

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || ['список', 'list'].includes(cmd)) {
  for (const p of read()) {
    const dir = dirOf(p);
    let who = 'вход не задан';
    try { who = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')).user; } catch {}
    let accs = 0;
    try { accs = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8')).length; } catch {}
    console.log(`${p.id.padEnd(12)} «${p.title}»  вход: ${who}  аккаунтов: ${accs}  порт: ${p.port}`);
    console.log(`${''.padEnd(12)} данные: ${dir}`);
  }
  process.exit(0);
}

if (['завести', 'add'].includes(cmd)) {
  const [id, title, user, pass] = rest;
  if (!id || !title || !user || !pass) {
    die('нужно: node profiles.mjs завести <имя> "<название>" <логин> <пароль>');
  }
  if (!/^[a-z0-9_-]{2,20}$/i.test(id)) die('имя профиля — латиница, цифры, дефис; 2–20 знаков');
  const list = read();
  if (list.some((p) => p.id === id)) die(`профиль «${id}» уже есть`);
  const port = Math.max(FIRST_PORT - 1, ...list.map((p) => +p.port || 0)) + 1;
  const p = { id, title, dir: path.join('profiles', id), port };
  const dir = dirOf(p);
  if (fs.existsSync(path.join(dir, 'accounts.json'))) {
    die(`в ${dir} уже лежат чьи-то данные — выбери другое имя`);
  }
  try { auth.setPasswordIn(dir, user, pass); } catch (e) { die(e.message); }
  fs.chmodSync(dir, 0o700);
  write([...list, p]);
  console.log(`\nпрофиль «${title}» заведён`);
  console.log(`  данные: ${dir}`);
  console.log(`  вход:   ${user}`);
  console.log(`\nПерезапусти панель, чтобы она его подняла:  systemctl restart tg-panel\n`);
  process.exit(0);
}

if (['вход', 'password'].includes(cmd)) {
  const [id, user, pass] = rest;
  if (!id || !user || !pass) die('нужно: node profiles.mjs вход <имя> <логин> <пароль>');
  const p = read().find((x) => x.id === id);
  if (!p) die(`нет профиля «${id}»`);
  try { auth.setPasswordIn(dirOf(p), user, pass); } catch (e) { die(e.message); }
  console.log(`\nвход профиля «${p.title}» изменён: ${user}`);
  console.log('Кто сидел в нём — разлогинится.\n');
  process.exit(0);
}

if (['убрать', 'remove'].includes(cmd)) {
  const [id] = rest;
  if (!id) die('нужно: node profiles.mjs убрать <имя>');
  const list = read();
  const p = list.find((x) => x.id === id);
  if (!p) die(`нет профиля «${id}»`);
  if (list.length === 1) die('это единственный профиль — его не убрать');
  if ((p.dir || '.') === '.') die('это основной профиль, его данные лежат в корне панели — не трогаю');
  write(list.filter((x) => x.id !== id));
  console.log(`\nпрофиль «${p.title}» убран из списка.`);
  console.log(`Данные НЕ удалены, лежат в ${dirOf(p)} — сотри руками, если они не нужны.`);
  console.log(`Там живые сессии Telegram: аккаунты останутся в сети, пока их не отключишь.`);
  console.log(`\nПерезапусти панель:  systemctl restart tg-panel\n`);
  process.exit(0);
}

die(`не знаю команду «${cmd}». Есть: список, завести, вход, убрать`);
