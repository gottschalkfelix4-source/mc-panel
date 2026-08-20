'use strict';

const fs = require('fs');
const path = require('path');

const SERVERS_DIR = process.env.SERVERS_DIR || './servers';
const PLAYER_NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const FILES = {
  cache: 'usercache.json',
  ops: 'ops.json',
  whitelist: 'whitelist.json',
  bans: 'banned-players.json',
};

function serviceError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function serverDir(serverId) {
  const id = Number(serverId);
  if (!Number.isInteger(id) || id <= 0) throw serviceError('Ungültige Server-ID.');
  return path.resolve(SERVERS_DIR, String(id));
}

function readArray(serverId, fileName) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(serverDir(serverId), fileName), 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function normalizeUuid(value) {
  const compact = String(value || '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) return null;
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function entryIdentity(entry) {
  return {
    uuid: normalizeUuid(entry && entry.uuid),
    name: typeof (entry && entry.name) === 'string' ? entry.name : null,
  };
}

function list(serverId, onlineNames = []) {
  const records = [];
  const byUuid = new Map();
  const byName = new Map();

  function merge(source, fields = {}) {
    const identity = entryIdentity(source);
    const nameKey = identity.name && identity.name.toLowerCase();
    let record = (identity.uuid && byUuid.get(identity.uuid)) || (nameKey && byName.get(nameKey));

    if (!record) {
      record = {
        uuid: identity.uuid,
        name: identity.name,
        online: false,
        opLevel: null,
        bypassesPlayerLimit: false,
        whitelisted: false,
        banned: false,
        banReason: null,
        lastSeen: null,
      };
      records.push(record);
    }

    if (!record.uuid && identity.uuid) record.uuid = identity.uuid;
    if (!record.name && identity.name) record.name = identity.name;
    Object.assign(record, fields);
    if (record.uuid) byUuid.set(record.uuid, record);
    if (record.name) byName.set(record.name.toLowerCase(), record);
    return record;
  }

  for (const entry of readArray(serverId, FILES.cache)) {
    merge(entry, { lastSeen: entry.lastSeen || entry.expiresOn || null });
  }
  for (const entry of readArray(serverId, FILES.ops)) {
    const level = Number(entry.level);
    merge(entry, {
      opLevel: Number.isInteger(level) && level >= 1 && level <= 4 ? level : null,
      bypassesPlayerLimit: entry.bypassesPlayerLimit === true,
    });
  }
  for (const entry of readArray(serverId, FILES.whitelist)) {
    merge(entry, { whitelisted: true });
  }
  for (const entry of readArray(serverId, FILES.bans)) {
    merge(entry, { banned: true, banReason: typeof entry.reason === 'string' ? entry.reason : null });
  }
  for (const name of Array.isArray(onlineNames) ? onlineNames : []) {
    if (typeof name === 'string' && PLAYER_NAME_RE.test(name)) merge({ name }, { online: true });
  }

  return records.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return String(a.name || '').localeCompare(String(b.name || ''), 'de', { sensitivity: 'base' });
  });
}

