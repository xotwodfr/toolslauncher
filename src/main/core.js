'use strict';
// Electron-free core logic so it can be unit-tested with plain Node.
// Inside Electron the normal `fs` treats *.asar files as virtual folders, which breaks installing other
// Electron apps (their resources/app.asar must be written as a plain file). `original-fs` has no asar
// magic. Plain Node (tests) has no such module, so fall back to `fs`.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');
const os = require('os');
const { pathToFileURL, fileURLToPath } = require('url');
const AdmZip = require('adm-zip');

function platformKey(p = process.platform) {
  if (p === 'win32') return 'windows';
  if (p === 'linux') return 'linux';
  return null; // unsupported (macOS etc.)
}

/** Compare dotted versions. Returns >0 if a>b, <0 if a<b, 0 if equal. */
function compareVersions(a, b) {
  const pa = String(a).split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function safeId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) {
    throw new Error(`Invalid tool id: ${id}`);
  }
  return id;
}

/** Resolve `child` inside `root`; throw if it escapes (zip-slip / path traversal). */
function resolveInside(root, child) {
  const full = path.resolve(root, child);
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes install directory: ${child}`);
  }
  return full;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(stripBom(await fsp.readFile(file, 'utf8')));
  } catch {
    return fallback;
  }
}

// Files saved by Notepad / PowerShell often start with a UTF-8 BOM, which JSON.parse rejects.
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}

const MAX_CATALOG_BYTES = 1024 * 1024;
const CATALOG_TIMEOUT_MS = 8000;

/** Fetch the raw catalog text from an http(s) URL, file:// URL or local path. */
async function readCatalogText(source, timeoutMs = CATALOG_TIMEOUT_MS) {
  let text;
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Catalog request failed: HTTP ${res.status}`);
    text = await res.text();
  } else {
    const file = source.startsWith('file:') ? fileURLToPath(source) : source;
    // The bundled catalog lives inside app.asar when packaged, so this read must use the asar-aware fs.
    text = await require('fs').promises.readFile(file, 'utf8');
  }
  if (text.length > MAX_CATALOG_BYTES) throw new Error('Catalog is too large');
  return stripBom(text);
}

const SHA256_RE = /^[0-9a-f]{64}$/i;
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * Parse + sanitise a catalog. A hosted catalog is untrusted input: anything that ends up in the UI or in an
 * install decision is validated here, and malformed tools/assets are dropped instead of failing the whole list.
 */
function parseCatalog(text) {
  const cat = JSON.parse(stripBom(text));
  if (!cat || !Array.isArray(cat.tools)) throw new Error('Catalog is malformed (no tools array)');
  const tools = [];
  for (const t of cat.tools) {
    if (!t || typeof t !== 'object') continue;
    try { safeId(t.id); } catch { continue; }
    const name = str(t.name, 60).trim();
    if (!name || t.version == null || !/^[0-9A-Za-z.+-]{1,32}$/.test(String(t.version))) continue;
    const platforms = {};
    for (const key of ['windows', 'linux']) {
      const a = t.platforms && t.platforms[key];
      if (!a || typeof a.url !== 'string' || a.url.length > 2048) continue;
      if (!SHA256_RE.test(String(a.sha256 || ''))) continue;
      const exec = str(a.exec, 260);
      if (!exec) continue;
      platforms[key] = {
        url: a.url,
        sha256: String(a.sha256).toLowerCase(),
        exec,
        kind: a.kind === 'file' ? 'file' : 'zip',
        args: Array.isArray(a.args) ? a.args.filter((x) => typeof x === 'string').slice(0, 16).map((x) => x.slice(0, 200)) : [],
        size: Number.isFinite(a.size) && a.size > 0 ? a.size : undefined,
      };
    }
    tools.push({
      id: t.id,
      name,
      description: str(t.description, 300),
      category: str(t.category, 30) || 'Tools',
      glyph: [...str(t.glyph, 8)].slice(0, 2).join('') || name.slice(0, 1),
      accent: /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(t.accent || '') ? t.accent : '#7c5cff',
      version: String(t.version),
      platforms,
    });
  }
  return { version: 1, tools };
}

/** Load a catalog from an http(s) URL, file:// URL or local path. */
async function loadCatalog(source, timeoutMs) {
  return parseCatalog(await readCatalogText(source, timeoutMs));
}

