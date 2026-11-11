'use strict';
// `npm run e2e`: starts the app in end-to-end mode (a real window, driven with real input) and prints the report.
//   node test/run-e2e.js [--shots=<folder for screenshots>]
//   node test/run-e2e.js --readme-shots=../../docs/screenshots   (makes the README screenshot instead)
// There is no microphone here: Chromium's fake capture device plays an invented speech recording (made below) instead.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const W = require('../src/wav');
const { makeSpeech } = require('../src/synth');

const out = path.join(os.tmpdir(), `voicerecorder-e2e-${process.pid}.json`);
const fake = path.join(os.tmpdir(), `voicerecorder-e2e-mic-${process.pid}.wav`);
const s = makeSpeech({ phrases: [1.6, 2.2, 1.8], pauses: [0.4, 2.6, 0.5], lead: 0.3, noise: 0.006, hum: 0.004, seed: 42 });
W.writeFloatWav(fake, s.samples, s.sampleRate);
const shots = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8);
const readme = (process.argv.find((a) => a.startsWith('--readme-shots=')) || '').slice(15);
const electron = require(path.join(__dirname, '..', '..', '..', 'node_modules', 'electron'));
const args = [path.join(__dirname, '..'), '--e2e', `--e2e-out=${out}`, `--fake-audio=${fake}`];
if (shots) args.push(`--shots=${path.resolve(shots)}`);
if (readme) args.push(`--readme-shots=${path.resolve(readme)}`);
const child = spawn(electron, args, { stdio: 'inherit' });
const timer = setTimeout(() => { console.error('e2e timed out'); child.kill(); }, 300000);
child.on('exit', (code) => {
  clearTimeout(timer);
  try { fs.rmSync(fake, { force: true }); } catch { /* ignore */ }
  if (readme) process.exit(code);
  let report = null;
  try { report = JSON.parse(fs.readFileSync(out, 'utf8')); fs.rmSync(out, { force: true }); } catch { /* none */ }
  if (!report) { console.error('No report was written (exit code ' + code + ').'); process.exit(1); }
  for (const r of report.results) console.log(`${r.ok ? '  ok  ' : ' FAIL '} ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}${r.error ? '\n        ' + r.error : ''}`);
  console.log(report.ok ? '\nend-to-end: all passed' : '\nend-to-end: FAILED');
  process.exit(report.ok ? 0 : 1);
});
