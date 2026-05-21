'use strict';

/**
 * Payment service. Bridges Wompi webhook events into our session model.
 *
 * The webhook handler is the only entry point that can mark a session as
 * APPROVED. We never trust client-side redirects or hash params — the
 * server-to-server webhook (with verified HMAC) is the source of truth.
 */

const wompi = require('./wompi');
const sessions = require('./sessions');
const activation = require('./activation');
const audit = require('./audit');
const logger = require('../utils/logger');
const { db } = require('../db/db');

/**
 * Process a Wompi event after its signature has been verified.
 * Returns a status object suitable for the webhook 200/4xx response.
 */
async function handleWompiEvent(event) {
  // We only act on transaction.updated events; the rest are stored for audit.
  if (event.event !== 'transaction.updated') {
    return { ok: true, ignored: true, reason: 'unhandled_event_type' };
  }

  const tx = event.data && event.data.transaction;
  if (!tx) return { ok: false, reason: 'missing_transaction' };

  const session = sessions.findByReference(tx.reference);
  if (!session) {
    logger.warn('Wompi event for unknown reference', { reference: tx.reference });
    return { ok: false, reason: 'unknown_reference' };
  }

  // Persist Wompi's view of the payment.
  sessions.updatePaymentStatus(session.id, tx.status, tx.id);
  audit.log({
    sessionId: session.id, chargerId: session.charger_id,
    eventType: `wompi.${tx.status.toLowerCase()}`,
    payload: { wompi_transaction_id: tx.id, amount_in_cents: tx.amount_in_cents },
  });

  if (tx.status !== 'APPROVED') {
    return { ok: true, status: tx.status };
  }

  // Approved → fire activation. activation.activate() is idempotent so a
  // duplicate webhook from Wompi will not re-activate the charger.
  const result = await activation.activate(session.id);
  return { ok: true, status: tx.status, activation: result };
}

/**
 * For local development and demos: simulate a successful Wompi webhook
 * for a given session reference. Used by scripts/simulate-wompi-webhook.js
 * and by the admin "Force Approval" button on the transaction detail page.
 */
async function simulateApproval(reference) {
  const session = sessions.findByReference(reference);
  if (!session) return { ok: false, reason: 'unknown_reference' };

  const fakeEvent = {
    event: 'transaction.updated',
    data: {
      transaction: {
        id: `sim_${Date.now()}`,
        reference,
        status: 'APPROVED',
        amount_in_cents: session.amount_cop * 100,
        currency: 'COP',
      },
    },
    timestamp: Math.floor(Date.now() / 1000),
  };

  db().prepare(`
    INSERT INTO webhook_events (provider, event_type, signature_valid, raw_payload, processed)
    VALUES ('wompi', ?, 0, ?, 0)
  `).run(fakeEvent.event, JSON.stringify({ ...fakeEvent, simulated: true }));

  return handleWompiEvent(fakeEvent);
}

module.exports = { handleWompiEvent, simulateApproval };
