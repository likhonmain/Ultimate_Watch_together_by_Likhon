#!/usr/bin/env python3
"""
Ultimate Watch Together — Dedicated Daum PotPlayer Synchronizer (Windows)

Synchronised co-watching between Daum PotPlayer on Windows, mpvEx on Android and
web browsers, using 3-digit room codes.

Speaks protocol v2 — see PROTOCOL.md. The short version:
  * one transport (the WebSocket relay), no second peer-to-peer path
  * every packet carries a stable `sid` and a monotonic `seq`, so our own echoes
    and reordered packets get dropped instead of applied
  * playback sync is state based (absolute position + paused + rate), never
    play/pause events, so a lost or late packet cannot leave the room skewed
  * the elected leader re-broadcasts state every 3 s, repairing any drift
  * echo suppression is a timestamp deadline, not a boolean flag
"""

import os
import time
import json
import random
import string
import asyncio
import threading
import subprocess
import ctypes
import tkinter as tk
from tkinter import ttk, messagebox, filedialog

# Cloud WebSocket relay. The plain-ws endpoint is the fallback for networks that
# break the TLS handshake.
DEFAULT_RELAY_URL = "wss://138-68-159-46.sslip.io/ws"
FALLBACK_RELAY_URL = "ws://138.68.159.46:8765"

PROTOCOL_VERSION = 2
PLATFORM_TAG = "potplayer"

# Mute budgets, in seconds — how long our own player changes stay un-broadcast
# after we apply something remote.
MUTE_SIMPLE = 0.60
MUTE_SEEK = 2.50
MUTE_SEEK_SETTLED = 0.45
MUTE_HEARTBEAT = 0.90

HEARTBEAT_S = 3.0
HELLO_S = 10.0
CLOCK_PING_S = 5.0
RELAY_PING_S = 15.0
PEER_TIMEOUT_S = 25.0
POLL_S = 0.25

# PotPlayer is driven over SendMessage and seeks by keyframe, so it cannot hold
# the 0.3 s tolerance the browser uses without thrashing. These are the smallest
# values that stay stable in practice.
TOL_EXPLICIT = 0.80
TOL_HEARTBEAT = 1.50

# How close the playhead has to get to a requested seek before we call it landed.
SEEK_SETTLE_MS = 700.0
# A change this large with the player paused can only be a user scrub. While
# playing we need a looser bar, because the poll interval itself jitters.
JUMP_PAUSED_MS = 400.0
JUMP_PLAYING_MS = 1200.0

# No Win32 call may block the caller longer than this. PotPlayer stops pumping
# messages while it decodes a heavy seek, and an unbounded SendMessageW there
# would stall the asyncio loop along with every send queued on it.
IPC_TIMEOUT_MS = 400
# A cached snapshot older than this is treated as unknown rather than reused.
SNAPSHOT_MAX_AGE_S = 3.0

# Optional websockets package for room-based sync with mpvEx and Web
try:
    import websockets
    HAS_WEBSOCKETS = True
except ImportError:
    HAS_WEBSOCKETS = False

# Windows Constants for PotPlayer Remote API
WM_USER = 0x0400
POT_GET_TOTAL_TIME = 0x5002    # Total duration in ms
POT_GET_CURRENT_TIME = 0x5004  # Current position in ms
POT_SET_CURRENT_TIME = 0x5005  # Set position (lParam = ms)
POT_GET_PLAY_STATUS = 0x5006   # 0: Stopped, 1: Paused, 2: Running
POT_SET_PLAY_STATUS = 0x5007   # 0: Toggle, 1: Pause, 2: Play

SMTO_ABORTIFHUNG = 0x0002

user32 = ctypes.windll.user32

# Declared explicitly: with the default ctypes signatures a 64-bit HWND is
# truncated to a C int, and lParam is passed at the wrong width.
user32.FindWindowW.restype = ctypes.c_void_p
user32.FindWindowW.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p]
user32.SendMessageTimeoutW.restype = ctypes.c_long
user32.SendMessageTimeoutW.argtypes = [
    ctypes.c_void_p,                  # hWnd
    ctypes.c_uint,                    # Msg
    ctypes.c_void_p,                  # wParam
    ctypes.c_void_p,                  # lParam
    ctypes.c_uint,                    # fuFlags
    ctypes.c_uint,                    # uTimeout
    ctypes.POINTER(ctypes.c_void_p),  # lpdwResult
]


def new_sid():
    """Stable per-process identity used to recognise our own echoes."""
    alphabet = string.ascii_lowercase + string.digits
    return "p" + "".join(random.choice(alphabet) for _ in range(8))


def now_ms():
    return int(time.time() * 1000)


