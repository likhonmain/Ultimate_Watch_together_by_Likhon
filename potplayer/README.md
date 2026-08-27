# 🎬 Daum PotPlayer Synchronizer (Windows)

> **Part of the Ultimate Watch Together Suite by Likhon**  
> Synchronizes Daum PotPlayer on Windows PC with **mpvEx on Android** and **Web Browsers** via 3-digit room codes.

---

## 🌟 Key Features

1. **Native Daum PotPlayer IPC**:
   - Communicates directly with running PotPlayer instances (`PotPlayer64` or `PotPlayer32`) via high-speed Windows API messages (`SendMessageW`).
   - Polls playback time and status in real-time ($<200\text{ms}$).
   - Emits and listens for `play`, `pause`, and `seek` events.
2. **True 4K HDR & Dolby Atmos**:
   - Zero video streaming data — plays local movie files directly from your SSD.
   - Decodes 4K HDR, Dolby Vision, HEVC 10-bit, AC-3, E-AC-3, TrueHD, and DTS-HD with hardware acceleration (DXVA / madVR).
3. **Stream URL & Direct Link Support**:
   - Paste direct `.mp4` or `.m3u8` stream URLs and click **"Open in PotPlayer"** to launch and sync online media.
4. **Unified 3-Digit Room Sync**:
   - Connects to room `582` via the lightweight WebSocket relay server.
   - Syncs seamlessly with **mpvEx (Android)** and **Web Browsers**.
5. **Integrated Live Chat**:
   - Send and receive chat messages across all platforms while watching.

---

## 🚀 Quickstart

### 1. Install Requirements
```powershell
pip install -r requirements.txt
```

### 2. Start the Relay Server (Optional for LAN/Online Sync)
Double-click `start_relay_server.bat` or run:
```powershell
python relay_server.py
```

### 3. Start PotPlayer Synchronizer
Double-click `start_potplayer_sync.bat` or run:
```powershell
python potplayer_sync.py
```

### 4. How to Watch
1. Open your movie in Daum PotPlayer (or click **"Select Local File"** in the sync app).
2. Enter your 3-digit room code (e.g. `582`).
3. Click **"Connect to Room"**.
4. Play, pause, and seek commands will stay synchronized with your friends on PC, Android, and Web!
