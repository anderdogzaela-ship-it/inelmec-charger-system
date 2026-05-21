#!/usr/bin/env node
'use strict';

/**
 * Simulate a Wompi webhook against the running server.
 *
 * Usage:
 *   node scripts/simulate-wompi-webhook.js <reference> [APPROVED|DECLINED]
 *
 * Builds an event with a properly computed HMAC checksum so the server's
 * verifier will accept it. Used by the e2e test and useful for manual demos.
 */

const crypto = require('crypto');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

async function main() {
  const reference = process.argv[2];
  const status = (process.argv[3] || 'APPROVED').toUpperCase();
  if (!reference) {
    console.error('Usage: node scripts/simulate-wompi-webhook.js <reference> [APPROVED|DECLINED]');
    process.exit(1);
  }

  const secret = process.env.WOMPI_EVENTS_SECRET || 'test_events_secret_demo';
  const baseUrl = process.env.PUBLIC_BASE_URL || 'http://localhost:3000';

  const transactionId = 'sim_' + Date.now();
  const amountInCents = 5000_00; // dummy; the server uses our own session amount
  const ts = Math.floor(Date.now() / 1000);

  // properties order MUST match what we list — the verifier replays it.
  const properties = ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'];
  const data = {
    transaction: {
      id: transactionId,
      reference,
      status,
      amount_in_cents: amountInCents,
      currency: 'COP',
    },
  };

  const concat = properties.map((p) => {
    return p.split('.').reduce((acc, k) => acc[k], data);
  }).join('') + String(ts) + secret;

  const checksum = crypto.createHash('sha256').update(concat, 'utf8').digest('hex');

  const event = {
    event: 'transaction.updated',
    data,
    signature: { properties, checksum },
    timestamp: ts,
    sent_at: new Date().toISOString(),
  };

  const res = await fetch(`${baseUrl}/api/payment/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  console.log('Status:', res.status);
  console.log('Body:', await res.text());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
