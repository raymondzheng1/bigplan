// api/state.js — BigPlan cloud state (single-user KV blob, passcode-gated).
// Auth: x-app-pass header must match APP_PASSCODE (server env, like Translator).
// Storage: Upstash Redis REST. Reads BOTH env name families (harness §15 gotcha):
//   Vercel KV integration:  KV_REST_API_URL / KV_REST_API_TOKEN
//   Upstash marketplace:    UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
// Fail-closed (§6.4): missing config => 503, wrong pass => 401 (+delay).
// Concurrency: whole-blob last-write-wins on client updatedAt; a stale PUT gets
// 409 + the newer state. Previous blob kept at bigplan:prev (cheap backup).
import { createHash, timingSafeEqual } from 'node:crypto';
import { sendAlert } from './_alert.js';

const KEY = 'bigplan:state';
const PREV = 'bigplan:prev';
const MAX_BYTES = 950_000; // Upstash free-tier request cap is 1 MB

export default async function handler(req, res) {
  const base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  const pass = process.env.APP_PASSCODE;
  if (!base || !token || !pass) {
    res.status(503).json({ error: 'Sync not configured: set APP_PASSCODE + Upstash Redis env vars in Vercel, then redeploy.' });
    return;
  }

  const given = String(req.headers['x-app-pass'] || '');
  const h = s => createHash('sha256').update(s).digest();
  if (!timingSafeEqual(h(given), h(pass))) {
    await new Promise(r => setTimeout(r, 400)); // slow brute force
    await sendAlert('Wrong passcode attempt',
      'Endpoint: /api/state\nTime: ' + new Date().toISOString() +
      '\nIP: ' + (req.headers['x-forwarded-for'] || '?') +
      '\nUA: ' + (req.headers['user-agent'] || '?'), 'auth');
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const kv = (path, opts = {}) =>
    fetch(base + path, { ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) } })
      .then(r => r.json());

  if (req.method === 'GET') {
    const j = await kv('/get/' + encodeURIComponent(KEY));
    let state = null;
    try { state = j.result ? JSON.parse(j.result) : null; } catch {}
    res.status(200).json({ state });
    return;
  }

  if (req.method === 'PUT' || req.method === 'POST') {
    const body = req.body;
    if (!body || typeof body.updatedAt !== 'number' || typeof body.data !== 'object' || body.data === null) {
      res.status(400).json({ error: 'bad request' });
      return;
    }
    const payload = JSON.stringify({ updatedAt: body.updatedAt, data: body.data, savedAt: Date.now() });
    if (payload.length > MAX_BYTES) {
      res.status(413).json({ error: 'State too large to sync. (File attachments never sync — this is other data.)' });
      return;
    }
    const cur = await kv('/get/' + encodeURIComponent(KEY));
    let curState = null;
    try { curState = cur.result ? JSON.parse(cur.result) : null; } catch {}
    if (curState && curState.updatedAt > body.updatedAt) {
      res.status(409).json({ state: curState }); // client is stale — newer copy wins
      return;
    }
    if (cur.result) await kv('/set/' + encodeURIComponent(PREV), { method: 'POST', body: cur.result });
    const setr = await kv('/set/' + encodeURIComponent(KEY), { method: 'POST', body: payload });
    if (setr && setr.error) {
      await sendAlert('KV write FAILED', 'Upstash returned: ' + JSON.stringify(setr) + '\nTime: ' + new Date().toISOString(), 'kv');
      res.status(500).json({ error: 'kv write failed' });
      return;
    }
    // Daily rolling snapshot (harness §2.3): first save of each day is snapshotted,
    // keep the last 14 days. Wrapped in try/catch — a snapshot hiccup never fails the save.
    try {
      const snapKey = 'bigplan:snap:' + new Date().toISOString().slice(0, 10);
      const exists = await kv('/get/' + encodeURIComponent(snapKey));
      if (!exists.result) {
        await kv('/set/' + encodeURIComponent(snapKey), { method: 'POST', body: payload });
        const keys = await kv('/keys/' + encodeURIComponent('bigplan:snap:*'));
        const list = (keys.result || []).sort();
        for (const k of list.slice(0, Math.max(0, list.length - 14)))
          await kv('/del/' + encodeURIComponent(k));
      }
    } catch {}
    res.status(200).json({ ok: true, updatedAt: body.updatedAt });
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
}
