'use strict';

// Obsidian Anywhere
//
// Opens Markdown files that live OUTSIDE the vault, without copying, importing or moving them.
// A small Linux opener (installed by install.sh) creates a temporary symlink
// <vault>/External/<name> -> original file and hands this plugin a request. The plugin OWNS
// opening/focusing of that file and the cleanup of the temporary symlink:
//
//   opener --> <plugin dir>/requests/request-<id>.json   persistent, atomic request record (source of truth)
//          \-> obsidian://open?vault=<id>                 only wakes/raises the running Obsidian
//
// The plugin also registers obsidian://obsidian-anywhere. It is a nudge/compat channel: it makes the
// plugin read the request records immediately. A URI can never make the plugin track or delete an
// External/ link; only a request record written by the opener can do that.
//
// Every request has a unique id and is handled at most once (duplicate delivery is harmless). A request
// record is deleted only after the file was opened/focused, or deliberately discarded (invalid/timeout).
//
//   kind "external": path is External/<name>, a symlink to the original file
//   kind "internal": path is the vault-relative path of a file already in the vault
//
// Only tracked External/ symlinks are ever removed - never originals, regular files, internal vault
// files, retargeted links or untracked links.

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, Modal, Notice, FileSystemAdapter, TFile, TFolder } = obsidian;
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_ID = 'obsidian-anywhere';
const PLUGIN_TITLE = 'Obsidian Anywhere';
const DEFAULT_EXTERNAL_DIR = 'External';
// The folder (directly inside the vault) that holds the temporary links. A dot-folder would be ignored by Obsidian.
function validExtName(n) {
  return typeof n === 'string' && n.length > 0 && n.length <= 100 && !n.includes('/') && !n.includes('\\') && !n.includes('\0')
    && !n.startsWith('.') && n.trim() === n;
}
const REQUEST_DIR = 'requests';
const ACTION = 'obsidian-anywhere';
const DESKTOP_ID = 'obsidian-anywhere.desktop';
const MIME_TYPES = ['text/markdown', 'text/x-markdown'];
const ID_RE = /^[0-9A-Za-z._-]{8,80}$/;
const DONE_KEEP = 500;
const LOG_MAX_BYTES = 1024 * 1024;

const ENV = (typeof process !== 'undefined' && process.env) || {};

const DEFAULT_SETTINGS = {
  removeOnLastTabClose: true, // remove a symlink when its last tab closes
  removeOnShutdown: true,     // remove tracked symlinks on normal Obsidian shutdown
  restoreOnStartup: true,     // recreate tracked symlinks at startup so restored tabs resolve
  graceSeconds: 1.5,          // a link must stay unreferenced this long before removal
  debugLogging: false,
};

// ---- per-user locations (XDG) ---------------------------------------------------------------------

function xdgDir(name, fallback) {
  const v = ENV[name];
  if (v && path.isAbsolute(v)) return v;
  return path.join(os.homedir(), ...fallback);
}

function configFilePath() {
  const o = ENV.OBSIDIAN_ANYWHERE_CONFIG;
  if (o && path.isAbsolute(o)) return o;
  return path.join(xdgDir('XDG_CONFIG_HOME', ['.config']), PLUGIN_ID, 'config.json');
}

function defaultLogPath() {
  return path.join(xdgDir('XDG_STATE_HOME', ['.local', 'state']), PLUGIN_ID, PLUGIN_ID + '.log');
}

function pad2(n) { return String(n).padStart(2, '0'); }

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function sanitizeSettings(raw) {
  const s = Object.assign({}, DEFAULT_SETTINGS);
  if (raw && typeof raw === 'object') {
    for (const k of ['removeOnLastTabClose', 'removeOnShutdown', 'restoreOnStartup', 'debugLogging']) {
      if (typeof raw[k] === 'boolean') s[k] = raw[k];
    }
    if (typeof raw.graceSeconds === 'number' && isFinite(raw.graceSeconds)) s.graceSeconds = clamp(raw.graceSeconds, 0.5, 60);
  }
  return s;
}

function sameFile(a, b) {
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch (e) { return false; }
}

function errText(e) { return e && e.message ? e.message : String(e); }

