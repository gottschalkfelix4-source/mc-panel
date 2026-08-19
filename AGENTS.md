# AGENTS.md

## Projekt
Minecraft Server Hosting Panel (Demo). Express 5 + Socket.IO + `node:sqlite` Backend,
Vanilla-JS-Frontend ohne Build-Schritt. CommonJS (`"type": "commonjs"`).

## Befehle
- `docker compose up -d --build` — Deployment als Stack auf **Host-Port 3100**
  (3000 ist durch open-webui belegt, 4173 durch creeperpanel — nicht anfassen!).
  Override via `MC_PANEL_PORT` in `.env`. Volumes: `panel-data` (DB),
  `panel-servers` (Server/Modpacks), `panel-backups` (ZIP-Backups).
- `npm start` — lokal, Port aus `.env` (Default 3000)
- `npm run dev` — nodemon
- Kein Test-Framework vorhanden. Smoke-Tests manuell: `/health`,
  Login via `POST /api/auth/login`, dann Endpunkte mit Bearer-Token prüfen.

## Docker
- Image: `node:24-trixie-slim` (braucht Node ≥22.5 für `node:sqlite`; **trixie** wegen
  OpenJDK 21 — Bookworm hat nur 17, zu alt für MC 1.20.5+), non-root (`USER node`),
  Healthcheck via `fetch('/health')`. `sqlite3` wurde aus `package.json` entfernt (ungenutzt).
- `.dockerignore` hält `node_modules`, DB und Laufzeitdaten aus dem Build-Kontext.

## Echte Server (Real-Modus)
- `SIMULATION_MODE=false` (Docker-Default) + Java vorhanden → echte Java-Prozesse.
  Auto-Fallback auf Simulation, wenn kein `java`-Binary gefunden wird (z. B. lokal).
- `installerService.js`: lädt Server-JARs/Installer (Vanilla=Mojang manifest,
  Paper=fill.papermc.io **v3** (v2 ist 410 Gone!), Fabric=meta.fabricmc.net,
  Forge=promotions_slim.json + Maven-Installer, NeoForge=maven-metadata.xml; Achtung:
  neue MC-Versionen haben kein `1.`-Präfix mehr, z. B. `26.2`), schreibt
  `eula.txt`/`server.properties`/`run.json` in `servers/<id>/`, nutzt die
  `modpack_jobs`-Tabelle (provider='installer') für Fortschritt.
- `processManager.js`: spawn `java -Xmx<ram>M … nogui`, Boot-Erkennung via
  `Done (Xs)!`, Stopp via stdin `stop` (SIGTERM@45s, SIGKILL@55s), `sendCommand`
  für echte Konsolen-Befehle, 20s-Poller parst `list` (Spieler) / `tps` (nur Paper).
  Beim Panel-/Containerstart werden persistierte online/starting/stopping-Status auf
  offline korrigiert, da Child-Prozesse einen Container-Neustart nicht überleben.
- Ressourcen: `servers.ram_mb` + `servers.cpu_cores`; nur Admin darf offline ändern.
  JVM erhält `-XX:ActiveProcessorCount`, Linux-Prozess zusätzlich CPU-Affinität via
  `/usr/bin/taskset` auf die ersten erlaubten Container-CPUs. CPU-Metrik wird auf die
  zugewiesenen Kerne normalisiert.
- `metricsService.js`: Real-Modus = `pidusage(pid)` für CPU/RAM.
- Server ohne Installation → API 409 `NOT_INSTALLED` → Frontend öffnet den Wizard
  (5 Schritte: Modpack → Loader → Version → EULA → Installation).
- **Modpacks werden echt angewendet** (`modpackService.applyPack`): Modrinth =
  `modrinth.index.json` parsen, CF = `manifest.json` + per-file Download via API,
  Mods landen in `servers/<id>/mods/`, Overrides werden extrahiert (adm-zip,
  Path-Traversal-Guard, 4 parallele Downloads). `mods`-Tabelle hat `mc_version`/`loader`.
- CurseForge: wenn eine Version `serverPackFileId` besitzt, immer das offizielle
  Server-Pack verwenden (nicht das Client-Pack mit z. B. Sodium). Große Server-Packs
  werden mit `unzipper` streaming-basiert extrahiert; beim erneuten Anwenden werden
  alte Pack-Dateien/Mods/Configs ersetzt, Welten bleiben erhalten.
- Install-Job-Kette: `POST /api/servers/:id/install` mit `modpack{...}` = Server-JAR
  + Pack in einem Job; `wipe:true` setzt zurück (behält Welt, eula, properties).
  Loader-Konflikt bei installiertem Server → 409 `LOADER_MISMATCH` → Wizard-Reinstall.

## Konventionen
- **DB:** ausschließlich `node:sqlite` (`DatabaseSync`) — KEINE nativen sqlite-Pakete.
  Schema nur in `src/services/database.js`. Timestamps als Integer (`Date.now()`).
