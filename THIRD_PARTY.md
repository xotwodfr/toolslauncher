# Third-party software

Tools Launcher's own code is MIT-licensed (see `LICENSE`). The built apps include the following third-party
components. Each downloadable package also carries the licence files its components ship with
(for example `LICENSE.electron.txt` and `LICENSES.chromium.html` next to every executable).

| Component | Used by | Licence | Notes |
|---|---|---|---|
| [Electron](https://github.com/electron/electron) and Chromium | all apps | MIT; Chromium and its dependencies under various open-source licences | Full notices: `LICENSES.chromium.html` in each package |
| [adm-zip](https://github.com/cthackers/adm-zip) | Launcher | MIT | |
| [sharp](https://github.com/lovell/sharp) | Picture Converter | Apache-2.0 | Bundles [libvips](https://github.com/libvips/libvips) (LGPL-3.0-or-later) and other native libraries; see the `@img/sharp-*` package licences |
| [node-taglib-sharp](https://github.com/benrr101/node-taglib-sharp) | Audio Tagger | LGPL-2.1-or-later | Pure JavaScript; dependencies iconv-lite, os-locale, uuid (MIT) |
| [FFmpeg](https://ffmpeg.org/) via [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | Audio Converter | **GPL-3.0-or-later** (this build is GPL: libmp3lame, libopus, libvorbis and others) | See below |

## FFmpeg (GPL) - Audio Converter

The Audio Converter package contains an unmodified FFmpeg binary built with GPL-licensed components.
Because that binary is distributed with the Audio Converter download, the GPL applies to the binary itself:

- FFmpeg is Copyright (c) the FFmpeg developers. Licence text: <https://www.gnu.org/licenses/gpl-3.0.html>
- The Windows binary is the gyan.dev "essentials" build (GPLv3); the Linux binary is a static GPLv3 build
  fetched by the same package. The package includes the licence and readme files shipped with the binary
  (for example `ffmpeg.exe.LICENSE`, `ffmpeg.exe.README`).
- **Source code** for the exact FFmpeg version bundled (6.1.1) is available from <https://ffmpeg.org/releases/>
  (`ffmpeg-6.1.1.tar.xz`). Build configuration is printed by `ffmpeg -version`.
- Audio Converter runs ffmpeg as a separate process and does not link against it.

If you redistribute Audio Converter, keep these files together with the binary and keep this notice.
