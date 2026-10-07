# 📘 Noteversity — Parul University Academic Notes, PYQ & AI Assistant Platform

**Noteversity** is a full-stack, university-tailored academic portal built for engineering students at **Parul University**. It provides a centralized repository for semester lecture notes, previous year question papers (PYQs), and an **AI-powered Academic Mentor** that reads course notes and exam papers directly to answer student doubts and exam queries.

---

## 🚀 Quick Setup & Installation Guide

### Prerequisites
- **Node.js**: `v18.0.0` or higher installed on your computer. (Check via `node -v` in terminal)
- **Web Browser**: Modern browser (Chrome, Edge, Firefox, Brave).

---

### Option 1: One-Click Startup (Recommended for Windows)

Simply double-click the **`start.bat`** file in the root directory.

The batch script will automatically:
1. Check if Node.js is installed.
2. Install required backend npm dependencies if missing (`npm install`).
3. Automatically free port `5000` if previously occupied.
4. Launch the Noteversity backend server.
5. Restore database collections from persistent JSON files.
6. Open **http://localhost:5000** automatically in your default browser.

---

### Option 2: Manual Command-Line Setup

1. **Navigate to backend folder**:
   ```bash
   cd noteversity-backend
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure Environment Variables**:
   Verify or edit `noteversity-backend/.env`:
   ```env
   PORT=5000
   ALLOWED_EMAIL_DOMAIN=paruluniversity.ac.in
   JWT_SECRET=noteversity_super_secret_jwt_key_2026
   JWT_EXPIRES_IN=7d
   GEMINI_API_KEY=YOUR_GEMINI_API_KEY_HERE
   GEMINI_MODEL=gemini-3.1-flash-lite
   ```

4. **Start the server**:
   ```bash
   npm start
   ```

5. **Open the application**:
   Visit **[http://localhost:5000](http://localhost:5000)** in your web browser.

---

## 🔑 Access Roles

| Role | How access works | Permissions |
| :--- | :--- | :--- |
| **Visitor / Student** | None — the site opens directly with an anonymous per-browser guest session (no accounts, no registration) | Search, view, download notes & PYQs, ask AI ChatBot, personal stats |
| **Admin** | 🛡️ icon at the bottom-left of the sidebar → password (set via `ADMIN_PASSWORD_HASH` env var) | Upload notes/PYQs, delete files, manage repository |

> There is **no user login system**. Sessions are HttpOnly cookies — nothing sensitive is stored in the browser.

---

## 🚢 Deploying to Vercel (production)

The app runs as a Vercel serverless function (`api/index.js`) + static frontend, with MongoDB Atlas for the database and PDF storage (GridFS).

1. **Create a free MongoDB Atlas cluster** and copy the connection string (allow access from `0.0.0.0/0` — Vercel IPs are dynamic).
2. **Sync the PDF library + seed the cloud database** (one-time, run locally):
   ```
   cd noteversity-backend
   set MONGO_URI=mongodb+srv://user:pass@cluster0.xxx.mongodb.net/noteversity
   npm run sync:cloud
   ```
3. **Generate production secrets**:
   ```
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"          :: JWT_SECRET
   node -e "console.log(require('bcryptjs').hashSync('YOUR_ADMIN_PASSWORD',10))"     :: ADMIN_PASSWORD_HASH
   ```
4. **Push to GitHub → Vercel dashboard → Add New Project → Import.** Framework preset: *Other*; no build command needed (`vercel.json` handles routing, headers, and function settings).
5. **Add Environment Variables** (Production):
   | Variable | Value |
   | :--- | :--- |
   | `MONGO_URI` | your Atlas connection string |
   | `JWT_SECRET` | the long random string from step 3 |
   | `ADMIN_PASSWORD_HASH` | the bcrypt hash from step 3 |
   | `GEMINI_API_KEY` | your Gemini API key |
   | `XAI_API_KEY` | *(optional)* backup AI key |
6. **Deploy**, then open the URL — the site loads with an auto guest session; admin via the 🛡️ icon.

---

## 📄 Adding Your Own PDFs

The repository is designed so that **anyone can add their own course PDFs** without editing code:

1. **Name your files** with the subject prefix (case-insensitive):
   - `DAA_Chapter_1_Notes.pdf`
   - `AI_Unit_1_Intro.pdf`
   - `AWS_Cloud_Basics.pdf`
   - `EPJ_Servlets_Tutorial.pdf`
   - `TOC_Chapter_3_DFA.pdf`
   - `QR_Unit_2_Practice.pdf`

   Supported prefixes: `DAA_`, `AI_`, `AWS_`, `EPJ_`, `TOC_`, `QR_` (case-insensitive).

2. **Drop them into** `noteversity-backend/uploads/`

3. **Restart the server** (or start it if not running). The backend will auto-import any PDFs in `uploads/` that match a known subject prefix and aren't already in the database. The subject is inferred from the prefix; the title is generated from the filename (underscores become spaces).

> **Note**: The `uploads/` folder and `data/` folder are intentionally **gitignored** — you won't see other people's PDFs in this repo, and your own PDFs won't be committed. This keeps the repository lightweight and private.

---

## 🏗️ How the Entire System Works (Architecture & Data Flow)

```mermaid
flowchart TD
    subgraph Client["Frontend (noteversity-prototype.html)"]
        UI["UI Layer & Views (Dashboard, Notes, PYQs, ChatBot, Profile)"]
        KaTeX["KaTeX 0.16 (LaTeX Math Engine)"]
        AuthStore["localStorage Session & Auth State"]
    end

    subgraph Server["Backend (Node.js + Express)"]
        AuthMid["JWT Auth & Admin Role Guards"]
        APIRoutes["REST API Routes (/auth, /notes, /pyqs, /chat, /dashboard)"]
        MulterEng["Multer File Upload Engine"]
        RAGEngine["AI Service (PDF Parsing + Intent Filter + Gemini RAG)"]
    end

    subgraph Storage["Dual-Layer Storage Engine"]
        Mongo["In-Memory MongoDB (mongodb-memory-server) / Local Mongo"]
        JSONStore["JSON Persistence Layer (noteversity-backend/data/)"]
        Uploads["Physical PDF Storage (noteversity-backend/uploads/)"]
    end

    UI -->|REST API with Bearer JWT| APIRoutes
    APIRoutes --> AuthMid
    AuthMid --> APIRoutes
    APIRoutes --> MulterEng
    MulterEng --> Uploads
    APIRoutes --> RAGEngine
    RAGEngine -->|Extract Text| Uploads
    RAGEngine -->|Academic Prompt + Context| Gemini["Google Gemini AI API"]
    APIRoutes <--> Mongo
    Mongo <-->|Two-Way Sync & Startup Restore| JSONStore
