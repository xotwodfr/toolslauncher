'use strict';
// `npm run e2e`: starts the app in end-to-end mode (a real window, driven with real input) and prints the report.
//   node test/run-e2e.js [--shots=<folder for screenshots>]
// It first writes an invented webcam video (.y4m) of the six faces of a known scrambled cube and the faces of a non-cube
// puzzle; only in this mode the app is told to use it as a fake camera (and to offer two small test puzzles too), so the
// scan is tested for real on known colours.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanVideo } = require('./fixtures');

const out = path.join(os.tmpdir(), `cubesolver-e2e-${process.pid}.json`);
const video = path.join(os.tmpdir(), `cubesolver-e2e-${process.pid}.y4m`);
const shots = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8);
const SEED = 4242;
scanVideo(video, SEED);
const electron = require(path.join(__dirname, '..', '..', '..', 'node_modules', 'electron'));
const args = [path.join(__dirname, '..'), '--e2e', '--test-puzzles', `--e2e-out=${out}`, `--fake-video=${video}`, `--fake-seed=${SEED}`];
if (shots) args.push(`--shots=${path.resolve(shots)}`);
const child = spawn(electron, args, { stdio: 'inherit' });
const timer = setTimeout(() => { console.error('e2e timed out'); child.kill(); }, 1200000);
child.on('exit', (code) => {
  clearTimeout(timer);
  try { fs.rmSync(video, { force: true }); } catch { /* ignore */ }
  let report = null;
  try { report = JSON.parse(fs.readFileSync(out, 'utf8')); fs.rmSync(out, { force: true }); } catch { /* none */ }
  if (!report) { console.error('No report was written (exit code ' + code + ').'); process.exit(1); }
  for (const r of report.results) console.log(`${r.ok ? '  ok  ' : ' FAIL '} ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}${r.error ? '\n        ' + r.error : ''}`);
  if (report.notes && Object.keys(report.notes).length) console.log('\nnotes:', JSON.stringify(report.notes));
  console.log(report.ok ? '\nend-to-end: all passed' : '\nend-to-end: FAILED');
  process.exit(report.ok ? 0 : 1);
});
