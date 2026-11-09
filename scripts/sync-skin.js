'use strict';
// Copies tools/_shared/skin.css into every tool as src/renderer/skin.css (each tool is packaged on its own, so it needs its
// own copy) and makes sure each tool's index.html links it after styles.css.
//   node scripts/sync-skin.js          write the copies
//   node scripts/sync-skin.js --check  fail if any copy is missing, differs, or is not linked (used by `npm test`)
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const source = path.join(root, 'tools', '_shared', 'skin.css');
const skin = fs.readFileSync(source, 'utf8').replace(/\r\n/g, '\n');
const check = process.argv.includes('--check');
const LINK = '<link rel="stylesheet" href="skin.css">';

const tools = fs.readdirSync(path.join(root, 'tools'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('_') && fs.existsSync(path.join(root, 'tools', d.name, 'src', 'renderer', 'index.html')))
  .map((d) => d.name);

let problems = 0;
for (const name of tools) {
  const dir = path.join(root, 'tools', name, 'src', 'renderer');
  const copy = path.join(dir, 'skin.css');
  const htmlFile = path.join(dir, 'index.html');
  const have = fs.existsSync(copy) ? fs.readFileSync(copy, 'utf8').replace(/\r\n/g, '\n') : null;
  let html = fs.readFileSync(htmlFile, 'utf8');
  const linked = html.includes(LINK);

  if (check) {
    if (have !== skin) { console.error(`FAIL ${name}: src/renderer/skin.css ${have === null ? 'is missing' : 'differs from tools/_shared/skin.css'}`); problems++; }
    if (!linked) { console.error(`FAIL ${name}: index.html does not link skin.css`); problems++; }
    else if (html.indexOf(LINK) < html.indexOf('href="styles.css"')) { console.error(`FAIL ${name}: skin.css must come after styles.css`); problems++; }
    continue;
  }
  if (have !== skin) { fs.writeFileSync(copy, skin); console.log(`wrote ${name}/src/renderer/skin.css`); }
  if (!linked) {
    const eol = html.includes('\r\n') ? '\r\n' : '\n';
    const re = /(<link rel="stylesheet" href="styles\.css">)/;
    if (!re.test(html)) throw new Error(`${name}: cannot find the styles.css link in index.html`);
    html = html.replace(re, `$1${eol}  ${LINK}`);
    fs.writeFileSync(htmlFile, html);
    console.log(`linked skin.css in ${name}/src/renderer/index.html`);
  }
}
if (check) {
  if (problems) { console.error(`\n${problems} skin problem(s). Run: node scripts/sync-skin.js`); process.exit(1); }
  console.log(`  ok  ${tools.length} tools use the shared skin`);
}
