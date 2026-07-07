# BigPlan

Raymond's one-year mission command center (Jul 1, 2026 → Jun 30, 2027). Kanban tasks, habit streaks, focus timer, notes, milestone celebrations — **synced to the cloud, works offline, passcode-gated**, installable PWA.

## How your data works
- The cloud (Upstash KV via `api/state.js`) holds the master copy — open the app anywhere, enter the passcode, your data appears.
- Each device keeps a full local copy, so everything works with no internet; changes sync automatically when you're back online (newest copy wins; the previous copy is kept server-side as `bigplan:prev`).
- Exception: **file attachments stay on the device where you added them** (names sync, contents don't — KV size limit).
- First unlock on a new device needs internet; after that, offline unlock works.

## One-time setup
1. **Push to GitHub** (from `C:\Users\Ivy\RayTasks\Projects\bigplan`):
   ```powershell
   Remove-Item -Recurse -Force .git   # clear corrupted clone remnant, first time only
   git init -b main
   git remote add origin https://github.com/raymondzheng1/bigplan.git
   git add -A
   git commit -m "BigPlan: offline-first PWA with cloud sync"
   git push -u origin main
   ```
2. **Vercel:** vercel.com → Add New → Project → import `raymondzheng1/bigplan` → Framework preset **Other**, no build command → Deploy.
3. **Storage:** in the Vercel project → **Storage** (or Marketplace) → add **Upstash Redis** (free tier) → connect to the project. This auto-adds the KV env vars.
4. **Passcode:** Project → Settings → Environment Variables → add `APP_PASSCODE` = your passcode (all environments).
5. **Redeploy** (Deployments → ⋯ → Redeploy) so the env vars take effect.
6. Open `https://<project>.vercel.app`, enter the passcode. Install to your phone's home screen (Share → Add to Home Screen / menu → Install app).

Changing the passcode later: edit `APP_PASSCODE` in Vercel → redeploy. (Devices that cached the old passcode for offline unlock will re-verify next time they're online.)

## Releasing changes
1. Edit `index.html` / `api/state.js`.
2. **Bump `CACHE = 'bigplan-vN'` in `sw.js`** — installed clients won't update otherwise.
3. `npm run verify` must pass.
4. Commit + push — Vercel auto-deploys. Confirm the build finished before calling it live.
