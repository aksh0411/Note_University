# Fix admin-flip bug + slow/partial lists + rename to "Akshay" + security fixes

Root causes confirmed by code trace: (1) the auth middleware returns a **false 401 when the DB is cold** on Vercel, and the frontend's 401-recovery then **overwrites the admin session with a guest**; (2) list endpoints ship **1.26 MB of `extractedText`** the UI never reads, plus crash on bad input; (3) name/strings + DB record say "Parul Admin".

## A. Backend — honest auth semantics (fixes the guest-flip)
1. `noteversity-backend/config/db.js` — add and export a `waitForDb(maxMs)` helper (polls connection readyState up to ~8 s) and an `isDbUnavailable(err)` classifier (readyState + Mongo error names).
2. `middleware/auth.js` — separate token errors from DB errors: invalid/expired token → 401 (as now); token valid but DB not ready → wait briefly, then **503** "Database is warming up. Please try again." Never a fake 401.
3. `routes/auth.js` —
   - `/me`: DB failure while token valid → 503 (not 401).
   - `guest-session` / `admin/login` fallback: `waitForDb()` instead of the racing `connectDB()` re-call (kills the "insertOne before initial connection" 500s from your logs).
   - **Remove the `Harsh2002` backdoor** (auth.js:149-151).
   - Admin record name `'Parul Admin'` → `'Akshay'`.

## B. Backend — fast, safe list endpoints (fixes the 5–10 s delay)
4. `routes/notes.js` + `routes/pyqs.js` GET handlers:
   - `.select('-extractedText')` → payload drops 1.26 MB → ~40 KB (frontend confirmed to never read that field).
   - try/catch → clean 503/500 JSON instead of killing the serverless instance.
   - Guard `semester` non-numeric (NaN → ignore) and escape regex metacharacters in `search` — the crash-from-`(` bug dies here too.

## C. Frontend (`noteversity-prototype.html`) — keep sessions, load resiliently
5. `fetchSessionUser()` (~:1692): 401 → null; 5xx/network → one retry after 1 s, then **throw** (boot shows the Retry screen rather than silently becoming guest).
6. `refreshGuestSession()` (~:1700): **check `/api/auth/me` first** — if a valid session (admin or guest) still exists, return it unchanged; only mint a guest when the server explicitly says there's no session. This is the direct fix for "Welcome, Parul → flips to Guest".
7. `fetchNotes()`/`fetchPyqs()` (~:915/:977): retry on 401 (via fixed refresh) **or 503** (short wait + one retry, no session change); if the retry still fails, render the "Could not load…" error in the grid instead of leaving a stuck skeleton (the "only notes / only PYQs" symptom).
8. Rename strings: 3 access-denied toasts "(Parul Admin)" → "(Akshay)"; static sidebar/profile placeholders → "Akshay".

## D. Security + rename data
9. `app.js`: delete the public `/api/debug-db` route (lines 72-96).
10. `config/seeder.js`: admin seed name → 'Akshay'.
11. One-time DB update on your **new** Atlas cluster (axjyerz, creds already in use): rename existing admin record to 'Akshay' + verify counts (62 notes / 16 PYQs / 79 PDFs).
12. New admin password `Akshay77201` → compute bcrypt hash; update local `.env` `ADMIN_PASSWORD_HASH` and give you the hash to paste into **Vercel env** (then Redeploy). Old password stops working.

## E. Verify
13. Local: isolated server + API regression (payload size, `?search=(` → clean 400, `semester=abc` guarded, garbage cookie → 401, DB-cold path → 503, backdoor rejected 401, new password works, `/api/debug-db` → 404) + browser E2E (admin login survives refresh, lists load fully and fast).
14. Deploy: I don't have push access (remote disconnected) — I'll check if the Vercel CLI is authed and deploy; otherwise give you exact redeploy steps + the hash value.
15. Live smoke against the deployed URL: boot, admin login with new password (no guest flip), notes+PYQs complete and fast, old password rejected, debug-db gone.

**Honest caveat:** brief 503s can still occur on the very first request after a long idle cold start — they're now handled gracefully (retry, no session loss). Baseline latency depends on the distance between your Atlas region and Vercel's; if lists are still slower than expected after this, the next lever is aligning Vercel's function region with the cluster region (separate decision).