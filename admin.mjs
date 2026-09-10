/**
 * Пульт: веб-обёртка над теми же скриптами, что запускаются из терминала.
 *
 * Панель НЕ открывает Telegram сама и не держит браузер — она запускает
 * дочерним процессом уже существующие скрипты и показывает их вывод живьём.
 *
 * Аккаунты работают ПАРАЛЛЕЛЬНО: у каждого свой профиль, свой процесс и,
 * если задан, свой прокси. Один аккаунт — одна задача за раз (профиль
 * Telegram занимает ровно один процесс). Чтобы двое не прошли по одним и
 * тем же номерам, база делится бронями (claims.mjs).
 *
 * Вход в панель — по логину и паролю:  node set-password.mjs <логин> <пароль>
 *
 *   node admin.mjs                        -> http://localhost:8787
 *   node admin.mjs --host 0.0.0.0 --cert cert.pem --key key.pem
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, exec, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as accounts from './accounts.mjs';
import * as claims from './claims.mjs';
import * as auth from './auth.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };

const PORT = Number(arg('port', process.env.PORT || 8787));
const HOST = arg('host', process.env.HOST || '127.0.0.1');
const CERT = arg('cert', ''), KEY = arg('key', '');
const TLS = !!(CERT && KEY);
const LOCAL = /^(127\.|::1|localhost$)/.test(HOST);

/**
 * Задачи панели. Работа идёт родным каналом Telegram (MTProto) через
 * Telethon — это Python, поэтому у задач помечен свой запускающий.
 * Старые скрипты на Playwright лежат рядом (*.mjs) и запускаются руками:
 * они больше не нужны для работы, но и не мешают.
 */
const TASKS = {
  login:  { title: 'Вход в Telegram',  cmd: ['login-qr.py'],        py: true },
  check:  { title: 'Проверка базы',    cmd: ['check-batch.py'],     py: true, opts: true },
  drafts: { title: 'Черновики',        cmd: ['draft-messages.py'],  py: true, opts: true, send: true, voice: true },
  stats:  { title: 'Сводка',           cmd: ['stats.py'],           py: true },
  clean:  { title: 'Чистка контактов', cmd: ['cleanup-contacts.py'],py: true },
  proxy:  { title: 'Проверка прокси',  cmd: ['proxy-check.py'],     py: true },
  // перенос уже вошедшего в браузере аккаунта на Telethon: ключ тот же,
  // заново сканировать QR не нужно
  migrate:{ title: 'Перенос сессии',   cmd: ['import-account.py'],  py: true,
            extra: ['--from-profile'] },
};

/** Что сейчас крутится: ключ — аккаунт (или '_base' для разбора файла). */
const running = new Map();
const log = [];                       // кольцевой буфер строк
const push = (line) => { log.push(line); if (log.length > 1000) log.shift(); };

const readCsv = (f) => {
  const p = path.join(DIR, f);
  if (!fs.existsSync(p)) return [];
  const [head, ...lines] = fs.readFileSync(p, 'utf8').trim().split('\n');
  const cols = head.split(',');
  return lines.filter(Boolean).map((l) => {
    const v = l.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, v[i] ?? '']));
  });
};

/** Метка строки с итогом пачки: её печатает tglib.state() в конце задачи. */
const STATE_MARK = '\u2301STATE ';

/** Текущие числа по файлам: их показывает панель и из них копится сводка. */
function counts() {
  const res = readCsv('results.csv');
  const dr = readCsv('drafts.csv');
  return {
    checked: res.filter((r) => r.tg === 'true' || r.tg === 'false').length,
    found: res.filter((r) => r.tg === 'true').length,
    none: res.filter((r) => r.tg === 'false').length,
    drafts: dr.filter((r) => r.ok === 'true').length,
    sent: dr.filter((r) => r.sent === 'true').length,
  };
}

/**
 * Сводка за всё время. Чистка уносит results.csv и drafts.csv в бэкап, и
 * вместе с ними исчезли бы все числа — поэтому перед тем, как унести, панель
 * складывает их сюда. Показываем всегда кеш + то, что лежит в файлах сейчас:
 * так после чистки итог не меняется ни на единицу.
 */
const STATS = path.join(DIR, 'stats-cache.json');
const KEEP_WIPES = 20;

const statsRead = () => {
  try {
    const o = JSON.parse(fs.readFileSync(STATS, 'utf8'));
    return { checked: 0, found: 0, none: 0, drafts: 0, sent: 0, since: '', wipes: [], ...o };
  } catch {
    return { checked: 0, found: 0, none: 0, drafts: 0, sent: 0, since: '', wipes: [] };
  }
};

/** Прибавить к кешу то, что сейчас в файлах, и запомнить саму чистку. */
function statsFold(now, about) {
  const c = statsRead();
  for (const k of ['checked', 'found', 'none', 'drafts', 'sent']) c[k] += now[k];
  if (!c.since) c.since = about.at;
  c.wipes = [{ ...about, ...now }, ...c.wipes].slice(0, KEEP_WIPES);
  fs.writeFileSync(STATS, JSON.stringify(c, null, 2) + '\n');
  return c;
}

/** Что показывать как «за всё время»: кеш плюс нынешние файлы. */
function statsTotal(now) {
  const c = statsRead();
  const t = {};
  for (const k of ['checked', 'found', 'none', 'drafts', 'sent']) t[k] = c[k] + now[k];
  return { ...t, since: c.since, last: c.wipes[0] || null, wipes: c.wipes.length };
}

/**
 * Уборка после выхода из аккаунтов: панель становится как новая, а числа
 * остаются. Всё, что человек собирал руками (база, результаты, история
 * сообщений, загруженные файлы), уезжает в бэкап-папку рядом с панелью;
 * туда же — реестр аккаунтов и файлы сессий: если у какого-то аккаунта выйти
 * не вышло, его сессия ещё живая, и терять её нельзя. Насовсем удаляем только
 * восстановимое: профили браузера, картинку QR, брони.
 * Вход в панель (auth.json), текст сообщения и накопленную сводку не трогаем.
 */
function wipeAll() {
  const at = new Date().toISOString();
  const stamp = at.replace(/[:T]/g, '-').slice(0, 19);
  const backup = path.join(DIR, `_backup_${stamp}`);
  fs.mkdirSync(backup, { recursive: true });
  const move = (name) => {
    const src = path.join(DIR, name);
    if (fs.existsSync(src)) { fs.renameSync(src, path.join(backup, name)); return true; }
    return false;
  };
  const wipe = (name) => { try { fs.rmSync(path.join(DIR, name), { recursive: true, force: true }); } catch {} };

  // числа снимаем ДО того, как унести файлы: после переноса считать будет нечего
  const now = counts();
  const had = accounts.list().length;

  let saved = 0;
  for (const f of ['numbers.csv', 'base.json', 'results.csv', 'drafts.csv',
                   'accounts.json', 'sessions', 'uploads', 'voice.ogg', 'voice.json', 'replies.json']) {
    if (move(f)) saved++;
  }
  for (const f of ['tg-profile', 'accounts', 'qr', 'claims.json', 'desktop']) wipe(f);
  // пустой бэкап (чистили уже чистую панель) не оставляем
  let rel = path.basename(backup);
  if (!saved) { try { fs.rmdirSync(backup); } catch {} rel = ''; }

  // и только теперь — в кеш: чистку начисто в историю не пишем, иначе она
  // копила бы пустые строки с папками, которых нет
  const total = saved || had ? statsFold(now, { at, accounts: had, backup: rel }) : statsRead();

  push(`🧹 чисто: аккаунтов в панели нет` + (rel ? `, данные в ${rel}` : ''));
  push(`   сводка за всё время осталась: проверено ${total.checked} · найдено ${total.found}` +
       ` · написано ${total.drafts} · отправлено ${total.sent}`);
  return { backup: rel ? path.join(DIR, rel) : '' };
}

/**
 * Запуск дочернего процесса под ключом. Аккаунты идут параллельно, поэтому
 * вывод помечаем именем — иначе в общем логе не разобрать, кто что пишет.
 */
