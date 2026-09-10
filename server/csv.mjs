/**
 * Чтение наших CSV: база номеров, результаты проверки, история сообщений.
 * Формат плоский и свой, поэтому обходимся без библиотеки.
 *
 * DIR приходит снаружи: модуль не должен решать, где лежит папка панели.
 */
import fs from 'node:fs';
import path from 'node:path';

export const makeReadCsv = (DIR) => (name) => {
  const file = path.join(DIR, name);
  if (!fs.existsSync(file)) return [];
  const [head, ...lines] = fs.readFileSync(file, 'utf8').trim().split('\n');
  const cols = head.split(',');
  return lines.filter(Boolean).map((line) => {
    const v = line.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, v[i] ?? '']));
  });
};
