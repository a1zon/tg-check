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

/**
 * Собирает архив комплекта.
 *
 * tdata достаём из исходного архива аккаунта: берём ТОЛЬКО папку tdata —
 * рядом в архиве часто лежит заметка с паролем, и её имя в не-UTF8 кодировке
 * роняет unzip целиком.
 */
export function buildKit({ id, title, proxy, os, uploadsZip, kitDir, tmpRoot }) {
  const root = `tg-${id}-${os}`;
  const files = [];
  const add = (name, data, exec) => files.push({ name: `${root}/${name}`,
    data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'), exec: !!exec });

  add('kit.json', JSON.stringify({ id, title, listen: LISTEN, proxy }, null, 1) + '\n');

  const src = (f) => fs.readFileSync(path.join(kitDir, f));
  // PowerShell, который идёт с Windows (5.1), читает скрипт без метки BOM как
  // ANSI — и весь русский текст превращается в кашу. Поэтому для винды метку
  // ставим. В .bat её ставить нельзя: cmd попробует выполнить её как команду.
  const bom = (f) => Buffer.concat([Buffer.from('﻿', 'utf8'), src(f)]);
  if (os === 'win') {
    add('Открыть аккаунт.bat', src('open-win.bat'));
    add('open-win.ps1', bom('open-win.ps1'));
    add('bridge.ps1', bom('bridge.ps1'));
    add('ЧИТАЙ-МЕНЯ.txt', bom('readme-win.txt'));
  } else {
    add(os === 'mac' ? 'Открыть аккаунт.command' : 'открыть-аккаунт.sh', src('open-unix.sh'), true);
    add('bridge.py', src('bridge.py'), true);
    add('ЧИТАЙ-МЕНЯ.txt', src(os === 'mac' ? 'readme-mac.txt' : 'readme-linux.txt'));
  }

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

  return { name: `${root}.zip`, body: buildZip(files) };
}

