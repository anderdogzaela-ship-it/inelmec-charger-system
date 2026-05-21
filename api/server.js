'use strict';

/**
 * Vercel serverless entry point.
 *
 * vercel.json rewrites every request (`/(.*)`) to this function, so the
 * existing Express app handles both API routes AND static files for the
 * frontend + admin panel from a single function.
 *
 * Three Vercel-specific behaviors:
 *
 *  1. The SQLite file lives in /tmp (the only writable path in serverless).
 *     /tmp is per-instance and ephemeral, which is desirable here: every
 *     cold start re-seeds and the test demo always opens with a clean,
 *     presentable state.
 *
 *  2. The setInterval-based safety worker cannot run (no long-lived process).
 *     We use safetyLazy.middleware on the hot endpoints instead; it runs the
 *     same `tick()` at most once per SAFETY_CHECK_INTERVAL_MS.
 *
 *  3. TUYA_MOCK is forced to true (see config). The whole demo flow works
 *     against the in-memory device simulator, with realistic 1-3s latency.
 */

// Ensure these defaults are set BEFORE requiring config — Vercel sets
// `process.env.VERCEL = '1'` automatically, but we re-affirm here so the
// behavior is also reproducible when running `vercel dev` locally.
process.env.VERCEL = process.env.VERCEL || '1';
process.env.DB_PATH = process.env.DB_PATH || '/tmp/inelmec.db';
process.env.TUYA_MOCK = 'true';
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'http://localhost:3000';

const { app } = require('../backend/src/server');
const { seed } = require('../backend/src/db/seed');
const logger = require('../backend/src/utils/logger');

// Seed runs on the first request after a cold start. `seed()` is idempotent
// — it ONLY creates rows that don't already exist, so re-running it is safe.
let initialized = false;
function init() {
  if (initialized) return;
  try {
    seed();
    initialized = true;
    logger.info('Vercel cold start: schema + demo data ready', { db: process.env.DB_PATH });
  } catch (err) {
    logger.error('Vercel init failed', { error: err.message, stack: err.stack });
    throw err;
  }
}

module.exports = (req, res) => {
  init();
  return app(req, res);
};