```

### 1. Dual-Layer Storage Engine (Zero-Setup + Full Persistence)
- **In-Memory MongoDB**: If no external MongoDB is running on port `27017`, the backend automatically spins up an embedded `mongodb-memory-server`. This guarantees zero manual database setup.
- **JSON File Persistence**: To prevent data loss when the in-memory server restarts, the backend synchronizes all models into dedicated `.json` files under `noteversity-backend/data/`. On startup, `config/seeder.js` automatically loads and restores all users, notes, PYQs, and chats from disk.

### 2. Academic AI ChatBot (RAG Architecture)
1. **Relevance-Ranked Retrieval**: When a student asks a question in a subject (e.g. *DAA*, *AI*, *AWS*, *EPJ*, *TOC*, *QR*), the backend scores every notes/PYQ PDF by IDF-weighted keyword overlap with the question (and a bonus for rare, distinctive terms), so the chapters that actually teach the queried topic are selected — not just the most-downloaded files. Questions asked under *General* search across all six subjects.
2. **Targeted Excerpts & In-Memory Caching**: `pdf-parse` extracts full PDF text (cached in memory with timestamp validation). Instead of only the first pages, the AI reads the highest-scoring ~4,000-character chunks from anywhere in each book (up to 24k chars per document, 100k total) — so a 1.2-million-character reference book still contributes exactly its pumping-lemma section. Scanned/image-only PDFs (no text layer) are reported honestly to the model instead of being cited as sources.
3. **Instant Intent Filter**: Quick greetings (*"hey"*, *"hi"*, *"thanks"*, *"what can you do?"*) are answered instantly without consuming AI tokens.
4. **Academic Guardrails**: If an off-topic question is asked (e.g., movies, sports, entertainment), the assistant politely declines and redirects the student to Parul University coursework.
5. **Faculty Answer Format**: Every answer follows a two-part structure — first a ready-to-write **"✍️ How to Write This in Your Exam"** section (definitions, formulas, steps, tables, complexity — copy-ready for the answer sheet), then a deeper **"📚 Faculty Explanation"** (intuition, worked example, common mistakes). Markdown tables and LaTeX render natively in the chat.
6. **Gemini Fallback Pipeline**: Formulates a structured university exam prompt and queries Google Gemini using a multi-model fallback chain (`gemini-3.1-flash-lite` → `gemini-flash-latest` → `gemini-3.8-flash` → `gemini-3.7-flash`).
7. **Mathematical KaTeX Rendering**: Mathematical equations, recurrence relations, and algorithm complexity bounds ($O(N \log N)$) are rendered cleanly on the client using KaTeX.

---

## 🖥️ Frontend Features (noteversity-prototype.html)

The single-page frontend is a modern, zero-framework SPA with the following features:

| Feature | Description |
|---------|-------------|
| **Password show/hide** | Eye-toggle on login and both signup password fields. |
| **Favicon & per-view titles** | SVG "N" favicon; browser tab title updates per view (*Notes Library — Noteversity*, *ChatBot — Noteversity*, etc.). |
| **Loading skeletons** | Shimmer placeholder cards render instantly while notes/PYQs fetch, then swap seamlessly for real data. |
| **Inline PDF preview** | 👁 "Preview" button on every note/PYQ card opens a modal iframe — no download needed to peek. |
| **Drag-and-drop upload + progress** | Admin upload modal has a drag-and-drop zone; XHR upload shows a real-time % progress bar. |
| **Dark mode** | One-click sun/moon toggle in the topbar; preference saved to localStorage and restored on load. |
| **Mobile responsive** | Hamburger-drawer sidebar, full-width cards, stacked dashboard, search bar on its own row — works down to 375px. |

---

## 📂 Detailed File & Folder Breakdown

```
note/
├── start.bat                         # One-click Windows startup & dependency installer script
├── noteversity-prototype.html         # Complete single-page frontend web application
├── CHANGES_AND_ARCHITECTURE.md       # Architectural history and changelog
├── README.md                         # Complete project documentation (this file)
└── noteversity-backend/              # Express backend application
    ├── server.js                     # Main Express server entrypoint & static routing
    ├── package.json                  # Node.js dependencies and script definitions
    ├── .env                          # Active environment configuration & API keys
    ├── .env.example                  # Environment template
    │
    ├── config/
    │   ├── db.js                     # Hybrid MongoDB connector (External or In-Memory)
    │   └── seeder.js                 # Startup data restorer and default content seeder
    │
    ├── data/                         # Dedicated JSON persistence directory
    │   ├── users.json                # User accounts, hashed passwords, download tracking
    │   ├── notes.json                # Notes repository items and download stats
    │   ├── pyqs.json                 # PYQ repository papers and solution tags
    │   └── chats.json                # User-scoped ChatBot conversation history
    │
    ├── middleware/
    │   ├── auth.js                   # JWT authentication and user payload extraction
    │   ├── admin.js                  # Admin role authorization guard (Parul Admin)
    │   └── upload.js                 # Multer storage configuration for PDF files
    │
    ├── models/
    │   ├── User.js                   # Mongoose schema for User profiles
    │   ├── Note.js                   # Mongoose schema for Course Notes
    │   ├── Pyq.js                    # Mongoose schema for Previous Year Question papers
        │
    ├── routes/
    │   ├── auth.js                   # Guest sessions, /me, admin login/logout
    │   ├── notes.js                  # Notes listing, upload, delete, download tracking
    │   ├── pyqs.js                   # PYQs listing, upload, delete, download tracking
    │   ├── chat.js                   # AI Query (/ask), History (/history), and clear
    │   ├── dashboard.js              # User statistics and analytical metrics
        │
    ├── services/
    │   ├── aiService.js              # PDF text extractor, intent filter, Gemini RAG engine
    │   └── jsonStore.js              # File-system read/write persistence coordinator
    │
    └── uploads/                      # Local storage for all course PDFs (notes, papers, question banks)
        └── <subject>_<document>.pdf  # 79 catalogued course files served at /uploads/
