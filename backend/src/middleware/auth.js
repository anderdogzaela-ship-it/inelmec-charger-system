'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');

function sign(payload) {
  return jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
}

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    req.admin = jwt.verify(token, config.jwt.secret);
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

module.exports = { sign, requireAdmin };
