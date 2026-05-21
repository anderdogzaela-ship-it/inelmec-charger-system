'use strict';

/**
 * Lazy safety check.
 *
 * On a long-running server we rely on workers/safety.js (setInterval) to
 * deactivate expired sessions. On Vercel serverless that interval cannot
 * run, so instead we run a one-shot tick whenever a hot endpoint is hit
 * — the user's status page, the admin dashboard, the charger list.
 *
 * Throttled to once every SAFETY_CHECK_INTERVAL_MS so we don't hammer
 * Tuya every request.
 */

const config = require('../config');
const safetyWorker = require('../workers/safety');

let lastRun = 0;
let inFlight = null;

async function maybeRun() {
  const now = Date.now();
  if (now - lastRun < config.safety.checkIntervalMs) return;
  if (inFlight) return inFlight;
  lastRun = now;
  inFlight = safetyWorker.tick().finally(() => { inFlight = null; });
  return inFlight;
}

/**
 * Express middleware. Fires the safety tick without blocking the response
 * (since failures here are non-critical to the current request).
 */
function middleware(req, res, next) {
  maybeRun().catch(() => {}); // intentionally swallow — not for this request
  next();
}

module.exports = { maybeRun, middleware };