function run(key, tag, title, cmd, args, onDone) {
  const child = spawn(cmd, args, { cwd: DIR });
  const rec = { child, title, since: Date.now(), state: null };
  running.set(key, rec);
  push(`\n▶ ${title}: ${args.map((a) => path.basename(a)).join(' ')}`);
  // Последняя строка задачи — итог для панели, а не для человека: сколько
  // сделано, сколько осталось и не придержал ли Telegram аккаунт. В журнал
  // её не пишем — по ней решает автопрогон.
  const feed = (b) => String(b).split('\n').filter(Boolean).forEach((l) => {
    if (l.startsWith(STATE_MARK)) {
      try { rec.state = JSON.parse(l.slice(STATE_MARK.length)); } catch {}
      return;
    }
    push(`[${tag}] ${l}`);
  });
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  child.on('close', (code) => {
    push(`■ ${title} завершено (код ${code})`);
    running.delete(key);
    onDone?.(code, rec.state);
  });
}

function start(name, opts, onDone) {
  const { account, limit, delay, send, voice } = opts;
  const t = TASKS[name];
  if (!t) return { ok: false, reason: 'неизвестная задача' };
  let acc;
  try { acc = accounts.resolve(account); } catch (e) { return { ok: false, reason: e.message }; }
  const cur = running.get(acc.id);
  if (cur) return { ok: false, reason: `«${acc.title}» уже занят: ${cur.title}` };

  // задачи, которым нужна живая сессия: без входа запускать бессмысленно —
  // раньше это молча падало «нет сессии» и путало (проверка/рассылка вхолостую)
  const NEEDS_SESSION = ['check', 'drafts', 'stats', 'clean'];
  if (NEEDS_SESSION.includes(name) && !accounts.hasSession(acc)) {
    return { ok: false, reason: `«${acc.title}» не вошёл — сначала войди по QR или залей сессию (шаг 1)` };
  }

  // отлёжка: пока аккаунт «молодой», его нельзя дёргать даже вручную —
  // ради этого прогрев и заводился. Отключается флагом warm:false.
  if (['check', 'drafts'].includes(name) && opts.warm !== false) {
    const w = warm(acc);
    if (w.resting) {
      return { ok: false, reason: `«${acc.title}» на отлёжке — ещё ${fmtLeft(w.restLeft)}. ` +
        'Свежий аккаунт первые сутки не трогаем, иначе Telegram его забанит.' };
    }
    if (name === 'drafts' && w.left <= 0) {
      return { ok: false, reason: `«${acc.title}» выбрал дневной предел прогрева ` +
        `(${w.cap} в сутки, день ${w.day}). Вернётся завтра.` };
    }
  }

  // голосовое уходит сразу и требует файла — без него запускать нечего
  if (t.voice && voice && !fs.existsSync(VOICE)) {
    return { ok: false, reason: 'сначала загрузи голосовое (шаг 4)' };
  }

  const args = [path.join(DIR, ...t.cmd), '--account', acc.id, ...(t.extra || [])];
  if (t.opts) {
    if (limit) args.push('--limit', String(limit));
    if (delay) args.push('--delay', String(delay));
  }
  if (t.voice && voice) args.push('--voice');
  else if (t.send && send) args.push('--send');
  const tag = t.voice && voice ? ' (голосовое)' : t.send && send ? ' (с отправкой)' : '';
  run(acc.id, acc.title, `${t.title} — ${acc.title}${tag}`,
      t.py ? pythonCmd() : 'node', args, onDone);
  return { ok: true };
}

/* ------------------------------------------------------------- автопрогон
 *
 * Ручной режим — это одна пачка на одно нажатие: нажал, дождался, нажал снова.
 * Автопрогон делает то же самое сам и сразу всеми аккаунтами: каждый берёт
 * свою пачку, отдыхает положенную паузу и берёт следующую, пока база не
 * кончится. Пересечься они не могут — номера делятся бронями (claims), тот же
 * механизм, что и при ручном запуске.
 *
 * Правила, ради которых это вообще отдельный узел:
 *   • один аккаунт — один процесс за раз (профиль Telegram занимает ровно один);
 *   • Telegram придержал аккаунт (PEER_FLOOD, квота) — он уходит отдыхать
 *     на столько, сколько сказала задача, остальные продолжают;
 *   • номер, который не даётся, откладывается после трёх попыток (это делают
 *     сами задачи) — иначе прогон крутился бы на месте;
 *   • дневной предел на аккаунт: сколько сообщений в сутки ему позволено.
 */
const AUTO_TICK = 3000;          // как часто смотрим, кому пора работать
const AUTO_FAILS_MAX = 3;        // столько неудачных запусков — аккаунт выбывает
const AUTO_FAIL_WAIT = 5 * 60;   // после неудачного запуска ждём столько, сек
const MAX_TRIES = 3;             // столько же, сколько в check-batch.py и draft-messages.py

const auto = {
  on: false,
  mode: 'full',                  // full | check | write
  send: false, voice: false,
  warm: true,                    // беречь новые аккаунты по расписанию прогрева
  check: { limit: 20, delay: 15 },
  write: { limit: 2,  delay: 5  },
  pause: 60,                     // между своими пачками, сек
  cap: 0,                        // предел отправок в сутки на аккаунт, 0 — без предела
  ids: [],                       // кто участвует
  per: new Map(),                // id -> { nextAt, note, batches, fails, stopped }
  timer: null, since: 0,
};

const fmtLeft = (sec) => sec >= 3600
  ? `${Math.floor(sec / 3600)} ч ${Math.round((sec % 3600) / 60)} мин`
  : `${Math.max(1, Math.round(sec / 60))} мин`;
const hhmm = (t) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const num = (v, d, min, max) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

/**
 * Сколько работы осталось на самом деле: занятые брони не в счёт (их уже
 * кто-то делает), безнадёжные номера — тоже.
 */
function work() {
  const held = claims.heldAll();
  const base = readCsv('numbers.csv');
  const res = readCsv('results.csv');
  const log = readCsv('drafts.csv');

  const checked = new Set(res.filter((r) => r.tg === 'true' || r.tg === 'false').map((r) => r.phone));
  const tries = {};
  for (const r of res) if (!checked.has(r.phone)) tries[r.phone] = (tries[r.phone] || 0) + 1;
  const check = base.filter((r) => !checked.has(r.phone)
    && (tries[r.phone] || 0) < MAX_TRIES && !held.has(r.phone)).length;

  const written = new Set(log.filter((r) => r.ok === 'true' || r.sent === 'true').map((r) => r.phone));
  const dtries = {};
  for (const r of log) if (!written.has(r.phone)) dtries[r.phone] = (dtries[r.phone] || 0) + 1;
  const write = res.filter((r) => r.tg === 'true' && !written.has(r.phone)
    && (dtries[r.phone] || 0) < MAX_TRIES && !held.has(r.phone)).length;

  return { check, write };
}

/**
 * Кто ответил. Считает stats.py и кладёт в replies.json по аккаунтам —
 * панель показывает это числом, чтобы не заставлять читать журнал.
 */
const REPLIES = path.join(DIR, 'replies.json');
function replies() {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(REPLIES, 'utf8')) || {}; } catch { return { n: 0, list: [], at: '' }; }
  const seen = new Map();
  let at = '';
  for (const [, v] of Object.entries(data)) {
    if (v?.at && v.at > at) at = v.at;
    for (const r of v?.replies || []) if (r?.who && !seen.has(r.who)) seen.set(r.who, r);
  }
  return { n: seen.size, at, list: [...seen.values()].slice(0, 30) };
}

/**
 * Сколько этот аккаунт СЕГОДНЯ уже написал людям. Считаем и черновики, и
 * отправленные: рискует аккаунт одинаково — в обоих случаях он добавляет
 * контакт и заводит чат, а Telegram смотрит именно на это.
 */
