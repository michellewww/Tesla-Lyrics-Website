// A tiny relay for QQ Music lyrics, to run as a Cloudflare Worker (free plan is plenty).
//
// Why it exists: QQ Music's servers don't let a web page on another site read their
// replies, so the lyrics page can't ask them directly. This Worker asks on the page's
// behalf and passes the reply back. It only ever talks to the two QQ Music addresses
// below, holds no keys or accounts, and stores nothing.
//
// Setup (see README, "QQ Music backup"): paste this file into a new Worker, deploy, and
// put the Worker's address in public/js/config.js as `lyricsRelay`.
//
//   GET /search?q=<title and artist>   → QQ Music's song search reply (JSON)
//   GET /lyric?mid=<song mid>          → QQ Music's lyrics reply (JSON; lyric is base64)

// Sites allowed to use this relay. Empty = any site. To keep it to your own page, list
// its origin, e.g. ['https://yourname.github.io', 'http://127.0.0.1:5173'].
const ALLOWED_ORIGINS = [];

const SEARCH_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const LYRIC_URL = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg';
const QQ_HEADERS = { Referer: 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' };

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = !ALLOWED_ORIGINS.length ? '*' : ALLOWED_ORIGINS.includes(origin) ? origin : '';
  return allowed ? { 'Access-Control-Allow-Origin': allowed, Vary: 'Origin' } : {};
}

function reply(request, status, body, extra = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(request), ...extra },
  });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...corsHeaders(request), 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } });
    }
    if (request.method !== 'GET') return reply(request, 405, { error: 'GET only' });

    const url = new URL(request.url);
    let upstream;
    if (url.pathname.endsWith('/search')) {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q || q.length > 200) return reply(request, 400, { error: 'q is required (up to 200 characters)' });
      upstream = fetch(SEARCH_URL, {
        method: 'POST',
        headers: { ...QQ_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comm: { ct: '19', cv: '1859', uin: '0' },
          req: {
            method: 'DoSearchForQQMusicDesktop',
            module: 'music.search.SearchCgiService',
            param: { grp: 1, num_per_page: 10, page_num: 1, query: q, search_type: 0 },
          },
        }),
      });
    } else if (url.pathname.endsWith('/lyric')) {
      const mid = url.searchParams.get('mid') || '';
      if (!/^[A-Za-z0-9]{6,24}$/.test(mid)) return reply(request, 400, { error: 'mid is required' });
      upstream = fetch(`${LYRIC_URL}?songmid=${mid}&format=json&g_tk=5381`, { headers: QQ_HEADERS });
    } else {
      return reply(request, 404, { error: 'Use /search?q= or /lyric?mid=' });
    }

    try {
      const res = await upstream;
      const text = await res.text();
      if (!res.ok) return reply(request, 502, { error: `QQ Music answered ${res.status}` });
      // Lyrics and search results rarely change: let browsers and Cloudflare reuse them.
      return reply(request, 200, text, { 'Cache-Control': 'public, max-age=86400' });
    } catch (e) {
      return reply(request, 502, { error: 'QQ Music could not be reached' });
    }
  },
};