/**
 * Remote catalog -> last good cached copy -> catalog bundled with the app.
 * A successful remote fetch refreshes the cache, so the launcher keeps working offline.
 * Returns { catalog, source: 'remote'|'cache'|'bundled', remoteError }.
 */
async function loadCatalogChain({ remote, cacheFile, bundled, timeoutMs }) {
  let remoteError = null;
  if (remote) {
    try {
      const text = await readCatalogText(remote, timeoutMs);
      const catalog = parseCatalog(text);
      if (cacheFile) await writeJsonAtomic(cacheFile, JSON.parse(text)).catch(() => {});
      return { catalog, source: 'remote', remoteError: null };
    } catch (e) {
      remoteError = e;
    }
  }
  if (cacheFile) {
    try {
      return { catalog: parseCatalog(await fsp.readFile(cacheFile, 'utf8')), source: 'cache', remoteError };
    } catch { /* no usable cache */ }
  }
  return { catalog: await loadCatalog(bundled, timeoutMs), source: 'bundled', remoteError };
}

/**
 * Download `url` to `dest`, streaming, hashing as we go.
 * Supports http(s) and file://. Returns { sha256, bytes }.
 */
async function download(url, dest, onProgress) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  let bytes = 0;
  let total = 0;
  let readable;

  if (/^https?:\/\//i.test(url)) {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
    total = Number(res.headers.get('content-length')) || 0;
    readable = require('stream').Readable.fromWeb(res.body);
  } else {
    const file = url.startsWith('file:') ? fileURLToPath(url) : url;
    total = (await fsp.stat(file)).size;
    readable = fs.createReadStream(file);
  }

  // Write every chunk from our OWN COPY. Inside Electron the HTTP layer may reuse a chunk's memory once the
  // 'data' event returns, so piping the original buffer to an async write stream could write corrupted bytes
  // even though the hash (computed at arrival) looked right.
  const out = fs.createWriteStream(dest);
  const finished = new Promise((resolve, reject) => { out.once('finish', resolve); out.once('error', reject); });
  finished.catch(() => {}); // surfaced below; avoid an unhandled rejection if we bail out earlier
  try {
    for await (const chunk of readable) {
      const buf = Buffer.from(chunk);
      bytes += buf.length;
      if (!out.write(buf)) await Promise.race([once(out, 'drain'), finished]);
      if (onProgress) onProgress({ bytes, total });
    }
    out.end();
    await finished;
  } catch (err) {
    out.destroy();
    throw err;
  }
  if (total && bytes !== total) throw new Error(`Download incomplete (${bytes} of ${total} bytes)`);
  // Hash what is actually on disk: that is exactly what will be extracted and run.
  return { sha256: await hashFile(dest), bytes };
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

function extractZip(zipFile, destDir) {
  const zip = new AdmZip(zipFile);
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of zip.getEntries()) {
    const target = resolveInside(destDir, entry.entryName);
    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.getData());
      // Preserve executable bit on unix
      const mode = (entry.attr >>> 16) & 0o777;
      if (process.platform !== 'win32' && mode) fs.chmodSync(target, mode);
    }
  }
}

