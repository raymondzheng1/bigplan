# BigPlan — project conventions

**Tier B — KV-only** (harness §2.0). Static single-file PWA + one serverless function; Upstash Redis KV holds a single-user state blob. No Supabase, no Stripe, no Resend, no accounts.

## Deviations from harness defaults (recorded per §2.0/§2.1)
- **No GA4.** Single-user personal tool. (§8.2 waived.) **Vercel Web Analytics IS enabled** (§8.5): plain-HTML script tag in `index.html`; `/_vercel/` excluded from SW cache; requires Analytics enabled in the Vercel dashboard.
- **No contact page.** The only user is the owner. (§16.3 waived.)
- **Auth = shared passcode** (`APP_PASSCODE` server env, checked per request via `x-app-pass`, constant-time) — the validated Translator pattern, not real auth. Fine for a single-user app; never reuse for multi-user.

## Architecture
- `index.html` is the entire client (inline CSS/JS by design — keep single-file). `api/state.js` is the entire server.
- **Sync model (offline-first, LWW):** localStorage is the working copy. Every write marks dirty + debounce-pushes the whole `tk_*` blob to KV. Unlock / reconnect / 60s poll pulls; a strictly newer remote copy replaces local. Stale PUT → 409 + newer state; client adopts it. Previous blob kept at `bigplan:prev`.
- **Backups (§2.3, KV data is user-authored):** four layers — (1) full local copy on every device; (2) `bigplan:prev` on every save; (3) daily rolling KV snapshots `bigplan:snap:<date>` written on the first save of each day, pruned to 14, try/catch-wrapped so they never fail the save; (4) token-gated `/api/export` + client "Cloud backup" button downloading state+prev+snapshots as one restorable JSON (Import accepts it). Monthly restore drill documented in README.
- **File attachments never sync** (KV 1 MB cap): names/sizes sync, bytes stay device-local (`collectState` strips `f.data`; `applyRemote` re-attaches local bytes by task id + name).
- KV env names: read **both** `KV_REST_API_URL`/`KV_REST_API_TOKEN` and `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` (§15 gotcha) — pinned by launch-check.
- Passcode: verified server-side when online; SHA-256 hash cached locally for offline unlocks. A privacy gate, not encryption.
- `sw.js`: offline-first SWR for static assets; **never caches `/api/`**. **Bump `CACHE = 'bigplan-vN'` every release.**
- Mission window fixed: 2026-07-01 → 2027-06-30, computed at load.
- **Signal collection (feeds Insights + planned Phase-3 AI review).** Collected silently, all local + synced in the state blob:
  - per task: `createdAt`, `doneAt`, `timeSpent`, `sessions` [[startMs, secs], …] (cap 30), `moves` (reorder count), `src` (typed/voice/file), `createdDevice`/`doneDevice` (mobile/desktop)
  - `tk_usage` — app opens + work-mode sessions per day (rolling 60 days)
  - `tk_deleted` — last 50 tasks deleted while incomplete (abandonment churn, with age at deletion)
- **Phase 3 (planned, not built): AI weekly review.** `/api/review` reads the KV state server-side → Anthropic API (`ANTHROPIC_API_KEY`, server-only, small model) → chief-of-staff style weekly brief; delivered on demand from the Insights tab + Monday-morning email via Vercel cron (guard with `CRON_SECRET`) through the existing Resend helper. Privacy note: task text leaves the device only when this ships and is enabled.

## Required environment variables (placeholders only in repo)
| Var | Where | Purpose |
|---|---|---|
| `APP_PASSCODE` | Vercel env | The passcode. Server-only. Change → redeploy. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | auto-added by Vercel↔Upstash integration | KV REST endpoint (or the `UPSTASH_REDIS_REST_*` pair). |
| `RESEND_API_KEY` | Vercel env (optional) | Operator alert emails (§16.4) + the daily update email. Unset = both silently off (fail-open — alerts are observability, not a guardrail). |
| `CRON_SECRET` | Vercel env | Guards `/api/cron/daily`. Any long random string; Vercel automatically sends it as the Authorization bearer on scheduled invocations. |
| `ALERT_EMAIL` | optional | Alert recipient. Default `raymond.zheng@gmail.com`. |
| `ALERT_FROM` | optional | Sender. Default `BigPlan <onboarding@resend.dev>` — works without domain verification but ONLY to the Resend account owner's email; verify a domain (§16.1) to send anywhere else. |

**Alerts fire on:** wrong passcode attempts (state + export), KV write failures, client-reported JS errors / unhandled rejections / API 404s & 5xx. Throttled server-side to 1 email per type per 10 min; client reports max 1/min.

## Daily update cron (`/api/cron/daily`, 21:00 UTC = 7am AEST)
Sends the daily progress email (yesterday's completions, week stats, mission time %, rocks, next milestone, aging items), **then** archive-prunes done cards older than `PRUNE_DAYS` (35 — kept >30 so monthly stats stay accurate) into `bigplan:archive` (capped 5,000; included in `/api/export`). **Invariants, pinned by launch-check:** email sends before prune; prune never runs if the send failed; failure branches call `sendAlert`. Note: the prune writes state server-side — a device that was offline with unsynced edits since before the prune will get a 409 and adopt the pruned state (same LWW behaviour as any stale push). Cadence is daily for testing; switch the `vercel.json` schedule to weekly (`0 21 * * 0`) once trusted.

## Hosting
Vercel (region `syd1`), Git push to `main` auto-deploys. `git push` ≠ live (§2.2). Env var changes require a redeploy.

## Verify gate (§4.1)
`npm run verify` → `scripts/launch-check.mjs` (PWA deliverables + sync invariants present). Run before every push.
