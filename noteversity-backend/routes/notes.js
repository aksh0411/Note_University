const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const path = require('path');
const Note = require('../models/Note');
const User = require('../models/User');
const requireAuth = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');
const upload = require('../middleware/upload');
const storage = require('../services/storage');
const { syncNotesToJson, syncUsersToJson } = require('../services/jsonStore');

const { isDbUnavailable } = require('../config/db');

const router = express.Router();

const VALID_SUBJECTS = ['DAA', 'AI', 'AWS', 'EPJ', 'TOC', 'QR'];

// GET /api/notes?subject=DAA&semester=5 — list cards only; extractedText is the
// RAG corpus for the chatbot and is deliberately excluded (≈1.2MB → ~40KB).
router.get('/', requireAuth, async (req, res) => {
  try {
    const { subject, semester, branch, search } = req.query;
    const filter = {};
    if (subject) filter.subject = subject;
    if (semester && !Number.isNaN(Number(semester))) filter.semester = Number(semester);
    if (branch) filter.branch = branch;
    if (search) {
      const rx = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      // Search inside the documents too, not just titles — students look up
      // topics ("knapsack"), not file names.
      filter.$or = [{ title: rx }, { extractedText: rx }];
    }

    const notes = await Note.find(filter).select('-extractedText').populate('uploadedBy', 'name').sort({ createdAt: -1 });
    res.json(notes);
  } catch (err) {
    console.error('Notes list error:', err && err.message ? err.message : err);
    if (isDbUnavailable(err)) return res.status(503).json({ message: 'Database is warming up. Please try again.' });
    res.status(500).json({ message: 'Failed to load notes' });
  }
});

// POST /api/notes  (multipart/form-data, field name: file) - ADMIN ONLY
router.post('/', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  try {
    const { title, subject, branch, semester } = req.body;
    if (!req.file) return res.status(400).json({ message: 'File is required' });
    if (!title || !title.trim() || !VALID_SUBJECTS.includes(subject)) {
      return res.status(400).json({ message: 'Title and subject are required' });
    }

    const ext = (path.extname(req.file.originalname || '') || '.pdf').toLowerCase();
    const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    const fileUrl = await storage.putPdf(req.file.buffer, filename);
    const extractedText = req.file.mimetype === 'application/pdf'
      ? await storage.extractPdfText(req.file.buffer)
      : '';

    const note = await Note.create({
      title: title.trim(),
      subject,
      branch: (branch && String(branch).trim()) || 'CSE',
      semester: Number(semester) || 5,
      fileUrl,
      fileType: req.file.mimetype,
      extractedText,
      uploadedBy: req.userId,
    });

    await syncNotesToJson(Note);
    res.status(201).json(note);
  } catch (err) {
    console.error('Note upload error');
    res.status(500).json({ message: 'Upload failed: ' + String(err.message || err).slice(0, 140) });
  }
});

// DELETE /api/notes/:id - ADMIN ONLY
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid note id' });
    }
    const note = await Note.findById(req.params.id);
    if (!note) return res.status(404).json({ message: 'Note not found' });

    if (note.fileUrl) await storage.deletePdf(path.basename(note.fileUrl));
    await Note.findByIdAndDelete(req.params.id);
    await syncNotesToJson(Note);
    res.json({ message: 'Note deleted successfully', id: req.params.id });
  } catch (err) {
    console.error('Note delete error');
    res.status(500).json({ message: 'Failed to delete note' });
  }
});

// POST /api/notes/:id/download  — increments count + tracks on user dashboard
router.post('/:id/download', requireAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid note id' });
    }
    const note = await Note.findByIdAndUpdate(req.params.id, { $inc: { downloads: 1 } }, { new: true });
    if (!note) return res.status(404).json({ message: 'Note not found' });

    await User.findByIdAndUpdate(req.userId, { $addToSet: { downloadedNotes: note._id } });
    await syncNotesToJson(Note);
    await syncUsersToJson(User);
    res.json({ fileUrl: note.fileUrl });
  } catch (err) {
    console.error('Note download error');
    res.status(500).json({ message: 'Download tracking failed' });
  }
});

module.exports = router;
