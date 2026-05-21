'use strict';

/**
 * Activation orchestrator.
 *
 * Owns the state machine that connects a successful Wompi payment to the
 * physical charger turning on (and later off). This is the single place
 * where Wompi state, Tuya state, our DB state, and timers are reconciled.
 *
 * State machine for a session's activation_status:
 *
 *   NOT_STARTED ──(payment APPROVED)──> ACTIVATING
 *   ACTIVATING  ──(Tuya confirms on)──> ACTIVE
 *   ACTIVATING  ──(timeout reached) ──> TIMEOUT          (manual refund path)
 *   ACTIVATING  ──(Tuya offline)    ──> FAILED           (manual refund path)
 *   ACTIVE      ──(time expires)    ──> DEACTIVATING
 *   DEACTIVATING──(Tuya confirms off)─> COMPLETED
 *   DEACTIVATING──(safety force off)─> COMPLETED         (with audit flag)
 *
 * Idempotency: every call into activate() goes through claimActivation()
 * which uses a row lock + the idempotency_keys table to make sure two
 * concurrent webhooks (retry, duplicate, race) only ever produce one
 * activation. This is the fix for the "user pays twice, charger turns
 * on twice" failure mode described to the client.
 */

const tuya = require('./tuya');
const sessions = require('./sessions');
const chargers = require('./chargers');
const audit = require('./audit');
const config = require('../config');
const logger = require('../utils/logger');
const { db } = require('../db/db');

/**
 * Idempotent activation entry point. Safe to call multiple times with
 * the same session — only the first call does work.
 */
async function activate(sessionId) {
  const claimed = claimActivation(sessionId);
  if (!claimed.claimed) {
    logger.info('Activation skipped (idempotent)', { sessionId, reason: claimed.reason });
    return { skipped: true, reason: claimed.reason };
  }

  const session = sessions.findById(sessionId);
  const charger = chargers.findById(session.charger_id);

  if (session.payment_status !== 'APPROVED') {
    sessions.updateActivationStatus(sessionId, 'FAILED', { failureReason: 'payment_not_approved' });
    audit.log({
      sessionId, chargerId: charger.id,
      eventType: 'activation.refused.payment',
      payload: { payment_status: session.payment_status },
    });
    return { activated: false, reason: 'payment_not_approved' };
  }

  audit.log({
    sessionId, chargerId: charger.id,
    eventType: 'activation.start',
    payload: { tuya_device_id: charger.tuya_device_id },
  });

  let result;
  try {
    result = await tuya.activateAndConfirm(
      charger.tuya_device_id,
      charger.tuya_switch_dp,
      { pollIntervalMs: config.activation.pollIntervalMs, timeoutMs: config.activation.timeoutMs },
    );
  } catch (err) {
    logger.error('Tuya activation threw', { sessionId, error: err.message });
    sessions.updateActivationStatus(sessionId, 'FAILED', { failureReason: err.message });
    audit.log({
      sessionId, chargerId: charger.id,
      eventType: 'activation.error',
      payload: { error: err.message },
    });
    return { activated: false, error: err.message };
  }

  if (!result.activated) {
    sessions.updateActivationStatus(sessionId, 'TIMEOUT', {
      failureReason: `tuya did not confirm on within ${config.activation.timeoutMs}ms`,
    });
    audit.log({
      sessionId, chargerId: charger.id,
      eventType: 'activation.timeout',
      payload: { latency_ms: result.latencyMs, last_state: result.finalState },
    });
    return { activated: false, reason: 'timeout', latencyMs: result.latencyMs };
  }

  const now = new Date();
  const expectedEnd = new Date(now.getTime() + session.minutes_purchased * 60_000);

  sessions.updateActivationStatus(sessionId, 'ACTIVE', {
    activatedAt: now.toISOString(),
    expectedEndAt: expectedEnd.toISOString(),
  });
  chargers.setStatus(charger.id, 'occupied');

  audit.log({
    sessionId, chargerId: charger.id,
    eventType: 'activation.confirmed',
    payload: {
      latency_ms: result.latencyMs,
      activated_at: now.toISOString(),
      expected_end_at: expectedEnd.toISOString(),
    },
  });

  return {
    activated: true,
    latencyMs: result.latencyMs,
    activatedAt: now.toISOString(),
    expectedEndAt: expectedEnd.toISOString(),
  };
}

/**
 * Deactivate a session. Called by the safety worker when time expires,
 * or by an admin doing a manual override.
 */
async function deactivate(sessionId, { actor = 'system', reason = 'time_expired' } = {}) {
  const session = sessions.findById(sessionId);
  if (!session) return { ok: false, reason: 'not_found' };
  if (session.activation_status !== 'ACTIVE') {
    return { ok: false, reason: `not_active (${session.activation_status})` };
  }

  const charger = chargers.findById(session.charger_id);
  sessions.updateActivationStatus(sessionId, 'DEACTIVATING');
  audit.log({
    sessionId, chargerId: charger.id, actor,
    eventType: 'deactivation.start',
    payload: { reason },
  });

  let result;
  try {
    result = await tuya.deactivateAndConfirm(
      charger.tuya_device_id,
      charger.tuya_switch_dp,
      { pollIntervalMs: config.activation.pollIntervalMs, timeoutMs: config.activation.timeoutMs },
    );
  } catch (err) {
    logger.error('Tuya deactivation threw', { sessionId, error: err.message });
    audit.log({
      sessionId, chargerId: charger.id, actor,
      eventType: 'deactivation.error',
      payload: { error: err.message },
    });
    return { ok: false, error: err.message };
  }

  if (!result.deactivated) {
    audit.log({
      sessionId, chargerId: charger.id, actor,
      eventType: 'deactivation.timeout',
      payload: { latency_ms: result.latencyMs, last_state: result.finalState },
    });
    // Leave status as DEACTIVATING so the safety worker keeps retrying.
    return { ok: false, reason: 'tuya_timeout' };
  }

  sessions.updateActivationStatus(sessionId, 'COMPLETED', {
    completedAt: new Date().toISOString(),
  });
  chargers.setStatus(charger.id, 'available');

  audit.log({
    sessionId, chargerId: charger.id, actor,
    eventType: 'deactivation.confirmed',
    payload: { latency_ms: result.latencyMs, reason },
  });

  return { ok: true, latencyMs: result.latencyMs };
}

// ---------------------------------------------------------------------------
// Idempotency: claim a session for activation atomically.
// ---------------------------------------------------------------------------
function claimActivation(sessionId) {
  const tx = db().transaction(() => {
    const s = db().prepare('SELECT activation_status FROM sessions WHERE id = ?').get(sessionId);
    if (!s) return { claimed: false, reason: 'not_found' };
    if (s.activation_status !== 'NOT_STARTED') {
      return { claimed: false, reason: `already_${s.activation_status}` };
    }
    // Mark ACTIVATING; a second concurrent call will see this and bail.
    db().prepare(`
      UPDATE sessions
         SET activation_status = 'ACTIVATING',
             updated_at = datetime('now')
       WHERE id = ? AND activation_status = 'NOT_STARTED'
    `).run(sessionId);
    db().prepare(`
      INSERT OR IGNORE INTO idempotency_keys (key, session_id)
      VALUES (?, ?)
    `).run(`activate:${sessionId}`, sessionId);
    return { claimed: true };
  });
  return tx();
}

module.exports = { activate, deactivate };
