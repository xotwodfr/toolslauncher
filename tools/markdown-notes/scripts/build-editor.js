'use strict';
// Builds src/renderer/vendor/editor.js (CodeMirror 6 + Markdown) from scripts/editor-entry.js with esbuild.
// Only needed after changing the entry or updating CodeMirror; the built file is committed.
const path = require('path');
require('esbuild').build({
  entryPoints: [path.join(__dirname, 'editor-entry.js')],
  bundle: true, minify: true, format: 'iife', globalName: 'NotesEditor', target: ['chrome130'],
  outfile: path.join(__dirname, '..', 'src', 'renderer', 'vendor', 'editor.js'),
  legalComments: 'eof',
  banner: { js: '/* Markdown Notes editor bundle: CodeMirror 6 (MIT, https://codemirror.net) built with esbuild. */' },
}).then(() => console.log('built src/renderer/vendor/editor.js')).catch((e) => { console.error(e); process.exit(1); });
