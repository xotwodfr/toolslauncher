'use strict';
// File type groups (by extension). Shared by the scanner (main / worker) and the window (loaded as a plain script).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DiskTypes = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const GROUPS = ['video', 'audio', 'images', 'archives', 'code', 'documents', 'apps', 'other'];
  const LABELS = ['Video', 'Audio', 'Pictures', 'Archives & disk images', 'Code & data', 'Documents', 'Programs', 'Other'];
  // colours for the treemap and the legend: readable on the near-black page, told apart by hue and lightness
  const COLORS = ['#ff9f6e', '#c58cff', '#5fc9f8', '#f2d15c', '#62d99b', '#7ea6ff', '#ff6f91', '#8a8a96'];
  const EXT = {
    video: 'mp4 m4v mkv mov avi wmv flv webm mpg mpeg m2ts mts ts vob 3gp ogv rmvb divx f4v',
    audio: 'mp3 flac wav m4a aac ogg oga opus wma aiff aif alac ape mid midi amr wv dsf dff mka',
    images: 'jpg jpeg png gif bmp tif tiff webp heic heif avif raw cr2 cr3 nef arw dng orf rw2 psd xcf svg ico jxl kra exr hdr',
    archives: 'zip rar 7z tar gz tgz bz2 xz zst lz lzma cab iso img dmg vhd vhdx vmdk qcow2 wim esd jar war apk xapk ova',
    code: 'js mjs cjs ts tsx jsx py pyc rb go rs c h cpp hpp cc cs java class kt swift php pl lua sh ps1 sql json xml yml yaml toml ini cfg css scss html htm vue map wasm o obj a lib pdb ipynb db sqlite sqlite3 log lock',
    documents: 'pdf doc docx odt rtf txt md xls xlsx ods csv ppt pptx odp epub mobi azw3 pages numbers key tex one msg eml pst ost',
    apps: 'exe msi msix appx dll sys drv ocx com bat cmd app deb rpm appimage snap flatpak so dylib bin run elf node scr cpl',
  };
  const BY_EXT = new Map();
  GROUPS.forEach((g, i) => { if (EXT[g]) for (const e of EXT[g].split(' ')) BY_EXT.set(e, i); });
  const OTHER = GROUPS.indexOf('other');

  /** the extension of a file name, lower case, without the dot ('' when there is none; ".bashrc" has none) */
  function extOf(name) {
    const s = String(name);
    const i = s.lastIndexOf('.');
    if (i <= 0 || i === s.length - 1) return '';
    const e = s.slice(i + 1).toLowerCase();
    return e.length > 12 || /[\s/\\]/.test(e) ? '' : e;
  }
  /** group index (into GROUPS) of a file name */
  function groupOf(name) {
    const e = extOf(name);
    if (BY_EXT.has(e)) return BY_EXT.get(e);
    // split archives and partial downloads: name.7z.001, name.part1.rar, file.mp4.part
    const m = /\.([a-z0-9]{1,5})\.(?:\d{3}|part|crdownload|tmp)$/i.exec(String(name));
    if (m && BY_EXT.has(m[1].toLowerCase())) return BY_EXT.get(m[1].toLowerCase());
    if (/^r\d\d$|^z\d\d$|^\d{3}$/.test(e)) return BY_EXT.get('zip');
    return OTHER;
  }
  return { GROUPS, LABELS, COLORS, OTHER, extOf, groupOf };
});
