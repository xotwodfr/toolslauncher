# Tools Launcher

A small desktop launcher (Windows and Linux) that installs, updates and starts a set of focused creative tools. Pick a tool, press **Install**, then **Launch**. Inspired by the ArtCraft launcher.

![Tools Launcher](docs/screenshots/launcher.png)

## Tools

| Tool | What it does |
|---|---|
| **Audio Tagger** | Edit tags and cover art for MP3, FLAC, OGG, Opus, M4A, WAV and more. Bulk edit many files at once, number tracks in list order, rename files from their tags. Every write is backed up, verified and rolled back on failure. |
| **Audio Converter** | Batch convert between MP3, AAC/M4A, OGG, Opus, FLAC and WAV (and pull the audio out of video files). Bitrate, sample rate, channels, keeps tags and cover art, parallel jobs with progress and Cancel. |
| **Picture Converter** | Batch convert and resize images between **14 formats**: JPEG, PNG, WebP, GIF, AVIF, JPEG XL, TIFF, PDF, BMP, ICO (multi-size), TGA, QOI, PPM and PGM. Per-format options (quality, lossless, progressive, palette, TIFF compression, icon sizes, background colour...). It also reads BMP, ICO, TGA, QOI, PNM and JPEG XL, so any of them can be converted to any other. |
| **PDF Toolkit** | Merge PDFs in the order you choose, split by page, range or every N pages, extract / reorder / delete / rotate pages, and turn JPEG and PNG images into a PDF (phone photos come out the right way up). Password-protected files are refused rather than mangled. |
| **Photo Privacy Cleaner** | Shows what a JPEG, PNG or WebP quietly reveals (GPS location, camera and serial numbers, names, date, embedded thumbnails, AI prompts, hidden trailing data) and writes a clean copy. It never re-encodes the picture, and checks that the pixel data in the copy is byte-identical before saving. |
| **Music Player** | Pick a folder and play everything in it (MP3, FLAC, OGG, Opus, M4A/AAC, WAV). Albums, artists, folders, search, queue and M3U playlists, with covers, tags and **synced lyrics** (`.lrc` files or lyrics stored in the tags). Gapless, 10-band equalizer, ReplayGain volume levelling, sleep timer, mini player. It includes a lyrics editor where you tap along to time each line. |
| **Audio Editor** | Cut, trim, join, fade and level out audio on a waveform. Drag to select, press Delete to cut a part out, add more files to join them (with a pause or a crossfade). Fade in and out, normalize to a peak or a loudness target, cut silence from the ends, hear the real result with **Preview**, and save as MP3, M4A, Ogg, Opus, FLAC or WAV. It always writes a new file. |
| **Stem Splitter** | Splits a song into **vocals, drums, bass, guitar, piano and other** with the Demucs model, on your computer and offline. Tick any combination (voice + bass, drums + bass + guitar, everything except the vocals...), hear it live, set each stem's volume, and save it as WAV, FLAC or MP3. Separated songs are kept so re-opening one is instant. |
| **Duplicate Finder** | Finds exact duplicate files (any type), look-alike photos (resized, re-saved or lightly edited) and repeated songs (identical audio, or the same artist, title and length, for example an MP3 and a FLAC). You review every group, mark folders as protected, and move the extras to the Recycle Bin. Nothing is deleted for good. |
| **Image Text Extractor** | Reads the text in screenshots, photos of pages and scans (OCR), offline, in 12 languages. Paste a screenshot with Ctrl+V, draw a box to read only part of a picture, see which words were read and how sure it was, edit the text, then copy it or save it as a .txt file. |
| **Video Converter** | Convert to MP4 (H.264), WebM (VP9) or animated GIF. Cap the resolution and frame rate, pick a quality or **aim for a file size** (two-pass, so it lands on the target), trim, drop the sound, strip location metadata. Shows progress and speed, with Cancel. |

