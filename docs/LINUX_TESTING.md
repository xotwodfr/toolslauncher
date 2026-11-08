# Testing Tools Launcher on Linux

The Linux builds are produced and unit-tested by CI, but they have **not yet been run on a real Linux desktop**. This is a checklist for doing that. The commands and checksums below are for **v0.1.1**; for a newer release, change the version in the URLs and copy the checksum from that release's page.

**You need:** a 64-bit Intel/AMD Linux desktop or VM with a graphical session (Ubuntu 22.04 or 24.04 is ideal). A headless server will not work.

> Details marked *(unconfirmed)* are best knowledge, not something that has been verified on Linux yet.

## 1. Download and verify the launcher

```bash
wget https://github.com/xotwodfr/toolslauncher/releases/download/v0.1.1/ToolsLauncher-0.1.1-linux-x86_64.AppImage
```

```bash
echo "b987cd006a6dfedcf0698c921e5882780366fb63e6f5aea16bc8397cad6d0283  ToolsLauncher-0.1.1-linux-x86_64.AppImage" | sha256sum -c
```

It should print `OK`. Then:

```bash
chmod +x ToolsLauncher-0.1.1-linux-x86_64.AppImage
```

A `.deb` (`ToolsLauncher-0.1.1-linux-amd64.deb`) is published too, but test the AppImage first: it is the simplest.

## 2. Start it from a terminal so errors are visible

```bash
./ToolsLauncher-0.1.1-linux-x86_64.AppImage
```

If it does not start:

- **FUSE error:** `sudo apt install libfuse2` (on Ubuntu 24.04 the package is `libfuse2t64`), or run it with `--appimage-extract-and-run`.
- **Sandbox error** (newer Ubuntu restricts the Chromium sandbox): run it with `--no-sandbox`. *(unconfirmed)* The launcher itself is not started with this flag; only the tools it launches are.
- **Missing library:** note the library name from the error; minimal installs can lack some of the libraries Electron needs.

## 3. What to check

1. **Catalog:** all three tools are listed with their sizes (about 99 MB, 125 MB and 108 MB) and there is **no orange banner** at the top.
2. **Install and Launch** each tool in turn; each should open its own window.
3. **Picture Converter:** drop in a few images and convert to JPEG XL, ICO, PDF and WebP; open the results.
4. **Audio Converter:** convert an MP3 to FLAC or Opus.
5. **Audio Tagger:** open a music file, change the title, save, and reopen it. Also set a cover image.

## 4. Test the update

1. **Settings → Catalog URL:** set it to the old release and press Save:
   ```
   https://github.com/xotwodfr/toolslauncher/releases/download/v0.1.0/catalog.json
   ```
2. Install **Picture Converter** (it will be version 0.1.0) and launch it. Leave it open.
3. In Settings, **clear** the Catalog URL and Save.
4. The Picture Converter card should now show **`v0.1.0 → v0.2.0`** and an **Update to v0.2.0** button.
5. Press it **while the old window is still open**. It should report "updated". Close the old window and launch again: the new one has a long list of output formats.

## 5. If a tool will not open

Run it by hand to see the error. Use **Settings → Open data folder** to find where the launcher keeps its files *(unconfirmed on Linux)*, then:

```bash
cd <data folder>/tools/picture-converter/0.2.0
```

```bash
./picture-converter --no-sandbox
```

## 6. What to report

For anything that fails, note:

- distro and version, and the desktop environment (GNOME, KDE, ...)
- which step failed
- the exact text printed in the terminal

and open an issue at <https://github.com/xotwodfr/toolslauncher/issues>.

## Cleanup

Delete the AppImage and the data folder shown under **Settings → Open data folder**.
