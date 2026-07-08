// api/_alert.js — operator alert emails via Resend (harness §16.4).
// Helper only (underscore file = not a route). Fail-open: no key => silently skip.
// Throttle: max one email per alert type per 10 minutes (KV SET NX EX), so a
// brute-force passcode attempt can't flood the inbox.

async function allowed(type) {
  const base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) return true;
  try {
    const r = await fetch(`${base}/set/${encodeURIComponent('bigplan:alertmute:' + type)}/1?EX=600&NX=true`,
      { headers: { Authorization: 'Bearer ' + token } }).then(x => x.json());
    return r.result === 'OK';           // null => muted (already sent within 10 min)
  } catch { return true; }
}

export async function sendAlert(subject, text, type = 'general') {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.error('ALERT_SKIPPED_NO_KEY — RESEND_API_KEY not set in this deployment'); return; }
  try {
    if (!(await allowed(type))) return;
    const to = process.env.ALERT_EMAIL || 'raymond.zheng@gmail.com';
    const from = process.env.ALERT_FROM || 'BigPlan <onboarding@resend.dev>';
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject: '[BigPlan] ' + subject, text })
    });
    if (!r.ok) {
      // Surface the reason in Vercel function logs (no secrets logged)
      console.error('ALERT_SEND_FAILED', r.status, (await r.text()).slice(0, 300));
    }
  } catch (e) { console.error('ALERT_SEND_ERROR', String(e).slice(0, 200)); }
}
