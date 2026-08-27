# 🌐 Ultimate Watch Together — Web Browser Client

> **Zero-install HTML5 & PWA Client for Ultimate Watch Together**  
> Runs on Windows PC, macOS, Linux, Android, and iOS browsers.

---

## 🌟 Features

- **0 MB Streaming Bandwidth**: Plays video files locally from disk.
- **Self-Repairing Playback Sync**: Absolute state (position, paused, rate) over a cloud WebSocket relay, with a leader heartbeat that corrects drift every 3 s. See [../PROTOCOL.md](../PROTOCOL.md).
- **Optional Voice Chat**: WebRTC/PeerJS carries **voice only** — never playback sync. If TURN fails, voice drops but playback and chat keep working.
- **YouTube Vanced Swipe Gestures**: Left-half brightness scrim, Right-half acoustic volume curve.
- **Dual-Audio Channel Switcher**: Web Audio API stereo splitter for Language 1 (Left) and Language 2 (Right) dub routing.
- **External Dub Loader**: Play separate `.mp3`/`.m4a` dub files with millisecond offset sync.
- **Multi-Tab Mobile Experience**: Live Chat, Audio & Subtitles, and Online Users with editable username.
- **Cross-Platform Sync**: Works in the exact same 3-digit room as **Daum PotPlayer (Windows)** and **mpvEx (Android)**!

---

## 🚀 How to Run Locally

```powershell
python -m http.server 8080
```
Then visit `http://localhost:8080` in your browser. Share a room with `?room=582`.

> **When editing this client:** bump the `?v=` query strings on the script and stylesheet
> tags in `index.html`. Without that bump, returning users keep running the old JS from
> their HTTP cache — and a v1 client is silently ignored by v2 peers.