class Store {
  /** @param {string} dataDir  root dir holding tools/, installed.json, settings.json */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.toolsDir = path.join(dataDir, 'tools');
    this.installedFile = path.join(dataDir, 'installed.json');
    this.settingsFile = path.join(dataDir, 'settings.json');
  }

  async getInstalled() {
    return readJson(this.installedFile, {});
  }

  async getSettings(defaults = {}) {
    return { ...defaults, ...(await readJson(this.settingsFile, {})) };
  }

  async setSettings(patch, defaults = {}) {
    const next = { ...(await this.getSettings(defaults)), ...patch };
    await writeJsonAtomic(this.settingsFile, next);
    return next;
  }

  /**
   * Install (or update) a tool from its catalog entry.
   * Download -> verify SHA-256 -> extract -> record. Old versions are removed afterwards.
   */
  async install(tool, onProgress = () => {}, { allowLocal = false } = {}) {
    const id = safeId(tool.id);
    const key = platformKey();
    if (!key) throw new Error('This platform is not supported');
    const asset = tool.platforms && tool.platforms[key];
    if (!asset || !asset.url) throw new Error(`${tool.name} is not available for ${key} yet`);
    if (!asset.exec) throw new Error('Catalog entry has no "exec" path');
    if (!asset.sha256) throw new Error('Catalog entry has no sha256; refusing to install unverified download');
    // A catalog (especially a hosted one) must not be able to make the launcher read local files or use plain http.
    // file:// and local paths are only for the offline dev catalog.
    if (!allowLocal && !/^https:\/\//i.test(asset.url)) throw new Error('Only https:// download URLs are allowed');

    const kind = asset.kind || 'zip';
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'toolslauncher-'));
    const tmpFile = path.join(tmpDir, 'download.bin');
    const versionDir = path.join(this.toolsDir, id, String(tool.version));

    try {
      onProgress({ phase: 'download', bytes: 0, total: 0 });
      const { sha256 } = await download(asset.url, tmpFile, (p) => onProgress({ phase: 'download', ...p }));

      onProgress({ phase: 'verify' });
      if (sha256.toLowerCase() !== String(asset.sha256).toLowerCase()) {
        throw new Error('Checksum mismatch - download is corrupted or has been tampered with');
      }

      onProgress({ phase: 'install' });
      await fsp.rm(versionDir, { recursive: true, force: true });
      await fsp.mkdir(versionDir, { recursive: true });
      if (kind === 'zip') {
        extractZip(tmpFile, versionDir);
      } else {
        const target = resolveInside(versionDir, asset.exec);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.copyFile(tmpFile, target);
      }
      const execPath = resolveInside(versionDir, asset.exec);
      if (!fs.existsSync(execPath)) throw new Error(`Executable not found after install: ${asset.exec}`);
      if (process.platform !== 'win32') await fsp.chmod(execPath, 0o755);

      const installed = await this.getInstalled();
      const previous = installed[id];
      installed[id] = {
        version: String(tool.version),
        exec: asset.exec,
        args: asset.args || [],
        installedAt: new Date().toISOString(),
      };
      await writeJsonAtomic(this.installedFile, installed);

      // Remove older version folders
      if (previous && previous.version !== String(tool.version)) {
        await fsp.rm(path.join(this.toolsDir, id, previous.version), { recursive: true, force: true });
      }
      onProgress({ phase: 'done' });
      return installed[id];
    } catch (err) {
      await fsp.rm(versionDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async uninstall(idRaw) {
    const id = safeId(idRaw);
    const installed = await this.getInstalled();
    delete installed[id];
    await writeJsonAtomic(this.installedFile, installed);
    await fsp.rm(path.join(this.toolsDir, id), { recursive: true, force: true });
  }

  /** Absolute path + args to launch an installed tool. */
  async resolveLaunch(idRaw) {
    const id = safeId(idRaw);
    const rec = (await this.getInstalled())[id];
    if (!rec) throw new Error('Tool is not installed');
    const versionDir = path.join(this.toolsDir, id, rec.version);
    const file = resolveInside(versionDir, rec.exec);
    if (!fs.existsSync(file)) throw new Error('Installed files are missing; try reinstalling');
    return { file, args: rec.args || [], cwd: versionDir };
  }

  /** Merge catalog tools with installed state for the UI. */
  async buildLibrary(catalog) {
    const installed = await this.getInstalled();
    const key = platformKey();
    return catalog.tools.map((t) => {
      const rec = installed[t.id];
      const asset = key && t.platforms ? t.platforms[key] : null;
      const available = !!(asset && asset.url);
      let state = 'available';
      if (!available) state = 'unavailable';
      else if (rec) state = compareVersions(t.version, rec.version) > 0 ? 'update' : 'installed';
      return {
        id: t.id,
        name: t.name,
        description: t.description || '',
        category: t.category || 'Tools',
        glyph: t.glyph || t.name.slice(0, 1),
        accent: t.accent || '#7c5cff',
        version: String(t.version),
        installedVersion: rec ? rec.version : null,
        size: asset && asset.size ? asset.size : null,
        state,
      };
    });
  }
}

module.exports = {
  platformKey,
  compareVersions,
  safeId,
  resolveInside,
  loadCatalog,
  loadCatalogChain,
  parseCatalog,
  download,
  extractZip,
  Store,
  pathToFileURL,
};
