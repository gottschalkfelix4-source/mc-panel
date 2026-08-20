'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { db, now } = require('./database');
const { validateUsername, validatePassword } = require('./passwordPolicy');
const config = require('../config');

let generatedToken = null;
let tokenPrinted = false;

function setupRequired() {
  const row = db.prepare("SELECT value FROM app_state WHERE key = 'setup_complete'").get();
  return !row || row.value !== '1';
}

function setupToken() {
  if (config.setupToken) return config.setupToken;
  if (!generatedToken) generatedToken = crypto.randomBytes(24).toString('base64url');
  return generatedToken;
}

function logSetupInstructions() {
  if (!setupRequired() || tokenPrinted) return;
  tokenPrinted = true;
  console.warn('\n[setup] Ersteinrichtung erforderlich. Einmaliger Setup-Token:');
  console.warn(`[setup] ${setupToken()}\n`);
}

function tokenMatches(candidate) {
  if (typeof candidate !== 'string') return false;
  const expected = Buffer.from(setupToken());
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function createInitialAdmin({ username, password, token }) {
  if (!setupRequired()) {
    const error = new Error('Die Ersteinrichtung wurde bereits abgeschlossen.');
    error.status = 409;
    throw error;
  }
  if (!tokenMatches(token)) {
    const error = new Error('Ungültiger Setup-Token.');
    error.status = 403;
    throw error;
  }
  const usernameError = validateUsername(username);
  const passwordError = validatePassword(password);
  if (usernameError || passwordError) {
    const error = new Error(usernameError || passwordError);
    error.status = 400;
    throw error;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!setupRequired()) {
      const conflict = new Error('Die Ersteinrichtung wurde bereits abgeschlossen.');
      conflict.status = 409;
      throw conflict;
    }
    const ts = now();
    const result = db.prepare(
      `INSERT INTO users
       (username, password_hash, role, created_at, active, token_version, must_change_password, password_changed_at, updated_at)
       VALUES (?, ?, 'admin', ?, 1, 0, 0, ?, ?)`
    ).run(username, passwordHash, ts, ts, ts);
    db.prepare("UPDATE app_state SET value = '1', updated_at = ? WHERE key = 'setup_complete'").run(ts);
    db.exec('COMMIT');
    return db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { setupRequired, setupToken, logSetupInstructions, createInitialAdmin };