function doneToday(id) {
  const today = new Date().toDateString();
  return readCsv('drafts.csv').filter((r) => r.account === id
    && (r.ok === 'true' || r.sent === 'true')
    && new Date(r.at).toDateString() === today).length;
}

/* ---------------------------------------------------------------- прогрев
 *
 * Свежекупленный аккаунт, который сразу пишет полсотне незнакомых людей, —
 * это мёртвый аккаунт: Telegram выдаёт PEER_FLOOD в первые же часы. Живые
 * аккаунты так себя не ведут, поэтому новый сначала отлёживается сутки, а
 * потом наращивает объём постепенно.
 *
 * Расписание — сколько человек в сутки можно писать с аккаунта:
 */
const WARM_PLAN = [
  { day: 0,  cap: 0,  note: 'отлёжка — сутки ничего не делаем' },
  { day: 1,  cap: 2,  note: 'первые шаги: 2 в сутки' },
  { day: 3,  cap: 5,  note: 'разгон: 5 в сутки' },
  { day: 5,  cap: 8,  note: '8 в сутки' },
  { day: 7,  cap: 12, note: '12 в сутки' },
  { day: 10, cap: 15, note: 'прогрет: 15 в сутки' },
];

/**
 * С какого момента считать возраст. Ставим один раз и запоминаем в реестре.
 * Аккаунт, который уже успел поработать до появления прогрева, в отлёжку не
 * загоняем — он своё «детство» прожил, ему засчитываем зрелый возраст.
 */
function warmFrom(acc) {
  if (acc.warmFrom) return Date.parse(acc.warmFrom);
  const worked = readCsv('drafts.csv').some((r) => r.account === acc.id
    && (r.ok === 'true' || r.sent === 'true'));
  const from = worked
    ? new Date(Date.now() - 10 * 864e5).toISOString()   // уже в строю — считаем прогретым
    : (acc.added || new Date().toISOString());
  accounts.setField(acc.id, { warmFrom: from });
  return Date.parse(from);
}

/** Состояние прогрева аккаунта: возраст, дневной предел, отдыхает ли ещё. */
function warm(acc) {
  const from = warmFrom(acc);
  const ms = Date.now() - from;
  const day = Math.floor(ms / 864e5);
  let step = WARM_PLAN[0];
  for (const p of WARM_PLAN) if (day >= p.day) step = p;
  const resting = step.cap === 0;
  return {
    day, cap: step.cap, note: step.note, resting,
    // сколько ещё отлёживаться, сек
    restLeft: resting ? Math.max(0, Math.ceil((from + 864e5 - Date.now()) / 1000)) : 0,
    left: Math.max(0, step.cap - doneToday(acc.id)),
  };
}

/** До начала следующих суток — столько ждёт аккаунт, выбравший дневной предел. */
const untilTomorrow = () => {
  const d = new Date();
  d.setHours(24, 5, 0, 0);
  return d.getTime();
};

/** Чем занять этот аккаунт прямо сейчас. null — пока нечем. */
function pickJob(left, id) {
  const canWrite = auto.mode !== 'check';
  const canCheck = auto.mode !== 'write';
  const acc = accounts.list().find((a) => a.id === id);
  const w = auto.warm && acc ? warm(acc) : null;

  // отлёжка: свежий аккаунт сутки не делает вообще ничего — ни проверок,
  // ни сообщений. Это единственный способ не потерять его в первый же день.
  if (w && w.resting) {
    const s = auto.per.get(id);
    if (s && s.note !== 'отлёжка') {
      s.note = 'отлёжка';
      s.nextAt = Date.now() + Math.min(w.restLeft, 3600) * 1000;
      push(`⏸ «${title(id)}» на отлёжке — ${fmtLeft(w.restLeft)} до первой работы`);
    }
    return null;
  }

  if (canWrite && left.write > 0) {
    // из двух пределов берём меньший: твой ручной и тот, что даёт прогрев
    const byUser = auto.cap ? auto.cap - doneToday(id) : Infinity;
    const capLeft = Math.min(byUser, w ? w.left : Infinity);
    if (capLeft > 0) {
      return { name: 'drafts',
               limit: Math.max(1, Math.min(auto.write.limit, left.write, capLeft)),
               delay: auto.write.delay };
    }
    const s = auto.per.get(id);
    if (s && s.note !== 'дневной предел') {
      const lim = w ? Math.min(auto.cap || Infinity, w.cap) : auto.cap;
      s.note = 'дневной предел';
      s.nextAt = untilTomorrow();
      push(`⏸ «${title(id)}» выбрал дневной предел (${lim}) — вернётся завтра`);
    }
  }
  if (canCheck && left.check > 0) {
    return { name: 'check', limit: Math.min(auto.check.limit, left.check), delay: auto.check.delay };
  }
  return null;
}

const title = (id) => accounts.list().find((a) => a.id === id)?.title || id;

/** Раз в несколько секунд: кому пора работать — того и запускаем. */
function autoTick() {
  if (!auto.on) return;
  const now = Date.now();
  const live = auto.ids.filter((id) => !auto.per.get(id).stopped);
  if (!live.length) return autoStop('все аккаунты выбыли — смотри журнал');

  const left = work();
  const busy = live.some((id) => running.has(id));
  // работы нет и никто её не доделывает — прогон закончен. Считаем только ту
  // работу, которую этот прогон вообще делает: в режиме «только писать»
  // непройденная база — не повод держать прогон включённым
  const need = auto.mode === 'check' ? left.check
             : auto.mode === 'write' ? left.write : left.check + left.write;
  if (!need && !busy) {
    return autoStop(auto.mode === 'check' ? 'база пройдена'
                  : auto.mode === 'write' ? 'всем найденным написано'
                  : 'база пройдена, всем найденным написано');
  }

  for (const id of live) {
    if (running.has(id)) continue;
    const s = auto.per.get(id);
    if (now < s.nextAt) continue;
    const job = pickJob(left, id);
    if (!job) continue;
    // то, что забрал этот аккаунт, не должно достаться ещё и следующему
    // в этом же обходе: иначе на два оставшихся номера уйдёт пять пачек
    if (job.name === 'drafts') left.write -= job.limit; else left.check -= job.limit;

    const r = start(job.name, {
      account: id, limit: job.limit, delay: job.delay,
      warm: auto.warm,
      send: job.name === 'drafts' && auto.send && !auto.voice,
      voice: job.name === 'drafts' && auto.voice,
    }, (code, st) => autoAfter(id, code, st));

    if (r.ok) { s.note = ''; continue; }
    // не запустилось (нет сессии, аккаунт занят чужой задачей) — не долбимся
    s.fails++;
    s.note = r.reason || 'не запускается';
    if (s.fails >= AUTO_FAILS_MAX) {
      s.stopped = true;
      push(`⏹ «${title(id)}» выбывает из автопрогона: ${s.note}`);
    } else {
      s.nextAt = now + AUTO_FAIL_WAIT * 1000;
    }
  }
}

/** Пачка кончилась: решаем, когда звать этот аккаунт снова. */
function autoAfter(id, code, st) {
  const s = auto.per.get(id);
  if (!s || !auto.on) return;
  const now = Date.now();

  if (st?.stop && st.cooldown) {
    // Telegram придержал аккаунт — отдых ровно на столько, сколько он просит
    s.nextAt = now + st.cooldown * 1000;
    s.note = st.stop === 'quota' ? 'квота на сегодня'
           : st.stop === 'flood' ? 'придержан Telegram' : 'сбои подряд';
    s.fails = 0;
    push(`⏸ «${title(id)}» отдыхает до ${hhmm(s.nextAt)} — ${s.note}`);
    return;
  }
  if (code !== 0) {
    // задача упала, итога не прислала: сеть, мёртвая сессия, прокси
    s.fails++;
    if (s.fails >= AUTO_FAILS_MAX) {
      s.stopped = true;
      s.note = 'задача падает — смотри журнал';
      push(`⏹ «${title(id)}» выбывает из автопрогона: ${AUTO_FAILS_MAX} неудачных запуска подряд`);
    } else {
      s.nextAt = now + AUTO_FAIL_WAIT * 1000;
      s.note = 'сбой, пробую снова';
    }
    return;
  }
  s.fails = 0;
  s.batches++;
  s.note = '';
  // пачка не взяла ни одного номера (всё разобрали другие) — не бежим по кругу
  const wait = st && st.done === 0 ? Math.max(auto.pause, 30) : auto.pause;
  s.nextAt = now + wait * 1000;
}

