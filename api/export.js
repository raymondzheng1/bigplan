// api/export.js — token-gated full backup (harness §2.3 Tier-B minimum).
// Returns current state + previous version + all daily snapshots as one
// downloadable JSON. Auth identical to api/state.js (x-app-pass, constant-time).
import { createHash, timingSafeEqual } from 'node:crypto';
import { sendAlert } from './_alert.js';

export default async function handler(req, res) {
  const base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  const pass = process.env.APP_PASSCODE;
  if (!base || !token || !pass) { res.status(503).json({ error: 'not configured' }); return; }

  const given = String(req.headers['x-app-pass'] || '');
  const h = s => createHash('sha256').update(s).digest();
  if (!timingSafeEqual(h(given), h(pass))) {
    await new Promise(r => setTimeout(r, 400));
    await sendAlert('Wrong passcode attempt',
      'Endpoint: /api/export\nTime: ' + new Date().toISOString() +
      '\nIP: ' + (req.headers['x-forwarded-for'] || '?') +
      '\nUA: ' + (req.headers['user-agent'] || '?'), 'auth');
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (req.method !== 'GET') { res.status(405).json({ error: 'method not allowed' }); return; }

  const kv = path => fetch(base + path, { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
  const parse = j => { try { return j.result ? JSON.parse(j.result) : null; } catch { return null; } };

  const current = parse(await kv('/get/' + encodeURIComponent('bigplan:state')));
  const previous = parse(await kv('/get/' + encodeURIComponent('bigplan:prev')));
  const snapshots = {};
  const keys = await kv('/keys/' + encodeURIComponent('bigplan:snap:*'));
  for (const k of (keys.result || []).sort()) {
    const v = parse(await kv('/get/' + encodeURIComponent(k)));
    if (v) snapshots[k.slice('bigplan:snap:'.length)] = v;
  }

  const day = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="bigplan-cloud-backup-${day}.json"`);
  res.status(200).json({
    app: 'bigplan-cloud-backup',
    exported: new Date().toISOString(),
    current, previous, snapshots
  });
}
