const fs = require('fs');
const path = require('path');
const User = require('../models/User');
const Note = require('../models/Note');
const Pyq = require('../models/Pyq');
const libraryCatalog = require('./libraryCatalog');
const storage = require('../services/storage');
const { IS_PROD } = require('./env');
const {
  USERS_FILE,
  NOTES_FILE,
  PYQS_FILE,
  readJson,
  syncUsersToJson,
  syncNotesToJson,
  syncPyqsToJson,
} = require('../services/jsonStore');

// Subjects retired from the platform — purged on every boot so only the 6
// catalog subjects (DAA, AI, AWS, EPJ, TOC, QR) remain.
const RETIRED_SUBJECTS = ['DBMS', 'OS', 'CN', 'DM'];

// Map of catalog subject code to upload filename prefix
const SUBJECT_PREFIX = {
  DAA: 'DAA_',
  AI: 'AI_',
  AWS: 'AWS_',
  EPJ: 'EPJ_',
  TOC: 'TOC_',
  QR: 'QR_'
};

// Extracted-text cache so repeated dev boots don't re-parse 78 PDFs
const TEXT_CACHE_FILE = path.join(__dirname, '..', 'data', 'extracted-text.json');
let textCache = null;
function loadTextCache() {
  if (textCache) return textCache;
  try { textCache = JSON.parse(fs.readFileSync(TEXT_CACHE_FILE, 'utf8')); } catch (e) { textCache = {}; }
  return textCache;
}
function saveTextCache() {
  if (IS_PROD) return; // no filesystem writes in production
  try { fs.writeFileSync(TEXT_CACHE_FILE, JSON.stringify(textCache)); } catch (e) { /* best effort */ }
}

function extractSubjectFromFilename(filename) {
  const upper = filename.toUpperCase();
  for (const [code, prefix] of Object.entries(SUBJECT_PREFIX)) {
    if (upper.startsWith(prefix)) return code;
  }
  return null;
}

function makeTitleFromFilename(filename) {
  return filename.replace(/\.pdf$/i, '').replace(/_/g, ' ');
}

/**
 * Ensure the PDF is available in the active storage backend and return its
 * extracted text. Disk path only exists locally; on a fresh GridFS database
 * (sync-cloud / production) the file is pushed from the local uploads folder.
 */
async function ensurePdfAndText(filename) {
  const diskPath = path.join(__dirname, '..', 'uploads', filename);
  const onDisk = fs.existsSync(diskPath);

  if (storage.USE_GRIDFS) {
    if (!(await storage.hasPdf(filename))) {
      if (!onDisk) return { ok: false, text: '' };
      const buffer = fs.readFileSync(diskPath);
      await storage.putPdf(buffer, filename);
    }
  } else if (!onDisk) {
    return { ok: false, text: '' };
  }

  // Extracted text: reuse cache unless the file changed
  const cache = loadTextCache();
  const mtime = onDisk ? fs.statSync(diskPath).mtimeMs : 0;
  const cached = cache[filename];
  if (cached && cached.mtime === mtime && cached.text) {
    return { ok: true, text: cached.text };
  }
  if (!onDisk) {
    return { ok: true, text: cached && cached.text ? cached.text : '' };
  }
  const buffer = fs.readFileSync(diskPath);
  const text = await storage.extractPdfText(buffer);
  cache[filename] = { mtime, text };
  saveTextCache();
  return { ok: true, text };
}

