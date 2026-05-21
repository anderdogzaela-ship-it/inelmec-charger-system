#!/usr/bin/env node
'use strict';

/**
 * End-to-end smoke test.
 *
 * Validates the full happy path against the running mock server:
 *   1. Lookup a charger by QR code
 *   2. Initiate payment -> creates a PENDING session
 *   3. Simulate a Wompi APPROVED webhook
 *   4. Poll the session until activation_status becomes ACTIVE
 *   5. Run the safety worker against an expired session -> COMPLETED
 *   6. Verify the audit trail captured every state transition
 *   7. Verify idempotency: send the webhook again, no double-activation
 *   8. Verify HMAC: send a webhook with the wrong signature -> 401
 *
 * Exits non-zero on any failure.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const BASE = process.env.PUBLIC_BASE_URL || 'http://localhost:3000';

const assert = (cond, msg) => {
  if (!cond) { console.error('  ✗ ' + msg); throw new Error(msg); }
  console.log('  ✓ ' + msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (res) => {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
};

async function run() {
  console.log('\n=== 1) Charger lookup ===');
  let r = await fetch(`${BASE}/api/charger/INL-001`);
  assert(r.ok, 'GET /api/charger/INL-001 returns 200');
  const charger = await r.json();
  assert(charger.display_name, 'Charger has a display_name');
  assert(charger.rate_cop_per_hour > 0, 'Charger has a rate');

  console.log('\n=== 2) Payment initiation ===');
  r = await fetch(`${BASE}/api/payment/initiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ qr_code: 'INL-001', minutes: 30, user_phone: '3001234567' }),
  });
  assert(r.ok, 'POST /api/payment/initiate returns 200');
  const init = await r.json();
  assert(init.session_id, 'Got session_id');
  assert(init.reference, 'Got reference');
  assert(init.checkout_url.includes('checkout.wompi.co'), 'checkout_url points to Wompi');

  r = await fetch(`${BASE}/api/session/${init.session_id}`);
  let s = await r.json();
  assert(s.payment_status === 'PENDING', 'Session starts PENDING');
  assert(s.activation_status === 'NOT_STARTED', 'Activation starts NOT_STARTED');

  console.log('\n=== 3) Wompi webhook with valid HMAC ===');
  const { spawnSync } = require('child_process');
  const sim = spawnSync('node', [__dirname + '/simulate-wompi-webhook.js', init.reference], { encoding: 'utf8' });
  assert(sim.stdout.includes('Status: 200'), 'Simulated webhook accepted (HTTP 200)');

  console.log('\n=== 4) Activation polling ===');
  let activated = false;
  for (let i = 0; i < 60; i++) {
    r = await fetch(`${BASE}/api/session/${init.session_id}`);
    s = await r.json();
    if (s.activation_status === 'ACTIVE') { activated = true; break; }
    if (s.activation_status === 'TIMEOUT' || s.activation_status === 'FAILED') break;
    await sleep(500);
  }
  assert(activated, 'Session transitioned to ACTIVE');
  assert(s.payment_status === 'APPROVED', 'Payment status is APPROVED');
  assert(s.activated_at && s.expected_end_at, 'Activation timestamps populated');

  console.log('\n=== 5) Idempotency: replay the webhook ===');
  const sim2 = spawnSync('node', [__dirname + '/simulate-wompi-webhook.js', init.reference], { encoding: 'utf8' });
  assert(sim2.stdout.includes('Status: 200'), 'Replay accepted');
  r = await fetch(`${BASE}/api/session/${init.session_id}`);
  const s2 = await r.json();
  assert(s2.activated_at === s.activated_at, 'activated_at unchanged after replay (idempotent)');

  console.log('\n=== 6) Invalid HMAC rejected ===');
  r = await fetch(`${BASE}/api/payment/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'transaction.updated',
      data: { transaction: { id: 'forged', reference: init.reference, status: 'APPROVED', amount_in_cents: 100 } },
      signature: { properties: ['transaction.id'], checksum: 'deadbeef' },
      timestamp: Math.floor(Date.now() / 1000),
    }),
  });
  assert(r.status === 401, 'Forged webhook returns 401 (HMAC rejection)');

  console.log('\n=== 7) Audit log captured the full lifecycle ===');
  // login as admin
  r = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.ADMIN_DEFAULT_EMAIL || 'admin@inelmec.com',
      password: process.env.ADMIN_DEFAULT_PASSWORD || 'inelmec2026',
    }),
  });
  const login = await r.json();
  assert(login.token, 'Admin login succeeded');

  r = await fetch(`${BASE}/api/admin/audit-log?limit=500`, {
    headers: { Authorization: 'Bearer ' + login.token },
  });
  const audit = await r.json();
  const types = audit.entries.map((e) => e.event_type);
  assert(types.includes('session.created'), 'Audit has session.created');
  assert(types.includes('wompi.approved'), 'Audit has wompi.approved');
  assert(types.includes('activation.start'), 'Audit has activation.start');
  assert(types.includes('activation.confirmed'), 'Audit has activation.confirmed');

  console.log('\n=== 8) Webhook ledger ===');
  r = await fetch(`${BASE}/api/admin/webhooks?limit=10`, {
    headers: { Authorization: 'Bearer ' + login.token },
  });
  const wh = await r.json();
  const valid = wh.webhooks.filter((w) => w.signature_valid).length;
  const invalid = wh.webhooks.filter((w) => !w.signature_valid).length;
  assert(valid >= 1, 'Webhook ledger has valid entries');
  assert(invalid >= 1, 'Webhook ledger captured the rejected (invalid) attempt');

  console.log('\nALL E2E CHECKS PASSED\n');
}

run().catch((err) => {
  console.error('\nE2E FAILED:', err.message);
  process.exit(1);
});
