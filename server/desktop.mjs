/**
 * Telegram Desktop: найти приложение, достать tdata, запустить на своей папке.
 *
 * Каждому аккаунту — свой каталог (ключ -workdir у десктопа), поэтому
 * несколько аккаунтов спокойно живут рядом и не мешают друг другу.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

export const TDESK_HINT =
  'Не найден Telegram Desktop. Похоже, стоит нативный клиент Telegram для macOS ' +
  '(ru.keepcoder.Telegram) — он формат tdata не понимает, это другое приложение.\n\n' +
  'Поставь именно Telegram Desktop:\n' +
  '  brew install --cask telegram-desktop\n' +
  'либо скачай с desktop.telegram.org и положи в /Applications.';

/**
 * Путь к Telegram Desktop. Важно не спутать с нативным клиентом для macOS:
 * тот про tdata ничего не знает и -workdir не умеет, поэтому сверяем
 * идентификатор приложения, а не имя файла.
 */
export function tdesktopApp() {
  if (process.platform === 'win32') {
    const exe = path.join(process.env.APPDATA || '', 'Telegram Desktop', 'Telegram.exe');
    return fs.existsSync(exe) ? exe : '';
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
export function findTdata(root, depth = 0) {
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

/**
 * Достаёт tdata из архива в рабочую папку. Берём ТОЛЬКО tdata: рядом в
 * архиве часто лежит заметка с паролем, и её имя в не-UTF8 кодировке роняет
 * unzip целиком. Ошибку на прочих файлах глотаем — важно лишь, дошла ли tdata.
 */
export function unpackTdata(zipFile, workdir, tmpRoot) {
  const tmp = fs.mkdtempSync(path.join(tmpRoot, '_x'));
  try {
    try {
      execFileSync('unzip', ['-qo', zipFile, '*tdata/*', '-d', tmp], { stdio: 'ignore' });
    } catch {}
    const found = findTdata(tmp);
    if (!found) throw new Error('внутри архива нет папки tdata');
    fs.rmSync(path.join(workdir, 'tdata'), { recursive: true, force: true });
    fs.cpSync(found, path.join(workdir, 'tdata'), { recursive: true });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Пускаем десктоп отдельно от панели: он живёт своей жизнью и её не держит. */
export function launchDesktop(app, workdir) {
  const child = spawn(app, ['-workdir', workdir], { detached: true, stdio: 'ignore' });
  child.unref();
}
