'use strict';
// Which folders the app refuses to move to the Recycle Bin. Electron-free and testable for both systems: pass `platform`,
// `home` and `env` to check Windows rules on Linux and the other way round.
const path = require('path');

function rulesFor({ platform = process.platform, home = require('os').homedir(), env = process.env } = {}) {
  const win = platform === 'win32';
  const P = win ? path.win32 : path.posix;
  const norm = (p) => {
    let s = String(p);
    if (win && /^[a-z]:$/i.test(s)) s += '\\';
    s = P.resolve(s);
    if (win) s = s.toLowerCase();
    if (s.length > (win ? 3 : 1)) s = s.replace(/[\\/]+$/, '');
    return s;
  };
  const inside = []; // the folder itself and everything in it
  const exact = [];  // only the folder itself (what is inside may go)
  if (win) {
    const sys = env.SystemRoot || env.windir || 'C:\\Windows';
    const drive = sys.slice(0, 2);
    inside.push(sys, env.ProgramFiles || drive + '\\Program Files', env['ProgramFiles(x86)'] || drive + '\\Program Files (x86)',
      env.ProgramW6432 || drive + '\\Program Files', env.ProgramData || drive + '\\ProgramData',
      drive + '\\System Volume Information', drive + '\\$Recycle.Bin', drive + '\\Recovery', drive + '\\Boot', drive + '\\EFI',
      drive + '\\pagefile.sys', drive + '\\hiberfil.sys', drive + '\\swapfile.sys', drive + '\\bootmgr');
    exact.push(drive + '\\Users', drive + '\\Users\\Public', home);
    if (env.APPDATA) exact.push(env.APPDATA);
    if (env.LOCALAPPDATA) exact.push(env.LOCALAPPDATA);
    if (home) exact.push(P.join(home, 'AppData'), P.join(home, 'Desktop'), P.join(home, 'Documents'), P.join(home, 'Downloads'));
  } else {
    inside.push('/bin', '/sbin', '/usr', '/etc', '/lib', '/lib32', '/lib64', '/libx32', '/boot', '/proc', '/sys', '/dev', '/run',
      '/var/lib', '/var/log', '/snap', '/System', '/Library', '/Applications', '/private');
    exact.push('/home', '/root', '/var', '/opt', '/srv', '/mnt', '/media', '/tmp', '/Users', home);
    if (home) exact.push(P.join(home, 'Desktop'), P.join(home, 'Documents'), P.join(home, 'Downloads'), P.join(home, '.config'), P.join(home, '.local'));
  }
  return { win, P, norm, inside: [...new Set(inside.filter(Boolean).map(norm))], exact: [...new Set(exact.filter(Boolean).map(norm))] };
}

/**
 * @returns {string} '' when the path may be moved to the Recycle Bin, else the reason in plain words
 */
function protectedReason(p, opts) {
  if (typeof p !== 'string' || !p) return 'No item was chosen.';
  const R = rulesFor(opts);
  const n = R.norm(p);
  const root = R.win ? /^[a-z]:\\?$/.test(n) || /^\\\\[^\\]+\\[^\\]+\\?$/.test(n) : n === '/';
  if (root) return 'A whole drive cannot be moved to the Recycle Bin.';
  const sep = R.win ? '\\' : '/';
  for (const s of R.inside) if (n === s || n.startsWith(s + sep)) return `This is part of the system (${s}). Deleting it could stop the computer from working.`;
  for (const s of R.exact) if (n === s) return 'This is a main folder of your computer or your user account. Look inside it and remove what you do not need instead.';
  // a folder that CONTAINS a protected one (for example the folder above your home folder)
  for (const s of [...R.inside, ...R.exact]) if (s.startsWith(n + sep)) return 'This folder holds system or user folders. Look inside it and remove what you do not need instead.';
  return '';
}

module.exports = { protectedReason, rulesFor };
