// Central job log for admins: aggregates modpack install jobs and backup jobs,
// and allows admins to cancel queued/running jobs.
'use strict';

const modpackService = require('./modpackService');
const backupService = require('./backupService');

function mapBackupJob(job) {
  return {
    id: job.id,
    type: 'backup',
    serverId: job.serverId,
    name: job.backupId || 'Backup',
    status: job.status,
    percent: job.percent,
    stage: job.stage,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function listJobs(limit = 100) {
  const modpackRows = modpackService.listJobs(limit);
  const backupRows = backupService.listJobs(limit);
  return [...modpackRows, ...backupRows.map(mapBackupJob)]
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, limit);
}

function cancelJob(jobId) {
  if (modpackService.abortJob(jobId)) return { type: 'modpack', id: jobId };
  if (backupService.abortJob(jobId)) return { type: 'backup', id: jobId };
  const error = new Error('Job nicht gefunden oder nicht mehr aktiv.');
  error.status = 404;
  throw error;
}

module.exports = { listJobs, cancelJob };
