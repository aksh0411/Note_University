const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const path = require('path');
const Pyq = require('../models/Pyq');
const User = require('../models/User');
const requireAuth = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');
const upload = require('../middleware/upload');
const storage = require('../services/storage');
const { syncPyqsToJson, syncUsersToJson } = require('../services/jsonStore');
const { isDbUnavailable } = require('../config/db');

const router = express.Router();

const VALID_SUBJECTS = ['DAA', 'AI', 'AWS', 'EPJ', 'TOC', 'QR'];

// GET /api/pyqs?subject=DAA&year=2024&examType=EndSem — cards only; extractedText
// is the chatbot's RAG corpus and is deliberately excluded from list payloads.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { subject, semester, branch, year, examType, search } = req.query;
    const filter = {};
    if (subject) filter.subject = subject;
    if (semester && !Number.isNaN(Number(semester))) filter.semester = Number(semester);
    if (branch) filter.branch = branch;
    if (year && !Number.isNaN(Number(year))) filter.year = Number(year);
    if (examType) filter.examType = examType;
    if (search) {
      const rx = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      filter.$or = [{ title: rx }, { extractedText: rx }];
    }

    const pyqs = await Pyq.find(filter).select('-extractedText').populate('uploadedBy', 'name').sort({ year: -1 });
    res.json(pyqs);
  } catch (err) {
    console.error('PYQ list error:', err && err.message ? err.message : err);
    if (isDbUnavailable(err)) return res.status(503).json({ message: 'Database is warming up. Please try again.' });
    res.status(500).json({ message: 'Failed to load PYQs' });
  }
});

// POST /api/pyqs - ADMIN ONLY
router.post('/', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  try {
    const { title, subject, branch, semester, year, examType, isSolved } = req.body;
    if (!req.file) return res.status(400).json({ message: 'File is required' });
    if (!title || !title.trim() || !VALID_SUBJECTS.includes(subject)) {
      return res.status(400).json({ message: 'Title and subject are required' });
    }
    const yearNum = Number(year);
    if (!Number.isInteger(yearNum) || yearNum < 2000 || yearNum > 2100) {
      return res.status(400).json({ message: 'A valid year is required' });
    }

    const ext = (path.extname(req.file.originalname || '') || '.pdf').toLowerCase();
    const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    const fileUrl = await storage.putPdf(req.file.buffer, filename);
    const extractedText = req.file.mimetype === 'application/pdf'
      ? await storage.extractPdfText(req.file.buffer)
      : '';

    const pyq = await Pyq.create({
      title: title.trim(),
      subject,
      branch: (branch && String(branch).trim()) || 'CSE',
      semester: Number(semester) || 5,
      year: yearNum,
      examType,
      isSolved: isSolved === 'true',
      fileUrl,
      extractedText,
      uploadedBy: req.userId,
    });

    await syncPyqsToJson(Pyq);
    res.status(201).json(pyq);
  } catch (err) {
    console.error('PYQ upload error');
    res.status(500).json({ message: 'Upload failed: ' + String(err.message || err).slice(0, 140) });
  }
});

// DELETE /api/pyqs/:id - ADMIN ONLY
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid PYQ id' });
    }
    const pyq = await Pyq.findById(req.params.id);
    if (!pyq) return res.status(404).json({ message: 'PYQ not found' });

    if (pyq.fileUrl) await storage.deletePdf(path.basename(pyq.fileUrl));
    await Pyq.findByIdAndDelete(req.params.id);
    await syncPyqsToJson(Pyq);
    res.json({ message: 'PYQ deleted successfully', id: req.params.id });
  } catch (err) {
    console.error('PYQ delete error');
    res.status(500).json({ message: 'Failed to delete PYQ' });
  }
});

// POST /api/pyqs/:id/download
router.post('/:id/download', requireAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid PYQ id' });
    }
    const pyq = await Pyq.findByIdAndUpdate(req.params.id, { $inc: { downloads: 1 } }, { new: true });
    if (!pyq) return res.status(404).json({ message: 'PYQ not found' });

    await User.findByIdAndUpdate(req.userId, { $addToSet: { downloadedPyqs: pyq._id } });
    await syncPyqsToJson(Pyq);
    await syncUsersToJson(User);
    res.json({ fileUrl: pyq.fileUrl });
  } catch (err) {
    console.error('PYQ download error');
    res.status(500).json({ message: 'Download tracking failed' });
  }
});

module.exports = router;
