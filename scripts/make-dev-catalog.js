'use strict';
// Builds tiny stub tools (zip files with a launch script) + a catalog.dev.json pointing at them
// via file:// URLs, so the whole install/verify/launch/update flow can be tested offline.
//   node scripts/make-dev-catalog.js            -> version 0.1.0
//   node scripts/make-dev-catalog.js --version 0.2.0   -> to test the "Update" button
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { pathToFileURL } = require('url');
const { findBuiltAssets } = require('./tool-assets');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dev-catalog');
const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'catalog.json'), 'utf8'));
const vi = process.argv.indexOf('--version');
const version = vi > -1 ? process.argv[vi + 1] : '0.1.0';

fs.mkdirSync(OUT, { recursive: true });

const tools = base.tools.map((t) => {
  const bat = `@echo off\r\ntitle ${t.name} (dev stub)\r\necho ${t.name} v${version} - dev stub\r\necho This is a placeholder for the real tool.\r\npause\r\n`;
  const sh = `#!/bin/sh\necho "${t.name} v${version} - dev stub"\necho "This is a placeholder for the real tool."\nread _\n`;

  const mk = (name, entries) => {
    const zip = new AdmZip();
    for (const [file, content, mode] of entries) {
      zip.addFile(file, Buffer.from(content), '', mode || 0o644);
    }
    const file = path.join(OUT, `${t.id}-${version}-${name}.zip`);
    zip.writeZip(file);
    const buf = fs.readFileSync(file);
    return {
      url: pathToFileURL(file).href,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      size: buf.length,
      kind: 'zip',
    };
  };

  // Real built tool? Use it instead of the stub (served from disk via file://).
  const real = findBuiltAssets(t.id, (full) => pathToFileURL(full).href);
  if (real) return { ...t, version: real.version, platforms: real.platforms };

  return {
    ...t,
    version,
    platforms: {
      windows: { ...mk('win', [['run.bat', bat]]), exec: 'run.bat' },
      linux: { ...mk('linux', [['run.sh', sh, 0o755]]), exec: 'run.sh' },
    },
  };
});

fs.writeFileSync(path.join(OUT, 'catalog.dev.json'), JSON.stringify({ version: 1, tools }, null, 2));
console.log(`Dev catalog written (${tools.length} tools @ ${version}) -> ${path.join(OUT, 'catalog.dev.json')}`);
