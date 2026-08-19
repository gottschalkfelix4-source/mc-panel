'use strict';

const { db } = require('./database');

function normalizedRole(role) {
  return role === 'player' ? 'viewer' : role;
}

function userRecord(username) {
  if (typeof username !== 'string' || !username) return null;
  return db
    .prepare('SELECT id, username, role, created_at FROM users WHERE username = ?')
    .get(username) || null;
}

function isAdmin(user) {
  return Boolean(user) && normalizedRole(user.role) === 'admin';
}

function accessibleServerIds(user) {
  if (!user) return [];
  if (isAdmin(user)) {
    return db.prepare('SELECT id FROM servers ORDER BY id').all().map((row) => row.id);
  }
  return db.prepare(
    `SELECT access.server_id AS id
     FROM user_server_access access
     JOIN users ON users.id = access.user_id
     WHERE users.username = ?
     ORDER BY access.server_id`
  ).all(user.username).map((row) => row.id);
}

function canAccess(user, serverId) {
  const id = Number(serverId);
  if (!user || !Number.isInteger(id) || id <= 0) return false;
  if (isAdmin(user)) return true;
  return Boolean(db.prepare(
    `SELECT 1
     FROM user_server_access access
     JOIN users ON users.id = access.user_id
     WHERE users.username = ? AND access.server_id = ?`
  ).get(user.username, id));
}

function requireServerAccess(req, res, next) {
  const id = Number(req.params.id);
  if (!req.user || !Number.isInteger(id) || id <= 0 || !canAccess(req.user, id)) {
    return res.status(404).json({ error: 'Server not found' });
  }
  req.serverAccessId = id;
  next();
}

function accessError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function userServerIds(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return [];
  return db.prepare(
    'SELECT server_id AS id FROM user_server_access WHERE user_id = ? ORDER BY server_id'
  ).all(id).map((row) => row.id);
}

function serverUserNames(serverId) {
  const id = Number(serverId);
  if (!Number.isInteger(id) || id <= 0) return [];
  return db.prepare(
    `SELECT u.username
     FROM user_server_access access
     JOIN users u ON u.id = access.user_id
     WHERE access.server_id = ?
     ORDER BY u.username`
  ).all(id).map((row) => row.username);
}

function setUserServers(userId, serverIds) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) {
    throw accessError(400, 'Invalid user id');
  }
  if (!Array.isArray(serverIds)) {
    throw accessError(400, 'serverIds must be an array');
  }
  const uniqueIds = [...new Set(serverIds)];
  if (uniqueIds.some((serverId) => !Number.isInteger(serverId) || serverId <= 0)) {
    throw accessError(400, 'serverIds must contain positive integers');
  }
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(id)) {
    throw accessError(404, 'User not found');
  }
  if (uniqueIds.length) {
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const rows = db.prepare(`SELECT id FROM servers WHERE id IN (${placeholders})`).all(...uniqueIds);
    if (rows.length !== uniqueIds.length) {
      throw accessError(400, 'serverIds contains an unknown server');
    }
  }

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM user_server_access WHERE user_id = ?').run(id);
    const insert = db.prepare(
      'INSERT INTO user_server_access (user_id, server_id) VALUES (?, ?)'
    );
    for (const serverId of uniqueIds) insert.run(id, serverId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return userServerIds(id);
}

module.exports = {
  normalizedRole,
  userRecord,
  isAdmin,
  accessibleServerIds,
  canAccess,
  requireServerAccess,
  setUserServers,
  userServerIds,
  serverUserNames,
};
