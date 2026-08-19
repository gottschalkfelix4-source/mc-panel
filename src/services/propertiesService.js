'use strict';

const fs = require('fs');
const path = require('path');

const SERVERS_DIR = process.env.SERVERS_DIR || './servers';

const schema = [
  { key: 'motd', label: 'Serverbeschreibung', group: 'Allgemein', type: 'string', default: 'A Minecraft Server' },
  { key: 'max-players', label: 'Maximale Spieler', group: 'Allgemein', type: 'integer', default: 20, min: 1, max: 500 },
  { key: 'gamemode', label: 'Spielmodus', group: 'Gameplay', type: 'enum', default: 'survival', options: ['survival', 'creative', 'adventure', 'spectator'] },
  { key: 'difficulty', label: 'Schwierigkeit', group: 'Gameplay', type: 'enum', default: 'easy', options: ['peaceful', 'easy', 'normal', 'hard'] },
  { key: 'hardcore', label: 'Hardcore', group: 'Gameplay', type: 'boolean', default: false },
  { key: 'pvp', label: 'PvP', group: 'Gameplay', type: 'boolean', default: true },
  { key: 'online-mode', label: 'Online-Modus', group: 'Allgemein', type: 'boolean', default: true },
  { key: 'white-list', label: 'Whitelist', group: 'Allgemein', type: 'boolean', default: false },
  { key: 'enforce-whitelist', label: 'Whitelist erzwingen', group: 'Allgemein', type: 'boolean', default: false },
  { key: 'allow-flight', label: 'Fliegen erlauben', group: 'Gameplay', type: 'boolean', default: false },
  { key: 'spawn-protection', label: 'Spawn-Schutz', group: 'Welt', type: 'integer', default: 16, min: 0, max: 1000 },
  { key: 'view-distance', label: 'Sichtweite', group: 'Welt', type: 'integer', default: 10, min: 2, max: 32 },
  { key: 'simulation-distance', label: 'Simulationsdistanz', group: 'Welt', type: 'integer', default: 10, min: 2, max: 32 },
  { key: 'player-idle-timeout', label: 'Inaktivitätslimit (Minuten)', group: 'Gameplay', type: 'integer', default: 0, min: 0, max: 10080 },
  { key: 'server-port', label: 'Server-Port', group: 'Netzwerk', type: 'integer', default: 25565, min: 1024, max: 65535, readOnly: true },
  { key: 'level-name', label: 'Weltname', group: 'Welt', type: 'string', default: 'world' },
  { key: 'level-seed', label: 'Welt-Seed', group: 'Welt', type: 'string', default: '' },
  { key: 'generate-structures', label: 'Strukturen generieren', group: 'Welt', type: 'boolean', default: true },
  { key: 'allow-nether', label: 'Nether erlauben', group: 'Welt', type: 'boolean', default: true },
  { key: 'enable-command-block', label: 'Befehlsblöcke aktivieren', group: 'Gameplay', type: 'boolean', default: false },
  { key: 'spawn-monsters', label: 'Monster spawnen', group: 'Gameplay', type: 'boolean', default: true },
  { key: 'spawn-animals', label: 'Tiere spawnen', group: 'Gameplay', type: 'boolean', default: true },
  { key: 'spawn-npcs', label: 'NPCs spawnen', group: 'Gameplay', type: 'boolean', default: true },
  { key: 'resource-pack', label: 'Ressourcenpaket-URL', group: 'Allgemein', type: 'string', default: '' },
  { key: 'resource-pack-sha1', label: 'Ressourcenpaket SHA-1', group: 'Allgemein', type: 'string', default: '' },
];

const schemaByKey = new Map(schema.map((entry) => [entry.key, entry]));

function serviceError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function propertiesPath(serverId) {
  const id = Number(serverId);
  if (!Number.isInteger(id) || id <= 0) throw serviceError('Ungültige Server-ID.');
  return path.resolve(SERVERS_DIR, String(id), 'server.properties');
}

