/**
 * Панель: весь клиентский код.
 *
 * Схема простая: раз в две секунды опрашиваем сервер (loop внизу файла) и
 * перерисовываем то, что изменилось. Никаких фреймворков — панель одна,
 * состояний немного, а так её правит любой, кто читает JavaScript.
 */
const $ = s => document.querySelector(s);
let logFrom = 0, busy = false, accs = [], accsRaw = '';
let cur = localStorage.getItem('tg-account') || '';

const post = (url, data) => fetch(url, {
  method: 'POST',
  headers: {'content-type': 'application/json', 'x-panel': '1'},
  body: JSON.stringify(data || {}),
}).then(r => { if (r.status === 401) { location.href = '/login'; throw new Error('нужен вход'); } return r.json(); });

const pick = (id) => { cur = id; localStorage.setItem('tg-account', id); accsRaw = ''; paintAccounts(); };

/** Текст из чужих рук (имя из Telegram, название аккаунта) в разметку — только так. */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g,
  (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/** Вошёл или нет — это первое, что нужно видеть в списке. */
const accReady = (a) => a.session && a.authed;
const accBadge = (a) =>
  a.busy ? `<span class="st st-run">${esc(a.busy)}</span>`
  : accReady(a) ? '<span class="st st-ok">вошёл</span>'
  : a.profile && !a.session ? '<span class="st st-no">нужен перенос</span>'
  : '<span class="st st-no">не вошёл</span>';

/**
 * Прогрев одной строкой. Свежий аккаунт нельзя сразу гнать в рассылку —
 * панель ведёт его по расписанию, и человеку надо видеть, где он сейчас.
 */
const fmtLeftJs = (sec) => sec >= 3600
  ? `${Math.floor(sec / 3600)} ч ${Math.round((sec % 3600) / 60)} мин`
  : `${Math.max(1, Math.round(sec / 60))} мин`;
const warmLine = (a) => {
  const w = a.warm;
  if (!w) return '';
  if (w.resting) return `🌱 отлёжка — ещё ${fmtLeftJs(w.restLeft)}, не трогаем`;
  return `🌱 день ${w.day} · ${w.note} · сегодня осталось ${w.left}`;
};

/** Кто это на самом деле: имя, @ и телефон — их отдаёт Telegram при входе. */
const accWho = (a) => {
  const who = [a.name, a.username ? '@' + a.username : '', a.phone ? '+' + String(a.phone).replace(/^\+/, '') : '']
    .filter(Boolean).map(esc).join(' · ');
  if (who) return who;
  return accReady(a) ? 'данные аккаунта появятся после первой задачи'
       : a.profile && !a.session ? 'нажми «На Telethon» — вход перенесётся без QR'
       : 'войди по QR или залей готовую сессию';
};

function paintAccounts() {
  if (!accs.length) {
    $('#accs').innerHTML = '<p style="color:var(--mut);margin:0">Пока ни одного — нажми «Добавить аккаунт».</p>';
    $('#acct').innerHTML = '<b style="color:var(--no)">аккаунт не подключён</b>';
    $('#s1').classList.remove('done');
    return;
  }
  if (!accs.some(a => a.id === cur)) cur = accs[0].id;
  if (work === null) work = new Set(accs.filter(accReady).map(a => a.id));
  $('#accs').innerHTML = accs.map(a => `
    <label class="acc ${work.has(a.id) ? 'sel' : ''}">
      <input type="checkbox" data-work="${a.id}" ${work.has(a.id) ? 'checked' : ''}
             ${accReady(a) ? '' : 'disabled'}>
      <span class="nm"><b>${esc(a.title)} ${accBadge(a)}</b>
        <span class="${accReady(a) ? 'on' : 'off'}">${accWho(a)}</span>
        <span>${esc(a.proxyLabel)} · написано ${a.sent} · черновиков ${a.drafts}${
          a.held ? ` · держит ${a.held}` : ''}</span>
        <span class="warm ${a.warm && a.warm.resting ? 'off' : ''}">${warmLine(a)}</span></span>
      <span class="accbtns">
        <button class="ghost mini" data-tgname="${a.id}" data-busy title="Имя и фамилия в самом Telegram">Имя</button>
        <button class="ghost mini" data-tguser="${a.id}" data-busy title="@username в Telegram">@ник</button>
        <button class="ghost mini" data-tgpic="${a.id}" data-busy title="Аватарка в Telegram">Аватар</button>
        <button class="ghost mini" data-desk="${a.id}" data-busy title="Открыть этот аккаунт в Telegram Desktop">Desktop</button>
        <button class="ghost mini" data-prx="${a.id}" data-busy title="Через какой прокси ходит">Прокси</button>
        <button class="ghost mini" data-chk="${a.id}" data-busy title="Проверить, жив ли прокси">IP</button>
        <button class="ghost mini" data-imp="${a.id}" data-busy title="Залить файл сессии">Сессия</button>${
        a.profile && !a.session
          ? `<button class="ghost mini" data-mig="${a.id}" data-busy>На Telethon</button>` : ''}
        <button class="ghost mini" data-ren="${a.id}" data-busy title="Название только внутри панели">Ярлык</button>
        <button class="ghost mini" data-del="${a.id}" data-busy title="Удалить сессию с этого компьютера">Убрать</button>
      </span>
    </label>`).join('');

  // галочки — единственный выбор на всю панель: по нему идут и запуск, и ручные заходы
  document.querySelectorAll('#accs [data-work]').forEach(c => c.onchange = () => {
    c.checked ? work.add(c.dataset.work) : work.delete(c.dataset.work);
    accsRaw = '';            // перерисовать подсветку строки
    paintAccounts();
  });
  document.querySelectorAll('[data-ren]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.ren);
    const t = prompt('Как назвать этот аккаунт?', a.title);
    if (t) { await post('/api/accounts/rename', {id: a.id, title: t}); loop(); }
  });
  // Профиль в самом Telegram — тем же ключом, которым работает панель.
  // Разнесено по кнопкам: чаще всего нужно что-то одно, а не всё сразу.
  document.querySelectorAll('[data-tgname]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.tgname);
    const name = prompt(`Имя в Telegram для «${esc(a.title)}»\n\nТак его увидят люди, которым пишем.`, a.name || '');
    if (name === null || !name.trim()) return;
    const last = prompt('Фамилия (можно пусто):', '');
    if (last === null) return;
    const r = await post('/api/accounts/profile', {id: a.id, name: name.trim(), last: last.trim()});
    if (!r.ok) alert(r.reason || 'не удалось'); else state();
  });

  document.querySelectorAll('[data-tguser]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.tguser);
    const u = prompt(`@username для «${esc(a.title)}» — без «собаки».\n\n` +
      '5–32 знака, латиница, цифры и _. Если занят, Telegram откажет.',
      a.username || '');
    if (u === null || !u.trim()) return;
    const r = await post('/api/accounts/profile', {id: a.id, username: u.trim().replace(/^@/, '')});
    if (!r.ok) alert(r.reason || 'не удалось'); else alert('Меняю @ — результат смотри в журнале.');
    state();
  });

  document.querySelectorAll('[data-tgpic]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.tgpic);
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/jpeg,image/png,image/webp';
    inp.onchange = async () => {
      if (!inp.files[0]) return;
      $('#status-t').textContent = 'ставлю аватарку…';
      const res = await fetch('/api/accounts/photo?account=' + encodeURIComponent(a.id), {
        method: 'POST',
        headers: {'x-filename': encodeURIComponent(inp.files[0].name), 'x-panel': '1'},
        body: inp.files[0],
      }).then(r => r.json()).catch(() => ({ok: false}));
      if (!res.ok) alert(res.reason || 'не удалось загрузить аватарку');
      state();
    };
    inp.click();
  });

  /**
   * Открыть аккаунт в Telegram Desktop. Два шага не ради красоты: если пустить
   * десктоп сразу с аккаунтом, он сходит в Telegram с настоящего IP, а панель
   * ходит через прокси — одна авторизация из двух стран, и сессию отзывают.
   * Поэтому сначала пустой запуск для настройки прокси, потом уже с аккаунтом.
   */
  document.querySelectorAll('[data-desk]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.desk);
    const how = prompt(
      `Открыть «${esc(a.title)}» в Telegram Desktop.\n\n` +
      `Аккаунт ходит через: ${esc(a.proxyLabel)}\n` +
      `Если десктоп выйдет в сеть мимо этого прокси — Telegram увидит одну\n` +
      `авторизацию с двух разных IP и может отозвать сессию.\n\n` +
      `  1 — ПОДГОТОВИТЬ: запустить десктоп пустым (без аккаунта),\n` +
      `      прописать в нём прокси и закрыть. Светить нечего.\n` +
      `  2 — ОТКРЫТЬ аккаунт (только после шага 1).\n\n` +
      `Введи 1 или 2:`, '1');
    if (how === null) return;
    const step = how.trim() === '2' ? 'open' : 'proxy';
    const r = await post('/api/accounts/desktop', {id: a.id, step});
    if (!r.ok) { alert(r.reason || 'не удалось'); return; }

    if (step === 'proxy') {
      alert('Десктоп открыт ПУСТЫМ — аккаунта в нём пока нет.\n\n' +
        'Сделай так:\n' +
        `  Настройки → Продвинутые → Тип соединения → Свой прокси\n` +
        `  SOCKS5, укажи: ${a.proxyLabel}\n\n` +
        'Потом закрой окно Telegram и нажми эту кнопку снова, выбрав 2.');
      await post('/api/accounts/desktop/ready', {id: a.id});
      return;
    }
    if (!r.warmed && !confirm('Похоже, прокси в этой папке ещё не настраивали (шаг 1).\n\n' +
        'Открыть всё равно? Аккаунт может выйти в сеть с твоего IP.')) return;
    alert('Открываю в Telegram Desktop.\n\nУчти: ключ у десктопа и у панели общий — ' +
      'не выходи там из аккаунта, иначе панель тоже потеряет сессию.');
  });

  document.querySelectorAll('[data-prx]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.prx);
    const t = prompt(`Через какой прокси ходит «${a.title}»?\n\nФормат: host:port  либо  host:port:логин:пароль\nМожно с протоколом: socks5://host:port\n\nПустая строка — ходить напрямую, со своего IP.`, a.proxy);
    if (t === null) return;
    const r = await post('/api/accounts/proxy', {id: a.id, proxy: t});
    if (!r.ok) alert(r.reason || 'не удалось');
    else { if (r.warn) alert(r.warn); accsRaw = ''; loop(); }
  });
  document.querySelectorAll('[data-imp]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.imp);
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.zip,.session';
    inp.onchange = async () => {
      if (!inp.files[0]) return;
      const res = await importFile(a.id, inp.files[0]);
      if (!res.ok) alert(res.reason || 'не удалось загрузить');
      else alert(`Файл принят как ${res.kind}. Подключаю сессию «${a.title}» — смотри журнал.`);
      loop();
    };
    inp.click();
  });
  document.querySelectorAll('[data-mig]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.mig);
    if (!confirm(`Перенести «${a.title}» на прямой канал Telegram?\n\nКлюч возьмётся из уже открытой сессии браузера — сканировать QR заново не нужно. Займёт несколько секунд.`)) return;
    const r = await post('/api/start', {name: 'migrate', account: a.id});
    if (!r.ok && r.reason) alert(r.reason);
    state();
  });
  document.querySelectorAll('[data-chk]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const r = await post('/api/start', {name: 'proxy', account: b.dataset.chk});
    if (!r.ok && r.reason) alert(r.reason);
    state();
  });
  document.querySelectorAll('[data-del]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.del);
    if (!confirm(`Отключить «${a.title}»?\n\nСессия на этом компьютере удалится — чтобы вернуть аккаунт, придётся снова входить по QR. Собранные номера и история сообщений останутся.`)) return;
    const r = await post('/api/accounts/remove', {id: a.id});
    if (!r.ok) alert(r.reason || 'не удалось'); else loop();
  });

  const chosen = accs.filter(x => work.has(x.id) && accReady(x));
  $('#acct').innerHTML = chosen.length
    ? `Работают: <b style="color:var(--ok)">${chosen.map(x => esc(x.title)).join(', ')}</b>`
    : '<b style="color:var(--no)">не отмечен ни один вошедший аккаунт</b>';
  $('#selcount').innerHTML = chosen.length
    ? `Отмечено <b>${chosen.length}</b> из ${accs.length}. Базу они поделят между собой: ` +
      `чем больше аккаунтов, тем больше можно за сутки.`
    : 'Отметь хотя бы один вошедший аккаунт — иначе запускать нечем.';
  $('#s1').classList.toggle('done', chosen.length > 0);
}

