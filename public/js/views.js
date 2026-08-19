/* views.js — all screens: dashboard, server list, server detail
   (metrics / console / mods) and the modpack browser modal.
   Expects global Icons, API, Management, Charts, App (see app.js). */
(function (global) {
  'use strict';

  /* ------------------------------ tiny helpers ------------------------------ */

  function A() { return global.App; }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  // Build an element from an HTML string.
  function h(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function esc(s) { return A().esc(s); }
  function canOperate() {
    return global.Management && global.Management.canOperate();
  }
  function canPower() {
    return Boolean(A().state.user);
  }
  function canCreate() {
    return A().state.user && A().state.user.role === 'admin';
  }

  function lampHtml(srv) {
    var info = A().statusInfo(srv.status);
    return '<span class="status-wrap" data-srv-status="' + srv.id + '">' +
      '<span class="lamp ' + info.cls + '"></span>' +
      '<span class="status-label">' + info.label + '</span></span>';
  }

  function providerBadge(provider) {
    var p = String(provider || '').toLowerCase();
    if (p === 'modrinth') return '<span class="badge badge-modrinth">Modrinth</span>';
    if (p === 'curseforge') return '<span class="badge badge-curseforge">CurseForge</span>';
    return '<span class="badge">' + esc(provider || '?') + '</span>';
  }

  function emptyState(icon, title, sub) {
    return '<div class="empty-state"><span class="pix pix-big">' + global.Icons.get(icon) + '</span>' +
      '<h3>' + esc(title) + '</h3><p>' + esc(sub) + '</p></div>';
  }

  function skeletonCards(n) {
    var out = '';
    for (var i = 0; i < n; i++) out += '<div class="card skeleton"><div class="sk-block"></div><div class="sk-line"></div><div class="sk-line short"></div></div>';
    return out;
  }

  /* ------------------------------ sparklines -------------------------------- */

  function sparkDraw(canvas, buf) {
    var ctx = canvas.getContext('2d');
    var w = canvas.width, hgt = canvas.height;
    ctx.clearRect(0, 0, w, hgt);
    if (buf.length < 2) return;
    var max = 100;
    ctx.beginPath();
    for (var i = 0; i < buf.length; i++) {
      var x = (i / (buf.length - 1)) * (w - 2) + 1;
      var y = hgt - 2 - (Math.min(buf[i].cpu, max) / max) * (hgt - 4);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#8dff57';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // soft fill
    ctx.lineTo(w - 1, hgt - 1); ctx.lineTo(1, hgt - 1); ctx.closePath();
    ctx.fillStyle = 'rgba(141,255,87,0.12)';
    ctx.fill();
  }

  /* ------------------------------ server cards ------------------------------ */

  function powerButtons(srv, size) {
    var st = String(srv.status || 'offline');
    var canStart = st === 'offline';
    var canStop = st === 'online' || st === 'starting';
    var cls = size === 'sm' ? 'icon-btn icon-btn-sm' : 'icon-btn';
    return '<div class="power-btns">' +
      '<button class="' + cls + '" data-power="start" title="Starten" ' + (canStart ? '' : 'disabled') + '>' + global.Icons.ui('play') + '</button>' +
      '<button class="' + cls + '" data-power="stop" title="Stoppen" ' + (canStop ? '' : 'disabled') + '>' + global.Icons.ui('stop') + '</button>' +
      '<button class="' + cls + '" data-power="restart" title="Neustart" ' + (canStop ? '' : 'disabled') + '>' + global.Icons.ui('restart') + '</button>' +
      '</div>';
  }

  function serverCard(srv, opts) {
    opts = opts || {};
    var m = srv.metrics || null;
    var card = h(
      '<article class="card server-card" data-server-id="' + srv.id + '">' +
        '<div class="card-top">' +
          '<span class="pix server-icon">' + global.Icons.get(srv.icon) + '</span>' +
          '<div class="card-title-wrap">' +
            '<h3 class="card-title">' + esc(srv.name) + '</h3>' +
            '<span class="badge badge-loader">' + esc(srv.loader) + ' · ' + esc(srv.version) + '</span>' +
          '</div>' +
          lampHtml(srv) +
          (srv.installed === false ? '<span class="badge badge-setup">Setup nötig</span>' : '') +
        '</div>' +
        '<div class="card-mid">' +
          '<canvas class="spark" width="120" height="30"></canvas>' +
          '<div class="card-facts">' +
            '<span title="CPU">' + global.Icons.ui('cpu') + ' ' + (m ? Math.round(m.cpu) + ' %' : '—') + '</span>' +
            '<span title="Spieler">' + global.Icons.ui('players') + ' ' + (m ? m.playersOnline + '/' + m.playersMax : '—') + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="card-resource-facts">' +
          '<span title="RAM">' + global.Icons.ui('ram') + ' ' + A().fmtMB(srv.ramMb || 0) + '</span>' +
          '<span title="CPU-Kerne">' + global.Icons.ui('cpu') + ' ' + esc(srv.cpuCores || 1) + ' Kerne</span>' +
          '<span title="Port">' + global.Icons.ui('bolt') + ' :' + srv.port + '</span>' +
        '</div>' +
        '<div class="card-actions">' +
          ((srv.installed === false ? canOperate() : canPower()) ? powerButtons(srv, 'sm') : '') +
          '<button class="btn btn-ghost btn-open">Öffnen</button>' +
        '</div>' +
      '</article>'
    );

    // sparkline seed
    if (m) {
      var buf = (A().state.spark[srv.id] = A().state.spark[srv.id] || []);
      buf.push({ ts: m.ts || Date.now(), cpu: m.cpu });
      if (buf.length > 40) buf.shift();
      sparkDraw($('.spark', card), buf);
    }

    card.addEventListener('click', function (ev) {
      var p = ev.target.closest ? ev.target.closest('[data-power]') : null;
      if (p) {
        ev.stopPropagation();
        var action = p.getAttribute('data-power');
        // uninstalled server: start opens the install wizard instead
        if (action === 'start' && srv.installed === false) { installWizard(srv); return; }
        A().power(srv.id, action, p);
        return;
      }
      if (opts.onOpen) { opts.onOpen(); return; }
      location.hash = '#/server/' + srv.id;
    });
    return card;
  }

  function createCard() {
    var card = h(
      '<article class="card server-card create-card">' +
        '<span class="pix server-icon">' + global.Icons.get('crafting') + '</span>' +
        '<h3>Neuer Server</h3>' +
        '<p>Stelle dir deinen eigenen Realm zusammen.</p>' +
        '<button class="btn btn-primary">' + global.Icons.ui('plus') + ' Erstellen</button>' +
      '</article>'
    );
    card.querySelector('button').addEventListener('click', function (ev) {
      ev.stopPropagation();
      openCreateServerModal();
    });
    card.addEventListener('click', function () { openCreateServerModal(); });
    return card;
  }

  /* Renders the grid of servers into `grid`; returns a socket listener to attach. */
  function renderServerGrid(grid, servers) {
    grid.innerHTML = '';
    if (!servers.length) {
      grid.appendChild(h(emptyState('chest', 'Hier ist es still … wie in einer Höhle.',
        canCreate() ? 'Erstelle deinen ersten Server und werde zum Block-Meister.' : 'Dir sind noch keine Server zugewiesen.')));
      if (canCreate()) grid.appendChild(createCard());
      return;
    }
    servers.forEach(function (srv) { grid.appendChild(serverCard(srv)); });
    if (canCreate()) grid.appendChild(createCard());
  }

  /* Live sparkline updater shared by dashboard + list views. */
  function attachSparkListener(grid) {
    var socket = A().state.socket;
    if (!socket) return function () {};
    var handler = function (m) {
      if (!m || m.serverId === undefined) return;
      var buf = (A().state.spark[m.serverId] = A().state.spark[m.serverId] || []);
      if (!buf.length || m.ts > buf[buf.length - 1].ts) {
        buf.push({ ts: m.ts, cpu: m.cpu });
        if (buf.length > 40) buf.shift();
      }
      var card = grid.querySelector('[data-server-id="' + m.serverId + '"]');
      if (card) {
        var cv = card.querySelector('.spark');
        if (cv) sparkDraw(cv, buf);
      }
    };
    socket.on('metrics:tick', handler);
    return function () { socket.off('metrics:tick', handler); };
  }

  /* ------------------------------ install wizard ---------------------------- */

  var LOADER_ICONS = { vanilla: 'grass', paper: 'crafting', fabric: 'redstone', forge: 'tnt', neoforge: 'ender_pearl' };
  var WIZ_STEPS = ['Modpack', 'Loader', 'Version', 'EULA', 'Installation'];

  // Lazy panel-mode resolver — cached once per session in App.state.panelMode.
  async function panelMode() {
    if (A().state.panelMode) return A().state.panelMode;
    try {
      var res = await global.API.loaders();
      A().state.panelMode = res && res.mode === 'real' ? 'real' : 'simulation';
    } catch (e) {
      A().state.panelMode = 'simulation'; // endpoint missing (old backend) -> demo behavior
    }
    return A().state.panelMode;
  }

  function loaderSkeletons(n) {
    var out = '';
    for (var i = 0; i < n; i++) {
      out += '<div class="loader-card skeleton"><div class="sk-block"></div><div class="sk-line"></div><div class="sk-line short"></div></div>';
    }
    return out;
  }

  /* Five-step install wizard: modpack -> loader -> version -> EULA -> install job.
     Optional `preselectPack` ({provider, modpackId, versionId?, name?, iconUrl?,
     mcVersion?, loader?}) pre-fills step 1 (e.g. after a LOADER_MISMATCH in the
     modpack browser) and skips the mods-list lookup. */
  function installWizard(server, preselectPack) {
    var wiz = {
      step: 1,
      // step 1: modpack (optional)
      pack: null,                  // {provider, modpackId, versionId, name, iconUrl, mcVersion, loader} | null
      packVersions: null,          // lazily loaded versions of the selected pack
      packVersionsLoading: false,
      pendingPackVersions: false,  // preselected pack still needs its version list
      installedPack: null,         // row from GET /servers/:id/mods (info box)
      modsChecked: false,
      providers: { modrinth: { configured: true }, curseforge: { configured: false } },
      mpProvider: 'modrinth',
      mpQ: '',
      mpResults: [],
      mpLoading: false,
      mpLoaded: false,
      mpSearchTimer: null,
      // steps 2+3: free choice when no modpack is selected
      loaders: null,
      loader: server.loader || null,
      versions: null,
      version: server.version || null,
      eula: false,
      started: false,   // install request sent
      finished: false   // job done -> refresh view on close
    };

    if (preselectPack) {
      wiz.pack = {
        provider: preselectPack.provider,
        modpackId: String(preselectPack.modpackId),
        versionId: preselectPack.versionId || null,
        name: preselectPack.name || null,
        iconUrl: preselectPack.iconUrl || null,
        mcVersion: preselectPack.mcVersion || null,
        loader: preselectPack.loader || null
      };
      wiz.modsChecked = true; // explicit preselection replaces the mods-list lookup
      wiz.mpProvider = preselectPack.provider || 'modrinth';
      if (!wiz.pack.versionId) wiz.pendingPackVersions = true;
    }

    var box = h(
      '<div class="wizard">' +
        '<div class="modal-head">' +
          '<h3 class="modal-title">Server einrichten <span class="badge badge-loader">' + esc(server.name) + '</span></h3>' +
          '<button class="icon-btn modal-x no-burst">' + global.Icons.ui('close') + '</button>' +
        '</div>' +
        '<div class="wizard-steps" id="wiz-steps"></div>' +
        '<div class="wizard-body" id="wiz-body"></div>' +
        '<div class="wizard-foot" id="wiz-foot"></div>' +
      '</div>'
    );

    var ov = A().openModal(box, { wide: true, dismissible: false });
    var body = $('#wiz-body', box);
    var foot = $('#wiz-foot', box);

    // refresh the underlying view whenever the wizard closes after a finished install
    var closed = false;
    var mo = new MutationObserver(function () {
      if (!ov.isConnected) {
        mo.disconnect();
        if (!closed) { closed = true; if (wiz.finished) A().route(); }
      }
    });
    mo.observe(document.getElementById('modal-root'), { childList: true });

    $('.modal-x', box).addEventListener('click', function () { A().closeModal(ov); });

    // provider config for the mini-tabs (CurseForge may be greyed out)
    global.API.modpackProviders().then(function (p) {
      if (p) wiz.providers = p;
      var t = $('.mp-mini-tabs .mp-tab[data-provider="curseforge"]', box);
      if (t) t.disabled = !(wiz.providers.curseforge && wiz.providers.curseforge.configured);
    }).catch(function () { /* keep defaults */ });

    // step-1 lookup: is a modpack already installed on this server?
    if (!wiz.modsChecked) checkInstalledPack();

    async function checkInstalledPack() {
      wiz.modsChecked = true;
      var m = null;
      try {
        var res = await global.API.listMods(server.id);
        m = (res.mods || [])[0] || null;
      } catch (e) { /* best-effort lookup */ }
      if (!m || wiz.pack || wiz.step !== 1) return;
      wiz.installedPack = m;
      // full row -> preselect; incomplete row (nulls) -> info box only, free choice
      if (m.provider && m.providerProjectId && m.mcVersion && m.loader) {
        wiz.pack = {
          provider: m.provider,
          modpackId: String(m.providerProjectId),
          versionId: null,
          name: m.name,
          iconUrl: m.iconUrl || null,
          mcVersion: m.mcVersion,
          loader: m.loader
        };
        wiz.mpProvider = m.provider;
        wiz.pendingPackVersions = true;
      }
      renderModpackStep();
    }

    function canNext() {
      if (wiz.step === 1) return wiz.pack ? (!wiz.packVersionsLoading && !!wiz.pack.versionId) : true;
      if (wiz.step === 2) return wiz.pack ? true : !!wiz.loader;
      if (wiz.step === 3) return wiz.pack ? !!wiz.pack.mcVersion : !!wiz.version;
      if (wiz.step === 4) return wiz.eula;
      return false;
    }

    function renderSteps() {
      $('#wiz-steps', box).innerHTML = WIZ_STEPS.map(function (label, i) {
        var n = i + 1;
        var cls = n < wiz.step ? 'done' : (n === wiz.step ? 'active' : 'todo');
        return (i ? '<span class="wiz-sep"></span>' : '') +
          '<span class="wiz-step ' + cls + '"><span class="wiz-dot"></span>' + esc(label) + '</span>';
      }).join('');
    }

    function renderFoot() {
      foot.innerHTML =
        '<button class="btn btn-ghost" id="wiz-back"' + (wiz.step === 1 ? ' disabled' : '') + '>Zurück</button>' +
        '<button class="btn btn-primary" id="wiz-next"' + (canNext() ? '' : ' disabled') + '>Weiter</button>';
      $('#wiz-back', foot).addEventListener('click', function () {
        if (wiz.step > 1) { wiz.step--; render(); }
      });
      $('#wiz-next', foot).addEventListener('click', function () {
        if (canNext()) { wiz.step++; render(); }
      });
    }

    /* ---- step 1: modpack (optional) ---- */
    function renderModpackStep() {
      var html = '';
      if (server.installed) {
        html += '<div class="wizard-warn">' + global.Icons.ui('bolt') +
          '<span>Der Server wird neu aufgesetzt — die Welt bleibt erhalten.</span></div>';
      }
      if (wiz.installedPack) {
        var ip = wiz.installedPack;
        var ipIcon = ip.iconUrl
          ? '<span class="pix mp-icon"><img src="' + esc(ip.iconUrl) + '" alt="" loading="lazy" onerror="this.parentNode.innerHTML=window.Icons.get(\'chest\')"></span>'
          : '<span class="pix mp-icon">' + global.Icons.get('chest') + '</span>';
        html += '<div class="wizard-info">' + ipIcon +
          '<span>Auf diesem Server ist bereits <b>„' + esc(ip.name) + '"</b> installiert. ' +
          'Wähle unten ein anderes Modpack oder fahre ohne Modpack fort.</span></div>';
      }
      html += '<p class="wizard-hint">Optional: Installiere ein Modpack — es legt Loader und Version automatisch fest.</p>' +
        '<div class="mp-mini-tabs">' +
          '<button class="mp-tab' + (wiz.mpProvider === 'modrinth' ? ' active' : '') + '" data-provider="modrinth"><span class="badge badge-modrinth">Modrinth</span></button>' +
          '<button class="mp-tab' + (wiz.mpProvider === 'curseforge' ? ' active' : '') + '" data-provider="curseforge"' +
            (wiz.providers.curseforge.configured ? '' : ' disabled title="Nicht konfiguriert"') + '><span class="badge badge-curseforge">CurseForge</span></button>' +
        '</div>' +
        '<div class="mp-search-row">' +
          '<input class="input" id="wiz-mp-search" placeholder="Modpacks suchen …" value="' + esc(wiz.mpQ) + '">' +
        '</div>' +
        '<div class="mp-mini-grid" id="wiz-mp-grid"></div>' +
        '<div id="wiz-pack-slot"></div>';
      body.innerHTML = html;

      $$('.mp-mini-tabs .mp-tab', body).forEach(function (t) {
        t.addEventListener('click', function () {
          if (t.disabled) return;
          var p = t.getAttribute('data-provider');
          if (wiz.mpProvider === p) return;
          wiz.mpProvider = p;
          $$('.mp-mini-tabs .mp-tab', body).forEach(function (x) { x.classList.toggle('active', x === t); });
          searchPacks();
        });
      });
      var si = $('#wiz-mp-search', body);
      si.addEventListener('input', function () {
        if (wiz.mpSearchTimer) clearTimeout(wiz.mpSearchTimer);
        wiz.mpSearchTimer = setTimeout(function () {
          wiz.mpQ = si.value.trim();
          searchPacks();
        }, 350);
      });

      renderPackGrid();
      renderPackSlot();
      if (!wiz.mpLoaded) { wiz.mpLoaded = true; searchPacks(); }
      if (wiz.pack && wiz.pendingPackVersions) {
        wiz.pendingPackVersions = false;
        loadPackVersions();
      }
    }

    function renderPackGrid() {
      var grid = $('#wiz-mp-grid', body);
      if (!grid) return;
      var out = '<div class="mp-mini' + (wiz.pack ? '' : ' selected') + '" data-pack="none">' +
        '<span class="pix mp-icon">' + global.Icons.get('grass') + '</span>' +
        '<div class="mp-mini-body"><div class="mp-name">Kein Modpack</div>' +
        '<p class="mp-desc">Freie Auswahl von Loader und Version in den nächsten Schritten.</p></div></div>';
      if (wiz.mpLoading) {
        for (var i = 0; i < 3; i++) {
          out += '<div class="mp-mini skeleton"><div class="sk-block"></div>' +
            '<div class="mp-mini-body"><div class="sk-line"></div><div class="sk-line short"></div></div></div>';
        }
      }
      wiz.mpResults.forEach(function (pack, i) {
        var icon = pack.iconUrl
          ? '<span class="pix mp-icon"><img src="' + esc(pack.iconUrl) + '" alt="" loading="lazy" onerror="this.parentNode.innerHTML=window.Icons.get(\'chest\')"></span>'
          : '<span class="pix mp-icon">' + global.Icons.get('chest') + '</span>';
        var sel = wiz.pack && wiz.pack.provider === wiz.mpProvider && String(wiz.pack.modpackId) === String(pack.id);
        out += '<div class="mp-mini' + (sel ? ' selected' : '') + '" data-pack-idx="' + i + '">' + icon +
          '<div class="mp-mini-body"><div class="mp-name">' + esc(pack.name) + '</div>' +
          '<p class="mp-desc"><span class="mp-dl">' + global.Icons.ui('download') + ' ' + A().fmtDownloads(pack.downloads) + '</span> · ' +
          esc(pack.description || '') + '</p></div></div>';
      });
      grid.innerHTML = out;
      $$('.mp-mini', grid).forEach(function (c) {
        c.addEventListener('click', function () {
          var idx = c.getAttribute('data-pack-idx');
          if (idx === null) { // 'Kein Modpack' clears the pack state
            if (!wiz.pack) return;
            wiz.pack = null;
            wiz.packVersions = null;
            renderPackGrid();
            renderPackSlot();
            renderFoot();
            return;
          }
          var pack = wiz.mpResults[parseInt(idx, 10)];
          if (!pack) return;
          if (wiz.pack && wiz.pack.provider === wiz.mpProvider && String(wiz.pack.modpackId) === String(pack.id)) return;
          wiz.pack = {
            provider: wiz.mpProvider,
            modpackId: String(pack.id),
            versionId: null,
            name: pack.name,
            iconUrl: pack.iconUrl || null,
            mcVersion: null,
            loader: null
          };
          renderPackGrid();
          loadPackVersions();
        });
      });
    }

    async function searchPacks() {
      if (wiz.mpProvider === 'curseforge' && !wiz.providers.curseforge.configured) {
        wiz.mpResults = [];
        wiz.mpLoading = false;
        renderPackGrid();
        return;
      }
      wiz.mpLoading = true;
      renderPackGrid();
      try {
        var res = await global.API.searchModpacks(wiz.mpProvider, wiz.mpQ, 12);
        wiz.mpResults = res.results || [];
      } catch (e) {
        wiz.mpResults = [];
        if (e.status !== 401) A().toast(e.message || 'Modpack-Suche fehlgeschlagen', 'err');
      }
      wiz.mpLoading = false;
      renderPackGrid();
    }

    async function loadPackVersions() {
      wiz.packVersionsLoading = true;
      wiz.packVersions = null;
      renderPackSlot();
      renderFoot();
      try {
        var res = await global.API.modpackVersions(wiz.pack.provider, wiz.pack.modpackId);
        wiz.packVersions = res.versions || [];
        if (wiz.packVersions.length) applyPackVersion(wiz.packVersions[0]); // newest preselected
      } catch (e) {
        wiz.packVersions = [];
        if (e.status !== 401) A().toast(e.message || 'Versionen konnten nicht geladen werden', 'err');
      }
      wiz.packVersionsLoading = false;
      renderPackSlot();
      renderFoot();
    }

    function applyPackVersion(v) {
      if (!wiz.pack) return;
      wiz.pack.versionId = v.id;
      wiz.pack.mcVersion = v.mcVersion || wiz.pack.mcVersion;
      wiz.pack.loader = v.loader || wiz.pack.loader;
    }

    function packChips() {
      if (!wiz.pack || (!wiz.pack.loader && !wiz.pack.mcVersion)) return '';
      var out = '<div class="wizard-chips">';
      if (wiz.pack.loader) out += '<span class="chip">Loader: <span class="chip-num">' + esc(wiz.pack.loader) + '</span></span>';
      if (wiz.pack.mcVersion) out += '<span class="chip">Minecraft: <span class="chip-num">' + esc(wiz.pack.mcVersion) + '</span></span>';
      return out + '</div>';
    }

    function renderPackSlot() {
      var slot = $('#wiz-pack-slot', body);
      if (!slot) return;
      if (!wiz.pack) { slot.innerHTML = ''; return; }
      if (wiz.packVersionsLoading) {
        slot.innerHTML = '<label class="field"><span>Version des Modpacks</span>' +
          '<select class="input" disabled><option>Lade Versionen …</option></select></label>';
        return;
      }
      if (!wiz.packVersions) { // fixed preselection (e.g. mismatch flow) — no list needed
        slot.innerHTML = packChips();
        return;
      }
      if (!wiz.packVersions.length) {
        slot.innerHTML = '<label class="field"><span>Version des Modpacks</span>' +
          '<select class="input" disabled><option>Keine Versionen gefunden</option></select></label>';
        return;
      }
      slot.innerHTML = '<label class="field"><span>Version des Modpacks</span>' +
        '<select class="input" id="wiz-pack-version">' +
        wiz.packVersions.map(function (v) {
          return '<option value="' + esc(v.id) + '"' + (String(v.id) === String(wiz.pack.versionId) ? ' selected' : '') + '>' +
            esc(v.name) + ' — ' + esc(v.mcVersion || '?') + ' (' + esc(v.loader || '?') + ')</option>';
        }).join('') + '</select></label>' + packChips();
      $('#wiz-pack-version', slot).addEventListener('change', function (ev) {
        var v = wiz.packVersions.find(function (x) { return String(x.id) === String(ev.target.value); });
        if (v) { applyPackVersion(v); renderPackSlot(); renderFoot(); }
      });
    }

    /* ---- step 2: loader ---- */
    function renderLoaderStep() {
      if (wiz.pack) { // locked by the modpack
        var lid = String(wiz.pack.loader || '').toLowerCase();
        var lname = lid ? lid.charAt(0).toUpperCase() + lid.slice(1) : '?';
        body.innerHTML = '<p class="wizard-hint">Der Loader steht bereits fest.</p>' +
          '<div class="loader-grid">' +
            '<div class="loader-card locked selected">' +
              '<span class="pix">' + global.Icons.get(LOADER_ICONS[lid] || 'chest') + '</span>' +
              '<span class="loader-name">' + esc(lname) + '</span>' +
              '<span class="lock-note">Durch das Modpack vorgegeben</span>' +
            '</div>' +
          '</div>';
        return;
      }
      if (!wiz.loaders) {
        body.innerHTML = '<p class="wizard-hint">Wähle den Loader für deinen Server.</p>' +
          '<div class="loader-grid">' + loaderSkeletons(5) + '</div>';
        loadLoaders();
        return;
      }
      body.innerHTML = '<p class="wizard-hint">Wähle den Loader für deinen Server.</p>' +
        '<div class="loader-grid">' +
        wiz.loaders.map(function (l) {
          return '<div class="loader-card' + (wiz.loader === l.id ? ' selected' : '') + '" data-loader="' + esc(l.id) + '">' +
            '<span class="pix">' + global.Icons.get(LOADER_ICONS[l.id] || 'chest') + '</span>' +
            '<span class="loader-name">' + esc(l.name) + '</span>' +
            '<span class="loader-desc">' + esc(l.description || '') + '</span>' +
          '</div>';
        }).join('') + '</div>';
      $$('.loader-card', body).forEach(function (c) {
        c.addEventListener('click', function () {
          var id = c.getAttribute('data-loader');
          if (wiz.loader !== id) { wiz.loader = id; wiz.versions = null; wiz.version = null; }
          $$('.loader-card', body).forEach(function (x) { x.classList.toggle('selected', x === c); });
          renderFoot();
        });
      });
    }

    async function loadLoaders() {
      try {
        var res = await global.API.loaders();
        A().state.panelMode = res.mode === 'real' ? 'real' : 'simulation';
        wiz.loaders = res.loaders || [];
        if (wiz.step === 2) { renderLoaderStep(); renderFoot(); }
      } catch (e) {
        body.innerHTML = emptyState('tnt', 'Loader konnten nicht geladen werden', e.message || '') +
          '<p style="text-align:center"><button class="btn btn-ghost" id="wiz-retry-load">Erneut versuchen</button></p>';
        $('#wiz-retry-load', body).addEventListener('click', function () { renderLoaderStep(); });
      }
    }

    /* ---- step 3: version ---- */
    function renderVersionStep() {
      if (wiz.pack) { // locked by the modpack — no fetch needed
        body.innerHTML =
          '<p class="wizard-hint">Das Modpack bestimmt die Minecraft-Version.</p>' +
          '<div class="wizard-chips">' +
            '<span class="chip">Minecraft: <span class="chip-num">' + esc(wiz.pack.mcVersion || '?') + '</span></span>' +
            '<span class="chip">' + global.Icons.ui('ram') + ' RAM: <span class="chip-num">' + A().fmtMB(server.ramMb || 0) + '</span></span>' +
            '<span class="chip">' + global.Icons.ui('bolt') + ' Port: <span class="chip-num">:' + esc(server.port) + '</span></span>' +
          '</div>';
        return;
      }
      body.innerHTML =
        '<p class="wizard-hint">Wähle die Minecraft-Version für <b>' + esc(wiz.loader) + '</b>.</p>' +
        '<label class="field"><span>Version</span>' +
          '<select class="input" id="wiz-version" disabled><option>Lade Versionen …</option></select></label>' +
        '<div class="wizard-chips">' +
          '<span class="chip">' + global.Icons.ui('ram') + ' RAM: <span class="chip-num">' + A().fmtMB(server.ramMb || 0) + '</span></span>' +
          '<span class="chip">' + global.Icons.ui('bolt') + ' Port: <span class="chip-num">:' + esc(server.port) + '</span></span>' +
        '</div>';
      loadVersions();
    }

    async function loadVersions() {
      var sel = $('#wiz-version', body);
      try {
        var res = await global.API.loaderVersions(wiz.loader);
        wiz.versions = res.versions || [];
        if (!wiz.versions.length) {
          sel.innerHTML = '<option>Keine Versionen gefunden</option>';
          return;
        }
        sel.innerHTML = wiz.versions.map(function (v) {
          return '<option value="' + esc(v) + '"' + (v === wiz.version ? ' selected' : '') + '>' + esc(v) + '</option>';
        }).join('');
        sel.disabled = false;
        if (!wiz.version) wiz.version = sel.value;
        sel.addEventListener('change', function () { wiz.version = sel.value; renderFoot(); });
        renderFoot();
      } catch (e) {
        sel.innerHTML = '<option>Fehler beim Laden</option>';
        if (e.status !== 401) A().toast(e.message || 'Versionen konnten nicht geladen werden', 'err');
      }
    }

    /* ---- step 4: EULA ---- */
    function renderEulaStep() {
      body.innerHTML =
        '<p class="wizard-hint">Bevor es losgeht, musst du das Minecraft EULA akzeptieren.</p>' +
        '<label class="eula-check">' +
          '<input type="checkbox" id="wiz-eula"' + (wiz.eula ? ' checked' : '') + '>' +
          '<span class="eula-box"></span>' +
          '<span class="eula-text">Ich akzeptiere das <a id="wiz-eula-link" href="https://aka.ms/MinecraftEULA" target="_blank" rel="noopener">Minecraft EULA</a></span>' +
        '</label>';
      $('#wiz-eula', body).addEventListener('change', function (ev) {
        wiz.eula = ev.target.checked;
        renderFoot();
      });
      // open the link manually so the click does not toggle the checkbox
      $('#wiz-eula-link', body).addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        window.open('https://aka.ms/MinecraftEULA', '_blank', 'noopener');
      });
    }

    /* ---- step 5: installation ---- */
    async function renderInstallStep() {
      foot.innerHTML = '';
      var target = wiz.pack
        ? '„' + (wiz.pack.name || 'Modpack') + '" (' + (wiz.pack.loader || '?') + ' ' + (wiz.pack.mcVersion || '?') + ')'
        : wiz.loader + ' ' + wiz.version;
      body.innerHTML =
        '<p class="wizard-hint">Installiere <b>' + esc(target) + '</b>' +
          (server.installed ? ' — die Welt bleibt erhalten' : '') + ' …</p>' +
        '<div class="mp-progress-label"><span id="wiz-stage">Starte …</span><span id="wiz-percent">0 %</span></div>' +
        '<div class="xp-bar"><div class="xp-fill" id="wiz-fill"></div></div>';
      if (wiz.started) return;
      wiz.started = true;
      try {
        var payload = { eulaAccepted: true };
        if (wiz.pack) { // the pack dictates loader + MC version
          payload.modpack = {
            provider: wiz.pack.provider,
            modpackId: wiz.pack.modpackId,
            versionId: wiz.pack.versionId,
            name: wiz.pack.name,
            iconUrl: wiz.pack.iconUrl
          };
        } else {
          payload.version = wiz.version;
        }
        if (server.installed) payload.wipe = true;
        var res = await global.API.installServer(server.id, payload);
        var job = A().trackJob(res.jobId, { serverId: server.id, name: 'Server-Installation' });
        A().state.jobListeners[res.jobId] = function (j) { updateInstall(j); };
        updateInstall(job);
      } catch (e) {
        showInstallError(e.message || 'Installation fehlgeschlagen');
      }
    }

    function updateInstall(job) {
      var fill = $('#wiz-fill', box);
      if (!fill) return; // wizard closed
      var pct = Math.max(0, Math.min(100, Math.round(job.percent || 0)));
      fill.style.width = pct + '%';
      $('#wiz-percent', box).textContent = pct + ' %';
      $('#wiz-stage', box).textContent = job.stage || '…';
      if (job.status === 'done') {
        fill.classList.add('done');
        $('#wiz-stage', box).textContent = 'Installation abgeschlossen!';
        wiz.finished = true;
        server.installed = true;
        var cached = (A().state.servers || []).find(function (s) { return String(s.id) === String(server.id); });
        if (cached) cached.installed = true;
        foot.innerHTML =
          '<button class="btn btn-ghost" id="wiz-close">Schließen</button>' +
          '<button class="btn btn-primary" id="wiz-start">' + global.Icons.ui('play') + ' Server starten</button>';
        $('#wiz-close', foot).addEventListener('click', function () { A().closeModal(ov); });
        $('#wiz-start', foot).addEventListener('click', function (ev) {
          A().power(server.id, 'start', ev.currentTarget);
          A().closeModal(ov);
        });
      } else if (job.status === 'error') {
        showInstallError(job.error || 'Unbekannter Fehler');
      }
    }

    function showInstallError(msg) {
      var fill = $('#wiz-fill', box);
      if (fill) fill.classList.add('error');
      var stage = $('#wiz-stage', box);
      if (stage) stage.textContent = 'Fehler: ' + msg;
      foot.innerHTML =
        '<button class="btn btn-ghost" id="wiz-close">Schließen</button>' +
        '<button class="btn btn-primary" id="wiz-retry">' + global.Icons.ui('restart') + ' Erneut versuchen</button>';
      $('#wiz-close', foot).addEventListener('click', function () { A().closeModal(ov); });
      $('#wiz-retry', foot).addEventListener('click', function () {
        wiz.started = false;
        wiz.step = 1; // back to the beginning, selections are kept
        render();
      });
    }

    function render() {
      renderSteps();
      if (wiz.step === 1) renderModpackStep();
      else if (wiz.step === 2) renderLoaderStep();
      else if (wiz.step === 3) renderVersionStep();
      else if (wiz.step === 4) renderEulaStep();
      else if (wiz.step === 5) renderInstallStep();
      if (wiz.step !== 5) renderFoot();
    }

    render();
    return ov;
  }

  /* ------------------------------ create modal ------------------------------ */

  function openCreateServerModal() {
    if (!canCreate()) return;
    var versions = ['1.21.1', '1.21', '1.20.4', '1.20.1', '1.19.2', '1.18.2'];
    var loaders = ['vanilla', 'paper', 'fabric', 'forge', 'neoforge'];

    var iconPicker = global.Icons.blockKeys.map(function (k, i) {
      return '<label class="icon-pick' + (k === 'grass' ? ' selected' : '') + '" title="' + k + '">' +
        '<input type="radio" name="srv-icon" value="' + k + '"' + (k === 'grass' ? ' checked' : '') + '>' +
        '<span class="pix">' + global.Icons.get(k) + '</span></label>';
    }).join('');

    var box = h(
      '<div>' +
        '<div class="modal-head"><h3 class="modal-title">Server erschaffen</h3>' +
        '<button class="icon-btn modal-x no-burst">' + global.Icons.ui('close') + '</button></div>' +
        '<div class="modal-body">' +
          '<label class="field"><span>Name</span>' +
            '<input id="cs-name" class="input" maxlength="32" placeholder="Mein cooler Server" value="Neuer Server"></label>' +
          '<div class="field-row">' +
            '<label class="field"><span>Version</span><select id="cs-version" class="input">' +
              versions.map(function (v) { return '<option>' + v + '</option>'; }).join('') + '</select></label>' +
            '<label class="field"><span>Loader</span><select id="cs-loader" class="input">' +
              loaders.map(function (l) { return '<option>' + l + '</option>'; }).join('') + '</select></label>' +
          '</div>' +
          '<div class="field-row">' +
            '<label class="field"><span>Port</span>' +
              '<input id="cs-port" class="input" type="number" min="1024" max="65535" value="25565"></label>' +
            '<label class="field"><span>RAM: <b id="cs-ram-label">4096 MB</b></span>' +
              '<input id="cs-ram" type="range" min="1024" max="16384" step="512" value="4096"></label>' +
          '</div>' +
          '<label class="field"><span>CPU-Kerne</span><input id="cs-cpu" class="input" type="number" min="1" step="1" value="2"></label>' +
          '<div class="field"><span>Icon</span><div class="icon-picker">' + iconPicker + '</div></div>' +
        '</div>' +
        '<div class="modal-foot">' +
          '<button class="btn btn-ghost" data-act="cancel">Abbrechen</button>' +
          '<button class="btn btn-primary" data-act="create">Erschaffen</button>' +
        '</div>' +
      '</div>'
    );

    var ov = A().openModal(box);
    var ram = $('#cs-ram', box), ramLabel = $('#cs-ram-label', box);
    ram.addEventListener('input', function () { ramLabel.textContent = ram.value + ' MB'; });
    box.addEventListener('change', function (ev) {
      if (ev.target.name === 'srv-icon') {
        $$('.icon-pick', box).forEach(function (l) { l.classList.remove('selected'); });
        ev.target.closest('.icon-pick').classList.add('selected');
      }
    });
    $('.modal-x', box).addEventListener('click', function () { A().closeModal(ov); });

    box.addEventListener('click', async function (ev) {
      var act = ev.target.getAttribute && ev.target.getAttribute('data-act');
      if (act === 'cancel') return A().closeModal(ov);
      if (act !== 'create') return;
      var btn = ev.target;
      btn.disabled = true;
      var payload = {
        name: $('#cs-name', box).value.trim(),
        version: $('#cs-version', box).value,
        loader: $('#cs-loader', box).value,
        port: parseInt($('#cs-port', box).value, 10),
        ramMb: parseInt(ram.value, 10),
        cpuCores: parseInt($('#cs-cpu', box).value, 10),
        icon: (box.querySelector('input[name="srv-icon"]:checked') || {}).value || 'grass'
      };
      try {
        var srv = await global.API.createServer(payload);
        A().closeModal(ov);
        A().toast('„' + srv.name + '" wurde erschaffen.', 'ok', 'Server bereit');
        A().refreshSummary();
        A().route();
        // real mode: the new server is not installed yet -> run the wizard
        var mode = await panelMode();
        if (mode === 'real') installWizard(srv);
      } catch (e) {
        btn.disabled = false;
        if (e.status !== 401) A().toast(e.message || 'Erstellen fehlgeschlagen', 'err');
      }
    });
  }

  function renderServerList(container, servers) {
    container.className = 'server-list';
    if (!servers.length) {
      var canCreateServer = canCreate();
      container.innerHTML = emptyState('chest', 'Keine Server', canCreateServer ? 'Erstelle einen Server, um loszulegen.' : 'Dir sind noch keine Server zugewiesen.') +
        (canCreateServer ? '<p style="text-align:center;margin-top:12px"><button class="btn btn-primary" id="dash-create-server">' + global.Icons.ui('plus') + ' Server erstellen</button></p>' : '');
      var createBtn = $('#dash-create-server', container);
      if (createBtn) createBtn.addEventListener('click', openCreateServerModal);
      return;
    }
    var html = '<div class="server-list-row head">' +
      '<span>Server</span>' +
      '<span>Status</span>' +
      '<span>Loader</span>' +
      '<span>Zugewiesen</span>' +
      '<span>CPU</span>' +
      '<span>RAM</span>' +
      '<span>Spieler</span>' +
      '<span></span>' +
    '</div>';
    servers.forEach(function (srv) {
      var m = srv.metrics || {};
      var users = (srv.assignedUsers || []).join(', ');
      html += '<div class="server-list-row" data-server-id="' + srv.id + '">' +
        '<span class="sl-name"><span class="pix server-icon">' + global.Icons.get(srv.icon) + '</span> ' + esc(srv.name) + '</span>' +
        '<span>' + lampHtml(srv) + '</span>' +
        '<span><span class="badge badge-loader">' + esc(srv.loader) + ' · ' + esc(srv.version) + '</span></span>' +
        '<span class="sl-users" title="' + esc(users || 'Keine Zuweisungen') + '">' + esc(users || '—') + '</span>' +
        '<span>' + (m.cpu !== undefined ? Math.round(m.cpu) + ' %' : '—') + '</span>' +
        '<span>' + (m.ram !== undefined ? A().fmtMB(m.ram) : '—') + '</span>' +
        '<span>' + (m.playersOnline !== undefined ? m.playersOnline + '/' + (m.playersMax || 20) : '—') + '</span>' +
        '<span><button class="btn btn-ghost btn-sm btn-open">Öffnen</button></span>' +
      '</div>';
    });
    container.innerHTML = html;
    $$('.server-list-row .btn-open', container).forEach(function (btn) {
      var row = btn.closest('.server-list-row');
      var id = row && row.getAttribute('data-server-id');
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        location.hash = '#/server/' + id;
      });
    });
  }

  function renderAdminDashboard(view, grid, servers) {
    var hostEl = document.createElement('div');
    hostEl.id = 'admin-dashboard-host';
    hostEl.innerHTML =
      '<h3 class="section-title">Host-Metriken</h3>' +
      '<div class="host-metrics-grid">' +
        '<div class="card stat-card"><span class="stat-icon">' + global.Icons.ui('cpu') + '</span><div><div class="stat-value" id="host-cpu">--</div><div class="stat-label">Host-CPU</div><small id="host-cpu-cores">-- Kerne</small></div></div>' +
        '<div class="card stat-card"><span class="stat-icon">' + global.Icons.ui('ram') + '</span><div><div class="stat-value" id="host-ram">--</div><div class="stat-label">Host-RAM</div><small id="host-ram-pct">-- % genutzt</small></div></div>' +
        '<div class="card stat-card"><span class="stat-icon">' + global.Icons.ui('box') + '</span><div><div class="stat-value" id="host-disk">--</div><div class="stat-label">Host-Disk</div><small id="host-disk-pct">-- % genutzt</small></div></div>' +
        '<div class="card stat-card"><span class="stat-icon">' + global.Icons.ui('clock') + '</span><div><div class="stat-value" id="host-uptime">--</div><div class="stat-label">Host-Uptime</div></div></div>' +
      '</div>' +
      '<h3 class="section-title">Server</h3>';
    view.insertBefore(hostEl, grid);
    renderServerList(grid, servers);

    async function loadHost() {
      try {
        var h = await global.API.hostMetrics();
        $('#host-cpu', hostEl).textContent = Math.round(h.cpuPercent || 0) + ' %';
        $('#host-cpu-cores', hostEl).textContent = (h.cpuCores || 0) + ' Kerne';
        $('#host-ram', hostEl).textContent = A().fmtMB(h.memUsed || 0);
        $('#host-ram-pct', hostEl).textContent = (h.memUsedPercent || 0) + ' % genutzt';
        $('#host-disk', hostEl).textContent = A().fmtMB(h.diskUsed || 0);
        $('#host-disk-pct', hostEl).textContent = (h.diskUsedPercent || 0) + ' % genutzt';
        $('#host-uptime', hostEl).textContent = A().fmtUptime(h.uptimeSec || 0);
      } catch (e) { /* ignore */ }
    }
    loadHost();
    var timer = setInterval(loadHost, 10000);
    return function () { clearInterval(timer); };
  }

  /* -------------------------------- dashboard -------------------------------- */

  async function dashboard(view) {
    A().state.refreshView = A().route;
    var isAdmin = A().state.user && A().state.user.role === 'admin';
    view.innerHTML =
      '<section class="hero">' +
        '<div>' +
          '<h1 class="hero-title">Willkommen zurück, ' + esc(A().state.user.username) + '!</h1>' +
          '<p class="hero-sub">' + (isAdmin ? 'Host-Übersicht und Server-Status.' : 'Deine Welten warten. Zeit, etwas Großartiges zu bauen.') + '</p>' +
        '</div>' +
        '<span class="pix hero-creeper bob">' + global.Icons.get('creeper') + '</span>' +
      '</section>' +
      '<div class="grid servers-grid">' + skeletonCards(3) + '</div>';

    var grid = $('.servers-grid', view);
    var detach = function () {};
    try {
      var servers = await (isAdmin ? global.API.adminListServers() : global.API.listServers());
      A().state.servers = servers;
      A().syncSidebar();
      if (!isAdmin && servers.length === 1) {
        location.hash = '#/server/' + servers[0].id;
        return detach;
      }
      if (isAdmin) {
        detach = renderAdminDashboard(view, grid, servers);
      } else {
        renderServerGrid(grid, servers);
        detach = attachSparkListener(grid);
      }
    } catch (e) {
      if (e.status !== 401) grid.innerHTML = emptyState('tnt', 'Hoppla!', e.message || 'Server konnten nicht geladen werden.');
    }
    return detach;
  }

  /* ------------------------------- servers list ------------------------------ */

  async function serversList(view) {
    A().state.refreshView = A().route;
    var isAdmin = A().state.user && A().state.user.role === 'admin';
    view.innerHTML =
      '<div class="view-head"><h2>' + (isAdmin ? 'Server' : 'Deine Server') + '</h2></div>' +
      '<div class="grid servers-grid">' + skeletonCards(3) + '</div>';

    var grid = $('.servers-grid', view);
    var detach = function () {};
    try {
      var servers = await (isAdmin ? global.API.adminListServers() : global.API.listServers());
      A().state.servers = servers;
      A().syncSidebar();
      if (!isAdmin && servers.length === 1) {
        location.hash = '#/server/' + servers[0].id;
        return detach;
      }
      grid.innerHTML = '';
      if (!servers.length) {
        if (isAdmin) {
          grid.innerHTML = emptyState('chest', 'Keine Server vorhanden', 'Erstelle einen neuen Server, um loszulegen.') +
            '<p style="text-align:center;margin-top:12px"><button class="btn btn-primary" id="sl-create-server">' + global.Icons.ui('plus') + ' Server erstellen</button></p>';
          $('#sl-create-server', grid).addEventListener('click', openCreateServerModal);
        } else {
          grid.innerHTML = emptyState('chest', 'Keine Server zugewiesen', 'Dir wurden noch keine Server zugewiesen.');
        }
        return detach;
      }
      if (isAdmin) {
        renderServerList(grid, servers);
      } else {
        renderServerGrid(grid, servers);
        detach = attachSparkListener(grid);
      }
    } catch (e) {
      if (e.status !== 401) grid.innerHTML = emptyState('tnt', 'Hoppla!', e.message || 'Server konnten nicht geladen werden.');
    }
    return detach;
  }

  /* ------------------------------ server detail ------------------------------ */

  var CHART_DEFS = [
    { key: 'cpu', title: 'CPU', unit: '%', color: '#8dff57', max: 100, icon: 'cpu', fmt: function (v) { return v.toFixed(1) + ' %'; } },
    { key: 'ram', title: 'RAM', unit: 'MB', color: '#3fd8ea', max: null, icon: 'ram', fmt: function (v) { return A().fmtMB(v); } }, // max set from server
    { key: 'tps', title: 'TPS', unit: '', color: '#ffd83d', max: 20, icon: 'bolt', fmt: function (v) { return v.toFixed(1); } },
    { key: 'playersOnline', title: 'Spieler', unit: '', color: '#ff9a8a', max: null, icon: 'players', fmt: function (v) { return String(Math.round(v)); } }
  ];

  async function serverDetail(view, id) {
    A().state.refreshView = A().route;
    view.innerHTML = '<div class="grid">' + skeletonCards(2) + '</div>';

    // resolve server (cache first, refetch on hard reload)
    var srv = (A().state.servers || []).find(function (s) { return String(s.id) === String(id); });
    if (!srv) {
      try {
        var all = await global.API.listServers();
        A().state.servers = all;
        A().syncSidebar();
        srv = all.find(function (s) { return String(s.id) === String(id); });
      } catch (e) { /* handled below */ }
    } else {
      A().syncSidebar();
    }
    if (!srv) {
      view.innerHTML = emptyState('tnt', 'Server nicht gefunden', 'Dieser Server existiert nicht (mehr).') +
        '<p style="text-align:center"><a class="btn btn-ghost" href="#/">Zurück zum Dashboard</a></p>';
      return function () {};
    }

    var isAdmin = A().state.user && A().state.user.role === 'admin';
    var operate = canOperate();
    var power = canPower();
    var needsSetup = srv.installed === false;
    view.innerHTML =
      '<div class="detail-head card">' +
        '<a class="icon-btn no-burst" href="#/" title="Zurück">' + global.Icons.ui('back') + '</a>' +
        '<span class="pix server-icon">' + global.Icons.get(srv.icon) + '</span>' +
        '<div class="detail-title">' +
          '<h2>' + esc(srv.name) + '</h2>' +
          '<span class="badge badge-loader">' + esc(srv.loader) + ' · ' + esc(srv.version) + '</span>' +
          '<span class="chip detail-resource-chip">' + global.Icons.ui('ram') + ' <span class="chip-num" data-detail-resource="ram">' + A().fmtMB(srv.ramMb || 0) + '</span></span>' +
          '<span class="chip detail-resource-chip">' + global.Icons.ui('cpu') + ' <span class="chip-num" data-detail-resource="cpu">' + esc(srv.cpuCores || 1) + ' Kerne</span></span>' +
          lampHtml(srv) +
        '</div>' +
        '<div class="detail-actions">' +
          (operate && needsSetup
            ? '<button class="btn btn-primary" id="btn-install-server">' + global.Icons.ui('download') + ' Installieren</button>'
            : (!needsSetup && power ? powerButtons(srv, 'md') : '')) +
          (isAdmin ? '<button class="icon-btn danger" id="btn-del-server" title="Server löschen">' + global.Icons.ui('trash') + '</button>' : '') +
        '</div>' +
      '</div>' +
      '<nav class="tabs">' +
        '<button class="tab active" data-tab="metrics">' + global.Icons.ui('dashboard') + ' Übersicht</button>' +
        '<button class="tab" data-tab="console">' + global.Icons.ui('terminal') + ' Konsole</button>' +
        '<button class="tab" data-tab="mods">' + global.Icons.ui('box') + ' Mods & Modpacks</button>' +
        '<button class="tab" data-tab="files">' + global.Icons.ui('box') + ' Dateien</button>' +
        '<button class="tab" data-tab="backups">' + global.Icons.ui('download') + ' Backups</button>' +
        '<button class="tab" data-tab="players">' + global.Icons.ui('players') + ' Spieler</button>' +
        '<button class="tab" data-tab="properties">' + global.Icons.ui('gear') + ' Einstellungen</button>' +
        '<button class="tab" data-tab="resources">' + global.Icons.ui('cpu') + ' Ressourcen</button>' +
      '</nav>' +
      '<div class="tab-panels">' +
        '<section class="tab-panel" data-panel="metrics">' +
          '<div class="stat-cards">' +
            CHART_DEFS.map(function (d) {
              return '<div class="card stat-card"><span class="stat-icon">' + global.Icons.ui(d.icon) + '</span>' +
                '<div><div class="stat-value" id="stat-' + d.key + '">—</div>' +
                '<div class="stat-label">' + d.title + '</div></div></div>';
            }).join('') +
          '</div>' +
          '<div class="charts-grid">' +
            CHART_DEFS.map(function (d) {
              return '<div class="card chart-card"><div class="chart-head"><span>' + d.title + '</span>' +
                '<span class="chart-unit">' + (d.unit || '') + '</span></div>' +
                '<div class="chart-holder"><canvas id="chart-' + d.key + '"></canvas></div></div>';
            }).join('') +
          '</div>' +
        '</section>' +
        '<section class="tab-panel hidden" data-panel="console">' +
          '<div class="card console-card">' +
            '<div class="console-head"><span>Konsole</span>' +
              '<label class="autoscroll"><input type="checkbox" id="console-autoscroll" checked> Autoscroll</label></div>' +
            '<div class="console-out" id="console-out"></div>' +
            '<form class="console-form' + (power ? '' : ' hidden') + '" id="console-form">' +
              '<span class="console-prompt">&gt;</span>' +
              '<input class="console-input" id="console-input" placeholder="Befehl eingeben (Demo) …" autocomplete="off" spellcheck="false">' +
            '</form>' +
          '</div>' +
        '</section>' +
        '<section class="tab-panel hidden" data-panel="mods">' +
          '<div class="mods-head">' +
            '<h3>Installierte Modpacks</h3>' +
            (power ? '<button class="btn btn-primary" id="btn-browse-modpacks">' + global.Icons.ui('search') + ' Modpacks durchsuchen</button>' : '') +
          '</div>' +
          '<div id="update-area"></div>' +
          '<div id="mods-list" class="mods-list"><div class="sk-line"></div><div class="sk-line"></div></div>' +
        '</section>' +
        '<section class="tab-panel hidden" data-panel="files"><div class="management-root" data-management="files"></div></section>' +
        '<section class="tab-panel hidden" data-panel="backups"><div class="management-root" data-management="backups"></div></section>' +
        '<section class="tab-panel hidden" data-panel="players"><div class="management-root" data-management="players"></div></section>' +
        '<section class="tab-panel hidden" data-panel="properties"><div class="management-root" data-management="properties"></div></section>' +
        '<section class="tab-panel hidden" data-panel="resources"><div class="management-root" data-management="resources"></div></section>' +
      '</div>';

    /* ---- header actions ---- */
    if (operate && needsSetup) {
      $('#btn-install-server', view).addEventListener('click', function () { installWizard(srv); });
    } else {
      $$('.detail-actions [data-power]', view).forEach(function (btn) {
        btn.addEventListener('click', function () { A().power(srv.id, btn.getAttribute('data-power'), btn); });
      });
    }
    if (isAdmin) {
      $('#btn-del-server', view).addEventListener('click', function () { A().deleteServer(srv); });
    }

    /* ---- tabs ---- */
    var managementCleanups = {};
    var managementMounts = {
      files: 'mountFiles', backups: 'mountBackups', players: 'mountPlayers', properties: 'mountProperties', resources: 'mountResources'
    };
    $$('.tab', view).forEach(function (tab) {
      tab.addEventListener('click', function () {
        var tabName = tab.getAttribute('data-tab');
        $$('.tab', view).forEach(function (t) { t.classList.toggle('active', t === tab); });
        $$('.tab-panel', view).forEach(function (p) {
          p.classList.toggle('hidden', p.getAttribute('data-panel') !== tabName);
        });
        if (managementMounts[tabName] && !managementCleanups[tabName]) {
          var root = $('[data-management="' + tabName + '"]', view);
          managementCleanups[tabName] = global.Management[managementMounts[tabName]](root, srv);
        }
      });
    });

    /* ---- charts ---- */
    var charts = {};
    CHART_DEFS.forEach(function (d) {
      var max = d.max;
      if (d.key === 'ram') max = srv.ramMb;
      if (d.key === 'playersOnline') max = function (dm) { return global.Charts.niceMax(Math.max(5, dm)); };
      charts[d.key] = new global.Charts.SmoothChart($('#chart-' + d.key, view), {
        color: d.color, unit: d.unit, max: max, live: true, windowMs: 60 * 60 * 1000
      });
    });

    function statEls() {
      var out = {};
      CHART_DEFS.forEach(function (d) { out[d.key] = $('#stat-' + d.key, view); });
      return out;
    }

    function applyHistory(points) {
      var series = { cpu: [], ram: [], tps: [], playersOnline: [] };
      points.forEach(function (p) {
        series.cpu.push({ ts: p.ts, v: p.cpu });
        series.ram.push({ ts: p.ts, v: p.ram });
        series.tps.push({ ts: p.ts, v: p.tps });
        series.playersOnline.push({ ts: p.ts, v: p.playersOnline });
      });
      CHART_DEFS.forEach(function (d) { charts[d.key].setData(series[d.key]); });
      if (points.length) updateStats(points[points.length - 1], true);
    }

    function updateStats(p, instant) {
      var els = statEls();
      CHART_DEFS.forEach(function (d) {
        var el = els[d.key];
        if (!el) return;
        if (instant) { el.textContent = d.fmt(p[d.key]); el._cv = p[d.key]; }
        else global.Charts.countUp(el, p[d.key], { format: d.fmt });
      });
    }

    // 1) history FIRST (charts never start empty), then live ticks append
    try {
      var hist = await global.API.metricsHistory(srv.id, 60);
      applyHistory(hist.points || []);
    } catch (e) { /* charts show "warte auf Daten …" */ }
    CHART_DEFS.forEach(function (d) { charts[d.key].start(); });

    /* ---- console ---- */
    var consoleOut = $('#console-out', view);
    function appendLog(ts, line, cls) {
      if (!consoleOut) return;
      var row = document.createElement('div');
      row.className = 'console-line' + (cls ? ' ' + cls : '');
      row.innerHTML = '<span class="console-ts">[' + A().fmtClock(ts) + ']</span> ' + esc(line);
      consoleOut.appendChild(row);
      while (consoleOut.children.length > 600) consoleOut.removeChild(consoleOut.firstChild);
      var auto = $('#console-autoscroll', view);
      if (!auto || auto.checked) consoleOut.scrollTop = consoleOut.scrollHeight;
    }
    try {
      var logs = await global.API.logs(srv.id, 200);
      (logs.lines || []).forEach(function (l) { appendLog(l.ts, l.line); });
    } catch (e) { /* ignore */ }

    // real mode: commands go to the server, only while it is online
    var consoleInput = $('#console-input', view);
    var consoleStatus = srv.status;
    var mode = A().state.panelMode || null;
    panelMode().then(function (m) { mode = m; syncConsoleInput(); });

    function syncConsoleInput(status) {
      if (status !== undefined) consoleStatus = status;
      if (!consoleInput) return;
      if (!power) {
        consoleInput.disabled = true;
        consoleInput.placeholder = 'Nur-Lese-Zugriff';
      } else if (mode === 'real') {
        var online = consoleStatus === 'online';
        consoleInput.disabled = !online;
        consoleInput.placeholder = online ? 'Befehl eingeben …' : 'Server ist offline …';
      } else {
        consoleInput.disabled = false;
        consoleInput.placeholder = 'Befehl eingeben (Demo) …';
      }
    }
    syncConsoleInput();

    $('#console-form', view).addEventListener('submit', async function (ev) {
      ev.preventDefault();
      if (!power) return;
      var cmd = consoleInput.value.trim();
      if (!cmd) return;
      if (mode === 'real') {
        if (consoleStatus !== 'online') return;
        consoleInput.value = '';
        appendLog(Date.now(), '> ' + cmd);
        try {
          await global.API.sendCommand(srv.id, cmd);
        } catch (e) {
          if (e.status !== 401) appendLog(Date.now(), 'Fehler: ' + (e.message || 'Befehl fehlgeschlagen'), 'err');
        }
        return;
      }
      consoleInput.value = '';
      appendLog(Date.now(), '> ' + cmd);
      setTimeout(function () {
        appendLog(Date.now(), 'Unbekannter Befehl. „help" für Hilfe. (Demo — Konsole ist schreibgeschützt)');
      }, 220);
    });

    /* ---- mods ---- */
    async function loadMods() {
      var host = $('#mods-list', view);
      if (!host) return;
      try {
        var res = await global.API.listMods(srv.id);
        var mods = res.mods || [];
        if (!mods.length) {
          host.innerHTML = emptyState('ender_pearl', 'Noch keine Mods installiert',
            power ? 'Stöbere im Modpack-Browser und rüste deinen Server auf!' : 'Auf diesem Server sind keine Modpacks installiert.');
          return;
        }
        host.innerHTML = '';
        mods.forEach(function (mod) {
          var iconHtml = mod.iconUrl
            ? '<span class="pix mod-icon"><img src="' + esc(mod.iconUrl) + '" alt="" loading="lazy" onerror="this.parentNode.innerHTML=window.Icons.get(\'chest\')"></span>'
            : '<span class="pix mod-icon">' + global.Icons.get('chest') + '</span>';
          var row = h(
            '<div class="card mod-row">' + iconHtml +
              '<div class="mod-info"><div class="mod-name">' + esc(mod.name) + '</div>' +
              '<div class="mod-meta">' + providerBadge(mod.provider) +
                (mod.loader ? '<span class="badge badge-loader">' + esc(mod.loader) + '</span>' : '') +
                (mod.mcVersion ? '<span class="badge">' + esc(mod.mcVersion) + '</span>' : '') +
                (mod.version ? '<span class="badge">' + esc(mod.version) + '</span>' : '') +
                '<span class="mod-date">' + A().fmtDate(mod.installedAt) + '</span></div></div>' +
              (operate ? '<button class="icon-btn danger" title="Deinstallieren">' + global.Icons.ui('trash') + '</button>' : '') +
            '</div>'
          );
          var removeBtn = row.querySelector('button');
          if (removeBtn) removeBtn.addEventListener('click', async function () {
            var ok = await A().confirm('Modpack entfernen?', '„' + mod.name + '" wird von diesem Server entfernt.', 'Entfernen');
            if (!ok) return;
            try {
              await global.API.deleteMod(srv.id, mod.id);
              A().toast('„' + mod.name + '" entfernt.', 'ok');
              loadMods();
            } catch (e) {
              if (e.status !== 401) A().toast(e.message || 'Entfernen fehlgeschlagen', 'err');
            }
          });
          host.appendChild(row);
        });
      } catch (e) {
        if (e.status !== 401) host.innerHTML = emptyState('tnt', 'Mods konnten nicht geladen werden', e.message || '');
      }
    }
    loadMods();

    /* ---- modpack updates ---- */
    var updateArea = $('#update-area', view);
    var updateJobId = null;

    async function loadUpdates() {
      if (!updateArea) return;
      try {
        var res = await global.API.getUpdates(srv.id);
        var available = (res.updates || []).filter(function (u) { return u.available; });
        if (updateJobId) return; // progress view is active, job events drive the UI
        if (!available.length) { updateArea.innerHTML = ''; return; }
        updateArea.innerHTML = '';
        available.forEach(function (u) { updateArea.appendChild(updateBanner(u)); });
      } catch (e) { /* silent: banner is best-effort */ }
    }

    function updateBanner(u) {
      var iconHtml = u.iconUrl
        ? '<span class="pix mod-icon"><img src="' + esc(u.iconUrl) + '" alt="" loading="lazy" onerror="this.parentNode.innerHTML=window.Icons.get(\'chest\')"></span>'
        : '<span class="pix mod-icon">' + global.Icons.get('chest') + '</span>';
      var offline = srv.status === 'offline';
      var btn = operate
        ? '<button class="btn btn-primary upd-btn"' + (offline ? '' : ' disabled title="Server muss offline sein"') + '>' +
          global.Icons.ui('download') + ' Jetzt aktualisieren</button>'
        : '<span class="badge">Nur Operatoren/Admins</span>';
      var row = h(
        '<div class="card update-banner">' + iconHtml +
          '<div class="update-info">' +
            '<div class="update-title">' + global.Icons.ui('bolt') + ' Update verfügbar für „' + esc(u.name) + '"</div>' +
            '<div class="update-meta">' + providerBadge(u.provider) +
              '<span class="badge">' + esc(u.installedVersion || '?') + '</span> → ' +
              '<span class="badge badge-update">' + esc(u.latestVersionName || '?') + '</span>' +
              '<span class="update-note">Ein Backup wird vor dem Update automatisch erstellt.</span></div>' +
          '</div>' + btn +
        '</div>'
      );
      var updBtn = row.querySelector('.upd-btn');
      if (updBtn) updBtn.addEventListener('click', function () { startUpdate(u, updBtn); });
      return row;
    }

    async function startUpdate(u, btn) {
      var ok = await A().confirm('Modpack aktualisieren?',
        '„' + u.name + '" wird auf ' + (u.latestVersionName || 'die neueste Version') +
        ' aktualisiert. Vorher wird automatisch ein vollständiges Backup erstellt. Der Server muss offline bleiben.',
        'Backup + Update starten');
      if (!ok) return;
      btn.disabled = true;
      try {
        var res = await global.API.runUpdate(srv.id, { provider: u.provider, projectId: u.projectId });
        updateJobId = res.jobId;
        var job = A().trackJob(res.jobId, { serverId: srv.id, name: 'Update: ' + u.name });
        A().state.jobListeners[res.jobId] = function (j) {
          renderUpdateProgress(j, u);
          if (j.status === 'done' || j.status === 'error') {
            updateJobId = null;
            setTimeout(loadUpdates, 800);
          }
        };
        renderUpdateProgress(job, u);
      } catch (e) {
        btn.disabled = false;
        if (e.status !== 401) A().toast(e.message || 'Update konnte nicht gestartet werden', 'err');
      }
    }

    function renderUpdateProgress(job, u) {
      if (!updateArea) return;
      var pct = Math.max(0, Math.min(100, Math.round(job.percent || 0)));
      updateArea.innerHTML =
        '<div class="card update-banner updating">' +
          '<div class="update-info">' +
            '<div class="update-title">' + global.Icons.ui('download') + ' Update läuft: „' + esc(u.name) + '"</div>' +
            '<div class="update-meta"><span class="update-note">' + esc(job.stage || 'Starte …') + '</span>' +
              '<span class="badge badge-update">' + pct + ' %</span></div>' +
            '<div class="xp-bar"><div class="xp-fill" style="width:' + pct + '%"></div></div>' +
            (job.status === 'error' ? '<div class="update-meta"><span class="badge badge-loader">Fehler: ' + esc(job.error || 'unbekannt') + '</span></div>' : '') +
          '</div>' +
        '</div>';
    }

    loadUpdates();

    var browseBtn = $('#btn-browse-modpacks', view);
    if (browseBtn) browseBtn.addEventListener('click', function () { openModpackBrowser(srv); });

    /* ---- socket wiring ---- */
    A().state.detailHandlers = {
      tick: function (m) {
        var p = { ts: m.ts, cpu: m.cpu, ram: m.ram, tps: m.tps, playersOnline: m.playersOnline };
        charts.cpu.push({ ts: m.ts, v: m.cpu });
        charts.ram.push({ ts: m.ts, v: m.ram });
        charts.tps.push({ ts: m.ts, v: m.tps });
        charts.playersOnline.push({ ts: m.ts, v: m.playersOnline });
        updateStats(p, false);
      },
      init: function (points) { applyHistory(points); },
      reconnect: async function () {
        try {
          var h2 = await global.API.metricsHistory(srv.id, 60);
          applyHistory(h2.points || []);
        } catch (e) { /* ignore */ }
      },
      log: function (m) { appendLog(m.ts, m.line); },
      status: function (st) { syncConsoleInput(st); },
      modsChanged: function () { loadMods(); if (!updateJobId) loadUpdates(); },
      updates: function () { if (!updateJobId) loadUpdates(); }
    };
    A().subscribeDetail(srv.id);

    /* ---- cleanup ---- */
    return function () {
      A().unsubscribeDetail();
      CHART_DEFS.forEach(function (d) { charts[d.key].destroy(); });
      Object.keys(managementCleanups).forEach(function (key) {
        if (typeof managementCleanups[key] === 'function') managementCleanups[key]();
      });
    };
  }

  /* ----------------------------- modpack browser ----------------------------- */

  async function mountModpackBrowser(root, server, opts) {
    opts = opts || {};
    var providers = { modrinth: { configured: true }, curseforge: { configured: false } };
    try { providers = await global.API.modpackProviders(); } catch (e) { /* keep defaults */ }

    var state = {
      provider: 'modrinth',
      q: '',
      results: [],
      selected: null,      // pack
      versions: [],
      jobId: null,
      searchTimer: null
    };

    var closeBtn = opts.onClose
      ? '<button class="icon-btn mp-close no-burst">' + global.Icons.ui('close') + '</button>'
      : '';

    root.innerHTML =
      '<div class="mp-browser">' +
        '<div class="modal-head">' +
          '<h3 class="modal-title">Modpack-Browser <span class="badge badge-loader">für ' + esc(server.name) + '</span></h3>' +
          closeBtn +
        '</div>' +
        '<div class="mp-tabs">' +
          '<button class="mp-tab active" data-provider="modrinth"><span class="badge badge-modrinth">Modrinth</span></button>' +
          '<button class="mp-tab" data-provider="curseforge"><span class="badge badge-curseforge">CurseForge</span></button>' +
        '</div>' +
        '<div class="mp-cf-hint hidden" id="mp-cf-hint">' +
          global.Icons.ui('bolt') + ' CurseForge benötigt einen API-Key — als Admin unter <a href="#/settings">Einstellungen</a> eintragen (oder <code>CURSEFORGE_API_KEY</code> in der <code>.env</code>).' +
        '</div>' +
        '<div class="mp-search-row">' +
          '<input class="input" id="mp-search" placeholder="Modpacks suchen … z. B. „All the Mods", „RLCraft">' +
          '<button class="btn btn-primary" id="mp-search-btn">' + global.Icons.ui('search') + ' Suchen</button>' +
        '</div>' +
        '<div class="mp-results" id="mp-results"></div>' +
        '<div class="mp-detail hidden" id="mp-detail"></div>' +
        '<div class="mp-progress hidden" id="mp-progress">' +
          '<div class="mp-progress-label"><span id="mp-stage">Starte …</span><span id="mp-percent">0 %</span></div>' +
          '<div class="xp-bar"><div class="xp-fill" id="mp-fill"></div></div>' +
        '</div>' +
      '</div>';

    var box = root.querySelector('.mp-browser') || root.firstElementChild;

    var closeBtnEl = $('.mp-close', box);
    if (closeBtnEl) closeBtnEl.addEventListener('click', function () { if (opts.onClose) opts.onClose(); });

    var resultsEl = $('#mp-results', box);
    var detailEl = $('#mp-detail', box);
    var progressEl = $('#mp-progress', box);
    var cfHint = $('#mp-cf-hint', box);

    function setProvider(p) {
      state.provider = p;
      state.selected = null;
      detailEl.classList.add('hidden');
      $$('.mp-tab', box).forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-provider') === p); });
      cfHint.classList.toggle('hidden', !(p === 'curseforge' && !providers.curseforge.configured));
      search();
    }

    $$('.mp-tab', box).forEach(function (t) {
      t.addEventListener('click', function () { setProvider(t.getAttribute('data-provider')); });
    });

    async function search() {
      if (state.provider === 'curseforge' && !providers.curseforge.configured) {
        resultsEl.innerHTML = emptyState('redstone', 'CurseForge ist nicht konfiguriert',
          'Hinterlege einen API-Key, um tausende CurseForge-Modpacks zu durchsuchen.');
        return;
      }
      resultsEl.innerHTML = skeletonCards(6);
      try {
        var res = await global.API.searchModpacks(state.provider, state.q, 24, 0);
        state.results = res.results || [];
        renderResults();
      } catch (e) {
        resultsEl.innerHTML = emptyState('tnt', 'Suche fehlgeschlagen', e.message || 'Der Provider antwortet nicht.');
      }
    }

    function renderResults() {
      if (!state.results.length) {
        resultsEl.innerHTML = emptyState('chest', 'Nichts gefunden', 'Versuche einen anderen Suchbegriff.');
        return;
      }
      resultsEl.innerHTML = '';
      state.results.forEach(function (pack) {
        var icon = pack.iconUrl
          ? '<span class="pix mp-icon"><img src="' + esc(pack.iconUrl) + '" alt="" loading="lazy" onerror="this.parentNode.innerHTML=window.Icons.get(\'chest\')"></span>'
          : '<span class="pix mp-icon">' + global.Icons.get('chest') + '</span>';
        var chips = (pack.mcVersions || []).slice(0, 3).map(function (v) {
          return '<span class="mc-chip">' + esc(v) + '</span>';
        }).join('');
        var card = h(
          '<div class="card mp-card">' + icon +
            '<div class="mp-card-body">' +
              '<div class="mp-name">' + esc(pack.name) + '</div>' +
              '<div class="mp-author">von ' + esc(pack.author || 'unbekannt') + '</div>' +
              '<p class="mp-desc">' + esc(pack.description || '') + '</p>' +
              '<div class="mp-meta"><span class="mp-dl">' + global.Icons.ui('download') + ' ' + A().fmtDownloads(pack.downloads) + '</span>' + chips + '</div>' +
            '</div>' +
          '</div>'
        );
        card.addEventListener('click', function () { selectPack(pack); });
        resultsEl.appendChild(card);
      });
    }

    async function selectPack(pack) {
      state.selected = pack;
      state.versions = [];
      detailEl.classList.remove('hidden');
      detailEl.innerHTML =
        '<div class="mp-detail-inner">' +
          '<div><div class="mp-detail-name">' + esc(pack.name) + '</div>' +
          '<div class="mp-author">' + providerBadge(state.provider) + ' · ' + A().fmtDownloads(pack.downloads) + ' Downloads</div></div>' +
          '<select class="input" id="mp-version"><option>Lade Versionen …</option></select>' +
          '<button class="btn btn-primary" id="mp-install" disabled>' + global.Icons.ui('download') + ' Installieren</button>' +
        '</div>';
      detailEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

      try {
        var res = await global.API.modpackVersions(state.provider, pack.id);
        state.versions = res.versions || [];
        var sel = $('#mp-version', detailEl);
        if (!state.versions.length) {
          sel.innerHTML = '<option>Keine Versionen gefunden</option>';
          return;
        }
        sel.innerHTML = state.versions.map(function (v) {
          return '<option value="' + esc(v.id) + '">' + esc(v.name) + ' — ' + esc(v.mcVersion || '?') + ' (' + esc(v.loader || '?') + ')</option>';
        }).join('');
        $('#mp-install', detailEl).disabled = false;
      } catch (e) {
        $('#mp-version', detailEl).innerHTML = '<option>Fehler beim Laden</option>';
        if (e.status !== 401) A().toast(e.message || 'Versionen konnten nicht geladen werden', 'err');
      }
    }

    detailEl.addEventListener('click', async function (ev) {
      if (!ev.target.closest || !ev.target.closest('#mp-install')) return;
      if (!state.selected) return;
      var btn = ev.target.closest('#mp-install');
      btn.disabled = true;
      var versionId = ($('#mp-version', detailEl) || {}).value;
      try {
        var res = await global.API.installModpack(server.id, {
          provider: state.provider,
          modpackId: String(state.selected.id),
          versionId: versionId,
          name: state.selected.name,
          iconUrl: state.selected.iconUrl
        });
        if (opts.onClose) opts.onClose();
        openInstallProgressModal(server.id, res.jobId, state.selected.name);
      } catch (e) {
        btn.disabled = false;
        // loader mismatch -> offer a wipe-reinstall via the install wizard (operators only)
        if (e.status === 409 && e.data && e.data.code === 'LOADER_MISMATCH') {
          if (!canOperate()) {
            A().toast('Dieses Modpack benötigt einen anderen Loader. Bitte einen Operator oder Admin, den Server neu aufzusetzen.', 'err');
            return;
          }
          var d = e.data;
          var packName = state.selected.name;
          var ok = await A().confirm('Loader passt nicht',
            '„' + packName + '" benötigt ' + d.requiredLoader + ' ' + d.requiredVersion +
            ', der Server nutzt aber ' + d.currentLoader + ' ' + d.currentVersion +
            '. Server neu aufsetzen? Die Welt bleibt erhalten.', 'Neu aufsetzen');
          if (ok) {
            if (opts.onClose) opts.onClose();
            installWizard(server, {
              provider: state.provider,
              modpackId: String(state.selected.id),
              versionId: versionId,
              name: packName,
              iconUrl: state.selected.iconUrl,
              mcVersion: d.requiredVersion,
              loader: d.requiredLoader
            });
          }
          return;
        }
        if (e.status !== 401) A().toast(e.message || 'Installation fehlgeschlagen', 'err');
      }
    });

    function showProgress() {
      progressEl.classList.remove('hidden');
      $('#mp-fill', box).style.width = '0%';
      $('#mp-percent', box).textContent = '0 %';
      $('#mp-stage', box).textContent = 'In Warteschlange …';
    }

    function updateProgress(job) {
      var fill = $('#mp-fill', box);
      if (!fill) return; // container removed
      var pct = Math.max(0, Math.min(100, Math.round(job.percent || 0)));
      fill.style.width = pct + '%';
      $('#mp-percent', box).textContent = pct + ' %';
      $('#mp-stage', box).textContent = job.stage || '…';
      if (job.status === 'done') {
        fill.classList.add('done');
        $('#mp-stage', box).textContent = 'Fertig! Viel Spaß mit „' + (job.name || '') + '".';
      } else if (job.status === 'error') {
        fill.classList.add('error');
        $('#mp-stage', box).textContent = 'Fehler: ' + (job.error || 'unbekannt');
      }
    }

    var searchInput = $('#mp-search', box);
    searchInput.addEventListener('input', function () {
      if (state.searchTimer) clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(function () {
        state.q = searchInput.value.trim();
        search();
      }, 350);
    });
    $('#mp-search-btn', box).addEventListener('click', function () {
      state.q = searchInput.value.trim();
      search();
    });

    // initial content
    search();
  }

  function openInstallProgressModal(serverId, jobId, name) {
    var box = h(
      '<div class="mp-progress-modal">' +
        '<div class="modal-head"><h3 class="modal-title">Modpack wird installiert</h3></div>' +
        '<div class="modal-body">' +
          '<p class="wizard-hint">Das Modpack wird auf dem Server installiert. Du kannst dieses Fenster jederzeit schließen — die Installation läuft im Hintergrund weiter.</p>' +
          '<div class="mp-progress-label"><span id="mp-stage">In Warteschlange …</span><span id="mp-percent">0 %</span></div>' +
          '<div class="xp-bar"><div class="xp-fill" id="mp-fill"></div></div>' +
          '<div id="mp-progress-meta" class="mp-progress-meta">Installation läuft …</div>' +
        '</div>' +
        '<div class="modal-foot" id="mp-progress-foot">' +
          '<button class="btn btn-ghost" id="mp-progress-close">Schließen</button>' +
        '</div>' +
      '</div>'
    );
    var ov = A().openModal(box, { dismissible: false });

    function update(j) {
      var fill = $('#mp-fill', box);
      if (!fill) return;
      var pct = Math.max(0, Math.min(100, Math.round(j.percent || 0)));
      fill.style.width = pct + '%';
      $('#mp-percent', box).textContent = pct + ' %';
      $('#mp-stage', box).textContent = j.stage || '…';
      if (j.status === 'done') {
        fill.classList.add('done');
        $('#mp-stage', box).textContent = 'Fertig! „' + esc(j.name || name) + '" wurde installiert.';
        $('#mp-progress-meta', box).textContent = 'Du kannst das Fenster jetzt schließen.';
      } else if (j.status === 'error') {
        fill.classList.add('error');
        $('#mp-stage', box).textContent = 'Fehler: ' + esc(j.error || 'unbekannt');
        $('#mp-progress-meta', box).textContent = 'Die Installation ist fehlgeschlagen. Versuche es erneut oder wende dich an einen Admin.';
      }
    }

    var job = A().trackJob(jobId, { serverId: serverId, name: name });
    A().state.jobListeners[jobId] = update;
    update(job);

    $('#mp-progress-close', box).addEventListener('click', function () { A().closeModal(ov); });
  }

  function openModpackBrowser(server) {
    var wrapper = document.createElement('div');
    var ov = A().openModal(wrapper, { full: true });
    mountModpackBrowser(wrapper, server, { onClose: function () { A().closeModal(ov); } });
  }

  /* ---------------------------- modpacks picker ------------------------------ */

  async function modpacksPicker(view) {
    A().state.refreshView = A().route;
    if (!canPower()) {
      view.innerHTML = emptyState('redstone', 'Nur-Lese-Zugriff', 'Dir ist kein Server zugewiesen. Modpacks können nur auf Servern installiert werden, auf die du Zugriff hast.');
      return function () {};
    }

    view.innerHTML =
      '<div class="view-head"><h2>Modpacks installieren</h2></div>' +
      '<div class="grid servers-grid">' + skeletonCards(3) + '</div>';

    var grid = $('.servers-grid', view);
    try {
      var servers = await global.API.listServers();
      A().state.servers = servers;
      A().syncSidebar();
      if (servers.length === 1) {
        view.innerHTML = '<div class="view-head"><h2>Modpacks installieren</h2><p class="hero-sub">für ' + esc(servers[0].name) + '</p></div><div id="mp-inline-root"></div>';
        mountModpackBrowser($('#mp-inline-root', view), servers[0], { onClose: function () { location.hash = '#/'; } });
        return function () {};
      }
      grid.innerHTML = '';
      if (!servers.length) {
        grid.innerHTML = emptyState('chest', 'Keine Server vorhanden', 'Dir ist kein Server zugewiesen.');
        return function () {};
      }
      grid.parentElement.querySelector('.view-head h2').insertAdjacentHTML('afterend',
        '<p class="hero-sub">Wähle den Server, der aufgerüstet werden soll.</p>');
      servers.forEach(function (srv) {
        var card = serverCard(srv, { onOpen: function () { openModpackBrowser(srv); } });
        grid.appendChild(card);
      });
    } catch (e) {
      if (e.status !== 401) grid.innerHTML = emptyState('tnt', 'Hoppla!', e.message || 'Server konnten nicht geladen werden.');
    }
    return function () {};
  }

  /* -------------------------------- settings -------------------------------- */

  async function settings(view) {
    A().state.refreshView = A().route;
    var isAdmin = A().state.user && A().state.user.role === 'admin';
    if (!isAdmin) {
      view.innerHTML = emptyState('redstone', 'Keine Berechtigung', 'Nur Admins dürfen an den Einstellungen drehen.');
      return function () {};
    }

    view.innerHTML =
      '<div class="view-head"><h2>Einstellungen</h2><p class="hero-sub">Panel-Konfiguration zur Laufzeit — wird sofort wirksam.</p></div>' +
      '<div class="settings-grid">' +
        '<div class="card settings-card">' +
          '<div class="settings-head">' +
            '<span class="badge badge-curseforge">CurseForge</span>' +
            '<span class="status-wrap" id="cf-status"></span>' +
          '</div>' +
          '<p class="settings-desc">API-Key für die CurseForge-Modpack-Suche. ' +
            'Erstelle einen kostenlosen Key in der <a href="https://console.curseforge.com/" target="_blank" rel="noopener">CurseForge Console</a>. ' +
            'Der Key wird in der Datenbank gespeichert und hat Vorrang vor der <code>.env</code>-Datei.</p>' +
          '<div class="cf-current hidden" id="cf-current">' +
            'Aktiver Key: <code id="cf-masked"></code> <span class="badge" id="cf-source"></span>' +
          '</div>' +
          '<label class="field"><span id="cf-input-label">API-Key</span>' +
            '<input id="cf-key-input" class="input" type="password" placeholder="CurseForge API-Key einfügen …" autocomplete="off" spellcheck="false"></label>' +
          '<div class="settings-actions">' +
            '<button class="btn btn-primary" id="cf-save">' + global.Icons.ui('download') + ' Speichern</button>' +
            '<button class="btn btn-ghost" id="cf-test">' + global.Icons.ui('bolt') + ' Verbindung testen</button>' +
            '<button class="btn btn-danger" id="cf-delete">' + global.Icons.ui('trash') + ' Entfernen</button>' +
          '</div>' +
          '<div class="cf-result hidden" id="cf-result"></div>' +
        '</div>' +
        '<div class="card settings-card">' +
          '<div class="settings-head">' +
            '<span class="badge badge-modrinth">Modrinth</span>' +
            '<span class="status-wrap"><span class="lamp lamp-online"></span><span class="status-label">Immer aktiv</span></span>' +
          '</div>' +
          '<p class="settings-desc">Modrinth benötigt keinen API-Key und steht sofort zur Verfügung. ' +
            'Die Modpack-Suche auf Modrinth ist immer aktiv.</p>' +
        '</div>' +
      '</div>' +
      '<div id="global-backup-settings"></div>';

    var backupSettingsCleanup = global.Management.mountGlobalBackupSettings($('#global-backup-settings', view));

    var statusEl = $('#cf-status', view);
    var currentEl = $('#cf-current', view);
    var maskedEl = $('#cf-masked', view);
    var sourceEl = $('#cf-source', view);
    var input = $('#cf-key-input', view);
    var resultEl = $('#cf-result', view);

    function showResult(msg, ok) {
      resultEl.textContent = msg;
      resultEl.className = 'cf-result ' + (ok ? 'cf-ok' : 'cf-err');
    }

    async function refresh() {
      try {
        var s = await global.API.getSettings();
        var cf = s.curseforgeKey;
        statusEl.innerHTML = cf.configured
          ? '<span class="lamp lamp-online"></span><span class="status-label">Konfiguriert</span>'
          : '<span class="lamp lamp-offline"></span><span class="status-label">Nicht konfiguriert</span>';
        if (cf.configured) {
          currentEl.classList.remove('hidden');
          maskedEl.textContent = cf.masked;
          sourceEl.textContent = cf.source === 'database' ? 'Datenbank' : '.env';
        } else {
          currentEl.classList.add('hidden');
        }
        $('#cf-delete', view).disabled = !cf.configured || cf.source !== 'database';
      } catch (e) {
        if (e.status !== 401) showResult(e.message || 'Einstellungen konnten nicht geladen werden', false);
      }
    }

    $('#cf-save', view).addEventListener('click', async function (ev) {
      var btn = ev.currentTarget;
      var key = input.value.trim();
      if (!key) return showResult('Bitte zuerst einen Key einfügen.', false);
      btn.disabled = true;
      try {
        var r = await global.API.saveCurseforgeKey(key);
        input.value = '';
        showResult('Key gespeichert (' + r.masked + '). CurseForge ist jetzt aktiv!', true);
        A().toast('CurseForge API-Key gespeichert.', 'ok', 'Einstellungen');
        refresh();
      } catch (e) {
        if (e.status !== 401) showResult(e.message || 'Speichern fehlgeschlagen', false);
      } finally {
        btn.disabled = false;
      }
    });

    $('#cf-test', view).addEventListener('click', async function (ev) {
      var btn = ev.currentTarget;
      btn.disabled = true;
      showResult('Teste Verbindung …', true);
      try {
        var r = await global.API.testCurseforgeKey(input.value.trim() || undefined);
        showResult(r.message || 'Verbindung erfolgreich!', true);
      } catch (e) {
        if (e.status !== 401) showResult(e.message || 'Test fehlgeschlagen', false);
        else resultEl.classList.add('hidden');
      } finally {
        btn.disabled = false;
      }
    });

    $('#cf-delete', view).addEventListener('click', async function () {
      var ok = await A().confirm('Key entfernen?', 'Der gespeicherte CurseForge-Key wird aus der Datenbank gelöscht.', 'Entfernen');
      if (!ok) return;
      try {
        await global.API.deleteCurseforgeKey();
        showResult('Key entfernt.', true);
        A().toast('CurseForge-Key entfernt.', 'ok');
        refresh();
      } catch (e) {
        if (e.status !== 401) showResult(e.message || 'Entfernen fehlgeschlagen', false);
      }
    });

    refresh();
    return function () { if (backupSettingsCleanup) backupSettingsCleanup(); };
  }

  function users(view) {
    A().state.refreshView = A().route;
    return global.Management.usersView(view);
  }

  function statusBadge(status) {
    var cls = 'badge';
    if (status === 'running' || status === 'starting') cls += ' badge-loader';
    else if (status === 'done') cls += ' badge-setup';
    else if (status === 'error' || status === 'aborted') cls += ' badge-danger';
    else cls += ' badge-loader';
    return '<span class="' + cls + '">' + esc(status) + '</span>';
  }

  async function jobsLog(view) {
    A().state.refreshView = A().route;
    view.innerHTML =
      '<div class="view-head"><h2>Job-Log</h2><p class="hero-sub">Laufende und abgeschlossene Modpack-Installationen, Backups und Updates.</p></div>' +
      '<div class="jobs-table-wrap"><table class="jobs-table">' +
        '<thead><tr>' +
          '<th>Typ</th><th>Server</th><th>Name</th><th>Status</th><th>Fortschritt</th><th>Stage</th><th>Gestartet</th><th>Aktion</th>' +
        '</tr></thead>' +
        '<tbody id="jobs-body"><tr><td colspan="8" class="jobs-loading">Lade Jobs …</td></tr></tbody>' +
      '</table></div>';

    var body = $('#jobs-body', view);
    var timer = null;

    async function load() {
      try {
        var res = await global.API.listJobs();
        render(res.jobs || []);
      } catch (e) {
        if (e.status === 401) return;
        body.innerHTML = '<tr><td colspan="8" class="jobs-empty">Jobs konnten nicht geladen werden.</td></tr>';
      }
    }

    function render(jobs) {
      if (!jobs.length) {
        body.innerHTML = '<tr><td colspan="8" class="jobs-empty">Keine Jobs vorhanden.</td></tr>';
        return;
      }
      body.innerHTML = jobs.map(function (j) {
        var canCancel = j.status === 'queued' || j.status === 'running' || j.status === 'starting';
        var typeLabel = j.type === 'backup' ? 'Backup' : (j.type === 'modpack' ? 'Modpack' : j.type);
        return '<tr data-job-id="' + esc(j.id) + '">' +
          '<td><span class="badge badge-loader">' + esc(typeLabel) + '</span></td>' +
          '<td>' + esc(j.serverId) + '</td>' +
          '<td>' + esc(j.name || '') + '</td>' +
          '<td>' + statusBadge(j.status) + '</td>' +
          '<td><div class="xp-bar job-xp"><div class="xp-fill" style="width:' + Math.round(j.percent || 0) + '%"></div></div> ' + Math.round(j.percent || 0) + ' %</td>' +
          '<td>' + esc(j.stage || '') + '</td>' +
          '<td>' + A().fmtDate(j.createdAt) + '</td>' +
          '<td>' + (canCancel ? '<button class="btn btn-danger btn-sm btn-cancel-job">Beenden</button>' : '') + '</td>' +
        '</tr>';
      }).join('');

      $$('.btn-cancel-job', body).forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var row = btn.closest('tr');
          var id = row && row.getAttribute('data-job-id');
          if (!id) return;
          btn.disabled = true;
          try {
            await global.API.cancelJob(id);
            A().toast('Job beendet.', 'ok');
            load();
          } catch (e) {
            btn.disabled = false;
            if (e.status !== 401) A().toast(e.message || 'Job konnte nicht beendet werden.', 'err');
          }
        });
      });
    }

    load();
    timer = setInterval(load, 3000);
    return function () { clearInterval(timer); };
  }

  global.Views = {
    dashboard: dashboard,
    serversList: serversList,
    serverDetail: serverDetail,
    modpacksPicker: modpacksPicker,
    openModpackBrowser: openModpackBrowser,
    installWizard: installWizard,
    panelMode: panelMode,
    settings: settings,
    users: users,
    jobsLog: jobsLog
  };
})(typeof window !== 'undefined' ? window : globalThis);
