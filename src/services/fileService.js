'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const fsp = fs.promises;
const SERVERS_DIR = process.env.SERVERS_DIR || './servers';
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const EDITABLE_EXTENSIONS = new Set([
  '.txt', '.json', '.properties', '.yml', '.yaml', '.toml', '.cfg', '.conf',
  '.log', '.md', '.xml', '.js', '.sh', '.bat',
]);

function serviceError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function serverRoot(serverId) {
  const value = String(serverId);
  if (!/^[1-9]\d*$/.test(value)) throw serviceError('VALIDATION', 'Invalid server id');
  return path.resolve(process.cwd(), SERVERS_DIR, value);
}

function normalizeRelative(value, allowRoot = true) {
  if (typeof value !== 'string') throw serviceError('VALIDATION', 'Path must be a string');
  if (value.includes('\0')) throw serviceError('VALIDATION', 'Path contains invalid characters');

  const slashPath = value.replace(/\\/g, '/');
  if (path.posix.isAbsolute(slashPath) || /^[A-Za-z]:/.test(slashPath)) {
    throw serviceError('VALIDATION', 'Absolute paths are not allowed');
  }
  if (slashPath.split('/').includes('..')) {
    throw serviceError('VALIDATION', 'Path traversal is not allowed');
  }

  const normalized = path.posix.normalize(slashPath).replace(/^\.\//, '');
  const rel = normalized === '.' ? '' : normalized;
  if (!allowRoot && !rel) throw serviceError('VALIDATION', 'The server root is not allowed');
  return rel;
}

function resolveTarget(serverId, value, allowRoot = true) {
  const root = serverRoot(serverId);
  const rel = normalizeRelative(value, allowRoot);
  const target = path.resolve(root, ...rel.split('/').filter(Boolean));
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw serviceError('VALIDATION', 'Path traversal is not allowed');
  }
  return { root, rel, target };
}

async function assertNotSymlink(target) {
  const stat = await fsp.lstat(target);
  if (stat.isSymbolicLink()) throw serviceError('VALIDATION', 'Symbolic links are not allowed');
  return stat;
}

async function inspectExistingSegments(root, rel) {
  await assertNotSymlink(root);
  let current = root;
  for (const segment of rel.split('/').filter(Boolean)) {
    current = path.join(current, segment);
    try {
      await assertNotSymlink(current);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
  }
}

function isEditable(rel) {
  return EDITABLE_EXTENSIONS.has(path.extname(rel).toLowerCase());
}

async function list(serverId, value = '') {
  const { root, rel, target } = resolveTarget(serverId, value);
  await fsp.mkdir(root, { recursive: true });
  await inspectExistingSegments(root, rel);
  const targetStat = await assertNotSymlink(target);
  if (!targetStat.isDirectory()) throw serviceError('VALIDATION', 'Path is not a directory');

  const children = await fsp.readdir(target);
  const entries = [];
  for (const name of children) {
    const child = path.join(target, name);
    const stat = await fsp.lstat(child);
    if (stat.isSymbolicLink()) continue;
    const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : null;
    if (!type) continue;
    const childRel = rel ? `${rel}/${name}` : name;
    entries.push({
      name,
      path: childRel,
      type,
      size: type === 'file' ? stat.size : 0,
      modifiedAt: stat.mtimeMs,
      editable: type === 'file' && isEditable(childRel),
    });
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { path: rel, entries };
}

async function readText(serverId, value) {
  const { root, rel, target } = resolveTarget(serverId, value, false);
  if (!isEditable(rel)) throw serviceError('NOT_EDITABLE', 'File type is not editable');
  await inspectExistingSegments(root, rel);
  const stat = await assertNotSymlink(target);
  if (!stat.isFile()) throw serviceError('VALIDATION', 'Path is not a file');
  if (stat.size > MAX_TEXT_BYTES) throw serviceError('TOO_LARGE', 'File exceeds the 2 MB text limit');
  const content = await fsp.readFile(target, 'utf8');
  return { path: rel, content, size: stat.size };
}

async function atomicWrite(target, data) {
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  try {
    await fsp.writeFile(temp, data, { flag: 'wx' });
    await fsp.rename(temp, target);
  } catch (err) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

async function prepareWrite(serverId, value) {
  const resolved = resolveTarget(serverId, value, false);
  await fsp.mkdir(resolved.root, { recursive: true });
  await inspectExistingSegments(resolved.root, resolved.rel);
  const parentStat = await assertNotSymlink(path.dirname(resolved.target));
  if (!parentStat.isDirectory()) throw serviceError('VALIDATION', 'Parent path is not a directory');
  try {
    const stat = await assertNotSymlink(resolved.target);
    if (!stat.isFile()) throw serviceError('VALIDATION', 'Path is not a file');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return resolved;
}

async function writeText(serverId, value, content) {
  if (typeof content !== 'string') throw serviceError('VALIDATION', 'Content must be a string');
  const { rel, target } = await prepareWrite(serverId, value);
  if (!isEditable(rel)) throw serviceError('NOT_EDITABLE', 'File type is not editable');
  if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) {
    throw serviceError('TOO_LARGE', 'Content exceeds the 2 MB text limit');
  }
  await atomicWrite(target, content);
}

async function createFolder(serverId, value) {
  const { root, rel, target } = resolveTarget(serverId, value, false);
  await fsp.mkdir(root, { recursive: true });
  await inspectExistingSegments(root, rel);
  await fsp.mkdir(target, { recursive: true });
  const stat = await assertNotSymlink(target);
  if (!stat.isDirectory()) throw serviceError('VALIDATION', 'Path is not a directory');
}

async function remove(serverId, value) {
  const { root, rel, target } = resolveTarget(serverId, value, false);
  await inspectExistingSegments(root, rel);
  await assertNotSymlink(target);
  await fsp.rm(target, { recursive: true, force: false });
}

async function rename(serverId, value, newValue) {
  const source = resolveTarget(serverId, value, false);
  const destination = resolveTarget(serverId, newValue, false);
  await inspectExistingSegments(source.root, source.rel);
  await assertNotSymlink(source.target);
  await inspectExistingSegments(destination.root, destination.rel);
  const parentStat = await assertNotSymlink(path.dirname(destination.target));
  if (!parentStat.isDirectory()) throw serviceError('VALIDATION', 'Destination parent is not a directory');
  try {
    await fsp.lstat(destination.target);
    throw serviceError('VALIDATION', 'Destination already exists');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await fsp.rename(source.target, destination.target);
}

async function getDownloadPath(serverId, value) {
  const { root, rel, target } = resolveTarget(serverId, value, false);
  await inspectExistingSegments(root, rel);
  const stat = await assertNotSymlink(target);
  if (!stat.isFile()) throw serviceError('VALIDATION', 'Path is not a file');
  return target;
}

async function writeBinary(serverId, value, data) {
  if (!Buffer.isBuffer(data)) throw serviceError('VALIDATION', 'Upload body must be binary');
  const { target } = await prepareWrite(serverId, value);
  await atomicWrite(target, data);
}

module.exports = {
  list,
  readText,
  writeText,
  createFolder,
  remove,
  rename,
  getDownloadPath,
  writeBinary,
};
