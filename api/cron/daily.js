// api/cron/daily.js — daily update email + archive-prune of old done cards.
// Order is a hard invariant: SEND FIRST, PRUNE ONLY AFTER A SUCCESSFUL SEND.
// Guarded by CRON_SECRET (Vercel sends "Authorization: Bearer <CRON_SECRET>").
// Prune = move done cards older than PRUNE_DAYS into bigplan:archive (never deleted;
// archive is included in /api/export backups). Structured JSON response (harness §7.5).
import { sendEmail, sendAlert } from '../_alert.js';

const KEY = 'bigplan:state', PREV = 'bigplan:prev', ARCH = 'bigplan:archive';
const PRUNE_DAYS = 35;   // > 30 so monthly stats stay accurate; UI tidiness comes from the collapsed Done column
const TZ = 'Australia/Sydney';
const DAY = 864e5;

const dayKey = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
const fmtD = ts => new Date(ts).toLocaleDateString('en-AU', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
const dur = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60); return h ? h + 'h ' + m + 'm' : m + 'm'; };

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET || (req.headers.authorization || '') !== 'Bearer ' + process.env.CRON_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) { res.status(503).json({ error: 'kv not configured' }); return; }
  const kv = (path, opts = {}) =>
    fetch(base + path, { ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) } }).then(r => r.json());

  try {
    const cur = await kv('/get/' + encodeURIComponent(KEY));
    if (!cur.result) { res.status(200).json({ ok: true, note: 'no state yet' }); return; }
    const state = JSON.parse(cur.result);
    const data = state.data || {};
    const tasks = JSON.parse(data.tk_tasks || '[]');
    const mission = JSON.parse(data.tk_mission || '{}');
    const now = Date.now();

    /* ---- compute the update (Sydney time) ---- */
    const [y, m, d] = dayKey(now).split('-').map(Number);
    const todayUTC = Date.UTC(y, m - 1, d);
    const missionDay = Math.max(1, Math.min(365, Math.floor((todayUTC - Date.UTC(2026, 6, 1)) / DAY) + 1));
    const yestKey = dayKey(now - DAY);
    const doneY = tasks.filter(t => t.done && t.doneAt && dayKey(t.doneAt) === yestKey)
      .sort((a, b) => a.doneAt - b.doneAt);
    const done7 = tasks.filter(t => t.done && t.doneAt >= now - 7 * DAY);
    const new7 = tasks.filter(t => (t.createdAt || 0) >= now - 7 * DAY);
    const open = tasks.filter(t => !t.done);

    let time7 = 0, missionSecs = 0;
    const kws = (mission.keywords || ['minglitang']).flatMap(k => k === 'minglitang' ? ['minglitang', 'mlt'] : [k]);
    tasks.forEach(t => {
      let secs = 0;
      if (t.sessions && t.sessions.length) t.sessions.forEach(([s, dd]) => { if (s >= now - 7 * DAY) secs += dd; });
      else if (t.timeSpent && t.done && t.doneAt >= now - 7 * DAY) secs = t.timeSpent;
      if (!secs) return;
      time7 += secs;
      if (kws.some(k => (t.text || '').toLowerCase().includes(k))) missionSecs += secs;
    });
    const align = time7 >= 600 ? Math.round(missionSecs / time7 * 100) : null;

    const off = (new Date(todayUTC).getUTCDay() + 6) % 7;         // Monday-based week (Sydney)
    const wk = new Date(todayUTC - off * DAY).toISOString().slice(0, 10);
    const rocks = tasks.filter(t => t.rockWeek === wk);

    const undoneMs = (mission.milestones || []).filter(x => !x.done && x.date).sort((a, b) => a.date < b.date ? -1 : 1);
    let msLine = 'No milestones set — open the mission banner and set them.';
    if (undoneMs.length) {
      const dd = Math.ceil((new Date(undoneMs[0].date + 'T12:00') - now) / DAY);
      msLine = dd < 0 ? '⚠ OVERDUE: ' + undoneMs[0].name + ' (' + (-dd) + ' days)' : undoneMs[0].name + ' — ' + dd + ' days away';
    } else if ((mission.milestones || []).length) msLine = 'All milestones achieved 🎉';

    const aging = open.map(t => ({ t, days: Math.floor((now - (t.createdAt || now)) / DAY) }))
      .sort((a, b) => b.days - a.days).slice(0, 5);

    const L = [];
    L.push('BIGPLAN — DAILY UPDATE · Day ' + missionDay + ' of 365');
    if (mission.goal) L.push('Mission: ' + mission.goal);
    L.push('');
    L.push('YESTERDAY (' + fmtD(now - DAY) + ')');
    if (doneY.length) doneY.forEach(t => L.push('  ✓ ' + t.text + (t.timeSpent ? '  (' + dur(t.timeSpent) + ')' : '')));
    else L.push('  (nothing completed)');
    L.push('');
    L.push('THE WEEK SO FAR');
    L.push('  Done: ' + done7.length + '   New: ' + new7.length + '   Time tracked: ' + (time7 ? dur(time7) : '—'));
    L.push('  Mission time: ' + (align !== null ? align + '%' : '—') + '   Rocks: ' + (rocks.length ? rocks.filter(t => t.done).length + '/' + rocks.length + ' done' : 'none set'));
    const qg = {};
    done7.forEach(t => { const q = t.queueName || 'To Do'; (qg[q] = qg[q] || [0, 0]); qg[q][0]++; qg[q][1] += t.timeSpent || 0; });
    if (Object.keys(qg).length > 1) {
      L.push('');
      L.push('BY QUEUE (7d)');
      Object.entries(qg).sort((a, b) => b[1][0] - a[1][0])
        .forEach(([q, [n, s]]) => L.push('  ' + q + ': ' + n + ' done' + (s ? ' · ' + dur(s) : '')));
    }
    const rituals = tasks.filter(t => !t.done && t.repeat);
    const ritY = doneY.filter(t => t.repeat);
    if (rituals.length || ritY.length) {
      L.push('');
      L.push('RITUALS');
      ritY.forEach(t => L.push('  ✓ ' + t.text.slice(0, 50) + (t.streakAtDone ? '  🔥' + t.streakAtDone : '')));
      rituals.forEach(t => {
        if (!ritY.some(d => d.text === t.text))
          L.push('  ○ ' + t.text.slice(0, 50) + (t.streak ? '  (🔥' + t.streak + ' at risk — do it today)' : ''));
      });
    }
    L.push('');
    L.push('NEXT MILESTONE');
    L.push('  ' + msLine);
    L.push('');
    L.push('NEEDS ATTENTION (' + open.length + ' open)');
    aging.forEach(a => L.push('  • ' + a.t.text.slice(0, 70) + '  — ' + (a.days <= 0 ? 'new' : a.days + 'd old')));

    /* ---- 1) SEND ---- */
    const doneYCount = doneY.length;
    const sent = await sendEmail('Daily update — Day ' + missionDay + ' · ' + doneYCount + ' done yesterday', L.join('\n'));
    if (!sent) {                        // never prune if the update didn't reach the user
      await sendAlert('Daily update failed to send', 'sendEmail returned false — see function logs.', 'cron');
      res.status(500).json({ ok: false, emailed: false, pruned: 0 });
      return;
    }

    /* ---- 2) PRUNE (archive, never delete) ---- */
    const cutoff = now - PRUNE_DAYS * DAY;
    const toArchive = tasks.filter(t => t.done && t.doneAt && t.doneAt < cutoff);
    let pruned = 0;
    if (toArchive.length) {
      const arch = await kv('/get/' + encodeURIComponent(ARCH));
      let list = []; try { list = arch.result ? JSON.parse(arch.result) : []; } catch {}
      list = list.concat(toArchive);
      if (list.length > 5000) list = list.slice(-5000);
      await kv('/set/' + encodeURIComponent(ARCH), { method: 'POST', body: JSON.stringify(list) });
      const keep = tasks.filter(t => !(t.done && t.doneAt && t.doneAt < cutoff));
      const newState = { updatedAt: Date.now(), data: { ...data, tk_tasks: JSON.stringify(keep) }, savedAt: Date.now() };
      await kv('/set/' + encodeURIComponent(PREV), { method: 'POST', body: cur.result });
      const w = await kv('/set/' + encodeURIComponent(KEY), { method: 'POST', body: JSON.stringify(newState) });
      if (w && w.error) throw new Error('kv write failed during prune');
      pruned = toArchive.length;
    }

    res.status(200).json({ ok: true, emailed: true, pruned, kept: tasks.length - pruned });
  } catch (e) {
    console.error('CRON_DAILY_ERROR', String(e && e.stack || e).slice(0, 400));
    await sendAlert('Daily cron FAILED', String(e && e.stack || e).slice(0, 800), 'cron');
    res.status(500).json({ ok: false, error: String(e).slice(0, 200) });
  }
}
