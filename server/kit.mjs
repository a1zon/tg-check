/**
 * Комплект запуска аккаунта на своём компьютере.
 *
 * Панель живёт на сервере, а Telegram Desktop нужно открыть на компьютере
 * человека — из браузера процесс там не запустить. Поэтому кнопка отдаёт
 * архив: tdata аккаунта, мост до его прокси и один запускаемый файл под
 * нужную систему. Человек распаковывает и щёлкает — дальше всё само.
 *
 * Архив собираем руками, без сторонних библиотек: нужен только обычный zip
 * с правом на запуск у файла-пускача (иначе macOS и Linux его не откроют).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { findTdata } from './desktop.mjs';

const CRC = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Собирает zip из списка {name, data, exec}. Имена кладём в UTF-8 (в архиве
 * русские названия) и помечаем это флагом — иначе Windows покажет кракозябры.
 */
export function buildZip(entries) {
  const now = new Date();
  const time = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const date = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  const locals = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = e.data;
    const packed = zlib.deflateRawSync(raw, { level: 6 });
    const sum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // нужна версия 2.0 — дефлейт
    local.writeUInt16LE(0x0800, 6);        // имена в UTF-8
    local.writeUInt16LE(8, 8);             // дефлейт
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(0x031e, 4);         // собрано на unix — права читаются
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(8, 10);
    head.writeUInt16LE(time, 12);
    head.writeUInt16LE(date, 14);
    head.writeUInt32LE(sum, 16);
    head.writeUInt32LE(packed.length, 20);
    head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE((((e.exec ? 0o755 : 0o644) | 0o100000) << 16) >>> 0, 38);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);

    offset += 30 + name.length + packed.length;
  }

  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