function autoStart(o) {
  if (auto.on) return { ok: false, reason: 'автопрогон уже идёт' };
  const ready = accounts.list().filter((a) => accounts.hasSession(a) && accounts.isAuthed(a));
  const want = Array.isArray(o.accounts) ? o.accounts : [];
  const ids = (want.length ? ready.filter((a) => want.includes(a.id)) : ready).map((a) => a.id);
  if (!ids.length) {
    return { ok: false, reason: ready.length
      ? 'ни один из выбранных аккаунтов не вошёл'
      : 'нет ни одного вошедшего аккаунта — подключи хотя бы один (шаг 1)' };
  }
  const mode = ['full', 'check', 'write'].includes(o.mode) ? o.mode : 'full';
  const voice = !!o.voice && mode !== 'check';
  if (voice && !fs.existsSync(VOICE)) return { ok: false, reason: 'сначала загрузи голосовое (шаг 4)' };
  if (mode !== 'check' && !fs.existsSync(path.join(DIR, 'message.txt')) && !voice) {
    return { ok: false, reason: 'сначала сохрани текст сообщения (шаг 4)' };
  }

  Object.assign(auto, {
    on: true, mode, voice,
    warm: o.warm !== false,
    send: !!o.send && !voice && mode !== 'check',
    check: { limit: num(o.checkLimit, 20, 1, 500), delay: num(o.checkDelay, 15, 5, 3600) },
    write: { limit: num(o.writeLimit, 2, 1, 200),  delay: num(o.writeDelay, 5, 3, 3600) },
    pause: num(o.pause, 60, 10, 24 * 3600),
    cap: num(o.cap, 0, 0, 10000),
    ids, since: Date.now(),
    per: new Map(ids.map((id) => [id, { nextAt: 0, note: '', batches: 0, fails: 0, stopped: false }])),
  });

  const what = mode === 'check' ? 'только проверка базы'
             : mode === 'write' ? 'только рассылка' : 'проверка и рассылка';
  const how = auto.voice ? 'ГОЛОСОВЫМ, уходит людям'
            : auto.send ? 'С ОТПРАВКОЙ — сообщения уходят людям' : 'только черновики';
  push(`\n▶▶ АВТОПРОГОН: ${ids.map(title).join(', ')}`);
  push(`   ${what} · ${how} · пауза между пачками ${auto.pause} с` +
       (auto.cap ? ` · не больше ${auto.cap} в сутки на аккаунт` : '') +
       (auto.warm ? ' · прогрев новых аккаунтов включён' : ' · ПРОГРЕВ ВЫКЛЮЧЕН'));
  if (auto.warm) {
    for (const id of ids) {
      const acc = accounts.list().find((a) => a.id === id);
      const w = warm(acc);
      push(`   «${acc.title}»: день ${w.day} — ${w.note}` +
           (w.resting ? ` (ещё ${fmtLeft(w.restLeft)})` : ` · сегодня осталось ${w.left}`));
    }
  }
  auto.timer = setInterval(autoTick, AUTO_TICK);
  autoTick();
  return { ok: true };
}

function autoStop(why) {
  if (!auto.on) return;
  auto.on = false;
  clearInterval(auto.timer);
  auto.timer = null;
  push(`■■ автопрогон остановлен: ${why}`);
}

/** Что показывать в панели, пока прогон идёт. */
function autoView() {
  const now = Date.now();
  return {
    on: auto.on, mode: auto.mode, send: auto.send, voice: auto.voice,
    cap: auto.cap, pause: auto.pause, since: auto.since,
    accounts: auto.ids.map((id) => {
      const s = auto.per.get(id) || {};
      return {
        id, title: title(id), batches: s.batches || 0, stopped: !!s.stopped,
        note: s.note || '', busy: running.get(id)?.title || '',
        wait: Math.max(0, Math.round(((s.nextAt || 0) - now) / 1000)),
      };
    }),
  };
}

/**
 * Запустить одну задачу сразу на нескольких аккаунтах — параллельно.
 * Базу они делят бронями (claims), поэтому по одному номеру не пройдут дважды.
 * Занятый чем-то другим или невошедший аккаунт просто пропускаем и говорим,
 * кого именно.
 */
function startMany(name, ids, opts) {
  let started = 0;
  const skipped = [];
  for (const id of ids) {
    const r = start(name, { account: id, ...opts });
    if (r.ok) started++;
    else skipped.push(r.reason || id);
  }
  if (!started) {
    return { ok: false, reason: skipped[0] || 'ни один аккаунт не запустился' };
  }
  return { ok: true, started, skipped };
}

/* ------------------------------------------------- Telegram Desktop -------
 * Каждому аккаунту — своя рабочая папка desktop/<id>: у Telegram Desktop
 * это ключ -workdir, поэтому несколько аккаунтов спокойно живут рядом.
 */
const DESKTOP = path.join(DIR, 'desktop');
const TDESK_HINT =
  'Не найден Telegram Desktop. Похоже, стоит нативный клиент Telegram для macOS ' +
  '(ru.keepcoder.Telegram) — он формат tdata не понимает, это другое приложение.\n\n' +
  'Поставь именно Telegram Desktop:\n' +
  '  brew install --cask telegram-desktop\n' +
  'либо скачай с desktop.telegram.org и положи в /Applications.';

/**
 * Путь к Telegram Desktop. Важно не перепутать с нативным клиентом для macOS
 * (ru.keepcoder.Telegram): тот про tdata ничего не знает и -workdir не умеет.
 */
function tdesktopApp() {
  const win = process.platform === 'win32';
  if (win) {
    const p = path.join(process.env.APPDATA || '', 'Telegram Desktop', 'Telegram.exe');
    return fs.existsSync(p) ? p : '';
  }
  const cands = ['/Applications/Telegram Desktop.app', '/Applications/Telegram.app',
                 path.join(process.env.HOME || '', 'Applications/Telegram Desktop.app')];
  for (const app of cands) {
    const bin = path.join(app, 'Contents/MacOS/Telegram');
    if (!fs.existsSync(bin)) continue;
    try {
      const id = execFileSync('defaults',
        ['read', path.join(app, 'Contents/Info.plist'), 'CFBundleIdentifier'],
        { encoding: 'utf8' }).trim();
      if (id === 'com.tdesktop.Telegram') return bin;
    } catch {}
  }
  return '';
}

/** Ищет папку tdata внутри распакованного архива, на любой глубине. */
function findTdata(root, depth = 0) {
  if (depth > 4) return null;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const full = path.join(root, e.name);
    if (e.name === 'tdata') return full;
    const deeper = findTdata(full, depth + 1);
    if (deeper) return deeper;
  }
  return null;
}

/** Пускаем десктоп отдельно от панели: он живёт своей жизнью и её не держит. */
function launchDesktop(app, workdir) {
  const child = spawn(app, ['-workdir', workdir], { detached: true, stdio: 'ignore' });
  child.unref();
}

/** Python для разбора базы: venv-tg (openpyxl+opentele), потом venv, потом системный. */
function pythonCmd() {
  const win = process.platform === 'win32';
  const cands = [
    path.join(DIR, 'venv-tg', win ? 'Scripts\\python.exe' : 'bin/python'),
    path.join(DIR, 'venv', win ? 'Scripts\\python.exe' : 'bin/python'),
  ];
  for (const p of cands) if (fs.existsSync(p)) return p;
  return win ? 'python' : 'python3';
}
const BASEMETA = path.join(DIR, 'base.json');
const UPLOADS = path.join(DIR, 'uploads');
const BASE_EXT = /\.(xlsx|xlsm|csv|tsv|txt)$/i;
const ACCFILE_EXT = /\.(zip|session)$/i;
const VOICE = path.join(DIR, 'voice.ogg');
const VOICEMETA = path.join(DIR, 'voice.json');
const VOICE_EXT = /\.(ogg|oga|opus|mp3|m4a|aac|wav|mp4|webm)$/i;

