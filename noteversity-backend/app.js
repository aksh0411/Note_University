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

const corsOptions = {
  origin: true,
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
