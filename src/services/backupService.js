'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { ZipArchive } = require('archiver');
const unzipper = require('unzipper');
const backupPolicy = require('./backupPolicyService');

const fsp = fs.promises;
const SERVERS_DIR = process.env.SERVERS_DIR || './servers';
const BACKUPS_DIR = process.env.BACKUPS_DIR || './backups';
const jobs = new Map();
const reservations = new Map();
let socketIo = null;
let schedulerStarted = false;
let schedulerRun = null;
let quotaQueue = Promise.resolve();

function serviceError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function init(io) {
  socketIo = io || null;
  if (schedulerStarted) return;
  schedulerStarted = true;
  const firstRun = setTimeout(() => {
    runSchedulerNow().catch((err) => console.error('[backup] scheduler failed:', err));
  }, 5_000);
  firstRun.unref();
  const interval = setInterval(() => {
    runSchedulerNow().catch((err) => console.error('[backup] scheduler failed:', err));
  }, 60_000);
  interval.unref();
}

function activeJobForServer(serverId) {
  return Array.from(jobs.values()).some(
    (job) => job.serverId === Number(serverId) && ['queued', 'running'].includes(job.status)
  );
}

async function runSchedulerNow() {
  if (schedulerRun) return schedulerRun;
  schedulerRun = (async () => {
    const started = [];
    for (const server of backupPolicy.dueServers(Date.now())) {
      if (activeJobForServer(server.id)) continue;
      try {
        const job = create(server.id, 'Automatisch', { automatic: true });
        backupPolicy.markScheduled(server.id, false);
        started.push(job);
      } catch (err) {
        console.error(`[backup] could not schedule server ${server.id}:`, err);
      }
    }
    return started;
  })().finally(() => {
    schedulerRun = null;
  });
  return schedulerRun;
}

