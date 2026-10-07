/**
 * Панель: весь клиентский код.
 *
 * Схема простая: раз в две секунды опрашиваем сервер (loop внизу файла) и
 * перерисовываем то, что изменилось. Никаких фреймворков — панель одна,
 * состояний немного, а так её правит любой, кто читает JavaScript.
 */

/*
 * КАРТА ФАЙЛА — экраны идут сверху вниз в том же порядке, что в панели.
 *
 *    123  АККАУНТЫ — строка аккаунта и кнопки при ней
 *    453  СОСТОЯНИЕ — счётчики, прогресс, кто чем занят
 *    562  ТЕКСТЫ ПИСЕМ, ЗЕРКАЛА, ГОЛОСОВОЕ
 *    764  РЕЗУЛЬТАТЫ — сводка, дни, ответы
 *   1049  ЗАПУСК РАССЫЛКИ
 *   1338  БАЗА ПОЛУЧАТЕЛЕЙ — файл с номерами и люди из чатов
 *   1476  ПРОГРЕВ — расписание, срок, смена IP
 *   1736  ОТКРЫТЬ АККАУНТ НА СВОЁМ КОМПЬЮТЕРЕ
 *   1888  ЕГРЮЛ
 *   1997  РЕЖИМЫ (боковая панель)
 *   2021  ОБЗОР + КАЛЬКУЛЯТОР МОЩНОСТИ
 *   2088  АВТОСКАН ЛИДОВ: интервал + чаты + следующий заход
 *   2140  СКАЧИВАНИЕ СПИСКОВ (по запросу, не вживую)
 *
 * Всё рисуется опросом раз в две секунды (см. loop внизу файла):
 * панель спрашивает сервер и перерисовывает только то, что изменилось.
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
  // «Подключение сессии — Вася» в бейдж не влезает и дёргает вёрстку;
  // при заливке показываем короткое и понятное
  a.busy && /Подключение сессии/i.test(a.busy) ? '<span class="st st-run">подключаю…</span>'
  : a.busy ? `<span class="st st-run">${esc(a.busy)}</span>`
  // карантин важнее «вошёл»: аккаунт живой, но писать с него нельзя,
  // и человек должен видеть это первым, а не искать в журнале
  : a.quarantine ? `<span class="st st-no">${a.spamUntil
      ? 'ограничен до ' + new Intl.DateTimeFormat('ru-RU', {timeZone: 'Asia/Yekaterinburg',
          day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'}).format(new Date(a.spamUntil))
      : a.spamKind === 'perm' ? 'ограничен бессрочно' : 'ограничен'}</span>`
  : accReady(a) ? '<span class="st st-ok">вошёл</span>'
  : a.profile && !a.session ? '<span class="st st-no">нужен перенос</span>'
  : '<span class="st st-no">не вошёл</span>';

/**
 * Прогрев одной строкой. Свежий аккаунт нельзя сразу гнать в рассылку —
 * панель ведёт его по расписанию, и человеку надо видеть, где он сейчас.
 */
/**
 * Остаток времени словами.
 *
 * Минуты округляем ПОСЛЕ разбора на часы, иначе 86 398 секунд превращаются
 * в «23 ч 60 мин»: минуты округлились до шестидесяти, а часы этого уже не
 * увидели. Мало того что неправда — строка дёргалась туда-сюда на каждом
 * опросе, и список аккаунтов мигал.
 */
const agoJs = (ts) => {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 90) return 'только что';
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} мин назад` : `${(m / 60).toFixed(1)} ч назад`;
};
const fmtLeftJs = (sec) => {
  const m = Math.max(1, Math.round(sec / 60));
  return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин`;
};
const warmLine = (a) => {
  if (a.quarantine) {
    // временно (с датой снятия) или бессрочно — это пишет сама панель по ответу SpamBot
    return `⛔ ограничен Telegram: ${esc((a.spam || '').slice(0, 140))}` +
      (a.spamKind === 'perm' ? ' · бессрочно, пока SpamBot не снимет'
        : ' · писать незнакомым нельзя, вернётся в рассылку сам');
  }
  const w = a.warm;
  if (!w) return '';
  if (w.resting) return `🌱 отлёжка нового аккаунта — ещё ${fmtLeftJs(w.restLeft)}: первые сутки после покупки ничего не делаем, иначе Telegram забанит`;
  // прогрев и рассылка — разные часы: первый считает возраст аккаунта, вторая —
  // дни, когда он реально пишет людям. Раньше они сливались в одну строку
  const warmTxt = w.day >= w.fullDay ? `прогрет (день ${w.day})` : `день ${w.day} из ${w.fullDay}`;
  const od = typeof a.outreachDay === 'number' ? a.outreachDay : -1;
  const outTxt = od < 0 ? 'ещё не писал — начнёт с 2 писем в день'
    : `день ${od + 1} · ${w.cap} писем в день`;
  const chk = a.checks ? ` · проверка номеров: ${a.checks.cap} в день` : '';
  const now = a.now ? `<br>▸ сейчас: ${esc(a.now)}` : '';
  return `🌱 прогрев: ${warmTxt}<br>✉️ рассылка: ${outTxt}${chk}${now}`;
};

/** Кто это на самом деле: имя, @ и телефон — их отдаёт Telegram при входе. */
// под крупным именем — номер, @ник и ярлык панели (если он не совпадает с номером)
const accSub = (a) => {
  const phone = a.phone ? '+' + String(a.phone).replace(/^\+/, '') : '';
  const parts = [phone, a.username ? '@' + a.username : '',
                 a.name && a.title && a.title !== phone ? a.title : ''].filter(Boolean);
  return parts.length ? parts.map(esc).join(' · ') : accWho(a);
};
const accWho = (a) => {
  const who = [a.name, a.username ? '@' + a.username : '', a.phone ? '+' + String(a.phone).replace(/^\+/, '') : '']
    .filter(Boolean).map(esc).join(' · ');
  if (who) return who;
  return accReady(a) ? 'данные аккаунта появятся после первой задачи'
       : a.profile && !a.session ? 'нажми «На Telethon» — вход перенесётся без QR'
       : 'войди по QR или залей готовую сессию';
};

let accsHtml = '';        // что уже нарисовано: лишний раз DOM не трогаем
/* ═══════════ АККАУНТЫ — строка аккаунта и кнопки при ней ═══════════ */


