/**
 * Делёжка базы между аккаунтами.
 *
 * Аккаунты работают параллельно по одной базе, поэтому номер нельзя просто
 * «взять» — иначе двое возьмут один и тот же и напишут человеку дважды.
 * Перед работой аккаунт бронирует пачку номеров, и пока бронь висит,
 * другим они не достаются.
 *
 * Бронь живёт в claims.json, доступ к нему прикрыт файловым замком:
 * файлы общие, а процессы разные, и надеяться на порядок нельзя.
 *
 * Бронь протухает (по умолчанию час): если прогон упал вместе с процессом,
 * номера не должны остаться заперты навсегда.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(DIR, 'claims.json');
const LOCK = path.join(DIR, 'claims.lock');
const TTL = 60 * 60_000;               // сколько живёт бронь
const LOCK_STALE = 15_000;             // замок дольше этого — от упавшего процесса
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Критическая секция поверх файла: создание с 'wx' атомарно. */
function withLock(fn) {
  const start = Date.now();
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(LOCK, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(LOCK).mtimeMs > LOCK_STALE) fs.unlinkSync(LOCK);
      } catch {}
      if (Date.now() - start > 20_000) throw new Error('не дождался доступа к броням');
      sleep(60);
      continue;
    }
    try { return fn(); }
    finally {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(LOCK); } catch {}
    }
  }
}

const readAll = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };
const writeAll = (o) => fs.writeFileSync(FILE, JSON.stringify(o, null, 2) + '\n');
const fresh = (o) => {
  const now = Date.now();
  return Object.fromEntries(Object.entries(o).filter(([, v]) => now - Date.parse(v.at) < TTL));
};

/**
 * Забронировать до n номеров из candidates (в их порядке).
 * Возвращает те, что достались нам: занятые другими пропускаются.
 */
export function take(account, task, candidates, n) {
  return withLock(() => {
    const all = fresh(readAll());
    const mine = [];
    for (const phone of candidates) {
      if (mine.length >= n) break;
      // живая бронь блокирует всех, включая её владельца: она означает
      // «номер в работе». Иначе второй запуск того же аккаунта (или другая
      // задача под ним) выдал бы те же номера ещё раз.
      if (all[phone]) continue;
      all[phone] = { account, task, at: new Date().toISOString() };
      mine.push(phone);
    }
    writeAll(all);
    return mine;
  });
}

/** Снять бронь с номера: он уже отработан и записан в результаты. */
export function release(account, phone) {
  withLock(() => {
    const all = readAll();
    if (all[phone]?.account === account) delete all[phone];
    writeAll(all);
  });
}

/** Снять все брони аккаунта — на выходе из прогона, в том числе аварийном. */
export function releaseAll(account, task) {
  withLock(() => {
    const all = readAll();
    for (const [phone, v] of Object.entries(all)) {
      if (v.account === account && (!task || v.task === task)) delete all[phone];
    }
    writeAll(all);
  });
}

/** Кто что держит прямо сейчас — для панели. */
export function active() {
  const all = fresh(readAll());
  const by = {};
  for (const v of Object.values(all)) {
    const k = `${v.account}|${v.task}`;
    by[k] = (by[k] || 0) + 1;
  }
  return Object.entries(by).map(([k, n]) => {
    const [account, task] = k.split('|');
    return { account, task, n };
  });
}

/** Номера, занятые другими: их не показываем как свободные. */
export function heldByOthers(account) {
  const all = fresh(readAll());
  return new Set(Object.entries(all).filter(([, v]) => v.account !== account).map(([p]) => p));
}

/**
 * Все номера, что сейчас у кого-то в работе. Панель считает по ним настоящую
 * очередь: занятый номер свободным считать нельзя, иначе автопрогон запустит
 * пачку, которой не достанется ни одного номера.
 */
export function heldAll() {
  return new Set(Object.keys(fresh(readAll())));
}
