# 🧠 HOW IT WORKS — Noteversity Logic & Architecture Guide

This document explains **how every piece of Noteversity actually works** — the session logic, the ChatBot RAG pipeline, where data is stored, and what every file does. Read this before touching the code.

*Ahead of the 2026-10-05 production hardening this document described the old signup/OTP/JWT-in-localStorage architecture; it has been rewritten to match the current cookie-session system.*

---

## The big picture

```
┌───────────────────────────┐         ┌──────────────────────────────┐
│  noteversity-prototype    │  HTTPS  │  Express API (Vercel function │
│  .html — zero-build SPA   │────────▶│  api/index.js + noteversity-  │
│  (HTML+CSS+JS, one file)  │◀────────│  backend)                     │
└───────────────────────────┘         └───────────────┬──────────────┘
     HttpOnly cookies carry the                       │ Mongoose
     session — nothing sensitive                      ▼
     is ever stored in the browser      ┌──────────────────────────────┐
                                        │ MongoDB Atlas (cluster0)     │
                                        │  users / notes / pyqs /      │
                                        │  chatentries + GridFS "pdfs" │
                                        └──────────────────────────────┘
```

## Sessions (no login)

There is **no user signup or login**. On first visit the frontend calls
`POST /api/auth/guest-session`, which creates an anonymous Guest user and sets
an `nv_session` HttpOnly cookie (JWT, 7 days). Every page load afterwards calls
`GET /api/auth/me` to restore the identity. The only credential check in the
whole app is `POST /api/auth/admin/login`, which bcrypt-compares the password
against the `ADMIN_PASSWORD_HASH` environment variable and sets an `nv_admin`
cookie (8 hours). Admin rights are enforced **server-side** by
`middleware/admin.js` (guest tokens are rejected by a `typ` claim check).

## Library (notes + PYQs)

- `GET /api/notes` / `GET /api/pyqs` — list cards (title, subject, downloads,
  file URL). `search` matches **titles and the extracted PDF text**; responses
  deliberately exclude `extractedText` to keep payloads small.
- `POST /api/notes` / `POST /api/pyqs` — admin-only uploads (PDF, ≤20 MB).
  The file is stored in **GridFS** (bucket `pdfs`) and its text is extracted
  with `pdf-parse` into `extractedText` — this is the RAG corpus.
- `DELETE /api/:id` — admin-only; removes both the GridFS file and the record.
- `POST /api/:id/download` — increments the download counter and records it on
  the user's dashboard.
- `GET /uploads/:filename` — serves PDFs publicly (shareable links), with
  path-traversal sanitization.

## AI chatbot

`POST /api/chat/ask` (`routes/chat.js` → `services/aiService.js`):

1. The question is stored in the user's chat history (`chatentries`).
2. The last few turns are sent along as conversation memory.
3. Relevant course PDFs are found by matching the question against
   `extractedText` (RAG).
4. Gemini (`GEMINI_API_KEY`, xAI Grok as backup) answers strictly from that
   material; the answer + source documents are returned and persisted.
5. `POST /api/chat/suggest` generates follow-up question chips separately so a
   suggestions failure can never break the answer.

## Data & deployment

- **Local dev**: `npm start` → if Atlas is unreachable, an embedded
  in-memory MongoDB starts automatically and is seeded from `config/libraryCatalog.js`
  and the `data/*.json` mirrors.
- **Production (Vercel)**: `api/index.js` wraps the Express app; the
  connection is managed by `getReadyConnection()` in `config/db.js`, which
  waits for in-flight reconnects and hard-resets zombie topologies (frozen
  serverless instances' sockets die on Atlas's side). Security headers + CSP
  are set in `app.js`.
- **One-time setup**: `scripts/sync-cloud.js` uploads the PDF library into
  GridFS and seeds the catalog; `scripts/create-indexes.js` creates the
  database indexes (`autoIndex` is off in production by design).

## Environment variables (production)

| Variable | Purpose |
|---|---|
| `MONGO_URI` | Atlas connection string (required) |
| `JWT_SECRET` | Session signing secret, ≥16 chars (required) |
| `ADMIN_PASSWORD_HASH` | bcrypt hash of the admin password |
| `GEMINI_API_KEY` | Primary AI provider |
| `XAI_API_KEY` | Optional backup AI provider |
| `ALLOWED_EMAIL_DOMAIN` | Email domain for guest identities |

Dead variables from older versions (`SMTP_*`, `CLIENT_URL`,
`OTP_EXPIRY_MINUTES`) belong to the removed email/OTP system and are ignored.

## Key files

| File | Role |
|---|---|
| `noteversity-prototype.html` | The entire frontend SPA (views, chat UI, cards, modals) |
| `api/index.js` | Vercel serverless entry — DB connection + Express delegate |
| `noteversity-backend/app.js` | Express app: routes, CORS allowlist, security headers, PDF serving |
| `noteversity-backend/config/db.js` | `getReadyConnection()` — self-healing serverless connection manager |
| `noteversity-backend/config/seeder.js` | Dev seeding + catalog restore |
| `noteversity-backend/middleware/auth.js` | Session verification (401 vs 503 semantics) |
| `noteversity-backend/middleware/admin.js` | Admin-only gate (`nv_admin` cookie, `typ:'admin'`) |
| `noteversity-backend/middleware/upload.js` | Multer PDF-only uploads, 20 MB cap |
| `noteversity-backend/routes/*.js` | auth / notes / pyqs / chat / dashboard |
| `noteversity-backend/services/aiService.js` | Intent filter, RAG retrieval, Gemini/xAI calls |
| `noteversity-backend/services/storage.js` | GridFS put/get/delete + PDF text extraction |
| `noteversity-backend/services/chatStore.js` | Per-user chat persistence (Mongo) |
| `noteversity-backend/services/jsonStore.js` | Dev-only JSON mirrors |
| `noteversity-backend/scripts/sync-cloud.js` | One-time Atlas PDF upload + catalog seed |
| `noteversity-backend/scripts/create-indexes.js` | One-time production index creation |
