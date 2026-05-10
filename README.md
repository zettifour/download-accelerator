# Download Accelerator

A Chrome extension that speeds up downloads by splitting files into multiple parts and fetching them simultaneously over parallel connections — similar to IDM or JDownloader, built right into Chrome.

---

## Features

- **Parallel connections** — split each file into pieces, download simultaneously (up to 16 connections per file)
- **Multiple concurrent downloads** — run several downloads at once
- **Pause & resume** — stop and continue any download at any time
- **Real-time progress** — per-connection speed lanes, live speed and ETA
- **Right-click download** — "Download with Download Accelerator" on any link
- **Intercept mode** — optionally capture all browser downloads automatically
- **Custom download folder** — choose where files are saved per session

---

## Two Modes

### Browser Mode *(no installation required)*
Works out of the box. Downloads are handled directly in the browser using the Fetch API with Range requests.

### Native Mode *(optional, recommended)*
A small native helper app opens true parallel TCP connections over HTTP/1.1, bypassing Chrome's HTTP/2 multiplexing for maximum speed. Supports authenticated downloads by forwarding session cookies.

---

## Installation

### 1. Chrome Extension

Install from the [Chrome Web Store](#) *(link coming soon)* or load unpacked:

1. Download or clone this repository
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** → select this folder

### 2. Native Host *(optional)*

#### macOS
```bash
cd native_host
./install.sh YOUR_EXTENSION_ID
```

To build the binary yourself (requires [Homebrew Python](https://brew.sh)):
```bash
cd native_host
./build.sh
./install.sh YOUR_EXTENSION_ID
```

#### Windows
```bat
cd native_host
build.bat
install.bat YOUR_EXTENSION_ID
```

> **Where is the Extension ID?**  
> Open `chrome://extensions`, enable Developer mode — the ID is shown below the extension name.

---

## Uninstalling the Native Host

#### macOS
```bash
cd native_host
./uninstall.sh
```

#### Windows
```bat
cd native_host
uninstall.bat
```

---

## Building from Source

### Requirements
- **macOS:** Homebrew Python 3 (`brew install python`)
- **Windows:** Python 3 from [python.org](https://www.python.org)
- PyInstaller and requests are installed automatically by the build scripts

### Build
```bash
# macOS
cd native_host && ./build.sh

# Windows
cd native_host && build.bat
```

The binary is written to `native_host/dist/`.

---

## Supported File Types

Archives (`zip`, `rar`, `7z`, `tar`, `gz`, `tgz` …), videos (`mp4`, `mkv`, `mov`, `avi` …), audio (`mp3`, `flac`, `wav` …), disk images (`iso`, `dmg`, `img` …), documents (`pdf`, `docx`, `xlsx` …), installers (`exe`, `msi`, `pkg`, `deb`, `rpm` …), and many more.

---

## Privacy

No data is collected, stored remotely, or shared with third parties.  
→ [Privacy Policy](https://zettifour.github.io/download-accelerator/privacy-policy.html)

---

## License

MIT
