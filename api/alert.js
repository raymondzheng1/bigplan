// api/alert.js — passcode-gated client error reporting (JS errors, sync failures,
// 404s the app observes). Forwards to the operator via Resend (see _alert.js).
import { createHash, timingSafeEqual } from 'node:crypto';
import { sendAlert } from './_alert.js';

export default async function handler(req, res) {
  const pass = process.env.APP_PASSCODE;
  if (!pass) { res.status(503).json({ error: 'not configured' }); return; }
  const given = String(req.headers['x-app-pass'] || '');
  const h = s => createHash('sha256').update(s).digest();
  if (!timingSafeEqual(h(given), h(pass))) {
    await new Promise(r => setTimeout(r, 400));
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }

  const b = req.body || {};
  const type = String(b.type || 'client').slice(0, 32).replace(/[^a-z0-9_-]/gi, '') || 'client';
  const message = String(b.message || '').slice(0, 2000);
  await sendAlert('Client error: ' + type,
    message +
    '\n\nTime: ' + new Date().toISOString() +
    '\nIP: ' + (req.headers['x-forwarded-for'] || '?') +
    '\nUA: ' + (req.headers['user-agent'] || '?'),
    'client-' + type);
  res.status(200).json({ ok: true });
}
