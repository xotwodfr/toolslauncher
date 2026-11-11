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
| [node-taglib-sharp](https://github.com/benrr101/node-taglib-sharp) | Audio Tagger, Music Player, Duplicate Finder, BPM & Key Finder | LGPL-2.1-or-later | Pure JavaScript; dependencies iconv-lite, os-locale, uuid (MIT) |
| [tesseract.js](https://github.com/naptha/tesseract.js) and tesseract.js-core | Image Text Extractor | Apache-2.0 | The [Tesseract](https://github.com/tesseract-ocr/tesseract) OCR engine (Apache-2.0, with Leptonica, BSD-2-Clause) compiled to WebAssembly; runs in a worker thread, offline. Dependencies bmp-js, is-electron, is-url, node-fetch, regenerator-runtime, zlibjs (MIT), idb-keyval and wasm-feature-detect (Apache-2.0) |
| [@tesseract.js-data](https://github.com/naptha/tessdata) language files (English, Swedish, German, French, Spanish, Italian, Portuguese, Dutch, Danish, Norwegian, Finnish, Polish) | Image Text Extractor | Apache-2.0 | The "best, integer" Tesseract models, copied into the app at build time |
| [Demucs](https://github.com/facebookresearch/demucs) HT-Demucs 6-stem model (`htdemucs_6s`) as an ONNX export by [StemSplit](https://huggingface.co/StemSplitio/htdemucs-6s-onnx) | Stem Splitter | MIT | The model weights (Meta AI / Alexandre Défossez et al., MIT) exported to ONNX (MIT); the 136 MB fp16-weights file is downloaded by `npm run setup` (checked against a pinned SHA-256) and bundled in the app. Runs offline |
| [IS-Net](https://github.com/xuebinqin/DIS) "isnet-general-use" background-removal model (Xuebin Qin et al.), as the ONNX file published by [rembg](https://github.com/danielgatis/rembg/releases/tag/v0.0.0) | Background Remover | Apache-2.0 (the network and its weights); rembg, which converted it to ONNX, is MIT | The 170 MB model is downloaded by `npm run setup` and checked against a pinned SHA-256; it is bundled inside the package. Runs on the CPU |
| [Whisper](https://github.com/openai/whisper) "small" speech model (OpenAI), as the 8-bit ONNX "timestamped" export from [onnx-community/whisper-small_timestamped](https://huggingface.co/onnx-community/whisper-small_timestamped) | Lyrics Maker | MIT | About 250 MB (encoder, decoder, tokenizer and settings), downloaded by `npm run setup` at a pinned revision and checked against pinned SHA-256 values; bundled inside the package. The audio front end, decoding rules and word timing are code in this repository, following the published reference implementation |
| [onnxruntime-node](https://github.com/microsoft/onnxruntime) | Stem Splitter, Background Remover, Lyrics Maker | MIT | Microsoft ONNX Runtime with its native Node binding (CPU); dependencies onnxruntime-common, adm-zip, matcher, serialize-error and a few small helpers (MIT), global-agent (BSD-3-Clause), semver (ISC) |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | PDF Toolkit | MIT | Pure JavaScript; dependencies @pdf-lib/standard-fonts, @pdf-lib/upng (MIT) and pako (MIT and Zlib) |
| [FFmpeg](https://ffmpeg.org/) via [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | Audio Converter, Video Converter, Audio Editor, Duplicate Finder, Stem Splitter, BPM & Key Finder, Lyrics Maker | **GPL-3.0-or-later** (this build is GPL: libx264, libmp3lame, libopus, libvorbis and others) | See below |
| [exifr](https://github.com/MikeKovarik/exifr) | Batch File Renamer | MIT | Pure JavaScript; reads when a photo was taken (EXIF DateTimeOriginal) |
| [music-metadata](https://github.com/Borewit/music-metadata) | Batch File Renamer | MIT | Pure JavaScript; reads artist, title, track and album. Dependencies strtok3, token-types, file-type, @tokenizer/token, @tokenizer/inflate, uint8array-extras, @borewit/text-codec, win-guid, content-type, media-typer, debug, ms (MIT) and ieee754 (BSD-3-Clause) |
| [qrcode](https://github.com/soldair/node-qrcode) | QR & Barcode Studio | MIT | QR encoding (drawing is code in this repository); dependencies dijkstrajs, pngjs, yargs and its helpers (MIT / ISC) |
| [bwip-js](https://github.com/metafloor/bwip-js) | QR & Barcode Studio | MIT | Barcodes (EAN, UPC, Code 128, Code 39, ITF) as SVG, offline; includes BWIPP (MIT) |
| [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) | QR & Barcode Studio | MIT | [ZXing-C++](https://github.com/zxing-cpp/zxing-cpp) (Apache-2.0) compiled to WebAssembly, used to read codes. The .wasm file is bundled and loaded from the app's own files, never from the CDN that is the library's default; dependencies @types/emscripten, type-fest (MIT) |
| [hash-wasm](https://github.com/Daninet/hash-wasm) | Password Vault, File Encryptor & Hasher | MIT | Argon2id (and BLAKE2b in File Encryptor) from the reference C code compiled to WebAssembly; runs in-process |
| [zxcvbn-ts](https://github.com/zxcvbn-ts/zxcvbn) (@zxcvbn-ts/core, language-common, language-en) | Password Vault, File Encryptor & Hasher | MIT | Password strength estimate, offline; dependency fastest-levenshtein (MIT) |
| [EFF large word list](https://www.eff.org/deeplinks/2016/07/new-wordlists-random-passphrases) | Password Vault | CC BY 3.0 US (Electronic Frontier Foundation) | `src/data/eff_large_wordlist.txt`, 7,776 words for passphrases, from the npm packages diceware-wordlist-en-eff and @wordlist/english-eff (which agree word for word); byte-identical to the EFF's eff_large_wordlist.txt, checked by SHA-256 in the tests |

Music Player's playback uses the audio decoders built into Electron / Chromium (MP3, FLAC, Ogg Vorbis, Opus, AAC, WAV); it bundles no extra codecs. Its LRC and TTML lyrics, M3U playlist and library code is code in this repository.

Photo Privacy Cleaner has no runtime dependencies: its JPEG, PNG and WebP handling is code in this repository. BPM & Key Finder's tempo and key detection (and its FFT) is code in this repository too, with no models or analysis libraries.

Lyrics Maker's tests make spoken test clips with the speech voices that come with Windows; nothing from them is shipped.

Text & File Diff has no runtime dependencies: its diff (Myers and patience), patch, merge and folder comparison are code in this repository. Its tests use [jsdiff](https://github.com/kpdecker/jsdiff) (BSD-3-Clause, never shipped) to check that the diffs are minimal and that exported patches apply back.

Disk Space Visualizer has no runtime dependencies: its scanner and squarified treemap are code in this repository.

QR & Barcode Studio's tests use [resvg-js](https://github.com/yisibl/resvg-js) (MPL-2.0, never shipped) to turn the SVG codes into pixels before reading them back.

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
- Audio Converter, Video Converter, Audio Editor, Duplicate Finder, Stem Splitter, BPM & Key Finder and Lyrics Maker run ffmpeg as a separate process and do not link against it.

If you redistribute any of these tools, keep these files together with the binary and keep this notice.
