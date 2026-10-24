// Проверка связи: что из нужного приложению доступно с этого устройства и где именно рвётся.
// Отличаем «нет интернета», «Cloudflare недоступен совсем» и «замедление» (маленькие ответы проходят,
// большие зависают — так ведут себя некоторые российские провайдеры с серверами Cloudflare).
import { SYNC_URL, OWN_PROXY } from './store.js';

const WORKER = SYNC_URL.replace(/\/sync$/, '');
const TIMEOUT = 10000;

async function text(r) {
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

const getSize = (n) => async (signal) => {
  const t = await fetch(`${WORKER}/ping?size=${n}&t=${Date.now()}`, { signal, cache: 'no-store' }).then(text);
  if (t.length !== n) throw new Error(`пришло ${t.length} из ${n} Б`);
  return `${n} Б`;
};

function randomText(n) {
  const a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (let i = 0; i < n; i++) s += a[bytes[i] % a.length];
  return s;
}

export function diagTests(syncCode) {
  return [
    { key: 'site', name: 'Сайт приложения (GitHub Pages)',
      run: (signal) => fetch(`sw.js?t=${Date.now()}`, { signal, cache: 'no-store' }).then(text).then((t) => `${t.length} Б`) },
    { key: 'github', name: 'GitHub API (запасная площадка)',
      run: (signal) => fetch('https://api.github.com/zen', { signal, cache: 'no-store' }).then(text).then(() => 'доступен') },
    { key: 'w100', name: 'Cloudflare: маленький ответ (100 Б)', run: getSize(100) },
    { key: 'w10k', name: 'Cloudflare: ответ 10 КБ', run: getSize(10000) },
    { key: 'w50k', name: 'Cloudflare: ответ 50 КБ', run: getSize(50000) },
    { key: 'w150k', name: 'Cloudflare: ответ 150 КБ', run: getSize(150000) },
    { key: 'wpost', name: 'Cloudflare: отправка 50 КБ',
      run: async (signal) => {
        const t = await fetch(`${WORKER}/ping`, { method: 'POST', body: randomText(50000), signal, headers: { 'Content-Type': 'text/plain' } }).then(text);
        if (t.trim() !== '50000') throw new Error(`сервер получил ${t} Б`);
        return '50000 Б';
      } },
    { key: 'sync', name: 'Синхронизация (чтение)',
      run: async (signal) => {
        if (!syncCode) return 'не подключена — пропуск';
        const r = await fetch(SYNC_URL, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: syncCode, peek: true }) });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
        return `персонажей: ${(data.characters || []).length}`;
      } },
    { key: 'proxy', name: 'Загрузка с dnd.su через прокси',
      run: async (signal) => {
        const url = OWN_PROXY.replace('{url}', encodeURIComponent('https://dnd.su/spells/205-fireball/'));
        const t = await fetch(url, { signal, cache: 'no-store' }).then(text);
        if (!t.includes('params')) throw new Error('неожиданный ответ');
        return `${t.length} Б`;
      } },
  ];
}

export async function runTest(test) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  const t0 = performance.now();
  try {
    const detail = await test.run(ctrl.signal);
    return { ok: true, ms: Math.round(performance.now() - t0), detail };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0), detail: e.name === 'AbortError' ? `нет ответа за ${TIMEOUT / 1000} с` : e.message || 'ошибка сети' };
  }
}

// Вывод простыми словами
export function verdict(res) {
  const ok = (k) => res[k]?.ok;
  if (!ok('site')) return 'Похоже, на устройстве нет интернета (не открывается даже сайт приложения).';
  const gh = ok('github') ? 'GitHub при этом доступен — синхронизацию можно перенести туда.' : 'GitHub тоже недоступен.';
  if (!ok('w100')) {
    return `Сервер на Cloudflare недоступен совсем — даже крошечный ответ не приходит. Так бывает, когда провайдер блокирует Cloudflare. Проверьте с VPN или в другой сети. ${gh}`;
  }
  // «замедление» — это когда большие запросы зависают или рвутся, а не когда сервер ответил ошибкой
  const hung = (k) => res[k] && !res[k].ok && !/^HTTP /.test(res[k].detail);
  const big = ['w10k', 'w50k', 'w150k', 'wpost'].filter(hung);
  const serverErr = ['w10k', 'w50k', 'w150k', 'wpost'].filter((k) => res[k] && !res[k].ok && /^HTTP /.test(res[k].detail));
  if (!big.length && serverErr.length) return 'Связь с Cloudflare есть, но сервер проверки ответил ошибкой — это ошибка у меня, пришлите отчёт.';
  if (big.length) {
    return `Маленькие ответы от Cloudflare проходят, а большие зависают — похоже на замедление Cloudflare у провайдера. Помогут VPN, другая сеть или передача данных маленькими порциями. ${gh}`;
  }
  if (res.sync && !ok('sync')) return 'Связь с Cloudflare в порядке, но синхронизация отвечает ошибкой — это уже ошибка в приложении, пришлите отчёт.';
  if (!ok('proxy')) return 'Связь с Cloudflare в порядке, но прокси dnd.su не ответил — возможно, dnd.su временно недоступен.';
  return 'Всё работает: Cloudflare доступен, большие ответы проходят.';
}

export function reportText(tests, res, appVersion) {
  const conn = navigator.connection ? `${navigator.connection.effectiveType || ''} ${navigator.connection.type || ''}`.trim() : '';
  return [
    `Проверка связи · ${new Date().toLocaleString('ru-RU')} · ${appVersion}`,
    navigator.userAgent,
    conn ? `Сеть: ${conn}` : '',
    '',
    ...tests.map((t) => {
      const r = res[t.key];
      return r ? `${r.ok ? '✓' : '✗'} ${t.name} — ${r.ms} мс — ${r.detail}` : `· ${t.name} — не проверено`;
    }),
    '',
    verdict(res),
  ].filter((l, i) => l || i > 2).join('\n');
}
