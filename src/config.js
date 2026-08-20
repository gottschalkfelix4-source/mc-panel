'use strict';

const crypto = require('crypto');

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';
const isTest = nodeEnv === 'test';
const weakSecrets = new Set([
  'dev-secret',
  'change-me-to-a-long-random-string',
  'REPLACE_WITH_A_LONG_RANDOM_STRING',
]);

let jwtSecret = process.env.JWT_SECRET || '';
if (!jwtSecret && !isProduction) {
  jwtSecret = crypto.randomBytes(32).toString('hex');
  if (!isTest) console.warn('[security] JWT_SECRET fehlt; verwende ein temporäres Development-Secret.');
}
if (!jwtSecret || jwtSecret.length < 32 || weakSecrets.has(jwtSecret)) {
  throw new Error('JWT_SECRET muss mindestens 32 Zeichen lang und explizit konfiguriert sein.');
}

const corsOrigins = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
if (corsOrigins.includes('*')) {
  throw new Error('CORS_ORIGINS darf keinen Wildcard-Origin (*) enthalten.');
}
const configuredSetupToken = process.env.SETUP_TOKEN || '';
if (configuredSetupToken && configuredSetupToken.length < 32) {
  throw new Error('SETUP_TOKEN muss mindestens 32 Zeichen lang sein oder leer bleiben, damit ein sicherer Token generiert wird.');
}
const trustProxy = Number(process.env.TRUST_PROXY || 0);
if (!Number.isInteger(trustProxy) || trustProxy < 0 || trustProxy > 10) {
  throw new Error('TRUST_PROXY muss eine ganze Zahl zwischen 0 und 10 sein.');
}

function corsOrigin(origin, callback) {
  if (!origin || corsOrigins.includes(origin)) return callback(null, true);
  return callback(new Error('Origin nicht erlaubt'));
}

module.exports = {
  nodeEnv,
  isProduction,
  isTest,
  jwtSecret,
  jwtIssuer: 'mc-panel',
  jwtAudience: 'mc-panel-web',
  corsOrigins,
  corsOrigin,
  bindHost: process.env.SERVER_HOST || '0.0.0.0',
  setupToken: configuredSetupToken,
  trustProxy,
  demoMode: String(process.env.DEMO_MODE || 'false').toLowerCase() === 'true',
};
