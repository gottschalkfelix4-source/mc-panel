// JWT auth middleware.
'use strict';

const jwt = require('jsonwebtoken');
const { db } = require('../services/database');
const { normalizedRole } = require('../services/accessService');
const config = require('../config');

function signToken(user) {
  return jwt.sign(
    { tokenVersion: Number(user.token_version || 0) },
    config.jwtSecret,
    { subject: String(user.id), expiresIn: '12h', issuer: config.jwtIssuer, audience: config.jwtAudience, algorithm: 'HS256' }
  );
}

function verifyToken(token) {
  const payload = jwt.verify(token, config.jwtSecret, {
    algorithms: ['HS256'],
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
  });
  const id = Number(payload.sub);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid user subject');
  const user = db.prepare(
    'SELECT id, username, role, active, token_version, must_change_password, created_at FROM users WHERE id = ?'
  ).get(id);
  if (!user || !user.active || Number(user.token_version) !== Number(payload.tokenVersion || 0)) {
    throw new Error('Session revoked');
  }
  return {
    id: user.id,
    username: user.username,
    role: normalizedRole(user.role),
    tokenVersion: user.token_version,
    mustChangePassword: Boolean(user.must_change_password),
    createdAt: user.created_at,
    tokenExpiresAt: Number(payload.exp) * 1000,
  };
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  try {
    req.user = verifyToken(token);
    if (req.user.mustChangePassword && !['/api/auth/me', '/api/auth/password'].includes(req.path)) {
      return res.status(403).json({ error: 'Passwortänderung erforderlich', code: 'PASSWORD_CHANGE_REQUIRED' });
    }
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
