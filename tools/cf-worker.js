// Cloudflare Worker для «Книги заклинаний»:
//  GET  /?url=https://dnd.su/spells/…  — прокси страниц заклинаний dnd.su
//  POST /sync                          — синхронизация персонажей между устройствами (база D1)
// Отвечает только своим сайтам — это не открытый прокси.
const ALLOWED_ORIGINS = [
  'https://ilya316.github.io',
  'http://localhost:8765',
];

const CODE_RE = /^[a-z0-9]{4}(-[a-z0-9]{4}){3,7}$/;
const MAX_BODY = 2_000_000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return new Response('forbidden origin', { status: 403, headers: cors });
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    try {
      if (url.pathname === '/sync') return await sync(request, env, cors);
      return await proxy(url, cors);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500, cors);
    }
  },
};

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function proxy(url, cors) {
  let target;
  try {
    target = new URL(url.searchParams.get('url'));
  } catch {
    return new Response('bad url', { status: 400, headers: cors });
  }
  if (!/(^|\.)dnd\.su$/.test(target.hostname) || !target.pathname.startsWith('/spells/')) {
    return new Response('only dnd.su spells', { status: 403, headers: cors });
  }
  const r = await fetch(target.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36',
      'Accept-Language': 'ru-RU,ru;q=0.9',
    },
  });
  return new Response(await r.text(), {
    status: r.status,
    headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

let tableReady = false;
async function ensureTable(db) {
  if (tableReady) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS states (code TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)').run();
  try {
    await db.prepare('ALTER TABLE states ADD COLUMN rev INTEGER NOT NULL DEFAULT 0').run();
  } catch {} // колонка уже есть
  await db.prepare('CREATE TABLE IF NOT EXISTS history (code TEXT NOT NULL, rev INTEGER NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (code, rev))').run();
  tableReady = true;
}

const HISTORY_KEEP = 50;

function summary(data) {
  const chars = (data.characters || []).map((c) => ({
    name: c.name || '—',
    spells: (c.spells || []).length,
    items: (c.items || []).length,
  }));
  return { chars };
}

// Протокол (v14+): клиент сам объединяет данные (трёхстороннее слияние) и записывает результат,
// только если с момента чтения никто не успел записать новую версию (rev). Старые версии приложения
// объединяли персонажей целиком и теряли данные — их запросы отклоняются.
async function sync(request, env, cors) {
  if (!env.DB) return json({ error: 'База не подключена' }, 500, cors);
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405, cors);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: 'Слишком много данных' }, 413, cors);
  const body = JSON.parse(text);
  if (!CODE_RE.test(body.code || '')) return json({ error: 'Неверный код синхронизации' }, 400, cors);

  await ensureTable(env.DB);
  const db = env.DB;
  const row = await db.prepare('SELECT data, rev FROM states WHERE code = ?').bind(body.code).first();
  const stored = row ? JSON.parse(row.data) : { characters: [] };
  const rev = row ? row.rev : 0;

  if (body.peek) {
    return json({ characters: stored.characters || [], rev, existed: !!row }, 200, cors);
  }

  if (body.put) {
    if (!Array.isArray(body.characters)) return json({ error: 'Нет данных' }, 400, cors);
    if (body.baseRev !== rev) {
      return json({ conflict: true, characters: stored.characters || [], rev, existed: !!row }, 409, cors);
    }
    const now = Date.now();
    const out = JSON.stringify({ characters: body.characters });
    const next = rev + 1;
    let res;
    if (row) {
      res = await db.prepare('UPDATE states SET data = ?, updated = ?, rev = ? WHERE code = ? AND rev = ?')
        .bind(out, now, next, body.code, rev).run();
    } else {
      res = await db.prepare('INSERT INTO states (code, data, updated, rev) VALUES (?, ?, ?, ?) ON CONFLICT(code) DO NOTHING')
        .bind(body.code, out, now, next).run();
    }
    if (!res.meta.changes) {
      const fresh = await db.prepare('SELECT data, rev FROM states WHERE code = ?').bind(body.code).first();
      return json({ conflict: true, characters: JSON.parse(fresh.data).characters || [], rev: fresh.rev, existed: true }, 409, cors);
    }
    await db.batch([
      // предыдущая версия тоже должна быть в истории (данные, записанные до появления истории)
      ...(row ? [db.prepare('INSERT OR IGNORE INTO history (code, rev, data, created) VALUES (?, ?, ?, ?)').bind(body.code, rev, row.data, now - 1)] : []),
      db.prepare('INSERT OR REPLACE INTO history (code, rev, data, created) VALUES (?, ?, ?, ?)').bind(body.code, next, out, now),
      db.prepare('DELETE FROM history WHERE code = ? AND rev <= ?').bind(body.code, next - HISTORY_KEEP),
    ]);
    return json({ ok: true, rev: next }, 200, cors);
  }

  if (body.history) {
    const { results } = await db.prepare('SELECT rev, created, data FROM history WHERE code = ? ORDER BY rev DESC LIMIT ?')
      .bind(body.code, HISTORY_KEEP).all();
    return json({ versions: results.map((r) => ({ rev: r.rev, created: r.created, ...summary(JSON.parse(r.data)) })) }, 200, cors);
  }

  if (body.historyRev) {
    const r = await db.prepare('SELECT data, created FROM history WHERE code = ? AND rev = ?').bind(body.code, body.historyRev).first();
    if (!r) return json({ error: 'Версия не найдена' }, 404, cors);
    return json({ characters: JSON.parse(r.data).characters || [], created: r.created }, 200, cors);
  }

  return json({ error: 'Обновите приложение: закройте его полностью и откройте снова.', outdated: true }, 426, cors);
}
