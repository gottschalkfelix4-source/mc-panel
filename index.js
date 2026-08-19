// Main entry point for Minecraft Hosting Panel.
'use strict';

require('dotenv').config(); // must be first so services see env vars

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const { db } = require('./src/services/database');
const serverService = require('./src/services/serverService');
const processManager = require('./src/services/processManager');
const metricsService = require('./src/services/metricsService');
const accessService = require('./src/services/accessService');
const { verifyToken } = require('./src/middleware/authMiddleware');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (typeof token !== 'string' || !token) return next(new Error('Authentication required'));
  try {
    socket.user = verifyToken(token);
    next();
  } catch {
    next(new Error('Invalid or expired token'));
  }
});

// Middleware
app.use(helmet({ contentSecurityPolicy: false })); // CSP off: CDN fonts/inline SVGs
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));
app.use(express.static('public'));

// Seed demo servers + metrics history (no-op if servers already exist)
serverService.seedDemoData();
processManager.init(io);

// Health check (no auth required)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Core API routes
require('./src/routes/api').init(app, io);

// Per-server management (files, backups, players, properties) + global users
require('./src/routes/filesBackups').init(app, io);
require('./src/routes/serverAdmin').init(app, io);

// Modpack routes (built by another agent in parallel — tolerate absence)
try {
  require('./src/routes/modpacks').init(app, io);
} catch (err) {
  console.warn('[boot] Modpack routes not available, skipping:', err.message);
}

// SPA entry
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Expose io both ways for other services/routes
app.locals.io = io;
module.exports = { io };

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  for (const serverId of accessService.accessibleServerIds(socket.user)) {
    socket.join(`server:${serverId}`);
  }
  socket.on('subscribe', (serverId) => {
    const id = Number(serverId);
    if (!Number.isInteger(id) || id <= 0 || !accessService.canAccess(socket.user, id)) {
      socket.emit('access:error', { serverId, error: 'Server not found' });
      return;
    }
    socket.join(`server:${id}`);
  });
  socket.on('unsubscribe', (serverId) => {
    const id = Number(serverId);
    if (Number.isInteger(id) && id > 0) socket.leave(`server:${id}`);
  });
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Minecraft Hosting Panel running on http://localhost:${PORT}`);
  metricsService.start(io);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully`);
  metricsService.stop();
  processManager.shutdownAll();
  try {
    db.close();
  } catch {
    // already closed
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref(); // hard exit fallback
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
