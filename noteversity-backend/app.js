/**
 * The Express application (routes + middleware only — no HTTP listener, no
 * socket server). Used by BOTH the dev server (server.js) and the Vercel
 * serverless function (api/index.js).
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cookieParser = require('cookie-parser');

const requireAuth = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const notesRoutes = require('./routes/notes');
const pyqsRoutes = require('./routes/pyqs');
const dashboardRoutes = require('./routes/dashboard');
const chatRoutes = require('./routes/chat');
const storage = require('./services/storage');

const app = express();

// Trust the reverse proxy (Vercel / local tunnels) so req.ip is the real client
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Security headers — set in the app itself so they apply on every host,
// regardless of platform-level header configuration (mirrors vercel.json).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net; img-src 'self' data:; connect-src 'self'; frame-src 'self' about:; frame-ancestors 'self'; object-src 'self'; base-uri 'self'; form-action 'self'");
  next();
});

// CORS: same-origin app, so cross-origin access is allowlisted instead of
// reflected. Requests without an Origin header (same-site, curl, health
// checks) pass through untouched.
const ALLOWED_ORIGINS = [
  'https://note-university.vercel.app', // update if the site domain ever changes
  'http://localhost:5000',
  'http://127.0.0.1:5000',
];
const corsOptions = {
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(null, false); // no CORS grant — browser blocks the response
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

// Uploaded notes/PYQs require a signed-in session (cookie or Bearer/`?token=`
// for API clients). Filenames are sanitized against path traversal.
app.get('/uploads/:filename', requireAuth, async (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const stream = await storage.getPdfStream(filename);
    if (!stream) {
      return res.status(404).json({ message: 'File not found' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    stream.pipe(res);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500);
      res.end();
    });
  } catch (err) {
    console.error('[Uploads route error]');
    if (!res.headersSent) res.status(500).json({ message: 'Failed to retrieve file' });
  }
});

// Serve the frontend (dev convenience; on Vercel it is a static rewrite)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'noteversity-prototype.html'));
});

app.use('/api/auth', authRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/pyqs', pyqsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/chat', chatRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ---- Central error handler: multer problems → clean JSON 400, everything
// else → generic JSON 500 with the stack logged server-side only ----
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'File is too large. Maximum size is 20MB.'
      : 'Upload error: ' + err.code;
    return res.status(400).json({ message });
  }
  if (err && err.message && err.message.startsWith('Unsupported file type')) {
    return res.status(400).json({ message: err.message });
  }
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    return res.status(400).json({ message: 'Invalid request body' });
  }
  if (err && err.name === 'ValidationError') {
    return res.status(400).json({ message: 'Invalid request data' });
  }
  console.error('[Server Error]');
  if (res.headersSent) return next(err);
  return res.status(500).json({ message: 'Something went wrong. Please try again.' });
});

module.exports = app;
