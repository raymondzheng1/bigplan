// launch-check.mjs — harness §4.7 machine gate for BigPlan (Tier C, static PWA).
// Asserts the launch deliverables are PRESENT (markers, not behaviour).
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(resolve(ROOT, f), 'utf8');
let failures = 0;
const check = (ok, msg) => {
  if (ok) console.log('  ✓ ' + msg);
  else { console.error('  ✗ ' + msg); failures++; }
};

console.log('index.html');
const html = read('index.html');
check(html.includes('rel="manifest"'), 'links the web app manifest');
check(html.includes('name="theme-color"'), 'sets theme-color');
check(html.includes('apple-touch-icon'), 'links apple-touch-icon');
check(html.includes('serviceWorker'), 'registers the service worker');
check(html.includes('id="lock"'), 'ships the passcode gate');
check(html.includes('One-Year Mission'), 'ships the mission countdown');
check(html.includes('tk_pass'), 'passcode hash is stored, not plaintext marker (tk_pass)');
check(!/tk_pass'\s*,\s*v\b/.test(html), 'passcode is never stored as plaintext value');

console.log('manifest.webmanifest');
const mf = JSON.parse(read('manifest.webmanifest'));
check(mf.display === 'standalone', 'display: standalone (installable)');
check(Array.isArray(mf.icons) && mf.icons.some(i => i.sizes === '192x192') && mf.icons.some(i => i.sizes === '512x512'), 'declares 192 + 512 icons');
check(!!mf.start_url && !!mf.scope, 'start_url + scope set');

console.log('sw.js');
const sw = read('sw.js');
check(/const CACHE = 'bigplan-v\d+'/.test(sw), 'versioned cache name (bump per release)');
check(sw.includes("'./index.html'"), 'precaches index.html');
check(sw.includes('skipWaiting'), 'activates new versions promptly');

console.log('icon files');
for (const f of ['icon-192.png', 'icon-512.png', 'apple-icon.png', 'favicon.ico'])
  check(existsSync(resolve(ROOT, f)), f + ' exists');

console.log('cloud sync (api/state.js)');
check(existsSync(resolve(ROOT, 'api/state.js')), 'api/state.js exists');
const apiSrc = read('api/state.js');
check(apiSrc.includes('KV_REST_API_URL') && apiSrc.includes('UPSTASH_REDIS_REST_URL'), 'reads BOTH KV env-name families (harness §15)');
check(apiSrc.includes('timingSafeEqual'), 'constant-time passcode compare');
check(apiSrc.includes('503'), 'fail-closed when unconfigured (§6.4)');
check(apiSrc.includes('409'), 'stale-write conflict handling (LWW)');
check(html.includes('syncPull') && html.includes('x-app-pass'), 'client sync engine wired');
check(sw.includes("/api/"), 'service worker never caches the sync API');
JSON.parse(read('vercel.json')); check(true, 'vercel.json parses');

console.log('backups (harness §2.3)');
check(existsSync(resolve(ROOT, 'api/export.js')), 'token-gated /api/export exists');
check(read('api/export.js').includes('timingSafeEqual'), 'export endpoint is passcode-gated');
check(apiSrc.includes('bigplan:snap:'), 'daily rolling KV snapshots on save (keep 14)');
check(html.includes('cloudBackup'), 'client Cloud backup button wired');
check(html.includes('bigplan-cloud-backup'), 'Import restores cloud-backup files');

console.log('operator alerts (harness §16.4)');
check(existsSync(resolve(ROOT, 'api/_alert.js')), 'api/_alert.js helper exists');
check(read('api/_alert.js').includes('alertmute'), 'alerts are throttled (1 per type per 10 min)');
check(read('api/_alert.js').includes("'SET'"), 'mute uses Upstash command-array form (query-param ?EX&NX 400s — regression guard)');
check(read('api/_alert.js').includes('ALERT_MUTE_CHECK_FAILED'), 'mute check fails OPEN on infra error');
check(apiSrc.includes('sendAlert'), 'state.js alerts on auth failure + KV failure');
check(read('api/export.js').includes('sendAlert'), 'export.js alerts on auth failure');
check(read('api/alert.js').includes('timingSafeEqual'), 'client error endpoint is passcode-gated');
check(html.includes('reportError'), 'client reports JS/sync/404 errors');

console.log('daily update cron (harness §7/§16)');
check(existsSync(resolve(ROOT, 'api/cron/daily.js')), 'api/cron/daily.js exists');
const cron = read('api/cron/daily.js');
check(cron.includes('CRON_SECRET'), 'cron endpoint is CRON_SECRET-guarded');
const sendIdx = cron.indexOf('await sendEmail('), pruneIdx = cron.indexOf('PRUNE (archive');
check(sendIdx > -1 && pruneIdx > sendIdx, 'invariant: email sends BEFORE prune');
check(cron.includes('bigplan:archive'), 'prune archives (never deletes)');
check(cron.includes('sendAlert') && cron.includes('CRON_DAILY_ERROR'), 'failure branches alert the operator (§16.4)');
const vj = JSON.parse(read('vercel.json'));
check(Array.isArray(vj.crons) && vj.crons.some(c => c.path === '/api/cron/daily'), 'cron scheduled in vercel.json');
check(read('api/export.js').includes('bigplan:archive'), 'archive included in cloud backups');
check(html.includes('/_vercel/insights/script.js'), 'Vercel Web Analytics script mounted (§8.5)');
check(sw.includes('/_vercel/'), 'service worker never caches analytics');

if (failures) { console.error(`\n${failures} check(s) FAILED.`); process.exit(1); }
console.log('\nAll launch checks passed.');
