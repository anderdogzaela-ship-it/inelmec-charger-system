'use strict';

/**
 * In-memory Tuya device simulator.
 *
 * Mimics the latency characteristics of the real Tuya Cloud:
 *   - Commands are accepted immediately (sendCommand returns instantly)
 *   - But the device's state update has a randomized 800-3000ms delay,
 *     occasionally up to 8000ms, just like the real platform.
 *
 * This is what lets the demo prove that polling actually works: if you
 * remove the polling step, the user gets a "success" page before the LED
 * is on, exactly reproducing the failure mode described to the client.
 *
 * The mock supports an "offline" mode per device so the admin panel can
 * demonstrate the safety/alerts flow.
 */

const logger = require('../utils/logger');

const devices = new Map();

function ensureDevice(id) {
  if (!devices.has(id)) {
    devices.set(id, {
      id,
      datapoints: { switch_1: false },
      online: true,
      pendingUpdates: [],
    });
  }
  return devices.get(id);
}

function sendCommand(deviceId, code, value) {
  const dev = ensureDevice(deviceId);
  if (!dev.online) {
    // Tuya returns success:false with code 28841105 for offline devices.
    return Promise.resolve({ success: false, code: 28841105, msg: 'device is offline' });
  }

  // Pick a realistic latency. 80% of the time 800-2500ms, 20% slower.
  const slow = Math.random() < 0.2;
  const latency = slow
    ? 3000 + Math.random() * 5000
    : 800 + Math.random() * 1700;

  setTimeout(() => {
    dev.datapoints[code] = value;
    logger.debug('Tuya mock: state updated', { deviceId, code, value, latency: Math.round(latency) });
  }, latency);

  return Promise.resolve({ success: true, t: Date.now(), result: true });
}

function getDeviceStatus(deviceId) {
  const dev = ensureDevice(deviceId);
  if (!dev.online) {
    return Promise.resolve([]);
  }
  const dps = Object.entries(dev.datapoints).map(([code, value]) => ({ code, value }));
  return Promise.resolve(dps);
}

// --- helpers for tests / admin demo ---
function setOnline(deviceId, online) {
  ensureDevice(deviceId).online = online;
}

function forceState(deviceId, code, value) {
  ensureDevice(deviceId).datapoints[code] = value;
}

function getRawState(deviceId) {
  return ensureDevice(deviceId);
}

module.exports = {
  sendCommand,
  getDeviceStatus,
  setOnline,
  forceState,
  getRawState,
};