async function seedInitialData() {
  try {
    // ── 1. USERS: Restore from users.json (dev) or seed defaults ──
    const existingUsersInJson = readJson(USERS_FILE, []);
    if (existingUsersInJson && existingUsersInJson.length > 0) {
      console.log(`[JSON Store] Restoring ${existingUsersInJson.length} users from users.json...`);
      for (const u of existingUsersInJson) {
        // Legacy fields from older versions are dropped silently
        const { passwordHash, otpHash, otpExpiresAt, ...clean } = u;
        await User.findByIdAndUpdate(u._id, clean, { upsert: true, new: true, setDefaultsOnInsert: true });
      }
    } else {
      // System admin record (upload attribution only — admin auth is a
      // password-hash env var, never a user-account password)
      let demoUser = await User.findOne({ email: 'admin@paruluniversity.ac.in' });
      if (!demoUser) {
        demoUser = await User.create({
          name: 'Akshay',
          email: 'admin@paruluniversity.ac.in',
          rollNumber: '2113101',
          branch: 'Computer Science & Engineering',
          semester: 5,
          isVerified: true,
        });
        console.log('✓ System admin record seeded');
      }

      let peerUser = await User.findOne({ email: 'karan@paruluniversity.ac.in' });
      if (!peerUser) {
        peerUser = await User.create({
          name: 'Karan M.',
          email: 'karan@paruluniversity.ac.in',
          rollNumber: '2113102',
          branch: 'CSE',
          semester: 5,
          isVerified: true,
        });
      }

      let facultyUser = await User.findOne({ email: 'faculty@paruluniversity.ac.in' });
      if (!facultyUser) {
        facultyUser = await User.create({
          name: 'Faculty Notes',
          email: 'faculty@paruluniversity.ac.in',
          branch: 'CSE',
          semester: 5,
          isVerified: true,
        });
      }

      await syncUsersToJson(User);
    }

    const demoUser = await User.findOne({ email: 'admin@paruluniversity.ac.in' });
    const facultyUser = (await User.findOne({ email: 'faculty@paruluniversity.ac.in' })) || demoUser;

    // ── 2. NOTES: Restore from notes.json (dev) or seed the course library ──
    const existingNotesInJson = readJson(NOTES_FILE, []);
    if (existingNotesInJson && existingNotesInJson.length > 0) {
      console.log(`[JSON Store] Restoring ${existingNotesInJson.length} notes from notes.json...`);
      let backfilled = 0;
      for (const n of existingNotesInJson) {
        // Backfill extracted text for docs seeded before the extractedText field existed
        if ((!n.extractedText || n.extractedText.length < 200) && IS_PROD !== true) {
          const filename = path.basename(n.fileUrl || '');
          const { text } = await ensurePdfAndText(filename);
          if (text) { n.extractedText = text; backfilled++; }
        }
        await Note.findByIdAndUpdate(n._id, n, { upsert: true, new: true });
      }
      if (backfilled) {
        console.log(`✓ Backfilled extracted text into ${backfilled} notes`);
        await syncNotesToJson(Note);
      }
    } else {
      const noteCount = await Note.countDocuments();
      if (noteCount === 0) {
        // Existence filter: only seed catalog entries whose PDF actually exists
        const availableNotes = [];
        for (const entry of libraryCatalog.notes) {
          const { ok, text } = await ensurePdfAndText(entry.file);
          if (ok) availableNotes.push({ ...entry, extractedText: text });
        }
        if (availableNotes.length < libraryCatalog.notes.length) {
          console.log(`[Seeder] Skipping ${libraryCatalog.notes.length - availableNotes.length} catalog notes with missing PDFs`);
        }
        const initialNotes = availableNotes.map((entry, i) => ({
          title: entry.title,
          subject: entry.subject,
          branch: 'CSE',
          semester: 5,
          fileUrl: `/uploads/${entry.file}`,
          fileType: 'application/pdf',
          extractedText: entry.extractedText || '',
          uploadedBy: facultyUser._id,
          downloads: 40 + ((i * 37) % 260),
        }));
        const createdNotes = await Note.insertMany(initialNotes);
        if (createdNotes.length) {
          demoUser.downloadedNotes = [createdNotes[0]._id, createdNotes[1]._id, createdNotes[2]._id].filter(Boolean);
          await demoUser.save();
        }
        await syncUsersToJson(User);
        await syncNotesToJson(Note);
        console.log(`✓ Seeded ${createdNotes.length} notes (with extracted text)`);
      }
    }

    // ── 3. PYQs: Restore from pyqs.json (dev) or seed the papers/question banks ──
    const existingPyqsInJson = readJson(PYQS_FILE, []);
    if (existingPyqsInJson && existingPyqsInJson.length > 0) {
      console.log(`[JSON Store] Restoring ${existingPyqsInJson.length} PYQs from pyqs.json...`);
      let backfilled = 0;
      for (const p of existingPyqsInJson) {
        if ((!p.extractedText || p.extractedText.length < 200) && IS_PROD !== true) {
          const filename = path.basename(p.fileUrl || '');
          const { text } = await ensurePdfAndText(filename);
          if (text) { p.extractedText = text; backfilled++; }
        }
        await Pyq.findByIdAndUpdate(p._id, p, { upsert: true, new: true });
      }
      if (backfilled) {
        console.log(`✓ Backfilled extracted text into ${backfilled} PYQs`);
        await syncPyqsToJson(Pyq);
      }
    } else {
      const pyqCount = await Pyq.countDocuments();
      if (pyqCount === 0) {
        const availablePyqs = [];
        for (const entry of libraryCatalog.pyqs) {
          const { ok, text } = await ensurePdfAndText(entry.file);
          if (ok) availablePyqs.push({ ...entry, extractedText: text });
        }
        if (availablePyqs.length < libraryCatalog.pyqs.length) {
          console.log(`[Seeder] Skipping ${libraryCatalog.pyqs.length - availablePyqs.length} catalog PYQs with missing PDFs`);
        }
        const initialPyqs = availablePyqs.map((entry, i) => ({
          title: entry.title,
          subject: entry.subject,
          branch: 'CSE',
          semester: 5,
          year: entry.year,
          examType: entry.examType,
          isSolved: entry.isSolved,
          fileUrl: `/uploads/${entry.file}`,
          extractedText: entry.extractedText || '',
          uploadedBy: demoUser._id,
          downloads: 60 + ((i * 53) % 340),
        }));
        const createdPyqs = await Pyq.insertMany(initialPyqs);
        if (createdPyqs.length) {
          demoUser.downloadedPyqs = [createdPyqs[0]._id, createdPyqs[1]._id].filter(Boolean);
          await demoUser.save();
        }
        await syncUsersToJson(User);
        await syncPyqsToJson(Pyq);
        console.log(`✓ Seeded ${createdPyqs.length} PYQs (with extracted text)`);
      }
    }

    // ── 3b. Purge retired subjects (only-6-subjects policy) ──
    const purgedNotes = await Note.deleteMany({
      $or: [{ subject: { $in: RETIRED_SUBJECTS } }, { fileUrl: '/uploads/sample-document.pdf' }],
    });
    const purgedPyqs = await Pyq.deleteMany({
      $or: [{ subject: { $in: RETIRED_SUBJECTS } }, { fileUrl: '/uploads/sample-document.pdf' }],
    });
    if (purgedNotes.deletedCount || purgedPyqs.deletedCount) {
      await syncNotesToJson(Note);
      await syncPyqsToJson(Pyq);
      console.log(`✓ Purged retired content: ${purgedNotes.deletedCount} notes, ${purgedPyqs.deletedCount} PYQs`);
    }

    // ── 3c. Auto-import dropped-in PDFs (local disk mode only) ──
    if (!storage.USE_GRIDFS && fs.existsSync(storage.UPLOADS_DIR)) {
      const allFiles = fs.readdirSync(storage.UPLOADS_DIR).filter(f => f.toLowerCase().endsWith('.pdf'));
      let importedNotes = 0, importedPyqs = 0;

      for (const file of allFiles) {
        if (file === 'sample-document.pdf') continue;
        const inCatalog = libraryCatalog.notes.some(n => n.file === file) || libraryCatalog.pyqs.some(p => p.file === file);
        if (inCatalog) continue;

        const noteExists = await Note.findOne({ fileUrl: `/uploads/${file}` });
        const pyqExists = await Pyq.findOne({ fileUrl: `/uploads/${file}` });
        if (noteExists || pyqExists) continue;

        const subject = extractSubjectFromFilename(file);
        if (!subject) continue;

        const title = makeTitleFromFilename(file);
        const fileUrl = `/uploads/${file}`;
        const { text } = await ensurePdfAndText(file);
        const uploadedBy = facultyUser._id;

        const looksLikePyq = /mid|exam|paper|qb|question.bank|solved/i.test(file);
        if (looksLikePyq) {
          await Pyq.create({
            title, subject, branch: 'CSE', semester: 5,
            year: new Date().getFullYear(),
            examType: /mid/i.test(file) ? 'MidSem1' : 'EndSem',
            isSolved: /solved/i.test(file),
            fileUrl, extractedText: text || '', uploadedBy, downloads: 0,
          });
          importedPyqs++;
          console.log(`[Auto-import] PYQ added: ${title}`);
        } else {
          await Note.create({
            title, subject, branch: 'CSE', semester: 5,
            fileUrl, fileType: 'application/pdf', extractedText: text || '', uploadedBy, downloads: 0,
          });
          importedNotes++;
          console.log(`[Auto-import] Note added: ${title}`);
        }
      }

      if (importedNotes || importedPyqs) {
        await syncNotesToJson(Note);
        await syncPyqsToJson(Pyq);
        console.log(`✓ Auto-imported ${importedNotes} notes, ${importedPyqs} PYQs from uploads/`);
      }
    }
  } catch (err) {
    console.warn('[Seeder warning]:', err.message);
  }
}

module.exports = seedInitialData;