/** ffmpeg/ffprobe: сначала рядом с панелью (можно положить бинарь), потом из PATH. */
function toolCmd(name) {
  const win = process.platform === 'win32';
  const local = path.join(DIR, win ? `${name}.exe` : name);
  return fs.existsSync(local) ? local : name;
}

/**
 * Готовит голосовое из любого аудио: ffmpeg переводит в ogg/opus, моно —
 * формат голосовых заметок Telegram. Без ffmpeg берём только уже готовый
 * .ogg/.opus как есть. Длительность читаем ffprobe'ом, панель покажет её,
 * и Telegram нарисует полоску, а не 0:00.
 */
function makeVoice(srcPath, origName) {
  try {
    execFileSync(toolCmd('ffmpeg'),
      ['-y', '-i', srcPath, '-vn', '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', VOICE],
      { stdio: 'ignore' });
  } catch (e) {
    if (e.code === 'ENOENT') {
      if (/\.(ogg|oga|opus)$/i.test(origName)) fs.copyFileSync(srcPath, VOICE);
      else throw new Error('нет ffmpeg — запиши голосовое в Telegram и загрузи файл .ogg, либо поставь ffmpeg');
    } else {
      throw new Error('не получилось сделать голосовое: ' + (e.message || '').split('\n')[0]);
    }
  }
  let duration = 0;
  try {
    const out = execFileSync(toolCmd('ffprobe'),
      ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', VOICE],
      { encoding: 'utf8' });
    duration = Math.max(0, Math.round(parseFloat(out) || 0));
  } catch {}
  const meta = { name: origName, duration, at: new Date().toISOString() };
  fs.writeFileSync(VOICEMETA, JSON.stringify(meta, null, 2) + '\n');
  return meta;
}
const voiceMeta = () => { try { return JSON.parse(fs.readFileSync(VOICEMETA, 'utf8')); } catch { return null; } };

/**
 * Подключение аккаунта готовой сессией. Что внутри загруженного файла —
 * решаем по нему самому: .zip с папкой tdata → import-tdata, иначе (архив
 * с .session или сам .session) → import-session. Оба принимают одинаковый
 * первый аргумент, различается только скрипт.
 */
function importAccount(accId, file) {
  const acc = accounts.list().find((a) => a.id === accId);
  if (!acc) return { ok: false, reason: 'аккаунт не найден' };
  if (running.get(accId)) return { ok: false, reason: 'аккаунт сейчас занят' };

  let tdata = false;
  if (/\.zip$/i.test(file)) {
    try {
      const names = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' });
      tdata = /(^|\/)tdata\//m.test(names) || /(^|\/)key_datas$/m.test(names);
    } catch {}
  }
  const flag = tdata ? '--tdata' : '--session';
  run(accId, acc.title, `Подключение сессии — ${acc.title}`,
      pythonCmd(), [path.join(DIR, 'import-account.py'), '--account', accId, flag, file]);
  return { ok: true, kind: tdata ? 'TDATA' : 'session' };
}

/** Разбирает файл базы по указанному пути в numbers.csv (тот же extract_numbers.py). */
function loadBase(file) {
  if (running.has('_base')) return { ok: false, reason: 'база уже разбирается' };
  const clean = file.replace(/^~(?=\/)/, process.env.HOME || '~').trim();
  if (!fs.existsSync(clean)) return { ok: false, reason: `файл не найден: ${clean}` };
  run('_base', 'база', 'Загрузка базы', pythonCmd(),
      [path.join(DIR, 'extract_numbers.py'), clean, path.join(DIR, 'numbers.csv')],
      (code) => {
        if (code !== 0) return;
        fs.writeFileSync(BASEMETA, JSON.stringify(
          { file: path.basename(clean), at: new Date().toISOString() }, null, 2) + '\n');
      });
  return { ok: true };
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};
const body = (req) => new Promise((r) => {
  let d = ''; req.on('data', (c) => (d += c));
  req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } });
});
/** Тело запроса как есть — файл прилетает потоком, без multipart. */
const rawBody = (req, limit = 50 * 1024 * 1024) => new Promise((ok, no) => {
  const chunks = []; let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) { no(new Error('файл больше 50 МБ')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => ok(Buffer.concat(chunks)));
  req.on('error', no);
});

const page = (res, file) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8',
                       'cache-control': 'no-store' });
  res.end(fs.readFileSync(path.join(DIR, file)));
};

