'use strict';

const path = require('path');
const express = require('express');
const config = require('./config');
const logger = require('./utils/logger');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const { seed } = require('./db/seed');
const safetyWorker = require('./workers/safety');

const app = express();

// Body parser. NOTE: for production we should preserve the raw body on the
// webhook route so the HMAC can be verified against the EXACT bytes Wompi
// sent, not the re-stringified version. For the MVP, Wompi's signature
// scheme is over field values (not over the raw body), so this is safe.
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('HTTP', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start });
  });
  next();
});

// Static — user-facing and admin UIs.
const rootDir = path.join(__dirname, '..', '..');
app.use('/', express.static(path.join(rootDir, 'frontend')));
app.use('/admin', express.static(path.join(rootDir, 'admin')));

// API
app.use('/api', publicRoutes);
app.use('/api/admin', adminRoutes);

// Health
app.get('/health', (req, res) => {
  res.json({ ok: true, env: config.env, tuya_mock: config.tuya.mock });
});

// 404
app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }));

// Error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'internal_error' });
});

function start() {
  seed();
  // The setInterval-based worker only makes sense on a long-running server.
  // Under Vercel serverless we replace it with lazy safety checks bolted onto
  // the dashboard/session endpoints (see backend/src/services/safety-lazy.js).
  if (!process.env.VERCEL) safetyWorker.start();
  app.listen(config.port, () => {
    logger.info('INELMEC charger system listening', {
      port: config.port,
      env: config.env,
      tuya_mock: config.tuya.mock,
      base_url: config.publicBaseUrl,
    });
    if (config.tuya.mock) {
      logger.warn('Tuya MOCK mode is ENABLED — using in-memory device simulator');
    }
  });
}

if (require.main === module) {
  try {
    start();
  } catch (err) {
    logger.error('Server failed to start', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

module.exports = { app, start };
