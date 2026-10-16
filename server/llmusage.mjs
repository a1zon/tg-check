/**
 * Сколько тратим на модель (OpenRouter): баланс и расход за сутки/7/30 дней.
 *
 * OpenRouter сам считает расход ключа (/api/v1/key: usage_daily/weekly/monthly)
 * и баланс аккаунта (/api/v1/credits) — раз в полчаса снимаем эти числа и
 * кладём в llm-usage.json рядом с кодом: его показывает карточка «Трафик и
 * прокси» во всех профилях. Ключ берём из того же .env, что и llm.py; в
 * командную строку curl он не попадает (заголовок уходит через stdin) — в
 * списке процессов его не видно. С IP сервера OpenRouter отвечает 403, поэтому
 * ходим через LLM_PROXY, как и сама модель.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const LLM_EVERY = 30 * 60_000;

export function makeLlmUsage({ dir, code }) {
  const FILE = path.join(code, 'llm-usage.json');

  function env() {
    for (const b of [dir, code]) {
      let text;
      try { text = fs.readFileSync(path.join(b, '.env'), 'utf8'); } catch { continue; }
      const e = {};
      for (const line of text.split('\n')) {
        const s = line.trim();
        const i = s.indexOf('=');
        if (!s || s.startsWith('#') || i < 1) continue;
        e[s.slice(0, i).trim()] = s.slice(i + 1).trim();
      }
      return e;
    }
    return {};
  }

  function get(url, key, proxy) {
    return new Promise((done) => {
      const c = spawn('curl', ['-s', '-m', '30', '-K', '-', url]);
      let out = '';
      c.stdout.on('data', (b) => { out += b; });
      c.on('error', () => done(null));
      c.on('close', () => { try { done(JSON.parse(out).data || null); } catch { done(null); } });
      const q = (v) => '"' + String(v).replace(/(["\\])/g, '\\$1') + '"';
      c.stdin.end(`header = ${q('Authorization: Bearer ' + key)}\n` + (proxy ? `proxy = ${q(proxy)}\n` : ''));
    });
  }

  /** Снять баланс и расход. Не OpenRouter или нет ключа — молча ничего. */
  async function snapshot() {
    const e = env();
    const base = String(e.LLM_BASE_URL || '').replace(/\/+$/, '');
    if (!/openrouter\.ai/.test(base) || !e.LLM_API_KEY) return null;
    const [cr, k] = await Promise.all([get(base + '/credits', e.LLM_API_KEY, e.LLM_PROXY),
                                       get(base + '/key', e.LLM_API_KEY, e.LLM_PROXY)]);
    if (!cr && !k) return null;
    const rec = {
      at: new Date().toISOString(),
      credits: cr?.total_credits ?? null,
      used: cr?.total_usage ?? k?.usage ?? null,
      day: k?.usage_daily ?? null, week: k?.usage_weekly ?? null, month: k?.usage_monthly ?? null,
      model: e.LLM_MODEL || '',
    };
    try {
      fs.writeFileSync(FILE + '.tmp', JSON.stringify(rec) + '\n');
      fs.renameSync(FILE + '.tmp', FILE);
    } catch {}
    return rec;
  }

  function summary() {
    try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; }
  }

  return { snapshot, summary };
}