/** Все файлы папки, рекурсивно, относительными путями. */
function walk(root, base = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/** Прокси человеческой строкой -> что кладём в kit.json. */
export function kitProxy(parsed) {
  const m = String(parsed.server || '').match(/^([a-z0-9]+):\/\/([^:]+):(\d+)$/i);
  if (!m) throw new Error('не разобрал прокси');
  return { scheme: m[1].toLowerCase(), host: m[2], port: +m[3],
           user: parsed.username || '', pass: parsed.password || '' };
}

const LISTEN = 18080;   // локальный порт моста — он виден только этому компьютеру

/** Прокси на самой машине панели (127.x, localhost, ::1) — с чужого компьютера недоступен. */
export const isLoopbackProxy = (p) =>
  /^(?:[a-z0-9]+:\/\/)?(?:[^@/]*@)?(?:127(?:\.\d{1,3}){3}|localhost|\[?::1\]?)(?::|\/|$)/i
    .test(String(p || '').trim());

/**
 * Собирает архив комплекта.
 *
 * tdata достаём из исходного архива аккаунта: берём ТОЛЬКО папку tdata —
 * рядом в архиве часто лежит заметка с паролем, и её имя в не-UTF8 кодировке
 * роняет unzip целиком.
 */
// Файлы одного комплекта под префиксом root — отдельно от упаковки в zip,
// чтобы тем же набором можно было собрать и «Пульт» на несколько аккаунтов
// (каждый ложится в свою подпапку, но файлы те же самые и проверенные).
export function kitEntries({ id, title, proxy, os, uploadsZip, tdataDir, kitDir, tmpRoot }, root) {
  // Туннель на самом сервере (socks5://127.0.0.1:…) с компьютера человека не
  // достать: его 127.0.0.1 — это он сам, мост вёл бы в пустоту, и Telegram не
  // подключался, пока прокси не выключат руками. Такой прокси в комплект не
  // пишем — Telegram на ПК идёт своей сетью (или VPN этого компьютера).
  if (isLoopbackProxy(proxy)) proxy = '';
  const files = [];
  const add = (name, data, exec) => files.push({ name: `${root}/${name}`,
    data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'), exec: !!exec });

  add('kit.json', JSON.stringify({ id, title, listen: LISTEN, proxy }, null, 1) + '\n');

  const src = (f) => fs.readFileSync(path.join(kitDir, f));
  /**
   * Текст для Windows — с переводами строк по-виндовому.
   *
   * У нас в репозитории они юниксовые. Блокнот такой файл ещё покажет, а вот
   * cmd разбирает .bat построчно и на одних переводах строки ведёт себя
   * по-разному от версии к версии. Чинить это на чужом компьютере нечем,
   * поэтому кладём сразу правильные.
   *
   * А метка BOM нужна PowerShell, который идёт с самой Windows (5.1): без неё
   * он читает скрипт как ANSI, и весь русский текст превращается в кашу.
   * В .bat метку ставить нельзя — cmd попробует выполнить её как команду.
   */
  const crlf = (f) => Buffer.from(src(f).toString('utf8').replace(/\r?\n/g, '\r\n'), 'utf8');
  const bom = (f) => Buffer.concat([Buffer.from('﻿', 'utf8'), crlf(f)]);
  /**
   * Комплект без прокси. Мост не кладём вовсе: аккаунт открывается сразу,
   * а каким адресом он выйдет, решает компьютер человека (обычно его VPN).
   * Гайд при этом начинается с предупреждения — иначе человек будет искать
   * в нём шаги про прокси, которых в его случае нет.
   */
  const noProxyHead = [
    'ЭТОТ КОМПЛЕКТ БЕЗ ПРОКСИ.',
    '',
    'Аккаунт откроется сразу, никакой прокси настраивать не надо.',
    'Выйдет он тем адресом, что сейчас у компьютера: включён VPN — через VPN,',
    'не включён — домашним адресом. Нужен другой IP — включи VPN ДО запуска.',
    'Шаги про «включить прокси» ниже к твоему комплекту не относятся.',
    '', '─────────────────────────────────────────────────────────────', '', '',
  ].join('\r\n');
  const readme = (f) => (proxy ? bom(f)
    : Buffer.concat([Buffer.from('\ufeff' + noProxyHead, 'utf8'), crlf(f)]));

  // Убрать аккаунт с чужого компьютера нечем, кроме как стереть файлы: выход
  // в самом Telegram отзовёт сессию и у панели тоже. Поэтому кладём в каждый
  // комплект отдельный файл, который закрывает Telegram этой папки и удаляет
  // аккаунт — и ничего больше.
  if (os === 'win') {
    add('Открыть аккаунт.bat', crlf('open-win.bat'));
    add('open-win.ps1', bom('open-win.ps1'));
    if (proxy) add('bridge.ps1', bom('bridge.ps1'));
    add('Убрать аккаунт с компьютера.bat', crlf('clean-win.bat'));
    add('clean-win.ps1', bom('clean-win.ps1'));
    add('ЧИТАЙ-МЕНЯ.txt', readme('readme-win.txt'));
  } else {
    add(os === 'mac' ? 'Открыть аккаунт.command' : 'открыть-аккаунт.sh', src('open-unix.sh'), true);
    if (proxy) add('bridge.py', src('bridge.py'), true);
    add(os === 'mac' ? 'Убрать аккаунт с компьютера.command' : 'убрать-аккаунт.sh',
        src('clean-unix.sh'), true);
    add('ЧИТАЙ-МЕНЯ.txt', readme(os === 'mac' ? 'readme-mac.txt' : 'readme-linux.txt'));
  }

  // Откуда берём аккаунт для комплекта:
  //   tdataDir — отдельный вход, созданный специально под этот комплект.
  //              Его можно выгнать из панели, панели это не мешает.
  //   uploadsZip — копия ключа самой панели. Старый способ: выгнать нельзя,
  //              выход в Telegram убивает аккаунт и у панели.
  if (tdataDir) {
    const tdata = findTdata(tdataDir) || tdataDir;
    for (const rel of walk(tdata)) add(`tdata/${rel}`, fs.readFileSync(path.join(tdata, rel)));
  } else {
    const tmp = fs.mkdtempSync(path.join(tmpRoot, '_kit'));
    try {
      try {
        execFileSync('unzip', ['-qo', uploadsZip, '*tdata/*', '-d', tmp], { stdio: 'ignore' });
      } catch {}
      const tdata = findTdata(tmp);
      if (!tdata) throw new Error('внутри архива аккаунта нет папки tdata');
      for (const rel of walk(tdata)) add(`tdata/${rel}`, fs.readFileSync(path.join(tdata, rel)));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  return files;
}

export function buildKit(opts) {
  const root = `tg-${opts.id}-${opts.os}`;
  return { name: `${root}.zip`, body: buildZip(kitEntries(opts, root)) };
}

/**
 * «Пульт» — один архив на несколько аккаунтов. Внутри меню и папка akkaunty/,
 * где каждый аккаунт лежит ОБЫЧНЫМ комплектом (теми же проверенными файлами).
 * Меню просто запускает «Открыть аккаунт» нужной подпапки. Три аккаунта на
 * окно тут ни при чём: у каждого своя папка данных, значит своё окно.
 *
 * accounts: [{ id, title, proxy, tdataDir }]  — tdataDir у каждого свой вход.
 * Пока только Windows: там все, кому это нужно.
 */
export function buildPult({ accounts, kitDir, os = 'win' }) {
  const root = `Пульт-${accounts.length}-акк`;
  let files = [];
  const add = (name, data, exec = false) => files.push({ name: `${root}/${name}`,
    data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'), exec });

  const src = (f) => fs.readFileSync(path.join(kitDir, f));
  const crlf = (f) => Buffer.from(src(f).toString('utf8').replace(/\r?\n/g, '\r\n'), 'utf8');
  const bom = (f) => Buffer.concat([Buffer.from('﻿', 'utf8'), crlf(f)]);

  if (os === 'win') {
    add('Пульт.bat', crlf('pult-win.bat'));
    add('pult-win.ps1', bom('pult-win.ps1'));
    const head = [
      'ПУЛЬТ — несколько аккаунтов в одном месте.', '',
      'Запусти «Пульт.bat» — он покажет список. Введи номер — откроется аккаунт,',
      'каждый в своём окне. Трёх аккаунтов на окно тут нет: у каждого своя папка.', '',
      'Нужен другой IP — включи VPN ДО запуска.',
      'Убрать аккаунт с компьютера: в меню набери У и его номер (например У2).', '',
      'Нужен Telegram Desktop с desktop.telegram.org. Версия из Microsoft Store',
      'не подходит — она не открывает чужую папку с аккаунтом.', '',
    ].join('\r\n');
    add('ЧИТАЙ-МЕНЯ.txt', Buffer.concat([Buffer.from('﻿', 'utf8'), Buffer.from(head, 'utf8')]));
  } else {
    // macOS/Linux: один скрипт открывает ВСЕ аккаунты сразу, каждый своим окном.
    const launcher = os === 'mac' ? 'Открыть все.command' : 'открыть-все.sh';
    add(launcher, src('pult-unix.sh'), true);
    const head = [
      'ПУЛЬТ — все аккаунты одним скриптом.', '',
      os === 'mac'
        ? 'Распакуй папку (не из архива!). ПЕРВЫЙ запуск «Открыть все.command» —'
        : 'Распакуй папку. Запуск «открыть-все.sh»:',
      ...(os === 'mac'
        ? ['через Терминал: открой Терминал, напечатай  bash  (слово bash и пробел),',
           'перетащи в окно «Открыть все.command», нажми Enter. Со следующего раза —',
           'обычным двойным щелчком (блокировка снимется сама).']
        : ['chmod +x «открыть-все.sh» и запусти его.']),
      '',
      'Откроются ВСЕ аккаунты сразу, каждый своим окном. Нужен другой IP —',
      'включи VPN ДО запуска.', '',
      'Нужен Telegram Desktop с desktop.telegram.org. Версия из App Store',
      'не подходит — она не открывает чужую папку с аккаунтом.', '',
    ].join('\n');
    add('ЧИТАЙ-МЕНЯ.txt', Buffer.concat([Buffer.from('﻿', 'utf8'), Buffer.from(head, 'utf8')]));
  }

  for (const a of accounts) {
    const sub = `${root}/akkaunty/tg-${a.id}-${os}`;
    files = files.concat(kitEntries(
      { id: a.id, title: a.title, proxy: a.proxy, os, tdataDir: a.tdataDir, kitDir }, sub));
  }
  return { name: `${root}.zip`, body: buildZip(files) };
}

