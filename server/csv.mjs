/**
 * Чтение наших CSV: база номеров, результаты проверки, история сообщений.
 * Формат плоский и свой, поэтому обходимся без библиотеки.
 *
 * DIR приходит снаружи: модуль не должен решать, где лежит папка панели.
 *
 * Разобранные строки держим в памяти до изменения файла. Дело в том, что за
 * один ответ панели один и тот же файл перечитывается многократно: прогрев
 * спрашивает историю сообщений отдельно про КАЖДЫЙ аккаунт, а список аккаунтов
 * панель опрашивает каждые две секунды. На десятке аккаунтов и подросшей
 * истории это складывалось в секунды работы на ровном месте.
 *
 * Свежесть определяем по времени правки и размеру файла: дописал их кто угодно
 * — хоть панель, хоть Python-задача рядом — и разбор повторится.
 */
import fs from 'node:fs';
import path from 'node:path';

export const makeReadCsv = (DIR) => {
  const cache = new Map();          // имя -> { mtimeMs, size, rows }

  return (name) => {
    const file = path.join(DIR, name);
    let st;
    try { st = fs.statSync(file); } catch { cache.delete(name); return []; }

    const hit = cache.get(name);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.rows;

    // Окончания строк бывают и windows-овские: достаточно один раз переписать
    // файл чем-нибудь вроде питоновского csv.writer — и у последней колонки в
    // имени окажется возврат каретки. Снаружи файл выглядит целым, а панель
    // такую колонку уже не находит: текст ответа «пропадает».
    const [head, ...lines] = fs.readFileSync(file, 'utf8')
      .replace(/\r\n/g, '\n').trim().split('\n');
    const cols = head.split(',');
    const rows = lines.filter(Boolean).map((line) => {
      const v = line.split(',');
      return Object.fromEntries(cols.map((c, i) => [c, v[i] ?? '']));
    });
    cache.set(name, { mtimeMs: st.mtimeMs, size: st.size, rows });
    return rows;
  };
};
