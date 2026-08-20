// Executable entry point for Minecraft Hosting Panel.
'use strict';

require('dotenv').config();

const config = require('./src/config');
const { db } = require('./src/services/database');
const { createPanel } = require('./src/app');
const serverService = require('./src/services/serverService');
const processManager = require('./src/services/processManager');
const metricsService = require('./src/services/metricsService');
const backupService = require('./src/services/backupService');
const updateService = require('./src/services/updateService');
const setupService = require('./src/services/setupService');

async function main() {
  const { server, io } = createPanel();
  if (config.demoMode) serverService.seedDemoData();
  await processManager.init(io);
  backupService.init(io);
  updateService.init(io);
  setupService.logSetupInstructions();

  const port = Number(process.env.PORT || 3000);
  server.listen(port, config.bindHost, () => {
    console.log(`Minecraft Hosting Panel listening on ${config.bindHost}:${port}`);
    metricsService.start(io);
  });

  function shutdown(signal) {
    console.log(`\n${signal} received - shutting down gracefully`);
    metricsService.stop();
    processManager.shutdownAll();
    try { db.close(); } catch { /* already closed */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return { server, io };
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[boot] Start fehlgeschlagen:', error);
    process.exit(1);
  });
}

module.exports = { main };
