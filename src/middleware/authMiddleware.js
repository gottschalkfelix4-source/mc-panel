// JWT auth middleware.
'use strict';

const jwt = require('jsonwebtoken');
const { normalizedRole } = require('../services/accessService');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

function signToken(user) {
  return jwt.sign({ username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireOperator(req, res, next) {
  if (!req.user || !['admin', 'operator'].includes(normalizedRole(req.user.role))) {
    return res.status(403).json({ error: 'Operator- oder Admin-Rechte erforderlich' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || normalizedRole(req.user.role) !== 'admin') {
    return res.status(403).json({ error: 'Admin-Rechte erforderlich' });
  }
  next();
}

module.exports = { requireAuth, requireOperator, requireAdmin, signToken, verifyToken, normalizedRole };