async function withQuotaLock(task) {
  const previous = quotaQueue;
  let release;
  quotaQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

function reservedBytes(serverId, excludeJobId = null) {
  let global = 0;
  let server = 0;
  for (const [jobId, reservation] of reservations) {
    if (jobId === excludeJobId) continue;
    global += reservation.bytes;
    if (reservation.serverId === Number(serverId)) server += reservation.bytes;
  }
  return { global, server };
}

function roots(serverId) {
  const value = String(serverId);
  if (!/^[1-9]\d*$/.test(value)) throw serviceError('VALIDATION', 'Invalid server id');
  const serverRoot = path.resolve(process.cwd(), SERVERS_DIR, value);
  const backupRoot = path.resolve(process.cwd(), BACKUPS_DIR, value);
  const overlaps =
    serverRoot === backupRoot ||
    serverRoot.startsWith(backupRoot + path.sep) ||
    backupRoot.startsWith(serverRoot + path.sep);
  if (overlaps) throw serviceError('VALIDATION', 'Backup directory must be outside the server directory');
  return { serverRoot, backupRoot };
}

async function rejectSymlink(target) {
  const stat = await fsp.lstat(target);
  if (stat.isSymbolicLink()) throw serviceError('VALIDATION', 'Symbolic links are not allowed');
  return stat;
}

async function ensureSeparated(serverRoot, backupRoot) {
  const [realServer, realBackup] = await Promise.all([
    fsp.realpath(serverRoot),
    fsp.realpath(backupRoot),
  ]);
  const overlaps =
    realServer === realBackup ||
    realServer.startsWith(realBackup + path.sep) ||
    realBackup.startsWith(realServer + path.sep);
  if (overlaps) throw serviceError('VALIDATION', 'Backup directory must be outside the server directory');
}

function validateBackupId(backupId) {
  if (
    typeof backupId !== 'string' ||
    !backupId ||
    backupId.includes('\0') ||
    path.basename(backupId) !== backupId ||
    path.posix.basename(backupId) !== backupId ||
    !backupId.endsWith('.zip')
  ) {
    throw serviceError('VALIDATION', 'Invalid backup id');
  }
  return backupId;
}

function sanitizeName(name) {
  const normalized = String(name == null ? '' : name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/[-_]{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 48)
    .replace(/[-_]+$/g, '');
  return normalized || 'backup';
}

function backupFileName(name) {
  return `${Date.now()}-${sanitizeName(name)}-${crypto.randomBytes(3).toString('hex')}.zip`;
}

function publicJob(job) {
  return { ...job, jobId: job.id };
}

function updateJob(job, changes) {
  Object.assign(job, changes, { updatedAt: Date.now() });
  if (socketIo) socketIo.to(`server:${job.serverId}`).emit('backup:progress', publicJob(job));
}

function newJob(serverId, type, backupId = null, options = {}) {
  const timestamp = Date.now();
  const job = {
    id: crypto.randomUUID(),
    serverId: Number(serverId),
    type,
    status: 'queued',
    percent: 0,
    stage: 'Queued',
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    backupId,
    automatic: Boolean(options.automatic),
  };
  jobs.set(job.id, job);
  if (socketIo) socketIo.to(`server:${job.serverId}`).emit('backup:progress', publicJob(job));
  return job;
}

function safeJobError(type, err) {
  if (err && err.code === 'ENOENT') return type === 'create' ? 'Server files not found' : 'Backup not found';
  if (err && ['VALIDATION', 'QUOTA'].includes(err.code)) return err.message;
  return type === 'create' ? 'Backup creation failed' : 'Backup restore failed';
}

async function scanServer(root) {
  const rootStat = await rejectSymlink(root);
  if (!rootStat.isDirectory()) throw serviceError('VALIDATION', 'Server path is not a directory');
  const entries = [];
  let totalBytes = 0;

  async function walk(directory, relative) {
    const names = await fsp.readdir(directory);
    if (relative && names.length === 0) entries.push({ type: 'directory', path: `${relative}/` });
    for (const name of names) {
      const absolute = path.join(directory, name);
      const stat = await fsp.lstat(absolute);
      if (stat.isSymbolicLink()) continue;
      const entryPath = relative ? `${relative}/${name}` : name;
      if (stat.isDirectory()) {
        await walk(absolute, entryPath);
      } else if (stat.isFile()) {
        entries.push({ type: 'file', path: entryPath, absolute, size: stat.size });
        totalBytes += stat.size;
      }
    }
  }

  await walk(root, '');
  return { entries, totalBytes };
}

async function runCreate(job) {
  const { serverRoot, backupRoot } = roots(job.serverId);
  const outputPath = path.join(backupRoot, job.backupId);
  const temporaryPath = `${outputPath}.partial`;
  let reserved = false;
  let completed = false;
  try {
    updateJob(job, { status: 'running', percent: 1, stage: 'Calculating size' });
    await rejectSymlink(serverRoot);
    await fsp.mkdir(backupRoot, { recursive: true });
    await rejectSymlink(backupRoot);
    await ensureSeparated(serverRoot, backupRoot);
    const { entries, totalBytes } = await scanServer(serverRoot);
    const estimatedBytes = Math.ceil(totalBytes * 1.05);

    await withQuotaLock(async () => {
      await backupPolicy.pruneCount(job.serverId);
      const pending = reservedBytes(job.serverId);
      const quota = await backupPolicy.checkQuota(
        job.serverId,
        estimatedBytes,
        pending.global,
        pending.server
      );
      if (!quota.allowed) throw serviceError('QUOTA', quota.reason);
      reservations.set(job.id, { serverId: job.serverId, bytes: estimatedBytes });
      reserved = true;
    });
    updateJob(job, { percent: 5, stage: 'Archiving' });

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(temporaryPath, { flags: 'wx' });
      const archive = new ZipArchive({ zlib: { level: 6 } });
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      output.on('close', () => finish());
      output.on('error', finish);
      archive.on('error', finish);
      archive.on('warning', finish);
      archive.on('progress', (progress) => {
        const processed = progress && progress.fs ? progress.fs.processedBytes : 0;
        const ratio = totalBytes > 0 ? Math.min(processed / totalBytes, 1) : 1;
        const percent = Math.min(99, 5 + Math.floor(ratio * 94));
        if (percent !== job.percent) updateJob(job, { percent });
      });
      archive.pipe(output);
      for (const entry of entries) {
        if (entry.type === 'directory') archive.append('', { name: entry.path });
        else archive.file(entry.absolute, { name: entry.path });
      }
      archive.finalize().catch(finish);
    });

    await withQuotaLock(async () => {
      await backupPolicy.pruneCount(job.serverId);
      const archiveStat = await fsp.lstat(temporaryPath);
      if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) {
        throw serviceError('VALIDATION', 'Das erstellte Backup ist ungültig.');
      }
      const pending = reservedBytes(job.serverId, job.id);
      const quota = await backupPolicy.checkQuota(
        job.serverId,
        archiveStat.size,
        pending.global,
        pending.server
      );
      if (!quota.allowed) throw serviceError('QUOTA', quota.reason);
      await fsp.rename(temporaryPath, outputPath);
      reservations.delete(job.id);
      reserved = false;
      completed = true;
    });

    if (job.automatic) {
      try {
        backupPolicy.markScheduled(job.serverId, true);
      } catch (err) {
        console.error(`[backup] could not mark automatic backup ${job.id} successful:`, err);
      }
    }
    updateJob(job, { status: 'done', percent: 100, stage: 'Complete' });
  } catch (err) {
    console.error(`[backup] create job ${job.id} failed:`, err);
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
    if (!completed) await fsp.rm(outputPath, { force: true }).catch(() => {});
    updateJob(job, {
      status: 'error',
      stage: 'Failed',
      error: safeJobError('create', err),
    });
  } finally {
    if (reserved) reservations.delete(job.id);
  }
}

