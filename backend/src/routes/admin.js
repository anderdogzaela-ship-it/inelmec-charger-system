'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db/db');
const auth = require('../middleware/auth');
const chargers = require('../services/chargers');
const sessions = require('../services/sessions');
const audit = require('../services/audit');
const activation = require('../services/activation');
const safetyLazy = require('../services/safety-lazy');
const tuya = require('../services/tuya');
const tuyaMock = require('../services/tuya.mock');

const router = express.Router();

// ---------------------------------------------------------------------------
// POST /api/admin/login
// ---------------------------------------------------------------------------
router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'missing_credentials' });

  const row = db().prepare('SELECT * FROM admins WHERE email = ?').get(email);
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  db().prepare("UPDATE admins SET last_login_at = datetime('now') WHERE id = ?").run(row.id);
  const token = auth.sign({ id: row.id, email: row.email, role: row.role });
  res.json({ token, admin: { id: row.id, email: row.email, role: row.role, display_name: row.display_name } });
});

// All routes below require auth.
router.use(auth.requireAdmin);

// Lazy safety tick (no-op on long-running server, real check on Vercel).
router.use(safetyLazy.middleware);

// ---------------------------------------------------------------------------
// GET /api/admin/dashboard
// ---------------------------------------------------------------------------
router.get('/dashboard', (req, res) => {
  const d = db();

  const today = d.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(amount_cop), 0) AS revenue
      FROM sessions
     WHERE payment_status = 'APPROVED'
       AND date(created_at) = date('now')
  `).get();

  const month = d.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(amount_cop), 0) AS revenue
      FROM sessions
     WHERE payment_status = 'APPROVED'
       AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
  `).get();

  const active = d.prepare("SELECT COUNT(*) AS c FROM sessions WHERE activation_status = 'ACTIVE'").get();
  const chargerCounts = d.prepare(`
    SELECT status, COUNT(*) AS c FROM chargers GROUP BY status
  `).all().reduce((acc, r) => (acc[r.status] = r.c, acc), {});

  const stuckActive = d.prepare(`
    SELECT COUNT(*) AS c FROM sessions
     WHERE activation_status = 'ACTIVE'
       AND expected_end_at < datetime('now', '-60 seconds')
  `).get();

  res.json({
    today: { transactions: today.count, revenue_cop: today.revenue },
    month: { transactions: month.count, revenue_cop: month.revenue },
    active_sessions: active.c,
    chargers: chargerCounts,
    alerts: { stuck_active: stuckActive.c },
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/chargers
// ---------------------------------------------------------------------------
router.get('/chargers', (req, res) => {
  res.json({ chargers: chargers.listWithCurrentSession() });
});

// ---------------------------------------------------------------------------
// POST /api/admin/chargers/:id/force-deactivate
// Emergency override — sends Tuya off command and audits the actor.
// ---------------------------------------------------------------------------
router.post('/chargers/:id/force-deactivate', async (req, res) => {
  const c = chargers.findById(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'not_found' });

  const active = db().prepare(`
    SELECT id FROM sessions
     WHERE charger_id = ? AND activation_status = 'ACTIVE'
     LIMIT 1
  `).get(c.id);

  if (active) {
    const r = await activation.deactivate(active.id, {
      actor: req.admin.email,
      reason: 'admin_force_deactivate',
    });
    return res.json({ ok: r.ok, source: 'session' });
  }

  // No active session — still send the command directly for safety.
  await tuya.sendCommand(c.tuya_device_id, c.tuya_switch_dp, false);
  chargers.setStatus(c.id, 'available');
  audit.log({
    chargerId: c.id, actor: req.admin.email,
    eventType: 'admin.force_deactivate.direct',
  });
  res.json({ ok: true, source: 'direct' });
});

// ---------------------------------------------------------------------------
// GET /api/admin/sessions
// ---------------------------------------------------------------------------
router.get('/sessions', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  res.json({ sessions: sessions.listRecent({ limit }) });
});

// ---------------------------------------------------------------------------
// GET /api/admin/audit-log
// ---------------------------------------------------------------------------
router.get('/audit-log', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  res.json({ entries: audit.list({ limit, eventType: req.query.event_type }) });
});

// ---------------------------------------------------------------------------
// GET /api/admin/webhooks
// ---------------------------------------------------------------------------
router.get('/webhooks', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const rows = db().prepare(`
    SELECT id, provider, event_type, signature_valid, processed, error, received_at
      FROM webhook_events ORDER BY id DESC LIMIT ?
  `).all(limit);
  res.json({ webhooks: rows });
});

// ---------------------------------------------------------------------------
// POST /api/admin/dev/toggle-charger-online
// Mock-mode helper to demonstrate the offline/safety flow.
// ---------------------------------------------------------------------------
router.post('/dev/toggle-charger-online/:id', (req, res) => {
  if (!tuya.isMock()) return res.status(400).json({ error: 'only_in_mock_mode' });
  const c = chargers.findById(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'not_found' });
  const current = tuyaMock.getRawState(c.tuya_device_id);
  tuyaMock.setOnline(c.tuya_device_id, !current.online);
  audit.log({
    chargerId: c.id, actor: req.admin.email,
    eventType: 'admin.mock.toggle_online',
    payload: { new_online: !current.online },
  });
  res.json({ online: !current.online });
});

module.exports = router;
