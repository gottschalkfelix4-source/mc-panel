// Runtime settings stored in the DB (editable via the settings page).
// Values from the DB take precedence over env vars.
'use strict';

const { db, now } = require('./database');

const KEYS = {
  CURSEFORGE_API_KEY: 'curseforge_api_key',
};

function get(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function set(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).run(key, String(value), now());
}

function remove(key) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

module.exports = { KEYS, get, set, remove };
