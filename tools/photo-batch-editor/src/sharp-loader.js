'use strict';
// Which build of sharp to use. Inside Electron on Linux, the native build must not be used: the Electron binary links
// the system's GLib, and libvips' own copy of GLib clashes with it (GObject errors, and crashes after the window has
// drawn). The WebAssembly build of the same sharp version has no such libraries, so there we hide the native build
// from sharp's loader and it falls back to WebAssembly. Everywhere else (Windows, plain Node for the tests) it is native.
const Module = require('module');

function load() {
  const avoidNative = (process.versions.electron && process.platform === 'linux') || process.env.PHOTO_BATCH_WASM === '1';
  if (!avoidNative) return require('sharp');
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (/@img[\\/]sharp-(linux|linuxmusl)-[a-z0-9]+[\\/]sharp\.node$/.test(request) || /build[\\/]Release[\\/]sharp-linux/.test(request)) {
      const e = new Error('native sharp hidden on purpose'); e.code = 'MODULE_NOT_FOUND'; throw e;
    }
    return orig.call(this, request, ...rest);
  };
  try { return require('sharp'); } finally { Module._resolveFilename = orig; }
}

module.exports = load();
