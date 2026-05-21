#!/usr/bin/env node
'use strict';

const bcrypt = require('bcryptjs');
const { db } = require('./db');
const { migrate } = require('./migrate');
const config = require('../config');
const logger = require('../utils/logger');

function seed() {
  migrate();
  const d = db();

  // Default admin
  const adminExists = d.prepare('SELECT id FROM admins WHERE email = ?').get(config.admin.defaultEmail);
  if (!adminExists) {
    const hash = bcrypt.hashSync(config.admin.defaultPassword, 10);
    d.prepare(`
      INSERT INTO admins (email, password_hash, display_name, role)
      VALUES (?, ?, ?, 'admin')
    `).run(config.admin.defaultEmail, hash, 'INELMEC Admin');
    logger.info('Default admin created', { email: config.admin.defaultEmail });
  }

  // Demo location + chargers
  const loc = d.prepare('SELECT id FROM locations WHERE name = ?').get('Conjunto Residencial Demo');
  let locationId;
  if (!loc) {
    locationId = d.prepare(`
      INSERT INTO locations (name, address, contact_name, contact_phone)
      VALUES (?, ?, ?, ?)
    `).run(
      'Conjunto Residencial Demo',
      'Cra 7 #45-12, Bogotá',
      'Administración',
      '+57 300 123 4567'
    ).lastInsertRowid;
    logger.info('Demo location created', { id: locationId });
  } else {
    locationId = loc.id;
  }

  const demoChargers = [
    { qr: 'INL-001', name: 'Cargador Parqueadero A1', dev: 'mock-device-001', rate: 6000 },
    { qr: 'INL-002', name: 'Cargador Parqueadero A2', dev: 'mock-device-002', rate: 6000 },
    { qr: 'INL-003', name: 'Cargador Parqueadero B1', dev: 'mock-device-003', rate: 7500 },
    { qr: 'INL-004', name: 'Cargador Visitantes',    dev: 'mock-device-004', rate: 8000 },
  ];

  const upsertCharger = d.prepare(`
    INSERT INTO chargers
      (location_id, qr_code, display_name, tuya_device_id, tuya_switch_dp, rate_cop_per_hour)
    VALUES (?, ?, ?, ?, 'switch_1', ?)
    ON CONFLICT(qr_code) DO NOTHING
  `);

  for (const c of demoChargers) {
    upsertCharger.run(locationId, c.qr, c.name, c.dev, c.rate);
  }
  logger.info('Demo chargers seeded', { count: demoChargers.length });
}

if (require.main === module) {
  try {
    seed();
    process.exit(0);
  } catch (err) {
    logger.error('Seed failed', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

module.exports = { seed };
