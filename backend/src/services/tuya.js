'use strict';

/**
 * Tuya IoT Cloud client.
 *
 * Implements Tuya's required HMAC-SHA256 signature scheme:
 *   - "simple" sign for /v1.0/token requests (no token in sig)
 *   - "business" sign for everything else (token included in sig)
 *
 * Docs: https://developer.tuya.com/en/docs/iot/singnature
 *
 * If config.tuya.mock is true, swaps in an in-memory simulator that
 * preserves the latency characteristics of the real platform (1-15s
 * before the device reports the new state). This lets us demo the full
 * end-to-end flow — including polling and timeouts — without hardware.
 */

const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');
const tuyaMock = require('./tuya.mock');

const isMock = () => config.tuya.mock;

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------
let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken() {
  if (isMock()) return 'mock-token';
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;

  const t = Date.now().toString();
  const stringToSign = buildStringToSign('GET', '/v1.0/token?grant_type=1', '', {});
  const sign = hmacSign(config.tuya.accessId + t + stringToSign);

  const res = await fetch(`${config.tuya.baseUrl}/v1.0/token?grant_type=1`, {
    method: 'GET',
    headers: {
      client_id: config.tuya.accessId,
      sign,
      t,
      sign_method: 'HMAC-SHA256',
    },
  });
  const body = await res.json();
  if (!body.success) {
    throw new Error(`Tuya token request failed: ${body.code} ${body.msg}`);
  }
  cachedToken = body.result.access_token;
  tokenExpiresAt = Date.now() + body.result.expire_time * 1000;
  return cachedToken;
}

// ---------------------------------------------------------------------------
// Signing helpers
// ---------------------------------------------------------------------------
function hmacSign(payload) {
  return crypto
    .createHmac('sha256', config.tuya.accessSecret)
    .update(payload, 'utf8')
    .digest('hex')
    .toUpperCase();
}

function buildStringToSign(method, urlPathWithQuery, bodyText, headers) {
  const contentSha = crypto.createHash('sha256').update(bodyText || '', 'utf8').digest('hex');
  const headerLines = Object.keys(headers).sort().map((k) => `${k}:${headers[k]}`).join('\n');
  return [method.toUpperCase(), contentSha, headerLines, urlPathWithQuery].join('\n');
}

async function signedRequest(method, urlPath, { body, query, headers = {} } = {}) {
  const token = await getToken();
  const t = Date.now().toString();
  const bodyText = body ? JSON.stringify(body) : '';
  const qs = query
    ? '?' + Object.keys(query).sort().map((k) => `${k}=${encodeURIComponent(query[k])}`).join('&')
    : '';
  const fullPath = urlPath + qs;

  const stringToSign = buildStringToSign(method, fullPath, bodyText, headers);
  const sign = hmacSign(config.tuya.accessId + token + t + stringToSign);

  const res = await fetch(`${config.tuya.baseUrl}${fullPath}`, {
    method,
    body: bodyText || undefined,
    headers: {
      ...headers,
      client_id: config.tuya.accessId,
      access_token: token,
      sign,
      t,
      sign_method: 'HMAC-SHA256',
      'Content-Type': 'application/json',
    },
  });
  const json = await res.json();
  return json;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a command to a device. Returns the raw response.
 * IMPORTANT: success: true here means "Tuya accepted the command", NOT that
 * the device has actually executed it. You MUST poll device state to confirm.
 */
async function sendCommand(deviceId, code, value) {
  if (isMock()) return tuyaMock.sendCommand(deviceId, code, value);

  const result = await signedRequest('POST', `/v1.0/iot-03/devices/${deviceId}/commands`, {
    body: { commands: [{ code, value }] },
  });
  logger.debug('Tuya command sent', { deviceId, code, value, success: result.success });
  return result;
}

/**
 * Read current device status. Returns the array of datapoints.
 */
async function getDeviceStatus(deviceId) {
  if (isMock()) return tuyaMock.getDeviceStatus(deviceId);

  const result = await signedRequest('GET', `/v1.0/iot-03/devices/${deviceId}/status`);
  if (!result.success) {
    throw new Error(`Tuya status read failed: ${result.code} ${result.msg}`);
  }
  return result.result; // [{ code, value }, ...]
}

/**
 * Convenience: read a single datapoint value.
 */
async function getDatapoint(deviceId, code) {
  const status = await getDeviceStatus(deviceId);
  const dp = status.find((d) => d.code === code);
  return dp ? dp.value : undefined;
}

/**
 * Activate a charger via its switch datapoint, then poll until the device
 * confirms the change OR the timeout expires.
 *
 * Returns: { activated: boolean, latencyMs: number, finalState: any }
 */
async function activateAndConfirm(deviceId, switchDp, { pollIntervalMs, timeoutMs }) {
  const startedAt = Date.now();
  await sendCommand(deviceId, switchDp, true);
  const result = await pollUntilState(deviceId, switchDp, true, { pollIntervalMs, timeoutMs });
  return {
    activated: result.matched,
    latencyMs: Date.now() - startedAt,
    finalState: result.lastValue,
  };
}

/**
 * Deactivate, then poll until the device confirms off. Same return shape.
 */
async function deactivateAndConfirm(deviceId, switchDp, { pollIntervalMs, timeoutMs }) {
  const startedAt = Date.now();
  await sendCommand(deviceId, switchDp, false);
  const result = await pollUntilState(deviceId, switchDp, false, { pollIntervalMs, timeoutMs });
  return {
    deactivated: result.matched,
    latencyMs: Date.now() - startedAt,
    finalState: result.lastValue,
  };
}

/**
 * Poll the device's datapoint until it matches expectedValue or we time out.
 * This is the critical "is the LED actually on?" check that prevents the
 * "user pays but doesn't see anything happen" failure mode.
 */
async function pollUntilState(deviceId, code, expectedValue, { pollIntervalMs, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    try {
      lastValue = await getDatapoint(deviceId, code);
      if (lastValue === expectedValue) {
        return { matched: true, lastValue };
      }
    } catch (err) {
      logger.warn('Polling read failed; will retry', { deviceId, error: err.message });
    }
    await sleep(pollIntervalMs);
  }
  return { matched: false, lastValue };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  getToken,
  sendCommand,
  getDeviceStatus,
  getDatapoint,
  activateAndConfirm,
  deactivateAndConfirm,
  pollUntilState,
  isMock,
};
