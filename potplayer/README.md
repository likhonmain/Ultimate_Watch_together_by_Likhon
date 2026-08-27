# 🎬 Daum PotPlayer Synchronizer (Windows)

> **Part of the Ultimate Watch Together Suite by Likhon**  
> Synchronizes Daum PotPlayer on Windows PC with **mpvEx on Android** and **Web Browsers** via 3-digit room codes.

---

## 🌟 Key Features

1. **Native Daum PotPlayer IPC**:
   - Communicates directly with running PotPlayer instances (`PotPlayer64` or `PotPlayer32`) via high-speed Windows API messages (`SendMessageW`).
   - Polls playback time and status every 250 ms and broadcasts absolute state — position, paused, rate — rather than play/pause events, so a lost packet can never leave the room out of step.
   - Detects seeks by comparing where playback actually landed against where natural playback would have reached.
2. **True 4K HDR & Dolby Atmos**:
   - Zero video streaming data — plays local movie files directly from your SSD.
   - Decodes 4K HDR, Dolby Vision, HEVC 10-bit, AC-3, E-AC-3, TrueHD, and DTS-HD with hardware acceleration (DXVA / madVR).
3. **Stream URL & Direct Link Support**:
   - Paste direct `.mp4` or `.m3u8` stream URLs and click **"Open in PotPlayer"** to launch and sync online media.
4. **Unified 3-Digit Room Sync**:
   - Connects to a room like `582` on the built-in cloud WebSocket relay — no IP address to type, no server to host.
   - Falls back automatically to a plain-`ws` endpoint on networks that break the TLS handshake.
   - Syncs seamlessly with **mpvEx (Android)** and **Web Browsers**.
5. **Integrated Live Chat**:
   - Send and receive chat messages across all platforms while watching.

> **Known limitation:** PotPlayer's documented remote-control message set has no
> playback-rate accessor, so this client always reports and holds 1.0× and ignores
> remote speed changes. Everything else — position, play/pause, seeks, chat — syncs
> fully. Protocol details: [../PROTOCOL.md](../PROTOCOL.md).

---

## 🚀 Quickstart

### 1. Install Requirements
```powershell
pip install -r requirements.txt
```

### 2. Start PotPlayer Synchronizer
Double-click `start_potplayer_sync.bat` or run:
```powershell
python potplayer_sync.py
```

### 3. How to Watch
1. Open your movie in Daum PotPlayer (or click **"Select Local File"** in the sync app).
2. Click **➕ Create Room** to get a fresh 3-digit code, or type a friend's code and click **Join Room**.
3. Play, pause, and seek in PotPlayer as normal — everyone on PC, Android, and Web follows along.

### Running your own relay (optional)
The cloud relay is built in, so this is only for self-hosting. Double-click
`start_relay_server.bat` or run:
```powershell
python relay_server.py
```
Then point `DEFAULT_RELAY_URL` in `potplayer_sync.py` at your own host.
