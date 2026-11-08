'use strict';
// Finds built tool packages and describes them as catalog "platforms" entries.
// Looks in tools/<id>/dist by default, or in any folder (e.g. a flat CI artifacts folder) via `distDir`.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PLATFORMS = {
  windows: { suffix: '-win-x64.zip', exec: (exe) => `${exe}.exe`, args: [] },
  // Unpacked Electron apps can't use the SUID chrome-sandbox helper, so run without it on Linux.
  linux: { suffix: '-linux-x64.zip', exec: (exe) => exe, args: ['--no-sandbox'] },
};

/** Package files are named "<ProductNameWithoutSpaces>-<version>-<os>-x64.zip" (see each tool's artifactName). */
const filePrefix = (pkg) => String((pkg.build && pkg.build.productName) || pkg.productName || pkg.name).replace(/\s+/g, '');

/** @returns {{version:string, platforms:object}|null}  null when nothing has been built */
function findBuiltAssets(id, urlFor, { distDir } = {}) {
  const dir = path.join(ROOT, 'tools', id);
  const pkgFile = path.join(dir, 'package.json');
  const dist = distDir || path.join(dir, 'dist');
  if (!fs.existsSync(pkgFile) || !fs.existsSync(dist)) return null;
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  const exe = (pkg.build && pkg.build.executableName) || pkg.name;
  const prefix = filePrefix(pkg);
  const files = fs.readdirSync(dist);
  const platforms = {};
  for (const [key, def] of Object.entries(PLATFORMS)) {
    const file = files.find((f) => f === `${prefix}-${pkg.version}${def.suffix}`);
    if (!file) continue;
    const full = path.join(dist, file);
    const buf = fs.readFileSync(full);
    platforms[key] = {
      url: urlFor(full, file),
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      size: buf.length,
      kind: 'zip',
      exec: def.exec(exe),
      ...(def.args.length ? { args: def.args } : {}),
    };
  }
  return Object.keys(platforms).length ? { version: pkg.version, platforms } : null;
}

module.exports = { findBuiltAssets, filePrefix, PLATFORMS };
