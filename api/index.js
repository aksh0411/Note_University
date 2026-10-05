/**
 * Vercel serverless entry point. Keeps a cached MongoDB connection across
 * invocations, then delegates every request to Express.
 */

// Stubs for pdf-parse browser globals on headless Linux
globalThis.DOMMatrix = globalThis.DOMMatrix || class DOMMatrix {};
globalThis.ImageData = globalThis.ImageData || class ImageData {};
globalThis.Path2D = globalThis.Path2D || class Path2D {};

const mongoose = require('mongoose');

// Configure Mongoose BEFORE compiling models or routes
mongoose.set('bufferCommands', false);
mongoose.set('autoIndex', false);

const app = require('../noteversity-backend/app');
const { waitForDb } = require('../noteversity-backend/config/db');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/noteversity';

const CONNECT_OPTS = {
  bufferCommands: false,
  autoIndex: false,
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  maxPoolSize: 10,
};

let cached = global.mongoose;
if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

async function ensureDb() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;

  if (!cached.promise || mongoose.connection.readyState === 0) {
    cached.promise = mongoose.connect(MONGO_URI, CONNECT_OPTS).then((m) => {
      console.log('MongoDB connected successfully');
      return m;
    });
  }

  try {
    cached.conn = await cached.promise;
  } catch (err) {
    cached.promise = null;
    cached.conn = null;
    console.error('MongoDB connect error:', err.message);
    throw err;
  }

  // An existing connection can be mid-reconnect (readyState 2) after an idle
  // gap — wait for it instead of serving requests against a half-open socket
  // (which surfaced as "insertOne before initial connection is complete").
  if (mongoose.connection.readyState !== 1) {
    const ready = await waitForDb(10000);
    if (!ready) throw new Error('MongoDB connection did not become ready in time');
  }

  return mongoose.connection;
}

module.exports = async (req, res) => {
  try {
    await ensureDb();
    return app(req, res);
  } catch (err) {
    console.error('[DB unavailable]:', err && err.message ? err.message : err);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ message: 'Database is temporarily unreachable. Please try again.' }));
  }
};
