'use strict';
// npm >= 11 doesn't run dependency install scripts by default, and ffmpeg-static downloads its binary in one.
// This runs that step explicitly (idempotent: does nothing if the binary is already there).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const pkgDir = path.join(__dirname, '..', 'node_modules', 'ffmpeg-static');
if (!fs.existsSync(pkgDir)) { console.error('Run `npm install` first.'); process.exit(1); }
const binary = require(pkgDir); // path of the platform binary (it may not exist yet)
if (binary && fs.existsSync(binary)) { console.log('ffmpeg already present:', binary); process.exit(0); }
console.log('Fetching ffmpeg binary (ffmpeg-static install step)...');
const r = spawnSync(process.execPath, ['install.js'], { cwd: pkgDir, stdio: 'inherit' });
if (r.status !== 0 || !fs.existsSync(binary)) { console.error('ffmpeg download failed.'); process.exit(1); }
console.log('ffmpeg ready:', binary);
