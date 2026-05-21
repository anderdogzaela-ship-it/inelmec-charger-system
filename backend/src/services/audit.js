'use strict';

const { db } = require('../db/db');
const logger = require('../utils/logger');

/**
 * Append-only audit logger. NEVER expose UPDATE or DELETE on audit_log.
 * Every state change to a session or charger flows through here, so the
 * trail is reconstructible end-to-end and survives Wompi disputes.
 */
function log({ sessionId = null, chargerId = null, eventType, payload = null, actor = 'system' }) {
  try {
    db().prepare(`
      INSERT INTO audit_log (session_id, charger_id, event_type, payload, actor)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, chargerId, eventType, payload ? JSON.stringify(payload) : null, actor);
  } catch (err) {
    // Audit failures are loud but non-fatal — the main flow must continue.
    logger.error('Audit log write failed', { eventType, error: err.message });
  }
}

function list({ limit = 100, sessionId, chargerId, eventType, since } = {}) {
  const where = [];
  const params = [];
  if (sessionId) { where.push('session_id = ?'); params.push(sessionId); }
  if (chargerId) { where.push('charger_id = ?'); params.push(chargerId); }
  if (eventType) { where.push('event_type = ?'); params.push(eventType); }
  if (since)     { where.push('created_at >= ?'); params.push(since); }
  const sql = `
    SELECT * FROM audit_log
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC LIMIT ?
  `;
  params.push(limit);
  return db().prepare(sql).all(...params).map((r) => ({
    ...r,
    payload: r.payload ? JSON.parse(r.payload) : null,
  }));
}

module.exports = { log, list };
