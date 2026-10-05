const mongoose = require('mongoose');
const seedInitialData = require('./seeder');
const { IS_PROD } = require('./env');

// Disable command buffering and automatic background indexing in serverless environments
mongoose.set('bufferCommands', false);
mongoose.set('autoIndex', false);

function maskedUri(uri) {
  // Never log embedded credentials — show scheme + host + db only
  try {
    const parsed = new URL(uri);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? ':' + parsed.port : ''}${parsed.pathname}`;
  } catch (e) {
    return '<unparseable mongo uri>';
  }
}

async function connectDB() {
  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }

  const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/noteversity';

  try {
    console.log(`Connecting to MongoDB at ${maskedUri(mongoUri)}...`);
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: IS_PROD ? 10000 : 2500,
      socketTimeoutMS: 45000,
      maxPoolSize: IS_PROD ? 5 : 20,
      // See api/index.js — frozen serverless sockets die on Atlas's side;
      // expire them client-side so each cold invocation gets a fresh one.
      maxIdleTimeMS: IS_PROD ? 30000 : 0,
      heartbeatFrequencyMS: IS_PROD ? 5000 : 10000,
      bufferCommands: false,
      autoIndex: false,
    });
    console.log('MongoDB connected successfully');
    // Production: connect only — data is provisioned by scripts/sync_cloud.py.
    // Running the seeder per lambda boot destabilizes the connection.
    if (!IS_PROD) {
      await seedInitialData();
    }
    return mongoose;
  } catch (err) {
    if (IS_PROD) {
      // Serverless has no persistent disk — the in-memory fallback cannot save us.
      console.error('MongoDB connection failed in production:', err.message);
      throw err;
    }
    console.warn(`Could not connect to external MongoDB (${err.message}).`);
    console.log('Starting embedded in-memory MongoDB instance for development...');
    try {
      const { MongoMemoryServer } = require('mongodb-memory-server');
      const mongod = await MongoMemoryServer.create();
      const uri = mongod.getUri();
      await mongoose.connect(uri);
      console.log(`Embedded MongoDB started and connected at ${maskedUri(uri)}`);
      await seedInitialData();
    } catch (memErr) {
      console.error('Failed to start embedded MongoDB:', memErr.message);
      process.exit(1);
    }
  }
}

/**
 * Wait for an existing connection attempt to reach the ready state instead of
 * racing it with a second connect() call (serverless cold starts often have a
 * connection already in progress — readyState 2).
 */
async function waitForDb(maxMs = 8000) {
  const start = Date.now();
  while (mongoose.connection.readyState !== 1 && Date.now() - start < maxMs) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return mongoose.connection.readyState === 1;
}

/** True when a failure is "database not reachable yet" rather than bad input. */
function isDbUnavailable(err) {
  if (mongoose.connection.readyState !== 1) return true;
  if (!err) return false;
  return [
    'MongoServerSelectionError',
    'MongooseServerSelectionError',
    'MongoNetworkError',
    'MongoNetworkTimeoutError',
    'TopologyDescriptionChangedError',
  ].includes(err.name) || /topology|connection/i.test(err.message || '');
}

/**
 * Single source of truth for getting a USABLE database connection in
 * serverless environments. Handles the three failure modes we have observed:
 *   1. no connection yet            → connect
 *   2. connection attempt in flight → wait for it
 *   3. zombie topology (an old pool stuck "reconnecting" after Vercel froze
 *      the instance and Atlas dropped its sockets) → hard disconnect and dial
 *      a brand-new connection instead of waiting forever.
 */
let connectPromise = null;

function connectOptions() {
  return {
    serverSelectionTimeoutMS: IS_PROD ? 10000 : 2500,
    socketTimeoutMS: 45000,
    maxPoolSize: IS_PROD ? 5 : 20,
    // Frozen serverless sockets die on Atlas's side; expire them client-side
    // so each thawed instance uses a fresh connection.
    maxIdleTimeMS: IS_PROD ? 30000 : 0,
    heartbeatFrequencyMS: IS_PROD ? 5000 : 10000,
    bufferCommands: false,
    autoIndex: false,
  };
}

async function getReadyConnection(maxWaitMs = 9000) {
  if (mongoose.connection.readyState === 1) return true;

  if (mongoose.connection.readyState === 0 || !connectPromise) {
    const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/noteversity';
    connectPromise = mongoose.connect(mongoUri, connectOptions());
    try {
      await connectPromise;
    } catch (err) {
      connectPromise = null;
      throw err;
    }
  } else {
    try {
      await connectPromise;
    } catch (e) { connectPromise = null; }
  }

  if (mongoose.connection.readyState === 1) return true;

  // Not ready yet — give an in-flight reconnect a short window…
  const ready = await waitForDb(Math.min(4000, maxWaitMs));
  if (ready) return true;

  // …then hard-reset the zombie topology and dial fresh.
  console.warn('[DB] Connection stuck in state', mongoose.connection.readyState, '— hard-resetting');
  try { await mongoose.disconnect(); } catch (e) { /* ignore */ }
  connectPromise = null;
  const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/noteversity';
  connectPromise = mongoose.connect(mongoUri, connectOptions());
  try {
    await connectPromise;
  } catch (err) {
    connectPromise = null;
    throw err;
  }
  return mongoose.connection.readyState === 1;
}

module.exports = connectDB;
module.exports.waitForDb = waitForDb;
module.exports.isDbUnavailable = isDbUnavailable;
module.exports.getReadyConnection = getReadyConnection;
