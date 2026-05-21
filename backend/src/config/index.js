'use strict';

require('dotenv').config();

function required(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be an integer`);
  return n;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: int('PORT', 3000),
  publicBaseUrl: required('PUBLIC_BASE_URL', 'http://localhost:3000'),

  db: {
    // On Vercel serverless, the only writable path is /tmp (per-instance,
    // ephemeral). Anywhere else we use ./data which is persistent.
    path: required('DB_PATH', process.env.VERCEL ? '/tmp/inelmec.db' : './data/inelmec.db'),
  },

  jwt: {
    secret: required('JWT_SECRET', 'dev-secret-do-not-use-in-prod'),
    expiresIn: '12h',
  },

  admin: {
    defaultEmail: required('ADMIN_DEFAULT_EMAIL', 'admin@inelmec.com'),
    defaultPassword: required('ADMIN_DEFAULT_PASSWORD', 'inelmec2026'),
  },

  wompi: {
    baseUrl: required('WOMPI_BASE_URL', 'https://sandbox.wompi.co/v1'),
    publicKey: required('WOMPI_PUBLIC_KEY', 'pub_test_demo'),
    privateKey: required('WOMPI_PRIVATE_KEY', 'prv_test_demo'),
    eventsSecret: required('WOMPI_EVENTS_SECRET', 'test_events_secret_demo'),
    integritySecret: required('WOMPI_INTEGRITY_SECRET', 'test_integrity_secret_demo'),
  },

  tuya: {
    baseUrl: required('TUYA_BASE_URL', 'https://openapi.tuyaus.com'),
    accessId: required('TUYA_ACCESS_ID', 'mock-access-id'),
    accessSecret: required('TUYA_ACCESS_SECRET', 'mock-access-secret'),
    // Always force mock on Vercel — no real Tuya calls from a demo deploy.
    mock: process.env.VERCEL ? true : bool('TUYA_MOCK', true),
  },

  activation: {
    pollIntervalMs: int('ACTIVATION_POLL_INTERVAL_MS', 500),
    timeoutMs: int('ACTIVATION_TIMEOUT_MS', 30000),
  },

  safety: {
    checkIntervalMs: int('SAFETY_CHECK_INTERVAL_MS', 15000),
    graceMs: int('SAFETY_GRACE_MS', 10000),
  },
};

module.exports = config;