module.exports = class ObsidianAnywhere extends Plugin {
  constructor(app, manifest) {
    super(app, manifest);
    this.timing = {
      debounceMs: 300,          // coalesce bursts of workspace events
      confirmMs: 1500,          // a link must stay unreferenced this long before removal (setting)
      recentMs: 10000,          // never remove a link (re)created by the opener this recently
      pollMs: 30000,            // small safety-net rescan; events are the primary trigger
      startupGraceMs: 15000,    // links known only from the registry are not removed this soon after layout-ready
      spoolPollMs: 5000,        // safety net for the request-dir watcher
      retryMs: 250,             // re-check interval for a request whose file is not indexed yet
      firstNudgeMs: 500,        // wait this long for Obsidian's own indexing before nudging it
      nudgeMs: 1000,            // minimum interval between index nudges per request
      resolveTimeoutMs: 30000,  // give up (logged) on a file that never becomes visible
      requestMaxAgeMs: 300000,  // discard requests older than this
      stepMs: 5000,             // cap on any single Obsidian call the queue awaits
      folderSyncMs: 2000,       // how often linked folders are compared with Obsidian's file index
      folderMaxEntries: 20000,  // a linked folder larger than this is not watched (logged once)
      purgeRetryMs: 3000,       // one extra look for stale explorer entries after startup
    };
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
    this.cfg = null;            // generated runtime config (read-only for the plugin, except "debug")
    this.logFile = defaultLogPath();
    this.tracked = new Map();   // vault-relative path -> { target, gone, restored }
    this.queue = new Map();     // pending requests by id
    this.opening = new Map();   // vault path -> leaf we are opening right now
    this.doneIds = [];
    this.doneSet = new Set();
    this.ready = false;
    this.readyAt = 0;
    this.syncing = false;       // a folder sync pass is running
    this.extDir = DEFAULT_EXTERNAL_DIR; // folder inside the vault that holds the links (config.json: externalDir)
    this.hidden = new Set();    // linked children the user deleted in Obsidian: hidden from the view, never touched on disk
    this.syncSeen = new Map();  // differences seen on the previous pass (acted on only when seen twice)
    this.quitting = false;
    this.shutdownCleaned = false;
    this.timer = null;
    this.pumpTimer = null;
    this.pumping = false;
    this.repump = false;
    this.saved = '';
    this.protocolRegistered = false;
    this.watcher = null;
    this.watcherActive = false;
    this.base = '';
  }

  async onload() {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter) || typeof adapter.getBasePath !== 'function') {
      new Notice(PLUGIN_TITLE + ' needs a desktop (filesystem) vault.');
      return;
    }
    this.base = adapter.getBasePath();
    this.root = path.join(this.base, DEFAULT_EXTERNAL_DIR);
    this.pluginDirAbs = path.join(this.base, this.app.vault.configDir, 'plugins', this.manifest.id);
    this.reqDir = path.join(this.pluginDirAbs, REQUEST_DIR);

    // Registered first and synchronously, so a URI that launched Obsidian finds it.
    if (typeof this.registerObsidianProtocolHandler === 'function') {
      try {
        this.registerObsidianProtocolHandler(ACTION, (params) => { this.accept(params); });
        this.protocolRegistered = true;
      } catch (e) { this.warn('protocol handler unavailable: ' + errText(e)); }
    }

    this.refreshConfig();
    if (this.cfg && validExtName(this.cfg.externalDir)) this.extDir = this.cfg.externalDir;
    this.root = path.join(this.base, this.extDir);
    await this.loadState();
    this.applySettings();

    // Recreate only plugin-owned tracked symlinks before restored external tabs need those paths.
    if (this.settings.restoreOnStartup) {
      const r = this.restoreTrackedLinks({ startup: true });
      this.info(`startup: tracked=${this.tracked.size} recreated=${r.created} intact=${r.ok} retargeted=${r.retargeted} missing-original=${r.missingTarget}`);
    } else {
      this.info(`startup: tracked=${this.tracked.size}; link restoration disabled in settings`);
    }

    this.addSettingTab(new AnywhereSettingTab(this.app, this));
    this.registerCommands();
    this.patchDeletion();
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.onRename(file, oldPath)));

    const ws = this.app.workspace;
    this.registerEvent(ws.on('layout-change', () => this.request()));
    this.registerEvent(ws.on('file-open', () => this.request()));
    this.registerEvent(ws.on('active-leaf-change', () => this.request()));
    // During shutdown the workspace is torn down; leaves vanishing then are not "closed tabs".
    this.registerEvent(ws.on('quit', () => {
      this.quitting = true;
      this.cleanupAllTrackedSync('quit');
    }));

    this.registerDomEvent(window, 'beforeunload', () => {
      this.quitting = true;
      this.cleanupAllTrackedSync('beforeunload');
    });
    this.registerInterval(window.setInterval(() => this.request(0), this.timing.pollMs));
    this.registerInterval(window.setInterval(() => { this.syncFolders(false).catch(() => {}); }, this.timing.folderSyncMs));

    // Persistent channel: request records written by the opener.
    this.startSpoolWatcher();
    this.register(() => {
      try { if (this.watcher) this.watcher.close(); } catch (e) { /* ignore */ }
      this.watcher = null;
      this.watcherActive = false;
    });
    this.registerInterval(window.setInterval(() => { this.scanSpool(); this.schedulePump(0); }, this.timing.spoolPollMs));
    this.scanSpool();

    // Restored tabs count as open only from here on; earlier scans would see "no tabs".
    ws.onLayoutReady(() => {
      this.ready = true;
      this.readyAt = Date.now();
      this.scanSpool();
      this.schedulePump(0);
      this.request(0);
      // Links removed at the last shutdown must not linger in Obsidian's cached file list.
      this.purgeStale().catch(() => {});
      this.registerInterval(window.setTimeout(() => { this.purgeStale().catch(() => {}); }, this.timing.purgeRetryMs));
    });
  }

  onunload() {
    window.clearTimeout(this.timer);
    window.clearTimeout(this.pumpTimer);

    if (this.quitting) {
      this.cleanupAllTrackedSync('onunload');
    }
  }

  // ---- settings / state --------------------------------------------------------------------------

  async loadState() {
    let data = {};
    try { data = (await this.loadData()) || {}; } catch (e) { data = {}; }
    this.settings = sanitizeSettings(data.settings);
    const links = data.links && typeof data.links === 'object' ? data.links : {};
    // Links this plugin tracked in an earlier session (orphan cleanup after a crash / plugin off).
    for (const rel of Object.keys(links)) {
      if (this.isExternal(rel) && typeof links[rel] === 'string' && path.isAbsolute(links[rel])) {
        this.tracked.set(rel, { target: links[rel], gone: null, restored: true });
      }
    }
    const dirs = Array.isArray(data.dirs) ? data.dirs : [];
    for (const rel of dirs) if (this.tracked.has(rel)) this.tracked.get(rel).dir = true;
    this.saved = this.serializeState();
  }

  applySettings() {
    this.timing.confirmMs = clamp(Math.round(this.settings.graceSeconds * 1000), 500, 60000);
  }

  serializeState() {
    const links = {};
    const dirs = [];
    for (const [rel, entry] of this.tracked) { links[rel] = entry.target; if (entry.dir) dirs.push(rel); }
    return JSON.stringify(dirs.length ? { links, dirs, settings: this.settings } : { links, settings: this.settings });
  }

  async saveSettings() {
    this.applySettings();
    this.saved = this.serializeState();
    await this.saveData(JSON.parse(this.saved));
  }

  persist() {
    const s = this.serializeState();
    if (s === this.saved) return;
    this.saved = s;
    Promise.resolve(this.saveData(JSON.parse(s))).catch(() => {});
  }

  // Generated runtime configuration written by install.sh (read-only here, except the debug flag).
  readConfig() {
    const file = configFilePath();
    try {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cfg && typeof cfg === 'object') return { file, cfg, error: '' };
      return { file, cfg: null, error: 'config.json is not an object' };
    } catch (e) {
      return { file, cfg: null, error: e && e.code === 'ENOENT' ? 'not found' : errText(e) };
    }
  }

  refreshConfig() {
    const { cfg } = this.readConfig();
    this.cfg = cfg;
    this.logFile = cfg && typeof cfg.logFile === 'string' && path.isAbsolute(cfg.logFile) ? cfg.logFile : defaultLogPath();
  }

  syncHelperDebug(on) {
    const { file, cfg } = this.readConfig();
    if (!cfg) return false;
    try {
      cfg.debug = !!on;
      const tmp = file + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
      fs.renameSync(tmp, file);
      this.cfg = cfg;
      return true;
    } catch (e) {
      this.warn('could not update helper debug flag: ' + errText(e));
      return false;
    }
  }

  // ---- logging ---------------------------------------------------------------------------------------
  // Quiet by default: errors, warnings and lifecycle summaries are kept; per-request detail is debug only.

  writeLog(level, msg) {
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      try { if (fs.statSync(this.logFile).size > LOG_MAX_BYTES) fs.renameSync(this.logFile, this.logFile + '.1'); } catch (e) { /* no log yet */ }
      fs.appendFileSync(this.logFile, `${stamp()} [plugin] ${level} ${msg}\n`);
    } catch (e) { /* logging is best effort */ }
  }

  err(msg) { console.error('[obsidian-anywhere] ' + msg); this.writeLog('ERROR', msg); }
  warn(msg) { console.warn('[obsidian-anywhere] ' + msg); this.writeLog('WARN', msg); }
  info(msg) { this.writeLog('INFO', msg); }
  debug(msg) {
    if (!this.settings.debugLogging) return;
    console.debug('[obsidian-anywhere] ' + msg);
    this.writeLog('DEBUG', msg);
  }

  clearLog() {
    let n = 0;
    for (const f of [this.logFile, this.logFile + '.1']) {
      try { fs.unlinkSync(f); n++; } catch (e) { /* not there */ }
    }
    return n;
  }

  // ---- shutdown / startup of tracked links ------------------------------------------------------------

  // Recreate missing symlinks of tracked entries whose original still exists. Never overwrites a
  // regular file and never touches a symlink that was retargeted (it is only reported).
  restoreTrackedLinks(opts = {}) {
    const res = { created: 0, ok: 0, retargeted: 0, missingTarget: 0, refused: 0, failed: 0 };
    let changed = false;

    try {
      const st = fs.lstatSync(this.root);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        this.warn(this.extDir + '/ is not a plain directory; link restoration skipped');
        return res;
      }
    } catch (e) {
      try { fs.mkdirSync(this.root, { recursive: true }); } catch (e2) {
        this.err('cannot create ' + this.extDir + '/: ' + errText(e2));
        return res;
      }
    }

    for (const [rel, entry] of [...this.tracked]) {
      if (opts.only && opts.only !== rel) continue;

      if (!entry || typeof entry.target !== 'string' || !entry.target || !path.isAbsolute(entry.target)) {
        this.tracked.delete(rel);
        changed = true;
        continue;
      }

      const linkPath = this.abs(rel);
      if (!linkPath) {
        this.tracked.delete(rel);
        changed = true;
        continue;
      }

      const target = path.resolve(entry.target);

      // Only recreate links whose original target still exists. A missing original keeps its
      // tracking record so it is visible (BROKEN) and can be forgotten explicitly.
      let targetOk = false;
      try { const ts = fs.statSync(target); targetOk = entry.dir ? ts.isDirectory() : ts.isFile(); } catch (e) { /* missing */ }
      if (!targetOk) {
        res.missingTarget++;
        this.debug('restore: original missing for ' + rel);
        continue;
      }

      let st = null;
      try {
        st = fs.lstatSync(linkPath);
      } catch (e) {
        if (e.code !== 'ENOENT') {
          res.failed++;
          this.warn(`restore: lstat failed for ${rel}: ${errText(e)}`);
          continue;
        }
      }

      try {
        if (!st) {
          fs.symlinkSync(target, linkPath);
          res.created++;
          this.debug(`restore: recreated ${rel} -> ${target}`);
          continue;
        }

        // Never overwrite a normal file.
        if (!st.isSymbolicLink()) {
          this.warn(`restore: a regular file occupies tracked path; refusing to touch it: ${rel}`);
          this.tracked.delete(rel);
          changed = true;
          res.refused++;
          continue;
        }

        const actual = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
        if (actual !== target) {
          // Retargeted from outside: report, never replace or delete.
          this.warn(`restore: ${rel} points to ${actual}, not to the tracked original ${target}; left untouched`);
          res.retargeted++;
        } else {
          res.ok++;
        }
      } catch (e) {
        res.failed++;
        this.warn(`restore: link recreation failed for ${rel}: ${errText(e)}`);
      }
    }

    if (changed) this.persist();
    return res;
  }

  cleanupAllTrackedSync(reason) {
    // quit + beforeunload + onunload can all occur. Do this exactly once.
    if (this.shutdownCleaned) return;
    this.shutdownCleaned = true;
    if (!this.base || !this.settings.removeOnShutdown) {
      this.info(`shutdown [${reason}]: link removal disabled in settings`);
      return;
    }

    let removed = 0;

    for (const [rel, entry] of this.tracked) {
      const linkPath = this.abs(rel);
      if (!linkPath) continue;

      try {
        const st = fs.lstatSync(linkPath);

        // Never delete a regular file.
        if (!st.isSymbolicLink()) {
          this.warn('shutdown cleanup skipped non-symlink: ' + rel);
          continue;
        }

        const actual = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
        const expected = entry && typeof entry.target === 'string' ? path.resolve(entry.target) : null;

        // Never delete a link whose target changed.
        if (!expected || actual !== expected) {
          this.warn('shutdown cleanup skipped retargeted link: ' + rel);
          continue;
        }

        // This removes ONLY the symlink itself.
        fs.unlinkSync(linkPath);
        removed += 1;
      } catch (e) {
        if (e.code !== 'ENOENT') this.warn(`shutdown cleanup failed for ${rel}: ${errText(e)}`);
      }
    }

    this.info(`shutdown [${reason}]: removed=${removed}`);
  }

  // ---- helpers -----------------------------------------------------------------------------------------

  isExternal(rel) {
    return typeof rel === 'string'
      && rel.startsWith(this.extDir + '/')
      && rel.length > this.extDir.length + 1
      && rel.indexOf('/', this.extDir.length + 1) === -1
      && !rel.includes('\0')
      && !rel.split('/').includes('..');
  }

  // Filesystem path of a vault-relative path, only if it lies inside <vault>/External/.
  abs(rel) {
    if (!this.isExternal(rel)) return null;
    const p = path.resolve(this.base, rel);
    return p.startsWith(this.root + path.sep) ? p : null;
  }

  validRel(rel) {
    if (typeof rel !== 'string' || !rel || rel.includes('\0') || rel.startsWith('/')) return false;
    if (rel.split('/').some((s) => s === '' || s === '.' || s === '..')) return false;
    return path.resolve(this.base, rel).startsWith(this.base + path.sep);
  }

  leafFiles(leaf) {
    const out = [];
    const vs = typeof leaf.getViewState === 'function' ? leaf.getViewState() : null; // works for deferred views too
    const state = vs && vs.state;
    if (state && typeof state.file === 'string') out.push(state.file);
    const vf = !leaf.isDeferred && leaf.view && leaf.view.file && leaf.view.file.path;
    if (typeof vf === 'string') out.push(vf);
    return out;
  }

  // ---- opening: request intake ---------------------------------------------------------------------------

  // obsidian://obsidian-anywhere?id=..&kind=..&t=..&path=..
  // The request records stay the source of truth: read them right away, and only accept a URI-only
  // request for a file that is already inside the vault. External links are never created, tracked or
  // removed because of a URI.
  accept(p) {
    this.scanSpool();
    const params = p && typeof p === 'object' ? p : {};
    const id = params.id;
    if (typeof id === 'string' && ID_RE.test(id) && (this.queue.has(id) || this.doneSet.has(id))) return 'duplicate';
    if (params.kind === 'internal') {
      return this.enqueue({ id, kind: 'internal', rel: params.path, requestedAt: Number(params.t), source: 'uri' });
    }
    this.warn(`URI request ${typeof id === 'string' ? id : '?'} ignored: external requests are only accepted from request records`);
    return 'rejected';
  }

  invalid(r) {
    if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return 'bad id';
    if (r.kind !== 'external' && r.kind !== 'internal') return 'bad kind';
    if (!this.validRel(r.rel)) return 'bad path';
    if (r.kind === 'external' && !this.isExternal(r.rel)) return 'external path is not under ' + this.extDir + '/';
    if (r.target !== undefined && r.target !== null && (typeof r.target !== 'string' || !path.isAbsolute(r.target) || r.target.includes('\0'))) return 'bad target';
    if (r.dir !== undefined && typeof r.dir !== 'boolean') return 'bad dir';
    if (typeof r.requestedAt !== 'number' || !isFinite(r.requestedAt)) return 'bad time';
    if (Date.now() - r.requestedAt > this.timing.requestMaxAgeMs) return 'stale';
    return '';
  }

  // Idempotent: the same request id is handled once, whichever delivery arrives first.
  enqueue(req) {
    if (typeof req.id === 'string' && ID_RE.test(req.id)) {
      if (this.doneSet.has(req.id)) {
        if (req.source === 'spool') this.dropRecord(req.id);
        else this.debug(`request ${req.id}: duplicate delivery via ${req.source} ignored (already handled)`);
        return 'duplicate';
      }
      if (this.queue.has(req.id)) {
        if (req.source !== 'spool') this.debug(`request ${req.id}: duplicate delivery via ${req.source} ignored (already queued)`);
        return 'duplicate';
      }
    }
    const bad = this.invalid(req);
    if (bad) {
      this.warn(`request ${req.id || '?'} rejected: ${bad}`);
      if (typeof req.id === 'string' && ID_RE.test(req.id)) { this.markDone(req.id); this.dropRecord(req.id); }
      return 'rejected';
    }
    this.queue.set(req.id, {
      id: req.id, kind: req.kind, rel: req.rel, target: req.target || '', dir: req.dir === true, requestedAt: req.requestedAt,
      source: req.source, first: 0, retryAt: 0, nudgeAt: 0,
    });
    this.schedulePump(0);
    return 'queued';
  }

  recordPath(id) { return path.join(this.reqDir, `request-${id}.json`); }

  dropRecord(id) {
    try { fs.unlinkSync(this.recordPath(id)); } catch (e) { /* already gone */ }
  }

  markDone(id) {
    if (this.doneSet.has(id)) return;
    this.doneSet.add(id);
    this.doneIds.push(id);
    if (this.doneIds.length > DONE_KEEP) this.doneSet.delete(this.doneIds.shift());
  }

  startSpoolWatcher() {
    if (this.watcherActive) return true;
    try {
      fs.mkdirSync(this.reqDir, { recursive: true });
      this.watcher = fs.watch(this.reqDir, () => this.scanSpool());
      this.watcher.on('error', () => { this.watcherActive = false; });
      this.watcherActive = true;
      return true;
    } catch (e) {
      this.warn('request watcher unavailable: ' + errText(e));
      return false;
    }
  }

  // Read the persistent request records. Anything unrecognisable is discarded here; valid records go
  // through the same queue.
  scanSpool() {
    if (!this.reqDir) return;
    let names;
    try { names = fs.readdirSync(this.reqDir).sort(); } catch (e) { return; }
    for (const n of names) {
      if (n.startsWith('.') || !n.endsWith('.json')) continue;
      const file = path.join(this.reqDir, n);
      let rec = null;
      try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* invalid */ }
      const id = rec && typeof rec.id === 'string' ? rec.id : null;
      if (!id || !ID_RE.test(id) || n !== `request-${id}.json`) {
        try { fs.unlinkSync(file); this.warn(`discarded unrecognised request file ${n}`); } catch (e) { /* ignore */ }
        continue;
      }
      this.enqueue({ id, kind: rec.kind, rel: rec.vaultPath, target: rec.target, dir: rec.dir, requestedAt: rec.requestedAt, source: 'spool' });
    }
  }

  // ---- opening: queue processing -----------------------------------------------------------------------------

  schedulePump(delay = 0) {
    if (this.quitting) return;
    window.clearTimeout(this.pumpTimer);
    this.pumpTimer = window.setTimeout(() => { this.pumpTimer = null; this.pump(); }, delay);
  }

  // One request at a time, in id order; a request that is not ready never blocks the ones after it.
  async pump() {
    if (!this.ready || this.quitting) return;
    if (this.pumping) { this.repump = true; return; }
    this.pumping = true;
    let wait = 0;
    try {
      do {
        this.repump = false;
        wait = 0;
        const items = [...this.queue.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        for (const item of items) {
          if (!this.queue.has(item.id) || this.quitting) continue;
          const w = await this.process(item);
          if (w > 0) wait = wait ? Math.min(wait, w) : w;
        }
      } while (this.repump);
    } catch (e) {
      this.err('request queue error: ' + errText(e));
    } finally {
      this.pumping = false;
    }
    if (wait > 0) this.schedulePump(wait);
  }

  // True when rel is a symlink that points exactly where the request said it would.
  linkMatches(rel, target) {
    const abs = this.abs(rel);
    if (!abs) return false;
    try {
      if (!fs.lstatSync(abs).isSymbolicLink()) return false;
      return path.resolve(path.dirname(abs), fs.readlinkSync(abs)) === path.resolve(target);
    } catch (e) { return false; }
  }

  // Returns 0 when the request is finished, otherwise the ms to wait before trying it again.
  async process(item) {
    const now = Date.now();
    if (now < item.retryAt) return item.retryAt - now;
    if (!item.first) item.first = now;
    const rel = item.rel;
    const abs = path.resolve(this.base, rel);

    let st = null;
    try { st = fs.lstatSync(abs); } catch (e) { /* not there (yet) */ }
    if (st && item.kind === 'external' && !st.isSymbolicLink()) return this.finish(item, 'discarded: an external request must name a symlink');
    if (st && item.kind === 'external' && item.target && !this.linkMatches(rel, item.target)) return this.finish(item, 'discarded: the symlink does not point at the requested original');
    if (st && item.kind === 'internal' && st.isSymbolicLink() && this.isExternal(rel)) return this.finish(item, 'discarded: an internal request must not name an External/ symlink');

    if (item.dir) return this.processFolder(item, now);

    // 1. Already open in ANY leaf of ANY window (deferred ones included)? Focus it, open nothing.
    const leaves = this.leavesFor(rel);
    if (leaves.length) {
      await this.focus(this.best(leaves));
      return this.succeed(item, `focused existing tab (${leaves.length} leaf/leaves)`);
    }

    // 2. Is the file visible to Obsidian yet? A fresh symlink can lag; keep the request meanwhile.
    let file = this.lookup(rel);
    if (!file) {
      if (!item.nudgeAt) item.nudgeAt = now + this.timing.firstNudgeMs;
      if (now >= item.nudgeAt) {
        item.nudgeAt = now + this.timing.nudgeMs;
        await this.nudge(rel);
        file = this.lookup(rel);
      }
    }
    if (!file) {
      if (now - item.first > this.timing.resolveTimeoutMs) {
        this.err(`request ${item.id}: ${rel} never became visible in Obsidian; discarded`);
        new Notice(`${PLUGIN_TITLE}: could not open ${rel}`);
        // The opener created this link for a request that will never be served: let cleanup own it.
        if (item.kind === 'external' && item.target && this.linkMatches(rel, item.target)) { this.track(rel); this.persist(); }
        return this.finish(item, 'discarded after timeout');
      }
      item.retryAt = now + this.timing.retryMs;
      return this.timing.retryMs;
    }

    // 3. Not open anywhere: exactly one new tab.
    let leaf = null;
    try {
      leaf = this.app.workspace.getLeaf('tab');
      this.opening.set(rel, leaf);
      await this.within(leaf.openFile(file, { active: true }), 'openFile');
      if (!this.leafFiles(leaf).includes(rel)) throw new Error('tab does not show the file');
    } catch (e) {
      this.debug(`request ${item.id}: open of ${rel} failed (${errText(e)}); will retry`);
      this.opening.delete(rel);
      try { if (leaf && !this.leafFiles(leaf).length) leaf.detach(); } catch (e2) { /* ignore */ }
      item.retryAt = Date.now() + this.timing.retryMs;
      return this.timing.retryMs;
    }
    this.opening.delete(rel);
    await this.focus(leaf);
    return this.succeed(item, 'opened new tab');
  }

  // Folder request: no tab. Wait until Obsidian lists the folder, then reveal it in the file explorer
  // (repeating the request just reveals it again). The one tracked root symlink is all that exists.
  async processFolder(item, now) {
    const rel = item.rel;
    let folder = this.lookup(rel, true);
    if (!folder) {
      if (!item.nudgeAt) item.nudgeAt = now + this.timing.firstNudgeMs;
      if (now >= item.nudgeAt) {
        item.nudgeAt = now + this.timing.nudgeMs;
        await this.nudge(rel, true);
        folder = this.lookup(rel, true);
      }
    }
    if (!folder) {
      if (now - item.first > this.timing.resolveTimeoutMs) {
        this.err(`request ${item.id}: ${rel} never became visible in Obsidian; discarded`);
        new Notice(`${PLUGIN_TITLE}: could not open ${rel}`);
        if (item.kind === 'external' && item.target && this.linkMatches(rel, item.target)) { this.track(rel, true); this.persist(); }
        return this.finish(item, 'discarded after timeout');
      }
      item.retryAt = now + this.timing.retryMs;
      return this.timing.retryMs;
    }
    try {
      const ws = this.app.workspace;
      const fe = typeof ws.getLeavesOfType === 'function' ? ws.getLeavesOfType('file-explorer')[0] : null;
      if (fe && fe.view && typeof fe.view.revealInFolder === 'function') { // undocumented but widely used; optional
        await this.within(ws.revealLeaf(fe), 'revealLeaf');
        fe.view.revealInFolder(folder);
      } else this.debug('file explorer not available: folder is linked but not revealed');
    } catch (e) { this.debug('reveal failed: ' + errText(e)); }
    return this.succeed(item, 'folder linked and revealed');
  }

  succeed(item, msg) {
    if (item.kind === 'external') { this.track(item.rel, item.dir); this.persist(); }
    return this.finish(item, msg);
  }

  finish(item, msg) {
    this.queue.delete(item.id);
    this.markDone(item.id);
    this.dropRecord(item.id);
    this.debug(`request ${item.id} (${item.kind} ${item.rel}): ${msg}`);
    return 0;
  }

  // Leaves showing rel, across all tab groups and windows, deferred/background ones included.
  // dir=true: a folder root counts as in use while any tab shows a file below it.
  leavesFor(rel, dir) {
    const found = [];
    const attached = new Set();
    const under = rel + '/';
    this.app.workspace.iterateAllLeaves((leaf) => {
      attached.add(leaf);
      try { if (this.leafFiles(leaf).some((f) => f === rel || (dir && f.startsWith(under)))) found.push(leaf); } catch (e) { /* leaf mid-teardown */ }
    });
    const o = this.opening.get(rel);
    if (o) {
      if (!attached.has(o)) this.opening.delete(rel);
      else if (!found.includes(o)) found.push(o);
    }
    return found;
  }

  best(leaves) {
    const ws = this.app.workspace;
    const recent = typeof ws.getMostRecentLeaf === 'function' ? ws.getMostRecentLeaf() : null;
    return leaves.includes(recent) ? recent : leaves[0];
  }

  lookup(rel, dir) {
    const f = this.app.vault.getAbstractFileByPath(rel);
    return f instanceof (dir ? TFolder : TFile) ? f : null;
  }

  // Best effort, only for a path that exists on disk as a real file but that Obsidian has not indexed:
  // ask its file adapter to reconcile it. This is the ONLY undocumented Obsidian API used; every call
  // is feature-detected and failure is harmless (the request just keeps waiting for Obsidian's own indexing).
  async nudge(rel, dir) {
    const abs = path.resolve(this.base, rel);
    try { const st = fs.statSync(abs); if (dir ? !st.isDirectory() : !st.isFile()) return; } catch (e) { return; } // broken link: nothing to index
    const a = this.app.vault.adapter;
    const calls = [];
    if (dir && typeof a.reconcileFolderCreation === 'function') calls.push(() => a.reconcileFolderCreation(abs, rel));
    if (typeof a.reconcileFileInternal === 'function') calls.push(() => a.reconcileFileInternal(abs, rel));
    if (typeof a.reconcileFile === 'function') calls.push(() => a.reconcileFile(rel, abs));
    for (const call of calls) {
      try { await this.within(call(), 'reconcile'); } catch (e) { this.debug('index nudge failed: ' + errText(e)); }
      if (this.lookup(rel, dir)) return;
    }
  }

  within(promise, label) {
    let t;
    const timeout = new Promise((_, reject) => {
      t = window.setTimeout(() => reject(new Error(label + ' timed out')), this.timing.stepMs);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => window.clearTimeout(t));
  }

  async focus(leaf) {
    const ws = this.app.workspace;
    try { if (leaf.isDeferred && typeof leaf.loadIfDeferred === 'function') await this.within(leaf.loadIfDeferred(), 'loadIfDeferred'); } catch (e) { /* ignore */ }
    try { if (typeof ws.revealLeaf === 'function') await this.within(ws.revealLeaf(leaf), 'revealLeaf'); } catch (e) { /* ignore */ }
    try { if (typeof ws.setActiveLeaf === 'function') ws.setActiveLeaf(leaf, { focus: true }); } catch (e) { /* ignore */ }
    try { leaf.getContainer().win.focus(); } catch (e) { /* popout windows only */ }
  }

  // ---- cleanup ---------------------------------------------------------------------------------------------

  request(delay = this.timing.debounceMs) {
    if (this.quitting) return;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.timer = null; this.scan(); }, delay);
  }

  // Vault paths referenced by any leaf (all windows, deferred views included), plus an
  // independent second opinion from the serialized layout.
  openPaths() {
    const open = new Set();
    let leaves = 0;
    let failed = false;
    this.app.workspace.iterateAllLeaves((leaf) => {
      leaves++;
      try { for (const f of this.leafFiles(leaf)) open.add(f); } catch (e) { failed = true; } // mid-teardown: unsure
    });
    try { this.layoutFiles(this.app.workspace.getLayout(), open); } catch (e) { /* second opinion only */ }
    return { open, leaves, failed };
  }

  layoutFiles(node, into) {
    if (Array.isArray(node)) { node.forEach((n) => this.layoutFiles(n, into)); return; }
    if (!node || typeof node !== 'object') return;
    if (node.type === 'leaf') {
      const f = node.state && node.state.state && node.state.state.file;
      if (typeof f === 'string') into.add(f);
      return;
    }
    for (const k of Object.keys(node)) if (k !== 'lastOpenFiles') this.layoutFiles(node[k], into);
  }

  scan() {
    if (!this.ready || this.quitting || !this.settings.removeOnLastTabClose) return;
    let wait = 0; // ms until the soonest still-pending link should be re-checked
    try {
      const { open, leaves, failed } = this.openPaths();
      if (leaves === 0 || failed) return; // transient state: remove nothing

      const now = Date.now();
      const inUse = new Set(open);
      for (const item of this.queue.values()) inUse.add(item.rel); // a request for it is pending
      for (const rel of this.opening.keys()) inUse.add(rel);       // a tab is being opened for it

      for (const [rel, entry] of [...this.tracked]) {
        if (entry.dir) { // a folder root is in use while a tab shows a file below it; one opened this session stays until shutdown / manual cleanup
          const under = rel + '/';
          if ([...open].some((f) => f.startsWith(under))) { entry.gone = null; entry.restored = false; continue; }
          if (!entry.restored) { entry.gone = null; continue; }
        }
        if (inUse.has(rel)) { entry.gone = null; if (open.has(rel)) entry.restored = false; continue; }
        if (entry.gone === null) entry.gone = now;
        const w = this.tryRemove(rel, entry, now);
        if (w > 0) wait = wait ? Math.min(wait, w) : w;
      }
      this.persist();
    } catch (e) {
      this.err('scan failed: ' + errText(e));
    }
    if (wait) this.request(wait + 50);
  }

  // Record External/X.md -> target, only if X.md really is a symbolic link.
  track(rel, dir) {
    const abs = this.abs(rel);
    if (!abs) return;
    try {
      if (!fs.lstatSync(abs).isSymbolicLink()) { this.tracked.delete(rel); return; }
      const target = path.resolve(path.dirname(abs), fs.readlinkSync(abs));
      const entry = this.tracked.get(rel);
      if (entry) { entry.target = target; entry.gone = null; entry.restored = false; entry.warned = false; if (dir) entry.dir = true; }
      else this.tracked.set(rel, { target, gone: null, restored: false, dir: dir === true });
    } catch (e) {
      if (e.code === 'ENOENT') this.tracked.delete(rel);
    }
  }

  // Returns 0 when the entry is settled (removed / untracked / left for the user), else the ms to wait before re-checking.
  tryRemove(rel, entry, now) {
    const confirmWait = this.timing.confirmMs - (now - entry.gone);
    if (confirmWait > 0) return confirmWait;
    if (entry.restored) { // known only from the registry so far: give a restoring workspace time
      const grace = this.readyAt + this.timing.startupGraceMs - now;
      if (grace > 0) return grace;
    }
    const abs = this.abs(rel);
    if (!abs) { this.tracked.delete(rel); return 0; }
    try {
      const st = fs.lstatSync(abs);
      if (!st.isSymbolicLink()) { // not a link: never ours to delete
        this.warn(`${rel} is no longer a symlink; tracking dropped, nothing deleted`);
        this.tracked.delete(rel);
        return 0;
      }
      const target = path.resolve(path.dirname(abs), fs.readlinkSync(abs));
      if (target !== path.resolve(entry.target)) { // re-pointed: not the link we tracked; keep the record, report it, delete nothing
        if (!entry.warned) {
          entry.warned = true;
          this.warn(`${rel} was retargeted to ${target}; left untouched (use Diagnostics to stop tracking it)`);
        }
        return 0;
      }
      const age = now - st.mtimeMs;
      if (age < this.timing.recentMs) return Math.max(1, this.timing.recentMs - age); // opener just (re)created it
      // Last look at ALL leaves (and pending requests) right before deleting.
      if (this.leavesFor(rel, entry.dir).length || [...this.queue.values()].some((i) => i.rel === rel)) { entry.gone = null; return 0; }
      fs.unlinkSync(abs); // removes the symlink only, never its target
      this.tracked.delete(rel);
      this.dropHidden(rel);
      this.dropFromIndex(rel);
      this.debug(`removed ${rel} -> ${entry.target}`);
      return 0;
    } catch (e) {
      if (e.code === 'ENOENT') this.tracked.delete(rel);
      return 0; // other errors: leave it, retried on the next event / poll
    }
  }

  // ---- delete / rename made INSIDE Obsidian on linked items --------------------------------------------------
  // Delete behaves like deleting a normal vault item, following the user's own trash setting.
  //  - Items INSIDE a linked folder need no special handling: their vault paths resolve through the one root symlink to
  //    the real files and folders, so Obsidian's own trash / delete flow acts on the originals.
  //  - The linked ROOT is the symlink itself. Obsidian's native flow would move the symlink into .trash or recurse
  //    through it, which is not "deleting the item". So the policy that arrived (which native call was made) is applied
  //    to the real original instead, and then the temporary symlink and its Obsidian entry are removed.

  // The linked root (a symlink directly inside the external folder) a vault path belongs to, or null.
  linkRootOf(rel) {
    if (typeof rel !== 'string' || !rel.startsWith(this.extDir + '/')) return null;
    const seg = rel.split('/')[1];
    if (!seg || seg === '.' || seg === '..' || rel.includes('\0')) return null;
    const root = this.extDir + '/' + seg;
    try { if (!fs.lstatSync(path.join(this.base, root)).isSymbolicLink()) return null; } catch (e) { return null; }
    return { root, isRoot: rel === root };
  }

  // mode: 'permanent' (vault.delete), 'local' (vault.trash, .trash folder) or 'system' (vault.trash, system trash).
  async deleteLinkedRoot(file, mode) {
    const rel = file.path;
    const abs = path.join(this.base, rel);
    const refuse = (why) => { this.warn(`delete ${rel}: ${why}; nothing was changed`); new Notice(`${PLUGIN_TITLE}: ${why}. Nothing was deleted.`, 8000); };
    const entry = this.tracked.get(rel);
    let how = 'link removed (no original recorded for it)';
    if (entry) {
      let linkOk = false;
      try { linkOk = fs.lstatSync(abs).isSymbolicLink() && path.resolve(path.dirname(abs), fs.readlinkSync(abs)) === path.resolve(entry.target); } catch (e) { /* missing */ }
      if (!linkOk) return refuse('the link is no longer the one this plugin created');
      const orig = path.resolve(entry.target);
      let ost = null;
      try { ost = fs.lstatSync(orig); } catch (e) { /* original already gone */ }
      if (ost) {
        if (ost.isSymbolicLink() || (entry.dir ? !ost.isDirectory() : !ost.isFile())) return refuse('the original is not a plain ' + (entry.dir ? 'folder' : 'file'));
        if (!this.safeToDelete(orig)) return refuse(`refusing to delete ${orig}`);
        try { how = await this.applyTrashPolicy(orig, mode, !!entry.dir); } catch (e) { return refuse(`could not ${mode === 'permanent' ? 'delete' : 'trash'} the original (${e.code || errText(e)})`); }
      } else how = 'original already gone; link removed';
    }
    try { fs.unlinkSync(abs); } catch (e) { // unlink on a symlink removes the link only
      if (e.code !== 'ENOENT') { this.warn(`${rel}: original handled (${how}) but the link could not be removed: ${errText(e)}`); return; }
    }
    this.tracked.delete(rel);
    this.dropHidden(rel);
    this.syncSeen = new Map();
    this.persist();
    await this.reconcilePath('del', rel);
    this.info(`delete ${rel} [${mode}]: ${how}`);
  }

  // Never apply a delete to the filesystem root, the home folder, the vault or anything that contains it.
  safeToDelete(orig) {
    if (!path.isAbsolute(orig) || path.dirname(orig) === orig) return false;
    const base = path.resolve(this.base);
    if (orig === base || base.startsWith(orig + path.sep) || orig.startsWith(base + path.sep)) return false;
    try { if (orig === path.resolve(os.homedir())) return false; } catch (e) { /* no home */ }
    return true;
  }

  async applyTrashPolicy(orig, mode, isDir) {
    if (mode === 'permanent') {
      if (isDir) fs.rmSync(orig, { recursive: true }); else fs.unlinkSync(orig);
      return 'original deleted permanently';
    }
    if (mode === 'system') {
      if (await this.trashSystemItem(orig)) return 'original moved to the system trash';
      // Electron's trashItem cannot cross filesystems: write a Freedesktop Trash entry in the home Trash instead.
      try { return await this.trashFreedesktop(orig, isDir); } catch (e) { this.warn(`Freedesktop trash failed (${errText(e)}); using .trash`); }
    }
    // Obsidian's own trash folder (also what Obsidian falls back to when the system trash is unavailable).
    const dir = path.join(this.base, '.trash');
    fs.mkdirSync(dir, { recursive: true });
    const ext = isDir ? '' : path.extname(orig);
    const stem = path.basename(orig).slice(0, path.basename(orig).length - ext.length);
    let dest = path.join(dir, path.basename(orig));
    for (let i = 1; ; i++) {
      try { fs.lstatSync(dest); } catch (e) { break; }
      dest = path.join(dir, `${stem} ${i}${ext}`);
    }
    this.moveAcross(orig, dest, isDir);
    return `original moved to ${dest}`;
  }

  // ---- moving across filesystems ---------------------------------------------------------------------------
  // rename(2) cannot cross filesystems (EXDEV). Then the move is: copy everything, verify the copy, and only after
  // that remove the source. Any failure removes the partial copy and leaves the source exactly as it was.

  moveAcross(src, dest, isDir) {
    try { fs.lstatSync(dest); throw Object.assign(new Error('destination exists: ' + dest), { code: 'EEXIST' }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    try { fs.renameSync(src, dest); return; } catch (e) { if (!e || e.code !== 'EXDEV') throw e; }
    this.copyVerifyRemove(src, dest, isDir);
  }

  copyVerifyRemove(src, dest, isDir) {
    if (dest === src || dest.startsWith(src + path.sep)) throw new Error('the destination is inside the source');
    const st = fs.lstatSync(src);
    if (st.isSymbolicLink() || (isDir ? !st.isDirectory() : !st.isFile())) throw new Error('the source is not a plain ' + (isDir ? 'folder' : 'file'));
    let started = false; // true once WE created dest (exclusively), so only our own partial copy is ever cleaned up
    try {
      if (isDir) { fs.mkdirSync(dest); started = true; this.copyDirInto(src, dest, st); } else { this.copyFileExcl(src, dest, st); started = true; }
      this.verifyCopy(src, dest);
    } catch (e) {
      if (started) { try { fs.rmSync(dest, { recursive: true, force: true }); } catch (x) { /* nothing more to do */ } }
      throw e;
    }
    // The copy is complete and verified: only now is the source removed (rm never follows symlinks).
    if (isDir) fs.rmSync(src, { recursive: true }); else fs.unlinkSync(src);
  }

  copyFileExcl(s, d, st) {
    fs.copyFileSync(s, d, fs.constants.COPYFILE_EXCL);
    const fd = fs.openSync(d, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.utimesSync(d, st.atime, st.mtime);
  }

  copyDirInto(s, d, st) { // d exists (created by us); children first, then mode/times so a read-only folder can be filled
    for (const name of fs.readdirSync(s)) {
      const cs = path.join(s, name);
      const cd = path.join(d, name);
      const cst = fs.lstatSync(cs);
      if (cst.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(cs), cd); // copied as a link, never followed
      else if (cst.isDirectory()) { fs.mkdirSync(cd); this.copyDirInto(cs, cd, cst); }
      else if (cst.isFile()) this.copyFileExcl(cs, cd, cst);
      else throw new Error('unsupported file type: ' + cs);
    }
    fs.chmodSync(d, st.mode & 0o7777);
    fs.utimesSync(d, st.atime, st.mtime);
  }

  verifyCopy(s, d) { // same names, same types, same sizes, same link targets - checked against the source as it is NOW
    const a = fs.lstatSync(s);
    const b = fs.lstatSync(d);
    if (a.isSymbolicLink() || b.isSymbolicLink()) { if (!(a.isSymbolicLink() && b.isSymbolicLink() && fs.readlinkSync(s) === fs.readlinkSync(d))) throw new Error('verification failed: ' + s); return; }
    if (a.isDirectory() !== b.isDirectory() || a.isFile() !== b.isFile()) throw new Error('verification failed: ' + s);
    if (a.isFile()) { if (a.size !== b.size) throw new Error('verification failed (size): ' + s); return; }
    const an = fs.readdirSync(s).sort();
    const bn = fs.readdirSync(d).sort();
    if (an.length !== bn.length || an.some((n, i) => n !== bn[i])) throw new Error('verification failed (entries): ' + s);
    for (const n of an) this.verifyCopy(path.join(s, n), path.join(d, n));
  }

  // Freedesktop.org Trash specification: <data home>/Trash/files/<name> plus info/<name>.trashinfo.
  async trashFreedesktop(orig, isDir) {
    const dh = process.env.XDG_DATA_HOME;
    const trash = path.join(dh && path.isAbsolute(dh) ? dh : path.join(os.homedir(), '.local', 'share'), 'Trash');
    const files = path.join(trash, 'files');
    const info = path.join(trash, 'info');
    for (const d of [trash, files, info]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    const pad = (n) => String(n).padStart(2, '0');
    const t = new Date();
    const stamp = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
    const text = `[Trash Info]\nPath=${orig.split('/').map(encodeURIComponent).join('/')}\nDeletionDate=${stamp}\n`;
    const base = path.basename(orig);
    let name = base;
    let infoPath;
    for (let n = 2; ; n++) { // reserve a free name: the .trashinfo is created exclusively, existing Trash items are never overwritten
      infoPath = path.join(info, name + '.trashinfo');
      let free = true;
      try { fs.lstatSync(path.join(files, name)); free = false; } catch (e) { /* free */ }
      if (free) { try { fs.writeFileSync(infoPath, text, { flag: 'wx', mode: 0o600 }); break; } catch (e) { if (e.code !== 'EEXIST') throw e; } }
      if (n > 10000) throw new Error('too many items with this name in the Trash');
      name = `${base}.${n}`;
    }
    try { this.moveAcross(orig, path.join(files, name), isDir); } catch (e) { try { fs.unlinkSync(infoPath); } catch (x) { /* none */ } throw e; }
    return `original moved to the Trash (${path.join(files, name)})`;
  }

  // Would moving `real` into the trash destination cross filesystems? (the destination is the vault's .trash, or the home Trash)
  otherDevice(real, mode) {
    try {
      let dest = this.base;
      if (mode === 'system') {
        const dh = process.env.XDG_DATA_HOME;
        dest = path.join(dh && path.isAbsolute(dh) ? dh : path.join(os.homedir(), '.local', 'share'), 'Trash');
        while (!fs.existsSync(dest)) dest = path.dirname(dest);
      }
      return fs.statSync(real).dev !== fs.statSync(dest).dev;
    } catch (e) { return false; }
  }

  // A child of a linked folder whose original lives on another filesystem than the trash destination: Obsidian's native
  // flow cannot move it, so the same policy routine is applied to the real file/folder. Returns true when handled.
  async trashLinkedChild(file, mode, info) {
    const entry = this.tracked.get(info.root);
    if (!entry || !entry.dir) return false;
    const abs = path.join(this.base, file.path);
    let real;
    let st;
    let rootReal;
    try {
      real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
      rootReal = fs.realpathSync(entry.target);
      st = fs.lstatSync(real);
    } catch (e) { return false; }
    // it must really be inside the recorded original (this also rules out a re-pointed link or a nested symlink), and plain
    if (!real.startsWith(rootReal + path.sep) || st.isSymbolicLink() || !(st.isFile() || st.isDirectory()) || !this.safeToDelete(real)) return false;
    if (!this.otherDevice(real, mode)) return false;
    let how;
    try { how = await this.applyTrashPolicy(real, mode, st.isDirectory()); } catch (e) {
      this.warn(`trash ${file.path}: ${errText(e)}; nothing was changed`);
      new Notice(`${PLUGIN_TITLE}: could not trash the original (${e.code || errText(e)}). Nothing was deleted.`, 8000);
      return true;
    }
    await this.reconcilePath('del', file.path);
    this.info(`delete ${file.path} [${mode}, other filesystem]: ${how}`);
    return true;
  }

  electronShell() { try { return require('electron').shell || null; } catch (e) { return null; } }

  async trashSystemItem(p) {
    try {
      const shell = this.electronShell();
      if (!shell || typeof shell.trashItem !== 'function') return false;
      await shell.trashItem(p);
      return true;
    } catch (e) { this.debug('system trash failed: ' + errText(e)); return false; }
  }

  dropHidden(rootRel) {
    for (const h of [...this.hidden]) if (h === rootRel || h.startsWith(rootRel + '/')) this.hidden.delete(h);
  }

  patchDeletion() {
    const self = this;
    const wrap = (obj, name, make) => {
      const orig = obj && obj[name];
      if (typeof orig !== 'function') return;
      const own = Object.prototype.hasOwnProperty.call(obj, name);
      const fn = make((...a) => orig.apply(obj, a));
      obj[name] = fn;
      this.register(() => { if (obj[name] === fn) { if (own) obj[name] = orig; else delete obj[name]; } });
    };
    // The linked ROOT is handled here, and so is a child whose original is on another filesystem than the trash
    // destination (native Obsidian cannot move that). Everything else goes to Obsidian's native trash / delete unchanged.
    wrap(this.app.vault, 'trash', (orig) => async (file, system, ...rest) => {
      const info = file && self.linkRootOf(file.path);
      if (info && info.isRoot) return self.deleteLinkedRoot(file, system ? 'system' : 'local');
      if (info && await self.trashLinkedChild(file, system ? 'system' : 'local', info)) return undefined;
      return orig(file, system, ...rest);
    });
    wrap(this.app.vault, 'delete', (orig) => (file, ...rest) => {
      const info = file && self.linkRootOf(file.path);
      return info && info.isRoot ? self.deleteLinkedRoot(file, 'permanent') : orig(file, ...rest);
    });
    // Safety net: a direct destructive adapter call on the root symlink itself would move the symlink or recurse through it.
    for (const name of ['rmdir', 'remove', 'trashLocal', 'trashSystem']) {
      wrap(this.app.vault.adapter, name, (orig) => (p, ...rest) => {
        const info = self.linkRootOf(p);
        if (info && info.isRoot) { self.warn(`refused adapter.${name} on the linked root ${p}`); return Promise.resolve(false); }
        return orig(p, ...rest);
      });
    }
  }

  // Obsidian renamed a path. Only the rename of a tracked ROOT link (flat External/<old> -> External/<new>) is of
  // interest: the original is renamed too and the link re-pointed. Anything ambiguous leaves the original alone.
  onRename(file, oldPath) {
    try {
      const entry = this.tracked.get(oldPath);
      const newRel = file && file.path;
      if (!entry || !this.isExternal(newRel) || newRel === oldPath) return;
      const oldLink = this.abs(oldPath);
      const newLink = this.abs(newRel);
      if (!oldLink || !newLink) return;
      const name = path.basename(newRel);
      const keep = (why) => { // original untouched: just keep tracking the link under its new name
        this.tracked.delete(oldPath);
        this.tracked.set(newRel, Object.assign({}, entry, { gone: null, restored: false }));
        this.moveHidden(oldPath, newRel);
        this.syncSeen = new Map();
        this.persist();
        this.warn(`rename ${oldPath} -> ${newRel}: ${why}; the original was not renamed`);
        new Notice(`${PLUGIN_TITLE}: only the temporary link was renamed (${why}). The original is unchanged.`, 8000);
      };
      // Unambiguous? the old link is gone, the new one is a symlink to exactly the recorded original.
      let gone = false;
      try { fs.lstatSync(oldLink); } catch (e) { gone = e.code === 'ENOENT'; }
      if (!gone) return;
      let linkTarget;
      try {
        if (!fs.lstatSync(newLink).isSymbolicLink()) return;
        linkTarget = path.resolve(path.dirname(newLink), fs.readlinkSync(newLink));
      } catch (e) { return; }
      const orig = path.resolve(entry.target);
      if (linkTarget !== orig) return;
      let st;
      try { st = fs.lstatSync(orig); } catch (e) { return keep('the original is missing'); }
      if (st.isSymbolicLink() || (entry.dir ? !st.isDirectory() : !st.isFile())) return keep('the original is not a plain ' + (entry.dir ? 'folder' : 'file'));
      if (!name || name === '.' || name === '..') return keep('invalid name');
      const newOrig = path.join(path.dirname(orig), name);
      if (newOrig === orig) { // same name as the original: only the link name changed
        this.tracked.delete(oldPath);
        this.tracked.set(newRel, Object.assign({}, entry, { gone: null, restored: false }));
        this.moveHidden(oldPath, newRel);
        this.persist();
        return;
      }
      try { fs.lstatSync(newOrig); return keep(`${newOrig} already exists`); } catch (e) { if (e.code !== 'ENOENT') return keep('cannot check the new name'); }
      try { fs.renameSync(orig, newOrig); } catch (e) { return keep('renaming the original failed: ' + (e.code || errText(e))); }
      const tmp = newLink + '.oa-tmp-' + process.pid;
      try {
        fs.symlinkSync(newOrig, tmp);
        fs.renameSync(tmp, newLink); // atomically replaces the old symlink
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (x) { /* none */ }
        try { fs.renameSync(newOrig, orig); } catch (x) { this.err(`could not undo renaming ${orig}: ${errText(x)}`); }
        return keep('re-pointing the link failed: ' + (e.code || errText(e)));
      }
      this.tracked.delete(oldPath);
      this.tracked.set(newRel, Object.assign({}, entry, { target: newOrig, gone: null, restored: false, warned: false }));
      this.moveHidden(oldPath, newRel);
      this.syncSeen = new Map();
      this.persist();
      this.info(`renamed original ${orig} -> ${newOrig}; ${newRel} now tracks it`);
      new Notice(`${PLUGIN_TITLE}: renamed the original to ${newOrig}`);
    } catch (e) {
      this.err('root rename handling failed: ' + errText(e));
    }
  }

  moveHidden(oldRoot, newRoot) {
    for (const h of [...this.hidden]) {
      if (h === oldRoot || h.startsWith(oldRoot + '/')) { this.hidden.delete(h); this.hidden.add(newRoot + h.slice(oldRoot.length)); }
    }
  }

  // ---- stale explorer entries ------------------------------------------------------------------------------
  // Obsidian's cached file list can still show a linked root whose symlink was removed (e.g. at the last shutdown).
  // Roots only (depth 2): anything below a root that is missing is dropped together with it.

  async purgeStale() {
    let loaded;
    try { loaded = this.app.vault.getAllLoadedFiles(); } catch (e) { return 0; }
    const under = this.extDir + '/';
    let n = 0;
    for (const f of loaded) {
      const p = f && f.path;
      if (typeof p !== 'string' || !p.startsWith(under) || p.split('/').length !== 2) continue;
      let missing = false;
      try { fs.lstatSync(path.join(this.base, p)); } catch (e) { missing = e.code === 'ENOENT'; }
      if (missing && !this.queue.size && await this.reconcilePath('del', p)) { n++; this.debug(`dropped stale explorer entry ${p}`); }
    }
    return n;
  }

  dropFromIndex(rel) {
    Promise.resolve().then(() => this.reconcilePath('del', rel)).catch(() => {});
  }

  // ---- settings: selected vault / external directory ---------------------------------------------------------

  updateConfig(patch) {
    const { file, cfg } = this.readConfig();
    if (!cfg) return false;
    try {
      Object.assign(cfg, patch);
      const tmp = file + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
      fs.renameSync(tmp, file);
      this.cfg = cfg;
      return true;
    } catch (e) {
      this.warn('could not update config.json: ' + errText(e));
      return false;
    }
  }

  // Name (directly inside the vault) or an absolute folder picked in a dialog.
  async applyExternalDir(input) {
    const fail = (msg) => ({ ok: false, msg });
    let v = String(input || '').trim().replace(/\/+$/, '');
    const vaultPath = (this.cfg && typeof this.cfg.vaultPath === 'string' && this.cfg.vaultPath) || this.base;
    if (path.isAbsolute(v)) {
      if (!sameFile(path.dirname(v), vaultPath)) return fail(`The external directory must be a folder directly inside the vault (${vaultPath}).`);
      v = path.basename(v);
    }
    if (!validExtName(v)) return fail('Invalid folder name: use a plain name without slashes, not starting with a dot.');
    if (v === this.extDir) return { ok: true, msg: `Already using ${v}.` };
    if (this.tracked.size && !this.queue.size) this.cleanupOrphans(); // closed leftovers (e.g. from the last session) must not block the change
    if (this.tracked.size || this.queue.size) return fail(`${this.tracked.size} linked item(s) are still open or pending. Close them (or run Cleanup Orphaned Links) and try again.`);
    try {
      const st = fs.lstatSync(path.join(this.base, v));
      if (st.isSymbolicLink() || !st.isDirectory()) return fail(`${v} exists but is not a plain folder.`);
    } catch (e) { if (e.code !== 'ENOENT') return fail('Cannot check ' + v + ': ' + errText(e)); }
    try { fs.mkdirSync(path.join(this.base, v), { recursive: true }); } catch (e) { return fail('Cannot create ' + v + ': ' + errText(e)); }
    if (!this.updateConfig({ externalDir: v })) return fail('Could not write config.json (run ./install.sh first?).');
    this.extDir = v;
    this.root = path.join(this.base, v);
    this.syncSeen = new Map();
    return { ok: true, msg: `Links are now created in ${v}/. The old folder is left as it is.` };
  }

  // Copy the plugin into another vault so requests sent there are picked up. Never touches data.json or other plugins.
  installInto(vault) {
    const dest = path.join(vault, '.obsidian', 'plugins', this.manifest.id);
    try {
      fs.mkdirSync(path.join(dest, REQUEST_DIR), { recursive: true });
      for (const f of ['main.js', 'manifest.json', 'icon.png']) {
        const src = path.join(this.pluginDirAbs, f);
        if (!fs.existsSync(src)) { if (f === 'icon.png') continue; return { ok: false, msg: `${src} is missing` }; }
        const tmp = path.join(dest, f + '.tmp-' + process.pid);
        fs.copyFileSync(src, tmp);
        fs.renameSync(tmp, path.join(dest, f));
      }
    } catch (e) { return { ok: false, msg: 'Could not install the plugin into that vault: ' + errText(e) }; }
    let enabled = false;
    const list = path.join(vault, '.obsidian', 'community-plugins.json');
    try {
      let arr = [];
      try { arr = JSON.parse(fs.readFileSync(list, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (Array.isArray(arr) && arr.every((x) => typeof x === 'string')) {
        if (!arr.includes(this.manifest.id)) { arr.push(this.manifest.id); fs.writeFileSync(list, JSON.stringify(arr, null, 2)); }
        enabled = true;
      }
    } catch (e) { /* reported below */ }
    return { ok: true, enabled };
  }

  async applyVaultPath(input) {
    const fail = (msg) => ({ ok: false, msg });
    let v = String(input || '').trim();
    if (v === '~' || v.startsWith('~/')) v = path.join(os.homedir(), v.slice(1));
    if (!v || !path.isAbsolute(v)) return fail('Enter an absolute path to the vault folder.');
    v = path.resolve(v);
    try { if (!fs.statSync(path.join(v, '.obsidian')).isDirectory()) throw new Error('x'); } catch (e) { return fail('Not an Obsidian vault (no .obsidian folder). Open it once in Obsidian first.'); }
    const cur = this.cfg && typeof this.cfg.vaultPath === 'string' ? this.cfg.vaultPath : '';
    if (cur && sameFile(v, cur)) return { ok: true, msg: 'That vault is already selected.' };
    let enabled = true;
    if (!sameFile(v, this.base)) {
      const r = this.installInto(v);
      if (!r.ok) return fail(r.msg);
      enabled = r.enabled;
    }
    const known = Array.isArray(this.cfg && this.cfg.knownVaults) ? this.cfg.knownVaults.filter((x) => typeof x === 'string') : [];
    for (const x of [cur, this.base, v]) if (x && !known.some((k) => sameFile(k, x))) known.push(x);
    if (!this.updateConfig({ vaultPath: v, vaultId: '', pluginDir: path.join(v, '.obsidian', 'plugins', this.manifest.id), knownVaults: known })) {
      return fail('Could not write config.json (run ./install.sh first?).');
    }
    return { ok: true, msg: `The opener now targets ${v}. Open that vault in Obsidian` + (enabled ? '.' : ' and enable the plugin (its community-plugins.json could not be updated).') };
  }

  // ---- changes made OUTSIDE Obsidian inside a linked folder --------------------------------------------------
  // Obsidian may not notice files added, removed or renamed behind a symlinked folder. Compare the original
  // folder with Obsidian's own index and tell Obsidian about the differences (feature-detected, undocumented
  // adapter hooks; failures are harmless). This never writes to the filesystem.

  // Bounded walk (dot entries skipped like Obsidian does). Nested symlinks are listed but never entered.
  walkFolder(absRoot, relRoot) {
    const dirs = new Set();
    const files = new Set();
    const opaque = [];
    let complete = true;
    let count = 0;
    const stack = [[absRoot, relRoot]];
    while (stack.length) {
      const [dir, rel] = stack.pop();
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { complete = false; continue; }
      for (const e of ents) {
        if (e.name.startsWith('.')) continue;
        if (++count > this.timing.folderMaxEntries) return { dirs, files, opaque, complete: false, tooBig: true };
        const r = rel + '/' + e.name;
        const a = path.join(dir, e.name);
        let isDir = e.isDirectory();
        if (e.isSymbolicLink()) {
          try { isDir = fs.statSync(a).isDirectory(); } catch (x) { isDir = false; }
          if (isDir) opaque.push(r);
        }
        if (isDir) { dirs.add(r); if (!e.isSymbolicLink()) stack.push([a, r]); } else files.add(r);
      }
    }
    return { dirs, files, opaque, complete, tooBig: false };
  }

  async reconcilePath(kind, p) {
    const a = this.app.vault.adapter;
    const real = path.resolve(this.base, p);
    let call = null;
    if (kind === 'dir' && typeof a.reconcileFolderCreation === 'function') call = () => a.reconcileFolderCreation(real, p);
    else if (kind === 'file' && typeof a.reconcileFileInternal === 'function') call = () => a.reconcileFileInternal(real, p);
    else if (kind === 'file' && typeof a.reconcileFile === 'function') call = () => a.reconcileFile(p, real);
    else if (kind === 'del' && typeof a.reconcileDeletion === 'function') call = () => a.reconcileDeletion(real, p);
    if (!call) return false;
    try { await this.within(call(), 'reconcile'); return true; } catch (e) { this.debug(`folder sync ${kind} ${p} failed: ${errText(e)}`); return false; }
  }

  // manual=true acts on every difference right away (command); otherwise a difference must be seen on two
  // consecutive passes, so Obsidian's own create/delete handling for changes made inside Obsidian is never raced.
  async syncFolders(manual) {
    const out = { added: 0, removed: 0, roots: 0, unsupported: false };
    if (this.syncing || !this.ready || this.quitting) return out;
    const roots = [...this.tracked].filter(([, e]) => e.dir);
    if (!roots.length) { this.syncSeen = new Map(); return out; }
    this.syncing = true;
    try {
      const a = this.app.vault.adapter;
      out.unsupported = !['reconcileFolderCreation', 'reconcileFileInternal', 'reconcileFile', 'reconcileDeletion'].some((n) => typeof a[n] === 'function');
      const loaded = new Set(this.app.vault.getAllLoadedFiles().map((f) => f.path));
      const acts = [];
      for (const [rel, entry] of roots) {
        const abs = this.abs(rel);
        if (!abs) continue;
        try { // only a root that is still exactly our link, with its original present
          if (!fs.lstatSync(abs).isSymbolicLink()) continue;
          if (path.resolve(path.dirname(abs), fs.readlinkSync(abs)) !== path.resolve(entry.target)) continue;
          if (!fs.statSync(abs).isDirectory()) continue;
        } catch (e) { continue; }
        const w = this.walkFolder(abs, rel);
        if (w.tooBig) {
          if (!entry.tooBig) { entry.tooBig = true; this.warn(`${rel}: more than ${this.timing.folderMaxEntries} entries; external changes are not watched (use Refresh Linked Folders)`); }
          continue;
        }
        out.roots++;
        const under = rel + '/';
        for (const h of [...this.hidden]) if (h.startsWith(under) && !fs.existsSync(path.join(this.base, h))) this.hidden.delete(h); // original gone: nothing left to hide
        const isHidden = (p) => { for (const h of this.hidden) if (p === h || p.startsWith(h + '/')) return true; return false; };
        // Act only on the TOPMOST changed folder/file: Obsidian handles a folder's descendants together with it.
        const topmost = (p, set) => { for (let q = path.posix.dirname(p); q.length > rel.length; q = path.posix.dirname(q)) if (set.has(q)) return false; return true; };
        const addDirs = new Set([...w.dirs].filter((p) => !loaded.has(p) && !isHidden(p)));
        for (const p of addDirs) if (topmost(p, addDirs)) acts.push(['add', 'dir', p]);
        for (const p of w.files) if (!loaded.has(p) && !isHidden(p) && topmost(p, addDirs)) acts.push(['add', 'file', p]);
        if (w.complete) { // deletions are only reported after a complete walk
          const dels = new Set();
          for (const p of loaded) {
            if (p.startsWith(under) && !w.dirs.has(p) && !w.files.has(p) && !w.opaque.some((o) => p.startsWith(o + '/'))) dels.add(p);
          }
          for (const p of dels) if (topmost(p, dels)) acts.push(['del', 'del', p]);
        }
      }
      const depth = (p) => p.split('/').length;
      const rank = { del: 0, dir: 1, file: 2 };
      acts.sort((x, y) => (rank[x[1]] - rank[y[1]]) || (x[0] === 'del' ? depth(y[2]) - depth(x[2]) : depth(x[2]) - depth(y[2])));
      const nextSeen = new Map();
      for (const [op, kind, p] of acts) {
        const key = kind + ':' + p;
        const n = (this.syncSeen.get(key) || 0) + 1;
        nextSeen.set(key, n);
        if (!manual && n !== 2) continue;
        if (this.quitting) break;
        if (await this.reconcilePath(kind, p)) { if (op === 'add') out.added++; else out.removed++; this.debug(`folder sync: ${kind === 'del' ? 'removed' : 'added'} ${p} in Obsidian's index`); }
      }
      this.syncSeen = nextSeen;
    } catch (e) {
      this.err('folder sync failed: ' + errText(e));
    } finally {
      this.syncing = false;
    }
    return out;
  }

  // ---- explicit recovery (commands / diagnostics) --------------------------------------------------------------

  // Remove one tracked symlink right now if - and only if - it is still exactly the link we created.
  unlinkTracked(rel, entry) {
    const abs = this.abs(rel);
    if (!abs) return 'skipped: invalid path';
    let st;
    try { st = fs.lstatSync(abs); } catch (e) {
      if (e.code === 'ENOENT') { this.tracked.delete(rel); return 'gone'; }
      return 'skipped: ' + e.code;
    }
    if (!st.isSymbolicLink()) return 'skipped: not a symlink';
    let actual;
    try { actual = path.resolve(path.dirname(abs), fs.readlinkSync(abs)); } catch (e) { return 'skipped: unreadable'; }
    if (actual !== path.resolve(entry.target)) return 'skipped: retargeted';
    try { fs.unlinkSync(abs); } catch (e) { return 'skipped: ' + (e.code || 'error'); }
    this.tracked.delete(rel);
    this.dropHidden(rel);
    this.dropFromIndex(rel);
    return 'removed';
  }

  cleanupOrphans() {
    const out = { removed: 0, skipped: 0 };
    const pend = this.pendingRels();
    for (const [rel, entry] of [...this.tracked]) {
      const row = this.inspect(rel, entry, pend);
      const dangling = row.status === 'BROKEN' && row.linkIsOurs;
      if ((row.status === 'CLOSED' || dangling) && !row.leaves && !pend.has(rel)) {
        const r = this.unlinkTracked(rel, entry);
        if (r === 'removed') { out.removed++; this.debug('orphan cleanup removed ' + rel); } else if (r !== 'gone') out.skipped++;
      } else if (row.status !== 'OPEN' && row.status !== 'PENDING') {
        out.skipped++;
      }
    }
    this.persist();
    return out;
  }

  // Drop a tracking record. A BROKEN entry whose symlink is still exactly the (dead) link we created is
  // removed with it; a retargeted or replaced path is never touched.
  forget(rel) {
    const entry = this.tracked.get(rel);
    if (!entry) return 'not tracked';
    let note = 'tracking record dropped';
    const row = this.inspect(rel, entry, this.pendingRels());
    if (row.status === 'BROKEN' && row.linkIsOurs && !row.leaves) {
      const r = this.unlinkTracked(rel, entry);
      if (r === 'removed') note = 'dead symlink removed and tracking record dropped';
    }
    this.tracked.delete(rel);
    this.persist();
    this.info(`forgot ${rel}: ${note}`);
    return note;
  }

  discardPending() {
    let n = 0;
    for (const item of [...this.queue.values()]) {
      // The opener made this link for the request; hand it to normal cleanup instead of leaking it.
      if (item.kind === 'external' && item.target && this.linkMatches(item.rel, item.target)) this.track(item.rel);
      this.queue.delete(item.id);
      this.markDone(item.id);
      this.dropRecord(item.id);
      n++;
    }
    try {
      for (const name of fs.readdirSync(this.reqDir)) {
        const m = /^request-(.+)\.json$/.exec(name);
        if (m && ID_RE.test(m[1])) { try { fs.unlinkSync(path.join(this.reqDir, name)); n++; } catch (e) { /* ignore */ } }
      }
    } catch (e) { /* no directory */ }
    this.persist();
    return n;
  }

  // ---- diagnostics -------------------------------------------------------------------------------------------------

  pendingRels() {
    const s = new Set();
    for (const item of this.queue.values()) s.add(item.rel);
    for (const rel of this.opening.keys()) s.add(rel);
    return s;
  }

  inspect(rel, entry, pending) {
    const row = { rel, target: entry.target, status: 'CLOSED', detail: '', leaves: 0, linkIsOurs: false };
    const abs = this.abs(rel);
    if (!abs) { row.status = 'BROKEN'; row.detail = 'invalid tracked path'; return row; }

    let lst = null;
    try { lst = fs.lstatSync(abs); } catch (e) { /* missing */ }
    let targetOk = false;
    try { const ts = fs.statSync(entry.target); targetOk = entry.dir ? ts.isDirectory() : ts.isFile(); } catch (e) { /* missing */ }
    try { row.leaves = this.leavesFor(rel, entry.dir).length; } catch (e) { row.leaves = 0; }

    if (!lst) {
      row.status = 'BROKEN';
      row.detail = targetOk ? 'symlink is missing, original exists (Repair can recreate it)' : 'symlink and original are both missing';
      return row;
    }
    if (!lst.isSymbolicLink()) {
      row.status = 'BROKEN';
      row.detail = 'a regular file or folder occupies this path; it is never touched';
      return row;
    }
    let actual = '';
    try { actual = path.resolve(path.dirname(abs), fs.readlinkSync(abs)); } catch (e) { /* unreadable */ }
    if (actual !== path.resolve(entry.target)) {
      row.status = 'RETARGETED';
      row.detail = 'symlink now points to ' + (actual || '(unreadable)') + '; left untouched';
      return row;
    }
    row.linkIsOurs = true;
    if (!targetOk) {
      row.status = 'BROKEN';
      row.detail = 'original file is missing';
      return row;
    }
    if (pending.has(rel)) row.status = 'PENDING';
    else if (row.leaves > 0) row.status = 'OPEN';
    else row.status = 'CLOSED';
    return row;
  }

  pendingList() {
    const now = Date.now();
    return [...this.queue.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((i) => ({
        id: i.id, kind: i.kind, rel: i.rel, target: i.target, source: i.source,
        ageMs: Math.max(0, now - i.requestedAt),
        state: !this.ready ? 'waiting for the workspace' : i.first ? 'waiting for Obsidian to see the file' : 'queued',
      }));
  }

  collectDiagnostics() {
    const pend = this.pendingRels();
    const rows = [...this.tracked]
      .map(([rel, entry]) => this.inspect(rel, entry, pend))
      .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    let openExternal = 0;
    this.app.workspace.iterateAllLeaves((leaf) => {
      try { if (this.leafFiles(leaf).some((f) => this.isExternal(f))) openExternal++; } catch (e) { /* mid-teardown */ }
    });
    const pending = this.pendingList();
    const count = (s) => rows.filter((r) => r.status === s).length;
    return {
      rows,
      pending,
      counts: {
        tracked: rows.length,
        openExternalTabs: openExternal,
        pending: pending.length,
        broken: count('BROKEN'),
        orphaned: count('CLOSED'),
        retargeted: count('RETARGETED'),
      },
    };
  }

  reportText(d) {
    const c = d.counts;
    const lines = [
      `${PLUGIN_TITLE} ${this.manifest.version} diagnostics`,
      '',
      `Tracked links: ${c.tracked}`,
      `Open external tabs: ${c.openExternalTabs}`,
      `Pending requests: ${c.pending}`,
      `Broken targets: ${c.broken}`,
      `Orphaned tracked links: ${c.orphaned}`,
    ];
    if (c.retargeted) lines.push(`Retargeted links: ${c.retargeted}`);
    lines.push('');
    for (const r of d.rows) {
      lines.push(r.rel, '-> ' + r.target, '-> ' + r.status + (r.detail ? ' (' + r.detail + ')' : ''), '');
    }
    return lines.join('\n');
  }

  // ---- installation status (settings tab) -----------------------------------------------------------------------------

  execFileText(cmd, args) {
    return new Promise((resolve) => {
      try {
        require('child_process').execFile(cmd, args, { timeout: 4000 }, (e, stdout) => resolve(e ? null : String(stdout).trim()));
      } catch (e) { resolve(null); }
    });
  }

  async getStatusItems() {
    this.refreshConfig();
    const items = [];
    const add = (key, label, state, detail) => items.push({ key, label, state, detail });
    const cfg = this.cfg;

    if (!cfg) {
      add('vault', 'Selected Vault', 'bad', 'No generated configuration found. Run ./install.sh from the project folder.');
    } else if (typeof cfg.vaultPath !== 'string' || !cfg.vaultPath) {
      add('vault', 'Selected Vault', 'bad', 'Configuration has no vault path. Run ./install.sh again.');
    } else if (!sameFile(cfg.vaultPath, this.base)) {
      add('vault', 'Selected Vault', 'warn', `${cfg.vaultPath} - the opener targets a different vault than this one (${this.base})`);
    } else {
      add('vault', 'Selected Vault', 'ok', cfg.vaultPath);
    }

    add('plugin', 'Plugin', 'ok', `v${this.manifest.version} loaded from ${this.pluginDirAbs}`);

    if (!cfg || !cfg.helperPath) {
      add('opener', 'Opener', 'bad', 'Opener path unknown. Run ./install.sh.');
    } else {
      try {
        fs.accessSync(cfg.helperPath, fs.constants.X_OK);
        add('opener', 'Opener', 'ok', cfg.helperPath);
      } catch (e) {
        add('opener', 'Opener', 'bad', `${cfg.helperPath} is missing or not executable. Run ./install.sh.`);
      }
    }

    if (!cfg || !cfg.desktopFile) {
      add('desktop', 'Desktop integration', 'bad', 'Desktop entry unknown. Run ./install.sh.');
    } else {
      try {
        const text = fs.readFileSync(cfg.desktopFile, 'utf8');
        const good = cfg.helperPath && text.includes(cfg.helperPath) && /^MimeType=.*text\/markdown/m.test(text);
        add('desktop', 'Desktop integration', good ? 'ok' : 'warn', good ? cfg.desktopFile : `${cfg.desktopFile} does not match the configured opener. Run ./install.sh.`);
      } catch (e) {
        add('desktop', 'Desktop integration', 'bad', `${cfg.desktopFile} not found. Run ./install.sh.`);
      }
    }

    const defaults = await Promise.all(MIME_TYPES.map((m) => this.execFileText('xdg-mime', ['query', 'default', m])));
    if (defaults.some((d) => d === null)) {
      add('mime', 'Markdown MIME association', 'warn', 'Could not run xdg-mime (is xdg-utils installed?).');
    } else if (defaults.every((d) => d === DESKTOP_ID)) {
      add('mime', 'Markdown MIME association', 'ok', MIME_TYPES.join(', ') + ' -> ' + DESKTOP_ID);
    } else {
      add('mime', 'Markdown MIME association', 'warn', MIME_TYPES.map((m, i) => `${m} -> ${defaults[i] || '(none)'}`).join('; '));
    }

    const handlerOk = this.protocolRegistered && this.watcherActive;
    let reqOk = false;
    try { fs.accessSync(this.reqDir, fs.constants.W_OK); reqOk = true; } catch (e) { /* missing */ }
    add('handler', 'Request handler', handlerOk && reqOk ? 'ok' : 'warn',
      `protocol handler ${this.protocolRegistered ? 'registered' : 'NOT registered'}; request watcher ${this.watcherActive ? 'active' : 'INACTIVE'}; ` +
      `request folder ${reqOk ? 'writable' : 'missing'}; ${this.queue.size} pending`);

    try {
      const st = fs.lstatSync(this.root);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        add('external', 'External directory', 'bad', this.extDir + '/ exists but is not a plain folder.');
      } else {
        fs.accessSync(this.root, fs.constants.W_OK);
        add('external', 'External directory', 'ok', `${this.root} (${fs.readdirSync(this.root).length} entries, ${this.tracked.size} tracked)`);
      }
    } catch (e) {
      add('external', 'External directory', 'warn', this.extDir + '/ does not exist yet; it is created on first use (or by Repair Installation).');
    }
    return items;
  }

  // Repair what the plugin can repair by itself; point to install.sh for the rest.
  async repairInstallation() {
    const did = [];
    try { fs.mkdirSync(this.root, { recursive: true }); did.push('External folder ok'); } catch (e) { did.push('External folder FAILED: ' + errText(e)); }
    try { fs.mkdirSync(this.reqDir, { recursive: true }); } catch (e) { /* reported by status */ }
    if (!this.watcherActive) { this.watcher = null; if (this.startSpoolWatcher()) did.push('request watcher restarted'); }
    const r = this.restoreTrackedLinks({});
    if (r.created) did.push(`${r.created} tracked link(s) recreated`);
    this.scanSpool();
    this.schedulePump(0);

    this.refreshConfig();
    const cfg = this.cfg;
    let mimeFixed = false;
    if (cfg && typeof cfg.desktopFile === 'string' && path.basename(cfg.desktopFile) === DESKTOP_ID && fs.existsSync(cfg.desktopFile)) {
      const defaults = await Promise.all(MIME_TYPES.map((m) => this.execFileText('xdg-mime', ['query', 'default', m])));
      if (defaults.every((d) => d !== null) && defaults.some((d) => d !== DESKTOP_ID)) {
        const ok = await this.execFileText('xdg-mime', ['default', DESKTOP_ID, ...MIME_TYPES]);
        if (ok !== null) { mimeFixed = true; did.push('Markdown association re-registered'); }
      }
    }

    const items = await this.getStatusItems();
    const systemBad = items.filter((i) => ['vault', 'opener', 'desktop', 'mime'].includes(i.key) && i.state !== 'ok');
    let msg = `${PLUGIN_TITLE}: ${did.join('; ') || 'nothing to repair in the plugin'}.`;
    if (systemBad.length) msg += ` Still needs attention: ${systemBad.map((i) => i.label).join(', ')} - run ./install.sh again (safe to repeat).`;
    else if (!mimeFixed && !did.length) msg = `${PLUGIN_TITLE}: installation looks healthy.`;
    return { msg, items };
  }

  // ---- commands ---------------------------------------------------------------------------------------------------------

  registerCommands() {
    this.addCommand({
      id: 'refresh-linked-folders',
      name: 'External Files: Refresh Linked Folders',
      callback: async () => {
        const r = await this.syncFolders(true);
        if (!r.roots) new Notice(`${PLUGIN_TITLE}: no linked folders to refresh.`);
        else if (r.unsupported) new Notice(`${PLUGIN_TITLE}: this Obsidian version does not expose the re-index hook; use the "Reload app without saving" command instead.`);
        else new Notice(`${PLUGIN_TITLE}: refreshed ${r.roots} folder(s): ${r.added} added, ${r.removed} removed in the file list.`);
      },
    });
    this.addCommand({
      id: 'cleanup-orphaned-links',
      name: 'External Files: Cleanup Orphaned Links',
      callback: () => {
        const r = this.cleanupOrphans();
        new Notice(`${PLUGIN_TITLE}: removed ${r.removed} orphaned link(s)` + (r.skipped ? `, ${r.skipped} need attention (see Diagnostics)` : '') + '.');
      },
    });
    this.addCommand({
      id: 'repair-tracked-links',
      name: 'External Files: Repair Tracked Links',
      callback: () => {
        const r = this.restoreTrackedLinks({});
        const bits = [`${r.created} recreated`, `${r.ok} intact`];
        if (r.retargeted) bits.push(`${r.retargeted} retargeted (untouched)`);
        if (r.missingTarget) bits.push(`${r.missingTarget} original(s) missing`);
        if (r.refused) bits.push(`${r.refused} blocked by a regular file`);
        new Notice(`${PLUGIN_TITLE}: ${bits.join(', ')}.`);
      },
    });
    this.addCommand({
      id: 'show-tracked-links',
      name: 'External Files: Show Tracked Links',
      callback: () => new InfoModal(this.app, this, 'tracked').open(),
    });
    this.addCommand({
      id: 'show-pending-requests',
      name: 'External Files: Show Pending Requests',
      callback: () => new InfoModal(this.app, this, 'pending').open(),
    });
    this.addCommand({
      id: 'diagnostics',
      name: 'External Files: Diagnostics',
      callback: () => new InfoModal(this.app, this, 'diagnostics').open(),
    });
  }

  iconUrl() {
    try {
      const rel = this.manifest.dir ? this.manifest.dir + '/icon.png' : path.posix.join(this.app.vault.configDir, 'plugins', this.manifest.id, 'icon.png');
      if (!fs.existsSync(path.join(this.base, rel))) return '';
      return this.app.vault.adapter.getResourcePath(rel);
    } catch (e) { return ''; }
  }
};

// ---- UI ---------------------------------------------------------------------------------------------------------------------

const STATUS_COLOR = {
  OPEN: 'var(--text-success)',
  CLOSED: 'var(--text-muted)',
  BROKEN: 'var(--text-error)',
  PENDING: 'var(--text-accent)',
  RETARGETED: 'var(--text-warning)',
  ok: 'var(--text-success)',
  warn: 'var(--text-warning)',
  bad: 'var(--text-error)',
};

function badge(parent, text, key) {
  const b = parent.createSpan({ text });
  b.style.fontWeight = '600';
  b.style.fontSize = 'var(--font-ui-smaller)';
  b.style.color = STATUS_COLOR[key] || 'var(--text-normal)';
  return b;
}

function titleWithIcon(parent, plugin, text) {
  const wrap = parent.createDiv();
  wrap.style.display = 'flex';
  wrap.style.alignItems = 'center';
  wrap.style.gap = '10px';
  const url = plugin.iconUrl();
  if (url) {
    const img = wrap.createEl('img', { attr: { src: url, alt: '' } });
    img.style.width = '32px';
    img.style.height = '32px';
    img.style.borderRadius = '8px';
  }
  const h = wrap.createEl('h2', { text });
  h.style.margin = '0';
  return wrap;
}

function ageText(ms) {
  if (ms < 1000) return '<1s';
  if (ms < 60000) return Math.round(ms / 1000) + 's';
  return Math.round(ms / 60000) + 'min';
}

class InfoModal extends Modal {
  constructor(app, plugin, mode) {
    super(app);
    this.plugin = plugin;
    this.mode = mode; // 'diagnostics' | 'tracked' | 'pending'
  }

  onOpen() {
    this.modalEl.style.maxWidth = '860px';
    this.render();
  }

  onClose() { this.contentEl.empty(); }

  render() {
    const { contentEl } = this;
    const p = this.plugin;
    contentEl.empty();
    const d = p.collectDiagnostics();
    const title = this.mode === 'tracked' ? 'Tracked links' : this.mode === 'pending' ? 'Pending requests' : 'Diagnostics';
    titleWithIcon(contentEl, p, `${PLUGIN_TITLE}: ${title}`);

    if (this.mode === 'diagnostics') {
      const c = d.counts;
      const box = contentEl.createDiv();
      box.style.margin = '12px 0';
      box.style.lineHeight = '1.6';
      const line = (label, n) => { const l = box.createDiv(); l.createSpan({ text: label + ': ' }); l.createEl('strong', { text: String(n) }); };
      line('Tracked links', c.tracked);
      line('Open external tabs', c.openExternalTabs);
      line('Pending requests', c.pending);
      line('Broken targets', c.broken);
      line('Orphaned tracked links', c.orphaned);
      if (c.retargeted) line('Retargeted links', c.retargeted);
    }

    if (this.mode !== 'pending') this.renderLinks(contentEl, d);
    if (this.mode !== 'tracked') this.renderPending(contentEl, d);

    const foot = contentEl.createDiv();
    foot.style.display = 'flex';
    foot.style.gap = '8px';
    foot.style.marginTop = '14px';
    foot.style.justifyContent = 'flex-end';
    foot.createEl('button', { text: 'Refresh' }).onclick = () => this.render();
    const copy = foot.createEl('button', { text: 'Copy report' });
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(p.reportText(p.collectDiagnostics())); new Notice('Report copied.'); } catch (e) { new Notice('Could not copy the report.'); }
    };
    foot.createEl('button', { text: 'Close', cls: 'mod-cta' }).onclick = () => this.close();
  }

  renderLinks(parent, d) {
    const p = this.plugin;
    if (this.mode === 'diagnostics') parent.createEl('h4', { text: 'Tracked links' });
    if (!d.rows.length) {
      parent.createDiv({ text: 'No tracked links. External files appear here while they are open.' }).style.color = 'var(--text-muted)';
      return;
    }
    const list = parent.createDiv();
    list.style.maxHeight = '45vh';
    list.style.overflowY = 'auto';
    for (const r of d.rows) {
      const row = list.createDiv();
      row.style.padding = '8px 0';
      row.style.borderBottom = '1px solid var(--background-modifier-border)';
      const top = row.createDiv();
      top.style.display = 'flex';
      top.style.justifyContent = 'space-between';
      top.style.gap = '8px';
      top.createEl('code', { text: r.rel }).style.wordBreak = 'break-all';
      badge(top, r.status, r.status);
      const t = row.createDiv({ text: '-> ' + r.target });
      t.style.color = 'var(--text-muted)';
      t.style.wordBreak = 'break-all';
      t.style.fontSize = 'var(--font-ui-smaller)';
      if (r.detail) {
        const dd = row.createDiv({ text: r.detail });
        dd.style.fontSize = 'var(--font-ui-smaller)';
        dd.style.color = STATUS_COLOR[r.status];
      }
      const actions = row.createDiv();
      actions.style.marginTop = '4px';
      actions.style.display = 'flex';
      actions.style.gap = '6px';
      const act = (text, fn) => { actions.createEl('button', { text }).onclick = () => { fn(); this.render(); }; };
      if (r.status === 'BROKEN') {
        if (r.detail.startsWith('symlink is missing')) act('Repair link', () => { p.restoreTrackedLinks({ only: r.rel }); });
        act('Forget', () => new Notice(`${PLUGIN_TITLE}: ${p.forget(r.rel)}.`));
      } else if (r.status === 'RETARGETED') {
        act('Stop tracking', () => { p.tracked.delete(r.rel); p.persist(); new Notice(`${PLUGIN_TITLE}: tracking dropped, nothing deleted.`); });
      } else if (r.status === 'CLOSED') {
        act('Remove link now', () => {
          const e = p.tracked.get(r.rel);
          const res = e ? p.unlinkTracked(r.rel, e) : 'not tracked';
          if (res === 'removed') p.persist();
          new Notice(`${PLUGIN_TITLE}: ${res}.`);
        });
      }
    }
  }

  renderPending(parent, d) {
    const p = this.plugin;
    parent.createEl('h4', { text: 'Pending requests' });
    if (!d.pending.length) {
      parent.createDiv({ text: 'No pending requests.' }).style.color = 'var(--text-muted)';
      return;
    }
    const list = parent.createDiv();
    list.style.maxHeight = '30vh';
    list.style.overflowY = 'auto';
    for (const q of d.pending) {
      const row = list.createDiv();
      row.style.padding = '6px 0';
      row.style.borderBottom = '1px solid var(--background-modifier-border)';
      const top = row.createDiv();
      top.createEl('code', { text: q.rel }).style.wordBreak = 'break-all';
      const meta = row.createDiv({ text: `${q.kind} - ${q.state} - ${ageText(q.ageMs)} old - via ${q.source} - ${q.id}` });
      meta.style.color = 'var(--text-muted)';
      meta.style.fontSize = 'var(--font-ui-smaller)';
      meta.style.wordBreak = 'break-all';
    }
    const b = parent.createEl('button', { text: 'Discard all pending requests' });
    b.style.marginTop = '8px';
    b.onclick = () => { const n = p.discardPending(); new Notice(`${PLUGIN_TITLE}: ${n} pending request record(s) discarded.`); this.render(); };
  }
}

// Folder picker. Uses Electron's native dialog when this Obsidian exposes it, else a hidden <input webkitdirectory>.
// Resolves to a path, null (cancelled) or undefined (this build cannot report paths: type the path instead).
async function pickFolder(title, defaultPath) {
  for (const mod of ['@electron/remote', 'electron']) {
    try {
      const m = require(mod);
      const dialog = (m && m.dialog) || (m && m.remote && m.remote.dialog);
      if (dialog && typeof dialog.showOpenDialog === 'function') {
        const r = await dialog.showOpenDialog({ title, defaultPath, properties: ['openDirectory', 'createDirectory'] });
        return r.canceled || !r.filePaths || !r.filePaths.length ? null : r.filePaths[0];
      }
    } catch (e) { /* try the next way */ }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('webkitdirectory', '');
    input.addEventListener('cancel', () => resolve(null));
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (!f) return resolve(null);
      let p = f.path;
      if (!p) { try { p = require('electron').webUtils.getPathForFile(f); } catch (e) { /* unavailable */ } }
      const rel = f.webkitRelativePath || '';
      if (!p || !rel) return resolve(undefined);
      resolve(p.slice(0, p.length - (rel.length - rel.split('/')[0].length)));
    });
    input.click();
  });
}

class AnywhereSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.token = 0;
  }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    containerEl.empty();
    titleWithIcon(containerEl, p, PLUGIN_TITLE).style.marginBottom = '8px';

    // Everything about the installation lives in one collapsible section.
    const details = containerEl.createEl('details');
    details.open = !!this.statusOpen;
    details.addEventListener('toggle', () => { this.statusOpen = details.open; });
    details.createEl('summary', { text: 'Status' }).style.cursor = 'pointer';
    this.statusEl = details.createDiv();
    this.renderStatus();

    new Setting(containerEl)
      .setName('Maintenance')
      .setDesc('Re-test the installation, repair it, or inspect tracked links, open external tabs and pending requests.')
      .addButton((b) => b.setButtonText('Run setup check').onClick(async () => {
        details.open = true;
        const items = await this.renderStatus();
        const bad = items.filter((i) => i.state !== 'ok');
        new Notice(bad.length ? `${PLUGIN_TITLE}: ${bad.length} item(s) need attention: ${bad.map((i) => i.label).join(', ')}.` : `${PLUGIN_TITLE}: all ${items.length} checks passed.`);
      }))
      .addButton((b) => b.setButtonText('Repair installation').onClick(async () => {
        const { msg } = await p.repairInstallation();
        new Notice(msg, 8000);
        this.renderStatus();
      }))
      .addButton((b) => b.setButtonText('Diagnostics').onClick(() => new InfoModal(this.app, p, 'diagnostics').open()));

    new Setting(containerEl).setName('Cleanup policy').setHeading();

    new Setting(containerEl)
      .setName('Remove symlink when the last tab closes')
      .setDesc('The temporary link is removed once no tab shows the file any more. The original file is never touched.')
      .addToggle((t) => t.setValue(p.settings.removeOnLastTabClose).onChange(async (v) => { p.settings.removeOnLastTabClose = v; await p.saveSettings(); }));

    new Setting(containerEl)
      .setName('Remove temporary links on normal shutdown')
      .setDesc('Tracked links are removed when Obsidian quits normally.')
      .addToggle((t) => t.setValue(p.settings.removeOnShutdown).onChange(async (v) => { p.settings.removeOnShutdown = v; await p.saveSettings(); }));

    new Setting(containerEl)
      .setName('Restore tracked links on startup')
      .setDesc('Recreate tracked links whose original still exists, so restored external tabs open again. Takes effect on the next start.')
      .addToggle((t) => t.setValue(p.settings.restoreOnStartup).onChange(async (v) => { p.settings.restoreOnStartup = v; await p.saveSettings(); }));

    new Setting(containerEl)
      .setName('Cleanup grace period')
      .setDesc('Seconds a link must stay unused before it is removed.')
      .addSlider((s) => s.setLimits(0.5, 30, 0.5).setValue(Math.min(30, p.settings.graceSeconds)).setDynamicTooltip()
        .onChange(async (v) => { p.settings.graceSeconds = v; await p.saveSettings(); }));

    new Setting(containerEl).setName('Logging').setHeading();

    new Setting(containerEl)
      .setName('Debug logging')
      .setDesc('Log every request and link removal (plugin and opener). Errors and warnings are always logged.')
      .addToggle((t) => t.setValue(p.settings.debugLogging).onChange(async (v) => {
        p.settings.debugLogging = v;
        await p.saveSettings();
        p.syncHelperDebug(v);
      }));

    new Setting(containerEl)
      .setName('Log file')
      .setDesc(p.logFile)
      .addButton((b) => b.setButtonText('Clear debug log').onClick(() => {
        const n = p.clearLog();
        new Notice(`${PLUGIN_TITLE}: ${n ? 'debug log cleared' : 'no log file to clear'}.`);
      }));
  }

  hide() { this.token++; }

  async renderStatus() {
    const my = ++this.token;
    const p = this.plugin;
    const items = await p.getStatusItems();
    if (my !== this.token || !this.statusEl) return items;
    this.statusEl.empty();
    const editable = {
      vault: {
        value: () => (p.cfg && p.cfg.vaultPath) || '',
        placeholder: '/path/to/vault',
        pick: () => pickFolder('Select the Obsidian vault', (p.cfg && p.cfg.vaultPath) || p.base),
        apply: (v) => p.applyVaultPath(v),
      },
      external: {
        value: () => path.join(p.base, p.extDir),
        placeholder: 'External',
        pick: () => pickFolder('Select the external directory (a folder directly inside the vault)', p.base),
        apply: (v) => p.applyExternalDir(v),
      },
    };
    for (const it of items) {
      const s = new Setting(this.statusEl).setName(it.label).setDesc(it.detail);
      badge(s.controlEl, it.state === 'ok' ? 'OK' : it.state === 'warn' ? 'CHECK' : 'MISSING', it.state);
      const ed = editable[it.key];
      if (!ed) continue;
      let text;
      s.addText((t) => { text = t; t.setPlaceholder(ed.placeholder).setValue(ed.value()); t.inputEl.style.width = '220px'; })
        .addButton((b) => b.setButtonText('Browse').onClick(async () => {
          const picked = await ed.pick();
          if (picked) text.setValue(picked);
          else if (picked === undefined) new Notice(`${PLUGIN_TITLE}: this Obsidian build cannot open a folder picker. Type the path instead.`, 6000);
        }))
        .addButton((b) => b.setButtonText('Apply').setCta().onClick(async () => {
          const r = await ed.apply(text.getValue());
          new Notice(`${PLUGIN_TITLE}: ${r.msg}`, 8000);
          this.renderStatus();
        }));
    }
    return items;
  }
}
