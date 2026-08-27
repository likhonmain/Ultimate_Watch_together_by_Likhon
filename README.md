# 🚀 Ultimate Watch Together by Likhon

> **The Universal Multi-Platform Co-Watching Suite.**  
> Synchronize movie playback seamlessly across **Daum PotPlayer (Windows PC)**, **mpvEx (Android Mobile)**, and **Web Browsers (HTML5 / PWA)** with 0 MB video bandwidth and native Dolby / DTS audio support.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)
[![Platforms](https://img.shields.io/badge/Platforms-Windows_|_Android_|_Web-emerald?style=for-the-badge)](#-the-tri-platform-ecosystem)
[![Bandwidth](https://img.shields.io/badge/Video_Data-0_MB_(Local_Storage)-gold?style=for-the-badge)](#-how-it-works)

---

## 🌟 Overview: The Problem Solved

Traditional co-watching websites require uploading video files to central cloud servers, which causes:
- ❌ Massive mobile data usage (gigabytes transferred).
- ❌ Long buffering pauses and low resolution downscaling.
- ❌ Broken audio in mobile browsers (loss of Dolby AC-3, E-AC-3, and DTS tracks).

**Ultimate Watch Together** solves this by separating **Media Decoding** from **Playback Synchronization**:
1. **Pristine Local Playback**: Each device plays the local video file (`.mkv`, `.mp4`) directly from device storage (SSD or phone internal memory).
2. **Universal Sync Protocol**: A lightweight WebSocket relay coordinates absolute playback state and chat across every device. Sub-second alignment, self-repairing after any dropped packet — see [PROTOCOL.md](PROTOCOL.md).

---

## 🌐 The Tri-Platform Ecosystem

```
                       ┌────────────────────────────────────────┐
                       │     Unified Watch Together Network     │
                       │           (3-Digit Room: 582)          │
                       └───────────────────┬────────────────────┘
                                           │
          ┌────────────────────────────────┼────────────────────────────────┐
          │                                │                                │
          ▼                                ▼                                ▼
┌───────────────────┐            ┌───────────────────┐            ┌───────────────────┐
│ Windows PC        │            │ Android Mobile    │            │ Web Browser       │
│ Daum PotPlayer    │            │ mpvEx App         │            │ HTML5 / PWA       │
│                   │            │                   │            │                   │
│ • Heavy 4K HDR    │            │ • Native AC-3/DTS │            │ • Zero install    │
│ • Dolby Atmos     │            │ • Dual Dub Switch │            │ • iPhone / Mac    │
│ • Local File/URL  │            │ • libmpv Engine   │            │ • Vanced Gestures │
└───────────────────┘            └───────────────────┘            └───────────────────┘
```

---

## 📁 Repository Structure

| Folder | Platform | Description |
| :--- | :--- | :--- |
| [📂 `browser/`](./browser/) | **Web (All Devices)** | Modern HTML5 PWA client with YouTube Vanced gestures, acoustic volume curve, and Web Audio API stereo dub routing. |
| [📂 `potplayer/`](./potplayer/) | **Windows PC** | High-performance Python bridge communicating via Windows API (`SendMessageW`) with Daum PotPlayer. |
| [📂 `mpvEx/`](./mpvEx/) | **Android Mobile** | Modern Android app built with Kotlin + Jetpack Compose on top of `libmpv`, playing AC-3, E-AC-3, 4K HEVC with hardware acceleration. |

---

## ⚡ Key Highlights

### 1. Unified 3-Digit Room Codes
Connect with a clean, 3-digit pin code (e.g. `582`). Everyone in the room stays synchronized regardless of which client they use:
* You on **PotPlayer (Windows)**
* Friend A on **mpvEx (Android)**
* Friend B on **Safari / Chrome (Web)**

### 2. Full Dolby AC-3, E-AC-3 & Multi-Dub Support
* **On Android (via `mpvEx`)**: Full hardware decoding of Dolby Digital (`AC-3`), Dolby Digital Plus (`E-AC-3`), DTS, and TrueHD with 1-tap dual audio switching.
* **On PC (via PotPlayer)**: Uncompromised cinema surround sound with madVR and hardware decoding.
* **On Web (via `browser`)**: Dual-audio channel routing via Web Audio API and external dub track loading with delay offset.

### 3. Dual Playback Modes
* **Mode A: Offline Local File (0 MB Data Usage)**: Zero streaming bandwidth, maximum picture quality.
* **Mode B: Direct Stream URLs**: Paste direct `.mp4` or `.m3u8` HLS streams — supported across all three clients.

### 4. Real-time In-App Live Chat
Send and receive chat messages in real time across PotPlayer, mpvEx, and Web browsers.
On Android the chat is available **inside the player** as a collapsible bubble with an
unread badge, so you never have to leave playback to talk.

### 5. Self-Repairing Sync
Sync is **state based**, not event based: clients exchange absolute position + paused +
rate rather than "play"/"pause" commands, and the elected room leader re-broadcasts
state every 3 seconds. A dropped, late or duplicated packet therefore cannot leave the
room out of step — the next state simply overwrites it. Full details in
[PROTOCOL.md](PROTOCOL.md).

---

## 🚀 Quickstart Guides

### 1. Running the Web Browser Client
```powershell
cd browser
python -m http.server 8080
# Open http://localhost:8080 in your browser
```

Or just use the hosted PWA — no install required.

### 2. Running the PotPlayer Synchronizer (Windows)
The cloud relay is built in, so there is nothing to host and no IP address to type:
```powershell
cd potplayer
pip install -r requirements.txt
python potplayer_sync.py
```
Open Daum PotPlayer, load your video, then Create or Join a 3-digit room.

> `relay_server.py` is only needed if you want to run your **own** relay instead of the
> bundled cloud one (`python relay_server.py`).

### 3. Building the mpvEx Android App
```bash
cd mpvEx
./gradlew assembleStandardDebug
```
The APKs land in `mpvEx/app/build/outputs/apk/standard/debug/` — debug-signed, so they
install directly with no keystore. Grab `app-standard-universal-debug.apk` if you are
unsure which ABI your phone uses, or `app-standard-arm64-v8a-debug.apk` for any modern
device.

> If Gradle reports *"SDK location not found"* even though `local.properties` looks
> right, the file has a UTF-8 BOM — re-save it without one.

---

## 📄 License
This project is open-source under the [MIT License](LICENSE).  
The `mpvEx` Android client is licensed under GPLv3 as an open-source fork.

---
*Architected and crafted with precision by Likhon.*
