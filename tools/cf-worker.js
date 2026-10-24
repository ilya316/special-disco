// Cloudflare Worker для «Книги заклинаний»:
//  GET  /?url=https://dnd.su/spells/… или /bestiary/…  — прокси страниц заклинаний и бестиария dnd.su
//  POST /sync                          — синхронизация персонажей между устройствами (база D1)
//  GET/POST /ping                      — проверка связи (ответ/приём заданного размера)
//  /sync: blob/upload                  — чтение и запись сжатыми кусками по 6 КБ (обход «замедления» Cloudflare)
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
      if (url.pathname === '/ping') return await ping(request, url, cors);
      return await proxy(url, cors);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500, cors);
    }
  },
};

// Проверка связи из приложения: GET /ping?size=N — ответ из N байт, POST /ping — размер принятого тела
async function ping(request, url, cors) {
  const headers = { ...cors, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' };
  if (request.method === 'POST') {
    const body = await request.text();
    return new Response(String(body.length), { headers });
  }
  const size = Math.max(1, Math.min(200000, parseInt(url.searchParams.get('size'), 10) || 100));
  // случайные символы — такой ответ не сжимается при передаче, и его размер честный
  const bytes = new Uint8Array(Math.ceil(size * 0.75) + 3);
  for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536)); // не больше 64 КБ за раз
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return new Response(btoa(bin).slice(0, size), { headers: { ...headers, 'Content-Encoding': 'identity' } });
}

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
  if (!/(^|\.)dnd\.su$/.test(target.hostname) || !/^\/(spells|bestiary)\//.test(target.pathname)) {
    return new Response('only dnd.su spells and bestiary', { status: 403, headers: cors });
  }
  const r = await fetch(target.toString(), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36',
      'Accept-Language': 'ru-RU,ru;q=0.9',
    },
  });
  const html = await r.text();
  return new Response(trimPage(html), {
    status: r.status,
    headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8', 'X-Original-Size': String(html.length) },
  });
}

// Отдаём только заголовок и блок с описанием (ul.params) — в 10–20 раз меньше всей страницы.
// Маленькие ответы надёжнее проходят через медленные и «застревающие» соединения.
function trimPage(html) {
  const t0 = html.indexOf('<h2 class="card-title"');
  const t1 = t0 >= 0 ? html.indexOf('</h2>', t0) : -1;
  const p0 = html.search(/<ul class=['"]params/);
  if (t1 < 0 || p0 < 0) return html;
  // конец ul.params с учётом вложенных списков
  const re = /<\/?ul[\s>]/gi;
  re.lastIndex = p0 + 3;
  let depth = 1;
  let end = -1;
  for (let m; (m = re.exec(html));) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) {
      end = m.index + 5;
      break;
    }
  }
  if (end < 0) return html;
  return '<!doctype html><html><body><div class="card__header">' + html.slice(t0, t1 + 5) + '</div>'
    + '<div class="card__body">' + html.slice(p0, end) + '</div></body></html>';
}

let tableReady = false;
async function ensureTable(db) {
  if (tableReady) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS states (code TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)').run();
  try {
    await db.prepare('ALTER TABLE states ADD COLUMN rev INTEGER NOT NULL DEFAULT 0').run();
  } catch {} // колонка уже есть
  await db.prepare('CREATE TABLE IF NOT EXISTS history (code TEXT NOT NULL, rev INTEGER NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (code, rev))').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS uploads (id TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (id, idx))').run();
  tableReady = true;
}

/* ---------- порционная передача ----------
   Некоторые провайдеры «замедляют» Cloudflare: соединение зависает, если за него передано больше ~16 КБ.
   Поэтому большие данные можно читать и писать сжатыми (gzip → base64) кусками по CHUNK символов,
   каждый — отдельным маленьким запросом. */
const CHUNK = 6000;

async function gzipB64(str) {
  const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function gunzipB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

// сжатые данные последней запрошенной версии — чтобы не сжимать заново на каждый кусок
const packedCache = new Map();
async function packed(key, str) {
  if (!packedCache.has(key)) {
    packedCache.clear();
    packedCache.set(key, await gzipB64(str));
  }
  return packedCache.get(key);
}

function blobPart(z, index, extra, cors) {
  const chunks = Math.ceil(z.length / CHUNK);
  if (index === undefined || index === null) return json({ ...extra, chunks, length: z.length }, 200, cors);
  return json({ ...extra, index, data: z.slice(index * CHUNK, (index + 1) * CHUNK) }, 200, cors);
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

  // чтение кусками: без index — сведения (сколько кусков), с index — кусок сжатых данных
  if (body.blob === 'state') {
    if (!row) return json({ existed: false, rev: 0, chunks: 0, length: 0 }, 200, cors);
    if (body.rev !== undefined && body.rev !== rev) return json({ conflict: true, rev }, 409, cors);
    return blobPart(await packed(`${body.code}:s:${rev}`, row.data), body.index, { existed: true, rev }, cors);
  }
  if (body.blob === 'history') {
    const h = await db.prepare('SELECT data, created FROM history WHERE code = ? AND rev = ?').bind(body.code, body.rev).first();
    if (!h) return json({ error: 'Версия не найдена' }, 404, cors);
    return blobPart(await packed(`${body.code}:h:${body.rev}`, h.data), body.index, { rev: body.rev, created: h.created }, cors);
  }

  // запись кусками: сначала куски (upload), потом put с uploadId
  if (body.upload) {
    if (!/^[a-z0-9-]{8,40}$/.test(body.upload) || typeof body.data !== 'string' || body.data.length > CHUNK * 2) {
      return json({ error: 'Неверный кусок' }, 400, cors);
    }
    const now = Date.now();
    await db.batch([
      db.prepare('INSERT OR REPLACE INTO uploads (id, idx, data, created) VALUES (?, ?, ?, ?)').bind(body.upload, body.index | 0, body.data, now),
      db.prepare('DELETE FROM uploads WHERE created < ?').bind(now - 3600e3),
    ]);
    return json({ ok: true }, 200, cors);
  }

  if (body.put) {
    let characters = body.characters;
    if (body.uploadId) {
      const { results } = await db.prepare('SELECT idx, data FROM uploads WHERE id = ? ORDER BY idx').bind(body.uploadId).all();
      if (results.length !== body.total || results.some((r, i) => r.idx !== i)) {
        return json({ error: `Получено кусков ${results.length} из ${body.total}` }, 400, cors);
      }
      characters = JSON.parse(await gunzipB64(results.map((r) => r.data).join(''))).characters;
      await db.prepare('DELETE FROM uploads WHERE id = ?').bind(body.uploadId).run();
    }
    if (!Array.isArray(characters)) return json({ error: 'Нет данных' }, 400, cors);
    body.characters = characters;
    // lite: не присылать данные в ответе о конфликте (клиент перечитает кусками)
    const conflictBody = (chars, r) => (body.lite ? { conflict: true, rev: r, existed: true } : { conflict: true, characters: chars, rev: r, existed: true });
    if (body.baseRev !== rev) {
      return json({ ...conflictBody(stored.characters || [], rev), existed: !!row }, 409, cors);
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
      return json(conflictBody(JSON.parse(fresh.data).characters || [], fresh.rev), 409, cors);
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