const accounts = async () => {
  try {
    const raw = await (await fetch('/api/accounts')).text();
    // перерисовываем только при изменениях: иначе список моргает каждые две секунды
    if (raw === accsRaw) return;
    accsRaw = raw; accs = JSON.parse(raw); paintAccounts();
  } catch {}
};

const state = async () => {
  try {
    const s = await (await fetch('/api/state')).json();
    lastState = s;
    baseLoading = !!s.baseLoading;
    for (const k of ['base','checked','found','sent']) $('#n-'+k).textContent = s[k];
    $('#n-replies').textContent = s.replies ?? 0;
    // «занят» теперь про выбранный аккаунт: остальные могут работать параллельно
    const anyRun = s.running.length > 0;
    busy = !!accs.find(a => a.id === cur)?.busy;
    $('#status-t').textContent = anyRun ? 'идёт: ' + s.running.join(' · ') : 'готов';
    const held = (s.claims || []).reduce((n, c) => n + c.n, 0);
    $('#claims').textContent = held ? `в работе у аккаунтов: ${held} номеров` : '';
    $('.run').classList.toggle('on', anyRun);
    // защита: задачи проверки/рассылки/сводки/чистки нужны живой сессии —
    // если выбранный аккаунт не вошёл, эти кнопки блокируем и объясняем почему
    const curAcc = accs.find(a => a.id === cur);
    const curReady = !!(curAcc && curAcc.session && curAcc.authed);
    // проверка/рассылка идут на выбранных (work) и живы, пока среди них есть
    // хоть один вошедший и не все заняты; сводка/чистка — по текущему аккаунту
    const workReady = accs.some(a => (work ? work.has(a.id) : true) && accReady(a));
    const workFree = accs.some(a => (work ? work.has(a.id) : true) && accReady(a) && !a.busy);
    document.querySelectorAll('button[data-t]').forEach(b => {
      const t = b.dataset.t;
      if (t === 'login') b.disabled = busy;
      else b.disabled = !workReady || !workFree;   // всё остальное — по отмеченным
    });
    document.querySelectorAll('button[data-busy]').forEach(b => b.disabled = anyRun);
    $('#notready').hidden = workReady || !accs.length;
    $('#stop').disabled = !anyRun;
    paintTotal(s.total);
    $('#s4').classList.toggle('done', s.drafts > 0);
    paintAuto(s.auto || {on: false, accounts: []});
  } catch { $('#status-t').textContent = 'сервер не отвечает'; }
};

