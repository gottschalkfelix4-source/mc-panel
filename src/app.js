'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const config = require('./config');
const accessService = require('./services/accessService');
const auditService = require('./services/auditService');
const { verifyToken } = require('./middleware/authMiddleware');

function createPanel({ logging = !config.isTest } = {}) {
  const app = express();
  const server = http.createServer(app);
  const ioOptions = config.corsOrigins.length ? { cors: { origin: config.corsOrigins } } : {};
  const io = new Server(server, ioOptions);

  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (typeof token !== 'string' || !token) return next(new Error('Authentication required'));
    try {
      socket.user = verifyToken(token);
      if (socket.user.mustChangePassword) return next(new Error('Password change required'));
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  app.disable('x-powered-by');
  if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
  }));
  if (config.corsOrigins.length) app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '2mb' }));
  if (logging) app.use(morgan('dev'));
  app.use(auditService.middleware);
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
  });

  require('./routes/api').init(app, io);
  require('./routes/filesBackups').init(app, io);
  require('./routes/serverAdmin').init(app, io);
  try {
    require('./routes/modpacks').init(app, io);
  } catch (error) {
    console.warn('[boot] Modpack routes not available, skipping:', error.message);
  }

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  app.locals.io = io;
  io.on('connection', (socket) => {
    socket.join(`user:${socket.user.id}`);
    for (const serverId of accessService.accessibleServerIds(socket.user)) {
      socket.join(`server:${serverId}`);
    }
    const revalidate = setInterval(() => {
      try {
        socket.user = verifyToken(tokenForSocket(socket));
        if (socket.user.mustChangePassword) socket.disconnect(true);
      } catch {
        socket.disconnect(true);
      }
    }, 60_000);
    revalidate.unref();
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
    socket.on('disconnect', () => clearInterval(revalidate));
  });

  return { app, server, io };
}

function tokenForSocket(socket) {
  return socket.handshake.auth && socket.handshake.auth.token;
}

module.exports = { createPanel };