async function list(serverId) {
  const { backupRoot } = roots(serverId);
  await fsp.mkdir(backupRoot, { recursive: true });
  await rejectSymlink(backupRoot);
  const names = await fsp.readdir(backupRoot);
  const backups = [];
  for (const id of names) {
    if (!id.endsWith('.zip')) continue;
    const stat = await fsp.lstat(path.join(backupRoot, id));
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const match = id.match(/^(\d+)-(.+)-[a-f0-9]{6}\.zip$/);
    backups.push({
      id,
      name: match ? match[2].replace(/[-_]+/g, ' ') : id.slice(0, -4),
      size: stat.size,
      createdAt: match ? Number(match[1]) : stat.mtimeMs,
      automatic: id.includes(`-${sanitizeName('Automatisch')}-`),
    });
  }
  backups.sort((a, b) => b.createdAt - a.createdAt);
  return backups;
}

function create(serverId, name, options = {}) {
  roots(serverId);
  const job = newJob(serverId, 'create', backupFileName(name), options);
  setImmediate(() => runCreate(job));
  return publicJob(job);
}

function validateArchivePath(value, root) {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw serviceError('VALIDATION', 'Archive contains an invalid path');
  }
  const slashPath = value.replace(/\\/g, '/');
  if (path.posix.isAbsolute(slashPath) || /^[A-Za-z]:/.test(slashPath)) {
    throw serviceError('VALIDATION', 'Archive contains an absolute path');
  }
  if (slashPath.split('/').includes('..')) {
    throw serviceError('VALIDATION', 'Archive contains path traversal');
  }
  const relative = path.posix.normalize(slashPath).replace(/^\.\//, '').replace(/\/$/, '');
  if (!relative || relative === '.') return { relative: '', target: root };
  const target = path.resolve(root, ...relative.split('/'));
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw serviceError('VALIDATION', 'Archive contains path traversal');
  }
  return { relative, target };
}

function isZipSymlink(entry) {
  const attributes = Number(entry.externalFileAttributes || 0) >>> 0;
  const mode = (attributes >>> 16) & 0xffff;
  return (mode & 0o170000) === 0o120000;
}

async function runRestore(job) {
  try {
    updateJob(job, { status: 'running', percent: 1, stage: 'Validating archive' });
    const { serverRoot, backupRoot } = roots(job.serverId);
    const archivePath = await getPath(job.serverId, job.backupId);
    await fsp.mkdir(serverRoot, { recursive: true });
    await rejectSymlink(serverRoot);
    await rejectSymlink(backupRoot);
    await ensureSeparated(serverRoot, backupRoot);

    const archive = await unzipper.Open.file(archivePath);
    const entries = archive.files.map((entry) => {
      if (isZipSymlink(entry) || !['File', 'Directory'].includes(entry.type)) {
        throw serviceError('VALIDATION', 'Archive contains an unsupported entry');
      }
      return { entry, ...validateArchivePath(entry.path, serverRoot) };
    });

    updateJob(job, { percent: 5, stage: 'Clearing server files' });
    const current = await fsp.readdir(serverRoot);
    for (const name of current) {
      await fsp.rm(path.join(serverRoot, name), { recursive: true, force: true });
    }

    updateJob(job, { stage: 'Restoring files' });
    const extractable = entries.filter(({ relative }) => relative);
    for (let index = 0; index < extractable.length; index += 1) {
      const { entry, target } = extractable[index];
      if (entry.type === 'Directory') {
        await fsp.mkdir(target, { recursive: true });
      } else {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await pipeline(entry.stream(), fs.createWriteStream(target, { flags: 'wx' }));
      }
      const percent = Math.min(99, 5 + Math.floor(((index + 1) / extractable.length) * 94));
      if (percent !== job.percent) updateJob(job, { percent });
    }
    updateJob(job, { status: 'done', percent: 100, stage: 'Complete' });
  } catch (err) {
    console.error(`[backup] restore job ${job.id} failed:`, err);
    updateJob(job, {
      status: 'error',
      stage: 'Failed',
      error: safeJobError('restore', err),
    });
  }
}

function restore(serverId, backupId) {
  roots(serverId);
  const id = validateBackupId(backupId);
  const job = newJob(serverId, 'restore', id);
  setImmediate(() => runRestore(job));
  return publicJob(job);
}

async function remove(serverId, backupId) {
  const target = await getPath(serverId, backupId);
  await fsp.unlink(target);
}

async function getPath(serverId, backupId) {
  const id = validateBackupId(backupId);
  const { backupRoot } = roots(serverId);
  await fsp.mkdir(backupRoot, { recursive: true });
  await rejectSymlink(backupRoot);
  const target = path.resolve(backupRoot, id);
  if (!target.startsWith(backupRoot + path.sep)) throw serviceError('VALIDATION', 'Invalid backup id');
  const stat = await rejectSymlink(target);
  if (!stat.isFile()) throw serviceError('VALIDATION', 'Backup is not a file');
  return target;
}

function getJob(jobId) {
  const job = jobs.get(jobId);
  return job ? publicJob(job) : null;
}

function listJobs(limit = 100) {
  return Array.from(jobs.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map(publicJob);
}

function abortJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return false;
  if (job.status !== 'running' && job.status !== 'queued') return false;
  updateJob(job, { status: 'aborted', stage: 'aborted', error: 'Vom Administrator abgebrochen' });
  return true;
}

module.exports = { init, list, create, restore, remove, getPath, getJob, listJobs, abortJob, runSchedulerNow };