- **API:** alle Endpunkte unter `/api/*`, JSON, camelCase in Responses (snake_case in DB).
  Auth: JWT Bearer via `requireAuth` aus `src/middleware/authMiddleware.js`.
- **Rollen:** `admin` (alles inkl. Benutzer/Secrets), `operator` (Servermutationen),
  `viewer` (zugewiesene Server Power-Aktionen + Konsolenbefehle + Modpacks
  installieren, sonst read-only). Legacy-Rolle `player` wird zu `viewer` migriert.
  Nicht-Admins sehen ausschließlich Server aus `user_server_access`; Admins implizit alle.
- **Routes** exportieren `init(app, io)`, kein direkter `app.listen`.
- **Frontend:** Vanilla JS, keine Frameworks, keine Bundler. Dateien in `public/js/`
  laden in Reihenfolge: icons → api → management → charts → views → app. UI-Sprache: **Deutsch**,
  Code-Kommentare Englisch. Icons nur aus `public/js/icons.js` (Pixel-SVGs, 16×16).
- **Metriken:** jeder Tick wird in `metrics` persistiert (Retention via
  `METRICS_RETENTION_HOURS`). Charts laden zuerst Historie via REST, dann Live-Ticks
  via Socket — nie bei null anfangen.
- **Provider:** Modrinth braucht keinen Key; CurseForge wirft ohne
  `CURSEFORGE_API_KEY` einen `NOT_CONFIGURED_MSG`-Fehler → Route mappt auf 503.
  Key-Auflösung in `curseforgeService.apiKey()`: **DB (`settings`-Tabelle, via
  Einstellungen-Seite) hat Vorrang vor env**. Settings-Routes (`/api/settings*`)
  sind admin-only; der Key wird nur maskiert (letzte 4 Zeichen) ans Frontend gegeben.
- Laufzeit-Artefakte (`panel.db`, `data/`, `servers/`) sind gitignored.

## Server-Management
- `fileService.js`: sichere relative Pfade, keine Symlinks/Traversal; Textlimit 2 MB,
  Binär-Uploads bis 512 MB. Routes in `filesBackups.js`.
- `backupService.js`: Archiver-Streaming in `BACKUPS_DIR`, Restore mit vorheriger
  vollständiger ZIP-Pfadvalidierung via `unzipper`; Server muss offline sein.
- `backupPolicyService.js`: persistente Server-Zeitpläne in `server_backup_settings`,
  60s-Scheduler (automatisch nur offline), Anzahl-Rotation sowie harte Quoten mit
  Reservierungen für parallele Jobs. Defaults: 20 GiB/Server, 100 GiB global;
  globale Limits und Server-Quota nur Admin, Zeitplan auch Operator.
- `playerService.js`: verwaltet `ops.json`, `whitelist.json`, `banned-players.json`,
  `usercache.json`; unbekannte UUIDs via Mojang API.
- `propertiesService.js`: whitelisted, typisiertes Schema; unbekannte/sensitive
  Properties werden nie über die GUI exponiert.
- `updateService.js`: Modpack-Update-Engine. Prüft installierte Packs (`mods`-Tabelle
  mit `version_id`) periodisch gegen Modrinth/CurseForge (Intervall via
  `UPDATE_CHECK_INTERVAL_MINUTES`, Default 360; nur gleiche MC-Version + Loader),
  persistiert in `modpack_update_state`, emittiert `update:available` in den
  Server-Room. `POST /api/servers/:id/update` (Operator, Server muss offline sein)
  startet die Kette: **Backup zuerst** (backupService, bei Fehler/Quote Abbruch),
  dann reguläre modpackService-Pipeline mit der neuesten Version; Fortschritt über
  `modpack:progress`-Events (Job-ID kommt mit der 202-Response).
- `jobsService.js`: admin-only Job-Aggregation für Modpack-/Installer-/Update-Jobs
  aus `modpack_jobs` und laufende Backup-Jobs. `GET /api/admin/jobs` liefert das
  Job-Log; `POST /api/admin/jobs/:id/cancel` markiert aktive Jobs als abgebrochen.
- Frontend-Modul `public/js/management.js` lädt vor `views.js` und mountet die
  Server-Management-Tabs sowie die globale Benutzerseite inklusive Serverzuweisungen.
- Socket.IO ist JWT-authentifiziert; Clients treten nur Räumen `server:<id>` bei, für
  die sie Zugriff besitzen. Serverbezogene Events niemals global emitten.

## Fallstricke
- `index.js` lädt `src/routes/modpacks.js` tolerant (try/catch) — beim Testen einzelner
  Teile kann die Datei fehlen.
- Im Simulationsmodus ist die Frontend-Konsole schreibgeschützt (Demo). Im Real-Modus
  sendet sie Befehle per `POST /api/servers/:id/command` an den Java-Prozess — für alle
  Benutzer mit Serverzugriff (auch Viewer), nur solange der Server online ist.