/** Пока идёт вход, показываем текущий QR: файл переписывается сам, когда код протухает. */
/**
 * Текст рассылки. Загружаем один раз: перечитывать каждые две секунды нельзя —
 * затрёт то, что человек в этот момент печатает.
 */
let msgLoaded = false;
const msgPreview = () => {
  const d = new Date();
  const date = `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
  const text = $('#msg').value.replaceAll('{name}', ', Евгения').replaceAll('{date}', date);
  $('#msg-prev').textContent = text.trim() ? 'так это увидит человек:\n\n' + text.trim() : '';
};
const message = async () => {
  if (msgLoaded) return;
  try {
    const d = await (await fetch('/api/message')).json();
    $('#msg').value = (d.text || '').trim();
    msgLoaded = true;
    msgPreview();
  } catch {}
};
$('#msg').oninput = msgPreview;
$('#msg-save').onclick = async () => {
  const r = await post('/api/message', {text: $('#msg').value});
  if (!r.ok) { alert(r.reason || 'не удалось сохранить'); return; }
  $('#msg').value = r.text;
  msgPreview();
  const t = new Date().toTimeString().slice(0, 5);
  $('#msg-note').innerHTML = `сохранено в ${t} · подстановки: <b>{name}</b> — имя, <b>{date}</b> — дата звонка`;
};

/**
 * Голосовое. Грузим сведения один раз (как и текст) и обновляем после
 * загрузки/удаления — незачем дёргать сервер каждые две секунды.
 */
let voiceLoaded = false, hasVoice = false;
const fmtDur = (s) => `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
const paintVoice = (v) => {
  hasVoice = !!v.exists;
  $('#voice-state').textContent = hasVoice
    ? `${v.name || 'голосовое'} · ${fmtDur(v.duration || 0)}` : 'не загружено';
  $('#voice-state').className = hasVoice ? 'on' : '';
  $('#voice-del').hidden = !hasVoice;
  $('#voice-play').hidden = !hasVoice;
  if (hasVoice) $('#voice-play').src = '/api/voice/file?t=' + Date.now();
  if (!hasVoice && $('#voicemode').checked) { $('#voicemode').checked = false; voiceModeChange(); }
  $('#voicemode').disabled = !hasVoice;
};
const voice = async () => {
  if (voiceLoaded) return;
  try { paintVoice(await (await fetch('/api/voice')).json()); voiceLoaded = true; } catch {}
};
$('#voice-pick').onclick = () => {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'audio/*,.ogg,.opus,.mp3,.m4a,.wav';
  inp.onchange = async () => {
    if (!inp.files[0]) return;
    $('#voice-state').textContent = 'загружаю…';
    const res = await fetch('/api/voice', {
      method: 'POST',
      headers: {'x-filename': encodeURIComponent(inp.files[0].name), 'x-panel': '1'},
      body: inp.files[0],
    }).then(r => r.json()).catch(() => ({ok:false}));
    if (!res.ok) { alert(res.reason || 'не удалось загрузить'); voiceLoaded = false; voice(); return; }
    paintVoice({exists: true, name: res.name, duration: res.duration});
  };
  inp.click();
};
$('#voice-del').onclick = async () => {
  await post('/api/voice/delete', {});
  paintVoice({exists: false});
};
function voiceModeChange() {
  const on = $('#voicemode').checked;
  // голосовое и текст исключают друг друга: в голосовом режиме текстовая
  // отправка не при чём, поэтому её галочку убираем и блокируем
  if (on) { $('#send').checked = false; }
  $('#send').disabled = on;
  $('#sendwarn').hidden = !(on || $('#send').checked);
  $('#sendwarn').textContent = on
    ? 'Голосовое уйдёт людям по-настоящему и не отзывается. Начни с маленького «за раз».'
    : 'Сообщения уйдут людям по-настоящему и не отзываются. Начни с маленького «за раз».';
  $('#b-drafts').textContent = on ? 'Отправить голосовое'
    : $('#send').checked ? 'Написать и отправить' : 'Написать';
  paintAuto();
}
$('#voicemode').onchange = voiceModeChange;

let qrUrl = '';
const qr = async () => {
  // Спрашиваем картинку, только пока реально идёт вход. Иначе панель раз в две
  // секунды получала 404 и засыпала консоль ошибками, за которыми не видно
  // настоящих.
  const logging = accs.some(a => /вход/i.test(a.busy || ''));
  if (!logging) { if (!$('#qr').hidden) $('#qr').hidden = true; return; }
  if (!cur) return;
  try {
    const r = await fetch(`/api/qr?account=${encodeURIComponent(cur)}&t=${Date.now()}`);
    if (!r.ok) { $('#qr').hidden = true; return; }
    // прошлую картинку освобождаем: опрос идёт раз в две секунды,
    // иначе за час ожидания наберётся полторы тысячи мёртвых ссылок
    if (qrUrl) URL.revokeObjectURL(qrUrl);
    qrUrl = URL.createObjectURL(await r.blob());
    $('#qr-img').src = qrUrl;
    $('#qr').hidden = false;
  } catch { $('#qr').hidden = true; }
};

const tail = async () => {
  try {
    const d = await (await fetch('/api/log?from=' + logFrom)).json();
    if (d.lines.length) {
      $('#log').textContent += d.lines.join('\n') + '\n';
      $('#log').scrollTop = $('#log').scrollHeight;
      logFrom = d.total;
    }
  } catch {}
};

/** Кто ответил — списком, чтобы не лезть в журнал. */
const repliesList = async () => {
  try {
    const d = await (await fetch('/api/replies')).json();
    $('#replies').innerHTML = (d.list || []).length
      ? '<div style="margin-top:10px;font-weight:600">Ответили:</div>' +
        d.list.map(r => `<div class="r"><b>${esc(r.who)}</b>
          <span>${esc(r.text || '')}</span></div>`).join('')
      : (d.at ? '<div style="color:var(--mut);margin-top:8px">пока никто не ответил</div>' : '');
  } catch {}
};

const found = async () => {
  const rows = await (await fetch('/api/found')).json();
  $('#rows').innerHTML = rows.map(r => `<tr>
    <td class="numcell">${r.phone}</td><td>${r.name || '—'}</td>
    <td style="color:var(--mut)">${(r.last_call||'').slice(0,10)}</td>
    <td>${r.sent ? '<span class="badge yes">отправлено</span>'
        : r.draft ? '<span class="badge wait">черновик</span>' : ''}</td></tr>`).join('')
    || '<tr><td colspan="4" style="color:var(--mut)">пока пусто — нажми «Проверить базу»</td></tr>';
};

/**
 * Сводка за всё время. Числа в кружках наверху — про то, что лежит в файлах
 * сейчас; чистка их обнуляет. Эта строка считает вместе с кешем и потому
 * чистку переживает — показываем её только когда есть что показать сверх
 * текущего, иначе она просто дублировала бы кружки.
 */
const nfmt = (n) => String(n).replace(/\B(?=(\d{3})+$)/g, ' ');
function paintTotal(t) {
  const box = $('#alltime');
  if (!t || !t.wipes) { box.hidden = true; return; }
  box.hidden = false;
  const when = t.since ? new Date(t.since).toLocaleDateString('ru-RU') : '';
  const last = t.last
    ? `последняя чистка ${new Date(t.last.at).toLocaleString('ru-RU')}` +
      (t.last.backup ? ` · данные в <b>${esc(t.last.backup)}</b>` : '')
    : '';
  box.innerHTML = `За всё время${when ? `, с ${when}` : ''}:
    проверено <b>${nfmt(t.checked)}</b> ·
    есть в Telegram <b>${nfmt(t.found)}</b> ·
    написано <b>${nfmt(t.drafts)}</b> ·
    отправлено <b>${nfmt(t.sent)}</b>` + (last ? `<br>${last}` : '');
}

/**
 * Автопрогон. Кого гонять — отмечается галочками; пока прогон идёт, вместо
 * галочек показываем, чем каждый занят и до какого времени отдыхает.
 * Всё остальное (размер пачки, паузы, текст, «отправлять сразу») берём из
 * шагов 3 и 4 — второго набора тех же полей быть не должно.
 */
let lastState = null, baseLoading = false;
let work = null, autoOn = false, autoLast = {on: false, accounts: []}, autoRaw = '';
const fmtWait = (s) => s >= 3600 ? `${Math.floor(s / 3600)} ч ${Math.round(s % 3600 / 60)} мин`
  : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function paintAuto(a) {
  autoLast = a = a || autoLast;
  const on = autoOn = !!a.on;
  const chosen = accs.filter(x => work && work.has(x.id) && accReady(x));

  // строки «кто чем занят» — только пока прогон идёт
  $('#autostate').innerHTML = !on ? '' : (a.accounts || []).map(x => `<div class="arow">
      <b>${esc(x.title)}</b>
      <span>${x.stopped ? '<span style="color:var(--no)">выбыл</span>'
             : x.busy ? `<span style="color:var(--ok)">${esc(x.busy)}</span>`
             : x.wait ? 'отдыхает' : 'свободен'}${
        x.note ? ' — ' + esc(x.note) : ''}</span>
      <span class="w">заходов ${x.batches}${
        !x.stopped && !x.busy && x.wait ? ` · через ${fmtWait(x.wait)}` : ''}</span>
    </div>`).join('');

  $('#b-auto').textContent = on ? 'Остановить' : 'Запустить';
  $('#b-auto').className = on ? 'danger big' : 'primary big';
  $('#b-auto').disabled = !chosen.length && !on;
  for (const id of ['#amode','#apause','#acap','#delay','#ddelay','#limit','#dlimit',
                    '#sm-draft','#sm-send'])
    if ($(id)) $(id).disabled = on;

  // предупреждение об отправке: пока идёт — по тому, что прогон делает НА САМОМ ДЕЛЕ
  const asVoice = on ? a.voice : $('#voicemode').checked;
  const asSend = on ? a.send : ($('#send').checked && $('#amode').value !== 'check');
  $('#autowarn').hidden = !(asVoice || asSend);
  $('#autowarn').innerHTML = asVoice
    ? 'Голосовые уходят людям <b>по-настоящему</b> и не отзываются.'
    : 'Сообщения уйдут людям <b>по-настоящему</b>. Отозвать нельзя — поставь дневной предел.';

  paintStage(a);
}

/**
 * Крупная строка «что происходит прямо сейчас». Ради неё всё и затевалось:
 * журнал читать никто не будет, а понять этап нужно с одного взгляда.
 */
function paintStage(a) {
  const box = $('#stage');
  if (!box) return;
  const s = lastState || {};
  if (baseLoading) {
    box.hidden = false;
    box.innerHTML = '<b>Разбираю таблицу…</b><br><span style="color:var(--mut)">' +
      'ищу колонку с номерами</span>';
    return;
  }
  if (!a.on) {
    // прогон не идёт — показываем итог прошлого, если что-то уже сделано
    if (!s.checked && !s.drafts) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `<b>Сейчас не работает.</b><br><span style="color:var(--mut)">` +
      `Проверено ${s.checked} из ${s.base}, найдено ${s.found}, написано ${s.drafts}. ` +
      `Нажми «Запустить», чтобы продолжить.</span>`;
    return;
  }
  const busyNames = (a.accounts || []).filter(x => x.busy);
  const checking = busyNames.filter(x => /Проверка/i.test(x.busy)).length;
  const writing = busyNames.filter(x => /Черновик/i.test(x.busy)).length;
  let head;
  if (writing && checking) head = `Проверяю базу и пишу людям`;
  else if (writing) head = `Пишу людям`;
  else if (checking) head = `Проверяю базу`;
  else head = 'Пауза между заходами — аккаунты отдыхают';
  const pct = s.base ? Math.round((s.checked / s.base) * 100) : 0;
  const sendWord = a.voice ? 'голосовым, уходит сразу'
                 : a.send ? 'ОТПРАВЛЯЮ по-настоящему' : 'только черновики, никому не уходит';
  box.hidden = false;
  box.innerHTML =
    `<b>${head}</b> · режим: ${esc(sendWord)}<br>` +
    `<span style="color:var(--mut)">проверено ${s.checked} из ${s.base} · ` +
    `найдено ${s.found} · написано ${s.drafts}${s.replies ? ` · ответили ${s.replies}` : ''}` +
    `</span><div class="bar"><i style="width:${pct}%"></i></div>`;
}

$('#b-auto').onclick = async () => {
  if (autoOn) { await post('/api/auto', {on: false}); state(); return; }
  const mode = $('#amode').value;
  const voice = mode !== 'check' && $('#voicemode').checked;
  const send = mode !== 'check' && !voice && $('#send').checked;
  const who = accs.filter(x => work.has(x.id) && accReady(x)).map(x => x.title);
  if (!who.length) { alert('Отметь хотя бы один вошедший аккаунт'); return; }
  const cap = +$('#acap').value || 0;
  if ((send || voice) && !confirm(
      `Запустить автопрогон от: ${who.join(', ')}?\n\n` +
      `Панель будет САМА ${voice ? 'отправлять голосовые' : 'отправлять сообщения'} людям, ` +
      `пачка за пачкой, пока база не кончится.\n` +
      (cap ? `Не больше ${cap} в сутки на аккаунт.\n` : 'Дневной предел не выставлен.\n') +
      `\nОтозвать отправленное нельзя. Продолжить?`)) return;
  const r = await post('/api/auto', {
    on: true, mode, send, voice, cap, warm: $('#warmon').checked,
    accounts: [...work].filter(id => accReady(accs.find(a => a.id === id) || {})),
    pause: +$('#apause').value || 60,
    checkLimit: $('#limit').value, checkDelay: $('#delay').value,
    writeLimit: $('#dlimit').value, writeDelay: $('#ddelay').value,
  });
  if (!r.ok && r.reason) alert(r.reason);
  state();
};
$('#amode').onchange = () => paintAuto();

document.querySelectorAll('button[data-t]').forEach(b => b.onclick = async () => {
  const t = b.dataset.t;
  const multi = t !== 'login';   // всё, кроме входа, идёт на отмеченных аккаунтах
  const drafts = t === 'drafts';
  const voiceMode = drafts && $('#voicemode').checked;

  // кто участвует: для проверки/рассылки — набор work, иначе выбранный (cur)
  const chosen = accs.filter(a => work.has(a.id) && accReady(a)).map(a => a.title);
  if (multi && !chosen.length) { alert('Отметь хотя бы один вошедший аккаунт'); return; }
  const whoList = chosen.join(', ');
  const per = drafts ? $('#dlimit').value : $('#limit').value;

  if (voiceMode &&
      !confirm(`Голосовое уйдёт людям ПО-НАСТОЯЩЕМУ — до ${per} с каждого из: ${whoList}.\n\nОтозвать нельзя. Продолжить?`)) return;
  if (drafts && !voiceMode && $('#send').checked &&
      !confirm(`Сообщения уйдут людям ПО-НАСТОЯЩЕМУ — до ${per} с каждого из: ${whoList}.\n\nОтозвать нельзя. Продолжить?`)) return;

  const payload = {
    name: t,
    warm: $('#warmon') ? $('#warmon').checked : true,
    limit: per,
    delay: drafts ? $('#ddelay').value : $('#delay').value,
    send: drafts && !voiceMode && $('#send').checked,
    voice: voiceMode,
  };
  if (multi) payload.accounts = accs.filter(a => work.has(a.id) && accReady(a)).map(a => a.id);
  else payload.account = cur;

  const r = await post('/api/start', payload);
  if (!r.ok && r.reason) alert(r.reason);
  else if (multi && r.skipped && r.skipped.length) alert('Запущено: ' + r.started + '\nПропущены:\n' + r.skipped.join('\n'));
  state();
});

/**
 * «Черновик / отправлять сразу» — крупным выбором. Внутри всё по-прежнему
 * висит на галочке #send: её читают и запуск, и ручные заходы, и подтверждения.
 */
function sendModeChange() {
  const send = $('#sm-send').checked;
  $('#send').checked = send;
  $('#b-drafts').textContent = send ? 'Отправить — один заход' : 'Разложить черновики — один заход';
  paintAuto();
}
$('#sm-draft').onchange = sendModeChange;
$('#sm-send').onchange = sendModeChange;

$('#send').onchange = () => {
  $('#sendwarn').hidden = !$('#send').checked;
  $('#b-drafts').textContent = $('#send').checked ? 'Написать и отправить' : 'Написать';
  paintAuto();
};

$('#b-reset').onclick = async () => {
  const who = accs.map(a => a.title).join(', ');
  if (!confirm(
      'Выйти из всех аккаунтов и очистить панель?\n\n' +
      (who ? `Выйдут: ${who}.\n\n` : '') +
      'Каждый аккаунт выйдет из Telegram ПО-НАСТОЯЩЕМУ: сессия будет отозвана, ' +
      'и вернуть аккаунт можно будет только новым входом — по QR или телефону. ' +
      'Залитый TDATA после этого работать не будет.\n\n' +
      'База, результаты, история сообщений и файлы сессий уедут в бэкап-папку ' +
      'рядом с панелью. Сводка за всё время останется в панели.\n\nПродолжить?')) return;
  const back = () => { $('#b-reset').disabled = false;
                       $('#b-reset').textContent = 'Выйти из всех аккаунтов и очистить'; };
  $('#b-reset').disabled = true; $('#b-reset').textContent = 'Выхожу из аккаунтов…';
  const r = await post('/api/reset', {});
  if (!r.ok) { alert(r.reason || 'не удалось'); back(); return; }
  // выход идёт по сети: ждём, пока панель отработает, но не вечно
  for (let i = 0; i < 240 && r.started; i++) {
    await new Promise(z => setTimeout(z, 1000));
    await tail();
    let s = null;
    try { s = await (await fetch('/api/state')).json(); } catch {}
    if (s && !s.wiping) break;
    if (i === 239) { alert('Выход затянулся — посмотри журнал.'); back(); return; }
  }
  alert('Готово — панель как новая. Сводка за всё время сохранена.');
  location.reload();
};

// импорт готовой сессии: заводим аккаунт с method:'file', затем шлём файл
const importFile = (accId, file) => {
  $('#status-t').textContent = `загружаю ${file.name}…`;
  return fetch('/api/accounts/import?account=' + encodeURIComponent(accId), {
    method: 'POST',
    headers: {'x-filename': encodeURIComponent(file.name), 'x-panel': '1'},
    body: file,
  }).then(r => r.json());
};

/**
 * Пакетный импорт: выбираешь сразу много файлов сессий (.zip TDATA или
 * .session) — панель заводит по аккаунту на файл и подключает их по очереди.
 * Имя берём из имени файла: там обычно номер. Прокси спрашиваем один раз на всех.
 */
/**
 * Открыть сразу несколько аккаунтов в одном Telegram Desktop — переключение
 * по аватарке слева внизу. Больше трёх в одну папку не влезает, это предел
 * самого десктопа. Как и в одиночном открытии, сначала пустой запуск под
 * прокси, потом уже с аккаунтами.
 */
$('#b-pack').onclick = async () => {
  const chosen = accs.filter(x => work.has(x.id) && accReady(x));
  if (!chosen.length) { alert('Отметь галочками аккаунты, которые открыть.'); return; }
  const take = chosen.slice(0, 3);
  const how = prompt(
    `Открыть в одном Telegram Desktop: ${take.map(x => x.title).join(', ')}` +
    (chosen.length > 3 ? `\n(отмечено ${chosen.length}, но десктоп держит только 3 — беру первые три)` : '') +
    `\n\n  1 — ПОДГОТОВИТЬ: пустой запуск, прописать прокси, закрыть.\n` +
    `  2 — ОТКРЫТЬ аккаунты (после шага 1).\n\nВведи 1 или 2:`, '1');
  if (how === null) return;
  const step = how.trim() === '2' ? 'open' : 'proxy';
  const r = await post('/api/accounts/desktop/pack', {ids: take.map(x => x.id), step});
  if (!r.ok) { alert(r.reason || 'не удалось'); return; }
  if (step === 'proxy') {
    alert('Десктоп открыт пустым — аккаунтов в нём нет.\n\n' +
      'Настройки → Продвинутые → Тип соединения → Свой прокси,\n' +
      `SOCKS5: ${take[0].proxyLabel}\n\nПотом закрой окно и нажми кнопку снова, выбрав 2.`);
    return;
  }
  alert(`Собираю папку на ${r.n} аккаунт(а) — это займёт несколько секунд,\n` +
    'ход виден в журнале. Десктоп откроется сам.\n\n' +
    'Переключение между аккаунтами — по аватарке слева внизу.\n' +
    'Не выходи там из аккаунтов: ключи общие с панелью.');
  state();
};

$('#b-bulk').onclick = async () => {
  const p = prompt('Через какой прокси будут ходить эти аккаунты?\n\n' +
    'Формат: host:port  либо  host:port:логин:пароль\n' +
    'Пустая строка — напрямую, со своего IP.\n\nОдин прокси на всю пачку.', '');
  if (p === null) return;
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.zip,.session'; inp.multiple = true;
  inp.onchange = async () => {
    const files = [...inp.files];
    if (!files.length) return;
    if (!confirm(`Залить ${files.length} сесси(й)?\n\nПанель заведёт по аккаунту на файл и подключит их по очереди.`)) return;
    let ok = 0; const bad = [];
    for (const f of files) {
      // имя: номер из имени файла, иначе само имя файла
      const digits = (f.name.match(/\d{10,15}/) || [])[0];
      const title = digits ? '+' + digits : f.name.replace(/\.(zip|session)$/i, '');
      $('#status-t').textContent = `завожу ${title}…`;
      const a = await post('/api/accounts/add', {title, proxy: p, method: 'file'});
      if (!a.ok) { bad.push(`${f.name}: ${a.reason || 'не завёлся'}`); continue; }
      const res = await importFile(a.id, f);
      if (res.ok) ok++; else { bad.push(`${f.name}: ${res.reason || 'не подключился'}`); await post('/api/accounts/remove', {id: a.id}); }
    }
    alert(`Залито: ${ok} из ${files.length}.` +
      (bad.length ? `\n\nНе вышло:\n${bad.join('\n')}` : '') +
      `\n\nПодключение идёт в фоне — смотри строки аккаунтов. У новых начнётся отлёжка на сутки.`);
    accsRaw = ''; loop();
  };
  inp.click();
};

$('#b-add').onclick = async () => {
  const t = prompt('Как назвать аккаунт? (например: Андрей, рабочий)', `Аккаунт ${accs.length + 1}`);
  if (t === null) return;
  const p = prompt(`Через какой прокси заходить «${t}»?\n\nФормат: host:port  либо  host:port:логин:пароль\nМожно с протоколом: socks5://host:port\n\nПустая строка — заходить напрямую, со своего IP.`, '');
  if (p === null) return;
  const how = prompt('Как подключить аккаунт?\n\n  1 — по QR-коду (вход телефоном)\n  2 — готовой сессией: TDATA (.zip) или .session (можно .zip с .session и .json)\n\nВведи 1 или 2:', '1');
  if (how === null) return;

  if (how.trim() === '2') {
    const r = await post('/api/accounts/add', {title: t, proxy: p, method: 'file'});
    if (!r.ok) { alert(r.reason || 'не удалось'); return; }
    if (r.warn) alert(r.warn);
    pick(r.id);
    // просим файл
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.zip,.session';
    inp.onchange = async () => {
      if (!inp.files[0]) { await post('/api/accounts/remove', {id: r.id}); loop(); return; }
      const res = await importFile(r.id, inp.files[0]);
      if (!res.ok) alert(res.reason || 'не удалось загрузить');
      else alert(`Файл принят как ${res.kind}. Подключаю сессию — смотри журнал внизу.`);
      loop();
    };
    inp.click();
    return;
  }

  const r = await post('/api/accounts/add', {title: t, proxy: p});
  if (!r.ok) { alert(r.reason || 'не удалось'); return; }
  if (r.warn) alert(r.warn);
  pick(r.id);
  alert('Откроется окно Telegram с QR-кодом — отсканируй его телефоном.\n(Telegram → Настройки → Устройства → Подключить устройство)');
  loop();
};

const base = async () => {
  try {
    const b = await (await fetch('/api/base')).json();
    $('#basenow').innerHTML = b.count
      ? `<b>${b.count}</b> номеров${b.file ? ` · из <b style="font-weight:600">${b.file}</b>` : ''}` +
        (b.at ? ` <span style="color:var(--mut)">· загружена ${new Date(b.at).toLocaleString('ru-RU')}</span>` : '')
      : '<span style="color:var(--mut)">базы пока нет — загрузи файл</span>';
    $('#peek').textContent = b.rows.length
      ? b.rows.map(r => `${r.phone}   звонков ${r.calls || 1}   ${(r.last_call || '').slice(0, 16)}`).join('\n')
        + (b.count > b.rows.length ? `\n… и ещё ${b.count - b.rows.length}` : '')
      : '';
  } catch {}
};

const upload = async (file) => {
  if (!file) return;
  baseLoading = true; paintStage(autoLast);
  $('#basenow').innerHTML = `<span style="color:var(--mut)">отправляю ${file.name}…</span>`;
  const r = await (await fetch('/api/upload', {
    method: 'POST',
    headers: {'x-filename': encodeURIComponent(file.name), 'x-panel': '1'},
    body: file,
  })).json();
  if (!r.ok) { alert(r.reason || 'не удалось загрузить'); base(); return; }
  state();
};

$('#drop').onclick = () => $('#file').click();
$('#file').onchange = (e) => upload(e.target.files[0]);
['dragenter','dragover'].forEach(ev => $('#drop').addEventListener(ev, (e) => {
  e.preventDefault(); $('#drop').classList.add('over');
}));
['dragleave','drop'].forEach(ev => $('#drop').addEventListener(ev, (e) => {
  e.preventDefault(); $('#drop').classList.remove('over');
}));
$('#drop').addEventListener('drop', (e) => upload(e.dataTransfer.files[0]));
// файл, брошенный мимо зоны, не должен открываться вкладкой поверх панели
['dragover','drop'].forEach(ev => document.addEventListener(ev, (e) => e.preventDefault()));

$('#b-load').onclick = async () => {
  const p = $('#basepath').value.trim();
  if (!p) { alert('Вставь путь к файлу базы'); return; }
  const r = await post('/api/loadbase', {path: p});
  if (!r.ok) alert(r.reason || 'не удалось'); else state();
};
$('#stop').onclick = async () => { await post('/api/stop'); state(); };
$('#logout').onclick = async () => { await post('/api/logout'); location.href = '/login'; };

const loop = async () => { await accounts(); await state(); await tail(); await qr(); await message(); await voice(); if (!busy) { await base(); await found(); await repliesList(); } };
loop(); setInterval(loop, 2000);
