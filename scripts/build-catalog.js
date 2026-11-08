'use strict';
// Builds the release catalog from the packages in a folder (CI: the merged release artifacts).
//   node scripts/build-catalog.js --artifacts artifacts --base-url https://github.com/<o>/<r>/releases/download/<tag> \
//        --out artifacts/catalog.json --require windows,linux
// Tool names, descriptions and colours come from catalog/catalog.json; versions, URLs, SHA-256 hashes, sizes and
// launch commands come from the real files, so the catalog can never disagree with what was actually built.
const fs = require('fs');
const path = require('path');
const { findBuiltAssets } = require('./tool-assets');

function buildCatalog({ template, artifactsDir, baseUrl, requirePlatforms = [] }) {
  if (!/^https:\/\//i.test(baseUrl || '')) throw new Error('--base-url must be an https:// URL');
  const base = baseUrl.replace(/\/+$/, '');
  const tools = template.tools.map((t) => {
    const built = findBuiltAssets(t.id, (_full, name) => `${base}/${encodeURIComponent(name)}`, { distDir: artifactsDir });
    if (!built) throw new Error(`No packages found for "${t.id}" in ${artifactsDir}`);
    for (const p of requirePlatforms) {
      if (!built.platforms[p]) throw new Error(`"${t.id}" has no ${p} package (found: ${Object.keys(built.platforms).join(', ')})`);
    }
    return { ...t, version: built.version, platforms: built.platforms };
  });
  return { version: 1, tools };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

if (require.main === module) {
  try {
    const artifactsDir = arg('--artifacts');
    const out = arg('--out');
    if (!artifactsDir || !out) throw new Error('usage: build-catalog.js --artifacts <dir> --base-url <https url> --out <file> [--require windows,linux]');
    const template = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'catalog.json'), 'utf8'));
    const catalog = buildCatalog({
      template,
      artifactsDir: path.resolve(artifactsDir),
      baseUrl: arg('--base-url'),
      requirePlatforms: (arg('--require') || '').split(',').filter(Boolean),
    });
    fs.writeFileSync(out, JSON.stringify(catalog, null, 2) + '\n');
    for (const t of catalog.tools) console.log(`${t.id} v${t.version}: ${Object.keys(t.platforms).join(', ')}`);
    console.log(`Catalog written to ${out}`);
  } catch (e) {
    console.error(`build-catalog: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { buildCatalog };