class PotPlayerController:
    """Interacts with Daum PotPlayer via Windows Messages (IPC)"""

    def __init__(self):
        self.hwnd = None
        self.potplayer_exe = self._locate_potplayer_binary()
        # Timestamp deadline, not a boolean: nested applies can only extend it.
        self._mute_until = 0.0
        self._lock = threading.Lock()
        # Last reading taken by the poll thread, so callers on the asyncio loop
        # can read playback state without making a blocking Win32 call.
        self._cache = None
        self._cache_lock = threading.Lock()

    # -- echo suppression ---------------------------------------------------

    def mute(self, seconds):
        with self._lock:
            until = time.time() + seconds
            if until > self._mute_until:
                self._mute_until = until

    def mute_settled(self, seconds):
        """Shorten the window once we know the operation already landed."""
        with self._lock:
            until = time.time() + seconds
            if until < self._mute_until:
                self._mute_until = until

    @property
    def is_muted(self):
        return time.time() < self._mute_until

    # -- discovery ----------------------------------------------------------

    def _locate_potplayer_binary(self):
        """Find PotPlayer64.exe or PotPlayer.exe on system"""
        common_paths = [
            r"C:\Program Files\DAUM\PotPlayer\PotPlayer64.exe",
            r"C:\Program Files (x86)\DAUM\PotPlayer\PotPlayer.exe",
            r"C:\Program Files\PotPlayer\PotPlayer64.exe",
            r"D:\Program Files\DAUM\PotPlayer\PotPlayer64.exe"
        ]
        for p in common_paths:
            if os.path.exists(p):
                return p
        return "PotPlayer64.exe"

    def find_window(self):
        """Find active PotPlayer window handle"""
        hwnd = user32.FindWindowW("PotPlayer64", None)
        if not hwnd:
            hwnd = user32.FindWindowW("PotPlayer", None)
        self.hwnd = hwnd
        return hwnd

    def _ipc(self, wparam, lparam=0):
        """One bounded PotPlayer message. Returns None if it did not get through.

        Never uses plain SendMessageW: that blocks for as long as PotPlayer's UI
        thread is busy, which is exactly what happens during a seek.
        """
        hwnd = self.find_window()
        if not hwnd:
            return None
        out = ctypes.c_void_p(0)
        ok = user32.SendMessageTimeoutW(hwnd, WM_USER, wparam, lparam,
                                       SMTO_ABORTIFHUNG, IPC_TIMEOUT_MS,
                                       ctypes.byref(out))
        if not ok:
            return None
        return int(out.value or 0)

    # -- reads --------------------------------------------------------------

    def snapshot(self):
        """(status, position_ms, duration_ms) in one pass. Blocking — poll thread only.

        This is the only read path. There deliberately are no single-value
        accessors: every caller outside the poll thread must use
        `cached_snapshot()` so it cannot block the asyncio loop.
        """
        status = self._ipc(POT_GET_PLAY_STATUS)
        if status is None:
            self._store_snapshot(-1, 0, 0)
            return -1, 0, 0
        pos = self._ipc(POT_GET_CURRENT_TIME) or 0
        total = self._ipc(POT_GET_TOTAL_TIME) or 0
        self._store_snapshot(status, pos, total)
        return status, pos, total

    def _store_snapshot(self, status, pos, total):
        with self._cache_lock:
            self._cache = (status, pos, total, time.time())

    def cached_snapshot(self):
        """The poll thread's last reading, with the playhead advanced to now.

        Used by the asyncio loop so that applying a remote state never makes a
        blocking Win32 call. Returns (-1, 0, 0) when there is no fresh reading.
        """
        with self._cache_lock:
            cached = self._cache
        if not cached:
            return -1, 0, 0
        status, pos, total, at = cached
        age = time.time() - at
        if age > SNAPSHOT_MAX_AGE_S:
            return -1, 0, 0
        if status == 2:
            pos = int(pos + age * 1000.0)
            if total > 0:
                pos = min(pos, total)
        return status, pos, total

    # -- writes -------------------------------------------------------------

    def set_time_ms(self, time_ms):
        self._ipc(POT_SET_CURRENT_TIME, int(max(0, time_ms)))

    def play(self):
        self._ipc(POT_SET_PLAY_STATUS, 2)

    def pause(self):
        self._ipc(POT_SET_PLAY_STATUS, 1)

    def open_media(self, path_or_url):
        """Launch or load media file/URL inside PotPlayer"""
        try:
            subprocess.Popen([self.potplayer_exe, path_or_url])
            return True
        except Exception as e:
            print(f"[PotPlayer] Launch error: {e}")
            return False


class ClockEstimate:
    """EMA-smoothed clock offset and round-trip time for one peer."""

    def __init__(self):
        self.offset_ms = 0.0
        self.rtt_ms = 0.0
        self.samples = 0

    def add_sample(self, t0, t1, t3):
        rtt = t3 - t0
        if rtt < 0 or rtt > 2000:
            return False
        offset = t1 - (t0 + t3) / 2.0
        if self.samples == 0:
            self.offset_ms = offset
            self.rtt_ms = rtt
        else:
            a = 0.3
            self.offset_ms = self.offset_ms * (1 - a) + offset * a
            self.rtt_ms = self.rtt_ms * (1 - a) + rtt * a
        self.samples += 1
        return True


