'use strict';

/**
 * Safety worker.
 *
 * INELMEC's brand depends on the charger NEVER staying energized past the
 * paid time. This worker is the last line of defense if anything else in
 * the system breaks:
 *
 *   - Scans for sessions whose expected_end_at has passed.
 *   - Calls activation.deactivate() for each one.
 *   - If Tuya is unreachable, raises a flag in the audit log so the admin
 *     gets paged. A future enhancement plugs this into email/SMS.
 *
 * Runs on an interval defined by SAFETY_CHECK_INTERVAL_MS.
 */

const config = require('../config');
const activation = require('../services/activation');
const sessions = require('../services/sessions');
const audit = require('../services/audit');
const logger = require('../utils/logger');

let timer = null;
let running = false;

async function tick() {
  if (running) return; // never overlap with the previous tick
  running = true;
  try {
    const cutoff = new Date(Date.now() - config.safety.graceMs).toISOString();
    const expired = sessions.listExpiringBefore(cutoff);

    for (const s of expired) {
      logger.info('Safety worker deactivating expired session', {
        sessionId: s.id, expected_end_at: s.expected_end_at,
      });
      const result = await activation.deactivate(s.id, {
        actor: 'safety_worker',
        reason: 'time_expired',
      });
      if (!result.ok) {
        audit.log({
          sessionId: s.id, chargerId: s.charger_id, actor: 'safety_worker',
          eventType: 'safety.alert',
          payload: { detail: 'deactivation failed; charger may still be energized', reason: result.reason || result.error },
        });
      }
    }
  } catch (err) {
    logger.error('Safety worker tick failed', { error: err.message });
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  logger.info('Safety worker starting', { intervalMs: config.safety.checkIntervalMs });
  timer = setInterval(tick, config.safety.checkIntervalMs);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick };
