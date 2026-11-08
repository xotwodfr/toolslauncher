'use strict';
// Plain-Node tests for the launcher core (no Electron needed). Run: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { pathToFileURL } = require('url');
const core = require('../src/main/core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-test-'));
const key = core.platformKey();
let passed = 0;
const ok = (name) => { passed++; console.log('  ok  ' + name); };

// adm-zip sanitises names when writing, so hand-build a stored zip to get a real traversal entry.
function rawZip(entries) {
  const zlib = require('zlib');
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name);
    const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data);
    centrals.push(ch, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function makeTool(version, { badHash = false, evil = false } = {}) {
  const file = path.join(tmp, `t-${version}-${evil ? 'evil' : 'ok'}.zip`);
  if (evil) {
    fs.writeFileSync(file, rawZip([['../../escape.txt', Buffer.from('x')], ['run.bat', Buffer.from('@echo off\r\n')]]));
  } else {
    const zip = new AdmZip();
    zip.addFile('run.bat', Buffer.from('@echo off\r\n'));
    zip.writeZip(file);
  }
  const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const asset = { url: pathToFileURL(file).href, sha256: badHash ? '0'.repeat(64) : sha, exec: 'run.bat', kind: 'zip' };
  return { id: 'demo', name: 'Demo', version, platforms: { [key]: asset } };
}

(async () => {
  assert(key, 'tests need windows or linux');

  // versions
  assert(core.compareVersions('1.10.0', '1.9.0') > 0);
  assert(core.compareVersions('1.0', '1.0.0') === 0);
  assert(core.compareVersions('0.1.0', '0.2.0') < 0);
  ok('compareVersions');

  // id / path safety
  assert.throws(() => core.safeId('../x'));
  assert.throws(() => core.resolveInside(tmp, '../outside'));
  ok('safeId + resolveInside');

  const store = new core.Store(path.join(tmp, 'data'));

  // install
  const phases = [];
  const L = { allowLocal: true }; // test assets are file:// URLs (only allowed for the dev catalog)
  await store.install(makeTool('0.1.0'), (p) => phases.push(p.phase), L);
  assert(phases.includes('download') && phases.includes('verify') && phases.includes('done'));
  assert.strictEqual((await store.getInstalled()).demo.version, '0.1.0');
  const launch = await store.resolveLaunch('demo');
  assert(fs.existsSync(launch.file));
  ok('install + resolveLaunch');

  // library state
  let lib = await store.buildLibrary({ tools: [makeTool('0.1.0')] });
  assert.strictEqual(lib[0].state, 'installed');
  lib = await store.buildLibrary({ tools: [makeTool('0.2.0')] });
  assert.strictEqual(lib[0].state, 'update');
  ok('library states (installed/update)');

  // update removes old version dir
  await store.install(makeTool('0.2.0'), undefined, L);
  assert(!fs.existsSync(path.join(store.toolsDir, 'demo', '0.1.0')));
  assert(fs.existsSync(path.join(store.toolsDir, 'demo', '0.2.0')));
  ok('update replaces old version');

  // checksum mismatch rejected, previous install untouched
  await assert.rejects(() => store.install(makeTool('0.3.0', { badHash: true }), undefined, L), /Checksum mismatch/);
  assert.strictEqual((await store.getInstalled()).demo.version, '0.2.0');
  assert(!fs.existsSync(path.join(store.toolsDir, 'demo', '0.3.0')));
  ok('bad checksum rejected');

  // zip-slip rejected
  await assert.rejects(() => store.install(makeTool('0.4.0', { evil: true }), undefined, L), /escapes/);
  assert(!fs.existsSync(path.join(tmp, 'escape.txt')));
  ok('zip-slip rejected');

  // missing sha256 refused
  const noHash = makeTool('0.5.0');
  delete noHash.platforms[key].sha256;
  await assert.rejects(() => store.install(noHash, undefined, L), /sha256/);

  // a (hosted) catalog must not be able to point at local files or plain http
  const prevInstalled = (await store.getInstalled()).demo.version;
  await assert.rejects(() => store.install(makeTool('0.6.0')), /https/); // file:// without allowLocal
  const httpTool = makeTool('0.6.0'); httpTool.platforms[key].url = 'http://example.com/x.zip';
  await assert.rejects(() => store.install(httpTool), /https/);
  const localTool = makeTool('0.6.0'); localTool.platforms[key].url = 'C:\\Windows\\win.ini';
  await assert.rejects(() => store.install(localTool), /https/);
  assert.strictEqual((await store.getInstalled()).demo.version, prevInstalled);
  assert(!fs.existsSync(path.join(store.toolsDir, 'demo', '0.6.0')));
  ok('non-https / local download URLs refused (unless dev)');
  ok('unverified install refused');

  // unavailable platform
  lib = await store.buildLibrary({ tools: [{ id: 'x', name: 'X', version: '1', platforms: {} }] });
  assert.strictEqual(lib[0].state, 'unavailable');
  ok('unavailable tool state');

  // uninstall
  await store.uninstall('demo');
  assert.deepStrictEqual(await store.getInstalled(), {});
  assert(!fs.existsSync(path.join(store.toolsDir, 'demo')));
  ok('uninstall');

  // settings
  // a hand-edited settings file with a UTF-8 BOM must still be honoured
  fs.writeFileSync(store.settingsFile, '﻿{ "catalogUrl": "https://bom.example/c.json" }');
  assert.strictEqual((await store.getSettings({ catalogUrl: '' })).catalogUrl, 'https://bom.example/c.json');
  assert.strictEqual(core.parseCatalog('﻿{"tools":[]}').tools.length, 0);
  await store.setSettings({ catalogUrl: 'https://a.b/c.json' });
  assert.strictEqual((await store.getSettings({ checkUpdatesOnStart: true })).checkUpdatesOnStart, true);
  ok('settings persist + defaults');

  // ---- catalog parsing: a hosted catalog is untrusted input ----------------------------------------
  const goodSha = 'AB'.repeat(32);
  const parsed = core.parseCatalog(JSON.stringify({
    tools: [
      { id: 'ok', name: 'Fine', version: '1.2.3', accent: '#abc', glyph: '♪x-long', description: 'd'.repeat(999),
        platforms: { windows: { url: 'https://x/y.zip', sha256: goodSha, exec: 'a.exe', args: ['--ok', 5] }, linux: { url: 'https://x/z.zip', sha256: 'nothex', exec: 'a' } } },
      { id: '../evil', name: 'Bad id', version: '1' },
      { id: 'noname', name: '  ', version: '1' },
      { id: 'badver', name: 'Bad', version: '1; drop table' },
      { id: 'css', name: 'Css', version: '1', accent: 'red; background-image:url(https://evil/x)' },
      null, 'str', 42,
    ],
  }));
  assert.deepStrictEqual(parsed.tools.map((t) => t.id), ['ok', 'css']);
  const okTool = parsed.tools[0];
  assert.strictEqual(okTool.accent, '#abc');
  assert.strictEqual(okTool.description.length, 300);
  assert.strictEqual([...okTool.glyph].length, 2);
  assert.strictEqual(okTool.platforms.windows.sha256, goodSha.toLowerCase());
  assert.deepStrictEqual(okTool.platforms.windows.args, ['--ok']);
  assert(!okTool.platforms.linux, 'asset with an invalid sha256 is dropped');
  assert.strictEqual(parsed.tools[1].accent, '#7c5cff', 'css injection replaced by default colour');
  assert.throws(() => core.parseCatalog('{"nope":1}'), /malformed/);
  ok('catalog sanitising (ids, versions, colours, text length, bad assets)');

  // ---- remote -> cache -> bundled fallback ------------------------------------------------------
  const http = require('http');
  const catalogJson = JSON.stringify({ tools: [{ id: 'remote-tool', name: 'Remote', version: '9.9.9', platforms: {} }] });
  let mode = 'ok';
  const server = http.createServer((req, res) => {
    if (mode === 'ok') { res.setHeader('content-type', 'application/json'); res.end(catalogJson); }
    else if (mode === '404') { res.statusCode = 404; res.end('nope'); }
    else if (mode === 'junk') res.end('<html>not json</html>');
    else if (mode === 'hang') { /* never answer */ }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const remote = `http://127.0.0.1:${server.address().port}/catalog.json`;
  const cacheFile = path.join(tmp, 'cache', 'catalog-cache.json');
  const bundled = path.join(__dirname, '..', 'catalog', 'catalog.json');
  const chain = (extra = {}) => core.loadCatalogChain({ remote, cacheFile, bundled, timeoutMs: 400, ...extra });

  let r = await chain();
  assert.strictEqual(r.source, 'remote');
  assert.strictEqual(r.catalog.tools[0].id, 'remote-tool');
  assert(fs.existsSync(cacheFile), 'cache written after a good fetch');
  for (const m of ['404', 'junk']) {
    mode = m; r = await chain();
    assert.strictEqual(r.source, 'cache', `${m} -> cache`);
    assert.strictEqual(r.catalog.tools[0].id, 'remote-tool');
    assert(r.remoteError);
  }
  mode = 'hang';
  const t0 = Date.now(); r = await chain();
  assert.strictEqual(r.source, 'cache');
  assert(Date.now() - t0 < 3000, 'a stalled server must time out quickly');
  fs.rmSync(cacheFile);
  r = await chain();
  assert.strictEqual(r.source, 'bundled');
  assert(r.catalog.tools.length >= 3);
  r = await chain({ remote: null });
  assert.strictEqual(r.source, 'bundled');
  mode = 'ok'; server.closeAllConnections && server.closeAllConnections(); await new Promise((res) => server.close(res));
  r = await chain();
  assert.strictEqual(r.source, 'bundled', 'server gone + no cache -> bundled');
  ok('catalog chain: remote, cache, bundled; timeout; bad responses');

  // ---- downloads over http: byte-exact, and truncation is detected -------------------------------------
  const big = crypto.randomBytes(6 * 1024 * 1024);
  const dlServer = http.createServer((req, res) => {
    if (req.url === '/full') { res.setHeader('content-length', big.length); res.end(big); }
    else if (req.url === '/cut') { res.setHeader('content-length', big.length); res.write(big.subarray(0, 1024 * 1024)); setTimeout(() => res.destroy(), 50); }
  });
  await new Promise((r) => dlServer.listen(0, '127.0.0.1', r));
  const dlBase = `http://127.0.0.1:${dlServer.address().port}`;
  const dest = path.join(tmp, 'dl', 'big.bin');
  const dl = await core.download(`${dlBase}/full`, dest, () => {});
  assert.strictEqual(dl.bytes, big.length);
  assert(fs.readFileSync(dest).equals(big), 'downloaded file must be byte-identical');
  assert.strictEqual(dl.sha256, crypto.createHash('sha256').update(big).digest('hex'));
  await assert.rejects(() => core.download(`${dlBase}/cut`, path.join(tmp, 'dl', 'cut.bin'), () => {}));
  dlServer.closeAllConnections && dlServer.closeAllConnections(); await new Promise((res) => dlServer.close(res));
  ok('http download is byte-exact; truncated downloads are rejected');

  // ---- release catalog builder (what CI runs) ------------------------------------------------------
  const { buildCatalog } = require('./build-catalog');
  const { filePrefix } = require('./tool-assets');
  const template = JSON.parse(fs.readFileSync(bundled, 'utf8'));
  const art = path.join(tmp, 'artifacts'); fs.mkdirSync(art);
  const pkgOf = (id) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tools', id, 'package.json'), 'utf8'));
  for (const t of template.tools) {
    const p = pkgOf(t.id);
    for (const os of ['win', 'linux']) fs.writeFileSync(path.join(art, `${filePrefix(p)}-${p.version}-${os}-x64.zip`), `${t.id}-${os}`);
  }
  const base = 'https://github.com/o/r/releases/download/v1.0.0';
  const built = buildCatalog({ template, artifactsDir: art, baseUrl: base + '/', requirePlatforms: ['windows', 'linux'] });
  assert.strictEqual(built.tools.length, template.tools.length);
  for (const t of built.tools) {
    const p = pkgOf(t.id);
    assert.strictEqual(t.version, p.version);
    const w = t.platforms.windows;
    assert.strictEqual(w.url, `${base}/${filePrefix(p)}-${p.version}-win-x64.zip`);
    assert.strictEqual(w.sha256, crypto.createHash('sha256').update(`${t.id}-win`).digest('hex'));
    assert.strictEqual(w.exec, `${p.build.executableName}.exe`);
    assert.strictEqual(t.platforms.linux.exec, p.build.executableName);
    assert.deepStrictEqual(t.platforms.linux.args, ['--no-sandbox']);
  }
  // the generated catalog must survive the launcher's own sanitiser unchanged in substance
  const re = core.parseCatalog(JSON.stringify(built));
  assert.strictEqual(re.tools.length, built.tools.length);
  assert(re.tools.every((t) => t.platforms.windows && t.platforms.linux));
  assert.throws(() => buildCatalog({ template, artifactsDir: art, baseUrl: 'http://insecure/x' }), /https/);
  fs.rmSync(path.join(art, fs.readdirSync(art).find((f) => /linux/.test(f) && f.startsWith('AudioTagger'))));
  assert.throws(() => buildCatalog({ template, artifactsDir: art, baseUrl: base, requirePlatforms: ['linux'] }), /no linux package/);
  assert.throws(() => buildCatalog({ template, artifactsDir: path.join(tmp, 'empty'), baseUrl: base }), /No packages/);
  ok('release catalog builder: urls, hashes, exec, required platforms, https only');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
