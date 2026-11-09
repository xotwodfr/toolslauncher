'use strict';
// `npm run e2e`: starts the app in end-to-end mode (a real window, driven with real input) and prints the report.
//   node test/run-e2e.js [--shots=<folder for screenshots>]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const out = path.join(os.tmpdir(), `musicplayer-e2e-${process.pid}.json`);
const shots = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8);
const electron = require(path.join(__dirname, '..', '..', '..', 'node_modules', 'electron'));
const args = [path.join(__dirname, '..'), '--e2e', `--e2e-out=${out}`];
if (shots) args.push(`--shots=${path.resolve(shots)}`);
const child = spawn(electron, args, { stdio: 'inherit' });
const timer = setTimeout(() => { console.error('e2e timed out'); child.kill(); }, 240000);
child.on('exit', (code) => {
  clearTimeout(timer);
  let report = null;
  try { report = JSON.parse(fs.readFileSync(out, 'utf8')); fs.rmSync(out, { force: true }); } catch { /* none */ }
  if (!report) { console.error('No report was written (exit code ' + code + ').'); process.exit(1); }
  for (const r of report.results) console.log(`${r.ok ? '  ok  ' : ' FAIL '} ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}${r.error ? '\n        ' + r.error : ''}`);
  if (report.notes && Object.keys(report.notes).length) console.log('\nnotes:', JSON.stringify(report.notes));
  console.log(report.ok ? '\nend-to-end: all passed' : '\nend-to-end: FAILED');
  process.exit(report.ok ? 0 : 1);
});
