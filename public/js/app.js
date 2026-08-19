/* app.js — bootstrap: auth, router, socket, toasts, modals, particles,
   animated floating-block background, topbar summary, rotating tips.
   Load order: icons.js -> api.js -> management.js -> charts.js -> views.js -> app.js */
(function (global) {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ------------------------------- helpers ------------------------------- */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtDownloads(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace('.', ',') + ' k';
    return String(n);
  }

  function fmtMB(mb) {
    mb = Number(mb) || 0;
    if (mb >= 1024) return (mb / 1024).toFixed(1).replace('.', ',') + ' GB';
    return Math.round(mb) + ' MB';
  }

  function fmtUptime(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d > 0) return d + 'T ' + h + 'Std';
    if (h > 0) return h + 'Std ' + m + 'Min';
    return m + 'Min';
  }

  function fmtClock(ts) {
    var d = new Date(ts);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
  }

  function fmtDate(ts) {
    try { return new Date(ts).toLocaleDateString('de-DE'); } catch (e) { return ''; }
  }

  // status -> css class + German label
  function statusInfo(status) {
    switch (String(status || '').toLowerCase()) {
      case 'online': return { cls: 'lamp-online', label: 'Online', tone: 'ok' };
      case 'starting': return { cls: 'lamp-starting', label: 'Startet …', tone: 'warn' };
      case 'stopping': return { cls: 'lamp-stopping', label: 'Stoppt …', tone: 'warn' };
      case 'offline': return { cls: 'lamp-offline', label: 'Offline', tone: 'off' };
      default: return { cls: 'lamp-offline', label: status || 'Unbekannt', tone: 'off' };
    }
  }

  function srvIcon(name) { return '<span class="pix">' + global.Icons.get(name) + '</span>'; }

  /* --------------------------------- state -------------------------------- */

  var App = {
    state: {
      user: null,
      servers: [],
      summary: null,
      socket: null,
      detailId: null,          // currently open server-detail id
      detailHandlers: null,    // {tick, log, status, init, modsChanged} set by views
      spark: {},               // serverId -> [{ts,cpu}] mini buffers for dashboard sparklines
      jobs: {},                // jobId -> {id,serverId,name,percent,stage,status,error,timer}
      jobListeners: {},        // jobId -> fn(job)
      cleanup: null,           // cleanup fn of current view
      summaryTimer: null,
      tipTimer: null
    }
  };

  App.$ = $; App.$$ = $$;
  App.esc = esc; App.fmtDownloads = fmtDownloads; App.fmtMB = fmtMB;
  App.fmtUptime = fmtUptime; App.fmtClock = fmtClock; App.fmtDate = fmtDate;
  App.statusInfo = statusInfo; App.srvIcon = srvIcon;

  /* --------------------------------- toasts -------------------------------- */

  function toast(msg, type, title) {
    type = type || 'ok';
    var root = $('#toast-root');
    if (!root) return;
    var t = document.createElement('div');
    t.className = 'toast toast-' + type;
    t.innerHTML =
      '<div class="toast-bar"></div>' +
      '<div class="toast-body">' +
      (title ? '<div class="toast-title">' + esc(title) + '</div>' : '') +
      '<div class="toast-msg">' + esc(msg) + '</div>' +
      '</div><button class="toast-x" aria-label="Schließen">&times;</button>';
    root.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    var kill = function () {
      t.classList.remove('show');
      setTimeout(function () { t.remove(); }, 250);
    };
    t.querySelector('.toast-x').addEventListener('click', kill);
    setTimeout(kill, 4800);
  }
  App.toast = toast;

  /* --------------------------------- modals -------------------------------- */

  function openModal(contentEl, opts) {
    opts = opts || {};
    var dismissible = opts.dismissible !== false;
    var root = $('#modal-root');
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    var box = document.createElement('div');
    box.className = 'modal' + (opts.full ? ' modal-full' : '') + (opts.wide ? ' modal-wide' : '');
    box.appendChild(contentEl);
    overlay.appendChild(box);
    root.appendChild(overlay);
    requestAnimationFrame(function () { overlay.classList.add('show'); });

    if (dismissible) {
      overlay.addEventListener('mousedown', function (ev) {
        if (ev.target === overlay) closeModal(overlay);
      });
      overlay._escHandler = function (ev) { if (ev.key === 'Escape') closeModal(overlay); };
      document.addEventListener('keydown', overlay._escHandler);
    }
    return overlay;
  }

  function closeModal(overlay) {
    if (!overlay) {
      var root = $('#modal-root');
      overlay = root && root.lastElementChild;
      if (!overlay) return;
    }
    overlay.classList.remove('show');
    if (overlay._escHandler) document.removeEventListener('keydown', overlay._escHandler);
    setTimeout(function () { overlay.remove(); }, 180);
  }
  App.openModal = openModal; App.closeModal = closeModal;

  function confirmDialog(title, text, okLabel) {
    return new Promise(function (resolve) {
      var box = document.createElement('div');
      box.innerHTML =
        '<div class="modal-head"><h3 class="modal-title">' + esc(title) + '</h3></div>' +
        '<div class="modal-body"><p class="confirm-text">' + esc(text) + '</p></div>' +
        '<div class="modal-foot">' +
        '<button class="btn btn-ghost" data-act="no">Abbrechen</button>' +
        '<button class="btn btn-danger" data-act="yes">' + esc(okLabel || 'Löschen') + '</button>' +
        '</div>';
      var ov = openModal(box);
      box.addEventListener('click', function (ev) {
        var act = ev.target.getAttribute('data-act');
        if (!act) return;
        closeModal(ov);
        resolve(act === 'yes');
      });
    });
  }
  App.confirm = confirmDialog;

  /* ------------------------------- particles ------------------------------- */

  var particles = [];
  var particleRaf = null;

  function particleBurst(x, y, colors) {
    colors = colors || ['#44bd32', '#8dff57', '#7CB342', '#8a5f3c', '#2f8f22'];
    var layer = $('#particle-layer');
    if (!layer) return;
    for (var i = 0; i < 14; i++) {
      var p = document.createElement('div');
      p.className = 'particle';
      var size = 4 + Math.random() * 5;
      p.style.width = size + 'px';
      p.style.height = size + 'px';
      p.style.background = colors[Math.floor(Math.random() * colors.length)];
      layer.appendChild(p);
      particles.push({
        el: p, x: x, y: y,
        vx: (Math.random() - 0.5) * 260,
        vy: -80 - Math.random() * 180,
        life: 600 + Math.random() * 350,
        born: performance.now()
      });
    }
    if (!particleRaf) particleRaf = requestAnimationFrame(stepParticles);
  }
  App.particleBurst = particleBurst;

  function stepParticles(now) {
    var gravity = 700; // px/s^2
    particles = particles.filter(function (p) {
      var age = now - p.born;
      if (age >= p.life) { p.el.remove(); return false; }
      var t = age / 1000;
      var px = p.x + p.vx * t;
      var py = p.y + p.vy * t + 0.5 * gravity * t * t;
      p.el.style.transform = 'translate(' + px + 'px,' + py + 'px)';
      p.el.style.opacity = String(1 - age / p.life);
      return true;
    });
    particleRaf = particles.length ? requestAnimationFrame(stepParticles) : null;
  }

  // tiny block-burst on every minecraft-button click
  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('.btn, .icon-btn') : null;
    if (btn && !btn.disabled && !btn.classList.contains('no-burst')) {
      particleBurst(ev.clientX, ev.clientY);
    }
  });

  /* ---------------------------- server actions ----------------------------- */

  async function power(id, action, btn) {
    if (btn) btn.disabled = true;
    try {
      var res = await global.API.power(id, action);
      if (res && res.status) updateStatusEverywhere(id, res.status);
      var label = { start: 'gestartet', stop: 'gestoppt', restart: 'neu gestartet' }[action] || action;
      toast('Server wird ' + label + ' …', 'ok');
    } catch (e) {
      // real mode: starting an uninstalled server -> open the install wizard
      if (e.status === 409 && e.data && e.data.code === 'NOT_INSTALLED') {
        var srv = (App.state.servers || []).find(function (s) { return String(s.id) === String(id); });
        if (srv && global.Views && typeof global.Views.installWizard === 'function') {
          if (btn) btn.disabled = false;
          global.Views.installWizard(srv);
          return;
        }
      }
      if (e.status !== 401) toast(e.message || 'Aktion fehlgeschlagen', 'err');
      if (btn) btn.disabled = false;
    }
  }
  App.power = power;

  async function deleteServer(srv) {
    var ok = await confirmDialog(
      'Server löschen?',
      '„' + srv.name + '" wird unwiderruflich gelöscht — inklusive Welt. Bist du sicher?',
      'Löschen'
    );
    if (!ok) return;
    try {
      await global.API.deleteServer(srv.id);
      toast('Server „' + srv.name + '" gelöscht.', 'ok');
      if (App.state.detailId === srv.id) location.hash = '#/';
      else if (App.state.refreshView) App.state.refreshView();
      refreshSummary();
    } catch (e) {
      if (e.status !== 401) toast(e.message || 'Löschen fehlgeschlagen', 'err');
    }
  }
  App.deleteServer = deleteServer;

  // keep cached server list + any visible lamps in sync
  function updateStatusEverywhere(id, status) {
    App.state.servers.forEach(function (s) { if (String(s.id) === String(id)) s.status = status; });
    $$('[data-srv-status="' + id + '"]').forEach(function (elHost) {
      var info = statusInfo(status);
      var lamp = elHost.querySelector('.lamp');
      if (lamp) lamp.className = 'lamp ' + info.cls;
      var lbl = elHost.querySelector('.status-label');
      if (lbl) lbl.textContent = info.label;
    });
    if (App.state.detailHandlers && String(App.state.detailId) === String(id) && App.state.detailHandlers.status) {
      App.state.detailHandlers.status(status);
    }
  }
  App.updateStatusEverywhere = updateStatusEverywhere;

  /* --------------------------------- socket -------------------------------- */

  function connectSocket() {
    if (typeof global.io === 'undefined') return null; // backend not serving socket.io (dev)
    if (App.state.socket) return App.state.socket;
    var s = global.io({ auth: { token: global.API.getToken() } }); // default path, authenticated per contract
    var accessErrorShown = false;

    s.on('connect', function () {
      $('#conn-lost').classList.add('hidden');
      if (App.state.detailId) {
        s.emit('subscribe', App.state.detailId);
        // refill the gap that may have opened during the disconnect
        if (App.state.detailHandlers && App.state.detailHandlers.reconnect) {
          App.state.detailHandlers.reconnect();
        }
      }
    });
    s.on('disconnect', function () {
      $('#conn-lost').classList.remove('hidden');
    });
    s.on('access:error', function (msg) {
      if (accessErrorShown) return;
      accessErrorShown = true;
      toast((msg && (msg.message || msg.error)) || 'Kein Zugriff auf diesen Server.', 'err', 'Zugriff verweigert');
    });

    s.on('metrics:init', function (msg) {
      if (msg && App.state.detailHandlers && String(App.state.detailId) === String(msg.serverId) && App.state.detailHandlers.init) {
        App.state.detailHandlers.init(msg.points || []);
      }
    });
    s.on('metrics:tick', function (m) {
      if (!m) return;
      if (App.state.detailHandlers && String(App.state.detailId) === String(m.serverId) && App.state.detailHandlers.tick) {
        App.state.detailHandlers.tick(m);
      }
    });
    s.on('server:status', function (m) {
      if (m && m.serverId !== undefined) updateStatusEverywhere(m.serverId, m.status);
      refreshSummarySoon();
    });
    s.on('log:line', function (m) {
      if (m && App.state.detailHandlers && String(App.state.detailId) === String(m.serverId) && App.state.detailHandlers.log) {
        App.state.detailHandlers.log(m);
      }
    });
    s.on('modpack:progress', function (m) {
      if (!m || !m.jobId) return;
      var job = App.state.jobs[m.jobId];
      if (job) {
        ['percent', 'stage', 'status', 'error'].forEach(function (k) {
          if (m[k] !== undefined) job[k] = m[k];
        });
        notifyJob(job);
      }
    });
    s.on('update:available', function (m) {
      if (!m) return;
      toast('„' + (m.name || 'Modpack') + '" ' + (m.latestVersion || '') + ' ist verfügbar.', 'ok', 'Modpack-Update');
      if (App.state.detailHandlers && String(App.state.detailId) === String(m.serverId) && App.state.detailHandlers.updates) {
        App.state.detailHandlers.updates();
      }
    });

    App.state.socket = s;
    return s;
  }

  function subscribeDetail(id) {
    App.state.detailId = id;
    var s = App.state.socket;
    if (s && s.connected) s.emit('subscribe', id);
  }
  function unsubscribeDetail() {
    var s = App.state.socket;
    if (s && s.connected && App.state.detailId) s.emit('unsubscribe', App.state.detailId);
    App.state.detailId = null;
    App.state.detailHandlers = null;
  }
  App.subscribeDetail = subscribeDetail;
  App.unsubscribeDetail = unsubscribeDetail;

  /* ------------------------------ modpack jobs ----------------------------- */

  function notifyJob(job) {
    var fn = App.state.jobListeners[job.id];
    if (fn) { try { fn(job); } catch (e) { /* listener gone */ } }
    if (job.status === 'done' || job.status === 'error') {
      if (job.timer) { clearInterval(job.timer); job.timer = null; }
      finishJob(job);
    }
  }

  function finishJob(job) {
    if (job._finished) return;
    job._finished = true;
    if (job.status === 'done') {
      toast('„' + job.name + '" wurde installiert.', 'ok', 'Installation abgeschlossen');
      var r = document.body.getBoundingClientRect();
      particleBurst(r.width - 120, 80, ['#44bd32', '#8dff57', '#ffd83d', '#7CB342']);
    } else {
      toast(job.error || 'Unbekannter Fehler', 'err', 'Installation fehlgeschlagen');
    }
    if (App.state.detailHandlers && App.state.detailHandlers.modsChanged &&
        String(App.state.detailId) === String(job.serverId)) {
      App.state.detailHandlers.modsChanged();
    }
    delete App.state.jobs[job.id];
    delete App.state.jobListeners[job.id];
  }

  // Track an install job: socket events are primary, 2s REST poll is the fallback.
  function trackJob(jobId, meta) {
    var job = App.state.jobs[jobId] = {
      id: jobId, serverId: meta.serverId, name: meta.name,
      percent: 0, stage: 'In Warteschlange …', status: 'running', error: null, timer: null
    };
    job.timer = setInterval(async function () {
      try {
        var j = await global.API.modpackJob(jobId);
        var cur = App.state.jobs[jobId];
        if (!cur) return;
        cur.percent = j.percent; cur.stage = j.stage; cur.status = j.status; cur.error = j.error;
        notifyJob(cur);
      } catch (e) { /* transient poll errors are fine */ }
    }, 2000);
    return job;
  }
  App.trackJob = trackJob;

  /* ------------------------------ topbar summary --------------------------- */

  var summarySoonTimer = null;
  function refreshSummarySoon() {
    if (summarySoonTimer) return;
    summarySoonTimer = setTimeout(function () { summarySoonTimer = null; refreshSummary(); }, 1200);
  }

  async function refreshSummary() {
    try {
      var s = await global.API.metricsSummary();
      App.state.summary = s;
      renderChips(s);
    } catch (e) { /* keep old chips */ }
  }
  App.refreshSummary = refreshSummary;

  function renderChips(s) {
    setChip('#chip-running', s.serversRunning + ' / ' + s.totalServers);
    setChip('#chip-cpu', Math.round(s.avgCpu || 0) + ' %');
    setChip('#chip-ram', fmtMB(s.totalRam || 0));
    setChip('#chip-players', String(s.totalPlayers || 0));
    setChip('#chip-uptime', fmtUptime(s.uptimeSec || 0));
  }

  function setChip(sel, val) {
    var el = $(sel + ' .chip-num');
    if (el && el.textContent !== val) global.Charts.countUp ? countChipText(el, val) : (el.textContent = val);
  }
  // chips may contain units -> simple text swap with a flash
  function countChipText(el, val) {
    el.textContent = val;
    el.classList.remove('chip-flash');
    void el.offsetWidth;
    el.classList.add('chip-flash');
  }

  /* --------------------------------- router -------------------------------- */

  function setNav(name) {
    $$('.nav-item').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-nav') === name);
    });
  }

  function syncSidebar() {
    // Server tab should always remain visible so admins can create servers
    // and users with zero assignments still see the (empty) server list.
    var servers = App.state.servers || [];
    var serverNav = $('[data-nav="servers"]');
    if (serverNav) serverNav.classList.remove('hidden');
    var isAdmin = App.state.user && App.state.user.role === 'admin';
    var jobsNav = $('#nav-jobs');
    if (jobsNav) jobsNav.classList.toggle('hidden', !isAdmin);
  }
  App.syncSidebar = syncSidebar;

  async function route() {
    if (!App.state.user) return;
    if (typeof App.state.cleanup === 'function') {
      try { App.state.cleanup(); } catch (e) { /* ignore */ }
      App.state.cleanup = null;
    }
    var view = $('#view');
    var hash = location.hash || '#/';
    var parts = hash.replace(/^#\//, '').split('/');

    view.classList.remove('view-enter');
    void view.offsetWidth; // restart transition
    view.classList.add('view-enter');

    if (parts[0] === 'server' && parts[1]) {
      setNav('');
      App.state.cleanup = await global.Views.serverDetail(view, parts[1]);
    } else if (parts[0] === 'servers') {
      setNav('servers');
      App.state.cleanup = await global.Views.serversList(view);
    } else if (parts[0] === 'modpacks') {
      setNav('modpacks');
      App.state.cleanup = await global.Views.modpacksPicker(view);
    } else if (parts[0] === 'jobs') {
      setNav('jobs');
      App.state.cleanup = await global.Views.jobsLog(view);
    } else if (parts[0] === 'settings') {
      setNav('settings');
      App.state.cleanup = await global.Views.settings(view);
    } else if (parts[0] === 'users') {
      setNav('users');
      App.state.cleanup = await global.Views.users(view);
    } else {
      setNav('dashboard');
      App.state.cleanup = await global.Views.dashboard(view);
    }
    $('#view').scrollTop = 0;
    window.scrollTo(0, 0);
  }
  App.route = route;

  /* ------------------------------- login/logout ---------------------------- */

  function showLogin() {
    $('#app-shell').classList.add('hidden');
    $('#login-screen').classList.remove('hidden');
    var u = $('#login-user');
    if (u) setTimeout(function () { u.focus(); }, 50);
  }

  function showApp() {
    $('#login-screen').classList.add('hidden');
    $('#app-shell').classList.remove('hidden');
    $('#user-name').textContent = App.state.user ? App.state.user.username : '';
    var navSettings = $('#nav-settings');
    if (navSettings) {
      navSettings.classList.toggle('hidden', !App.state.user || App.state.user.role !== 'admin');
    }
    var navUsers = $('#nav-users');
    if (navUsers) {
      navUsers.classList.toggle('hidden', !App.state.user || App.state.user.role !== 'admin');
    }
    syncSidebar();
    connectSocket();
    refreshSummary();
    if (App.state.summaryTimer) clearInterval(App.state.summaryTimer);
    App.state.summaryTimer = setInterval(refreshSummary, 5000);
    route();
  }

  function onUnauthorized() {
    App.state.user = null;
    if (App.state.summaryTimer) { clearInterval(App.state.summaryTimer); App.state.summaryTimer = null; }
    if (App.state.socket) { App.state.socket.disconnect(); App.state.socket = null; }
    showLogin();
    toast('Sitzung abgelaufen — bitte neu anmelden.', 'err');
  }
  App.onUnauthorized = onUnauthorized;

  function logout() {
    global.API.setToken(null);
    App.state.user = null;
    if (App.state.summaryTimer) { clearInterval(App.state.summaryTimer); App.state.summaryTimer = null; }
    if (App.state.socket) { App.state.socket.disconnect(); App.state.socket = null; }
    location.hash = '#/';
    showLogin();
  }
  App.logout = logout;

  function wireLogin() {
    var form = $('#login-form');
    var panel = $('.login-panel');
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var btn = $('#login-btn');
      var err = $('#login-error');
      err.classList.add('hidden');
      btn.disabled = true;
      btn.textContent = 'Lade …';
      try {
        var res = await global.API.login($('#login-user').value.trim(), $('#login-pass').value);
        global.API.setToken(res.token);
        App.state.user = res.user;
        showApp();
      } catch (e) {
        err.textContent = e.status === 401 || e.status === 400
          ? 'Falscher Benutzername oder Passwort.'
          : (e.message || 'Login fehlgeschlagen.');
        err.classList.remove('hidden');
        panel.classList.remove('shake');
        void panel.offsetWidth;
        panel.classList.add('shake');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Einloggen';
      }
    });
    $('#btn-logout').addEventListener('click', logout);
  }

  /* ------------------------------ sidebar tips ----------------------------- */

  var TIPS = [
    'Tipp: Baue nie direkt nach unten.',
    'Creeper mögen keine Katzen.',
    'Ein Bett setzt deinen Spawnpunkt.',
    'Redstone leuchtet, wenn man es anklickt.',
    'Nametag „Dinnerbone“ dreht Mobs auf den Kopf.',
    'Endermen verzeihen nie einen Blick.',
    'Diamanten gibt es am häufigsten auf Y -59.',
    'Ein Lavaeimer brennt 100 Items — bester Ofen-Treibstoff.'
  ];

  function startTips() {
    var el = $('#tip-text');
    if (!el) return;
    var i = Math.floor(Math.random() * TIPS.length);
    var show = function () {
      el.classList.add('tip-out');
      setTimeout(function () {
        el.textContent = TIPS[i % TIPS.length];
        i++;
        el.classList.remove('tip-out');
      }, 350);
    };
    el.textContent = TIPS[i % TIPS.length]; i++;
    if (App.state.tipTimer) clearInterval(App.state.tipTimer);
    App.state.tipTimer = setInterval(show, 7000);
  }

  /* --------------------------- animated background ------------------------- */

  function startBg() {
    var canvas = $('#bg');
    if (!canvas) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var ctx = canvas.getContext('2d');
    var sprites = [
      global.Icons.draw('grass', 5),
      global.Icons.draw('dirt', 5),
      global.Icons.draw('diamond_ore', 5),
      global.Icons.draw('redstone', 5)
    ];
    var W = 0, H = 0;
    function resize() {
      W = canvas.width = window.innerWidth;
      H = canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    var blocks = [];
    for (var i = 0; i < 22; i++) {
      blocks.push({
        sp: sprites[Math.floor(Math.random() * sprites.length)],
        x: Math.random() * 2000, y: Math.random() * 1200,
        depth: 0.25 + Math.random() * 0.75,         // parallax factor
        scale: 0.35 + Math.random() * 0.9,
        speed: 6 + Math.random() * 14,              // px/s upward
        alpha: 0.05 + Math.random() * 0.10
      });
    }
    var mx = 0, my = 0;
    window.addEventListener('mousemove', function (ev) {
      mx = (ev.clientX / window.innerWidth - 0.5);
      my = (ev.clientY / window.innerHeight - 0.5);
    });

    var last = performance.now();
    function frame(now) {
      var dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      ctx.clearRect(0, 0, W, H);
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        b.y -= b.speed * dt;
        var size = 80 * b.scale;
        if (b.y < -size) { b.y = H + size; b.x = Math.random() * W; }
        var px = (b.x % (W + size)) - size / 2 + mx * 30 * b.depth;
        var py = b.y + my * 30 * b.depth;
        ctx.globalAlpha = b.alpha;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(b.sp, px, py, size, size);
      }
      ctx.globalAlpha = 1;
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /* ---------------------------------- init --------------------------------- */

  async function init() {
    wireLogin();
    startTips();
    startBg();
    window.addEventListener('hashchange', route);

    var tok = global.API.getToken();
    if (tok) {
      try {
        var me = await global.API.me();
        App.state.user = me.user;
        showApp();
        return;
      } catch (e) {
        if (e.status === 401) return showLogin(); // token invalid -> handled already
        // backend unreachable: still show login, user can retry
        showLogin();
        toast('Backend nicht erreichbar.', 'err');
        return;
      }
    }
    showLogin();
  }

  App.init = init;
  global.App = App;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
