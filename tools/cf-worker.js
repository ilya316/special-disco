// Личный прокси для загрузки страниц dnd.su (Cloudflare Workers, бесплатно).
// Пропускает только dnd.su — не открытый прокси для всего интернета.
export default {
  async fetch(request) {
    const target = new URL(request.url).searchParams.get('url');
    const cors = { 'Access-Control-Allow-Origin': '*' };
    let u;
    try { u = new URL(target); } catch { return new Response('bad url', { status: 400, headers: cors }); }
    if (!/(^|\.)dnd\.su$/.test(u.hostname)) return new Response('forbidden', { status: 403, headers: cors });
    const r = await fetch(u.toString(), { headers: { 'User-Agent': 'Mozilla/5.0 (spellbook-pwa)' } });
    return new Response(await r.text(), {
      status: r.status,
      headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' },
    });
  },
};
