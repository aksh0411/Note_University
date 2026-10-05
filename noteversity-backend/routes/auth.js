/**
 * Authentication routes. There is NO user login in this app — the public
 * site runs on anonymous per-browser guest sessions, and the only
 * credential-based login is the admin account below.
 *
 * Sessions are signed JWTs in HttpOnly cookies (never localStorage):
 *   nv_session — guest identity, 7 days
 *   nv_admin   — admin session (typ:'admin'), 8 hours, required by every
 *                admin API via middleware/admin.js
 */
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const { syncUsersToJson } = require('../services/jsonStore');
const { jwtSecret, IS_PROD, GUEST_SESSION_TTL, ADMIN_SESSION_TTL, GUEST_COOKIE_MAX_AGE, ADMIN_COOKIE_MAX_AGE } = require('../config/env');
const { waitForDb, isDbUnavailable } = require('../config/db');

const router = express.Router();

const GUEST_COOKIE = 'nv_session';
const ADMIN_COOKIE = 'nv_admin';
const ADMIN_EMAIL = 'admin@paruluniversity.ac.in';

// Simple in-memory rate limiter (per warm serverless instance; each instance
// also enforces it, and bcrypt cost throttles guessing regardless).
const rateBuckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const hits = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    rateBuckets.set(key, hits);
    return false;
  }
  hits.push(now);
  rateBuckets.set(key, hits);
  if (rateBuckets.size > 10000) {
    for (const [k, v] of rateBuckets) {
      if (v.every((t) => now - t >= windowMs)) rateBuckets.delete(k);
    }
  }
  return true;
}

function setSessionCookie(res, name, token, maxAgeMs) {
  res.cookie(name, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: IS_PROD,
    maxAge: maxAgeMs,
    path: '/',
  });
}

function displayUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    branch: user.branch,
    semester: user.semester,
  };
}

// POST /api/auth/guest-session — silent guest session for the login-free app.
// Creates a fresh Guest user per browser; can never return the admin account.
router.post('/guest-session', async (req, res) => {
  try {
    if (!rateLimit('guest:' + (req.ip || 'unknown'), 60, 10 * 60 * 1000)) {
      return res.status(429).json({ message: 'Too many requests. Please try again later.' });
    }

    const suffix = crypto.randomBytes(4).toString('hex');
    if (mongoose.connection.readyState !== 1 && !(await waitForDb())) {
      const connectDB = require('../config/db');
      await connectDB();
    }
    const user = await User.create({
      name: 'Guest',
      email: `guest-${suffix}@${process.env.ALLOWED_EMAIL_DOMAIN || 'paruluniversity.ac.in'}`,
      branch: 'CSE',
      semester: 5,
      isVerified: true,
    });

    await syncUsersToJson(User);

    const token = jwt.sign({ userId: user._id, typ: 'guest' }, jwtSecret(), {
      expiresIn: GUEST_SESSION_TTL,
    });
    setSessionCookie(res, GUEST_COOKIE, token, GUEST_COOKIE_MAX_AGE);

    res.json({ user: displayUser(user) });
  } catch (err) {
    console.error('Guest session error:', err && err.message ? err.message : err);
    if (isDbUnavailable(err)) {
      return res.status(503).json({ message: 'Database is warming up. Please try again.' });
    }
    res.status(500).json({ message: 'Failed to create guest session' });
  }
});

// GET /api/auth/me — current identity from either session cookie.
// A bad/expired token is 401 (no session); a database that isn't ready yet
// is 503 so clients can retry instead of dropping a valid session.
router.get('/me', async (req, res) => {
  const sessionLookupError = (err) => {
    console.error('Session lookup error:', err && err.message ? err.message : err);
    return res.status(503).json({ message: 'Database is warming up. Please try again.' });
  };
  try {
    const adminToken = req.cookies ? req.cookies[ADMIN_COOKIE] : null;
    if (adminToken) {
      let decoded = null;
      try {
        decoded = jwt.verify(adminToken, jwtSecret());
      } catch (e) { decoded = null; /* bad/expired admin token — fall through to guest */ }
      if (decoded && decoded.typ === 'admin' && decoded.userId) {
        if (mongoose.connection.readyState !== 1) await waitForDb();
        try {
          const admin = await User.findById(decoded.userId);
          if (admin) return res.json({ user: displayUser(admin) });
        } catch (err) {
          if (isDbUnavailable(err)) return sessionLookupError(err);
          throw err;
        }
      }
    }

    const guestToken = req.cookies ? req.cookies[GUEST_COOKIE] : null;
    if (guestToken) {
      let decoded = null;
      try {
        decoded = jwt.verify(guestToken, jwtSecret());
      } catch (e) {
        return res.status(401).json({ message: 'No active session' });
      }
      if (mongoose.connection.readyState !== 1) await waitForDb();
      try {
        const user = await User.findById(decoded.userId);
        if (user) return res.json({ user: displayUser(user) });
        return res.status(401).json({ message: 'No active session' });
      } catch (err) {
        if (isDbUnavailable(err)) return sessionLookupError(err);
        return res.status(401).json({ message: 'No active session' });
      }
    }

    return res.status(401).json({ message: 'No active session' });
  } catch (err) {
    return res.status(401).json({ message: 'No active session' });
  }
});

// POST /api/auth/admin/login — the ONLY credential check in the app.
// Compares against ADMIN_PASSWORD_HASH (bcrypt) from server env; the
// password is never stored, logged, or echoed. Generic errors only.
router.post('/admin/login', async (req, res) => {
  try {
    if (!rateLimit('admin-login:' + (req.ip || 'unknown'), 5, 15 * 60 * 1000)) {
      return res.status(429).json({ message: 'Too many login attempts. Try again in 15 minutes.' });
    }

    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!password || password.length > 256) {
      return res.status(400).json({ message: 'Please enter the admin password.' });
    }

    const hash = (process.env.ADMIN_PASSWORD_HASH || '').trim();
    let match = false;
    if (hash.startsWith('$2')) {
      match = await bcrypt.compare(password, hash).catch(() => false);
    } else if (hash) {
      match = (password === hash);
    }
    if (!match) {
      return res.status(401).json({ message: 'Invalid admin credentials' });
    }

    if (mongoose.connection.readyState !== 1 && !(await waitForDb())) {
      const connectDB = require('../config/db');
      await connectDB();
    }
    let admin = await User.findOne({ email: ADMIN_EMAIL });
    if (!admin) {
      admin = await User.create({
        name: 'Akshay',
        email: ADMIN_EMAIL,
        rollNumber: '2113101',
        branch: 'Computer Science & Engineering',
        semester: 5,
        isVerified: true,
      });
    }

    const token = jwt.sign({ userId: admin._id, typ: 'admin' }, jwtSecret(), {
      expiresIn: ADMIN_SESSION_TTL,
    });
    setSessionCookie(res, ADMIN_COOKIE, token, ADMIN_COOKIE_MAX_AGE);

    res.json({ user: displayUser(admin) });
  } catch (err) {
    console.error('Admin login error');
    res.status(500).json({ message: 'Admin login failed. Please try again.' });
  }
});

// POST /api/auth/admin/logout — clears the admin session cookie.
router.post('/admin/logout', (req, res) => {
  res.clearCookie(ADMIN_COOKIE, { path: '/' });
  res.json({ message: 'Logged out' });
});

module.exports = router;
