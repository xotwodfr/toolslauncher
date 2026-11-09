'use strict';
// Finds a tool that Tools Launcher has installed (for "Edit tags in Audio Tagger"). The launcher records every installed
// tool in <data dir>/installed.json as { id: { version, exec } } and keeps the files in <data dir>/tools/<id>/<version>/.
// Electron-free (testable with plain Node). Anything that does not look exactly like that is ignored.
const fs = require('fs');
const path = require('path');

/**
 * @param {string[]} dataDirs  places the launcher may keep its data (release build, dev build)
 * @param {string} id          tool id, e.g. "audio-tagger"
 * @returns {{file: string, cwd: string}|null}
 */
function findInstalledTool(dataDirs, id) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return null;
  for (const dir of dataDirs) {
    try {
      const installed = JSON.parse(fs.readFileSync(path.join(dir, 'installed.json'), 'utf8'));
      const rec = installed && Object.prototype.hasOwnProperty.call(installed, id) ? installed[id] : null;
      if (!rec || typeof rec.version !== 'string' || typeof rec.exec !== 'string' || !rec.version || !rec.exec) continue;
      if (/[\/]/.test(rec.version) || rec.version === '.' || rec.version === '..') continue;
      const versionDir = path.join(dir, 'tools', id, rec.version);
      const file = path.resolve(versionDir, rec.exec);
      const back = path.relative(versionDir, file);
      if (!back || back.startsWith('..') || path.isAbsolute(back)) continue; // the executable must live inside its own version folder
      if (!fs.statSync(file).isFile()) continue;
      return { file, cwd: versionDir };
    } catch { /* not there, unreadable or damaged: try the next place */ }
  }
  return null;
}

module.exports = { findInstalledTool };
