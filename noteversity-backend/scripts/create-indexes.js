/**
 * One-time database index creation. mongoose runs with autoIndex:false in
 * production (serverless-safe), so indexes are created explicitly here.
 *
 * Usage (from noteversity-backend/):
 *   MONGO_URI="mongodb+srv://user:pass@cluster/noteversity" node scripts/create-indexes.js
 *
 * Safe to re-run — createIndex is a no-op when the index already exists.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
require('tls').DEFAULT_MAX_VERSION = 'TLSv1.2';
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri || uri.includes('127.0.0.1')) {
    console.error('[!] Set MONGO_URI to your production Atlas connection string.');
    process.exit(1);
  }

  await connectDB();
  const db = mongoose.connection.db;

  const jobs = [
    ['users', { email: 1 }, { unique: true }],
    ['chatentries', { userId: 1, createdAt: -1 }, {}],
    ['notes', { createdAt: -1 }, {}],
    ['notes', { subject: 1 }, {}],
    ['pyqs', { year: -1 }, {}],
    ['pyqs', { subject: 1 }, {}],
  ];

  for (const [collection, keys, opts] of jobs) {
    const name = `${keys.email ? 'email' : keys.userId ? 'userId_1_createdAt_-1' : Object.entries(keys).map(([k, v]) => k + '_' + v).join('_')}`;
    try {
      await db.collection(collection).createIndex(keys, opts);
      console.log(`✓ ${collection}: ${name}${opts.unique ? ' (unique)' : ''}`);
    } catch (err) {
      console.warn(`! ${collection}: ${name} — ${err.message}`);
    }
  }

  console.log('\n✓ Index creation complete.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[!] Index creation failed:', err.message);
  process.exit(1);
});
