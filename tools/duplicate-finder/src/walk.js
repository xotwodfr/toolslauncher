'use strict';
// Walks folders and lists the files in them. Never follows symbolic links or junctions (so a link can't send the scan
// somewhere unexpected, loop forever, or make a file count twice), skips folders it cannot read, and counts a file once
// even when several folders overlap or the same file has several hard links.
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }
const path = require('path');

const WIN = process.platform === 'win32';
const normKey = (p) => (WIN ? p.toLowerCase() : p);
const MAX_FILES = 400000;

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.ico'];
const AUDIO_EXTS = ['.mp3', '.flac', '.wav', '.ogg', '.oga', '.opus', '.m4a', '.m4b', '.aac', '.wma', '.aif', '.aiff', '.ape', '.wv', '.mka'];
const VIDEO_EXTS = ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.wmv', '.flv', '.mpg', '.mpeg', '.ts', '.m2ts', '.3gp'];
const DOC_EXTS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.txt', '.rtf', '.md', '.csv', '.epub'];
const TYPES = { all: null, images: IMAGE_EXTS, audio: AUDIO_EXTS, video: VIDEO_EXTS, documents: DOC_EXTS };

/** Folders that are never worth scanning (version control, package folders, the recycle bin). */
const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information', '.git', '.svn', '.hg', '@eadir']);
const skipDir = (name) => SKIP_DIRS.has(name.toLowerCase()) || name.toLowerCase().startsWith('.trash');

const extOf = (p) => path.extname(p).toLowerCase();

/**
 * @param roots   [{ path, keep }]   keep = files here are never offered for deletion
 * @param opts    { exts?: string[] | null, minSize?: number, skipHidden?: boolean, signal?: AbortSignal, onProgress?: (n) => void }
 * @returns {{ files, skippedLinks, unreadable, truncated }}   files: [{ path, size, mtimeMs, keep, root, links }]
 */
async function walk(roots, opts = {}) {
  const exts = opts.exts || null;
  const minSize = opts.minSize == null ? 1 : opts.minSize;
  const skipHidden = opts.skipHidden !== false;
  const signal = opts.signal;
  const byPath = new Map();     // normalised path -> record (a file reached through two roots is one record)
  const byInode = new Map();    // "dev:ino" -> record (hard links are one file)
  let skippedLinks = 0;
  let unreadable = 0;
  let truncated = false;
  let seen = 0;

  for (let r = 0; r < roots.length; r++) {
    const root = roots[r];
    const stack = [path.resolve(root.path)];
    while (stack.length) {
      if (signal && signal.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      const dir = stack.pop();
      let handle;
      try { handle = await fs.promises.opendir(dir); } catch { unreadable++; continue; }
      try {
        for await (const ent of handle) {
          if (signal && signal.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
          const full = path.join(dir, ent.name);
          if (ent.isSymbolicLink()) { skippedLinks++; continue; }
          if (ent.isDirectory()) {
            if (skipHidden && skipDir(ent.name)) continue;
            if (skipHidden && ent.name.startsWith('.')) continue;
            stack.push(full);
            continue;
          }
          if (!ent.isFile()) continue;
          if (exts && !exts.includes(extOf(ent.name))) continue;
          const key = normKey(full);
          const known = byPath.get(key);
          if (known) { if (root.keep) known.keep = true; continue; }
          let st;
          try { st = await fs.promises.lstat(full, { bigint: true }); } catch { unreadable++; continue; }
          if (!st.isFile()) continue;
          const size = Number(st.size);
          if (size < minSize) continue;
          if (byPath.size >= MAX_FILES) { truncated = true; continue; }
          const ino = st.ino && st.ino !== 0n ? `${st.dev}:${st.ino}` : '';
          const same = ino ? byInode.get(ino) : null;
          if (same) { same.links++; if (root.keep) same.keep = true; byPath.set(key, same); continue; }
          const rec = { path: full, size, mtimeMs: Number(st.mtimeMs), keep: !!root.keep, root: r, links: 1 };
          byPath.set(key, rec);
          if (ino) byInode.set(ino, rec);
          seen++;
          if (opts.onProgress && seen % 200 === 0) opts.onProgress(seen);
        }
      } catch (e) {
        if (e.cancelled) throw e;
        unreadable++;
      } finally { try { await handle.close(); } catch { /* already closed by the loop */ } }
    }
  }
  if (opts.onProgress) opts.onProgress(seen);
  return { files: [...new Set(byPath.values())], skippedLinks, unreadable, truncated };
}

module.exports = { walk, TYPES, IMAGE_EXTS, AUDIO_EXTS, VIDEO_EXTS, DOC_EXTS, extOf, normKey, skipDir };