```

---

## 🛠️ Technologies & Libraries Used

### Frontend
- **HTML5 / Vanilla CSS3 / Modern JavaScript (ES6+)**: Zero bulky frameworks for instant load times and lightweight footprint.
- **KaTeX 0.16.11**: High-performance browser rendering for LaTeX math notation, recurrences, and formulas.
- **Google Web Fonts**: Clean typography using `Space Grotesk`, `IBM Plex Sans`, and `IBM Plex Mono`.

### Backend
- **Node.js & Express 4**: RESTful API server and static asset delivery.
- **Google Generative AI SDK (`@google/generative-ai`)**: Official SDK for Google Gemini models (`gemini-3.1-flash-lite`, `gemini-flash-latest`).
- **`pdf-parse` (v2)**: High-speed server-side PDF document text extraction.
- **Mongoose 8 & `mongodb-memory-server`**: Object Document Mapping with zero-config embedded database.
- **JSON Persistent Store**: Atomic filesystem synchronization for restart safety.
- **JSON Web Tokens (JWT) & Bcrypt.js**: HttpOnly cookie sessions (guest + admin) and salted password hashing.
- **Multer**: Multi-part form data handler for PDF uploads.
- **CORS & Dotenv**: Cross-origin resource sharing and environment management.

---

## 🔮 Future Planning & Roadmap

1. **Multi-Semester Expansion (Semesters 1 to 8)**:
   - Roll out curated note sections and question banks for Semesters 1, 2, 3, 4, 6, 7, and 8 across all college branches (CSE, IT, ECE, EN, ME, CE).

2. **Vector Embeddings & Semantic Search (Pinecone / Qdrant)**:
   - Upgrade RAG pipeline from whole-document extraction to chunked vector embeddings (`text-embedding-004`) stored in a vector index for instant page-level semantic search across 500+ page reference textbooks.

3. **Student Contribution & Peer-Review Workflow**:
   - Allow registered students to upload notes with a *"Pending Admin Review"* state. Admins can preview, approve, or reject submissions before they go live.

4. **AI Exam Mock Generator & Flashcards**:
   - Interactive quiz mode where Noteversity AI automatically generates 5-question mock tests and formula flashcards based on recent AKTU semester PYQs.

5. **Offline Progressive Web App (PWA)**:
   - Service Worker implementation allowing students to save notes and view PDFs offline on mobile devices without active internet connection.

6. **Automated Syllabus Tracker & Exam Countdown**:
   - Visual progress bars where students can check off completed units and view countdown timers to upcoming AKTU Sessional and End-Sem exams.

---

## 📄 License & Credits
Developed for Parul University engineering students. Designed for fast academic study, easy resource sharing, and exam preparation.
