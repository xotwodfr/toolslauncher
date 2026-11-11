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
| **Music Player** | Pick a folder and play everything in it (MP3, FLAC, OGG, Opus, M4A/AAC, WAV). Albums, artists, folders, search, queue and M3U playlists, with covers, tags and **synced lyrics** (word-synced `.ttml` files that light up word by word, `.lrc` files, or lyrics stored in the tags). Gapless, 10-band equalizer, ReplayGain volume levelling, sleep timer, mini player. It includes a lyrics editor where you tap along to time each line. |
| **Audio Editor** | Cut, trim, join, fade and level out audio on a waveform. Drag to select, press Delete to cut a part out, add more files to join them (with a pause or a crossfade). Fade in and out, normalize to a peak or a loudness target, cut silence from the ends, hear the real result with **Preview**, and save as MP3, M4A, Ogg, Opus, FLAC or WAV. It always writes a new file. |
| **Stem Splitter** | Splits a song into **vocals, drums, bass, guitar, piano and other** with the Demucs model, on your computer and offline. Tick any combination (voice + bass, drums + bass + guitar, everything except the vocals...), hear it live, set each stem's volume, and save it as WAV, FLAC or MP3. Separated songs are kept so re-opening one is instant. |
| **Duplicate Finder** | Finds exact duplicate files (any type), look-alike photos (resized, re-saved or lightly edited) and repeated songs (identical audio, or the same artist, title and length, for example an MP3 and a FLAC). You review every group, mark folders as protected, and move the extras to the Recycle Bin. Nothing is deleted for good. |
| **Image Text Extractor** | Reads the text in screenshots, photos of pages and scans (OCR), offline, in 12 languages. Paste a screenshot with Ctrl+V, draw a box to read only part of a picture, see which words were read and how sure it was, edit the text, then copy it or save it as a .txt file. |
| **Lyrics Maker** | Listens to a song and writes its **lyrics with the time every word is sung**, offline, in 99 languages (the Whisper model). Play the song with the words lighting up karaoke-style, fix any word or time, **tap along** to time words by hand, and save **word-synced `.ttml`** lyrics (the format Apple Music uses; Music Player shows them word by word), a line-timed `.lrc` file, or plain text. Loads `.ttml` and `.lrc` files to fix them. The audio file is never changed. |
| **BPM & Key Finder** | Finds the **tempo and musical key** of songs, a folder at a time, with no internet and no model. See BPM and key (with the Camelot name) and how sure each is, fix a tempo with **÷2 / ×2** or a key from a list, then **write them into the tags** (BPM and Initial Key; musical, Camelot or Open Key names), backed up and verified like Audio Tagger. Also exports a CSV. |
| **Background Remover** | Cuts the subject out of a picture, offline (the ISNet model). Keep it **transparent** or put it on a **colour**, a **blurred copy** of the picture or **another picture**, tune the edge, and fix mistakes with an **erase / restore brush** (zoom and pan, undo). Saves PNG, WebP or JPEG at the original size; the original is never changed. |
| **Video Converter** | Convert to MP4 (H.264), WebM (VP9) or animated GIF. Cap the resolution and frame rate, pick a quality or **aim for a file size** (two-pass, so it lands on the target), trim, drop the sound, strip location metadata. Shows progress and speed, with Cancel. |
| **Text & File Diff** | Compares two texts, two files or two folders. Shows the changes side by side or unified, with the changed words highlighted. You can build a merged version change by change, save a patch or an HTML report, and copy files between folders. |
| **Batch File Renamer** | Renames many files or folders at once with a stack of rules: find & replace (also regex), insert, remove, case, numbering, dates (also the photo's EXIF date), audio tags, extension, spaces, accents. Shows every new name first, blocks clashes and names Windows can't use, and can undo any batch. |
| **Disk Space Visualizer** | Shows **what takes up space** on a drive or in a folder: a **map of boxes** coloured by file type, a sortable folder list with the % of each folder, the **200 largest files** and a file-type summary. Go into folders, then show, open, copy the path or **move to the Recycle Bin** (system folders are refused). Exports CSV. |
| **QR & Barcode Studio** | **Makes QR codes** for text, links, Wi-Fi, contacts (vCard/MeCard), email, SMS, phone, places and calendar events, with colours, rounded or dot styles and a **logo**, and **barcodes** (EAN-13, EAN-8, UPC-A, Code 128, Code 39, ITF) with check digits. Every code is **read back to check it scans**. **Reads** codes from pictures, the clipboard or the screen, several at once, and makes **batches** from a list or CSV. |

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
  <img src="docs/screenshots/lyrics-maker.png" width="32%" alt="Lyrics Maker: the lines of an invented, spoken song with the time of every word, the word being sung highlighted">
  <img src="docs/screenshots/bpm-key-finder.png" width="32%" alt="BPM and Key Finder: eight invented songs with tempo, key, how sure each result is, and what was written to the tags">
  <img src="docs/screenshots/background-remover.png" width="32%" alt="Background Remover: an invented potted plant cut out, on a transparent background, with the brush tools">
  <img src="docs/screenshots/text-diff.png" width="32%" alt="Text and File Diff: two versions of an invented script side by side with the changed words highlighted, and the merged result below">
  <img src="docs/screenshots/file-renamer.png" width="32%" alt="Batch File Renamer: invented holiday photos renamed by the date they were taken, with one screenshot flagged because it has no photo date">
  <img src="docs/screenshots/disk-space.png" width="32%" alt="Disk Space Visualizer: a map of boxes for an invented home folder, coloured by file type, with a disk image selected">
  <img src="docs/screenshots/qr-studio.png" width="32%" alt="QR and Barcode Studio: a Wi-Fi QR code for an invented café with a cup logo in the middle, checked as scanning">
</p>

No tool overwrites your original files. (Music Player never changes a song; when you save lyrics it writes a `.lrc` file next to the song, and keeps any existing one as `.lrc.bak`. Lyrics Maker does the same with `.ttml` and `.lrc` files.)

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

### Lyrics Maker

- **Open a song** (or drop one on the window), choose its language or leave it on *Detect the language*, and press *Make lyrics*. The song is listened to on this computer with [Whisper](https://github.com/openai/whisper) (the "small" model, MIT licence, inside the app), so nothing is uploaded and no internet is needed. Lines appear as they are found, with a progress bar and an estimate, and *Cancel* stops it within a few seconds.
- **Every word gets its own time.** Each word is placed on the audio by following where the model "listens" while it writes it (the same method as whisper-timestamped), and a line starts when its first word starts. The words show under each line and light up one by one as the song plays. In tests with spoken sentences placed at 1, 13 and 26 seconds the lines started at 1.08, 13.08 and 26.12 seconds. Long phrases are cut into lines where the singer pauses or at commas.
- **Check and fix it.** Play the song with the current word highlighted, click ▶ on a line to hear it, edit any text or time (it moves into place, with its words), move everything with the −0.5 / −0.1 / +0.1 / +0.5 s buttons, or select a line and press <kbd>S</kbd> at the moment it begins. *Add line* and × add and remove lines; *Undo all edits* goes back to the lyrics as they were made.
- **Fix single words.** Click a word to jump to it (each word's time shows on the selected line), <kbd>←</kbd> <kbd>→</kbd> pick the next word, <kbd>S</kbd> starts it at the playhead and <kbd>[</kbd> <kbd>]</kbd> nudge it by 0.05 s. Or press **Tap words** and hit <kbd>W</kbd> the moment each word is sung: it runs on from line to line, like a karaoke timing tool. A retyped word keeps its time; when you add or remove words, the line's time is shared out over them and they show in *italics* (estimated) until you tap or stamp them.
- **Save** word-synced lyrics as **TTML** (`.ttml`: one `<span>` with its own begin and end per word, as Apple Music and other karaoke-style players read), a line-timed `.lrc` file, or plain text, next to the song by default so Music Player picks it up. A file being replaced is kept as `.bak`. The extension is always `.ttml`, `.lrc` or `.txt`, so a save can never land on the song itself.
- **Load lyrics file…** opens a `.ttml` (word times kept, including other programs' files with syllables and background vocals) or an `.lrc` (line times; the words are spread over each line until you time them) to fix it.
- **How long it takes.** On a 6-core Ryzen 5 5600X it took between a quarter and a third of the song's length (90 seconds of rap in 20 to 31 seconds, depending on what else the computer was doing), plus a few seconds to load the model; the model needs about 1.5 GB of memory while it works and is released two minutes after the last song. Songs up to 30 minutes.
- **Good to know.** Speech is written down very accurately; **singing over a band is much harder**: expect wrong or missing words, especially with loud instruments, fast rap, heavy accents or a quiet voice, and Whisper sometimes writes a line twice or skips a line. Treat the result as a first draft and fix it in the editor. Instrumental parts are skipped. Choosing the language yourself helps when detection guesses wrong. Words that are sung while the singer holds a note can be timed a little late.
- **Keys:** <kbd>Space</kbd> play/pause, <kbd>S</kbd> stamp the selected word or line at the playhead, <kbd>W</kbd> tap the next word, <kbd>[</kbd> <kbd>]</kbd> nudge, <kbd>Esc</kbd> stop tapping, <kbd>Ctrl</kbd>+<kbd>S</kbd> save the `.ttml`, <kbd>Ctrl</kbd>+<kbd>O</kbd> open a song.

### BPM & Key Finder

- **Add songs or a folder** (or drop them on the window). They are analysed a few at a time in the background, about 1 to 6 seconds for a song of 3 to 5 minutes, with a progress bar and Cancel. There is no model to download: the detection is code in this repository.
- **Tempo.** The beat is found from where new sound arrives, then lined up with the whole song to a tenth of a BPM. Half and double speed are often equally good answers (is it 70 or 140?), so the app offers **÷2** and **×2** next to every tempo; songs slower than about 80 BPM are listed at double speed, as DJs count them. A song whose tempo drifts gets its average and a lower confidence.
- **Key.** The song's notes are collected (after measuring how far the recording is tuned from A = 440 Hz) and compared with the 24 major and minor keys. The key is shown as a name (Am, F#, Bbm) and as a Camelot name (8A, 11B); a list lets you pick another, and its tooltip shows the next most likely ones. The usual mistakes are the relative major or minor (Am vs C) and the neighbouring key.
- **How sure.** Each result shows *clear*, *fair* or *unsure*, in words as well as colour. Songs with clear answers are ticked for you; unsure ones are left for you to look at.
- **Write to tags.** Writes the BPM (a whole number) and the Initial Key (musical, Camelot or Open Key names, as your player or DJ program expects) into MP3, FLAC, Ogg, Opus, M4A, WAV and other tagged files. By default songs that already have a BPM or key keep it; *Replace existing* overwrites. Every write is backed up, read back to check and undone on failure, like Audio Tagger. Audio data is never touched (the tests compare the decoded sound before and after). *Export CSV* saves the results for a spreadsheet.
- **Good to know.** Measured on invented songs with known answers it was exact for every tempo from 84 to 178 BPM and named all 24 keys correctly; real recordings are harder, with live tempo, vocals and rarer chords, so check the ones marked *fair* or *unsure*, and remember the half/double question can only be settled by your ear.

### Background Remover

- **Open a picture** (PNG, JPEG, WebP, BMP, GIF or AVIF, up to 50 megapixels; or drop one on the window). The subject is found on this computer with the IS-Net "general use" model (Apache-2.0, inside the app), so nothing is uploaded; the first picture takes a few seconds longer while the model starts. The window shows the picture at once and the cutout when it is ready.
- **Background:** *Transparent* (shown as a chequerboard), a *Colour* (any colour or a swatch), *Blur* (a blurred copy of the same picture, with a strength slider) or *Picture* (another picture, scaled to fill). Hold *Hold: original* (or <kbd>O</kbd>) to compare with the untouched picture.
- **Edge.** The slider loosens (lets more of the soft edge through) or tightens the cutout; 0 is the model's own edge, and fully solid or fully empty areas never change.
- **Touch-up brush.** *Erase* takes away what the model kept and *Restore* brings back what it removed, with a size slider, undo and redo (<kbd>Ctrl</kbd>+<kbd>Z</kbd>) and a button to remove all strokes. Scroll to zoom up to pixel level, drag to move (hold <kbd>Space</kbd> to move while the brush is on), <kbd>F</kbd> fits the picture. Strokes are kept as shapes, so they are applied again at full size when you save.
- **Save** as PNG, WebP (both keep transparency) or JPEG (needs a background) at the picture's original size. It is always a new file; saving over the original is refused. Opening another picture asks first if you have unsaved touch-ups.
- **How long it takes.** About 1 to 7 seconds a picture on a 6-core Ryzen 5 5600X (the first one also starts the model), using under 1 GB of memory; the model is released 90 seconds after the last picture. It runs on the processor, not the graphics card.
- **Good to know.** The model sees the picture squeezed to 1024 pixels, so very fine detail (single hairs) is as sharp as that view allows, even in a large photo. It works best on a clear main subject; pale subjects on pale backgrounds (white on cream) are its weak spot and may need the brush. Cutting a picture out of a busy scene is guesswork for any model, so look at the edges.
- **Keys:** <kbd>E</kbd> erase, <kbd>R</kbd> restore, <kbd>[</kbd> <kbd>]</kbd> brush size, <kbd>O</kbd> (hold) original, <kbd>F</kbd> fit, <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Y</kbd> undo / redo, <kbd>Ctrl</kbd>+<kbd>S</kbd> save, <kbd>Ctrl</kbd>+<kbd>O</kbd> open.

### Music Player

- **Open a folder** (or drop one on the window). It scans in the background and remembers the result, so the next start is instant. Files it can't play (WMA, APE, AIFF, WavPack...) are counted and reported, not hidden.
- **Lyrics** come from a `Song.ttml` or `Song.lrc` next to the song (when both are there, the newer one), from lyrics stored in the tags (plain, LRC text, or ID3 synced lyrics), or `Song.txt`. Synced lyrics follow the song and you can click a line to jump there. **Word-synced** lyrics (TTML from [Lyrics Maker](#lyrics-maker) or Apple-Music-style files, and enhanced LRC with `<mm:ss.xx>` word times) fill in word by word as they are sung, and clicking a word plays from it. **Edit lyrics** lets you type them and tap *Stamp* as each line is sung (it writes `Song.lrc`, and leaves a `.ttml` alone).
- **Tags are read-only here.** *Edit tags in Audio Tagger* opens the song in [Audio Tagger](#tools) if you have installed it from the launcher.
- **Keys:** <kbd>Space</kbd> play/pause, <kbd>N</kbd> / <kbd>P</kbd> next / previous, <kbd>←</kbd> <kbd>→</kbd> seek 5 s (<kbd>Shift</kbd> 30 s), <kbd>Ctrl</kbd>+<kbd>↑</kbd> <kbd>↓</kbd> volume, <kbd>M</kbd> mute, <kbd>S</kbd> shuffle, <kbd>R</kbd> repeat, <kbd>L</kbd> lyrics, <kbd>Q</kbd> queue, <kbd>/</kbd> search. In a list: <kbd>Enter</kbd> plays, <kbd>Delete</kbd> removes (queue and playlists), <kbd>Alt</kbd>+<kbd>↑</kbd> <kbd>↓</kbd> reorders. The keyboard media keys work too.
- **Gapless:** the next song is loaded in advance and started 25 ms before the current one ends. Measured with the end-to-end test: no silence and no overlap between two WAV files over 40 consecutive hand-overs. MP3 and AAC files only play gaplessly as far as their own encoder-delay information allows.

### Text & File Diff

- **Texts, files and folders.** Paste into two boxes or open (or drop) two files. The view is side by side or unified, with line numbers, highlights for the changed words or characters, jumping between changes (<kbd>F7</kbd> / <kbd>Shift</kbd>+<kbd>F7</kbd>), and both sides scrolling together. Big files (100,000 lines and more) are compared in the background and only the visible lines are drawn.
- **Knows what a file is.** It reads UTF-8 (with or without BOM) and UTF-16 LE/BE, and shows the line endings (LF, CRLF, mixed). Whitespace, letter case and line endings can be ignored. Other files are compared by SHA-256 and shown as "binary files differ / are identical".
- **Merge.** For each change, pick the left or the right version. You can edit the result, then save it as a new file or overwrite one side. Overwriting asks first and keeps the old file as `.bak`. Files are written through a `.part` file and keep their encoding.
- **Export.** A unified `.patch` (always made from the exact texts, so it applies back cleanly) and a self-contained HTML report.
- **Folders.** Compares two folders with their sub-folders, either quickly by size and date or exactly by content (SHA-256). Each file is marked same, different, only left or only right. Ignore patterns skip things like `node_modules` and `.git`. Double-click a pair to open it in the text view. You can copy chosen files left→right or right→left; a file that gets replaced goes to the Recycle Bin, and nothing is ever deleted.

### Batch File Renamer

- **Rules you can stack.** Find & replace (plain text or regular expressions with `$1` groups, first or every match, case options), insert text, remove characters (a range, first/last N, digits, symbols), change case (lower, UPPER, Title, Sentence, camelCase, kebab-case, snake_case), numbering (start, step, digits, position, restart per folder), a date (modified, created, or when the photo was taken, from EXIF) with your own format, audio tags (`{track} - {artist} - {title}`…), the extension, extra spaces, and accents. Turn rules on and off and reorder them; save a set of rules as a preset.
- **See it before it happens.** Every file shows its current and new name, updated as you type. Problems are marked on the row: two files getting the same name, a name already taken in the folder, characters or names Windows can't use (CON, PRN…, trailing dots), names that are too long. *Rename* stays off until they are fixed, or let it add (2), (3)….
- **Careful renaming.** Swaps (a→b, b→a), chains and case-only changes (photo.JPG → photo.jpg on Windows) go through temporary names. Files inside a renamed folder are handled first. If something fails half way, everything is put back.
- **Undo, also later.** Every batch is written to a journal before the first rename. *History* lists the last batches, also after a restart. Undo first checks that each file is still where it was left, and can undo only the files that are. An interrupted batch is detected the next time the app starts and can be put back.

### Disk Space Visualizer

- **Pick a drive or a folder** (or drop one on the window). The drives are listed with their free space. The scan runs in the background with live progress, a map that fills in as files are found, and *Cancel*, which keeps what was found so far. About 80,000 files take 1.5 s.
- **Counted honestly.** It measures the space files take on the disk (not just their length). Links and junctions are never followed, so nothing is counted twice and there are no loops. A file with several hard links counts once. By default the scan stays on the chosen drive. Folders it may not read are counted and listed.
- **Four views.** A map where each box is a file or folder sized by its space and coloured by type (video, audio, pictures, archives, code, documents, programs, other); hover for the path, click a folder's name bar to go in, and use the path bar or <kbd>Backspace</kbd> to go back. A folder list sortable by name, size or file count, with the % of the parent. The 200 largest files. A summary by type and by extension.
- **Clean up safely.** For a selected item: *Show in folder*, *Open* (programs are never started), *Copy path*, *Rescan this folder*, and **Move to Recycle Bin**, which asks first and shows the size. Windows, Program Files, /usr, /etc, drive roots and your user folder itself are refused. Nothing is ever deleted for good.
- **Export CSV** of the current folder, the largest files or the types.

### QR & Barcode Studio

- **Make a QR code** for text, a link, a Wi-Fi network, a contact (vCard 3.0 or MeCard), an email, a text message, a phone number, a place or a calendar event. Special characters are escaped the way phones expect. Choose the error correction level, margin, colours, square, rounded or dot modules, and a logo in the middle (level H is then used and the logo stays under 20 % of the code). Low contrast, inverted colours and a see-through background get a plain warning.
- **It checks itself.** Every code you make is drawn to pixels and read back by the app's own reader, and you see "it scans and reads back exactly" or what to change. Save as PNG (any size) or SVG, or copy the picture.
- **Barcodes:** EAN-13, EAN-8 and UPC-A (the check digit is added, or checked and explained when it is wrong), Code 128, Code 39 (optional check character) and ITF, with the text under the bars.
- **Read codes** from a picture (open, drop or paste with <kbd>Ctrl</kbd>+<kbd>V</kbd>) or from the screen. Several codes per picture are outlined and numbered. Each shows what it holds: a Wi-Fi network with its password and *Copy* buttons, a contact's fields, an event, a product number with its check digit. Links are shown and never opened by themselves (*Open link…* asks first).
- **Batch:** paste a list or open a CSV (content, and optionally a file name). It makes a folder of PNG and/or SVG files without ever replacing an existing file, and explains any line that could not be made.

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
- BPM & Key Finder bundles ffmpeg (`npm run setup`) and has no models: `src/analyse.js` is the whole detector (a small FFT, a log-mel onset envelope, an autocorrelation comb and beat-grid refinement for tempo; spectral peaks, a tuning estimate and the Krumhansl-Kessler and Temperley profiles for key) and runs in a worker pool. Its tests render invented songs with a known tempo and key (`src/synth.js`: drums, bass, chords, a melody), including no drums, drums only, noise, a detuned recording and a drifting tempo, and write BPM and key tags into FLAC, MP3, M4A, Ogg and WAV files made by ffmpeg, checking the decoded audio is identical afterwards.
- Background Remover runs the ISNet model (`npm run setup` downloads it, ~170 MB, checked against a pinned SHA-256) with `onnxruntime-node` in a worker thread. The window does the decoding, resizing and compositing on canvas; the main process only reads and saves bytes and runs the model. **Never terminate that worker while onnxruntime is inside `run()`: it takes the whole process down** (measured). Cancel therefore abandons the result and lets the thread finish, and releasing goes through a message. Its tests cut out an invented picture whose true outline is known (`src/scene.js`) and compare, and its window test saves PNG, JPEG and WebP and reads the pixels back.
- Lyrics Maker bundles ffmpeg and the Whisper small model (`npm run setup` downloads ~250 MB from [onnx-community/whisper-small_timestamped](https://huggingface.co/onnx-community/whisper-small_timestamped) at a pinned revision, each file checked against a pinned SHA-256). `src/mel.js` is Whisper's audio front end, `src/whisper.js` the decoder (timestamp rules, 30 second windows, fallbacks, word times from cross-attention and dynamic time warping), run in a worker thread with the same never-kill-mid-run rule. Its tests make spoken clips with the voices that come with Windows, or with espeak-ng where it is installed (`src/speech.js`), whose words and timing are known; without either those tests are skipped. Everything else (front end, rules, timing maths, lyric lines and word times, `.ttml` and `.lrc` files) runs everywhere.
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