async function handler(req, res) {
  try {
    const u = new URL(req.url, 'http://x');
    const ip = req.socket.remoteAddress || '?';

    /**
     * Чужая страница не может ни поставить свой заголовок, ни подделать Origin,
     * а кука уходит с любым запросом — поэтому оба условия проверяем на каждом
     * изменяющем запросе.
     */
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin) {
        let bad = true;
        try { bad = new URL(origin).host !== req.headers.host; } catch {}
        if (bad) return json(res, 403, { error: 'чужой источник запроса' });
      }
      if (req.headers['x-panel'] !== '1') return json(res, 403, { error: 'запрос не из панели' });
    }

    const token = auth.cookieFrom(req.headers.cookie)[auth.COOKIE];
    const authed = auth.valid(token);

    if (u.pathname === '/api/login' && req.method === 'POST') {
      const wait = auth.blocked(ip);
      if (wait) return json(res, 429, { ok: false, reason: `слишком много попыток, подожди ${wait} с` });
      const { user, pass } = await body(req);
      if (!auth.check(user, pass)) {
        auth.noteFail(ip);
        return json(res, 401, { ok: false, reason: 'логин или пароль не подходят' });
      }
      auth.noteOk(ip);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': `${auth.COOKIE}=${auth.issue()}; HttpOnly; SameSite=Strict; Path=/; ` +
                      `Max-Age=${14 * 86400}${TLS ? '; Secure' : ''}`,
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (u.pathname === '/api/logout' && req.method === 'POST') {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': `${auth.COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    // всё остальное — только для вошедших
    if (!authed) {
      if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/login')) {
        return page(res, 'login.html');
      }
      return json(res, 401, { error: 'нужен вход' });
    }

    if (u.pathname === '/') return page(res, 'admin.html');
    if (u.pathname === '/login') { res.writeHead(302, { location: '/' }); return res.end(); }

    if (u.pathname === '/api/accounts') {
      const drafted = readCsv('drafts.csv');
      const held = claims.active();
      return json(res, 200, accounts.list().map((a) => ({
        id: a.id, title: a.title,
        authed: accounts.isAuthed(a),
        proxy: a.proxy || '',
        proxyLabel: accounts.proxyLabel(a.proxy),
        drafts: drafted.filter((r) => r.account === a.id && r.ok === 'true').length,
        sent: drafted.filter((r) => r.account === a.id && r.sent === 'true').length,
        busy: running.get(a.id)?.title || '',
        session: accounts.hasSession(a),
        profile: fs.existsSync(path.join(DIR, a.dir, 'Default')),
        // кто это на самом деле — панель показывает рядом с названием,
        // иначе после добавления видно только придуманное имя
        name: a.name || '', username: a.username || '', phone: a.phone || '',
        held: held.filter((h) => h.account === a.id).reduce((s, h) => s + h.n, 0),
        warm: accounts.hasSession(a) ? warm(a) : null,
      })));
    }

    if (u.pathname === '/api/accounts/add' && req.method === 'POST') {
      const { title, proxy, method } = await body(req);
      const acc = accounts.add(title);
      // прокси ставим ДО входа: сессия должна привязаться сразу к нужному адресу,
      // иначе Telegram увидит один IP при логине и другой при работе
      if (proxy) {
        try { accounts.setProxy(acc.id, proxy); }
        catch (e) { accounts.remove(acc.id); return json(res, 200, { ok: false, reason: e.message }); }
      }
      const warn = accounts.proxyWarning(proxy);
      // method === 'file' — вход готовой сессией, файл прилетит отдельным
      // запросом на /api/accounts/import; QR не открываем
      if (method === 'file') {
        push(`\n+ заведён «${acc.title}» (${accounts.proxyLabel(proxy)}) — жду файл сессии`);
        if (warn) push(`⚠ ${warn}`);
        return json(res, 200, { ok: true, id: acc.id, warn, method: 'file' });
      }
      push(`\n+ заведён «${acc.title}» (${accounts.proxyLabel(proxy)}) — сейчас откроется окно с QR-кодом`);
      if (warn) push(`⚠ ${warn}`);
      start('login', { account: acc.id });
      return json(res, 200, { ok: true, id: acc.id, warn });
    }

    if (u.pathname === '/api/accounts/import' && req.method === 'POST') {
      const accId = u.searchParams.get('account');
      const name = decodeURIComponent(req.headers['x-filename'] || '').split(/[\\/]/).pop();
      if (!accId || !accounts.list().find((a) => a.id === accId)) {
        return json(res, 200, { ok: false, reason: 'аккаунт не найден' });
      }
      if (!name || !ACCFILE_EXT.test(name)) {
        return json(res, 200, { ok: false, reason: 'нужен файл .zip (TDATA или session+json) или .session' });
      }
      let buf;
      try { buf = await rawBody(req); } catch (e) { return json(res, 200, { ok: false, reason: e.message }); }
      if (!buf.length) return json(res, 200, { ok: false, reason: 'файл пустой' });
      fs.mkdirSync(UPLOADS, { recursive: true });
      const dest = path.join(UPLOADS, `${accId}-${name.replace(/[^\p{L}\p{N}._ -]/gu, '_')}`);
      fs.writeFileSync(dest, buf);
      push(`\n↑ сессия для «${accId}»: ${name} (${Math.round(buf.length / 1024)} КБ)`);
      return json(res, 200, importAccount(accId, dest));
    }

    /**
     * Профиль аккаунта: имя, фамилия, «о себе», @username, аватарка.
     * Меняем тем же ключом, которым работает панель, — в браузер сессию
     * MTProto не перенести, там пришлось бы входить заново по QR.
     */
    if (u.pathname === '/api/accounts/profile' && req.method === 'POST') {
      const { id, name, last, about, username } = await body(req);
      const acc = accounts.list().find((a) => a.id === id);
      if (!acc) return json(res, 200, { ok: false, reason: 'аккаунт не найден' });
      if (running.has(id)) return json(res, 200, { ok: false, reason: 'аккаунт сейчас занят' });
      if (!accounts.hasSession(acc)) return json(res, 200, { ok: false, reason: 'аккаунт не вошёл' });
      const args = [path.join(DIR, 'profile.py'), '--account', id];
      for (const [k, v] of [['name', name], ['last', last], ['about', about], ['username', username]]) {
        if (v !== undefined && v !== null) args.push(`--${k}`, String(v));
      }
      run(id, acc.title, `Профиль — ${acc.title}`, pythonCmd(), args);
      return json(res, 200, { ok: true });
    }

    if (u.pathname === '/api/accounts/photo' && req.method === 'POST') {
      const id = u.searchParams.get('account');
      const acc = accounts.list().find((a) => a.id === id);
      if (!acc) return json(res, 200, { ok: false, reason: 'аккаунт не найден' });
      if (running.has(id)) return json(res, 200, { ok: false, reason: 'аккаунт сейчас занят' });
      const name = decodeURIComponent(req.headers['x-filename'] || '').split(/[\\/]/).pop();
      if (!name || !/\.(jpg|jpeg|png|webp)$/i.test(name)) {
        return json(res, 200, { ok: false, reason: 'нужна картинка .jpg или .png' });
      }
      let buf;
      try { buf = await rawBody(req, 12 * 1024 * 1024); } catch (e) { return json(res, 200, { ok: false, reason: e.message }); }
      fs.mkdirSync(UPLOADS, { recursive: true });
      const dest = path.join(UPLOADS, `avatar-${id}-${name.replace(/[^\p{L}\p{N}._ -]/gu, '_')}`);
      fs.writeFileSync(dest, buf);
      push(`\n🖼 аватарка для «${acc.title}»: ${name}`);
      run(id, acc.title, `Аватарка — ${acc.title}`, pythonCmd(),
          [path.join(DIR, 'profile.py'), '--account', id, '--photo', dest]);
      return json(res, 200, { ok: true });
    }

    /**
     * Открыть аккаунт в Telegram Desktop.
     *
     * tdata — родной формат Telegram Desktop, поэтому аккаунт там открывается
     * по-настоящему (в отличие от браузера, которому ключ MTProto не подходит).
     * Но ключ у десктопа и у панели ОДИН: если десктоп сходит в Telegram с
     * твоего настоящего IP, а панель ходит через прокси, Telegram увидит одну
     * авторизацию из двух стран — это первая причина, по которой сессии
     * отзывают. Поэтому запуск в два шага:
     *
     *   1) «Подготовить» — десктоп стартует на ПУСТОЙ папке, без аккаунта.
     *      Светить нечего. Человек прописывает прокси и закрывает окно.
     *   2) «Открыть» — только теперь кладём tdata рядом с уже настроенным
     *      прокси и запускаем снова. Аккаунт выходит в сеть сразу через прокси.
     */
    if (u.pathname === '/api/accounts/desktop' && req.method === 'POST') {
      const { id, step } = await body(req);
      const acc = accounts.list().find((a) => a.id === id);
      if (!acc) return json(res, 200, { ok: false, reason: 'аккаунт не найден' });

      const app = tdesktopApp();
      if (!app) return json(res, 200, { ok: false, need: 'tdesktop', reason: TDESK_HINT });

      const wd = path.join(DESKTOP, id);
      fs.mkdirSync(wd, { recursive: true });
      const proxyMark = path.join(wd, '.proxy-ok');

      if (step === 'proxy') {
        // на всякий случай убираем аккаунт из папки: шаг 1 должен быть пустым
        fs.rmSync(path.join(wd, 'tdata'), { recursive: true, force: true });
        launchDesktop(app, wd);
        push(`\n🖥 «${acc.title}»: десктоп открыт ПУСТЫМ — пропиши прокси и закрой окно`);
        return json(res, 200, { ok: true, step: 'proxy',
          proxy: accounts.proxyLabel(acc.proxy) });
      }

      // шаг 2 — кладём tdata
      const src = fs.existsSync(UPLOADS)
        ? fs.readdirSync(UPLOADS).find((f) => f.startsWith(`${id}-`) && /\.zip$/i.test(f))
        : null;
      if (!src) {
        return json(res, 200, { ok: false, reason:
          'Не нашёл исходный файл сессии в uploads/. Открыть в десктопе можно только ' +
          'аккаунт, залитый как TDATA (.zip). Перезалей его кнопкой «Сессия».' });
      }
      try {
        const tmp = fs.mkdtempSync(path.join(DESKTOP, '_x'));
        // достаём ТОЛЬКО tdata: рядом в архиве часто лежит заметка с паролем,
        // и её имя в не-UTF8 кодировке роняет unzip целиком («Illegal byte
        // sequence»). Нам она не нужна, а ошибку распаковки прочего глотаем —
        // важно лишь, добралась ли tdata.
        try {
          execFileSync('unzip', ['-qo', path.join(UPLOADS, src), '*tdata/*', '-d', tmp],
                       { stdio: 'ignore' });
        } catch {}
        const found = findTdata(tmp);
        if (!found) throw new Error('внутри архива нет папки tdata');
        fs.rmSync(path.join(wd, 'tdata'), { recursive: true, force: true });
        fs.cpSync(found, path.join(wd, 'tdata'), { recursive: true });
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch (e) {
        return json(res, 200, { ok: false, reason: 'не смог достать tdata: ' + e.message });
      }
      launchDesktop(app, wd);
      push(`\n🖥 «${acc.title}» открыт в Telegram Desktop (своя папка: desktop/${id})`);
      return json(res, 200, { ok: true, step: 'open',
        warmed: fs.existsSync(proxyMark), proxy: accounts.proxyLabel(acc.proxy) });
    }

    /**
     * Пачкой: собираем ОДНУ папку tdata сразу с несколькими аккаунтами, чтобы
     * в Telegram Desktop переключаться между ними по аватарке. Больше трёх в
     * одну папку не влезет — это ограничение самого десктопа.
     */
    if (u.pathname === '/api/accounts/desktop/pack' && req.method === 'POST') {
      const { ids, step } = await body(req);
      const app = tdesktopApp();
      if (!app) return json(res, 200, { ok: false, need: 'tdesktop', reason: TDESK_HINT });
      if (running.has('_pack')) return json(res, 200, { ok: false, reason: 'сборка уже идёт' });

      const wd = path.join(DESKTOP, 'pack');
      fs.mkdirSync(wd, { recursive: true });

      if (step === 'proxy') {
        fs.rmSync(path.join(wd, 'tdata'), { recursive: true, force: true });
        launchDesktop(app, wd);
        push('\n🖥 общий десктоп открыт ПУСТЫМ — пропиши прокси и закрой окно');
        return json(res, 200, { ok: true, step: 'proxy' });
      }

      const chosen = (Array.isArray(ids) ? ids : []).filter((id) => {
        const a = accounts.list().find((x) => x.id === id);
        return a && accounts.hasSession(a);
      }).slice(0, 3);
      if (!chosen.length) return json(res, 200, { ok: false, reason: 'не выбран ни один вошедший аккаунт' });

      push(`\n🖥 собираю общую папку Telegram Desktop: ${chosen.map(title).join(', ')}`);
      run('_pack', 'десктоп', 'Сборка папки Telegram Desktop', pythonCmd(),
          [path.join(DIR, 'desktop-pack.py'), '--accounts', chosen.join(','), '--out', wd],
          (code) => {
            if (code === 0) { launchDesktop(app, wd); push('🖥 общий десктоп запущен'); }
            else push('🖥 собрать папку не вышло — смотри строки выше');
          });
      return json(res, 200, { ok: true, step: 'open', n: chosen.length });
    }

    if (u.pathname === '/api/accounts/desktop/ready' && req.method === 'POST') {
      const { id } = await body(req);
      const wd = path.join(DESKTOP, id);
      fs.mkdirSync(wd, { recursive: true });
      fs.writeFileSync(path.join(wd, '.proxy-ok'), new Date().toISOString());
      return json(res, 200, { ok: true });
    }

    if (u.pathname === '/api/accounts/remove' && req.method === 'POST') {
      const { id } = await body(req);
      if (running.has(id)) return json(res, 200, { ok: false, reason: 'аккаунт сейчас занят' });
      const acc = accounts.list().find((a) => a.id === id);
      claims.releaseAll(id);
      const ok = accounts.remove(id);
      if (ok) push(`− аккаунт «${acc.title}» отключён, его сессия удалена`);
      return json(res, 200, { ok });
    }

    if (u.pathname === '/api/accounts/proxy' && req.method === 'POST') {
      const { id, proxy } = await body(req);
      try {
        const ok = accounts.setProxy(id, proxy);
        const acc = accounts.list().find((a) => a.id === id);
        const warn = accounts.proxyWarning(acc.proxy);
        if (ok) push(`⚙ «${acc.title}» ходит через: ${accounts.proxyLabel(acc.proxy)}`);
        if (warn) push(`⚠ ${warn}`);
        return json(res, 200, { ok, warn });
      } catch (e) {
        return json(res, 200, { ok: false, reason: e.message });
      }
    }

    if (u.pathname === '/api/accounts/rename' && req.method === 'POST') {
      const { id, title } = await body(req);
      return json(res, 200, { ok: accounts.rename(id, title) });
    }

    if (u.pathname === '/api/base') {
      const rows = readCsv('numbers.csv');
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(BASEMETA, 'utf8')); } catch {}
      return json(res, 200, {
        count: rows.length, file: meta.file || '', at: meta.at || '',
        loading: running.has('_base'),
        rows: rows.slice(0, 8).map((r) => ({ phone: r.phone, calls: r.calls, last_call: r.last_call })),
      });
    }

    if (u.pathname === '/api/upload' && req.method === 'POST') {
      // имя файла приходит заголовком: тело — сам файл, без multipart-обёртки
      const name = decodeURIComponent(req.headers['x-filename'] || '').split(/[\\/]/).pop();
      if (!name || !BASE_EXT.test(name)) {
        return json(res, 200, { ok: false, reason: 'нужен файл .xlsx, .xlsm, .csv или .tsv' });
      }
      let buf;
      try { buf = await rawBody(req); } catch (e) { return json(res, 200, { ok: false, reason: e.message }); }
      if (!buf.length) return json(res, 200, { ok: false, reason: 'файл пустой' });
      fs.mkdirSync(UPLOADS, { recursive: true });
      const safe = name.replace(/[^\p{L}\p{N}._ -]/gu, '_');
      const dest = path.join(UPLOADS, safe);
      fs.writeFileSync(dest, buf);
      push(`\n↑ файл принят: ${safe} (${Math.round(buf.length / 1024)} КБ)`);
      return json(res, 200, loadBase(dest));
    }

    /**
     * Текст рассылки правится прямо в панели: message.txt открывать руками
     * неудобно, а ошибиться в нём дороже всего — он уходит людям.
     */
    if (u.pathname === '/api/message') {
      const file = path.join(DIR, 'message.txt');
      if (req.method !== 'POST') {
        return json(res, 200, { text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' });
      }
      const { text } = await body(req);
      const clean = String(text ?? '').replace(/\r\n/g, '\n').trim();
      if (!clean) return json(res, 200, { ok: false, reason: 'текст не может быть пустым' });
      // предел одного сообщения в Telegram — 4096 символов; с запасом на подстановки
      if (clean.length > 3900) {
        return json(res, 200, { ok: false, reason: `слишком длинно: ${clean.length} символов, можно до 3900` });
      }
      fs.writeFileSync(file, clean + '\n');
      push(`\n✎ текст сообщения изменён (${clean.length} символов)`);
      return json(res, 200, { ok: true, text: clean });
    }

    /**
     * Голосовое для рассылки. GET — что сейчас лежит; POST — загрузка (файл
     * телом, имя заголовком, как у базы); отдельная отдача файла для прослушки
     * в панели; удаление. Голосовое одно на всю рассылку, как и текст.
     */
    if (u.pathname === '/api/voice' && req.method !== 'POST') {
      const m = voiceMeta();
      return json(res, 200, {
        exists: fs.existsSync(VOICE) && !!m,
        name: m?.name || '', duration: m?.duration || 0,
      });
    }
    if (u.pathname === '/api/voice/file') {
      if (!fs.existsSync(VOICE)) return json(res, 404, { ok: false });
      res.writeHead(200, { 'content-type': 'audio/ogg', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(VOICE));
    }
    if (u.pathname === '/api/voice' && req.method === 'POST') {
      const name = decodeURIComponent(req.headers['x-filename'] || '').split(/[\\/]/).pop();
      if (!name || !VOICE_EXT.test(name)) {
        return json(res, 200, { ok: false, reason: 'нужен аудиофайл (.ogg, .mp3, .m4a, .wav…)' });
      }
      let buf;
      try { buf = await rawBody(req); } catch (e) { return json(res, 200, { ok: false, reason: e.message }); }
      if (!buf.length) return json(res, 200, { ok: false, reason: 'файл пустой' });
      fs.mkdirSync(UPLOADS, { recursive: true });
      const tmp = path.join(UPLOADS, 'voice-src-' + name.replace(/[^\p{L}\p{N}._ -]/gu, '_'));
      fs.writeFileSync(tmp, buf);
      try {
        const m = makeVoice(tmp, name);
        push(`\n🎤 голосовое загружено: ${name} (${m.duration}с)`);
        return json(res, 200, { ok: true, name: m.name, duration: m.duration });
      } catch (e) {
        return json(res, 200, { ok: false, reason: e.message });
      } finally {
        try { fs.unlinkSync(tmp); } catch {}
      }
    }
    if (u.pathname === '/api/voice/delete' && req.method === 'POST') {
      try { fs.unlinkSync(VOICE); } catch {}
      try { fs.unlinkSync(VOICEMETA); } catch {}
      push('\n🎤 голосовое убрано');
      return json(res, 200, { ok: true });
    }

    /**
     * Чистка: аккаунты выходят из Telegram и пропадают из панели, данные
     * уезжают в бэкап-папку. Идёт в два шага, потому что выход из аккаунтов —
     * это работа по сети: сначала задача logout-accounts.py, потом уборка.
     * Панель ждать не заставляем — ход виден в журнале, готовность в /api/state.
     */
    if (u.pathname === '/api/reset' && req.method === 'POST') {
      if (auto.on) {
        return json(res, 200, { ok: false, reason: 'сначала останови автопрогон' });
      }
      if (running.size) {
        return json(res, 200, { ok: false, reason: 'сначала останови задачи (кнопка «Остановить»)' });
      }
      // выходить не из кого — сразу убираем
      if (!accounts.list().length) return json(res, 200, { ok: true, ...wipeAll() });
      push('\n🧹 чистка: выхожу из аккаунтов, это займёт несколько секунд…');
      run('_wipe', 'чистка', 'Выход из всех аккаунтов', pythonCmd(),
          [path.join(DIR, 'logout-accounts.py')], () => wipeAll());
      return json(res, 200, { ok: true, started: true });
    }

    if (u.pathname === '/api/state') {
      const now = counts();
      return json(res, 200, {
        running: [...running.values()].map((v) => v.title),
        base: readCsv('numbers.csv').length,
        ...now,
        // числа за всё время: переживают чистку, поэтому считаются отдельно
        total: statsTotal(now),
        replies: replies().n,
        baseLoading: running.has('_base'),
        wiping: running.has('_wipe'),
        claims: claims.active(),
        auto: autoView(),
        logLen: log.length,
      });
    }

    /**
     * Картинка QR для входа: её кладёт login-qr.py, пока ждёт скана.
     * Нет файла — значит кода сейчас нет (ещё не начали или уже вошли).
     */
    if (u.pathname === '/api/qr') {
      const id = u.searchParams.get('account') || '';
      const f = path.join(DIR, 'qr', `${path.basename(id)}.svg`);
      if (!/^[a-z0-9_-]+$/i.test(id) || !fs.existsSync(f)) return json(res, 404, { ok: false });
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(f));
    }

    if (u.pathname === '/api/log') {
      const from = Math.max(0, +(u.searchParams.get('from') || 0));
      return json(res, 200, { from, lines: log.slice(from), total: log.length });
    }

    if (u.pathname === '/api/replies') {
      return json(res, 200, replies());
    }

    if (u.pathname === '/api/found') {
      const rows = readCsv('drafts.csv');
      const drafted = new Set(rows.filter((r) => r.ok === 'true').map((r) => r.phone));
      const sent = new Set(rows.filter((r) => r.sent === 'true').map((r) => r.phone));
      return json(res, 200, readCsv('results.csv').filter((r) => r.tg === 'true')
        .map((r) => ({ phone: r.phone, name: r.name || '', last_call: r.last_call || '',
                       draft: drafted.has(r.phone), sent: sent.has(r.phone) })));
    }

    /**
     * Автопрогон: панель сама гоняет пачки всеми выбранными аккаунтами,
     * пока база не кончится. {on:false} — остановить.
     */
    if (u.pathname === '/api/auto' && req.method === 'POST') {
      const o = await body(req);
      if (o.on === false) { autoStop('остановлено вручную'); return json(res, 200, { ok: true }); }
      return json(res, 200, autoStart(o));
    }

    if (u.pathname === '/api/start' && req.method === 'POST') {
      const { name, account, accounts: many, limit, delay, send, voice, warm: w } = await body(req);
      const opts = { limit, delay, send, voice, warm: w };
      // список аккаунтов -> запускаем задачу на каждом СРАЗУ: они делят базу
      // бронями и идут параллельно. Одиночный account — как раньше.
      if (Array.isArray(many) && many.length) return json(res, 200, startMany(name, many, opts));
      return json(res, 200, start(name, { account, ...opts }));
    }

    if (u.pathname === '/api/loadbase' && req.method === 'POST') {
      const { path: p } = await body(req);
      if (!p) return json(res, 200, { ok: false, reason: 'укажи путь к файлу' });
      return json(res, 200, loadBase(p));
    }

    if (u.pathname === '/api/stop' && req.method === 'POST') {
      const { account } = await body(req);
      // «Остановить» без уточнения — значит всё: не выключив автопрогон,
      // мы бы убили процессы, а он через секунду запустил бы их снова
      if (!account) autoStop('остановлено вручную');
      else if (auto.on && auto.per.has(account)) {
        auto.per.get(account).stopped = true;
        auto.per.get(account).note = 'снят вручную';
      }
      const keys = account ? [account] : [...running.keys()];
      for (const k of keys) {
        const r = running.get(k);
        if (r) { r.child.kill('SIGTERM'); push(`⏹ остановлено вручную: ${r.title}`); }
      }
      return json(res, 200, { ok: true });
    }

    res.writeHead(404).end('not found');
  } catch (e) {
    json(res, 500, { error: e.message.split('\n')[0] });
  }
}