<p>
  <img src="docs/screenshots/audio-tagger.png" width="32%" alt="Audio Tagger">
  <img src="docs/screenshots/audio-converter.png" width="32%" alt="Audio Converter">
  <img src="docs/screenshots/picture-converter.png" width="32%" alt="Picture Converter">
  <img src="docs/screenshots/pdf-toolkit.png" width="32%" alt="PDF Toolkit">
  <img src="docs/screenshots/photo-privacy.png" width="32%" alt="Photo Privacy Cleaner">
  <img src="docs/screenshots/video-converter.png" width="32%" alt="Video Converter">
  <img src="docs/screenshots/music-player.png" width="32%" alt="Music Player: now playing with synced lyrics">
  <img src="docs/screenshots/music-player-albums.png" width="32%" alt="Music Player: albums">
  <img src="docs/screenshots/audio-editor.png" width="32%" alt="Audio Editor: a waveform with two parts cut out">
  <img src="docs/screenshots/stem-splitter.png" width="32%" alt="Stem Splitter: the six stems of an invented song, each with its own waveform, with drums and bass ticked">
  <img src="docs/screenshots/duplicate-finder.png" width="32%" alt="Duplicate Finder: groups of look-alike pictures, the extra copies marked to move">
  <img src="docs/screenshots/image-text-extractor.png" width="32%" alt="Image Text Extractor: a recipe card with the words that were read outlined, and the text beside it">
</p>

No tool overwrites your original files. (Music Player never changes a song; when you save lyrics it writes a `.lrc` file next to the song, and keeps any existing one as `.lrc.bak`.)

### Image Text Extractor

- **Offline.** It uses the Tesseract OCR engine compiled to WebAssembly, and the language files are inside the app (English, Swedish, German, French, Spanish, Italian, Portuguese, Dutch, Danish, Norwegian, Finnish, Polish), so no picture and no text ever leaves the computer and it needs no internet. You can pick a second language to read mixed text.
- **Getting pictures in.** Add files, drop them on the window, or press <kbd>Ctrl</kbd>+<kbd>V</kbd> to paste whatever is on the clipboard, such as a screenshot. PNG, JPEG, WebP, BMP, GIF and AVIF open (TIFF and PDF do not).
- **See what was read.** Every word is outlined on the picture, green when the engine is sure and amber or red when it is not, so doubtful words are easy to check. Drag a box around part of the picture and choose *Read selection* to read only that.
- **The text is yours to edit.** Correct it in the box, join the lines of each paragraph into one line, or reset to what was read. *Copy* puts it on the clipboard and *Save as .txt* writes a new text file (never over a picture). With several pictures, *Read all*, *Copy all text* and *Save all as text files* work on the whole list, and an existing file is never overwritten.
- **Good to know.** Small pictures are enlarged and contrast is evened out before reading (both can be switched off). It reads printed text well; handwriting and very stylised fonts are hit and miss, and the reading is only as good as the picture: sharp, straight and well lit is best. It does not rotate a sideways picture for you. Chinese, Japanese, Korean, Arabic and other scripts are not included.

### Duplicate Finder

- **Three ways to look.** *Files* finds files with exactly the same contents (any type, any name): by size, then the start and end, then a full SHA-256, so most files are never read in full, and hashes are remembered for the next scan. *Photos* finds pictures that look the same (the same photo resized, re-saved, recompressed or lightly edited, from a 64-bit difference hash; JPEG, PNG, WebP, GIF, BMP, AVIF) and shows them side by side with their pixel sizes. *Music* finds songs with identical decoded audio, and songs with the same artist, title and about the same length. It does not listen to the music, so a different recording, or the same recording with different tags, is not matched.
- **Review first, nothing automatic.** Nothing is selected until you choose. "Select the others" keeps one copy per group by a rule you pick (oldest, newest, shortest path, first folder, best quality) and you can still tick or untick any file. At least one copy of every group always stays.
- **Protected folders.** Mark a folder as protected and its copies are always the ones kept and can never be moved, even if you try.
- **Recycle Bin, not delete.** Files are moved to the Recycle Bin (Trash on Linux), so you can get them back. Right before moving, each file is checked again: if it changed after the scan it is left alone, and for exact duplicates it is compared byte for byte with the copy that stays. Files in Windows or other system folders are refused.
- **What it does not do.** It does not follow shortcuts or links, it skips `.git`, `node_modules` and hidden folders by default, and it counts hard links to one file as a single file. Files that exist only in the cloud (for example OneDrive "online only" files) are downloaded when they are read, so scan those folders only if that is what you want.

