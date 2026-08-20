'use strict';

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,24}$/;
const BLOCKED_PASSWORDS = new Set(['admin123', 'player123', 'password', 'minecraft']);

function validateUsername(username) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return 'Benutzername muss 3 bis 24 Zeichen lang sein und darf nur Buchstaben, Zahlen, _, . und - enthalten.';
  }
  return null;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    return 'Passwort muss 12 bis 128 Zeichen lang sein.';
  }
  if (Buffer.byteLength(password, 'utf8') > 72) {
    return 'Passwort darf wegen der bcrypt-Begrenzung maximal 72 UTF-8-Bytes lang sein.';
  }
  if (BLOCKED_PASSWORDS.has(password.toLowerCase())) {
    return 'Dieses bekannte Standardpasswort ist nicht erlaubt.';
  }
  return null;
}

module.exports = { validateUsername, validatePassword };
