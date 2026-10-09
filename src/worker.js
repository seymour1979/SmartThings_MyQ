// Rhythm Log backend: receives daily Apple Health numbers from an iPhone Shortcut
// and hands them back to the app. Everything else is served as static files.
const FIELDS = {
  stp: [0, 200000],   // steps
  exm: [0, 1440],     // exercise minutes
  sh: [0, 24],        // hours asleep
  ss: [0, 100],       // sleep score, if the shortcut can supply one
  rhr: [20, 250],     // resting heart rate
  hrv: [0, 500],      // heart rate variability (ms)
};
const KEEP_DAYS = 400;
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function authorized(request, env) {
  const secret = env.INGEST_TOKEN;
  if (!secret || secret.length < 16) return 'not_configured';
  const h = request.headers.get('authorization') || '';
  const given = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  return same(given, secret) ? 'ok' : 'denied';
}

async function load(env) {
  const raw = await env.HEALTH.get('all');
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    const auth = authorized(request, env);
    if (auth === 'not_configured') return json({ error: 'INGEST_TOKEN secret is not set (16+ characters).' }, 503);
    if (auth !== 'ok') return json({ error: 'Invalid sync code.' }, 401);

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return json({ days: await load(env) });
    }

    if (url.pathname === '/api/ingest' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Body must be JSON.' }, 400); }
      const date = String(body.date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
        return json({ error: 'date must look like 2026-10-09.' }, 400);
      }
      const clean = {};
      for (const [f, [lo, hi]] of Object.entries(FIELDS)) {
        const raw = body[f];
        if (raw === undefined || raw === null || raw === '') continue;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < lo || n > hi) continue;
        clean[f] = f === 'sh' ? Math.round(n * 100) / 100 : Math.round(n);
      }
      if (!Object.keys(clean).length) return json({ error: 'No usable numbers in the request.' }, 400);
      const all = await load(env);
      all[date] = { ...(all[date] || {}), ...clean };
      const keys = Object.keys(all).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete all[k];
      await env.HEALTH.put('all', JSON.stringify(all));
      return json({ ok: true, date, saved: clean });
    }

    return json({ error: 'Not found.' }, 404);
  },
};
