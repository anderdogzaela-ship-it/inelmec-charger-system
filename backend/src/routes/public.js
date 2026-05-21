'use strict';

const express = require('express');
const { v4: uuid } = require('uuid');
const chargers = require('../services/chargers');
const sessions = require('../services/sessions');
const wompi = require('../services/wompi');
const payment = require('../services/payment');
const audit = require('../services/audit');
const safetyLazy = require('../services/safety-lazy');
const config = require('../config');
const logger = require('../utils/logger');
const { db } = require('../db/db');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /api/charger/:qr
// Public lookup for the charger landing page after a QR scan.
// ---------------------------------------------------------------------------
router.get('/charger/:qr', (req, res) => {
  const c = chargers.findByQrCode(req.params.qr);
  if (!c) return res.status(404).json({ error: 'charger_not_found' });
  // Detect placeholder Wompi credentials so the frontend can gray out the
  // "Pagar con Wompi" button (which would otherwise dead-end at Wompi's
  // checkout with "no se pudo cargar la información del undefined").
  const wompiConfigured = !/(^pub_(test|prod)_demo$|x{4,}|^pub_test_xxx)/i.test(config.wompi.publicKey);
  res.json({
    qr_code: c.qr_code,
    display_name: c.display_name,
    location_name: c.location_name,
    location_address: c.location_address,
    rate_cop_per_hour: c.rate_cop_per_hour,
    min_minutes: c.min_minutes,
    max_minutes: c.max_minutes,
    status: c.status,
    online: !!c.online,
    // dev_mode is true when this is a non-prod demo environment. Tuya mock
    // is the cleanest indicator: any real production deploy uses real Tuya.
    dev_mode: config.tuya.mock || config.env !== 'production',
    wompi_configured: wompiConfigured,
  });
});

// ---------------------------------------------------------------------------
// POST /api/payment/initiate
// Creates a session in PENDING state and returns a Wompi Checkout URL.
// ---------------------------------------------------------------------------
router.post('/payment/initiate', (req, res) => {
  const { qr_code, minutes, user_phone, user_email } = req.body || {};
  if (!qr_code) return res.status(400).json({ error: 'qr_code_required' });

  const charger = chargers.findByQrCode(qr_code);
  if (!charger) return res.status(404).json({ error: 'charger_not_found' });
  if (charger.status !== 'available') {
    return res.status(409).json({ error: 'charger_unavailable', status: charger.status });
  }

  const mins = Number.parseInt(minutes, 10);
  if (!mins || mins < charger.min_minutes || mins > charger.max_minutes) {
    return res.status(400).json({
      error: 'invalid_minutes',
      min: charger.min_minutes,
      max: charger.max_minutes,
    });
  }

  const amountCop = Math.round((charger.rate_cop_per_hour * mins) / 60);
  const reference = `INL-${charger.qr_code}-${Date.now()}-${uuid().slice(0, 8)}`;

  const session = sessions.create({
    chargerId: charger.id,
    amountCop,
    minutes: mins,
    reference,
    userPhone: user_phone,
    userEmail: user_email,
  });

  const checkoutUrl = wompi.buildCheckoutUrl({
    reference,
    amountInCents: amountCop * 100,
    redirectUrl: `${config.publicBaseUrl}/status.html?session=${session.id}`,
    customerEmail: user_email,
  });

  res.json({
    session_id: session.id,
    reference,
    amount_cop: amountCop,
    minutes: mins,
    checkout_url: checkoutUrl,
  });
});

// ---------------------------------------------------------------------------
// POST /api/payment/webhook
// Wompi sends transaction.updated events here. We MUST verify the HMAC.
// ---------------------------------------------------------------------------
router.post('/payment/webhook', async (req, res) => {
  const raw = req.body; // parsed JSON; we re-stringify for storage
  const valid = wompi.verifyEventSignature(raw);

  const rec = db().prepare(`
    INSERT INTO webhook_events (provider, event_type, signature_valid, raw_payload)
    VALUES ('wompi', ?, ?, ?)
  `).run(raw.event || 'unknown', valid ? 1 : 0, JSON.stringify(raw));

  if (!valid) {
    logger.warn('Wompi webhook signature INVALID', { event: raw.event });
    return res.status(401).json({ error: 'invalid_signature' });
  }

  // Respond 200 first so Wompi does not retry, then process. We accept the
  // small risk because the handler is fully idempotent.
  res.status(200).json({ ok: true });

  payment.handleWompiEvent(raw)
    .then((result) => {
      db().prepare('UPDATE webhook_events SET processed = 1 WHERE id = ?').run(rec.lastInsertRowid);
      logger.info('Webhook processed', { event: raw.event, result });
    })
    .catch((err) => {
      logger.error('Webhook processing failed', { error: err.message, stack: err.stack });
      db().prepare('UPDATE webhook_events SET error = ? WHERE id = ?').run(err.message, rec.lastInsertRowid);
    });
});

// ---------------------------------------------------------------------------
// GET /api/session/:id
// Front-end polls this to drive the "activating charger..." screen.
// ---------------------------------------------------------------------------
router.get('/session/:id', safetyLazy.middleware, (req, res) => {
  const s = sessions.findById(req.params.id);
  if (!s) return res.status(404).json({ error: 'session_not_found' });
  const c = chargers.findById(s.charger_id);

  const remainingMs = s.expected_end_at
    ? Math.max(0, new Date(s.expected_end_at).getTime() - Date.now())
    : null;

  res.json({
    id: s.id,
    charger: { display_name: c.display_name, qr_code: c.qr_code },
    payment_status: s.payment_status,
    activation_status: s.activation_status,
    activated_at: s.activated_at,
    expected_end_at: s.expected_end_at,
    completed_at: s.completed_at,
    minutes_purchased: s.minutes_purchased,
    amount_cop: s.amount_cop,
    failure_reason: s.failure_reason,
    remaining_ms: remainingMs,
  });
});

// ---------------------------------------------------------------------------
// POST /api/dev/simulate-approval
// Demo helper: only enabled outside production. Used by the demo script and
// the "Simular pago aprobado" button on the payment page in dev.
// ---------------------------------------------------------------------------
router.post('/dev/simulate-approval', async (req, res) => {
  // Allow whenever we're running against the Tuya mock (= a demo deploy).
  // Real production has tuya.mock = false and this endpoint is unreachable.
  if (!config.tuya.mock && config.env === 'production') return res.status(404).end();
  const { reference } = req.body || {};
  if (!reference) return res.status(400).json({ error: 'reference_required' });
  const result = await payment.simulateApproval(reference);
  res.json(result);
});

module.exports = router;