class UltimatePotPlayerApp:
    """Dark-themed UI for PotPlayer synchronization"""

    def __init__(self, root):
        self.root = root
        self.root.title("Ultimate Watch Together — Daum PotPlayer Sync")
        self.root.geometry("640x600")
        self.root.configure(bg="#0f172a")

        self.pot = PotPlayerController()
        self.is_connected = False
        self.is_host = False
        self.ws = None
        self.loop = None
        self.room_code = "582"
        self.username = f"PC_User_{os.getpid() % 1000}"

        # Protocol v2 session state
        self.sid = new_sid()
        self._seq = 0
        self._seq_lock = threading.Lock()
        self.last_seq = {}
        self.peers = {}
        self.clocks = {}
        self.my_relay_id = None
        self.relay_peer_count = 1
        self.want_connection = False
        self.reconnect_attempts = 0
        self.use_fallback = False
        self._chat_fingerprint = (None, 0.0)

        # Local playback baselines for change detection
        self.last_status = -1
        self.last_time_ms = 0
        self.last_poll_at = time.time()
        self.is_monitoring = True
        # Set while a seek we requested is still landing; see _poll_once.
        self.seek_settle = None
        # PotPlayer cannot change speed, so we mirror the room's rate instead.
        self.room_rate = 1.0

        self._last_hello = 0.0
        self._last_heartbeat = 0.0
        self._last_clock_ping = 0.0

        self._setup_styles()
        self._build_ui()
        self._start_potplayer_monitor()

    # ---------------------------------------------------------------- styling

    def _setup_styles(self):
        style = ttk.Style()
        style.theme_use('clam')
        style.configure(".", background="#0f172a", foreground="#f8fafc", font=("Segoe UI", 9))
        style.configure("TFrame", background="#0f172a")
        style.configure("Card.TFrame", background="#1e293b", relief="flat")
        style.configure("TLabel", background="#0f172a", foreground="#f8fafc")
        style.configure("Card.TLabel", background="#1e293b", foreground="#cbd5e1")
        style.configure("Header.TLabel", background="#0f172a", foreground="#ffffff", font=("Segoe UI", 12, "bold"))
        style.configure("Status.TLabel", background="#1e293b", font=("Segoe UI", 10, "bold"))
        style.configure("Primary.TButton", background="#6366f1", foreground="#ffffff", font=("Segoe UI", 9, "bold"), borderwidth=0)
        style.map("Primary.TButton", background=[("active", "#4f46e5")])

    def _build_ui(self):
        main = ttk.Frame(self.root, padding="16")
        main.pack(fill=tk.BOTH, expand=True)

        # Header
        hdr = ttk.Frame(main)
        hdr.pack(fill=tk.X, pady=(0, 12))
        ttk.Label(hdr, text="🎬 Ultimate Watch Together", style="Header.TLabel").pack(side=tk.LEFT)
        ttk.Label(hdr, text="Daum PotPlayer Sync", foreground="#818cf8", font=("Segoe UI", 9)).pack(side=tk.LEFT, padx=8)

        # Card 1: Room Connection (relay is built in, no server IP entry)
        c1 = ttk.Frame(main, style="Card.TFrame", padding="12")
        c1.pack(fill=tk.X, pady=6)

        c1_top = ttk.Frame(c1, style="Card.TFrame")
        c1_top.pack(fill=tk.X)
        ttk.Label(c1_top, text="Room Code (3-Digit):", style="Card.TLabel").pack(side=tk.LEFT)
        self.entry_room = tk.Entry(c1_top, bg="#0f172a", fg="#38bdf8", insertbackground="#ffffff",
                                   font=("Consolas", 12, "bold"), width=8, justify="center")
        self.entry_room.insert(0, "582")
        self.entry_room.pack(side=tk.LEFT, padx=(8, 10))

        self.btn_create_room = tk.Button(c1_top, text="➕ Create Room", bg="#10b981", fg="#ffffff",
                                         font=("Segoe UI", 9, "bold"), relief="flat", padx=10, pady=3,
                                         command=self.create_room)
        self.btn_create_room.pack(side=tk.LEFT, padx=4)

        self.btn_join_room = tk.Button(c1_top, text="Join Room", bg="#6366f1", fg="#ffffff",
                                       font=("Segoe UI", 9, "bold"), relief="flat", padx=12, pady=3,
                                       command=self.join_room)
        self.btn_join_room.pack(side=tk.LEFT, padx=4)

        self.lbl_net_status = ttk.Label(c1, text="● Not Connected", foreground="#ef4444", style="Status.TLabel")
        self.lbl_net_status.pack(anchor="w", pady=(8, 0))

        # Card 2: PotPlayer Status & Media Launcher
        c2 = ttk.Frame(main, style="Card.TFrame", padding="12")
        c2.pack(fill=tk.X, pady=6)

        ttk.Label(c2, text="PotPlayer Status:", style="Card.TLabel", font=("Segoe UI", 9, "bold")).pack(anchor="w")
        self.lbl_pot_status = ttk.Label(c2, text="Searching for PotPlayer window...", foreground="#94a3b8", style="Card.TLabel")
        self.lbl_pot_status.pack(anchor="w", pady=(2, 8))

        # Media controls (Local File & URL Stream)
        c2_media = ttk.Frame(c2, style="Card.TFrame")
        c2_media.pack(fill=tk.X, pady=4)

        btn_browse = tk.Button(c2_media, text="📁 Select Local File", bg="#334155", fg="#ffffff",
                               relief="flat", padx=8, pady=3, command=self.browse_local_file)
        btn_browse.pack(side=tk.LEFT, padx=(0, 6))

        self.entry_url = tk.Entry(c2_media, bg="#0f172a", fg="#cbd5e1", insertbackground="#ffffff",
                                  font=("Segoe UI", 9))
        self.entry_url.insert(0, "Paste Stream URL (e.g. .mp4 / .m3u8)")
        self.entry_url.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=4)

        btn_load_url = tk.Button(c2_media, text="Open in PotPlayer", bg="#0284c7", fg="#ffffff",
                                 font=("Segoe UI", 9, "bold"), relief="flat", padx=8, pady=3,
                                 command=self.load_stream_url)
        btn_load_url.pack(side=tk.LEFT, padx=(6, 0))

        # Card 3: Live Chat Stream (Multi-Platform with Browser & mpvEx)
        c3 = ttk.Frame(main, style="Card.TFrame", padding="12")
        c3.pack(fill=tk.BOTH, expand=True, pady=6)

        ttk.Label(c3, text="Live Chat (Synced with mpvEx & Browser):", style="Card.TLabel", font=("Segoe UI", 9, "bold")).pack(anchor="w")
        self.txt_chat = tk.Text(c3, bg="#0f172a", fg="#f8fafc", font=("Segoe UI", 9),
                                relief="flat", height=8, state=tk.DISABLED)
        self.txt_chat.pack(fill=tk.BOTH, expand=True, pady=(4, 6))

        c3_send = ttk.Frame(c3, style="Card.TFrame")
        c3_send.pack(fill=tk.X)
        self.entry_chat = tk.Entry(c3_send, bg="#0f172a", fg="#ffffff", insertbackground="#ffffff", font=("Segoe UI", 9))
        self.entry_chat.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 6))
        self.entry_chat.bind("<Return>", lambda e: self.send_chat_message())

        btn_send = tk.Button(c3_send, text="Send", bg="#6366f1", fg="#ffffff",
                             font=("Segoe UI", 9, "bold"), relief="flat", padx=12, command=self.send_chat_message)
        btn_send.pack(side=tk.RIGHT)

    # ------------------------------------------------------------ media open

    def browse_local_file(self):
        path = filedialog.askopenfilename(
            title="Select Video File",
            filetypes=[("Video Files", "*.mkv *.mp4 *.webm *.avi *.mov *.ts"), ("All Files", "*.*")]
        )
        if path:
            self.pot.open_media(path)
            self._log_chat("System", f"Loaded local file: {os.path.basename(path)}")
            self._send("file_info", name=os.path.basename(path))

    def load_stream_url(self):
        url = self.entry_url.get().strip()
        if url and not url.startswith("Paste"):
            self.pot.open_media(url)
            self._log_chat("System", f"Loaded stream URL: {url}")
            self._send("file_info", name=url.split("/")[-1] or "Stream Video", url=url)

    # --------------------------------------------------------------- room io

    def create_room(self):
        if self.is_connected:
            return
        code = str(random.randint(100, 999))
        self.entry_room.delete(0, tk.END)
        self.entry_room.insert(0, code)
        self.room_code = code
        self.is_host = True
        self._connect_to_relay()

    def join_room(self):
        if self.is_connected or self.want_connection:
            self._disconnect_from_relay()
            return
        room = self.entry_room.get().strip()
        if len(room) != 3 or not room.isdigit():
            messagebox.showwarning("Room Required", "Please enter a 3-digit room code (100-999).")
            return
        self.room_code = room
        self.is_host = False
        self._connect_to_relay()

    def _connect_to_relay(self):
        if not HAS_WEBSOCKETS:
            messagebox.showerror("Missing Package", "websockets package is required.\nRun: pip install websockets")
            return

        self.want_connection = True
        self.reconnect_attempts = 0
        self.use_fallback = False
        self.last_seq = {}
        self.peers = {}
        self.clocks = {}
        self.relay_peer_count = 1
        # `_seq` is deliberately NOT reset: peers remember our highest seq, so
        # restarting the counter on a re-join would make them drop everything.

        self.btn_create_room.config(state=tk.DISABLED)
        self.btn_join_room.config(text="Cancel", state=tk.NORMAL)
        self.lbl_net_status.config(text=f"● Connecting to Cloud Relay [{self.room_code}]...", foreground="#eab308")

        threading.Thread(target=lambda: asyncio.run(self._ws_supervisor()), daemon=True).start()

    def _disconnect_from_relay(self):
        self.want_connection = False
        if self.is_connected:
            self._send("bye")
        if self.ws and self.loop:
            try:
                asyncio.run_coroutine_threadsafe(self.ws.close(), self.loop)
            except Exception:
                pass
        self.root.after(0, self._on_disconnected)

    async def _ws_supervisor(self):
        """Reconnect loop. Rotates endpoints only when the handshake itself fails."""
        while self.want_connection:
            url = FALLBACK_RELAY_URL if self.use_fallback else DEFAULT_RELAY_URL
            handshake_ok = False
            try:
                async with websockets.connect(url, ping_interval=20, ping_timeout=25) as ws:
                    handshake_ok = True
                    self.ws = ws
                    self.loop = asyncio.get_running_loop()
                    self.is_connected = True
                    self.reconnect_attempts = 0
                    self.root.after(0, self._on_connected)

                    await ws.send(json.dumps({
                        "type": "join_room",
                        "room": self.room_code,
                        "room_id": self.room_code,
                        "user": self.username,
                        "username": self.username,
                        "platform": "PotPlayer (Windows)",
                    }))

                    self._last_hello = 0.0
                    self._last_heartbeat = time.time()
                    self._last_clock_ping = time.time()

                    ticker = asyncio.create_task(self._ticker(ws))
                    try:
                        async for raw in ws:
                            try:
                                self._handle_relay_message(json.loads(raw))
                            except Exception as e:
                                print(f"[WS] Error handling message: {e}")
                    finally:
                        ticker.cancel()

            except Exception as e:
                print(f"[WS] {url} error: {e}")

            self.is_connected = False
            self.ws = None
            self.loop = None
            self.peers = {}

            if not self.want_connection:
                break

            if not handshake_ok:
                # This endpoint never came up — try the other one next.
                self.use_fallback = not self.use_fallback

            self.reconnect_attempts += 1
            delay = min(15.0, 1.0 * (1.6 ** min(self.reconnect_attempts, 8)))
            self.root.after(0, lambda d=delay: self.lbl_net_status.config(
                text=f"● Reconnecting in {d:.0f}s [{self.room_code}]...", foreground="#eab308"))
            await asyncio.sleep(delay)

        self.root.after(0, self._on_disconnected)

    async def _ticker(self, ws):
        """Hello / clock ping / leader heartbeat / relay keepalive."""
        last_relay_ping = time.time()
        try:
            while True:
                await asyncio.sleep(0.5)
                now = time.time()

                if now - last_relay_ping >= RELAY_PING_S:
                    last_relay_ping = now
                    await ws.send(json.dumps({"type": "ping", "timestamp": now_ms()}))

                # Drop peers that stopped announcing themselves.
                stale = [sid for sid, p in self.peers.items() if now - p["last_seen"] > PEER_TIMEOUT_S]
                for sid in stale:
                    gone = self.peers.pop(sid, None)
                    self.clocks.pop(sid, None)
                    if gone:
                        self.root.after(0, self._log_chat, "System", f"⚠️ {gone['name']} left the room")

                if now - self._last_hello >= HELLO_S:
                    self._last_hello = now
                    self._send("hello")

                if self.peers and now - self._last_clock_ping >= CLOCK_PING_S:
                    self._last_clock_ping = now
                    for sid in list(self.peers.keys()):
                        self._send("tping", to=sid, t0=now_ms())

                if self.peers and self._is_leader() and now - self._last_heartbeat >= HEARTBEAT_S:
                    self._last_heartbeat = now
                    self._send_state("heartbeat")
        except asyncio.CancelledError:
            pass

    def _on_connected(self):
        role_label = "Host" if self.is_host else "Guest"
        self.lbl_net_status.config(text=f"● Connected to Room [{self.room_code}] as {role_label}", foreground="#22c55e")
        self.btn_create_room.config(state=tk.DISABLED)
        self.btn_join_room.config(text="Disconnect", bg="#ef4444", state=tk.NORMAL)
        self._log_chat("System", f"Joined room {self.room_code} as {role_label}. In sync with mpvEx & Web!")

    def _on_disconnected(self):
        if self.want_connection:
            return
        self.lbl_net_status.config(text="● Disconnected", foreground="#ef4444")
        self.btn_create_room.config(state=tk.NORMAL, text="➕ Create Room", bg="#10b981")
        self.btn_join_room.config(text="Join Room", bg="#6366f1", state=tk.NORMAL)
        self._log_chat("System", "Disconnected from room.")

    # ----------------------------------------------------------------- sending

    def _next_seq(self):
        with self._seq_lock:
            self._seq += 1
            return self._seq

    def _send(self, kind, **extra):
        """Wraps a v2 payload in the `action` envelope the relay forwards."""
        if not (self.is_connected and self.ws and self.loop):
            return
        packet = {
            "type": "action",
            "room": self.room_code,
            "v": PROTOCOL_VERSION,
            "kind": kind,
            "sid": self.sid,
            "sname": self.username,
            "splat": PLATFORM_TAG,
            "seq": self._next_seq(),
            "sent_at": now_ms(),
        }
        if kind == "hello":
            # Feeds the leader election on every peer.
            packet["isHost"] = self.is_host
            packet["ver"] = "2.0"
        packet.update(extra)
        try:
            asyncio.run_coroutine_threadsafe(self.ws.send(json.dumps(packet)), self.loop)
        except Exception as e:
            print(f"[WS] Send failed: {e}")

    def _local_state(self):
        """Absolute playback state, or None when PotPlayer has nothing to assert."""
        status, pos_ms, total_ms = self.pot.cached_snapshot()
        if status < 0 or total_ms <= 0:
            return None
        # Stopped is not "paused at 0". PotPlayer zeroes the playhead when the
        # file ends or the user hits stop, and a state carrying position 0 would
        # rewind the entire room to the beginning. A stopped player has no
        # playback state, so it stays quiet until something is playing again.
        if status == 0:
            return None
        return {
            "position": pos_ms / 1000.0,
            "paused": status != 2,
            # `rate` is deliberately ABSENT. PotPlayer's documented message set
            # has no playback-rate accessor, so any value we put here would be a
            # guess — and a guess of 1.0 reset the whole room's speed on every
            # packet we sent. Omitting the key means "no opinion"; receivers
            # leave their own speed alone. See PROTOCOL.md §3.
            "duration": total_ms / 1000.0,
        }

    def _send_state(self, cause, override=None):
        if not self.is_connected:
            return
        if cause != "heartbeat" and self.pot.is_muted:
            return
        # Even a leader must not assert authority while its own seek is still
        # landing — the playhead is transient until the settle window closes.
        if cause == "heartbeat" and self.seek_settle is not None:
            return
        state = override or self._local_state()
        if not state:
            return
        self._send("state", cause=cause, **state)

    # ---------------------------------------------------------------- receive

    def _handle_relay_message(self, msg):
        msg_type = msg.get("type", "")

        # Relay control frames first — these have no `sid`.
        if msg_type == "pong":
            return
        if msg_type == "room_joined":
            self.my_relay_id = msg.get("client_id")
            self.relay_peer_count = max(1, int(msg.get("peer_count", 1)))
            self.root.after(0, self._log_chat, "System", f"Room {self.room_code} ready on Cloud Relay!")
            self._send("hello")
            self._last_hello = time.time()
            self._send("request_state")
            return
        if msg_type == "peer_joined":
            self.relay_peer_count = max(1, int(msg.get("peer_count", self.relay_peer_count + 1)))
            self._send("hello")
            self._last_hello = time.time()
            self._send_state("resync")
            return
        if msg_type == "peer_left":
            self.relay_peer_count = max(1, int(msg.get("peer_count", 1)))
            # The v2 relay names the departing sid outright; the v1 relay only gives us
            # its own client id, which we matched to a sid from that peer's traffic.
            direct_sid = msg.get("sid")
            relay_id = msg.get("client_id")
            if direct_sid and direct_sid in self.peers:
                victim = direct_sid
            else:
                victim = next((s for s, p in self.peers.items() if p.get("relay_id") == relay_id), None)
            if victim:
                gone = self.peers.pop(victim, None)
                self.clocks.pop(victim, None)
                self.root.after(0, self._log_chat, "System", f"⚠️ {gone['name']} left the room")
            elif not self.peers:
                self.root.after(0, self._log_chat, "System", "⚠️ A friend left the room.")
            return

        # Everything else must be a well-formed v2 peer packet.
        if msg_type != "action" or msg.get("v") != PROTOCOL_VERSION:
            return
        sid = msg.get("sid")
        kind = msg.get("kind")
        if not sid or not kind:
            return

        # Rule 1 — never apply our own echo.
        if sid == self.sid:
            return

        # Rule 2 — drop replays and reordered packets. A large backwards jump
        # means the sender restarted its counter, so accept that.
        seq = msg.get("seq")
        if isinstance(seq, int) and seq > 0:
            last = self.last_seq.get(sid)
            if last is not None and seq <= last and last - seq < 50:
                return
            self.last_seq[sid] = seq

        self._touch_peer(sid, msg)

        if kind == "state":
            self._apply_remote_state(sid, msg)
        elif kind == "chat":
            text = msg.get("text", "")
            sender = msg.get("sname", "Friend")
            if text and not self._is_duplicate_chat(sender, text):
                self.root.after(0, self._log_chat, sender, text)
        elif kind == "hello":
            if time.time() - self._last_hello > 1.5:
                self._last_hello = time.time()
                self._send("hello")
        elif kind == "bye":
            gone = self.peers.pop(sid, None)
            self.clocks.pop(sid, None)
            if gone:
                self.root.after(0, self._log_chat, "System", f"⚠️ {gone['name']} left the room")
        elif kind == "request_state":
            if self._local_state():
                self._send_state("resync")
        elif kind == "tping":
            to = msg.get("to")
            if not to or to == self.sid:
                self._send("tpong", to=sid, t0=msg.get("t0", 0), t1=now_ms())
        elif kind == "tpong":
            if msg.get("to") == self.sid:
                est = self.clocks.setdefault(sid, ClockEstimate())
                est.add_sample(int(msg.get("t0", 0)), int(msg.get("t1", 0)), now_ms())
        elif kind == "file_info":
            name = msg.get("name", "")
            if name:
                self.root.after(0, self._log_chat, "System",
                                f"📁 {msg.get('sname', 'Friend')} is playing: {name}")

    def _touch_peer(self, sid, msg):
        peer = self.peers.get(sid)
        if peer is None:
            self.peers[sid] = {
                "name": msg.get("sname", "Friend"),
                "platform": msg.get("splat", "unknown"),
                "is_host": bool(msg.get("isHost", False)),
                "relay_id": msg.get("sender_id"),
                "last_seen": time.time(),
            }
            if msg.get("kind") == "hello":
                self.root.after(0, self._log_chat, "System",
                                f"🎉 {msg.get('sname', 'Friend')} joined the room")
            # Get a usable clock estimate quickly instead of waiting for the tick.
            self._send("tping", to=sid, t0=now_ms())
        else:
            peer["last_seen"] = time.time()
            if msg.get("sname"):
                peer["name"] = msg["sname"]
            if msg.get("sender_id"):
                peer["relay_id"] = msg["sender_id"]
            if msg.get("kind") == "hello":
                peer["is_host"] = bool(msg.get("isHost", False))

    def _apply_remote_state(self, sid, msg):
        cause = msg.get("cause", "state")
        heartbeat = cause == "heartbeat"

        # Only the elected leader drives drift repair, otherwise two peers
        # correct each other forever.
        if heartbeat and (self._is_leader() or sid != self._leader_sid()):
            return
        if heartbeat and self.pot.is_muted:
            return

        # Cached, so applying a remote state never blocks on PotPlayer's UI thread.
        status, local_ms, total_ms = self.pot.cached_snapshot()
        if status < 0 or total_ms <= 0:
            return

        position = float(msg.get("position", 0.0))
        paused = bool(msg.get("paused", True))

        # We can neither read nor set PotPlayer's speed, so we never publish a
        # rate and never try to follow one. All we can usefully do is tell the
        # user once, because at anything other than 1.0x they will drift.
        rate = float(msg.get("rate", 0.0) or 0.0)
        if rate > 0 and abs(rate - self.room_rate) > 0.01:
            self.room_rate = rate
            if abs(rate - 1.0) > 0.01:
                self.root.after(0, self._log_chat, "System",
                                f"⚠️ Room switched to {rate:g}x. PotPlayer cannot be "
                                f"driven at other speeds — set {rate:g}x in PotPlayer "
                                f"yourself (Playback ▸ Speed) or ask the room for 1.0x.")

        est = self.clocks.get(sid)
        offset = est.offset_ms if est else 0.0
        sent_at = int(msg.get("sent_at", 0))

        elapsed = 0.0
        if sent_at > 0:
            # `offset` is senderClock - myClock, so my clock reads `now + offset`
            # on the sender's timescale. Subtracting it here would double the
            # skew instead of cancelling it.
            elapsed = ((now_ms() + offset) - sent_at) / 1000.0
            elapsed = max(0.0, min(5.0, elapsed))

        # Extrapolate at the sender's speed when it told us one; a sender that
        # cannot report its speed is assumed to be running at 1.0x.
        target = position if paused else position + elapsed * (rate if rate > 0 else 1.0)
        target = max(0.0, min(target, total_ms / 1000.0))
        target_ms = int(target * 1000)

        tol = TOL_HEARTBEAT if heartbeat else TOL_EXPLICIT
        needs_seek = abs(local_ms - target_ms) > tol * 1000

        self.pot.mute(MUTE_SEEK if needs_seek else (MUTE_HEARTBEAT if heartbeat else MUTE_SIMPLE))

        if needs_seek:
            self.pot.set_time_ms(target_ms)
            # The mute is NOT shortened here: nothing has confirmed the seek
            # landed yet. The poller shortens it once the playhead arrives, and
            # swallows the keyframe snap so we never rebroadcast it as a seek.
            self.seek_settle = {"target_ms": target_ms, "at": time.time(),
                                "deadline": time.time() + MUTE_SEEK}

        # Absolute pause state, never a toggle.
        locally_paused = status != 2
        if locally_paused != paused:
            if paused:
                self.pot.pause()
            else:
                self.pot.play()

        # Re-baseline so the poller does not read our own change as a user action.
        self.last_status = 1 if paused else 2
        self.last_time_ms = target_ms
        self.last_poll_at = time.time()

        if not heartbeat:
            who = msg.get("sname", "Friend")
            verb = "PAUSE" if paused else "PLAY"
            if cause == "seek":
                verb = "SEEK"
            self.root.after(0, self._log_chat, "Sync",
                            f"{who}: {verb} at {self._format_ms(target_ms)}")

    def _is_duplicate_chat(self, sender, text):
        key = f"{sender}|{text}"
        prev_key, prev_at = self._chat_fingerprint
        now = time.time()
        if prev_key == key and now - prev_at < 1.0:
            return True
        self._chat_fingerprint = (key, now)
        return False

    # ---------------------------------------------------------------- leader

    def _leader_key(self, sid, is_host):
        return ("0:" if is_host else "1:") + sid

    def _leader_sid(self):
        best_sid = self.sid
        best_key = self._leader_key(self.sid, self.is_host)
        for sid, peer in self.peers.items():
            key = self._leader_key(sid, peer.get("is_host", False))
            if key < best_key:
                best_key = key
                best_sid = sid
        return best_sid

    def _is_leader(self):
        return self._leader_sid() == self.sid

    # -------------------------------------------------------------- monitor

    def _start_potplayer_monitor(self):
        """Background poller that turns local PotPlayer changes into state broadcasts."""
        def poll_loop():
            while self.is_monitoring:
                time.sleep(POLL_S)
                try:
                    self._poll_once()
                except Exception as e:
                    print(f"[Monitor] {e}")

        threading.Thread(target=poll_loop, daemon=True).start()

    def _poll_once(self):
        status, curr_ms, total_ms = self.pot.snapshot()
        now = time.time()

        if status < 0:
            self.root.after(0, lambda: self.lbl_pot_status.config(
                text="⚠️ PotPlayer not found. Open Daum PotPlayer on PC!", foreground="#eab308"))
            self.last_status = -1
            self.last_poll_at = now
            self.seek_settle = None
            return

        status_names = {0: "Stopped", 1: "Paused", 2: "Playing"}
        info_str = (f"● {status_names.get(status, 'Unknown')} | "
                    f"{self._format_ms(curr_ms)} / {self._format_ms(total_ms)}")
        self.root.after(0, lambda s=info_str: self.lbl_pot_status.config(
            text=s, foreground="#38bdf8" if status == 2 else "#94a3b8"))

        # A seek we asked for is still landing. PotPlayer snaps to a keyframe, so
        # the playhead can arrive seconds away from the target — broadcasting that
        # as a fresh seek would drag the whole room onto our keyframe.
        settle = self.seek_settle
        if settle is not None:
            age = now - settle["at"]
            expected = settle["target_ms"] + (age * 1000.0 if status == 2 else 0.0)
            arrived = abs(curr_ms - expected) <= SEEK_SETTLE_MS
            if arrived or now >= settle["deadline"]:
                self.seek_settle = None
                self.pot.mute_settled(MUTE_SEEK_SETTLED)
            # Only the POSITION baseline is refreshed. `last_status` is left alone
            # on purpose — see the muted branch below.
            self.last_time_ms = curr_ms
            self.last_poll_at = now
            return

        if self.pot.is_muted:
            # We are mid-apply, so the position is transient: keep that baseline
            # fresh or the settle reads as a user seek.
            #
            # `last_status` is deliberately NOT refreshed. `_apply_remote_state`
            # already set it to the play/pause state it commanded, so it is a
            # correct baseline. Overwriting it here with whatever PotPlayer
            # happens to report *destroys* a pause the user pressed during the
            # mute window: the next poll would see status == last_status and
            # conclude nothing had changed, so the pause reached nobody. Leaving
            # it means the transition is simply reported once the mute lifts.
            self.last_time_ms = curr_ms
            self.last_poll_at = now
            return

        prev_status = self.last_status
        prev_time = self.last_time_ms
        dt_ms = (now - self.last_poll_at) * 1000.0
        self.last_status = status
        self.last_time_ms = curr_ms
        self.last_poll_at = now

        if not self.is_connected or total_ms <= 0 or prev_status < 0:
            return

        # A jump away from where natural playback would have landed is a seek.
        # Paused, there is no natural motion to allow for, so a much smaller
        # change is already unambiguous — without this, scrubbing a paused
        # PotPlayer by under a second never reached anyone.
        # `prev_status < 0` above is the only "no baseline yet" guard we need;
        # gating on `prev_time > 0` as well would swallow a seek made from the
        # very start of a freshly opened file.
        expected = prev_time + (dt_ms if prev_status == 2 else 0.0)
        jump_tol = JUMP_PLAYING_MS if prev_status == 2 else JUMP_PAUSED_MS
        if abs(curr_ms - expected) > jump_tol:
            self._send_state("seek")
            return

        if status != prev_status:
            self._send_state("play" if status == 2 else "pause")

    # ------------------------------------------------------------------ chat

    def send_chat_message(self):
        text = self.entry_chat.get().strip()
        if not text:
            return
        self.entry_chat.delete(0, tk.END)
        self._log_chat(self.username + " (You)", text)
        self._send("chat", text=text)

    def _log_chat(self, sender, message):
        self.txt_chat.config(state=tk.NORMAL)
        t_str = time.strftime("%H:%M")
        self.txt_chat.insert(tk.END, f"[{t_str}] {sender}: {message}\n")
        self.txt_chat.see(tk.END)
        self.txt_chat.config(state=tk.DISABLED)

    def _format_ms(self, ms):
        s = max(0, int(ms / 1000))
        m, s = divmod(s, 60)
        h, m = divmod(m, 60)
        return f"{h:02d}:{m:02d}:{s:02d}" if h > 0 else f"{m:02d}:{s:02d}"


if __name__ == "__main__":
    root = tk.Tk()
    app = UltimatePotPlayerApp(root)
    root.mainloop()
