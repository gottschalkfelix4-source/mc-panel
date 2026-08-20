/* management.js - files, backups, players, properties and user administration. */
(function (global) {
  'use strict';

  function A() { return global.App; }
  function canOperate() {
    var role = A().state.user && A().state.user.role;
    return role === 'admin' || role === 'operator';
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function icon(name) { return global.Icons.ui(name); }
  function block(name) { return global.Icons.get(name); }
  function pathJoin(dir, name) { return (dir ? dir.replace(/\/$/, '') + '/' : '') + String(name || '').replace(/^\/+/, ''); }
  function parentPath(path) { var bits = String(path || '').split('/'); bits.pop(); return bits.join('/'); }
  function fileName(path) { return String(path || '').split('/').pop() || 'download'; }
  function humanSize(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0).replace('.', ',') + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1).replace('.', ',') + ' MB';
    return (n / 1073741824).toFixed(1).replace('.', ',') + ' GB';
  }
  function humanDate(ts) {
    if (!ts) return '-';
    try { return new Date(ts).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }); }
    catch (e) { return A().fmtDate(ts); }
  }
  var GB = 1024 * 1024 * 1024;
  var BACKUP_INTERVALS = [
    { value: 60, label: 'Stündlich' },
    { value: 180, label: '3h' },
    { value: 360, label: '6h' },
    { value: 720, label: '12h' },
    { value: 1440, label: 'Täglich' },
    { value: 2880, label: 'Alle 2 Tage' },
    { value: 10080, label: 'Wöchentlich' }
  ];
  function gbValue(bytes) { return String((Number(bytes) || 0) / GB); }
  function parseGb(value, label, minimumGb, maximumGb) {
    var gb = Number(String(value).replace(',', '.'));
    var bytes = Math.round(gb * GB);
    if (!Number.isFinite(gb) || !Number.isSafeInteger(bytes) || gb < minimumGb || gb > maximumGb) {
      throw new Error(label + ' muss zwischen ' + minimumGb + ' und ' + maximumGb + ' GB liegen.');
    }
    return bytes;
  }
  function usageMeter(label, used, max, suffix) {
    used = Math.max(0, Number(used) || 0); max = Math.max(0, Number(max) || 0);
    var percent = max ? Math.round(used / max * 100) : 0;
    var fill = Math.max(0, Math.min(100, percent));
    return '<div class="usage-meter' + (percent >= 90 ? ' usage-warning' : '') + '">' +
      '<div class="usage-meter-head"><span>' + esc(label) + '</span><strong>' + percent + ' %</strong></div>' +
      '<div class="usage-track" role="progressbar" aria-label="' + esc(label) + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + fill + '">' +
      '<span class="usage-fill" style="width:' + fill + '%"></span></div>' +
      '<p>' + humanSize(used) + ' von ' + humanSize(max) + (suffix ? ' · ' + esc(suffix) : '') + '</p></div>';
  }
  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function errorMessage(root, err, fallback) {
    var text = err && err.status === 403 ? 'Keine Berechtigung für diesen Bereich.' : ((err && err.message) || fallback);
    if (root) root.innerHTML = '<div class="management-error">' + icon('bolt') + '<span>' + esc(text) + '</span></div>';
    if (err && err.status !== 401 && A()) A().toast(text, 'err');
  }
  function busy(btn, yes) { if (btn) btn.disabled = !!yes; }

  function textPrompt(title, label, value, submitLabel, password) {
    return new Promise(function (resolve) {
      var box = document.createElement('div');
      box.innerHTML = '<div class="modal-head"><h3 class="modal-title">' + esc(title) + '</h3></div>' +
        '<div class="modal-body"><label class="field"><span>' + esc(label) + '</span>' +
        '<input class="input management-prompt" type="' + (password ? 'password' : 'text') + '" value="' + esc(value || '') + '" autocomplete="off"></label></div>' +
        '<div class="modal-foot"><button class="btn btn-ghost" data-act="cancel">Abbrechen</button>' +
        '<button class="btn btn-primary" data-act="submit">' + esc(submitLabel || 'Speichern') + '</button></div>';
      var ov = A().openModal(box);
      var input = $('.management-prompt', box);
      var done = function (result) { A().closeModal(ov); resolve(result); };
      box.addEventListener('click', function (ev) {
        var action = ev.target.getAttribute && ev.target.getAttribute('data-act');
        if (action === 'cancel') done(null);
        if (action === 'submit') done(input.value.trim());
      });
      input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); done(input.value.trim()); } });
      setTimeout(function () { input.focus(); input.select(); }, 20);
    });
  }

  /* ---------------------------------- files --------------------------------- */
  function mountFiles(root, server) {
    var alive = true;
    var operate = canOperate();
    var currentDir = '';
    var uploadInput = document.createElement('input');
    uploadInput.type = 'file'; uploadInput.multiple = true; uploadInput.className = 'hidden';
    root.appendChild(uploadInput);

    function shell(body) {
      var bits = currentDir ? currentDir.split('/') : [];
      var crumbs = '<button class="file-crumb" data-dir="">Server</button>';
      var acc = '';
      bits.forEach(function (part) {
        acc = pathJoin(acc, part);
        crumbs += '<span>/</span><button class="file-crumb" data-dir="' + esc(acc) + '">' + esc(part) + '</button>';
      });
      root.innerHTML = '<div class="management-toolbar"><div class="file-breadcrumbs">' + crumbs + '</div>' + (operate ?
        '<div class="management-actions"><button class="btn btn-ghost" data-file-act="new-file">' + icon('plus') + ' Neue Datei</button>' +
        '<button class="btn btn-ghost" data-file-act="new-folder">' + icon('box') + ' Neuer Ordner</button>' +
        '<button class="btn btn-primary" data-file-act="upload">' + icon('download') + ' Upload</button></div>' : '') + '</div>' + body;
      root.appendChild(uploadInput);
    }

    async function load(dir) {
      currentDir = dir || '';
      shell('<div class="management-loading"><div class="sk-line"></div><div class="sk-line"></div><div class="sk-line short"></div></div>');
      try {
        var res = await global.API.listServerFiles(server.id, currentDir);
        if (!alive) return;
        currentDir = res.path || currentDir;
        renderEntries(res.entries || []);
      } catch (err) { if (alive) errorMessage(root, err, 'Dateien konnten nicht geladen werden.'); }
    }

    function renderEntries(entries) {
      entries.sort(function (a, b) {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return String(a.name).localeCompare(String(b.name), 'de');
      });
      var body = '<div class="management-table-wrap"><table class="management-table file-table"><thead><tr>' +
        '<th>Name</th><th>Größe</th><th>Geändert</th><th class="management-table-actions">Aktionen</th></tr></thead><tbody>';
      entries.forEach(function (entry) {
        var isDir = entry.type === 'directory' || entry.type === 'folder';
        var openAct = isDir ? 'open-dir' : (entry.editable ? 'edit' : 'download');
        body += '<tr><td><button class="file-entry" data-file-act="' + openAct + '" data-path="' + esc(entry.path) + '">' +
          '<span class="pix file-entry-icon">' + block(isDir ? 'chest' : (entry.editable ? 'crafting' : 'diamond_ore')) + '</span>' +
          '<span><b>' + esc(entry.name) + '</b><small>' + (isDir ? 'Ordner' : (entry.editable ? 'Textdatei' : 'Binärdatei')) + '</small></span></button></td>' +
          '<td>' + (isDir ? '-' : humanSize(entry.size)) + '</td><td>' + humanDate(entry.modifiedAt) + '</td>' +
          '<td><div class="entry-actions">' + (operate ? '<button class="icon-btn icon-btn-sm" data-file-act="rename" data-path="' + esc(entry.path) + '" title="Umbenennen">' + icon('gear') + '</button>' : '') +
          (!isDir ? '<button class="icon-btn icon-btn-sm" data-file-act="download" data-path="' + esc(entry.path) + '" title="Herunterladen">' + icon('download') + '</button>' : '') +
          (operate ? '<button class="icon-btn icon-btn-sm danger" data-file-act="delete" data-path="' + esc(entry.path) + '" title="Löschen">' + icon('trash') + '</button>' : '') + '</div></td></tr>';
      });
      body += '</tbody></table></div>';
      if (!entries.length) body = '<div class="management-empty"><span class="pix pix-big">' + block('chest') + '</span><h3>Dieser Ordner ist leer</h3><p>' +
        (operate ? 'Lade Dateien hoch oder lege einen neuen Ordner an.' : 'Hier sind noch keine Dateien vorhanden.') + '</p></div>';
      shell(body);
    }

    async function editFile(path, initial) {
      var content = initial;
      if (content === undefined) {
        try {
          var result = await global.API.getServerFile(server.id, path);
          content = typeof result === 'string' ? result : (result.content || '');
        } catch (err) { if (err.status !== 401) A().toast(err.message || 'Datei konnte nicht geöffnet werden.', 'err'); return; }
      }
      if (!alive) return;
      var box = document.createElement('div');
      box.innerHTML = '<div class="modal-head"><h3 class="modal-title">' + icon('box') + ' ' + esc(path) + '</h3></div>' +
        '<div class="modal-body"><textarea class="input file-editor" spellcheck="false"' + (operate ? '' : ' readonly') + '></textarea></div>' +
        '<div class="modal-foot"><button class="btn btn-ghost" data-act="cancel">Schließen</button>' +
        (operate ? '<button class="btn btn-primary" data-act="save">Speichern</button>' : '') + '</div>';
      var ov = A().openModal(box, { wide: true, dismissible: false });
      var textarea = $('.file-editor', box); textarea.value = content;
      box.addEventListener('click', async function (ev) {
        var action = ev.target.getAttribute && ev.target.getAttribute('data-act');
        if (action === 'cancel') return A().closeModal(ov);
        if (action !== 'save') return;
        busy(ev.target, true);
        try {
          await global.API.saveServerFile(server.id, path, textarea.value);
          A().toast('Datei gespeichert. Änderungen können einen Neustart erfordern.', 'ok');
          A().closeModal(ov); load(currentDir);
        } catch (err) { busy(ev.target, false); if (err.status !== 401) A().toast(err.message || 'Speichern fehlgeschlagen.', 'err'); }
      });
      setTimeout(function () { textarea.focus(); }, 20);
    }

    async function doDownload(path) {
      try { downloadBlob(await global.API.downloadServerFile(server.id, path), fileName(path)); }
      catch (err) { if (err.status !== 401) A().toast(err.message || 'Download fehlgeschlagen.', 'err'); }
    }

    async function clickHandler(ev) {
      var target = ev.target.closest ? ev.target.closest('[data-file-act], [data-dir]') : null;
      if (!target) return;
      if (target.hasAttribute('data-dir')) return load(target.getAttribute('data-dir'));
      var action = target.getAttribute('data-file-act');
      var path = target.getAttribute('data-path');
      if (action === 'open-dir') return load(path);
      if (action === 'edit') return editFile(path);
      if (action === 'download') return doDownload(path);
      if (!operate) return;
      if (action === 'upload') return uploadInput.click();
      if (action === 'new-file') {
        var file = await textPrompt('Neue Datei', 'Dateiname', '', 'Erstellen');
        if (file) editFile(pathJoin(currentDir, file), '');
        return;
      }
      if (action === 'new-folder') {
        var folder = await textPrompt('Neuer Ordner', 'Ordnername', '', 'Erstellen');
        if (!folder) return;
        try { await global.API.createServerFolder(server.id, pathJoin(currentDir, folder)); load(currentDir); }
        catch (err) { if (err.status !== 401) A().toast(err.message || 'Ordner konnte nicht erstellt werden.', 'err'); }
        return;
      }
      if (action === 'rename') {
        var oldName = fileName(path);
        var nextName = await textPrompt('Umbenennen', 'Neuer Name', oldName, 'Umbenennen');
        if (!nextName || nextName === oldName) return;
        try { await global.API.renameServerFile(server.id, path, pathJoin(parentPath(path), nextName)); load(currentDir); }
        catch (err) { if (err.status !== 401) A().toast(err.message || 'Umbenennen fehlgeschlagen.', 'err'); }
        return;
      }
      if (action === 'delete') {
        var ok = await A().confirm('Datei löschen?', '„' + fileName(path) + '“ wird unwiderruflich gelöscht.', 'Löschen');
        if (!ok) return;
        try { await global.API.deleteServerFile(server.id, path); A().toast('Eintrag gelöscht.', 'ok'); load(currentDir); }
        catch (err) { if (err.status !== 401) A().toast(err.message || 'Löschen fehlgeschlagen.', 'err'); }
      }
    }

    async function uploadHandler() {
      if (!operate) return;
      var files = Array.prototype.slice.call(uploadInput.files || []);
      if (!files.length) return;
      try {
        for (var i = 0; i < files.length; i++) await global.API.uploadServerFile(server.id, pathJoin(currentDir, files[i].name), files[i]);
        A().toast(files.length + (files.length === 1 ? ' Datei hochgeladen.' : ' Dateien hochgeladen.'), 'ok');
        uploadInput.value = ''; load(currentDir);
      } catch (err) { uploadInput.value = ''; if (err.status !== 401) A().toast(err.message || 'Upload fehlgeschlagen.', 'err'); }
    }
    root.addEventListener('click', clickHandler);
    uploadInput.addEventListener('change', uploadHandler);
    load('');
    return function () { alive = false; root.removeEventListener('click', clickHandler); uploadInput.removeEventListener('change', uploadHandler); };
  }

  /* -------------------------------- backups -------------------------------- */
  function mountBackups(root, server) {
    var alive = true;
    var operate = canOperate();
    var admin = A().state.user && A().state.user.role === 'admin';
    var jobs = {};
    var backups = [];
    var settings = {};
    var socket = A().state.socket;

    function progressHtml() {
      var ids = Object.keys(jobs);
      if (!ids.length) return '';
      return ids.map(function (id) {
        var job = jobs[id]; var pct = Math.max(0, Math.min(100, Math.round(job.percent || 0)));
        return '<div class="backup-progress" data-job-id="' + esc(id) + '"><div class="mp-progress-label"><span>' + esc(job.stage || 'In Warteschlange ...') +
          '</span><span>' + pct + ' %</span></div><div class="xp-bar"><div class="xp-fill' + (job.status === 'error' ? ' error' : '') + '" style="width:' + pct + '%"></div></div></div>';
      }).join('');
    }

    async function load() {
      root.innerHTML = '<div class="management-toolbar"><div><h3>Backups</h3><p>Sicherungen von Welt, Mods und Konfiguration.</p></div>' +
        (operate ? '<button class="btn btn-primary" data-backup-act="create">' + icon('plus') + ' Backup erstellen</button>' : '') + '</div>' + progressHtml() +
        '<div class="card backup-policy-card management-loading"><div class="sk-line"></div><div class="sk-line"></div><div class="sk-line short"></div></div>' +
        '<div class="management-loading"><div class="sk-line"></div><div class="sk-line short"></div></div>';
      try {
        var results = await Promise.all([global.API.listBackups(server.id), global.API.getServerBackupSettings(server.id)]);
        if (!alive) return;
        var res = results[0] || {};
        backups = res.backups || [];
        settings = Object.assign({}, res.settings || {}, results[1] || {}, res.usage || {});
        render();
      } catch (err) { if (alive) errorMessage(root, err, 'Backups konnten nicht geladen werden.'); }
    }

    function policyHtml() {
      var disabled = operate ? '' : ' disabled';
      var interval = Number(settings.intervalMinutes) || 1440;
      var serverMax = Number(settings.maxBytes) || 0;
      return '<form class="card backup-policy-card" id="backup-automation-form">' +
        '<div class="policy-head"><div><h3>Automatische Backups</h3><p>Sicherungen regelmäßig erstellen und alte Stände automatisch begrenzen.</p></div>' +
        '<label class="property-toggle policy-toggle"><input name="enabled" type="checkbox"' + (settings.enabled ? ' checked' : '') + disabled + '><span></span><b>' + (settings.enabled ? 'Aktiv' : 'Aus') + '</b></label></div>' +
        '<div class="backup-policy-grid"><label class="field"><span>Intervall</span><select class="input" name="intervalMinutes"' + disabled + '>' +
        BACKUP_INTERVALS.map(function (item) { return '<option value="' + item.value + '"' + (item.value === interval ? ' selected' : '') + '>' + item.label + '</option>'; }).join('') +
        '</select></label><label class="field"><span>Maximale Anzahl</span><input class="input" name="maxBackups" type="number" min="1" max="100" step="1" value="' + esc(settings.maxBackups || 1) + '"' + disabled + '></label>' +
        (admin ? '<label class="field"><span>Speicherlimit dieses Servers (GB)</span><input class="input" name="maxBytesGb" type="number" min="0.5" max="2048" step="any" value="' + esc(gbValue(serverMax)) + '" required></label>' : '') + '</div>' +
        '<div class="backup-usage-grid">' + usageMeter('Server-Speicher', settings.serverBytes, serverMax) +
        usageMeter('Gesamter Backup-Speicher', settings.globalBytes, settings.globalMaxBytes) + '</div>' +
        '<div class="policy-foot"><div class="policy-times"><span>Nächstes Backup: <b>' + (settings.enabled ? humanDate(settings.nextRunAt) : 'Nicht geplant') + '</b></span>' +
        '<span>Letztes Backup: <b>' + humanDate(settings.lastRunAt) + '</b></span></div>' +
        (operate ? '<button class="btn btn-primary" type="submit">' + icon('download') + ' Automatik speichern</button>' : '<span class="badge">Nur Lesen</span>') + '</div></form>';
    }

    function render() {
      var body = backups.map(function (backup) {
        var id = backup.id;
        return '<article class="card backup-card"><span class="pix backup-icon">' + block('chest') + '</span><div class="backup-info"><h4>' +
          esc(backup.name || ('Backup ' + id)) + (backup.automatic || backup.type === 'automatic' ? ' <span class="badge badge-automatic">Automatisch</span>' : '') +
          '</h4><p>' + humanDate(backup.createdAt || backup.date) + ' · ' + humanSize(backup.size) + '</p></div>' +
          '<div class="backup-actions"><button class="icon-btn" data-backup-act="download" data-id="' + esc(id) + '" data-name="' + esc(backup.name || 'backup') + '" title="Download">' + icon('download') + '</button>' +
          (operate ? '<button class="btn btn-ghost" data-backup-act="restore" data-id="' + esc(id) + '">' + icon('restart') + ' Wiederherstellen</button>' +
          '<button class="icon-btn danger" data-backup-act="delete" data-id="' + esc(id) + '" title="Löschen">' + icon('trash') + '</button>' : '') + '</div></article>';
      }).join('');
      root.innerHTML = '<div class="management-toolbar"><div><h3>Backups</h3><p>Sicherungen von Welt, Mods und Konfiguration.</p></div>' +
        (operate ? '<button class="btn btn-primary" data-backup-act="create">' + icon('plus') + ' Backup erstellen</button>' : '') + '</div>' + progressHtml() +
        policyHtml() +
        (body ? '<div class="backup-grid">' + body + '</div>' : '<div class="management-empty"><span class="pix pix-big">' + block('chest') + '</span><h3>Noch keine Backups</h3><p>' +
        (operate ? 'Erstelle eine erste Sicherung dieses Servers.' : 'Für diesen Server sind keine Sicherungen vorhanden.') + '</p></div>');
    }

    function updateJob(jobId, data) {
      if (!alive || !jobs[jobId]) return;
      ['status', 'percent', 'stage', 'error'].forEach(function (key) { if (data[key] !== undefined) jobs[jobId][key] = data[key]; });
      var current = jobs[jobId];
      if (current.status === 'done' || current.status === 'error') {
        clearInterval(current.timer);
        current.timer = null;
        if (current.status === 'done') A().toast('Backup-Aktion abgeschlossen.', 'ok');
        else A().toast(current.error || 'Backup-Aktion fehlgeschlagen.', 'err');
        setTimeout(function () { if (!alive) return; delete jobs[jobId]; load(); }, 700);
        return;
      }
      var host = $$('[data-job-id]', root).find(function (el) { return el.getAttribute('data-job-id') === String(jobId); });
      if (host) {
        var pct = Math.max(0, Math.min(100, Math.round(current.percent || 0)));
        $('.mp-progress-label span', host).textContent = current.stage || 'In Warteschlange ...';
        $$('.mp-progress-label span', host)[1].textContent = pct + ' %';
        $('.xp-fill', host).style.width = pct + '%';
      } else load();
    }

    function track(jobId) {
      jobs[jobId] = { status: 'running', percent: 0, stage: 'In Warteschlange ...', timer: null };
      jobs[jobId].timer = setInterval(async function () {
        try { updateJob(jobId, await global.API.backupJob(jobId)); } catch (e) { /* polling is a fallback */ }
      }, 1000);
      load();
    }
    function socketHandler(msg) {
      if (!msg || !msg.jobId || !jobs[msg.jobId]) return;
      if (msg.serverId !== undefined && String(msg.serverId) !== String(server.id)) return;
      updateJob(msg.jobId, msg);
    }
    if (socket && socket.on) socket.on('backup:progress', socketHandler);

    async function clickHandler(ev) {
      var btn = ev.target.closest ? ev.target.closest('[data-backup-act]') : null;
      if (!btn) return;
      var action = btn.getAttribute('data-backup-act'); var id = btn.getAttribute('data-id');
      if (!operate && action !== 'download') return;
      if (action === 'create') {
        var name = await textPrompt('Backup erstellen', 'Name (optional)', '', 'Backup starten');
        if (name === null) return;
        busy(btn, true);
        try { var created = await global.API.createBackup(server.id, name); track(created.jobId); }
        catch (err) { busy(btn, false); if (err.status !== 401) A().toast(err.message || 'Backup konnte nicht gestartet werden.', 'err'); }
      } else if (action === 'download') {
        busy(btn, true);
        try {
          var name = btn.getAttribute('data-name') || 'backup';
          downloadBlob(await global.API.downloadBackup(server.id, id), /\.zip$/i.test(name) ? name : name + '.zip');
        }
        catch (err) { if (err.status !== 401) A().toast(err.message || 'Download fehlgeschlagen.', 'err'); }
        busy(btn, false);
      } else if (action === 'restore') {
        if (String(server.status).toLowerCase() !== 'offline') return A().toast('Der Server muss für die Wiederherstellung offline sein.', 'err');
        var ok = await A().confirm('Backup wiederherstellen?', 'ACHTUNG: Die aktuellen Serverdateien werden ersetzt. Der Server muss offline bleiben.', 'Wiederherstellen');
        if (!ok) return;
        try { var restored = await global.API.restoreBackup(server.id, id); track(restored.jobId); }
        catch (err) { if (err.status !== 401) A().toast(err.message || 'Wiederherstellung konnte nicht gestartet werden.', 'err'); }
      } else if (action === 'delete') {
        var remove = await A().confirm('Backup löschen?', 'Diese Sicherung wird unwiderruflich gelöscht.', 'Löschen');
        if (!remove) return;
        try { await global.API.deleteBackup(server.id, id); A().toast('Backup gelöscht.', 'ok'); load(); }
        catch (err) { if (err.status !== 401) A().toast(err.message || 'Löschen fehlgeschlagen.', 'err'); }
      }
    }
    async function submitHandler(ev) {
      if (ev.target.id !== 'backup-automation-form' || !operate) return;
      ev.preventDefault();
      var form = ev.target;
      var interval = Number(form.elements.intervalMinutes.value);
      var maxBackups = Number(form.elements.maxBackups.value);
      if (!BACKUP_INTERVALS.some(function (item) { return item.value === interval; })) return A().toast('Bitte ein gültiges Backup-Intervall wählen.', 'err');
      if (!Number.isInteger(maxBackups) || maxBackups < 1 || maxBackups > 100) return A().toast('Die maximale Anzahl muss zwischen 1 und 100 liegen.', 'err');
      var payload = { enabled: form.elements.enabled.checked, intervalMinutes: interval, maxBackups: maxBackups };
      try {
        if (admin) payload.maxBytes = parseGb(form.elements.maxBytesGb.value, 'Das Server-Speicherlimit', 0.5, 2048);
      } catch (err) { return A().toast(err.message, 'err'); }
      var btn = $('[type="submit"]', form); busy(btn, true);
      try {
        await global.API.updateServerBackupSettings(server.id, payload);
        A().toast('Backup-Automatik gespeichert.', 'ok');
        load();
      } catch (err) { busy(btn, false); if (err.status !== 401) A().toast(err.message || 'Backup-Automatik konnte nicht gespeichert werden.', 'err'); }
    }
    function changeHandler(ev) {
      if (ev.target.name === 'enabled') {
        var label = ev.target.closest('.property-toggle');
        if (label) $('b', label).textContent = ev.target.checked ? 'Aktiv' : 'Aus';
      }
    }
    root.addEventListener('click', clickHandler);
    root.addEventListener('submit', submitHandler);
    root.addEventListener('change', changeHandler);
    load();
    return function () {
      alive = false; root.removeEventListener('click', clickHandler); root.removeEventListener('submit', submitHandler); root.removeEventListener('change', changeHandler);
      Object.keys(jobs).forEach(function (id) { if (jobs[id].timer) clearInterval(jobs[id].timer); });
      if (socket && socket.off) socket.off('backup:progress', socketHandler);
    };
  }

  /* -------------------------------- players -------------------------------- */
  function mountPlayers(root, server) {
    var alive = true;
    var operate = canOperate();
    var manual = [];
    var players = [];

    async function load() {
      root.innerHTML = '<div class="management-loading"><div class="sk-line"></div><div class="sk-line"></div></div>';
      try { var res = await global.API.listPlayers(server.id); players = res.players || []; if (alive) render(); }
      catch (err) { if (alive) errorMessage(root, err, 'Spieler konnten nicht geladen werden.'); }
    }
    function render() {
      var merged = players.slice();
      manual.forEach(function (p) {
        if (!merged.some(function (x) { return String(x.name).toLowerCase() === String(p.name).toLowerCase(); })) merged.push(p);
      });
      var rows = merged.map(function (player) {
        var key = player.uuid || player.name;
        var level = Math.max(1, Math.min(4, Number(player.opLevel) || 1));
        var identity = '<td><span class="status-wrap"><span class="lamp ' + (player.online ? 'lamp-online' : 'lamp-offline') + '"></span>' +
          '<span><b>' + esc(player.name) + '</b><small>' + esc(player.uuid || 'Noch keine UUID') + '</small></span></span></td>';
        if (!operate) {
          return '<tr data-player="' + esc(key) + '">' + identity + '<td><div class="player-state">' +
            (player.opLevel ? '<span class="badge badge-loader">OP ' + esc(player.opLevel) + '</span>' : '') +
            (player.whitelisted ? '<span class="badge">Whitelist</span>' : '') +
            (player.banned ? '<span class="badge player-banned">Gesperrt</span>' : '') +
            (!player.opLevel && !player.whitelisted && !player.banned ? '<span class="text-faint">Keine Sonderrechte</span>' : '') + '</div>' +
            (player.banReason ? '<small class="ban-reason">' + esc(player.banReason) + '</small>' : '') + '</td><td>' + humanDate(player.lastSeen) + '</td></tr>';
        }
        return '<tr data-player="' + esc(key) + '">' + identity + '<td><select class="input op-level" aria-label="OP-Level">' + [1, 2, 3, 4].map(function (n) { return '<option' + (n === level ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></td>' +
          '<td><div class="player-actions"><button class="btn btn-ghost" data-player-act="op" data-name="' + esc(player.name) + '" data-uuid="' + esc(player.uuid || '') + '">OP</button>' +
          '<button class="btn btn-ghost" data-player-act="deop" data-name="' + esc(player.name) + '" data-uuid="' + esc(player.uuid || '') + '">Deop</button>' +
          '<button class="btn ' + (player.whitelisted ? 'btn-danger' : 'btn-ghost') + '" data-player-act="' + (player.whitelisted ? 'unwhitelist' : 'whitelist') + '" data-name="' + esc(player.name) + '" data-uuid="' + esc(player.uuid || '') + '">' + (player.whitelisted ? 'Whitelist -' : 'Whitelist +') + '</button>' +
          '<button class="btn ' + (player.banned ? 'btn-primary' : 'btn-danger') + '" data-player-act="' + (player.banned ? 'pardon' : 'ban') + '" data-name="' + esc(player.name) + '" data-uuid="' + esc(player.uuid || '') + '">' + (player.banned ? 'Pardon' : 'Ban') + '</button></div>' +
          (player.banReason ? '<small class="ban-reason">' + esc(player.banReason) + '</small>' : '') + '</td><td>' + humanDate(player.lastSeen) + '</td></tr>';
      }).join('');
      root.innerHTML = '<div class="management-toolbar"><div><h3>Spieler</h3><p>' +
        (operate ? 'Rechte, Whitelist und Sperren verwalten.' : 'Spielerstatus und Rechte im Überblick.') + '</p></div>' +
        (operate ? '<form class="player-add" id="player-add"><input class="input" name="player" placeholder="Spielername" maxlength="16" required>' +
        '<button class="btn btn-primary" type="submit">' + icon('plus') + ' Verwalten</button></form>' : '') + '</div>' +
        '<div class="management-table-wrap"><table class="management-table players-table"><thead><tr><th>Spieler</th>' +
        (operate ? '<th>OP-Level</th><th>Aktionen</th>' : '<th>Status</th>') + '<th>Zuletzt gesehen</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="' + (operate ? '4' : '3') + '"><div class="management-empty"><p>Noch keine Spieler bekannt.</p></div></td></tr>') + '</tbody></table></div>';
    }
    async function clickHandler(ev) {
      var btn = ev.target.closest ? ev.target.closest('[data-player-act]') : null;
      if (!btn || !operate) return;
      var action = btn.getAttribute('data-player-act');
      var payload = { name: btn.getAttribute('data-name'), action: action };
      var uuid = btn.getAttribute('data-uuid'); if (uuid) payload.uuid = uuid;
      if (action === 'op') payload.level = Number($('.op-level', btn.closest('tr')).value);
      if (action === 'ban') {
        var reason = window.prompt('Grund für die Sperre (optional):', 'Vom Server ausgeschlossen');
        if (reason === null) return; payload.reason = reason;
      }
      busy(btn, true);
      try { await global.API.playerAction(server.id, payload); A().toast('Spieleraktion ausgeführt.', 'ok'); load(); }
      catch (err) { busy(btn, false); if (err.status !== 401) A().toast(err.message || 'Spieleraktion fehlgeschlagen.', 'err'); }
    }
    function submitHandler(ev) {
      if (ev.target.id !== 'player-add') return;
      if (!operate) return;
      ev.preventDefault(); var name = ev.target.elements.player.value.trim(); if (!name) return;
      manual.push({ name: name, uuid: null, online: false, opLevel: 1, whitelisted: false, banned: false }); render();
    }
    root.addEventListener('click', clickHandler); root.addEventListener('submit', submitHandler);
    load();
    return function () { alive = false; root.removeEventListener('click', clickHandler); root.removeEventListener('submit', submitHandler); };
  }

  /* ------------------------------- properties ------------------------------ */
  function mountProperties(root, server) {
    var alive = true;
    var operate = canOperate();
    var values = {}; var schema = []; var changed = {};

    function optionValue(option) { return option && typeof option === 'object' ? option.value : option; }
    function optionLabel(option) { return option && typeof option === 'object' ? (option.label !== undefined ? option.label : option.value) : option; }
    function control(field) {
      var value = values[field.key];
      var disabled = !operate || field.readOnly || field.key === 'server-port';
      var common = ' data-property="' + esc(field.key) + '"' + (disabled ? ' disabled' : '');
      if (field.type === 'boolean' || field.type === 'checkbox') {
        return '<label class="property-toggle"><input type="checkbox"' + common + (value ? ' checked' : '') + '><span></span><b>' + (value ? 'An' : 'Aus') + '</b></label>';
      }
      if (field.type === 'select' || (field.options && field.options.length)) {
        return '<select class="input"' + common + '>' + (field.options || []).map(function (option) {
          var val = optionValue(option); return '<option value="' + esc(val) + '"' + (String(val) === String(value) ? ' selected' : '') + '>' + esc(optionLabel(option)) + '</option>';
        }).join('') + '</select>';
      }
      var type = field.type === 'number' || field.type === 'integer' ? 'number' : 'text';
      return '<input class="input" type="' + type + '" value="' + esc(value) + '"' + common +
        (field.min !== undefined ? ' min="' + esc(field.min) + '"' : '') + (field.max !== undefined ? ' max="' + esc(field.max) + '"' : '') + '>';
    }
    function render() {
      var groups = {};
      schema.forEach(function (field) { var name = field.group || 'Allgemein'; (groups[name] = groups[name] || []).push(field); });
      root.innerHTML = '<div class="management-toolbar"><div><h3>server.properties</h3><p>Änderungen werden sicher und typisiert gespeichert.</p></div>' +
        (operate ? '<button class="btn btn-primary" id="properties-save" disabled>' + icon('download') + ' Änderungen speichern</button>' : '') + '</div>' +
        '<div class="properties-grid">' + Object.keys(groups).map(function (group) {
          return '<section class="card property-group"><h4>' + esc(group) + '</h4><div class="property-fields">' + groups[group].map(function (field) {
            return '<label class="property-field"><span><b>' + esc(field.label || field.key) + '</b><code>' + esc(field.key) + '</code></span>' + control(field) +
              (field.description ? '<small>' + esc(field.description) + '</small>' : '') + '</label>';
          }).join('') + '</div></section>';
        }).join('') + '</div>';
    }
    async function load() {
      root.innerHTML = '<div class="management-loading"><div class="sk-line"></div><div class="sk-line"></div></div>';
      try { var res = await global.API.getServerProperties(server.id); values = res.values || {}; schema = res.schema || []; changed = {}; if (alive) render(); }
      catch (err) { if (alive) errorMessage(root, err, 'Server-Einstellungen konnten nicht geladen werden.'); }
    }
    function changeHandler(ev) {
      if (!operate) return;
      var input = ev.target.closest ? ev.target.closest('[data-property]') : null; if (!input) return;
      var key = input.getAttribute('data-property'); var field = schema.find(function (item) { return item.key === key; });
      var value = input.type === 'checkbox' ? input.checked : input.value;
      if (field && field.options && field.options.length) {
        var selected = field.options.find(function (option) { return String(optionValue(option)) === String(value); });
        if (selected !== undefined) value = optionValue(selected);
      }
      if (field && (field.type === 'number' || field.type === 'integer')) value = Number(value);
      if (value === values[key] || String(value) === String(values[key])) delete changed[key];
      else changed[key] = value;
      input.closest('.property-field').classList.toggle('changed', Object.prototype.hasOwnProperty.call(changed, key));
      if (input.type === 'checkbox') input.nextElementSibling.nextElementSibling.textContent = value ? 'An' : 'Aus';
      $('#properties-save', root).disabled = !Object.keys(changed).length;
    }
    async function clickHandler(ev) {
      if (!operate) return;
      var btn = ev.target.closest ? ev.target.closest('#properties-save') : null; if (!btn) return;
      busy(btn, true);
      try {
        await global.API.updateServerProperties(server.id, changed); values = Object.assign(values, changed); changed = {};
        A().toast('Einstellungen gespeichert. Ein Server-Neustart ist erforderlich.', 'ok', 'Neustart erforderlich'); render();
      } catch (err) { busy(btn, false); if (err.status !== 401) A().toast(err.message || 'Speichern fehlgeschlagen.', 'err'); }
    }
    root.addEventListener('change', changeHandler); root.addEventListener('input', changeHandler); root.addEventListener('click', clickHandler);
    load();
    return function () { alive = false; root.removeEventListener('change', changeHandler); root.removeEventListener('input', changeHandler); root.removeEventListener('click', clickHandler); };
  }

  /* ------------------------------- resources ------------------------------- */
  function mountResources(root, server) {
    var alive = true;
    var admin = A().state.user && A().state.user.role === 'admin';
    var resources = null;
    var socket = A().state.socket;

    function offline() { return String(server.status || '').toLowerCase() === 'offline'; }
    function syncAvailability() {
      var save = $('#resources-save', root);
      var warning = $('#resources-offline-warning', root);
      if (save) save.disabled = !offline();
      if (warning) warning.classList.toggle('hidden', offline());
    }
    function render() {
      var maxCpu = Math.max(1, Number(resources.maxCpuCores) || Number(resources.cpuCores) || 1);
      var ram = Math.max(512, Number(resources.ramMb) || 512);
      var cpu = Math.max(1, Number(resources.cpuCores) || 1);
      root.innerHTML = '<div class="management-toolbar"><div><h3>Ressourcen</h3><p>Zugewiesene Leistung dieses Servers.</p></div>' +
        (admin ? '' : '<span class="badge resource-readonly">Nur Admins können Ressourcen ändern</span>') + '</div>' +
        '<div class="resource-summary-grid"><article class="card resource-summary-card"><span class="stat-icon">' + icon('ram') + '</span><div><span>Arbeitsspeicher</span><strong>' + esc(A().fmtMB(ram)) + '</strong></div></article>' +
        '<article class="card resource-summary-card"><span class="stat-icon">' + icon('cpu') + '</span><div><span>CPU-Kerne</span><strong>' + esc(cpu) + '</strong><small>von maximal ' + esc(maxCpu) + '</small></div></article></div>' +
        (admin ? '<form class="card resource-form" id="resources-form"><div class="resource-form-head"><div><h3>Zuweisung ändern</h3><p>CPU und RAM können nur bei ausgeschaltetem Server geändert werden.</p></div>' +
        '<span class="resource-warning' + (offline() ? ' hidden' : '') + '" id="resources-offline-warning">' + icon('bolt') + ' Server zuerst ausschalten</span></div>' +
        '<div class="resource-control-grid"><div class="resource-control"><label for="resource-ram-range">RAM <b id="resource-ram-label">' + esc(ram) + ' MB</b></label>' +
        '<input id="resource-ram-range" name="ramRange" type="range" min="512" max="65536" step="1" value="' + esc(ram) + '">' +
        '<input class="input" id="resource-ram-input" name="ramMb" type="number" min="512" max="65536" step="1" value="' + esc(ram) + '" required></div>' +
        '<div class="resource-control"><label for="resource-cpu-range">CPU-Kerne <b id="resource-cpu-label">' + esc(cpu) + '</b></label>' +
        '<input id="resource-cpu-range" name="cpuRange" type="range" min="1" max="' + esc(maxCpu) + '" step="1" value="' + esc(cpu) + '">' +
        '<input class="input" id="resource-cpu-input" name="cpuCores" type="number" min="1" max="' + esc(maxCpu) + '" step="1" value="' + esc(cpu) + '" required></div></div>' +
        '<div class="resource-form-foot"><p>Änderungen an CPU und RAM sind ausschließlich Admins vorbehalten.</p><button class="btn btn-primary" id="resources-save" type="submit"' + (offline() ? '' : ' disabled') + '>' + icon('download') + ' Speichern</button></div></form>' : '');
    }
    async function load() {
      root.innerHTML = '<div class="management-loading"><div class="sk-line"></div><div class="sk-line"></div></div>';
      try {
        resources = await global.API.getServerResources(server.id);
        if (!alive) return;
        server.ramMb = resources.ramMb;
        server.cpuCores = resources.cpuCores;
        render();
      } catch (err) { if (alive) errorMessage(root, err, 'Ressourcen konnten nicht geladen werden.'); }
    }
    function inputHandler(ev) {
      var target = ev.target;
      var other; var label;
      if (target.id === 'resource-ram-range' || target.id === 'resource-ram-input') {
        other = $(target.id === 'resource-ram-range' ? '#resource-ram-input' : '#resource-ram-range', root);
        label = $('#resource-ram-label', root);
        if (other) other.value = target.value;
        if (label) label.textContent = target.value + ' MB';
      } else if (target.id === 'resource-cpu-range' || target.id === 'resource-cpu-input') {
        other = $(target.id === 'resource-cpu-range' ? '#resource-cpu-input' : '#resource-cpu-range', root);
        label = $('#resource-cpu-label', root);
        if (other) other.value = target.value;
        if (label) label.textContent = target.value;
      }
    }
    async function submitHandler(ev) {
      if (ev.target.id !== 'resources-form' || !admin) return;
      ev.preventDefault();
      if (!offline()) { syncAvailability(); return A().toast('Server zuerst ausschalten', 'err'); }
      var ram = Number($('#resource-ram-input', root).value);
      var cpu = Number($('#resource-cpu-input', root).value);
      var maxCpu = Math.max(1, Number(resources.maxCpuCores) || 1);
      if (!Number.isInteger(ram) || ram < 512 || ram > 65536) return A().toast('RAM muss zwischen 512 und 65536 MB liegen.', 'err');
      if (!Number.isInteger(cpu) || cpu < 1 || cpu > maxCpu) return A().toast('CPU-Kerne müssen zwischen 1 und ' + maxCpu + ' liegen.', 'err');
      var btn = $('#resources-save', root); busy(btn, true);
      try {
        var updated = await global.API.updateServerResources(server.id, { ramMb: ram, cpuCores: cpu });
        resources = Object.assign({}, resources, updated || {}, { ramMb: ram, cpuCores: cpu });
        server.ramMb = resources.ramMb; server.cpuCores = resources.cpuCores;
        var cached = (A().state.servers || []).find(function (item) { return String(item.id) === String(server.id); });
        if (cached) { cached.ramMb = resources.ramMb; cached.cpuCores = resources.cpuCores; }
        var ramChip = document.querySelector('[data-detail-resource="ram"]');
        var cpuChip = document.querySelector('[data-detail-resource="cpu"]');
        if (ramChip) ramChip.textContent = A().fmtMB(resources.ramMb);
        if (cpuChip) cpuChip.textContent = resources.cpuCores + ' Kerne';
        A().toast('Ressourcen gespeichert.', 'ok');
        render();
      } catch (err) { busy(btn, false); if (err.status !== 401) A().toast(err.message || 'Ressourcen konnten nicht gespeichert werden.', 'err'); }
    }
    function statusHandler(msg) {
      if (!msg || String(msg.serverId) !== String(server.id)) return;
      server.status = msg.status;
      syncAvailability();
    }
    root.addEventListener('input', inputHandler);
    root.addEventListener('submit', submitHandler);
    if (socket && socket.on) socket.on('server:status', statusHandler);
    load();
    return function () {
      alive = false;
      root.removeEventListener('input', inputHandler);
      root.removeEventListener('submit', submitHandler);
      if (socket && socket.off) socket.off('server:status', statusHandler);
    };
  }

  /* -------------------------- global backup settings ------------------------ */
  function mountGlobalBackupSettings(root) {
    var alive = true;
    if (!root || !A().state.user || A().state.user.role !== 'admin') return function () {};

    function render(settings) {
      root.innerHTML = '<form class="card settings-card global-backup-card" id="global-backup-form">' +
        '<div class="settings-head"><span class="badge badge-backup">Backup-Speicher</span><span class="status-wrap"><span class="lamp lamp-online"></span><span class="status-label">Zentrale Richtlinie</span></span></div>' +
        '<p class="settings-desc">Lege das gemeinsame Speicherlimit und das Standardlimit für neu konfigurierte Server fest.</p>' +
        '<div class="backup-policy-grid"><label class="field"><span>Gesamtes Backup-Limit (GB)</span><input class="input" name="globalMaxBytesGb" type="number" min="1" max="10240" step="any" value="' + esc(gbValue(settings.globalMaxBytes)) + '" required></label>' +
        '<label class="field"><span>Standardlimit pro Server (GB)</span><input class="input" name="defaultServerMaxBytesGb" type="number" min="1" max="10240" step="any" value="' + esc(gbValue(settings.defaultServerMaxBytes)) + '" required></label></div>' +
        usageMeter('Aktuelle Gesamtnutzung', settings.globalBytes, settings.globalMaxBytes, (Number(settings.globalCount) || 0) + ' Backups') +
        '<div class="settings-actions"><button class="btn btn-primary" type="submit">' + icon('download') + ' Backup-Limits speichern</button></div></form>';
    }
    async function load() {
      root.innerHTML = '<div class="card settings-card management-loading"><div class="sk-line"></div><div class="sk-line"></div><div class="sk-line short"></div></div>';
      try { var settings = await global.API.getGlobalBackupSettings(); if (alive) render(settings || {}); }
      catch (err) { if (alive) errorMessage(root, err, 'Backup-Limits konnten nicht geladen werden.'); }
    }
    async function submitHandler(ev) {
      if (ev.target.id !== 'global-backup-form') return;
      ev.preventDefault();
      var form = ev.target; var payload;
      try {
        payload = {
          globalMaxBytes: parseGb(form.elements.globalMaxBytesGb.value, 'Das gesamte Backup-Limit', 1, 10240),
          defaultServerMaxBytes: parseGb(form.elements.defaultServerMaxBytesGb.value, 'Das Standardlimit pro Server', 1, 10240)
        };
      } catch (err) { return A().toast(err.message, 'err'); }
      var btn = $('[type="submit"]', form); busy(btn, true);
      try {
        await global.API.updateGlobalBackupSettings(payload);
        A().toast('Globale Backup-Limits gespeichert.', 'ok');
        load();
      } catch (err) { busy(btn, false); if (err.status !== 401) A().toast(err.message || 'Backup-Limits konnten nicht gespeichert werden.', 'err'); }
    }
    root.addEventListener('submit', submitHandler);
    load();
    return function () { alive = false; root.removeEventListener('submit', submitHandler); };
  }

  /* ---------------------------------- users --------------------------------- */
  function usersView(view) {
    var alive = true;
    var users = [];
    var serverOptions = [];
    var me = A().state.user || {};
    if (me.role !== 'admin') {
      view.innerHTML = '<div class="management-empty"><span class="pix pix-big">' + block('redstone') + '</span><h3>Keine Berechtigung</h3><p>Nur Admins dürfen Benutzer verwalten.</p></div>';
      return function () { alive = false; };
    }
    function isSelf(user) { return (me.id !== undefined && String(me.id) === String(user.id)) || String(me.username) === String(user.username); }
    function roleOptions(role) {
      return ['admin', 'operator', 'viewer'].map(function (name) { return '<option value="' + name + '"' + (name === role ? ' selected' : '') + '>' + ({ admin: 'Admin', operator: 'Operator', viewer: 'Betrachter' }[name]) + '</option>'; }).join('');
    }
    function accessGrid(selectedIds) {
      var selected = (selectedIds || []).map(String);
      if (!serverOptions.length) return '<div class="server-access-empty">Keine Server vorhanden. Ohne Zuweisung ist kein Server sichtbar.</div>';
      return '<div class="server-access-grid">' + serverOptions.map(function (server) {
        var checked = selected.indexOf(String(server.id)) !== -1;
        return '<label class="server-access-card"><input type="checkbox" name="serverIds" value="' + esc(server.id) + '"' + (checked ? ' checked' : '') + '>' +
          '<span class="server-access-box"></span><span class="pix">' + block('grass') + '</span><span><b>' + esc(server.name) + '</b><small>ID ' + esc(server.id) + '</small></span></label>';
      }).join('') + '</div>';
    }
    function selectedServerIds(root) {
      return $$('input[name="serverIds"]:checked', root).map(function (input) {
        var option = serverOptions.find(function (server) { return String(server.id) === input.value; });
        return option ? option.id : input.value;
      });
    }
    function render() {
      view.innerHTML = '<div class="view-head users-head"><div><h2>Benutzer</h2><p class="hero-sub">Zugänge und Rollen für dieses Panel verwalten.</p></div>' +
        '<button class="btn btn-primary" data-user-act="create">' + icon('plus') + ' Benutzer anlegen</button></div>' +
        '<div class="access-role-hint">Operatoren verwalten nur zugewiesene Server. Betrachter können zugewiesene Server starten/stoppen und Konsolenbefehle senden, sind sonst schreibgeschützt. CPU und RAM können nur Admins ändern.</div>' +
        '<div class="card management-table-wrap"><table class="management-table users-table"><thead><tr><th>Benutzer</th><th>Rolle</th><th>Server</th><th>Erstellt</th><th>Aktionen</th></tr></thead><tbody>' +
        users.map(function (user) {
          var self = isSelf(user);
          return '<tr><td><div class="user-identity"><span class="pix">' + block(user.role === 'admin' ? 'diamond' : 'creeper') + '</span><span><b>' + esc(user.username) + '</b>' +
            (self ? '<small>Du</small>' : '<small>ID ' + esc(user.id) + '</small>') + '</span></div></td>' +
            '<td><span class="role-badge role-' + esc(user.role) + '">' + esc(user.role) + '</span><select class="input role-select" data-user-act="role" data-id="' + esc(user.id) + '"' + (self ? ' title="Eigene Rolle kann nicht geändert werden" disabled' : '') + '>' + roleOptions(user.role) + '</select></td>' +
            '<td>' + (user.role === 'admin' ? '<span class="badge badge-all-servers">Alle Server</span>' : '<button class="btn btn-ghost server-access-button" data-user-act="servers" data-id="' + esc(user.id) + '">' + icon('box') + ' Serverzugriff <span>' + (user.serverIds || []).length + '</span></button>') + '</td>' +
            '<td>' + humanDate(user.createdAt) + '</td><td><div class="entry-actions"><button class="btn btn-ghost" data-user-act="password" data-id="' + esc(user.id) + '" data-name="' + esc(user.username) + '">Passwort</button>' +
            '<button class="icon-btn danger" data-user-act="delete" data-id="' + esc(user.id) + '" data-name="' + esc(user.username) + '" title="' + (self ? 'Eigenes Konto kann nicht gelöscht werden' : 'Benutzer löschen') + '"' + (self ? ' disabled' : '') + '>' + icon('trash') + '</button></div></td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    async function load() {
      view.innerHTML = '<div class="management-loading"><div class="sk-line"></div><div class="sk-line"></div></div>';
      try {
        var results = await Promise.all([global.API.listUsers(), global.API.listUserServerOptions()]);
        var res = results[0]; users = Array.isArray(res) ? res : (res.users || []);
        serverOptions = (results[1] && results[1].servers) || [];
        if (alive) render();
      }
      catch (err) { if (alive) errorMessage(view, err, 'Benutzer konnten nicht geladen werden.'); }
    }
    function createModal() {
      var box = document.createElement('div');
      box.innerHTML = '<div class="modal-head"><h3 class="modal-title">Benutzer anlegen</h3></div><div class="modal-body">' +
        '<label class="field"><span>Benutzername</span><input class="input" name="username" autocomplete="off"></label>' +
        '<label class="field"><span>Passwort</span><input class="input" name="password" type="password" autocomplete="new-password"></label>' +
        '<label class="field"><span>Rolle</span><select class="input" name="role">' + roleOptions('viewer') + '</select></label>' +
        '<div class="server-access-section"><h4>Serverzugriff</h4><p>Ohne Auswahl sieht der neue Benutzer keine Server.</p>' + accessGrid([]) + '</div></div>' +
        '<div class="modal-foot"><button class="btn btn-ghost" data-modal-act="cancel">Abbrechen</button><button class="btn btn-primary" data-modal-act="save">Anlegen</button></div>';
      var ov = A().openModal(box);
      box.addEventListener('click', async function (ev) {
        var action = ev.target.getAttribute && ev.target.getAttribute('data-modal-act');
        if (action === 'cancel') return A().closeModal(ov); if (action !== 'save') return;
        var username = $('[name="username"]', box).value.trim(); var password = $('[name="password"]', box).value;
        if (!username || !password) return A().toast('Benutzername und Passwort sind erforderlich.', 'err');
        busy(ev.target, true);
        try {
          var created = await global.API.createUser({ username: username, password: password, role: $('[name="role"]', box).value });
          var newUser = created && created.user ? created.user : created;
          if (newUser && newUser.id !== undefined && newUser.role !== 'admin') await global.API.updateUserServers(newUser.id, selectedServerIds(box));
          A().closeModal(ov); A().toast('Benutzer angelegt.', 'ok'); load();
        }
        catch (err) { busy(ev.target, false); if (err.status !== 401) A().toast(err.message || 'Benutzer konnte nicht angelegt werden.', 'err'); }
      });
    }
    async function clickHandler(ev) {
      var target = ev.target.closest ? ev.target.closest('[data-user-act]') : null; if (!target || target.tagName === 'SELECT') return;
      var action = target.getAttribute('data-user-act'); var id = target.getAttribute('data-id');
      if (action === 'create') return createModal();
      if (action === 'servers') {
        var user = users.find(function (item) { return String(item.id) === String(id); });
        if (!user || user.role === 'admin') return;
        var box = document.createElement('div');
        box.innerHTML = '<div class="modal-head"><h3 class="modal-title">Serverzugriff für ' + esc(user.username) + '</h3></div><div class="modal-body">' +
          '<p class="server-access-help">Operatoren können zugewiesene Server verwalten. Betrachter können sie starten/stoppen und Konsolenbefehle senden, ansonsten nur lesen. Eine leere Auswahl entzieht den Zugriff auf alle Server.</p>' + accessGrid(user.serverIds) + '</div>' +
          '<div class="modal-foot"><button class="btn btn-ghost" data-access-act="cancel">Abbrechen</button><button class="btn btn-primary" data-access-act="save">Speichern</button></div>';
        var ov = A().openModal(box, { wide: true });
        box.addEventListener('click', async function (event) {
          var accessAction = event.target.getAttribute && event.target.getAttribute('data-access-act');
          if (accessAction === 'cancel') return A().closeModal(ov);
          if (accessAction !== 'save') return;
          busy(event.target, true);
          try {
            var serverIds = selectedServerIds(box);
            await global.API.updateUserServers(user.id, serverIds);
            user.serverIds = serverIds;
            A().closeModal(ov); A().toast('Serverzugriff gespeichert.', 'ok'); render();
          } catch (err) { busy(event.target, false); if (err.status !== 401) A().toast(err.message || 'Serverzugriff konnte nicht gespeichert werden.', 'err'); }
        });
      } else if (action === 'password') {
        if (String(id) === String(me.id)) return A().openPasswordModal(false);
        var resetBox = document.createElement('div');
        resetBox.innerHTML = '<div class="modal-head"><h3 class="modal-title">Passwort zurücksetzen</h3></div><div class="modal-body">' +
          '<p class="confirm-text">Der Benutzer muss das temporäre Passwort beim nächsten Login ändern.</p>' +
          '<label class="field"><span>Dein Admin-Passwort</span><input class="input" name="adminPassword" type="password" autocomplete="current-password"></label>' +
          '<label class="field"><span>Neues Passwort für ' + esc(target.getAttribute('data-name')) + '</span><input class="input" name="newPassword" type="password" autocomplete="new-password"></label>' +
          '<label class="field"><span>Passwort wiederholen</span><input class="input" name="passwordConfirm" type="password" autocomplete="new-password"></label></div>' +
          '<div class="modal-foot"><button class="btn btn-ghost" data-reset-act="cancel">Abbrechen</button><button class="btn btn-primary" data-reset-act="save">Zurücksetzen</button></div>';
        var resetOv = A().openModal(resetBox);
        resetBox.addEventListener('click', async function (event) {
          var resetAction = event.target.getAttribute && event.target.getAttribute('data-reset-act');
          if (resetAction === 'cancel') return A().closeModal(resetOv);
          if (resetAction !== 'save') return;
          busy(event.target, true);
          try {
            await global.API.resetUserPassword(id, {
              adminPassword: $('[name="adminPassword"]', resetBox).value,
              newPassword: $('[name="newPassword"]', resetBox).value,
              passwordConfirm: $('[name="passwordConfirm"]', resetBox).value,
            });
            A().closeModal(resetOv);
            A().toast('Passwort wurde zurückgesetzt.', 'ok');
          } catch (err) {
            busy(event.target, false);
            if (err.status !== 401) A().toast(err.message || 'Passwort konnte nicht geändert werden.', 'err');
          }
        });
      } else if (action === 'delete') {
        var ok = await A().confirm('Benutzer löschen?', '„' + target.getAttribute('data-name') + '“ verliert sofort den Zugriff.', 'Löschen');
        if (!ok) return;
        try { await global.API.deleteUser(id); A().toast('Benutzer gelöscht.', 'ok'); load(); }
        catch (err) { if (err.status !== 401) A().toast(err.message || 'Benutzer konnte nicht gelöscht werden.', 'err'); }
      }
    }
    async function changeHandler(ev) {
      if (!ev.target.matches('[data-user-act="role"]')) return;
      var select = ev.target; busy(select, true);
      try { await global.API.updateUser(select.getAttribute('data-id'), { role: select.value }); A().toast('Rolle aktualisiert.', 'ok'); load(); }
      catch (err) { busy(select, false); if (err.status !== 401) A().toast(err.message || 'Rolle konnte nicht geändert werden.', 'err'); load(); }
    }
    view.addEventListener('click', clickHandler); view.addEventListener('change', changeHandler); load();
    return function () { alive = false; view.removeEventListener('click', clickHandler); view.removeEventListener('change', changeHandler); };
  }

  global.Management = {
    canOperate: canOperate,
    mountFiles: mountFiles,
    mountBackups: mountBackups,
    mountGlobalBackupSettings: mountGlobalBackupSettings,
    mountPlayers: mountPlayers,
    mountProperties: mountProperties,
    mountResources: mountResources,
    usersView: usersView
  };
})(typeof window !== 'undefined' ? window : globalThis);
