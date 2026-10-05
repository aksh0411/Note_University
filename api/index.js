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
const { getReadyConnection } = require('../noteversity-backend/config/db');

module.exports = async (req, res) => {
  try {
    await getReadyConnection();
    return app(req, res);
  } catch (err) {
    console.error('[DB unavailable]:', err && err.message ? err.message : err);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ message: 'Database is temporarily unreachable. Please try again.' }));
  }
};
