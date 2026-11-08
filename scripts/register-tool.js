'use strict';
// Writes a built tool's download info (url, sha256, size, exec) into catalog/catalog.json.
//   node scripts/register-tool.js picture-converter --base-url https://github.com/<you>/<repo>/releases/download/pc-v0.1.0
// Upload the zips from tools/<id>/dist to that location first (or after - the hash is what matters).
const fs = require('fs');
const path = require('path');
const { findBuiltAssets } = require('./tool-assets');

const id = process.argv[2];
const bi = process.argv.indexOf('--base-url');
const base = bi > -1 ? process.argv[bi + 1] : null;
if (!id || !base || !/^https:\/\//.test(base)) {
  console.error('usage: node scripts/register-tool.js <tool-id> --base-url https://...');
  process.exit(1);
}

const file = path.join(__dirname, '..', 'catalog', 'catalog.json');
const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
const tool = catalog.tools.find((t) => t.id === id);
if (!tool) { console.error(`No tool "${id}" in catalog.json`); process.exit(1); }

const built = findBuiltAssets(id, (_full, name) => `${base.replace(/\/$/, '')}/${name}`);
if (!built) { console.error(`No built packages in tools/${id}/dist - build them first.`); process.exit(1); }

tool.version = built.version;
tool.platforms = built.platforms;
fs.writeFileSync(file, JSON.stringify(catalog, null, 2) + '\n');
console.log(`Registered ${id} v${built.version} for: ${Object.keys(built.platforms).join(', ')}`);
