'use strict';

/**
 * Wompi integration.
 *
 * Two cryptographic concerns:
 *
 *  1. Webhook signature (data.signature.checksum):
 *     SHA256 of the concatenation of the values listed in
 *     event.signature.properties (in order) PLUS event.timestamp
 *     PLUS the WOMPI_EVENTS_SECRET.
 *     Docs: https://docs.wompi.co/docs/colombia/eventos/
 *
 *  2. Checkout integrity hash (when creating a payment link):
 *     SHA256 of: `${reference}${amountInCents}${currency}${integritySecret}`
 *     Used so the customer cannot tamper with the amount client-side.
 *
 * Without (1), any attacker who knows our webhook URL can simulate
 * "APPROVED" events and get free charging. This is the single most
 * important security control in the whole system.
 */

const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Verify a Wompi webhook event's checksum.
 *
 * @param {object} event - parsed JSON body of the webhook
 * @returns {boolean}
 */
function verifyEventSignature(event) {
  if (!event || !event.signature || !event.signature.checksum) return false;
  const { properties, checksum } = event.signature;
  if (!Array.isArray(properties)) return false;

  // Walk the dot-paths in `properties` against event.data.
  const concatValues = properties
    .map((path) => getByPath(event.data, path.replace(/^transaction\./, 'transaction.')))
    .map((v) => (v === null || v === undefined ? '' : String(v)))
    .join('');

  const tsPart = event.timestamp !== undefined ? String(event.timestamp) : '';
  const stringToHash = concatValues + tsPart + config.wompi.eventsSecret;

  const computed = crypto.createHash('sha256').update(stringToHash, 'utf8').digest('hex');
  return timingSafeEqual(computed, checksum);
}

/**
 * Generate the integrity hash that must be included on Checkout payment links.
 *
 * @param {string} reference     unique reference for this transaction
 * @param {number} amountInCents amount in COP cents (Wompi expects cents)
 * @param {string} currency      typically 'COP'
 * @returns {string} hex-encoded SHA256
 */
function generateIntegritySignature(reference, amountInCents, currency = 'COP') {
  const payload = `${reference}${amountInCents}${currency}${config.wompi.integritySecret}`;
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Build a Wompi Checkout URL for the given session.
 * The frontend redirects the user here to pay.
 */
function buildCheckoutUrl({ reference, amountInCents, currency = 'COP', redirectUrl, customerEmail }) {
  const params = new URLSearchParams({
    'public-key': config.wompi.publicKey,
    currency,
    'amount-in-cents': String(amountInCents),
    reference,
    'signature:integrity': generateIntegritySignature(reference, amountInCents, currency),
  });
  if (redirectUrl) params.set('redirect-url', redirectUrl);
  if (customerEmail) params.set('customer-data:email', customerEmail);
  return `https://checkout.wompi.co/p/?${params.toString()}`;
}

/**
 * Fetch the authoritative transaction record from Wompi (server-to-server).
 * Use this as the source of truth — never trust client-reported status.
 */
async function getTransaction(transactionId) {
  const res = await fetch(`${config.wompi.baseUrl}/transactions/${transactionId}`, {
    headers: { Authorization: `Bearer ${config.wompi.privateKey}` },
  });
  if (!res.ok) {
    throw new Error(`Wompi transaction fetch failed: ${res.status}`);
  }
  const body = await res.json();
  return body.data;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function getByPath(obj, path) {
  if (!obj) return undefined;
  return path.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

module.exports = {
  verifyEventSignature,
  generateIntegritySignature,
  buildCheckoutUrl,
  getTransaction,
};
