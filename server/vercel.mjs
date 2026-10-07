/**
 * Зеркала-субдомены на Vercel: под каждую пачку сообщений — свежий адрес,
 * чтобы одна и та же ссылка не светилась в тысяче писем.
 *
 * Два режима, оба ведут к одному: {LINK} в тексте становится
 * https://<случайное>.boldo-agency.ru
 *
 *   wildcard — на проекте Vercel один раз заведён *.boldo-agency.ru.
 *              Тогда ЛЮБОЙ субдомен работает сразу, без запросов к API,
 *              без ожидания SSL и без чистки. Панель просто придумывает имя.
 *              Это надёжнее и проще — рекомендуемый путь.
 *
 *   api      — как в ТЗ: каждый субдомен регистрируется отдельным запросом
 *              к Vercel. Гибче (видно каждый в кабинете), но медленнее:
 *              нужно ждать проверку DNS и выпуск сертификата, есть предел
 *              доменов на проект, и старые надо удалять.
 *
 * ВАЖНО про адрес API: правильный эндпоинт — api.vercel.com, а не vercel.com.
 * В присланном ТЗ был vercel.com{PROJECT_ID}/domains — так не работает.
 */

const API = 'https://api.vercel.com';

/** Случайное имя субдомена: строчные буквы и цифры, 5–8 знаков. */
export function randomName() {
  const words = ['kvartira', 'realt', 'prop', 'flat', 'dom', 'kv', 'estate', 'nedvizh'];
  const w = words[Math.floor(Math.random() * words.length)];
  const n = Math.floor(100 + Math.random() * 900);          // 3 цифры
  // иногда просто «prop7x», иногда «kvartira302» — не по одному шаблону
  const tail = Math.random() < 0.5 ? String(n)
    : Math.random().toString(36).slice(2, 2 + (2 + Math.floor(Math.random() * 3)));
  const name = (w + tail).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  return name.length >= 5 ? name : (name + '00').slice(0, 5);
}

const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});
const team = (teamId) => (teamId ? `?teamId=${encodeURIComponent(teamId)}` : '');

/**
 * Привязать субдомен к проекту. Возвращает {ok, verified, reason}.
 * verified=false — домен принят, но DNS/сертификат ещё не готовы.
 */
export async function registerDomain({ token, projectId, teamId }, fqdn) {
  try {
    const r = await fetch(`${API}/v10/projects/${projectId}/domains${team(teamId)}`, {
      method: 'POST', headers: headers(token),
      body: JSON.stringify({ name: fqdn }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, verified: data.verified !== false };
    // домен уже привязан к этому проекту — для нас это успех
    if (data?.error?.code === 'domain_already_in_use' || r.status === 409) {
      return { ok: true, verified: true, reason: 'уже был' };
    }
    return { ok: false, reason: data?.error?.message || `Vercel ответил ${r.status}` };
  } catch (e) {
    return { ok: false, reason: e.name === 'TimeoutError'
      ? 'Vercel не ответил за 20 секунд' : (e.message || 'не достучались до Vercel') };
  }
}

/** Готов ли домен (DNS проверен, сертификат выпущен). */
export async function domainReady({ token, projectId, teamId }, fqdn) {
  try {
    const r = await fetch(`${API}/v9/projects/${projectId}/domains/${fqdn}${team(teamId)}`, {
      headers: headers(token), signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return false;
    const d = await r.json().catch(() => ({}));
    return d.verified === true;
  } catch { return false; }
}

/** Отвязать субдомен от проекта. */
export async function deleteDomain({ token, projectId, teamId }, fqdn) {
  try {
    const r = await fetch(`${API}/v9/projects/${projectId}/domains/${fqdn}${team(teamId)}`, {
      method: 'DELETE', headers: headers(token), signal: AbortSignal.timeout(15000),
    });
    return { ok: r.ok || r.status === 404 };   // 404 — уже удалён, тоже хорошо
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** Проверка токена: список доменов проекта. Возвращает {ok, count, reason}. */
export async function ping({ token, projectId, teamId }) {
  try {
    const r = await fetch(`${API}/v9/projects/${projectId}/domains${team(teamId)}`, {
      headers: headers(token), signal: AbortSignal.timeout(15000),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, count: (d.domains || []).length };
    return { ok: false, reason: d?.error?.message || `Vercel ответил ${r.status}` };
  } catch (e) {
    return { ok: false, reason: e.message || 'не достучались до Vercel' };
  }
}
