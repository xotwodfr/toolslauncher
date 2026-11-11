'use strict';
// Makes the README screenshot: `node ../../node_modules/electron/cli.js . --e2e --readme-shots=<folder>`.
// The two files are INVENTED (a small made-up garden planner script), compared by the real engine.
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LEFT = `// Garden planner: when to sow what
const BEDS = ['north', 'south', 'herbs'];

function sowingWeek(plant, lastFrost) {
  const offset = plant.hardy ? -4 : 2;
  return addWeeks(lastFrost, offset);
}

function waterPerDay(bed) {
  // litres per square metre
  return bed.sunny ? 4 : 2.5;
}

const PLANTS = [
  { name: 'Peas', hardy: true, bed: 'north' },
  { name: 'Tomatoes', hardy: false, bed: 'south' },
  { name: 'Basil', hardy: false, bed: 'herbs' },
  { name: 'Carrots', hardy: true, bed: 'north' },
];

export function plan(lastFrost) {
  return PLANTS.map((p) => ({
    plant: p.name,
    week: sowingWeek(p, lastFrost),
  }));
}
`;
const RIGHT = `// Garden planner: when to sow and water what
const BEDS = ['north', 'south', 'herbs', 'pots'];

function sowingWeek(plant, lastFrost) {
  const offset = plant.hardy ? -6 : 2;
  return addWeeks(lastFrost, offset);
}

function waterPerDay(bed, rainMm = 0) {
  // litres per square metre, less after rain
  const base = bed.sunny ? 4 : 2.5;
  return Math.max(0, base - rainMm * 0.8);
}

const PLANTS = [
  { name: 'Peas', hardy: true, bed: 'north' },
  { name: 'Tomatoes', hardy: false, bed: 'pots' },
  { name: 'Basil', hardy: false, bed: 'herbs' },
  { name: 'Carrots', hardy: true, bed: 'north' },
  { name: 'Spinach', hardy: true, bed: 'north' },
];

export function plan(lastFrost) {
  return PLANTS.map((p) => ({
    plant: p.name,
    week: sowingWeek(p, lastFrost),
    bed: p.bed,
  }));
}
`;

exports.run = async ({ app, getWin, outDir }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'textdiff-shots-'));
  const win = getWin();
  const wc = win.webContents;
  const js = (c) => wc.executeJavaScript(c, true);
  const waitFor = async (expr, ms = 20000) => { const end = Date.now() + ms; for (;;) { if (await js(expr)) return; if (Date.now() > end) throw new Error('timed out: ' + expr); await sleep(60); } };
  let code = 1;
  try {
    win.setContentSize(1240, 840);
    const a = path.join(dir, 'planner.js'); const b = path.join(dir, 'planner (new).js');
    fs.writeFileSync(a, LEFT); fs.writeFileSync(b, RIGHT);
    await waitFor('!!window.__app');
    await js(`window.td.loadFile("left", ${JSON.stringify(a)}).then((r) => window.__app.setSide("left", r))`);
    await js(`window.td.loadFile("right", ${JSON.stringify(b)}).then((r) => { window.__app.setSide("right", r); window.__app.compare(); })`);
    await waitFor('window.__app.S.diff && window.__app.S.diff.stats.changes > 0');
    await js('window.__app.goTo(2)');
    await js('window.__app.choose(0, "right"); window.__app.choose(2, "right"); window.__app.goTo(2)');
    await waitFor('!document.getElementById("merge").hidden && document.getElementById("merged").value.length > 0');
    await js('for (const p of [document.getElementById("paneL"), document.getElementById("paneR")]) p.scrollTop = 0');
    await js('document.activeElement && document.activeElement.blur()');
    await sleep(500);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'text-diff.png'), (await wc.capturePage()).toPNG());
    console.log('wrote', path.join(outDir, 'text-diff.png'));
    code = 0;
  } catch (e) { console.error('screenshot failed:', e); }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  app.exit(code);
};
