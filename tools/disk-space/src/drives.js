'use strict';
// Lists the drives (Windows: the drive letters; Linux: the real mounted file systems) with their size and free space.
const fs = require('fs');
const path = require('path');

const REAL_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'jfs', 'reiserfs', 'vfat', 'fat', 'msdos', 'exfat', 'ntfs', 'ntfs3',
  'fuseblk', 'hfs', 'hfsplus', 'apfs', 'nfs', 'nfs4', 'cifs', 'smb3', 'smbfs', 'overlay', 'bcachefs', 'nilfs2', 'udf', 'iso9660', '9p', 'virtiofs', 'fuse.sshfs']);
const SKIP_UNDER = ['/proc', '/sys', '/dev', '/run', '/snap', '/var/lib/docker', '/var/snap', '/boot/efi'];

function space(p) {
  try {
    const s = fs.statfsSync(p);
    const total = s.blocks * s.bsize; const free = s.bavail * s.bsize;
    return total > 0 ? { total, free } : null;
  } catch { return null; }
}

/** "\040" style escapes in /proc/mounts */
const unescapeMount = (s) => s.replace(/\\([0-7]{3})/g, (_m, o) => String.fromCharCode(parseInt(o, 8)));

function parseMounts(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text).split('\n')) {
    const [dev, mnt, type] = line.split(' ');
    if (!mnt || !REAL_FS.has(type)) continue;
    const at = unescapeMount(mnt);
    if (SKIP_UNDER.some((s) => at === s || at.startsWith(s + '/'))) continue;
    if (seen.has(at)) continue;
    seen.add(at);
    out.push({ path: at, device: unescapeMount(dev), fs: type });
  }
  return out;
}

function listDrives(platform = process.platform) {
  const out = [];
  if (platform === 'win32') {
    for (let c = 65; c <= 90; c++) {
      const p = String.fromCharCode(c) + ':\\';
      if (c < 67 && !fs.existsSync(p)) continue; // A: and B: are old floppy letters; checking them can be slow
      const sp = space(p);
      if (sp) out.push({ path: p, label: p.slice(0, 2), ...sp });
    }
    return out;
  }
  let mounts = [];
  try { mounts = parseMounts(fs.readFileSync('/proc/mounts', 'utf8')); } catch { mounts = [{ path: '/', fs: '' }]; }
  const home = require('os').homedir();
  const devs = new Set();
  for (const m of mounts) {
    const sp = space(m.path);
    if (!sp) continue;
    let dev = null; try { dev = fs.statSync(m.path).dev; } catch { continue; }
    if (devs.has(dev + ':' + sp.total)) continue; // bind mounts of the same drive
    devs.add(dev + ':' + sp.total);
    const label = m.path === '/' ? 'System (/)' : path.basename(m.path) || m.path;
    out.push({ path: m.path, label, fs: m.fs, ...sp });
  }
  if (home && !out.some((d) => d.path === home)) { const sp = space(home); if (sp) out.push({ path: home, label: 'Home folder', home: true, ...sp }); }
  return out;
}

module.exports = { listDrives, parseMounts, space };