function paintAccounts() {
  if (!accs.length) {
    accsHtml = '';
    $('#accs').innerHTML = '<p style="color:var(--mut);margin:0">Пока ни одного — нажми «Добавить аккаунт».</p>';
    $('#acct').innerHTML = '<b style="color:var(--no)">аккаунт не подключён</b>';
    $('#s1').classList.remove('done');
    return;
  }
  if (!accs.some(a => a.id === cur)) cur = accs[0].id;
  if (work === null) work = new Set(accs.filter(accReady).map(a => a.id));
  // роль: прогрев идёт у всех, в рассылку попадают только отмеченные ✉️
  const rolePill = (a) => a.role === 'warm'
    ? `<span class="daypill rolepill warm" data-role="${a.id}" title="В рассылке не участвует, только греется. Нажми, чтобы перевести в рассылку">🌱 только прогрев</span>`
    : `<span class="daypill rolepill" data-role="${a.id}" title="Греется и участвует в рассылке. Нажми, чтобы оставить только прогрев">✉️ в рассылке</span>`;
  const html = accs.map(a => `
    <label class="acc ${work.has(a.id) ? 'sel' : ''}">
      <input type="checkbox" data-work="${a.id}" ${work.has(a.id) ? 'checked' : ''}
             ${accReady(a) ? '' : 'disabled'}>
      ${a.avatar ? `<img class="ava" src="/api/avatar?id=${a.id}&v=${a.avatar}" alt="">`
        : `<span class="ava ava-none">${esc((a.name || a.title || '?').trim().charAt(0).toUpperCase())}</span>`}
      <span class="nm"><b class="acc-name">${esc(a.name || a.title)} ${accBadge(a)}</b>
        <span class="${accReady(a) ? 'on' : 'off'}">${accSub(a)}</span>
        <span>${esc(a.proxyLabel)}${a.device ? ' · ' + esc(a.device) : ''} · написано ${a.sent} · черновиков ${a.drafts}${
          a.held ? ` · держит ${a.held}` : ''}</span>
        <span class="warm ${a.quarantine || (a.warm && a.warm.resting) ? 'off' : ''}">${warmLine(a)}</span>${
          accReady(a) ? rolePill(a) : ''}${
          a.warm && a.role !== 'warm' ? `<span class="daypill" data-cap="${a.id}" title="Сообщений в день этим аккаунтом — нажми, чтобы изменить">сегодня ${a.sentToday || 0} из ${a.warm.cap}/день${a.dailyCap ? ' ⚙' : ''}</span>` : ''}</span>
      <span class="accbtns">
        <button class="ghost mini" data-tgname="${a.id}" data-busy title="Имя и фамилия в самом Telegram">Имя</button>
        <button class="ghost mini" data-tguser="${a.id}" data-busy title="@username в Telegram">@ник</button>
        <button class="ghost mini" data-tgpic="${a.id}" data-busy title="Аватарка в Telegram">Аватар</button>
        <button class="ghost mini" data-desk="${a.id}" data-busy title="Открыть этот аккаунт в Telegram Desktop">Desktop</button>
        <button class="ghost mini" data-pckit="${a.id}" title="Скачать комплект и открыть аккаунт в Telegram Desktop на своём компьютере">На ПК</button>
        <button class="ghost mini" data-prx="${a.id}" data-busy title="Через какой прокси ходит">Прокси</button>
        <button class="ghost mini" data-chk="${a.id}" data-busy title="Проверить, жив ли прокси">IP</button>
        <button class="ghost mini" data-imp="${a.id}" data-busy title="Залить файл сессии">Сессия</button>${
        accReady(a) ? ''
          : `<button class="ghost mini" data-code="${a.id}" data-busy title="Войти по номеру: Telegram пришлёт код">Код</button>`}${
        a.profile && !a.session
          ? `<button class="ghost mini" data-mig="${a.id}" data-busy>На Telethon</button>` : ''}
        <button class="ghost mini" data-ren="${a.id}" data-busy title="Название только внутри панели">Ярлык</button>
        <button class="ghost mini" data-del="${a.id}" data-busy title="Удалить сессию с этого компьютера">Убрать</button>
      </span>
    </label>`).join('');

  /**
   * Перерисовываем, ТОЛЬКО если разметка изменилась.
   *
   * Список аккаунтов панель опрашивает каждые две секунды, а в ответе всегда
   * что-то дёргается — секунды до конца отлёжки, счётчик броней. Раньше это
   * означало полную перестройку разметки каждые две секунды: строки мигали,
   * и особенно противно это выглядело как раз при подключении аккаунтов,
   * когда смотреть на них и хочется.
   */
  if (html === accsHtml) return;
  accsHtml = html;
  $('#accs').innerHTML = html;

  // галочки — единственный выбор на всю панель: по нему идут и запуск, и ручные заходы
  document.querySelectorAll('#accs [data-work]').forEach(c => c.onchange = () => {
    c.checked ? work.add(c.dataset.work) : work.delete(c.dataset.work);
    accsRaw = ''; accsHtml = '';   // подсветка строки меняется — рисуем заново
    paintAccounts();
  });
  document.querySelectorAll('[data-ren]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.ren);
    const t = prompt('Как назвать этот аккаунт?', a.title);
    if (t) { await post('/api/accounts/rename', {id: a.id, title: t}); loop(); }
  });
  document.querySelectorAll('[data-role]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.role);
    const toSend = a.role === 'warm';
    if (toSend && a.warm && !a.warm.atMax &&
        !confirm(`«${a.name || a.title}» ещё не прогрет (день ${a.warm.day} из ${a.warm.fullDay}). Всё равно перевести в рассылку?`)) return;
    await post('/api/accounts/role', {id: a.id, role: toSend ? 'send' : 'warm'});
    loop();
  });
  // дневной лимит сообщений на конкретный аккаунт (для тестов). 0 — как у всех
  document.querySelectorAll('[data-cap]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.cap);
    const cur = a.dailyCap || 0;
    const v = prompt(`Сколько сообщений в сутки писать аккаунтом «${esc(a.title)}»?\n\n` +
      `Сейчас: ${cur > 0 ? cur + ' (свой лимит)' : 'как у всех (по прогреву)'}.\n` +
      `Введи число, или 0 — чтобы вернуть общий лимит.`, String(cur));
    if (v === null) return;
    await post('/api/accounts/dailycap', {id: a.id, cap: Math.max(0, parseInt(v) || 0)});
    loop();
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
  document.querySelectorAll('[data-pckit]').forEach(b => b.onclick = (e) => {
    e.preventDefault();
    openKit(b.dataset.pckit);
  });

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

  // вход по номеру для уже заведённого аккаунта: тот же способ, что и при
  // добавлении, — нужен, когда QR отсканировать нечем
  document.querySelectorAll('[data-code]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    const a = accs.find(x => x.id === b.dataset.code);
    const tel = prompt(`Номер аккаунта «${a.title}» — с кодом страны.\n\nНапример: +79001112233`,
                       a.phone ? '+' + String(a.phone).replace(/^\+/, '') : '+7');
    if (tel === null) return;
    const r = await post('/api/start', {name: 'code', account: a.id, phone: tel});
    if (!r.ok) { alert(r.reason || 'не удалось'); return; }
    alert('Telegram отправляет код. Как придёт — панель спросит его сама,\nздесь же, отдельным окном.');
    loop();
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

/**
 * Вход по номеру: код приходит человеку, а спросить его может только панель —
 * у скрипта, который её об этом просит, собеседника нет. Просьба помечена
 * номером захода, поэтому после неверного кода панель спросит снова, а на
 * ту же самую просьбу не переспросит.
 */
let asking = false;
const asked = new Map();
const askCode = async (a) => {
  if (asking || asked.get(a.id) === a.codeWait) return;
  const what = a.codeWait.replace(/\s*#\d+$/, '');
  const pass = !what.startsWith('код');
  asking = true;
  try {
    const v = prompt(`«${a.title}» — введи ${what}` + (pass ? ''
      : '\n\nTelegram присылает его в приложение на другом устройстве,\n' +
        'а если войти больше некуда — сообщением на номер.'), '');
    asked.set(a.id, a.codeWait);
    if (v === null || !v.trim()) return;
    const r = await post('/api/accounts/code',
      {account: a.id, code: pass ? '' : v, password: pass ? v : ''});
    if (!r.ok) alert(r.reason || 'не принято');
  } finally { asking = false; }
};

const accounts = async () => {
  try {
    const raw = await (await fetch('/api/accounts')).text();
    // перерисовываем только при изменениях: иначе список моргает каждые две секунды
    if (raw === accsRaw) return;
    accsRaw = raw; accs = JSON.parse(raw); paintAccounts();
    for (const a of accs) if (a.codeWait) askCode(a);
  } catch {}
};

/**
 * С каким списком получателей панель работает прямо сейчас.
 *
 * Раньше это была выпадашка посреди «Рассылки», и с нуля было не разобрать,
 * что к чему относится. Теперь список выбирает сама вкладка — но только в
 * момент запуска: открыть вкладку безопасно, идущий прогон от этого не
 * переключится (сервер и не даст — он откажет, пока прогон жив).
 */
async function useSet(want) {
  if (lastState && lastState.baseSet === want) return true;
  const r = await post('/api/base-set', {set: want});
  if (!r.ok) { alert(r.reason || 'не удалось переключить список получателей'); return false; }
  base(); state();
  return true;
}

function paintSetNow(s) {
  const chats = s.baseSet === 'chats';
  const p = $('#setnow-p'), c = $('#setnow-c');
  if (p) p.innerHTML = chats
    ? 'Панель сейчас работает <b>по чатам</b>. Нажмёшь «Запустить» здесь — переключится на номера.'
    : 'Панель сейчас работает <b>по номерам</b> — всё на этой вкладке про них.';
  if (c) c.innerHTML = chats
    ? 'Панель сейчас работает <b>по чатам</b> — всё на этой вкладке про них.'
    : 'Панель сейчас работает <b>по номерам</b>. Нажмёшь «Запустить по чатам» — переключится на чаты.';
}

// В каком профиле сидим. Рисуем один раз: имя профиля за жизнь вкладки
// не меняется — меняется только вместе со входом.
let whoamiDone = false;
function paintWhoami(s) {
  if (whoamiDone || !s.profile) return;
  whoamiDone = true;
  const box = $('#whoami');
  box.innerHTML = `<b>${esc(s.profile)}</b>` +
    (s.profileAdmin ? '<a href="/profiles">Профили</a>' : '') +
    '<a href="#" id="leave">Выйти в другой профиль</a>';
  box.hidden = false;
  $('#leave').onclick = async (e) => {
    e.preventDefault();
    await post('/api/logout', {});
    location.href = '/';
  };
}
/* ═══════════ СОСТОЯНИЕ — счётчики, прогресс, кто чем занят ═══════════ */


const state = async () => {
  try {
    const s = await (await fetch('/api/state')).json();
    lastState = s;
    paintWhoami(s);
    baseLoading = !!s.baseLoading;
    paintSetNow(s);
    for (const k of ['base','checked','found','sent']) $('#n-'+k).textContent = s[k];
    $('#n-replies').textContent = s.replies ?? 0;
    // «занят» теперь про выбранный аккаунт: остальные могут работать параллельно
    const anyRun = s.running.length > 0;
    busy = !!accs.find(a => a.id === cur)?.busy;
    $('#status-t').textContent = anyRun ? (s.doing || s.running).join(' · ') : 'сейчас ничего не выполняется';
    const held = (s.claims || []).reduce((n, c) => n + c.n, 0);
    $('#claims').textContent = held ? `в работе у аккаунтов: ${held} номеров` : '';
    const px = s.proxy || [];
    const dead = px.filter(p => !p.ok);
    const pst = $('#proxy-st');
    pst.textContent = dead.length
      ? `прокси лежит: ${dead[0].reason} — работа на паузе`
      : px.some(p => p.checked) ? `прокси в порядке${px.length === 1 && px[0].ip ? ` (IP ${px[0].ip})` : ''}` : '';
    pst.style.color = dead.length ? 'var(--no)' : 'var(--mut)';
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
    // кнопки аккаунта гасим, только пока занят ИМЕННО он: на время ручного
    // действия прогон сам встаёт на паузу, остальные аккаунты трогать можно
    document.querySelectorAll('button[data-busy]').forEach(b => {
      const id = Object.values(b.dataset).find(v => accs.some(a => a.id === v));
      b.disabled = id ? !!accs.find(a => a.id === id)?.busy : false;
    });
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
let noPhone = 0;          // сколько в очереди людей из чатов: у них нет даты звонка

/**
 * Как текст прочитает человек. Показываем оба случая, если получатели разные:
 * у человека из чата даты звонка не существует, и шаблон с {date} у него
 * превращается в «звонили .» — это видно только глазами, поэтому и показываем.
 */
// разворачивает {а|б|в} так же, как панель на сервере — для предпросмотра
const spin = (t) => {
  for (let i = 0; i < 100; i++) {
    const m = t.match(/\{([^{}]*)\}/);
    if (!m) break;
    let rep;
    if (m[1].includes('|')) { const o = m[1].split('|'); rep = o[Math.floor(Math.random()*o.length)]; }
    else rep = '\x00' + m[1] + '\x01';
    t = t.slice(0, m.index) + rep + t.slice(m.index + m[0].length);
  }
  return t.replaceAll('\x00','{').replaceAll('\x01','}');
};
const spinCount = (t) => {
  let n = 1; const re = /\{([^{}]*)\}/g; let m;
  while ((m = re.exec(t))) if (m[1].includes('|')) n *= m[1].split('|').length;
  return n;
};

const msgPreview = () => {
  const d = new Date();
  const date = `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
  const raw = $('#msg').value;
  const fill = (txt, name, day, nick) => spin(txt).replaceAll('{name}', name)
    .replaceAll('{date}', day).replaceAll('{username}', nick).trim();

  if (!raw.trim()) { $('#msg-prev').textContent = ''; $('#msg-warn').hidden = true; return; }
  const cnt = spinCount(raw);
  // три случайных варианта, как увидит человек из базы номеров
  let out = `непохожих писем: ${cnt}\n\nпримеры (как увидит человек):\n`;
  const seen = new Set();
  for (let k = 0; k < 12 && seen.size < 3; k++) seen.add(fill(raw, ', Евгения', date, '@evgenia'));
  out += [...seen].map(x => '· ' + x).join('\n');
  if (noPhone) out += `\n\nу человека из чата (без даты звонка):\n· ` + fill(raw, ', Сергей', '', '@sergey');
  $('#msg-prev').textContent = out;

  const dateHurts = noPhone && raw.includes('{date}');
  $('#msg-warn').hidden = !dateHurts;
  if (dateHurts) {
    $('#msg-warn').innerHTML = `В очереди <b>${noPhone}</b> человек без номера — они из чатов, ` +
      'и даты звонка у них нет. Подстановка <b>{date}</b> оставит у них пустое место. ' +
      'Убери <b>{date}</b> или заверни в вариант: <b>{ вы звонили {date}|здравствуйте}</b>.';
  }
};
/* ═══════════ ТЕКСТЫ ПИСЕМ, ЗЕРКАЛА, ГОЛОСОВОЕ ═══════════ */

const message = async () => {
  if (msgLoaded) return;
  try {
    const d = await (await fetch('/api/message')).json();
    $('#msg').value = (d.text || '').trim();
    // отдельный текст для собранных из чатов (может быть пустым)
    try { const dc = await (await fetch('/api/message?aud=chat')).json();
          if ($('#msg-chat')) $('#msg-chat').value = (dc.text || '').trim(); } catch {}
    msgLoaded = true;
    msgPreview();
  } catch {}
};

$('#msg-chat-save')?.addEventListener('click', async () => {
  const r = await post('/api/message?aud=chat', {text: $('#msg-chat').value});
  const note = $('#msg-chat-note');
  if (!r.ok) { if (note) note.textContent = r.reason || 'не удалось сохранить'; return; }
  $('#msg-chat').value = r.text;
  if (note) note.textContent = 'сохранено в ' + new Date().toTimeString().slice(0, 5) +
    ' · пусто — этой аудитории уйдёт общий текст';
});
$('#msg').oninput = msgPreview;

/**
 * Сборный текст. Грузим один раз — как и остальные поля с текстом: перечитывать
 * каждые две секунды нельзя, затрёт то, что человек печатает прямо сейчас.
 */
/**
 * Зеркала-субдомены. Грузим один раз, дальше только показываем статус.
 * Токен в браузер не возвращается — панель его не отдаёт.
 */
let mirLoaded = false;
const mirror = async () => {
  try {
    const m = await (await fetch('/api/mirror')).json();
    document.querySelectorAll('#mir-base-lbl, #mir-base-lbl2').forEach(e => e.textContent = m.base);
    if (!mirLoaded) {
      $('#mir-on').checked = !!m.on;
      $('#mir-mode').value = m.mode;
      $('#mir-base').value = m.base;
      $('#mir-lo').value = m.every[0]; $('#mir-hi').value = m.every[1];
      mirLoaded = true;
    }
    const left = m.on && m.next ? Math.max(0, m.next - (m.sent - m.sinceCount)) : 0;
    $('#mir-note').innerHTML = !m.on ? 'выключено'
      : m.url ? `сейчас: <b>${esc(m.url)}</b> · сменится через ${left} писем · всего адресов ${m.pool}`
      : 'включаю…';
    $('#mir-api-box').open = $('#mir-api-box').open || m.mode === 'api' && !m.hasToken;
  } catch {}
};
const mirSave = async (extra) => {
  const lo = +$('#mir-lo').value || 30, hi = Math.max(lo, +$('#mir-hi').value || 50);
  const body = {
    on: $('#mir-on').checked, mode: $('#mir-mode').value,
    base: $('#mir-base').value.trim(), every: [lo, hi], ...extra,
  };
  const tok = $('#mir-token').value.trim();
  if (tok) body.token = tok;
  if ($('#mir-proj').value.trim()) body.projectId = $('#mir-proj').value.trim();
  if ($('#mir-team').value.trim()) body.teamId = $('#mir-team').value.trim();
  const r = await post('/api/mirror', body);
  $('#mir-token').value = '';             // введённый токен из поля убираем
  mirLoaded = false; mirror();
  return r;
};
$('#mir-save').onclick = () => mirSave();
$('#mir-on').onchange = () => mirSave();
$('#mir-new').onclick = async () => {
  $('#mir-note').textContent = 'меняю адрес…';
  const r = await mirSave({forceNew: true});
  if (r && r.url) $('#mir-note').innerHTML = `новый адрес: <b>${esc(r.url)}</b>`;
};
$('#mir-test').onclick = async () => {
  await mirSave();                        // сохранить токен перед проверкой
  $('#mir-note').textContent = 'спрашиваю Vercel…';
  const r = await post('/api/mirror/test', {});
  $('#mir-note').textContent = r.ok ? `✓ Vercel на связи, доменов в проекте: ${r.count}` : `✗ ${r.reason}`;
};

/** Второе письмо воронки: текст и сколько людей уже дошли до второго шага. */
let msg2Loaded = false;
const funnel = async () => {
  try {
    const f = await (await fetch('/api/funnel')).json();
    if (!msg2Loaded) {
      const d = await (await fetch('/api/message?second=1')).json();
      $('#msg2').value = (d.text || '').trim();
      msg2Loaded = true;
    }
    $('#funnel-note').textContent = f.hasText
      ? `написано первых писем: ${f.wrote} · вторых ушло: ${f.answered}`
      : 'текст пока не сохранён — без него второй шаг не включится';
  } catch {}
};
$('#msg2-save').onclick = async () => {
  const r = await post('/api/message?second=1', {text: $('#msg2').value});
  if (!r.ok) { alert(r.reason || 'не удалось сохранить'); return; }
  $('#msg2').value = r.text;
  funnel();
};
$('#msg-save').onclick = async () => {
  const r = await post('/api/message', {text: $('#msg').value});
  if (!r.ok) { alert(r.reason || 'не удалось сохранить'); return; }
  $('#msg').value = r.text;
  msgPreview();
  const t = new Date().toTimeString().slice(0, 5);
  $('#msg-note').innerHTML = `сохранено в ${t} · подстановки: <b>{name}</b> — имя, ` +
    '<b>{date}</b> — дата звонка, <b>{username}</b> — ник в Telegram';
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

/** Вкладка «Результаты»: итоги по набору получателей, по дням и по аккаунтам. */
let resAt = 0;
/* ═══════════ РЕЗУЛЬТАТЫ — сводка, дни, ответы ═══════════ */

const resultsView = async (force) => {
  if (!force && Date.now() - resAt < 10_000) return;   // считать раз в 10 с достаточно
  resAt = Date.now();
  try {
    // вкладку открыли раньше, чем пришло состояние панели, — сначала узнаём,
    // по какому набору идёт рассылка, иначе показали бы «по номерам» по умолчанию
    if (!resSetTouched && !lastState) await state();
    if (!resSetTouched && lastState?.baseSet) $('#res-set').value = lastState.baseSet;
    const chats = $('#res-set').value === 'chats';
    const r = await (await fetch('/api/results?set=' + $('#res-set').value)).json();
    const t = r.totals || {};
    const n = (v) => nf(v || 0);
    const pct = (a, b) => (b ? ` (${Math.round((a || 0) / b * 100)}%)` : '');
    // у людей из чатов проверки номеров нет — показываем, сколько их собрано и сколько осталось
    $('#rs-checked').closest('.tile').querySelector('.tk').textContent = chats ? 'Людей из чатов' : 'Проверено номеров';
    $('#rs-checked').textContent = chats ? n(t.found) : n(t.checked);
    $('#rs-checked-sub').textContent = chats
      ? `осталось написать ${n(Math.max(0, (t.found || 0) - (t.sent || 0)))}`
      : `в Telegram ${n(t.found)} · давно не заходят ${n(t.idle)} · нет ${n(t.none)}`;
    $('#rs-sent').textContent = n(t.sent);
    $('#rs-sent-sub').textContent = `первых писем · пропущено неактивных ${n(t.skipped)}`;
    $('#rs-replied').textContent = n(t.replied) + pct(t.replied, t.sent);
    $('#rs-replied-sub').textContent = `да ${n(t.yes)} · нет ${n(t.no)} (🤝) · непонятно ${n(t.unclear)}`;
    $('#rs-second').textContent = n(t.second);
    $('#rs-second-sub').textContent = 'тем, кто ответил «да»';
    const cols = [...(chats ? [] : [['checked', 'проверено']]), ['sent', 'написали'], ['replied', 'ответили'],
                  ['yes', 'да'], ['no', 'нет'], ['unclear', 'непонятно'], ['second', 'ссылка']];
    const table = (rows, first, key) => rows.length
      ? `<tr><th>${first}</th>${cols.map(([, h]) => `<th>${h}</th>`).join('')}</tr>` +
        rows.map((x) => `<tr><td>${esc(x[key])}</td>${cols.map(([c]) => `<td>${x[c] || ''}</td>`).join('')}</tr>`).join('')
      : '<tr><td class="hint">пока пусто</td></tr>';
    $('#rs-days').innerHTML = table(r.days || [], 'день', 'day');
    $('#rs-accs').innerHTML = table(r.accounts || [], 'аккаунт', 'title');
    const ans = r.answers || [];
    $('#rs-answers').innerHTML = ans.length
      ? '<tr><th>когда</th><th>кто</th><th>аккаунт</th><th>как понято</th><th>ответ</th><th></th></tr>' +
        ans.map((x) => `<tr><td>${esc(x.at)}</td><td>${esc(x.who)}</td><td>${esc(x.account)}</td>
          <td>${x.verdict === 'yes' ? 'да' + (x.link ? ' · ссылка ушла' : '') : 'непонятно'}</td>
          <td class="ans-text">${esc(x.text || '—')}</td>
          <td>${x.accountId ? `<button class="ghost mini" data-ans-acc="${esc(x.accountId)}" title="Открыть этот аккаунт в Telegram Desktop на своём компьютере и ответить человеку">Ответить</button>` : ''}</td></tr>`).join('')
      : '<tr><td class="hint">пока нет</td></tr>';
    // «Ответить» — тот же комплект «На ПК», что в списке аккаунтов: панель на сервере, писать — со своего компьютера
    $('#rs-answers').querySelectorAll('[data-ans-acc]').forEach((b) => b.onclick = () => openKit(b.dataset.ansAcc));
  } catch {}
};
$('#res-set').onchange = () => { resSetTouched = true; resultsView(true); };
let resSetTouched = false;   // пока не выбрали руками — показываем тот набор, по которому идёт рассылка

/** Лента событий — что произошло, человеческим языком, свежие сверху. */
let eventsSeen = '';
const eventsFeed = async () => {
  try {
    const list = await (await fetch('/api/events?n=100')).json();
    const key = list.length ? list[0].t + ':' + list.length : '';
    if (key === eventsSeen) return;
    eventsSeen = key;
    $('#events').innerHTML = list.length ? list.map((e) => `<div class="ev${
        /⚠|⏳|■/.test(e.icon) ? ' ev-warn' : ''}">
      <span class="ev-t">${esc(e.time)}</span><span>${esc(e.icon)}</span>
      <span class="ev-who">${esc(e.who || 'панель')}</span><span>${esc(e.text)}</span></div>`).join('')
      : '<span class="ev-empty">пока тихо</span>';
  } catch {}
};

/** Кто ответил — списком, чтобы не лезть в журнал. */
// итог ответов — из тех же файлов, что и вкладка «Результаты», по текущему набору.
// Старая сводка (/api/replies) обновлялась только по кнопке и врала «никто не ответил»
let repliesAt = 0;
const repliesList = async () => {
  if (Date.now() - repliesAt < 15_000) return;
  repliesAt = Date.now();
  try {
    const r = await (await fetch('/api/results?set=' + (lastState?.baseSet || 'phones'))).json();
    const t = r.totals || {};
    $('#replies').innerHTML = t.replied
      ? `<div style="margin-top:10px"><b>Ответили ${t.replied}</b> из ${t.sent || 0}: ` +
        `да ${t.yes || 0} · нет ${t.no || 0} · непонятно ${t.unclear || 0} · ` +
        `вторых писем ушло ${t.second || 0}. Подробно — во вкладке «Результаты».</div>`
      : `<div style="color:var(--mut);margin-top:8px">${t.sent ? `написано ${t.sent}, пока никто не ответил` : 'писем ещё не было'}</div>`;
    // когда автопрогон последний раз заглядывал в диалоги — иначе «никто не ответил» нельзя отличить от «не проверяли»
    const ca = lastState?.repliesCheckedAt;
    $('#replies').insertAdjacentHTML('beforeend', `<div style="color:var(--mut);margin-top:4px;font-size:12px">${ca
      ? `ответы проверены в ${new Date(ca).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` +
        ` · за час проверено аккаунтов: ${lastState.repliesChecksHour || 0}`
      : 'ответы ещё ни разу не проверялись автопрогоном'}</div>`);
  } catch {}
};

const found = async () => {
  if (!$('#rows')) return;   // список найденных больше не выводим вживую — только файлом
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

/**
 * Форма запуска после обновления страницы — с теми настройками, с которыми
 * запускали в последний раз (а пока прогон идёт — это его настоящие). Раньше
 * галочки «второй шаг» и «по очереди» возвращались к умолчанию, и казалось,
 * что идущий прогон работает без них.
 */
let formRestored = false;
function restoreForm(f) {
  if (formRestored || !f) return;
  formRestored = true;
  const val = (id, v) => { if ($(id) && v !== undefined && v !== null && v !== '') $(id).value = v; };
  const chk = (id, v) => { if ($(id) && v !== undefined) $(id).checked = !!v; };
  val('#amode', f.mode);
  chk('#sm-send', f.send); chk('#sm-draft', !f.send); sendModeChange();
  chk('#funnel', f.funnel); chk('#serial', f.serial); chk('#warmon', f.warm !== false);
  if (!$('#rotate').value.trim()) val('#rotate', f.rotate);
  val('#rotwait', f.rotateWait);
  if (f.pause) val('#apause', Math.round(f.pause / 60));
  val('#limit', f.checkLimit); val('#delay', f.checkDelay);
  val('#dlimit', f.writeLimit); val('#ddelay', f.writeDelay); val('#ddelaymax', f.writeDelayMax);
  val('#dhold', f.hold); val('#dholdmax', f.holdMax);
}

function paintAuto(a) {
  autoLast = a = a || autoLast;
  restoreForm(a.form);
  const on = autoOn = !!a.on;
  const chosen = accs.filter(x => work && work.has(x.id) && accReady(x));

  // строки «кто чем занят» — только пока прогон идёт
  // строка аккаунта: имя · что делает (решает сервер) · сегодня проверено и написано.
  // Проверок бывает больше лимита — это сделанное до его введения, не превышение
  $('#autostate').innerHTML = !on ? '' : (a.accounts || []).map(x => `<div class="arow">
      <b title="${esc(x.phone || '')}">${esc(x.title)}</b>
      <span style="color:${x.stopped ? 'var(--no)' : x.working ? 'var(--ok)' : 'var(--mut)'}">${esc(x.status || '')}</span>
      <span class="w">${a.set !== 'chats' && x.checks ? `проверено сегодня ${x.checks.today} (лимит ${x.checks.cap}) · ` : ''}${
        `написано сегодня ${x.today ?? 0} из ${x.cap ?? '—'}`}</span>
    </div>`).join('');

  $('#b-auto').textContent = on ? 'Остановить' : 'Запустить';
  $('#b-auto').className = on ? 'danger big' : 'primary big';
  $('#b-auto').disabled = !chosen.length && !on;
  const cs = $('#cs-auto');
  if (cs) {
    cs.textContent = on ? 'Остановить' : 'Запустить по чатам';
    cs.className = on ? 'danger big' : 'primary big';
    cs.disabled = !chosen.length && !on;
    const note = $('#cs-note');
    if (note) note.textContent = chosen.length
      ? `работают: ${chosen.map(a => a.name || a.title).join(', ')}`
      : 'отметь аккаунты на вкладке «Аккаунты»';
  }
  for (const id of ['#amode','#apause','#delay','#ddelay','#ddelaymax','#dhold',
                    '#dholdmax','#limit','#dlimit',
                    '#sm-draft','#sm-send','#serial','#rotate','#rotwait'])
    if ($(id)) $(id).disabled = on;
  if (!on && $('#rotate').value.trim()) $('#serial').disabled = true;

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
  const st = (a.accounts || []).map(x => x.status || '');
  const has = (w) => st.some(x => x.startsWith(w));
  let head;
  if (a.hold > 0 && a.rotate) head = `Меняю IP на прокси — ещё ${a.hold} с`;
  else if (has('пишет людям')) head = 'Пишу людям';
  else if (has('проверяет номера')) head = 'Проверяю номера';
  else if (has('смотрит, кто ответил')) head = 'Смотрю, кто ответил';
  else if (has('пауза — ты')) head = 'Пауза — ты работаешь с аккаунтами';
  else if (st.length && st.every(x => /на сегодня всё|догревается|ограничен/.test(x))) head = 'Рассылка на сегодня всё — аккаунты догреваются, продолжим завтра';
  else if (has('ночь')) head = 'Ночь — письма ждут утра';
  else head = 'Пауза между заходами';
  const pct = s.base ? Math.round((s.checked / s.base) * 100) : 0;
  const sendWord = (a.voice ? 'голосовым, уходит сразу'
                 : a.send ? 'ОТПРАВЛЯЮ по-настоящему' : 'только черновики, никому не уходит')
                 + (a.serial ? (a.rotate ? ' · по очереди, со сменой IP' : ' · по очереди') : '');
  box.hidden = false;
  box.innerHTML =
    `<b>${head}</b> · режим: ${esc(sendWord)}<br>` +
    `<span style="color:var(--mut)">${a.set === 'chats'
      ? `по чатам: людей ${s.found} · написано ${s.sent} · осталось ${Math.max(0, s.found - s.sent)}`
      : `по номерам: проверено ${s.checked} из ${s.base} · найдено ${s.found} · написано ${s.sent}`}` +
    `${s.replies ? ` · ответили ${s.replies}` : ''}` +
    `</span><div class="bar"><i style="width:${a.set === 'chats' ? (s.found ? Math.round(s.sent / s.found * 100) : 0) : pct}%"></i></div>`;
}

async function startAuto(set) {
  if (autoOn) { await post('/api/auto', {on: false}); state(); return; }
  if (!await useSet(set)) return;
  const mode = $('#amode').value;
  const voice = mode !== 'check' && $('#voicemode').checked;
  const send = mode !== 'check' && !voice && $('#send').checked;
  const who = accs.filter(x => work.has(x.id) && accReady(x)).map(x => x.title);
  if (!who.length) { alert('Отметь хотя бы один вошедший аккаунт'); return; }
  const cap = Math.max(1, parseInt($('#daycap').value) || 15);
  if ($('#funnel').checked && !$('#msg2').value.trim()) {
    alert('Второй шаг включён, но текст второго письма пуст.\n\nНапиши его в шаге «Что напишем» и сохрани.');
    return;
  }
  if ((send || voice) && !confirm(
      `Запустить автопрогон от: ${who.join(', ')}?\n\n` +
      `Панель будет САМА ${voice ? 'отправлять голосовые' : 'отправлять сообщения'} людям, ` +
      `пачка за пачкой, пока база не кончится.\n` +
      `Не больше ${cap} в сутки на аккаунт (новые — меньше, по графику разгона).\n` +
      `\nОтозвать отправленное нельзя. Продолжить?`)) return;
  const r = await post('/api/auto', {
    on: true, mode, send, voice, warm: $('#warmon').checked,
    funnel: $('#funnel').checked,
    serial: $('#serial').checked, rotate: $('#rotate').value.trim(),
    rotateWait: +$('#rotwait').value || 10,
    accounts: [...work].filter(id => accReady(accs.find(a => a.id === id) || {})),
    pause: (+$('#apause').value || 40) * 60,     // поле в минутах, серверу — секунды
    checkLimit: $('#limit').value, checkDelay: $('#delay').value,
    writeLimit: $('#dlimit').value, writeDelay: $('#ddelay').value,
    writeDelayMax: $('#ddelaymax').value, hold: $('#dhold').value, holdMax: $('#dholdmax').value,
  });
  if (!r.ok && r.reason) alert(r.reason);
  state();
}
/* ═══════════ ЗАПУСК РАССЫЛКИ ═══════════ */


$('#b-auto').onclick = () => startAuto('phones');
// вкладка «по чатам»: тот же запуск, только список получателей свой
if ($('#cs-auto')) $('#cs-auto').onclick = () => startAuto('chats');
$('#amode').onchange = () => paintAuto();

/**
 * Мобильный прокси со сменой IP. Ссылку лучше проверить до запуска: иначе
 * о том, что она неверная, узнаешь в середине прогона.
 */
// один прокси на всех — ставим его всем аккаунтам разом, а не по одному
$('#b-bioall').onclick = async () => {
  const list = accs.filter(a => a.session);
  if (!list.length) { alert('Нет вошедших аккаунтов'); return; }
  const about = prompt(`Описание «о себе» — поставится ВСЕМ ${list.length} вошедшим аккаунтам.\n\nВведи текст (до 70 символов):`, '');
  if (about === null) return;
  if (!confirm(`Поставить это описание всем ${list.length} аккаунтам?`)) return;
  const r = await post('/api/accounts/profile-all', {about});
  if (r && r.ok === false) alert(r.reason || 'не вышло');
  state();
};
$('#b-picall').onclick = async () => {
  const list = accs.filter(a => a.session);
  if (!list.length) { alert('Нет вошедших аккаунтов'); return; }
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/jpeg,image/png,image/webp';
  inp.onchange = async () => {
    if (!inp.files[0]) return;
    if (!confirm(`Поставить эту аватарку всем ${list.length} вошедшим аккаунтам?`)) return;
    $('#status-t') && ($('#status-t').textContent = 'ставлю аватарку всем…');
    const res = await fetch('/api/accounts/photo-all', {
      method: 'POST',
      headers: {'x-filename': encodeURIComponent(inp.files[0].name), 'x-panel': '1'},
      body: inp.files[0],
    }).then(r => r.json()).catch(() => ({ok: false}));
    if (!res.ok) alert(res.reason || 'не удалось');
    state();
  };
  inp.click();
};
$('#b-prxall').onclick = async () => {
  const cur = accs.find(a => a.proxy)?.proxy || '';
  const p = prompt('Какой прокси поставить ВСЕМ аккаунтам?\n\n' +
    'Формат: host:port  либо  host:port:логин:пароль\n' +
    'Можно с протоколом: socks5://host:port\n\nПустая строка — снять прокси со всех.', cur);
  if (p === null) return;
  const r = await post('/api/accounts/proxy', {proxy: p, all: true});
  if (!r.ok) alert(r.reason || 'не у всех получилось');
  if (r.warn) alert(r.warn);
  accsRaw = ''; loop();
};

$('#b-rotate').onclick = async () => {
  const url = $('#rotate').value.trim();
  if (!url) { alert('Вставь ссылку смены IP из личного кабинета прокси'); return; }
  $('#rotnote').textContent = 'спрашиваю прокси…';
  const r = await post('/api/proxy/rotate', {url});
  $('#rotnote').textContent = r.ok
    ? `✓ прокси ответил: ${r.text || 'ок'}\nIP меняется — можно запускать`
    : `✗ ${r.reason}`;
};
// ротация без очереди бессмысленна: покажем это прямо галочкой
$('#rotate').oninput = () => {
  if ($('#rotate').value.trim()) { $('#serial').checked = true; $('#serial').disabled = true; }
  else $('#serial').disabled = false;
};

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
    delayMax: drafts ? $('#ddelaymax').value : undefined,
    hold: drafts ? $('#dhold').value : undefined,
    holdMax: drafts ? $('#dholdmax').value : undefined,
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
  // кнопку гасим сразу: чистка идёт минутами, и второе нажатие по ней —
  // самый лёгкий способ запутать и себя, и панель
  $('#b-reset').disabled = true; $('#b-reset').textContent = 'Останавливаю и выхожу…';
  $('#stop').disabled = true;
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
  $('#stop').disabled = false;
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

/**
 * Окно выбора файлов браузер открывает только «по горячему следу» клика.
 * prompt() этот след съедает: после него первый .click() по скрытому полю
 * молча ничего не делает, и список открывается лишь со второго нажатия.
 * Поэтому порядок обратный: сначала файлы, потом вопрос про прокси.
 */
$('#b-bulk').onclick = () => {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.zip,.session'; inp.multiple = true;
  inp.onchange = async () => {
    const files = [...inp.files];
    if (!files.length) return;
    const p = prompt('Через какой прокси будут ходить эти аккаунты?\n\n' +
      'Формат: host:port  либо  host:port:логин:пароль\n' +
      'Пустая строка — напрямую, со своего IP.\n\nОдин прокси на всю пачку.',
      accs.find(a => a.proxy)?.proxy || '');
    if (p === null) return;
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
  const how = prompt('Как подключить аккаунт?\n\n  1 — по QR-коду (вход телефоном)\n' +
    '  2 — готовой сессией: TDATA (.zip) или .session (можно .zip с .session и .json)\n' +
    '  3 — по номеру телефона: Telegram пришлёт код, панель спросит его тут же\n\nВведи 1, 2 или 3:', '1');
  if (how === null) return;

  if (how.trim() === '3') {
    const tel = prompt(`Номер аккаунта «${t}» — с кодом страны.\n\nНапример: +79001112233`, '+7');
    if (tel === null) return;
    const r = await post('/api/accounts/add', {title: t, proxy: p, method: 'code', phone: tel});
    if (!r.ok) { alert(r.reason || 'не удалось'); return; }
    if (r.warn) alert(r.warn);
    pick(r.id);
    alert('Telegram отправляет код. Как придёт — панель спросит его сама,\nздесь же, отдельным окном.');
    loop();
    return;
  }

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
/* ═══════════ БАЗА ПОЛУЧАТЕЛЕЙ — файл с номерами и люди из чатов ═══════════ */


const base = async () => {
  try {
    const b = await (await fetch('/api/base')).json();
    $('#basenow').innerHTML = b.count
      ? `<b>${b.count}</b> получателей${b.file ? ` · из <b style="font-weight:600">${b.file}</b>` : ''}` +
        (b.at ? ` <span style="color:var(--mut)">· загружена ${new Date(b.at).toLocaleString('ru-RU')}</span>` : '')
      : '<span style="color:var(--mut)">базы пока нет — загрузи файл</span>';
    $('#peek').textContent = b.rows.length
      ? b.rows.map(r => r.phone.startsWith('+')
          ? `${r.phone}   звонков ${r.calls || 1}   ${(r.last_call || '').slice(0, 16)}`
          : `${r.phone}   из чата`).join('\n')
        + (b.count > b.rows.length ? `\n… и ещё ${b.count - b.rows.length}` : '')
      : '';
  } catch {}
};

/**
 * Разбор чата: сколько людей собрано и из каких чатов. Это второй способ
 * набрать получателей — очередь у них дальше общая с проверенными номерами,
 * поэтому отдельной кнопки «написать им» не нужно.
 */
const members = async () => {
  try {
    const m = await (await fetch('/api/members')).json();
    // считаем не только разобранное чатами: готовый список @username из файла
    // ложится в ту же очередь, а в members.csv его нет
    const have = m.count || m.queued;
    $('#memnow').innerHTML = m.parsing
      ? '<span style="color:var(--mut)">иду по чатам, собираю участников…</span>'
      : have
        ? `<b>${have}</b> человек без номера` +
          `<span style="color:var(--mut)">${m.walked ? ` · из ${m.walked} чат(ов)` : ''}` +
          ` · в очереди ${m.queued - m.written} · написано ${m.written}</span>` +
          (m.solo
            ? `<span style="color:var(--mut);flex-basis:100%">` +
              `${m.queued - m.solo} напишет любой аккаунт (у них есть @username), ` +
              `${m.solo} — только тот, который их нашёл</span>`
            : '')
        : '<span style="color:var(--mut)">пока никого — сложи чаты в папку и нажми «Собрать из папки»</span>';
    $('#mempeek').textContent = m.rows.length
      ? m.rows.map(r => `${r.key}   ${r.name || ''}   ${r.chat ? '· ' + r.chat : ''}`).join('\n')
        + (m.chats.length > 1 ? '\n\nчаты: ' + m.chats.map(c => `${c.title} (${c.n})`).join(', ') : '')
      : '';
    noPhone = Math.max(0, m.queued - m.written);
    msgPreview();
    $('#s2').classList.toggle('done', have > 0);
    $('#b-memcsv').hidden = !m.count;   // выгружать нечего, пока не разбирали чаты
  } catch {}
};

/**
 * Разбор делает ОДИН аккаунт: делить тут нечего, а два подряд соберут одних
 * и тех же людей и зря потратят лимиты Telegram.
 */
const parser = () => accs.find(a => (work ? work.has(a.id) : false) && accReady(a) && !a.busy)
                  || accs.find(a => accReady(a) && !a.busy);

const startParse = async (opts) => {
  const who = parser();
  if (!who) { alert('Отметь хотя бы один вошедший и свободный аккаунт'); return; }
  const r = await post('/api/start',
    {name: 'parse', account: who.id, limit: $('#mlimit').value,
     onlyUser: $('#monly').checked, ...opts});
  if (!r.ok && r.reason) alert(r.reason);
  state();
};

$('#b-folder').onclick = () => {
  const folder = $('#mfolder').value.trim();
  if (!folder) { alert('Назови папку, которую панель должна обойти'); return; }
  startParse({folder, again: $('#magain').checked});
};
$('#b-list').onclick = () => {
  const list = $('#chatlist').value.trim();
  if (!list) { alert('Вставь ссылки на чаты — по одной в строке'); return; }
  const n = list.split('\n').filter(x => x.trim()).length;
  if ($('#mjoin').checked &&
      !confirm(`Аккаунт вступит в закрытые чаты по приглашениям, если ещё не в них.\n\nСписок: ${n} ссылок. Продолжить?`)) return;
  $('#list-note').textContent = `отправил ${n} ссылок в разбор…`;
  startParse({list, join: $('#mjoin').checked, again: $('#magain').checked});
};
$('#b-parse').onclick = () => {
  const chat = $('#chat').value.trim();
  if (!chat) { alert('Вставь ссылку на чат'); return; }
  const who = parser();
  if (who && $('#mjoin').checked &&
      !confirm(`«${who.title}» вступит в этот чат, если ещё не состоит в нём.\n\nПродолжить?`)) return;
  startParse({chat, join: $('#mjoin').checked});
};
$('#chat').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#b-parse').click(); });
$('#mfolder').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#b-folder').click(); });
$('#b-memcsv').onclick = () => { location.href = '/api/members/csv'; };

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

/**
 * Прогрев поведением: кто чем занят и что сказал SpamBot. Тут важнее всего
 * не числа, а понимание «панель жива и аккаунты чем-то заняты» — иначе
 * выглядит так, будто ничего не происходит, и хочется всё потрогать руками.
 */
let warmOn = false, warmRotDirty = false;
const fmtWarmWait = (s) => s <= 0 ? 'пора' : s < 90 ? `${s} с`
  : s < 5400 ? `${Math.round(s / 60)} мин` : `${(s / 3600).toFixed(1)} ч`;
/* ═══════════ ПРОГРЕВ — расписание, срок, смена IP ═══════════ */


const warmup = async () => {
  try {
    const w = await (await fetch('/api/warmup')).json();
    warmOn = !!w.on;
    if (document.activeElement !== $('#warm-rotate') && !warmRotDirty) $('#warm-rotate').value = w.rotate || '';
    if (document.activeElement !== $('#warm-rotwait')) $('#warm-rotwait').value = w.rotateWait || 10;
    if (w.warmDays && $('#warmdays') && document.activeElement !== $('#warmdays')) {
      $('#warmdays').value = w.warmDays;
    }
    if (w.plan && $('#cap-plan')) {
      $('#cap-plan').innerHTML = w.plan.map((st, i) => {
        const last = i === w.plan.length - 1;
        const val = st.cap === 0 ? 'отлёжка — не пишем' : `до ${st.cap} сообщений/день`;
        const label = st.day === 0 ? 'первые сутки' : `с ${st.day}-го дня`;
        return `<div class="cap-row"><span class="cap-day">${label}</span>` +
               `<span class="cap-val ${last ? 'max' : ''}">${val}${last ? ' · максимум' : ''}</span></div>`;
      }).join('');
    }
    if (w.checkMax && document.activeElement !== $('#checkcap')) $('#checkcap').value = w.checkMax;
    const maxNow = w.plan ? w.plan[w.plan.length - 1].cap : 15;
    if (document.activeElement !== $('#daycap')) $('#daycap').value = maxNow;
    $('#daycap-note').textContent = w.maxCap > 0 ? '' : '(сейчас стоит по умолчанию)';
    // при общем прокси без ссылки — предупреждаем прямо тут
    $('#warm-rot-note').textContent = w.alone && !w.rotate
      ? '⚠ прокси один на всех, а ссылка не задана — аккаунты будут греться с одного IP'
      : (w.rotate ? 'ссылка задана — IP меняется между аккаунтами' : '');
    $('#b-warm').textContent = warmOn ? 'Выключить прогрев' : 'Включить прогрев';
    $('#b-warm').className = warmOn ? 'ghost' : 'primary';
    $('#warm-state').textContent = warmOn
      ? `работает сам по ${w.accounts.length} аккаунт(ам): новые сначала лежат сутки, потом прогрев стартует автоматически с 1-го дня — тыкать ничего не надо`
      : 'выключен — нажми, чтобы аккаунты начали подписываться и читать';
    $('#warm-list').innerHTML = w.accounts.length ? w.accounts.map(a => {
      // человеческий статус: что с аккаунтом прямо сейчас
      let now = '';
      const nextTxt = a.dayLeft <= 0 ? 'на сегодня всё' : `дальше через ${fmtWarmWait(a.wait)}`;
      if (!warmOn) now = '';
      else if (a.busy) now = `● сейчас: ${a.act || 'работает'}`;
      else if (a.resting) now = `на отлёжке — старт через ${fmtWarmWait(a.restLeft)}`;
      else if (a.act) {
        const ago = a.actAt ? ` (${agoJs(a.actAt)})` : '';
        now = `${a.act}${ago} · ${nextTxt}`;
      }
      else if (a.dayLeft <= 0) now = 'на сегодня всё, продолжит завтра';
      else if (a.wait <= 0) now = 'ждёт очереди…';
      else now = `следующий заход через ${fmtWarmWait(a.wait)}`;
      const col = a.busy ? 'var(--ok)' : 'var(--mut)';
      // полоса прогресса прогрева
      const pct = Math.max(0, Math.min(100, a.pct || 0));
      const done = a.day >= a.fullDay;
      const barCls = a.resting ? 'rest' : (done ? 'full' : '');
      const barLbl = a.resting
        ? `отлёжка · старт через ${fmtWarmWait(a.restLeft)}`
        : done
          ? `прогрет · день ${a.day}`
          : `прогрев ${pct}% · день ${a.day} из ${a.fullDay}`;
      return `
      <div class="arow">
        <b>${esc(a.title)}</b>
        <span style="color:${a.spam && !a.spamOk ? 'var(--no)' : 'var(--mut)'};font-size:12px">${
          esc(a.spam ? a.spam.slice(0, 70) : 'SpamBot ещё не спрашивали')}${
          warmOn ? ` · сегодня осталось ${Math.max(0, a.dayLeft)}` : ''}</span>
        <span class="w" style="color:${col}">${esc(now)}</span>
        <div class="wbar ${barCls}">
          <div class="track"><i style="width:${pct}%"></i></div>
          <small>${esc(barLbl)}</small>
        </div>
      </div>`; }).join('') : '<p style="color:var(--mut);margin:0">Нет вошедших аккаунтов.</p>';
  } catch {}
};

// максимум проверок номеров в день — тоже одна на всю панель, сохраняем сразу
$('#checkcap').onchange = async () => {
  const cap = Math.max(1, parseInt($('#checkcap').value) || 50);
  await post('/api/checkcap', {cap});
  warmup();
};
// максимум в день — одна настройка на всю панель: сохраняем сразу, без кнопки
$('#daycap').onchange = async () => {
  const cap = Math.max(1, parseInt($('#daycap').value) || 15);
  await post('/api/dailycap', {cap});
  warmup();
};
$('#b-warm').onclick = async () => {
  if (!warmOn && !confirm(
      'Включить прогрев поведением?\n\n' +
      'Аккаунты будут сами подписываться на каналы, читать ленту, ставить реакции ' +
      'и переписываться между собой — понемногу и с большими паузами.\n\n' +
      'Это настоящие действия в Telegram от ваших аккаунтов. Продолжить?')) return;
  await post('/api/warmup', {on: !warmOn,
    rotate: $('#warm-rotate').value.trim(), rotateWait: +$('#warm-rotwait').value || 10});
  warmRotDirty = false;
  warmup();
};

// warmRotDirty объявлен выше
$('#warm-rotate').oninput = () => { warmRotDirty = true; };
// срок прогрева: за сколько дней аккаунт выходит на полный объём
if ($('#warmdays-save')) $('#warmdays-save').onclick = async () => {
  const days = Math.max(2, Math.min(21, parseInt($('#warmdays').value) || 7));
  const note = $('#warmdays-note');
  const r = await post('/api/warmup', {days});
  if (r && r.ok === false) { note.textContent = r.reason || 'не вышло'; return; }
  note.textContent = `сохранено: ${days} дн.`;
  setTimeout(() => { note.textContent = ''; }, 4000);
  warmup();
};

$('#warm-rot-save').onclick = async () => {
  const r = await post('/api/warmup', {rotate: $('#warm-rotate').value.trim(),
    rotateWait: +$('#warm-rotwait').value || 10});
  warmRotDirty = false;
  $('#warm-rot-note').textContent = r.ok
    ? (r.rotate ? 'сохранено — IP меняется между аккаунтами' : 'сохранено (ссылка пустая)')
    : (r.reason || 'не сохранилось');
};


/* ---------- горячие лиды из чатов ---------- */
let leadTpl = '', leadLink = '', leadTplLoaded = false;
function fillLeadTpl(tpl, p) {
  let t = spin(tpl || '');
  const first = (p.display_name || '').split(' ')[0] || '';
  const req = p.what_looking_for || 'квартиру';
  const map = {'{чат}': p.found_chat || '', '{chat}': p.found_chat || '',
    '{запрос}': req, '{request}': req, '{бюджет}': p.budget || '', '{budget}': p.budget || '',
    '{срок}': p.timeline || '', '{имя}': first, '{name}': first,
    '{LINK}': leadLink || '', '{ссылка}': leadLink || ''};
  for (const k in map) t = t.split(k).join(map[k]);
  return t.replace(/\(\s*\)/g, '').replace(/[ \t]+/g, ' ').trim();
}
function leadPrev() {
  const p = leadData.find(x => !x.message_sent) ||
    {display_name: 'Анна', found_chat: 'Мамы Академического',
     what_looking_for: '2-комнатную в районе Академический', budget: 'до 8 млн', timeline: 'к весне'};
  $('#lead-tpl-prev').textContent = 'Пример:\n' + fillLeadTpl($('#lead-tpl').value || leadTpl, p);
}
async function loadLeadTpl() {
  try {
    const r = await (await fetch('/api/leads/template')).json();
    leadTpl = r.template || ''; leadLink = r.link || '';
    if (document.activeElement !== $('#lead-tpl')) $('#lead-tpl').value = leadTpl;
    leadTplLoaded = true; leadPrev();
  } catch {}
}
$('#lead-tpl').addEventListener('input', () => { leadTpl = $('#lead-tpl').value; leadPrev(); leadsHtml = ''; });
$('#b-lead-tpl').onclick = async () => {
  await post('/api/leads/template', {template: $('#lead-tpl').value});
  $('#lead-tpl-note').textContent = 'шаблон сохранён';
  leadsHtml = ''; setTimeout(() => $('#lead-tpl-note').textContent = '', 2000);
};

let leadData = [], leadDraft = {}, leadsHtml = '';
const leadStatus = s => ({hot: '🔥 HOT', warm: '🟡 WARM', closed: '✔ закрыт'}[s] || s);
const leadKey = p => p.username ? '@' + p.username : 'id:' + p.user_id;

// оповещения о новых горячих лидах
let hotSeen, hotAlertReady = false, freshHi = new Set(), leadNotifyOn = false;
let baseTitle = document.title, titleTimer = 0;
try { hotSeen = new Set(JSON.parse(localStorage.getItem('hotSeen') || '[]')); } catch { hotSeen = new Set(); }
try { leadNotifyOn = localStorage.getItem('leadNotify') === '1'; } catch {}
const saveHotSeen = () => { try { localStorage.setItem('hotSeen', JSON.stringify([...hotSeen].slice(-500))); } catch {} };

function flashTitle(n) {
  try {
    document.title = `(🔥${n}) новый лид!`;
    clearTimeout(titleTimer);
    titleTimer = setTimeout(() => { document.title = baseTitle; }, 8000);
  } catch {}
}
function browserNotify(p) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const req = p.what_looking_for || 'квартиру';
    const said = (p.evidence && p.evidence[0]) ? '«' + p.evidence[0].quote + '»' : ('ищет ' + req);
    const nt = new Notification(`🔥 Горячий лид: ${p.display_name || 'аноним'}`,
      { body: said.slice(0, 160), tag: 'lead-' + p.user_id });
    nt.onclick = () => { window.focus(); };
  } catch {}
}
function showLeadAlert(n, p) {
  const el = $('#lead-alert'); if (!el) return;
  const req = p.what_looking_for || 'квартиру';
  el.innerHTML =
    `<div class="la-txt">🔥 <b>Новый горячий лид${n > 1 ? ` (ещё +${n - 1})` : ''}:</b> ` +
    `${esc(p.display_name || 'аноним')} ищет ${esc(req)}` +
    `${p.found_chat ? ` — из «${esc(p.found_chat)}»` : ''}. Напишите первым!</div>` +
    `<button class="la-go">Показать</button><button class="la-x" title="скрыть">×</button>`;
  el.hidden = false;
  el.querySelector('.la-go').onclick = () => {
    el.hidden = true;
    const c = document.querySelector(`.lead[data-u="${leadKey(p)}"]`) || document.querySelector('.lead');
    if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  el.querySelector('.la-x').onclick = () => { el.hidden = true; };
}

async function leads() {
  // не перетираем карточки, пока человек правит текст письма
  if (document.activeElement && document.activeElement.classList &&
      document.activeElement.classList.contains('lmsg')) return;
  let arr = [];
  try { arr = await (await fetch('/api/leads')).json(); } catch { return; }
  leadData = arr;
  if (!leadTplLoaded) loadLeadTpl();
  const unsent = arr.filter(p => !p.message_sent);
  const sent = arr.filter(p => p.message_sent && !p.skipped).length;
  const skipped = arr.filter(p => p.skipped).length;

  // новые горячие лиды — подсветить и оповестить (но не на самой первой загрузке)
  const hot = unsent.filter(p => p.status === 'hot');
  const freshNow = hot.filter(p => !hotSeen.has(String(p.user_id)));
  if (hotAlertReady && freshNow.length) {
    freshNow.forEach(p => freshHi.add(String(p.user_id)));
    showLeadAlert(freshNow.length, freshNow[0]);
    if (leadNotifyOn) browserNotify(freshNow[0]);
    flashTitle(freshNow.length);
    leadsHtml = '';
  }
  hot.forEach(p => hotSeen.add(String(p.user_id)));
  saveHotSeen();
  hotAlertReady = true;

  const hotN = hot.length;
  $('#lead-sum').innerHTML = arr.length
    ? `🔥 горячих: <b>${hotN}</b> · ждут отправки ${unsent.length} · написано ${sent} · скрыто ${skipped}`
    : 'Пока никого. Нажмите «Найти горячих лидов» — аккаунт должен состоять в чатах.';

  const html = unsent.map(p => {
    const key = leadKey(p);
    const meta = [p.what_looking_for, p.budget, p.timeline, p.financing].filter(Boolean).join(' · ');
    const ev = (p.evidence && p.evidence[0]) ? p.evidence[0].quote : '';
    const isFresh = freshHi.has(String(p.user_id));
    const msg = leadDraft[key] != null ? leadDraft[key]
      : (leadTpl ? fillLeadTpl(leadTpl, p) : ((p.outreach && p.outreach.variant_a) || ''));
    return `<div class="lead ${isFresh ? 'fresh' : ''}" data-u="${esc(key)}">
      <div class="lead-h"><b>${esc(p.display_name || 'без имени')}</b>
        <span class="lmut">${p.username ? '@' + esc(p.username) : 'без ника'}</span>
        ${isFresh ? '<span class="lbadge hot">🆕 новый</span>' : ''}
        <span class="lbadge ${p.status}">${leadStatus(p.status)} ${p.score}</span></div>
      <div class="lmeta">${esc(meta || 'запрос уточняется')} · нашли в «${esc(p.found_chat || '')}»</div>
      ${ev ? `<div class="lev">«${esc(ev)}»</div>` : ''}
      <textarea class="lmsg" data-u="${esc(key)}" spellcheck="false">${esc(msg)}</textarea>
      <div class="lbtns">
        <button class="softbtn mini" data-var="a" data-u="${esc(key)}">Текст A</button>
        <button class="softbtn mini" data-var="b" data-u="${esc(key)}">Текст B (вопрос)</button>
        <button class="primary mini" data-send="${esc(key)}">✍️ Написать</button>${
        p.by && accs.some(a => a.id === p.by)
          ? `<button class="softbtn mini" data-kit="${esc(p.by)}"
               title="Скачать комплект и продолжить переписку с этого аккаунта у себя на компьютере">🖥 Открыть на ПК</button>` : ''}
        <button class="softbtn mini" data-skip="${esc(key)}">Скрыть</button>
      </div></div>`;
  }).join('');
  if (html === leadsHtml) return;
  leadsHtml = html;
  $('#leads-list').innerHTML = html || (arr.length ? '<p class="hint" style="margin:0">Все лиды обработаны 👍</p>' : '');
}

/* ═══════════ ОТКРЫТЬ АККАУНТ НА СВОЁМ КОМПЬЮТЕРЕ ═══════════ */
/**
 * Панель живёт на сервере, а Telegram Desktop нужно открыть на компьютере
 * человека — из браузера процесс там не запустить. Поэтому кнопка отдаёт
 * архив: tdata аккаунта, мост до его прокси и один запускаемый файл.
 */
const KIT_STEPS = {
  mac: ['Распакуй архив туда, где папка останется жить, — например в «Документы». Из архива не запускать.',
        'Первый раз: правой кнопкой по <b>«Открыть аккаунт.command»</b> → «Открыть» → в окне ещё раз «Открыть». Дальше хватит двойного щелчка.',
        'Откроется ПУСТОЙ Telegram — без аккаунта. Подтверди <b>«Включить прокси»</b> и закрой окно: ⌘Q.',
        'Telegram откроется снова — уже с аккаунтом и через его прокси. Переписывайся как обычно, закрывай через ⌘Q.'],
  win: ['Распакуй папку из архива — из архива не запускать.',
        'Двойной щелчок по <b>«Открыть аккаунт.bat»</b>. Если SmartScreen ругнётся: «Подробнее» → «Выполнить в любом случае».',
        'Откроется ПУСТОЙ Telegram — без аккаунта. Подтверди <b>«Включить прокси»</b> и закрой окно.',
        'Telegram откроется снова — уже с аккаунтом и через его прокси.'],
  linux: ['Распакуй папку туда, где она останется жить.',
        'В терминале: <b>./открыть-аккаунт.sh</b> (или двойным щелчком, если файловый менеджер умеет).',
        'Откроется ПУСТОЙ Telegram — без аккаунта. Подтверди <b>«Включить прокси»</b> и закрой окно: Ctrl+Q.',
        'Telegram откроется снова — уже с аккаунтом и через его прокси.'],
};
const KIT_NEED = {
  mac: 'Нужны: Telegram Desktop (не клиент из App Store — тот не читает tdata) и Python 3.',
  win: 'Нужен Telegram Desktop с desktop.telegram.org.',
  linux: 'Нужны: Telegram Desktop и Python 3.',
};
let kitOs = /Win/i.test(navigator.userAgent) ? 'win'
          : /Mac/i.test(navigator.userAgent) ? 'mac' : 'linux';
let kitAcc = null;

function paintKit() {
  const a = kitAcc; if (!a) return;
  $('#kit-who').innerHTML = `Аккаунт <b>${esc(a.name || a.title)}</b> · выходит через ${esc(a.proxyLabel)}`;
  $('#kit-proxy-h').textContent = 'Пусто — поедет прокси аккаунта. Свой нужен, только если смотреть аккаунт с другого IP.';
  document.querySelectorAll('#kit-os button').forEach(b =>
    b.classList.toggle('on', b.dataset.os === kitOs));
  $('#kit-steps').innerHTML = KIT_STEPS[kitOs].map(t => `<li>${t}</li>`).join('')
    + `<li class="hint" style="list-style:none;margin-left:-20px">${KIT_NEED[kitOs]}</li>`;
}

function openKit(id) {
  kitAcc = accs.find(x => x.id === id);
  if (!kitAcc) { alert('Аккаунт не найден'); return; }
  $('#kit-note').textContent = '';
  $('#kit-proxy').value = '';
  paintKit();
  $('#kitdlg').showModal();
}

document.querySelectorAll('#kit-os button').forEach(b => b.onclick = () => {
  kitOs = b.dataset.os; paintKit();
});
$('#kit-close').onclick = () => $('#kitdlg').close();

$('#kit-go').onclick = async () => {
  if (!kitAcc) return;
  const note = $('#kit-note');
  const q = new URLSearchParams({id: kitAcc.id, os: kitOs});
  const px = $('#kit-proxy').value.trim();
  if (px) q.set('proxy', px);
  $('#kit-go').disabled = true;
  note.textContent = 'собираю комплект…';
  try {
    const r = await fetch('/api/accounts/kit?' + q);
    // ошибку сервер отдаёт как JSON, комплект — как архив
    if (!(r.headers.get('content-type') || '').includes('zip')) {
      const j = await r.json().catch(() => ({}));
      note.textContent = j.reason || 'не вышло собрать комплект';
      return;
    }
    const name = (r.headers.get('content-disposition') || '').match(/filename="(.+?)"/);
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = url; a.download = name ? name[1] : 'tg-kit.zip';
    a.click();
    URL.revokeObjectURL(url);
    note.textContent = 'скачано — дальше по шагам ниже';
  } catch (e) {
    note.textContent = 'не вышло: ' + e.message;
  } finally {
    $('#kit-go').disabled = false;
  }
};

// тумблер браузерных уведомлений о лидах
function paintNotifyBtn() {
  const b = $('#b-lead-notify'); if (!b) return;
  b.textContent = leadNotifyOn ? '🔔 Оповещения: вкл' : '🔔 Оповещения: выкл';
  b.classList.toggle('on', leadNotifyOn);
}
$('#b-lead-notify').onclick = async () => {
  if (!leadNotifyOn) {
    if ('Notification' in window && Notification.permission !== 'granted') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { alert('Браузер не дал разрешение на уведомления. Баннер в панели всё равно будет показываться.'); }
    }
    leadNotifyOn = true;
  } else leadNotifyOn = false;
  try { localStorage.setItem('leadNotify', leadNotifyOn ? '1' : '0'); } catch {}
  paintNotifyBtn();
};
paintNotifyBtn();

$('#leads-list').addEventListener('input', e => {
  if (e.target.classList.contains('lmsg')) leadDraft[e.target.dataset.u] = e.target.value;
});
$('#leads-list').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.kit) { openKit(b.dataset.kit); return; }
  const box = b.closest('.lead'); const key = box ? box.dataset.u : '';
  if (b.dataset.var) {
    const p = leadData.find(x => leadKey(x) === key);
    const t = (p && p.outreach && p.outreach['variant_' + b.dataset.var]) || '';
    leadDraft[key] = t; box.querySelector('.lmsg').value = t; return;
  }
  if (b.dataset.send) {
    const text = box.querySelector('.lmsg').value.trim();
    if (!text) { alert('Пустое сообщение'); return; }
    if (!confirm('Отправить это сообщение лиду сейчас?')) return;
    b.disabled = true; b.textContent = 'Отправляю…';
    const r = await post('/api/leads/send', {user: key, variant: 'a', text});
    if (r && r.ok === false && r.reason) alert(r.reason);
    delete leadDraft[key]; freshHi.delete(String(key).replace(/^id:/,'').replace(/^@/,'')); leadsHtml = '';
    setTimeout(leads, 1200);
  }
  if (b.dataset.skip) {
    if (!confirm('Скрыть лида? Больше писать ему не будем.')) return;
    await post('/api/leads/skip', {user: key});
    delete leadDraft[key]; leadsHtml = '';
    setTimeout(leads, 300);
  }
});

$('#b-leads').onclick = async () => {
  const who = parser();
  if (!who) { alert('Отметь хотя бы один вошедший и свободный аккаунт — он должен состоять в чатах'); return; }
  const folder = $('#lead-folder').value.trim() || 'chats';
  const r = await post('/api/start', {name: 'leads', account: who.id, folder,
    limit: $('#lead-limit').value, days: $('#lead-days').value});
  if (!r.ok && r.reason) alert(r.reason);
  state();
};
$('#b-leads-one').onclick = async () => {
  const who = parser();
  if (!who) { alert('Отметь аккаунт'); return; }
  const chat = $('#lead-chat').value.trim();
  if (!chat) { alert('Вставь ссылку на чат'); return; }
  const r = await post('/api/start', {name: 'leads', account: who.id, chat,
    limit: $('#lead-limit').value, days: $('#lead-days').value});
  if (!r.ok && r.reason) alert(r.reason);
  state();
};

/* ═══════════ ЕГРЮЛ ═══════════ */
/**
 * Таблица с ИНН живёт отдельно от базы номеров: сюда грузят список компаний,
 * панель спрашивает про них бота и достаёт человека. Найденный телефон сам
 * уезжает в базу номеров — дальше он идёт обычным путём.
 */
let egAccFilled = false;

function egStatus(r) {
  if (r.status === 'готово') return '<span class="lbadge hot">готово</span>';
  if (r.status === 'сбой') return '<span class="lbadge warm">сбой</span>';
  if (r.status === 'пусто') return '<span class="lbadge">нет данных</span>';
  return '<span class="lbadge">в очереди</span>';
}

async function egrulView() {
  let d;
  try { d = await (await fetch('/api/egrul')).json(); } catch { return; }

  // аккаунт-сборщик: список вошедших, заполняем один раз
  const sel = $('#eg-acc');
  if (sel && (!egAccFilled || sel.options.length <= 1) && accs.length) {
    sel.innerHTML = '<option value="">— выбери аккаунт-сборщик —</option>' +
      accs.filter(accReady).map(a =>
        `<option value="${a.id}">${esc(a.name || a.title)}</option>`).join('');
    if (d.account) sel.value = d.account;
    egAccFilled = true;
  }

  const btn = $('#eg-auto');
  if (btn) {
    btn.textContent = d.on ? '🤖 Сам: вкл' : '🤖 Сам: выкл';
    btn.classList.toggle('on', !!d.on);
  }

  const wait = d.nextAt && d.nextAt > Date.now()
    ? ` · следующий заход ${new Date(d.nextAt).toLocaleTimeString('ru', {hour: '2-digit', minute: '2-digit'})}` : '';
  $('#eg-sum').innerHTML = d.total
    ? `всего <b>${d.total}</b> · разобрано ${d.done} · без данных ${d.empty} · ` +
      `осталось ${d.left} · с телефоном <b>${d.phones}</b> · ` +
      `сегодня запросов ${d.today} из ${d.daily}` +
      (d.running ? ' · <b>идёт сбор</b>' : wait) +
      (d.note ? ` · ${esc(d.note)}` : '')
    : 'Таблицы пока нет — перетащи файл с ИНН.';

  const rows = d.rows || [];
  $('#eg-table').innerHTML = rows.length ? (
    '<tr><th>ИНН</th><th>компания</th><th>кто решает</th><th>телефон</th><th>статус</th></tr>' +
    rows.map(r => `<tr>
      <td>${esc(r.inn)}</td>
      <td>${esc((r.company || '').slice(0, 42)) || '<span class="no">—</span>'}</td>
      <td>${r.lpr ? esc(r.lpr) + (r.lpr_role ? `<br><span class="no">${esc(r.lpr_role)}</span>` : '') : '<span class="no">—</span>'}</td>
      <td>${r.phone ? esc(r.phone) : '<span class="no">—</span>'}</td>
      <td>${egStatus(r)}${r.note ? `<br><span class="no">${esc(r.note)}</span>` : ''}</td>
    </tr>`).join('')) : '';
}

// загрузка таблицы: перетаскиванием или щелчком
(() => {
  const drop = $('#eg-drop'), inp = $('#eg-file');
  if (!drop) return;
  const send = async (file) => {
    if (!file) return;
    $('#eg-sum').textContent = `читаю ${file.name}…`;
    const r = await fetch('/api/egrul/upload', {
      method: 'POST',
      headers: {'x-panel': '1', 'x-filename': encodeURIComponent(file.name)},
      body: file,
    }).then(x => x.json()).catch(() => ({ok: false}));
    if (!r.ok) alert(r.reason || 'не вышло принять файл');
    setTimeout(egrulView, 1500);
  };
  drop.onclick = () => inp.click();
  inp.onchange = () => send(inp.files[0]);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); send(e.dataTransfer.files[0]); };
})();

if ($('#eg-run')) $('#eg-run').onclick = async () => {
  const r = await post('/api/egrul/start', {account: $('#eg-acc').value});
  if (!r.ok) alert(r.reason || 'не вышло');
  setTimeout(egrulView, 800);
};
if ($('#eg-auto')) $('#eg-auto').onclick = async () => {
  const on = !$('#eg-auto').classList.contains('on');
  const r = await post('/api/egrul/auto', {on, account: $('#eg-acc').value});
  if (!r.ok) alert(r.reason || 'не вышло');
  egrulView();
};
if ($('#eg-csv')) $('#eg-csv').onclick = () => { location.href = '/api/egrul/csv'; };

// какой режим сейчас открыт — тяжёлые списки тянем только для него
function activeView() {
  const v = document.querySelector('.view.active');
  return v ? v.dataset.view : 'overview';
}
// Список найденных (30k строк) больше НЕ рисуем вживую — он вешал панель.
// Счётчики берём из /api/state, а полный список отдаём файлом по кнопке.
const loop = async () => {
  await accounts(); await state(); await tail(); await eventsFeed(); await qr(); await message(); await voice();
  if (busy) return;
  await base(); await leads(); await repliesList(); await warmup(); await funnel(); await mirror();
  if (activeView() === 'chatsend') await members();
  if (activeView() === 'results') await resultsView();
  if (activeView() === 'egrul') await egrulView();
};
loop(); setInterval(loop, 2000);

/* ═══════════ РЕЖИМЫ (боковая панель) ═══════════ */
const VIEW_TITLE = {
  overview: 'Обзор', accounts: 'Аккаунты', warmup: 'Прогрев', send: 'Рассылка по номерам',
  results: 'Результаты', chatsend: 'Рассылка по чатам', leads: 'Горячие лиды',
  egrul: 'ЕГРЮЛ', tools: 'Обслуживание',
};
function showView(name) {
  if (!VIEW_TITLE[name]) name = 'overview';
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === name));
  document.querySelectorAll('.nav-i').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
  const t = $('#view-title'); if (t) t.textContent = VIEW_TITLE[name];
  try { localStorage.setItem('tg-view', name); } catch {}
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  window.scrollTo(0, 0);
  if (name === 'results') resultsView(true);
}
document.querySelectorAll('.nav-i').forEach((a) => {
  a.onclick = (e) => { e.preventDefault(); showView(a.dataset.view); };
});
document.querySelectorAll('[data-goto]').forEach((b) => {
  b.onclick = () => showView(b.dataset.goto);
});
showView((location.hash || '').replace('#', '') || localStorage.getItem('tg-view') || 'overview');

/* ═══════════ ОБЗОР + КАЛЬКУЛЯТОР МОЩНОСТИ ═══════════ */
const nf = (n) => (n == null ? '—' : new Intl.NumberFormat('ru-RU').format(Math.round(n)));
// РАЗГОН РАССЫЛКИ по дню рассылки (не по возрасту прогрева): день 0 = первый день
// реальных сообщений. Аккаунт, который ещё не начинал слать, стартует с 2/день.
const OUTREACH_PLAN = [[0, 2], [2, 5], [4, 8], [6, 12], [9, 15]];
function outreachCap(outreachDay) {
  const d = outreachDay == null || outreachDay < 0 ? 0 : outreachDay;   // не начинали → как день 0
  let c = 2;
  for (const [pd, pc] of OUTREACH_PLAN) if (d >= pd) c = pc;
  return c;
}
// эффективный потолок дня: ручной override; иначе min(разгон рассылки, поведенческий
// прогрев, «максимум в день»)
function effCapDay(a, outreachDay, maxCap) {
  if (a.dailyCap && a.dailyCap > 0) return a.dailyCap;         // ручной предел (тест) — как есть
  const caps = [outreachCap(outreachDay)];
  if (a.warm && typeof a.warm.cap === 'number') caps.push(a.warm.cap);  // поведенческий потолок прогрева
  if (maxCap > 0) caps.push(maxCap);
  return Math.min(...caps);
}
const isReady = (a) => a.session && a.authed && a.role !== 'warm' && !(a.warm && a.warm.resting) && !a.quarantine;

function paintDash() {
  const total = accs.length;
  const entered = accs.filter((a) => a.session && a.authed).length;
  const resting = accs.filter((a) => a.session && a.authed && a.warm && a.warm.resting).length;
  const ready = accs.filter(isReady);
  const sentToday = accs.reduce((n, a) => n + (a.sentToday || 0), 0);
  const maxCap = Math.max(0, parseInt($('#daycap')?.value) || 15);
  const hot = (leadData || []).filter((p) => p.status === 'hot').length;
  const od = (a) => (typeof a.outreachDay === 'number' ? a.outreachDay : -1);

  // сегодня — по дню рассылки каждого аккаунта (не начинали → 2/день)
  const dayNow = ready.reduce((n, a) => n + effCapDay(a, od(a), maxCap), 0);
  // на плато — когда разгон дойдёт до конца (день рассылки ≥ 9)
  const dayMax = ready.reduce((n, a) => n + (a.dailyCap > 0 ? a.dailyCap : effCapDay(a, 9, maxCap)), 0);
  // за неделю — интеграл разгона: по каждому аккаунту суммируем его следующие 7 дней рассылки
  const week = ready.reduce((sum, a) => {
    const d0 = Math.max(0, od(a));
    let s = 0;
    for (let d = 0; d < 7; d++) s += (a.dailyCap > 0 ? a.dailyCap : effCapDay(a, d0 + d, maxCap));
    return sum + s;
  }, 0);

  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('#ov-accs', nf(total)); set('#ov-accs-sub', 'вошло ' + nf(entered));
  set('#ov-warm', nf(resting)); set('#ov-warm-sub', 'готовы к работе ' + nf(ready.length));
  set('#ov-today', nf(sentToday)); set('#ov-today-sub', 'потолок сегодня ' + nf(dayNow));
  set('#ov-hot', nf(hot)); set('#ov-hot-sub', 'автоскан ' + (asEvery ? 'каждые ' + asEvery : 'раз в 15 мин'));

  set('#calc-accs', nf(ready.length));
  set('#calc-day-now', nf(dayNow));
  set('#calc-day-max', nf(dayMax));
  set('#calc-week', nf(week));
}

// «а если бы аккаунтов было N по C сообщений»
function calcWhatIf() {
  const A = parseInt($('#calc-what-accs')?.value) || 0;
  const C = parseInt($('#calc-what-cap')?.value) || 0;
  const out = $('#calc-what-out'); if (!out) return;
  if (!A || !C) { out.textContent = ''; return; }
  out.textContent = `≈ ${nf(A * C)}/день · до ${nf(A * C * 7)}/неделю на плато`;
}
$('#calc-what-accs')?.addEventListener('input', calcWhatIf);
$('#calc-what-cap')?.addEventListener('input', calcWhatIf);

/* ═══════════ АВТОСКАН ЛИДОВ: интервал + чаты + следующий заход ═══════════ */
let asEvery = '', asNextMs = 0, asChats = [];
async function autoscanInfo() {
  try {
    const d = await (await fetch('/api/leads/autoscan')).json();
    asEvery = d.every || ''; asNextMs = d.nextMs || 0; asChats = d.chats || [];
    const line = $('#as-line');
    if (line) {
      let s = `каждые ${d.every} · ${d.count} ${plural(d.count, 'чат', 'чата', 'чатов')}`;
      if (asNextMs) {
        const left = Math.round((asNextMs - Date.now()) / 60000);
        if (left >= 0) s += ` · следующий заход ${left <= 0 ? 'вот-вот' : 'через ' + left + ' мин'}`;
      }
      line.textContent = s;
    }
    const box = $('#as-chats');
    if (box) box.textContent = asChats.length ? asChats.join('\n') : 'список чатов пуст (файл lead-chats.txt)';
    const dot = document.querySelector('#autoscan .as-dot');
    if (dot) dot.style.background = d.on ? '' : 'var(--mut)';
    $('#as-title').textContent = d.on ? 'Автопоиск включён' : 'Автопоиск выключен';
    if (!d.on) line.textContent = 'чаты не читаются · ' + `${d.count} ${plural(d.count, 'чат', 'чата', 'чатов')} в списке`;
    const sw = $('#as-switch');
    sw.hidden = false;
    sw.textContent = d.on ? 'Выключить автопоиск' : 'Включить автопоиск';
    sw.dataset.on = d.on ? '1' : '';
  } catch {}
}
$('#as-switch')?.addEventListener('click', async () => {
  const sw = $('#as-switch');
  const turnOn = !sw.dataset.on;
  if (!confirm(turnOn
    ? 'Включить автопоиск лидов? Раз в 15 минут один из аккаунтов a4–a9 будет читать чаты через общий прокси — в очереди с рассылкой и прогревом.'
    : 'Выключить автопоиск лидов? Чаты перестанут читаться по таймеру. «Найти горячих лидов сейчас» по-прежнему работает вручную.')) return;
  sw.disabled = true;
  try { await post('/api/leads/autoscan', { on: turnOn }); } catch {}
  sw.disabled = false;
  autoscanInfo();
});
function plural(n, a, b, c) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return a;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return b;
  return c;
}
$('#as-toggle')?.addEventListener('click', () => {
  const box = $('#as-chats'); if (box) box.hidden = !box.hidden;
});

// обновляем обзор/калькулятор часто (данные тянет основной loop), автоскан — редко
setInterval(paintDash, 1200); paintDash();
autoscanInfo(); setInterval(autoscanInfo, 60000);

/* ═══════════ СКАЧИВАНИЕ СПИСКОВ (по запросу, не вживую) ═══════════ */
$('#b-found-csv')?.addEventListener('click', () => { location.href = '/api/found/csv'; });
$('#b-leads-csv')?.addEventListener('click', () => { location.href = '/api/leads/csv'; });
