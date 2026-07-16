// api/_alert.js — email helpers via Resend (harness §16.2/§16.4).
// sendEmail: direct send, "[BigPlan]" subject prefix + app footer (§16.2).
// sendAlert: sendEmail + a 10-min per-type mute so error floods can't spam the inbox.
// Fail-open philosophy: email problems are logged, never break the caller.

async function allowed(type) {
  const base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) return true;
  try {
    // Command-array form (unambiguous Upstash REST syntax): SET key 1 EX 600 NX
    const r = await fetch(base, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(['SET', 'bigplan:alertmute:' + type, '1', 'EX', '600', 'NX'])
    }).then(x => x.json());
    if (r && r.error) {                 // infra error => FAIL OPEN: better to over-alert than never alert
      console.error('ALERT_MUTE_CHECK_FAILED', String(r.error).slice(0, 200));
      return true;
    }
    return r.result === 'OK';           // null => genuinely muted (sent within last 10 min)
  } catch { return true; }
}

export async function sendEmail(subject, text) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.error('ALERT_SKIPPED_NO_KEY — RESEND_API_KEY not set in this deployment'); return false; }
  try {
    const to = process.env.ALERT_EMAIL || 'raymond.zheng@gmail.com';
    const from = process.env.ALERT_FROM || 'BigPlan <onboarding@resend.dev>';
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({
        from, to: [to],
        subject: '[BigPlan] ' + subject,
        text: text + '\n\n— Sent via BigPlan'
      })
    });
    if (!r.ok) {
      console.error('ALERT_SEND_FAILED', r.status, (await r.text()).slice(0, 300));
      return false;
    }
    return true;
  } catch (e) { console.error('ALERT_SEND_ERROR', String(e).slice(0, 200)); return false; }
}

export async function sendAlert(subject, text, type = 'general') {
  if (!process.env.RESEND_API_KEY) { console.error('ALERT_SKIPPED_NO_KEY — RESEND_API_KEY not set in this deployment'); return; }
  if (!(await allowed(type))) return;
  await sendEmail(subject, text);
}
