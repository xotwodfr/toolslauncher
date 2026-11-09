# Third-party software

Tools Launcher's own code is MIT-licensed (see `LICENSE`). The built apps include the following third-party
components. Each downloadable package also carries the licence files its components ship with
(for example `LICENSE.electron.txt` and `LICENSES.chromium.html` next to every executable).

| Component | Used by | Licence | Notes |
|---|---|---|---|
| [Electron](https://github.com/electron/electron) and Chromium | all apps | MIT; Chromium and its dependencies under various open-source licences | Full notices: `LICENSES.chromium.html` in each package |
| [adm-zip](https://github.com/cthackers/adm-zip) | Launcher | MIT | |
| [sharp](https://github.com/lovell/sharp) | Picture Converter | Apache-2.0 | Bundles [libvips](https://github.com/libvips/libvips) (LGPL-3.0-or-later) and other native libraries; see the `@img/sharp-*` package licences |
| [@jsquash/jxl](https://github.com/jamsinclair/jSquash) | Picture Converter | Apache-2.0 | [libjxl](https://github.com/libjxl/libjxl) (BSD-3-Clause, with Highway under Apache-2.0) compiled to WebAssembly; used for JPEG XL. Runs in-process, no native code |
| [wasm-feature-detect](https://github.com/GoogleChromeLabs/wasm-feature-detect) | Picture Converter | Apache-2.0 | Used by @jsquash/jxl |
| [node-taglib-sharp](https://github.com/benrr101/node-taglib-sharp) | Audio Tagger, Music Player, Duplicate Finder | LGPL-2.1-or-later | Pure JavaScript; dependencies iconv-lite, os-locale, uuid (MIT) |
| [tesseract.js](https://github.com/naptha/tesseract.js) and tesseract.js-core | Image Text Extractor | Apache-2.0 | The [Tesseract](https://github.com/tesseract-ocr/tesseract) OCR engine (Apache-2.0, with Leptonica, BSD-2-Clause) compiled to WebAssembly; runs in a worker thread, offline. Dependencies bmp-js, is-electron, is-url, node-fetch, regenerator-runtime, zlibjs (MIT), idb-keyval and wasm-feature-detect (Apache-2.0) |
| [@tesseract.js-data](https://github.com/naptha/tessdata) language files (English, Swedish, German, French, Spanish, Italian, Portuguese, Dutch, Danish, Norwegian, Finnish, Polish) | Image Text Extractor | Apache-2.0 | The "best, integer" Tesseract models, copied into the app at build time |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | PDF Toolkit | MIT | Pure JavaScript; dependencies @pdf-lib/standard-fonts, @pdf-lib/upng (MIT) and pako (MIT and Zlib) |
| [FFmpeg](https://ffmpeg.org/) via [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | Audio Converter, Video Converter, Audio Editor, Duplicate Finder | **GPL-3.0-or-later** (this build is GPL: libx264, libmp3lame, libopus, libvorbis and others) | See below |

Music Player's playback uses the audio decoders built into Electron / Chromium (MP3, FLAC, Ogg Vorbis, Opus, AAC, WAV); it bundles no extra codecs. Its LRC lyrics, M3U playlist and library code is code in this repository.

Photo Privacy Cleaner has no runtime dependencies: its JPEG, PNG and WebP handling is code in this repository.

Test-only tools (never shipped in a package): [sharp](https://github.com/lovell/sharp) (Apache-2.0) and [exifr](https://github.com/MikeKovarik/exifr) (MIT) in Photo Privacy Cleaner's tests, and [pdf.js](https://github.com/mozilla/pdf.js) / pdfjs-dist (Apache-2.0) in PDF Toolkit's tests, used to check our output with independent implementations.

## FFmpeg (GPL) - Audio Converter and Video Converter

The Audio Converter and Video Converter packages each contain an unmodified FFmpeg binary built with GPL-licensed components.
Because that binary is distributed with those downloads, the GPL applies to the binary itself:

- FFmpeg is Copyright (c) the FFmpeg developers. Licence text: <https://www.gnu.org/licenses/gpl-3.0.html>
- The Windows binary is the gyan.dev "essentials" build (GPLv3); the Linux binary is a static GPLv3 build
  fetched by the same package. The package includes the licence and readme files shipped with the binary
  (for example `ffmpeg.exe.LICENSE`, `ffmpeg.exe.README`).
- **Source code** for the exact FFmpeg version bundled (6.1.1) is available from <https://ffmpeg.org/releases/>
  (`ffmpeg-6.1.1.tar.xz`). Build configuration is printed by `ffmpeg -version`.
- Audio Converter, Video Converter, Audio Editor and Duplicate Finder run ffmpeg as a separate process and do not link against it.

If you redistribute any of these tools, keep these files together with the binary and keep this notice.
