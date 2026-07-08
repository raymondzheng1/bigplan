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

## Required environment variables (placeholders only in repo)
| Var | Where | Purpose |
|---|---|---|
| `APP_PASSCODE` | Vercel env | The passcode. Server-only. Change → redeploy. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | auto-added by Vercel↔Upstash integration | KV REST endpoint (or the `UPSTASH_REDIS_REST_*` pair). |
| `RESEND_API_KEY` | Vercel env (optional) | Operator alert emails (§16.4). Unset = alerts silently off (fail-open — alerts are observability, not a guardrail). |
| `ALERT_EMAIL` | optional | Alert recipient. Default `raymond.zheng@gmail.com`. |
| `ALERT_FROM` | optional | Sender. Default `BigPlan <onboarding@resend.dev>` — works without domain verification but ONLY to the Resend account owner's email; verify a domain (§16.1) to send anywhere else. |

**Alerts fire on:** wrong passcode attempts (state + export), KV write failures, client-reported JS errors / unhandled rejections / API 404s & 5xx. Throttled server-side to 1 email per type per 10 min; client reports max 1/min.

## Hosting
Vercel (region `syd1`), Git push to `main` auto-deploys. `git push` ≠ live (§2.2). Env var changes require a redeploy.

## Verify gate (§4.1)
`npm run verify` → `scripts/launch-check.mjs` (PWA deliverables + sync invariants present). Run before every push.
