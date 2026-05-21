'use strict';

const { db } = require('../db/db');

function findByQrCode(qr) {
  return db().prepare(`
    SELECT c.*, l.name AS location_name, l.address AS location_address
      FROM chargers c
      JOIN locations l ON l.id = c.location_id
     WHERE c.qr_code = ?
  `).get(qr);
}

function findById(id) {
  return db().prepare(`
    SELECT c.*, l.name AS location_name, l.address AS location_address
      FROM chargers c
      JOIN locations l ON l.id = c.location_id
     WHERE c.id = ?
  `).get(id);
}

function listAll() {
  return db().prepare(`
    SELECT c.*, l.name AS location_name
      FROM chargers c
      JOIN locations l ON l.id = c.location_id
     ORDER BY c.id
  `).all();
}

function listWithCurrentSession() {
  return db().prepare(`
    SELECT c.*, l.name AS location_name,
           s.id AS active_session_id,
           s.expected_end_at AS active_session_end,
           s.minutes_purchased,
           s.user_phone
      FROM chargers c
      JOIN locations l ON l.id = c.location_id
      LEFT JOIN sessions s ON s.charger_id = c.id AND s.activation_status = 'ACTIVE'
     ORDER BY c.id
  `).all();
}

function setStatus(id, status) {
  db().prepare('UPDATE chargers SET status = ? WHERE id = ?').run(status, id);
}

module.exports = {
  findByQrCode,
  findById,
  listAll,
  listWithCurrentSession,
  setStatus,
};
