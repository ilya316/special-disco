// Загрузка страницы dnd.su через CORS-прокси (браузер не даёт читать чужие сайты напрямую).
import { OWN_PROXY, DEFAULT_PROXIES } from './store.js';
import { parseHtml } from './parser.js';

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

export function normalizeSpellUrl(url) {
  const bad = new Error('Нужна ссылка вида dnd.su/spells/… или next.dnd.su/spells/…');
  let u = url.trim();
  if (!u) throw bad;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    throw bad;
  }
  if (!/(^|\.)dnd\.su$/i.test(parsed.hostname) || !/^\/spells\/\d+/.test(parsed.pathname)) throw bad;
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString();
}

export async function fetchSpell(url, customProxy = '') {
  const target = normalizeSpellUrl(url);
  const proxies = [customProxy, OWN_PROXY, ...DEFAULT_PROXIES].filter(Boolean);
  const errors = [];
  for (const p of proxies) {
    const full = p.includes('{url}') ? p.replace('{url}', encodeURIComponent(target)) : p + encodeURIComponent(target);
    try {
      const html = await fetchWithTimeout(full, 8000);
      if (!html.includes('params')) throw new Error('неожиданный ответ');
      return parseHtml(html, target);
    } catch (e) {
      errors.push(`${new URL(full).hostname}: ${e.name === 'AbortError' ? 'таймаут' : e.message}`);
    }
  }
  const err = new Error('Не удалось загрузить страницу заклинания.');
  err.details = errors.join('; ');
  throw err;
}
