// Личный прокси для загрузки страниц dnd.su (Cloudflare Workers, бесплатно).
// Пропускает только страницы dnd.su и только для своих сайтов — это не открытый прокси.
const ALLOWED_ORIGINS = [
  'https://ilya316.github.io',
  'http://localhost:8765',
];

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Vary': 'Origin',
    };
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return new Response('forbidden origin', { status: 403, headers: cors });
    }

    let target;
    try {
      target = new URL(new URL(request.url).searchParams.get('url'));
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
  },
};