### Audio Editor

- **Cut by selecting.** Drag on the waveform (or type times in the Start / End boxes), then press <kbd>Delete</kbd> to cut that part out, or **Keep only** to trim to it. Removed parts stay visible (dimmed) with a ↺ button to put them back, and everything can be undone with <kbd>Ctrl</kbd>+<kbd>Z</kbd>. Playback skips the removed parts, and every cut edge gets a 5 ms fade so a cut never clicks.
- **Join.** Add more files and use the arrows to set the order; choose nothing, a pause of silence, or a crossfade between them. Mono and stereo files, and different sample rates, can be mixed.
- **Fades and volume.** Fade in and out, change the volume by up to ±30 dB (a boost is limited so it cannot clip), or level out: peak to −1 dB, or a loudness target (−23, −16 or −14 LUFS, measured first and then applied in a second pass). Cutting silence from the start and end is one tick box.
- **Hear it before you save.** *Preview result* renders the real thing (cuts, fades, volume) and plays it.
- **Saving.** MP3, M4A (AAC), Ogg Vorbis, Opus, FLAC or WAV, with tags and cover art kept where the format allows (a joined file keeps artist and album but not the first file's title and track number). The result is always a new file next to the original (or in a folder you choose), never an overwrite, and Cancel leaves nothing behind. MP3, AAC, Ogg and Opus are encoded again when saved, so for several rounds of editing save as FLAC or WAV and make the final lossy copy last.
- **Keys:** <kbd>Space</kbd> play/pause, <kbd>Delete</kbd> cut out the selection, <kbd>[</kbd> <kbd>]</kbd> set the selection start / end at the playhead, <kbd>←</kbd> <kbd>→</kbd> move the playhead by 0.5 s (<kbd>Shift</kbd> 5 s, <kbd>Alt</kbd> 10 ms), <kbd>+</kbd> <kbd>−</kbd> or <kbd>Ctrl</kbd>+mouse wheel zoom, <kbd>Ctrl</kbd>+<kbd>A</kbd> select all, <kbd>Esc</kbd> clear the selection.

### Stem Splitter

- **Open a song** (or drop one on the window) and it is split into six stems: vocals, drums, bass, guitar, piano and other. It uses [Demucs](https://github.com/facebookresearch/demucs) (the 6-stem "htdemucs_6s" model, MIT licence), which is inside the app, so no song ever leaves the computer and it needs no internet.
- **Pick a combination.** Tick the stems you want, or press a chip: *No vocals*, *Vocals only*, *Drums only*, *Drums + bass*, *Voice + bass*, *Voice + drums + bass*, *Bass + guitar*, *Everything*. *only* next to a stem selects just that one, and each stem has a volume slider (0 to 200%, double-click resets it). Playback follows your choice at once, so you can change the combination while it plays. Click or drag on any waveform to jump.
- **Save** the combination as WAV, FLAC or MP3 (320 kbps). The saved file is exactly what you ticked at the volumes you set, with the song's tags carried over, and a limiter only acts if adding stems would clip. It is always a new file; saving over the original song is refused.
- **How long it takes.** Splitting runs on the processor (not the graphics card) and takes roughly two thirds of the length of the song, plus a few seconds to load the model: a 34-second clip took 26 seconds on a 6-core Ryzen 5 5600X, so a 4-minute song is about 2½ minutes. A progress bar and a time estimate are shown, and Cancel stops it and leaves nothing behind. **Memory:** measured on Windows, the app needs about 4.5 GB for the few seconds while the model loads and then about 2.5 GB while it separates (8 GB of RAM is a practical minimum, and it warns you below that). Songs longer than 15 minutes wait for a click before the long job starts.
- **Saved stems.** The six stems of each song are kept (about 64 MB per minute of music, the 4 most recent songs) so opening the same song again is instant; *Clear saved stems* deletes them. They are tied to the song's name, size and modified time, so an edited song is split again.
- **Good to know.** Separation is never perfect: faint traces of other instruments can stay in a stem, and the sum of all six stems is close to, but not exactly, the original (in the tests the difference was between 4% and 10% of the signal). Vocals, drums and bass come out best; guitar and piano are the hardest parts to pull apart, and a guitar that is not clearly there may land in *other*. The live preview keeps all six stems in memory, so it is limited to songs up to 20 minutes (saving still works for longer ones).
- **Keys:** <kbd>Space</kbd> play/pause, <kbd>1</kbd>–<kbd>6</kbd> tick or untick vocals, drums, bass, guitar, piano, other.

### Music Player

- **Open a folder** (or drop one on the window). It scans in the background and remembers the result, so the next start is instant. Files it can't play (WMA, APE, AIFF, WavPack...) are counted and reported, not hidden.
- **Lyrics** come from a `Song.lrc` next to the song (synced or plain), from lyrics stored in the tags (plain, LRC text, or ID3 synced lyrics), or `Song.txt`. Synced lyrics follow the song and you can click a line to jump there. **Edit lyrics** lets you type them and tap *Stamp* as each line is sung.
- **Tags are read-only here.** *Edit tags in Audio Tagger* opens the song in [Audio Tagger](#tools) if you have installed it from the launcher.
- **Keys:** <kbd>Space</kbd> play/pause, <kbd>N</kbd> / <kbd>P</kbd> next / previous, <kbd>←</kbd> <kbd>→</kbd> seek 5 s (<kbd>Shift</kbd> 30 s), <kbd>Ctrl</kbd>+<kbd>↑</kbd> <kbd>↓</kbd> volume, <kbd>M</kbd> mute, <kbd>S</kbd> shuffle, <kbd>R</kbd> repeat, <kbd>L</kbd> lyrics, <kbd>Q</kbd> queue, <kbd>/</kbd> search. In a list: <kbd>Enter</kbd> plays, <kbd>Delete</kbd> removes (queue and playlists), <kbd>Alt</kbd>+<kbd>↑</kbd> <kbd>↓</kbd> reorders. The keyboard media keys work too.
- **Gapless:** the next song is loaded in advance and started 25 ms before the current one ends. Measured with the end-to-end test: no silence and no overlap between two WAV files over 40 consecutive hand-overs. MP3 and AAC files only play gaplessly as far as their own encoder-delay information allows.

## Install

Download the latest build from the [Releases](https://github.com/xotwodfr/toolslauncher/releases/latest) page:

- **Windows:** `ToolsLauncher-Setup-<version>.exe` (installer) or `ToolsLauncher-Portable-<version>.exe`.
- **Linux:** `ToolsLauncher-<version>-linux-x64.AppImage` (`chmod +x`, then run) or the `.deb`.

Builds are **not code-signed**, so Windows SmartScreen will warn the first time. The Linux builds are produced and unit-tested by CI, but have **not yet been run on a real Linux desktop**: please report problems (a test checklist is in [docs/LINUX_TESTING.md](docs/LINUX_TESTING.md)). The Linux tools start with `--no-sandbox`.

Tools are downloaded on demand (roughly 100-130 MB each) into your user data folder. The launcher checks each download's SHA-256 against the catalog and refuses anything that doesn't match, anything without a checksum, and (for hosted catalogs) anything that isn't served over HTTPS.

## Updating

Tools update from inside the launcher, using the releases published in this repository:

- When a newer version of a tool is published, its card shows **`v0.1.0 → v0.2.0`** and a full-width **Update to v0.2.0** button. **Update all** (top right) updates every tool that has an update.
- The launcher checks for updates when it starts; press **Refresh** to check right now.
- Updating a tool that is *running* is safe: the new version is installed next to the old one and is used the next time you start the tool; the old files are removed automatically (on the next update or launcher start).
  <img src="docs/screenshots/launcher-update.png" width="60%" alt="An update is available for Picture Converter">

- The launcher itself is not self-updating yet: to update it, install the newer build from the [Releases](https://github.com/xotwodfr/toolslauncher/releases/latest) page. Tool updates do not need a new launcher.

## Development

Requires Node 20+.

```bash
npm install
npm run dev     # builds stub tools + a dev catalog (using real built tool zips if present) and starts the launcher
npm test        # launcher core self-tests + a colour-contrast (WCAG AA) check of the UI
npm start       # run with the real catalog/catalog.json
```

The launcher's look is defined by the colour and spacing tokens at the top of `src/renderer/styles.css`. `scripts/contrast-check.js` reads those tokens and fails `npm test` if a change makes text or controls fall below WCAG AA contrast, so recolouring is safe to try.

> npm 11 doesn't run dependency install scripts by default, which breaks Electron's binary download. If `node_modules/electron/dist` is missing after `npm install`, run `node node_modules/electron/install.js`.

### Tools

Each tool is its own small Electron app in `tools/<id>/`:

```bash
cd tools/audio-tagger          # or any other folder in tools/
npm install
npm start                      # run it
npm test                       # core tests
npm run dist:win               # -> dist/<Name>-<version>-win-x64.zip  (dist:linux on Linux)
```

- Picture Converter: `sharp` handles JPEG, PNG, WebP, GIF, AVIF and TIFF; JPEG XL runs through libjxl compiled to WebAssembly (`@jsquash/jxl`); BMP, ICO, TGA, QOI, PNM and PDF are small pure-JavaScript codecs in `src/codecs/`. The format list and each format's options live in one registry (`src/formats.js`) that the interface builds itself from. `picture-converter --self-test=<result.json>` converts to every format and writes a report, which is handy for checking a packaged build. Its tests decode our encoders' output with ffmpeg when it is installed.
- Audio Converter and Video Converter bundle ffmpeg via `ffmpeg-static`: run `npm run setup` once after `npm install`. Video Converter's tests generate their own clips with ffmpeg and check every output by decoding it. A size target runs two passes, because a single pass overshoots badly (VP9 especially).
- PDF Toolkit uses `pdf-lib` (pure JavaScript). Its tests read the results back with pdf.js, an independent PDF reader.
- Photo Privacy Cleaner has no runtime dependencies. Cleaning copies the file's own segments/chunks and leaves metadata ones out (so pixels cannot change); its tests compare against `exifr` (a second EXIF reader) and libvips-decoded pixels, and run a fuzz pass over damaged files.
- Audio Editor and Duplicate Finder bundle ffmpeg the same way (`npm run setup`). Audio Editor's tests make tones of known pitch and loudness and measure every export; Duplicate Finder's tests use real files, real hashing and real tags, and try to break each safety promise (the last copy, protected folders, files that changed, the byte-for-byte check).
- Image Text Extractor bundles the OCR language files by copying them from the `@tesseract.js-data/*` dev dependencies into `langs/` (run `npm run setup` once after `npm install`; the build scripts do it too). Its tests read pictures with known text (`test/fixtures`) with the real engine and grade the result, the position of every word included.
- Stem Splitter bundles ffmpeg and the Demucs model (`npm run setup` downloads both; the model is ~136 MB, fetched from the MIT-licensed [StemSplitio/htdemucs-6s-onnx](https://huggingface.co/StemSplitio/htdemucs-6s-onnx) export and checked against a pinned SHA-256) and runs it with `onnxruntime-node` on the CPU, in a worker thread (onnxruntime's `run()` blocks the thread that calls it, which would freeze the window and the Cancel button for seconds at a time). The GPU path through DirectML was tried and fails on this model with an out-of-memory error, so it is not used; for the same reason a `.npmrc` stops `npm install` from downloading onnxruntime's CUDA libraries on Linux. The Linux build has not been run yet. Its tests replace the network with a fake whose six stems add up to the mix exactly, which checks the overlap-add, the seams, the cache and the mixdown sample for sample; one test runs the real model. `npm run e2e` drives the real window with real mouse and keyboard input, splits a generated song with the real model, and checks the saved files add up.
- Audio Tagger's tests also use ffmpeg to make FLAC/OGG/Opus/M4A fixtures if it is installed; otherwise those are skipped.

To test a tool without publishing anything, build its zip; `npm run dev` in the repo root then offers it in the launcher (served from disk).

### Packaging the launcher

```bash
npm run dist:win     # installer + portable exe in dist/
npm run dist:linux   # AppImage + .deb (must run on Linux; CI does it)
```

### Releasing

`.github/workflows/build.yml` does everything from a tag:

1. Bump versions: the launcher in the root `package.json` (the tag must match it), and any tool whose code changed in its own `package.json`. A tool's version going up is what makes the launcher offer **Update** on the tool's card. To ship only a tool update, still bump the launcher's patch number so the tag has a new, matching version; users on an older launcher still receive the tool update, because the catalog is separate from the launcher.
2. Push a tag: `git tag v0.1.0 && git push origin v0.1.0`.
3. CI builds Windows and Linux on native runners, runs all four test suites, then generates `catalog.json` **from the real package files** (download URL, SHA-256, size, launch command) and attaches the installers, the tool zips and the catalog to a GitHub release. If any platform fails to build, nothing is published.

| Tag | Result |
|---|---|
| `v0.1.0` | Normal release. It becomes "latest", so the launcher's built-in catalog URL (`https://github.com/xotwodfr/toolslauncher/releases/latest/download/catalog.json`) now serves it. |
| `v0.1.0-rc1` | Prerelease. Never "latest", so users are unaffected. To try it, set **Settings → Catalog URL** to `https://github.com/xotwodfr/toolslauncher/releases/download/v0.1.0-rc1/catalog.json`. |

The launcher keeps the last good catalog on disk, so it still works offline (with a banner), and falls back to the small catalog bundled in the app (all tools "Coming soon") if it has never been online.

To build a catalog by hand from local zips: `node scripts/build-catalog.js --artifacts <folder> --base-url https://... --out catalog.json --require windows,linux`. For a single tool, `node scripts/register-tool.js <tool-id> --base-url https://...` rewrites that tool's entry in `catalog/catalog.json`.

## How it works

- `catalog/catalog.json` lists tools. Each has per-OS (`windows` / `linux`) `url`, `sha256`, `exec`, `kind` (`zip` or `file`) and optional `args`. A tool with no assets for your OS shows as "Coming soon".
- Install = download → verify the SHA-256 **of the file on disk** → extract to `tools/<id>/<version>` → record in `installed.json`. Zip entries that try to escape the install folder are rejected and truncated downloads are rejected. An update installs the new version next to the old one, then removes the old one on a best-effort basis (a running tool's files can't be deleted on Windows), so an update can never break a working install; leftovers are pruned on the next update or launcher start.
- A hosted catalog is treated as untrusted input: ids, versions, colours and text are validated and malformed entries are dropped, downloads must be `https://`, and a response over 1 MB or slower than 8 seconds is ignored.
- Layout: `src/main/core.js` (install/verify/extract logic, unit-tested), `src/main/main.js` + `preload.js` (Electron shell), `src/renderer/` (UI), `scripts/` (dev catalog, registration, icons, tests).

## Licence

The code in this repository is MIT licensed (see [LICENSE](LICENSE)). Built packages bundle third-party software, including a **GPL** ffmpeg build in Audio Converter: see [THIRD_PARTY.md](THIRD_PARTY.md).
