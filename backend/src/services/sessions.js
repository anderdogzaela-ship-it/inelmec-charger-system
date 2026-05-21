'use strict';

const { v4: uuid } = require('uuid');
const { db } = require('../db/db');
const audit = require('./audit');

function create({ chargerId, amountCop, minutes, reference, userPhone, userEmail }) {
  const id = uuid();
  db().prepare(`
    INSERT INTO sessions (id, charger_id, amount_cop, minutes_purchased, reference, user_phone, user_email)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, chargerId, amountCop, minutes, reference, userPhone || null, userEmail || null);
  audit.log({
    sessionId: id,
    chargerId,
    eventType: 'session.created',
    payload: { amountCop, minutes, reference },
  });
  return findById(id);
}

function findById(id) {
  return db().prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}

function findByReference(reference) {
  return db().prepare('SELECT * FROM sessions WHERE reference = ?').get(reference);
}

function findByWompiTransactionId(txId) {
  return db().prepare('SELECT * FROM sessions WHERE wompi_transaction_id = ?').get(txId);
}

function updatePaymentStatus(id, status, wompiTransactionId) {
  db().prepare(`
    UPDATE sessions
       SET payment_status = ?,
           wompi_transaction_id = COALESCE(?, wompi_transaction_id),
           updated_at = datetime('now')
     WHERE id = ?
  `).run(status, wompiTransactionId || null, id);
}

function updateActivationStatus(id, status, extras = {}) {
  const fields = ['activation_status = ?', "updated_at = datetime('now')"];
  const params = [status];

  if (extras.activatedAt) { fields.push('activated_at = ?'); params.push(extras.activatedAt); }
  if (extras.expectedEndAt) { fields.push('expected_end_at = ?'); params.push(extras.expectedEndAt); }
  if (extras.completedAt) { fields.push('completed_at = ?'); params.push(extras.completedAt); }
  if (extras.failureReason !== undefined) { fields.push('failure_reason = ?'); params.push(extras.failureReason); }

  params.push(id);
  db().prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`).run(...params);
}

function listActive() {
  return db().prepare(`
    SELECT s.*, c.display_name AS charger_name, c.qr_code
      FROM sessions s
      JOIN chargers c ON c.id = s.charger_id
     WHERE s.activation_status = 'ACTIVE'
     ORDER BY s.activated_at DESC
  `).all();
}

function listRecent({ limit = 50 } = {}) {
  return db().prepare(`
    SELECT s.*, c.display_name AS charger_name, c.qr_code
      FROM sessions s
      JOIN chargers c ON c.id = s.charger_id
     ORDER BY s.created_at DESC
     LIMIT ?
  `).all(limit);
}

function listExpiringBefore(isoTimestamp) {
  return db().prepare(`
    SELECT * FROM sessions
     WHERE activation_status = 'ACTIVE'
       AND expected_end_at <= ?
  `).all(isoTimestamp);
}

module.exports = {
  create,
  findById,
  findByReference,
  findByWompiTransactionId,
  updatePaymentStatus,
  updateActivationStatus,
  listActive,
  listRecent,
  listExpiringBefore,
};