// ---------- запуск ----------
if (!auth.configured()) {
  console.log('\n  Панель без пароля не поднимается.');
  console.log('  Задай вход:  node set-password.mjs <логин> <пароль>\n');
  process.exit(1);
}

// пароль по открытому HTTP на внешнем адресе уходит по сети как есть —
// пускаем только с сертификатом либо с явного согласия
if (!LOCAL && !TLS && !process.argv.includes('--insecure-http')) {
  console.log(`\n  Отказ: ${HOST} — не локальный адрес, а шифрования нет.`);
  console.log('  По открытому HTTP пароль от панели уйдёт по сети в чистом виде.\n');
  console.log('  Как правильно:');
  console.log('   • оставить панель на 127.0.0.1 и прокинуть её туннелем');
  console.log('     (cloudflared / ngrok) — шифрование и адрес получишь готовыми;');
  console.log('   • либо свой сертификат:  node admin.mjs --host 0.0.0.0 --cert cert.pem --key key.pem\n');
  console.log('  Если снаружи уже стоит nginx с HTTPS и панель слушает только его:');
  console.log('     node admin.mjs --host 0.0.0.0 --insecure-http\n');
  process.exit(1);
}

const server = TLS
  ? https.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, handler)
  : http.createServer(handler);

server.on('error', (e) => {
  console.log(e.code === 'EADDRINUSE'
    ? `\n  Порт ${PORT} занят — панель уже запущена.\n` +
      `  Остановить старую:  lsof -ti tcp:${PORT} | xargs kill\n`
    : `ошибка сервера: ${e.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `${TLS ? 'https' : 'http'}://${LOCAL ? 'localhost' : HOST}:${PORT}`;
  console.log(`\n  ПУЛЬТ: ${url}   (вход по логину и паролю)\n`);
  const moved = accounts.migrateDraftsLog();
  push(moved ? `панель запущена; история черновиков (${moved} строк) переведена на новый формат`
             : 'панель запущена, готов к работе');
  if (LOCAL && !process.argv.includes('--no-open')) {
    exec(process.platform === 'darwin' ? `open ${url}`
       : process.platform === 'win32' ? `start ${url}` : `xdg-open ${url}`);
  }
});