async function resolvePlayer(name) {
  let response;
  try {
    response = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, {
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw serviceError('Der Mojang-Dienst ist derzeit nicht erreichbar.', 502);
  }
  if (response.status === 404 || response.status === 204) {
    throw serviceError(`Minecraft-Spieler „${name}“ wurde nicht gefunden.`, 404);
  }
  if (!response.ok) throw serviceError(`Mojang-Abfrage fehlgeschlagen (HTTP ${response.status}).`, 502);

  let profile;
  try {
    profile = await response.json();
  } catch {
    throw serviceError('Mojang hat ein ungültiges Spielerprofil geliefert.', 502);
  }
  const uuid = normalizeUuid(profile && profile.id);
  if (!uuid) throw serviceError('Mojang hat ein ungültiges Spielerprofil geliefert.', 502);
  return { uuid, name: PLAYER_NAME_RE.test(profile.name || '') ? profile.name : name };
}

async function writeArrayAtomic(serverId, fileName, entries) {
  const dir = serverDir(serverId);
  await fs.promises.mkdir(dir, { recursive: true });
  const target = path.join(dir, fileName);
  const temporary = path.join(dir, `.${fileName}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    await fs.promises.writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
    await fs.promises.rename(temporary, target);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function samePlayer(entry, player) {
  const uuid = normalizeUuid(entry && entry.uuid);
  return (uuid && uuid === player.uuid) ||
    (typeof (entry && entry.name) === 'string' && entry.name.toLowerCase() === player.name.toLowerCase());
}

async function action(serverId, input, processManager) {
  const body = input && typeof input === 'object' ? input : {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!PLAYER_NAME_RE.test(name)) {
    throw serviceError('Spielername muss 1 bis 16 Zeichen lang sein und darf nur Buchstaben, Zahlen und _ enthalten.');
  }

  const validActions = new Set(['op', 'deop', 'whitelist-add', 'whitelist-remove', 'ban', 'pardon']);
  if (!validActions.has(body.action)) throw serviceError('Ungültige Spieleraktion.');

  let level = null;
  if (body.action === 'op') {
    level = body.level == null ? 4 : body.level;
    if (!Number.isInteger(level) || level < 1 || level > 4) {
      throw serviceError('OP-Level muss eine ganze Zahl zwischen 1 und 4 sein.');
    }
  }

  let uuid = normalizeUuid(body.uuid);
  if (body.uuid != null && !uuid) throw serviceError('Ungültige Spieler-UUID.');
  let playerName = name;
  if (!uuid) {
    const known = list(serverId).find((player) => player.name && player.name.toLowerCase() === name.toLowerCase() && player.uuid);
    if (known) {
      uuid = known.uuid;
      playerName = known.name;
    } else {
      const resolved = await resolvePlayer(name);
      uuid = resolved.uuid;
      playerName = resolved.name;
    }
  }
  const player = { uuid, name: playerName };

  let fileName;
  let entries;
  let command;
  if (body.action === 'op' || body.action === 'deop') {
    fileName = FILES.ops;
    entries = readArray(serverId, fileName).filter((entry) => !samePlayer(entry, player));
    if (body.action === 'op') entries.push({ uuid, name: playerName, level, bypassesPlayerLimit: false });
    command = body.action === 'op' ? `op ${playerName}` : `deop ${playerName}`;
  } else if (body.action.startsWith('whitelist-')) {
    fileName = FILES.whitelist;
    entries = readArray(serverId, fileName).filter((entry) => !samePlayer(entry, player));
    if (body.action === 'whitelist-add') entries.push({ uuid, name: playerName });
    command = `whitelist ${body.action === 'whitelist-add' ? 'add' : 'remove'} ${playerName}`;
  } else {
    fileName = FILES.bans;
    entries = readArray(serverId, fileName).filter((entry) => !samePlayer(entry, player));
    const reason = typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim().slice(0, 200)
      : 'Vom MC Panel gesperrt';
    if (body.action === 'ban') {
      entries.push({
        uuid,
        name: playerName,
        created: new Date().toISOString(),
        source: 'MC Panel',
        expires: 'forever',
        reason,
      });
    }
    command = body.action === 'ban' ? `ban ${playerName} ${reason}` : `pardon ${playerName}`;
  }

  await writeArrayAtomic(serverId, fileName, entries);

  try {
    if (processManager && typeof processManager.status === 'function' &&
        processManager.status(serverId) === 'online' && typeof processManager.sendCommand === 'function') {
      await processManager.sendCommand(serverId, command);
    }
  } catch {
    // The JSON files are authoritative; a console synchronization failure is non-fatal.
  }

  const onlineNames = processManager && typeof processManager.getRuntimeInfo === 'function'
    ? (processManager.getRuntimeInfo(serverId) || {}).playerNames || []
    : [];
  return list(serverId, onlineNames).find((entry) => samePlayer(entry, player)) || {
    uuid,
    name: playerName,
    online: false,
    opLevel: null,
    bypassesPlayerLimit: false,
    whitelisted: false,
    banned: false,
    banReason: null,
    lastSeen: null,
  };
}

module.exports = { list, action };
