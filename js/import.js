// Загрузка страницы dnd.su через CORS-прокси (браузер не даёт читать чужие сайты напрямую).
import { OWN_PROXY, DEFAULT_PROXIES } from './store.js';
import { parseHtml } from './parser.js';
import { parseCreatureHtml } from './creature.js';

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

// kind: 'spells' или 'bestiary'
export function normalizeDndUrl(url, kind = 'spells') {
  const bad = new Error(`Нужна ссылка вида dnd.su/${kind}/… или next.dnd.su/${kind}/…`);
  let u = url.trim();
  if (!u) throw bad;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    throw bad;
  }
  if (!/(^|\.)dnd\.su$/i.test(parsed.hostname) || !new RegExp(`^/${kind}/\\d+`).test(parsed.pathname)) throw bad;
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString();
}
export const normalizeSpellUrl = (url) => normalizeDndUrl(url, 'spells');

async function fetchPage(target, customProxy, what) {
  const proxies = [customProxy, OWN_PROXY, ...DEFAULT_PROXIES].filter(Boolean);
  const errors = [];
  for (const p of proxies) {
    const full = p.includes('{url}') ? p.replace('{url}', encodeURIComponent(target)) : p + encodeURIComponent(target);
    try {
      // свой прокси отвечает быстро, но на медленной связи ему нужно больше времени
      const html = await fetchWithTimeout(full, p === OWN_PROXY || p === customProxy ? 20000 : 8000);
      if (!html.includes('params')) throw new Error('неожиданный ответ');
      return html;
    } catch (e) {
      errors.push(`${new URL(full).hostname}: ${e.name === 'AbortError' ? 'таймаут' : e.message}`);
    }
  }
  const err = new Error(`Не удалось загрузить страницу ${what}.`);
  err.details = errors.join('; ');
  if (errors.every((e) => /таймаут|Failed to fetch|NetworkError/i.test(e))) {
    err.details += '. Похоже, нет связи с посредником (так бывает у некоторых провайдеров с серверами Cloudflare): попробуйте другую сеть (Wi-Fi / мобильный интернет) или вставьте текст со страницы.';
  }
  throw err;
}

export async function fetchSpell(url, customProxy = '') {
  const target = normalizeSpellUrl(url);
  return parseHtml(await fetchPage(target, customProxy, 'заклинания'), target);
}

export async function fetchCreature(url, customProxy = '') {
  const target = normalizeDndUrl(url, 'bestiary');
  return parseCreatureHtml(await fetchPage(target, customProxy, 'существа'), target);
}
