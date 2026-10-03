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
  tableReady = true;
}

// Объединение по персонажам: побеждает более свежий updatedAt; удаление (deleted[id]) побеждает более старые правки.
function merge(a, b) {
  const deleted = { ...a.deleted };
  for (const [id, t] of Object.entries(b.deleted || {})) deleted[id] = Math.max(deleted[id] || 0, Number(t) || 0);
  const byId = new Map();
  for (const c of [...(a.characters || []), ...(b.characters || [])]) {
    if (!c || typeof c.id !== 'string') continue;
    const cur = byId.get(c.id);
    if (!cur || (Number(c.updatedAt) || 0) > (Number(cur.updatedAt) || 0)) byId.set(c.id, c);
  }
  const characters = [...byId.values()].filter((c) => !(deleted[c.id] >= (Number(c.updatedAt) || 0)));
  return { characters, deleted };
}

async function sync(request, env, cors) {
  if (!env.DB) return json({ error: 'База не подключена' }, 500, cors);
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405, cors);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: 'Слишком много данных' }, 413, cors);
  const body = JSON.parse(text);
  if (!CODE_RE.test(body.code || '')) return json({ error: 'Неверный код синхронизации' }, 400, cors);

  await ensureTable(env.DB);
  const row = await env.DB.prepare('SELECT data FROM states WHERE code = ?').bind(body.code).first();
  const stored = row ? JSON.parse(row.data) : { characters: [], deleted: {} };
  const merged = merge(stored, { characters: body.characters || [], deleted: body.deleted || {} });
  const out = JSON.stringify(merged);
  if (!row || out !== row.data) {
    await env.DB.prepare('INSERT INTO states (code, data, updated) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET data = excluded.data, updated = excluded.updated')
      .bind(body.code, out, Date.now()).run();
  }
  return json({ ...merged, existed: !!row }, 200, cors);
}
