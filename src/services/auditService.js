'use strict';

const { db, now } = require('./database');
const retentionDays = Math.min(3650, Math.max(1, Number(process.env.AUDIT_RETENTION_DAYS || 90)));
let writesSincePrune = 0;

function bounded(value, max) {
  if (value == null) return null;
  return String(value).slice(0, max);
}

const ACTIONS = [
  ['POST', /^\/api\/setup\/admin$/, 'setup.admin.create'],
  ['POST', /^\/api\/auth\/login$/, 'auth.login'],
  ['POST', /^\/api\/auth\/password$/, 'auth.password.change'],
  ['POST', /^\/api\/auth\/logout$/, 'auth.logout'],
  ['POST', /^\/api\/servers$/, 'server.create'],
  ['DELETE', /^\/api\/servers\/(\d+)$/, 'server.delete'],
  ['PUT', /^\/api\/servers\/(\d+)\/resources$/, 'server.resources.update'],
  ['POST', /^\/api\/servers\/(\d+)\/(start|stop|restart)$/, 'server.power'],
  ['POST', /^\/api\/servers\/(\d+)\/command$/, 'server.command'],
  ['POST', /^\/api\/servers\/(\d+)\/install$/, 'server.install'],
  ['POST', /^\/api\/servers\/(\d+)\/modpacks\/install$/, 'modpack.install'],
  ['POST', /^\/api\/servers\/(\d+)\/update$/, 'modpack.update'],
  ['DELETE', /^\/api\/servers\/(\d+)\/mods\//, 'modpack.remove'],
  ['PUT', /^\/api\/servers\/(\d+)\/files\//, 'file.update'],
  ['POST', /^\/api\/servers\/(\d+)\/files\//, 'file.create'],
  ['DELETE', /^\/api\/servers\/(\d+)\/files/, 'file.delete'],
  ['POST', /^\/api\/servers\/(\d+)\/backups/, 'backup.operation'],
  ['DELETE', /^\/api\/servers\/(\d+)\/backups/, 'backup.delete'],
  ['PUT', /^\/api\/servers\/(\d+)\/(backup-settings|properties)$/, 'server.settings.update'],
  ['POST', /^\/api\/servers\/(\d+)\/players\/action$/, 'server.player.action'],
  ['POST', /^\/api\/users$/, 'user.create'],
  ['POST', /^\/api\/users\/(\d+)\/password-reset$/, 'user.password.reset'],
  ['PATCH', /^\/api\/users\/(\d+)$/, 'user.update'],
  ['DELETE', /^\/api\/users\/(\d+)$/, 'user.delete'],
  ['PUT', /^\/api\/users\/(\d+)\/servers$/, 'user.access.update'],
  ['POST', /^\/api\/admin\/jobs\/.+\/cancel$/, 'job.cancel'],
  ['PUT', /^\/api\/settings\//, 'settings.update'],
  ['DELETE', /^\/api\/settings\//, 'settings.delete'],
];

function classify(method, path) {
  for (const [expectedMethod, pattern, eventType] of ACTIONS) {
    if (method !== expectedMethod) continue;
    const match = path.match(pattern);
    if (match) return { eventType, serverId: path.startsWith('/api/servers/') ? Number(match[1]) || null : null };
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && path.startsWith('/api/')) {
    return { eventType: `api.${method.toLowerCase()}`, serverId: null };
  }
  return null;
}

function record(event) {
  try {
    db.prepare(
      `INSERT INTO audit_events
       (ts, actor_user_id, actor_username, actor_role, event_type, outcome, method, path,
        target_type, target_id, server_id, status_code, ip, user_agent, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      event.ts || now(),
      event.actorUserId || null,
      bounded(event.actorUsername, 64),
      bounded(event.actorRole, 24),
      bounded(event.eventType, 80),
      event.outcome,
      bounded(event.method, 12),
      bounded(event.path, 512),
      bounded(event.targetType, 64),
      bounded(event.targetId, 128),
      event.serverId || null,
      event.statusCode || null,
      bounded(event.ip, 64),
      bounded(event.userAgent, 512),
      event.details ? bounded(JSON.stringify(event.details), 2048) : null
    );
    writesSincePrune += 1;
    if (writesSincePrune >= 100) {
      writesSincePrune = 0;
      db.prepare('DELETE FROM audit_events WHERE ts < ?').run(now() - retentionDays * 24 * 60 * 60 * 1000);
    }
  } catch (error) {
    console.error('[audit] Ereignis konnte nicht gespeichert werden:', error.message);
  }
}

function middleware(req, res, next) {
  const action = classify(req.method, req.path);
  if (!action) return next();
  res.on('finish', () => {
    const status = res.statusCode;
    const outcome = status === 202 ? 'accepted' : status < 400 ? 'succeeded' : status === 401 || status === 403 ? 'denied' : 'failed';
    const actor = req.user || {};
    record({
      eventType: action.eventType,
      outcome,
      method: req.method,
      path: req.path,
      serverId: action.serverId,
      statusCode: status,
      actorUserId: actor.id,
      actorUsername: actor.username || bounded(req.auditUsername, 64),
      actorRole: actor.role,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
  });
  next();
}

function list({ limit = 100, before, eventType, outcome, actor, serverId } = {}) {
  const clauses = [];
  const params = [];
  if (before) { clauses.push('id < ?'); params.push(Number(before)); }
  if (eventType) { clauses.push('event_type = ?'); params.push(eventType); }
  if (outcome) { clauses.push('outcome = ?'); params.push(outcome); }
  if (actor) { clauses.push('actor_username LIKE ?'); params.push(`%${actor}%`); }
  if (serverId) { clauses.push('server_id = ?'); params.push(Number(serverId)); }
  const boundedLimit = Math.min(200, Math.max(1, Number(limit) || 100));
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM audit_events ${where} ORDER BY id DESC LIMIT ?`).all(...params, boundedLimit)
    .map((row) => ({
      id: row.id,
      ts: row.ts,
      actorUserId: row.actor_user_id,
      actorUsername: row.actor_username,
      actorRole: row.actor_role,
      eventType: row.event_type,
      outcome: row.outcome,
      method: row.method,
      path: row.path,
      serverId: row.server_id,
      statusCode: row.status_code,
      ip: row.ip,
      userAgent: row.user_agent,
      details: row.details_json ? JSON.parse(row.details_json) : null,
    }));
}

module.exports = { record, middleware, list, classify };