function readDocument(serverId) {
  let text = '';
  try {
    text = fs.readFileSync(propertiesPath(serverId), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /\r?\n$/.test(text);
  const lines = text ? text.split(/\r?\n/) : [];
  if (trailingNewline) lines.pop();
  return { lines, eol, trailingNewline };
}

function parseLine(line) {
  if (/^\s*[#!]/.test(line) || /^\s*$/.test(line)) return null;
  const match = line.match(/^\s*([^\s=:]+)\s*(?:[=:]|\s)\s*(.*)$/);
  return match ? { key: match[1], value: match[2] } : null;
}

function convert(entry, rawValue) {
  if (rawValue == null) return entry.default;
  if (entry.type === 'string') return String(rawValue);
  if (entry.type === 'boolean') {
    if (rawValue === true || String(rawValue).toLowerCase() === 'true') return true;
    if (rawValue === false || String(rawValue).toLowerCase() === 'false') return false;
    return entry.default;
  }
  if (entry.type === 'integer') {
    const value = typeof rawValue === 'number' ? rawValue : Number(String(rawValue).trim());
    return Number.isInteger(value) && value >= entry.min && value <= entry.max ? value : entry.default;
  }
  if (entry.type === 'enum') {
    const value = String(rawValue).toLowerCase();
    return entry.options.includes(value) ? value : entry.default;
  }
  return entry.default;
}

function valuesFromDocument(document) {
  const raw = new Map();
  for (const line of document.lines) {
    const parsed = parseLine(line);
    if (parsed && schemaByKey.has(parsed.key)) raw.set(parsed.key, parsed.value);
  }
  return Object.fromEntries(schema.map((entry) => [entry.key, convert(entry, raw.get(entry.key))]));
}

function get(serverId) {
  return { values: valuesFromDocument(readDocument(serverId)), schema: schema.map((entry) => ({ ...entry })) };
}

function validateChanges(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw serviceError('changes muss ein Objekt sein.');
  }
  const validated = new Map();
  for (const [key, rawValue] of Object.entries(changes)) {
    const entry = schemaByKey.get(key);
    if (!entry) throw serviceError(`Unbekannte Server-Eigenschaft: ${key}.`);
    if (entry.readOnly) throw serviceError(`Die Eigenschaft ${key} ist schreibgeschützt.`);

    let value;
    if (entry.type === 'string') {
      if (typeof rawValue !== 'string') throw serviceError(`${key} muss eine Zeichenkette sein.`);
      if (/\r|\n/.test(rawValue)) throw serviceError(`${key} darf keinen Zeilenumbruch enthalten.`);
      value = rawValue;
    } else if (entry.type === 'boolean') {
      if (typeof rawValue !== 'boolean') throw serviceError(`${key} muss true oder false sein.`);
      value = rawValue;
    } else if (entry.type === 'integer') {
      if (!Number.isInteger(rawValue) || rawValue < entry.min || rawValue > entry.max) {
        throw serviceError(`${key} muss eine ganze Zahl zwischen ${entry.min} und ${entry.max} sein.`);
      }
      value = rawValue;
    } else if (entry.type === 'enum') {
      if (typeof rawValue !== 'string' || !entry.options.includes(rawValue)) {
        throw serviceError(`${key} muss einen der folgenden Werte haben: ${entry.options.join(', ')}.`);
      }
      value = rawValue;
    }
    validated.set(key, String(value));
  }
  return validated;
}

async function writeAtomic(target, content) {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.server.properties.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    await fs.promises.writeFile(temporary, content, 'utf8');
    await fs.promises.rename(temporary, target);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function update(serverId, changes) {
  const validated = validateChanges(changes);
  const document = readDocument(serverId);
  const found = new Set();
  const lines = document.lines.map((line) => {
    const parsed = parseLine(line);
    if (!parsed || !validated.has(parsed.key)) return line;
    found.add(parsed.key);
    return `${parsed.key}=${validated.get(parsed.key)}`;
  });
  for (const [key, value] of validated) {
    if (!found.has(key)) lines.push(`${key}=${value}`);
  }

  let content = lines.join(document.eol);
  if (lines.length && (document.trailingNewline || !document.lines.length)) content += document.eol;
  await writeAtomic(propertiesPath(serverId), content);
  return { values: valuesFromDocument({ lines, eol: document.eol, trailingNewline: true }), restartRequired: true };
}

module.exports = { get, update };
