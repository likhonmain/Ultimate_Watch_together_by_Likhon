#!/usr/bin/env python3
"""
Ultimate Watch Together — Dedicated Daum PotPlayer Synchronizer (Windows)
Enables synchronized co-watching between Daum PotPlayer on Windows PC,
mpvEx on Android mobile, and Web Browsers via 3-digit room codes.
"""

import sys
import os
import time
import json
import socket
import asyncio
import threading
import subprocess
import ctypes
from ctypes import wintypes
import tkinter as tk
from tkinter import ttk, messagebox, filedialog

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

user32 = ctypes.windll.user32

class PotPlayerController:
    """Interacts with Daum PotPlayer via Windows Messages (IPC)"""
    def __init__(self):
        self.hwnd = None
        self.is_remote_action = False
        self.potplayer_exe = self._locate_potplayer_binary()

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

    def get_status(self):
        """0: Stopped, 1: Paused, 2: Running, -1: Not Running"""
        if not self.find_window():
            return -1
        return user32.SendMessageW(self.hwnd, WM_USER, POT_GET_PLAY_STATUS, 0)

    def get_current_time_ms(self):
        if not self.find_window():
            return 0
        return user32.SendMessageW(self.hwnd, WM_USER, POT_GET_CURRENT_TIME, 0)

    def get_total_time_ms(self):
        if not self.find_window():
            return 0
        return user32.SendMessageW(self.hwnd, WM_USER, POT_GET_TOTAL_TIME, 0)

    def set_time_ms(self, time_ms):
        if not self.find_window():
            return
        self.is_remote_action = True
        user32.SendMessageW(self.hwnd, WM_USER, POT_SET_CURRENT_TIME, int(time_ms))
        time.sleep(0.12)
        self.is_remote_action = False

    def play(self):
        if not self.find_window():
            return
        self.is_remote_action = True
        user32.SendMessageW(self.hwnd, WM_USER, POT_SET_PLAY_STATUS, 2)
        time.sleep(0.12)
        self.is_remote_action = False

    def pause(self):
        if not self.find_window():
            return
        self.is_remote_action = True
        user32.SendMessageW(self.hwnd, WM_USER, POT_SET_PLAY_STATUS, 1)
        time.sleep(0.12)
        self.is_remote_action = False

    def toggle(self):
        if not self.find_window():
            return
        self.is_remote_action = True
        user32.SendMessageW(self.hwnd, WM_USER, POT_SET_PLAY_STATUS, 0)
        time.sleep(0.12)
        self.is_remote_action = False

    def open_media(self, path_or_url):
        """Launch or load media file/URL inside PotPlayer"""
        try:
            subprocess.Popen([self.potplayer_exe, path_or_url])
            return True
        except Exception as e:
            print(f"[PotPlayer] Launch error: {e}")
            return False


class UltimatePotPlayerApp:
    """Dark-themed UI for PotPlayer synchronization"""
    def __init__(self, root):
        self.root = root
        self.root.title("Ultimate Watch Together — Daum PotPlayer Sync")
        self.root.geometry("640x600")
        self.root.configure(bg="#0f172a")

        self.pot = PotPlayerController()
        self.is_connected = False
        self.ws = None
        self.loop = None
        self.room_code = "582"
        self.username = f"PC_User_{os.getpid() % 1000}"

        # State tracking
        self.last_known_status = -1
        self.last_known_time_ms = 0
        self.is_monitoring = True

        self._setup_styles()
        self._build_ui()
        self._start_potplayer_monitor()

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

        # Card 1: Room Connection
        c1 = ttk.Frame(main, style="Card.TFrame", padding="12")
        c1.pack(fill=tk.X, pady=6)

        c1_top = ttk.Frame(c1, style="Card.TFrame")
        c1_top.pack(fill=tk.X)
        ttk.Label(c1_top, text="Room Code (3-Digit):", style="Card.TLabel").pack(side=tk.LEFT)
        self.entry_room = tk.Entry(c1_top, bg="#0f172a", fg="#38bdf8", insertbackground="#ffffff",
                                   font=("Consolas", 12, "bold"), width=8, justify="center")
        self.entry_room.insert(0, "582")
        self.entry_room.pack(side=tk.LEFT, padx=10)

        self.btn_connect = tk.Button(c1_top, text="Connect to Room", bg="#6366f1", fg="#ffffff",
                                     font=("Segoe UI", 9, "bold"), relief="flat", padx=12, pady=3,
                                     command=self.toggle_connection)
        self.btn_connect.pack(side=tk.LEFT, padx=6)

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

    def browse_local_file(self):
        path = filedialog.askopenfilename(
            title="Select Video File",
            filetypes=[("Video Files", "*.mkv *.mp4 *.webm *.avi *.mov *.ts"), ("All Files", "*.*")]
        )
        if path:
            self.pot.open_media(path)
            self._log_chat("System", f"Loaded local file: {os.path.basename(path)}")
            self._broadcast({
                "type": "file_info",
                "name": os.path.basename(path),
                "platform": "PotPlayer (Windows)"
            })

    def load_stream_url(self):
        url = self.entry_url.get().strip()
        if url and not url.startswith("Paste"):
            self.pot.open_media(url)
            self._log_chat("System", f"Loaded stream URL: {url}")
            self._broadcast({
                "type": "file_info",
                "name": url.split("/")[-1] or "Stream Video",
                "url": url,
                "platform": "PotPlayer (Windows)"
            })

    def toggle_connection(self):
        if not self.is_connected:
            room = self.entry_room.get().strip()
            if not room:
                messagebox.showwarning("Room Required", "Please enter a 3-digit room code.")
                return
            self.room_code = room
            self._connect_to_relay()
        else:
            self._disconnect_from_relay()

    def _connect_to_relay(self):
        server_url = "ws://127.0.0.1:8765" # Default local relay or can point to cloud VPS
        self.btn_connect.config(text="Connecting...", state=tk.DISABLED)

        def ws_thread():
            asyncio.run(self._ws_worker(server_url))

        threading.Thread(target=ws_thread, daemon=True).start()

    async def _ws_worker(self, url):
        try:
            async with websockets.connect(url) as ws:
                self.ws = ws
                self.is_connected = True
                self.root.after(0, self._on_connected)

                # Send join room
                await ws.send(json.dumps({
                    "type": "join_room",
                    "room_id": self.room_code,
                    "username": self.username,
                    "platform": "PotPlayer (Windows)"
                }))

                async for msg_str in ws:
                    try:
                        data = json.loads(msg_str)
                        self.root.after(0, self._handle_remote_sync, data)
                    except Exception as e:
                        print(f"Error handling message: {e}")

        except Exception as e:
            print(f"[WS] Connection error: {e}")
        finally:
            self.is_connected = False
            self.ws = None
            self.root.after(0, self._on_disconnected)

    def _on_connected(self):
        self.lbl_net_status.config(text=f"● Connected to Room [{self.room_code}]", foreground="#22c55e")
        self.btn_connect.config(text="Disconnect", bg="#ef4444", state=tk.NORMAL)
        self._log_chat("System", f"Joined room {self.room_code}. In sync with mpvEx & Web!")

    def _on_disconnected(self):
        self.lbl_net_status.config(text="● Disconnected", foreground="#ef4444")
        self.btn_connect.config(text="Connect to Room", bg="#6366f1", state=tk.NORMAL)
        self._log_chat("System", "Disconnected from room.")

    def _disconnect_from_relay(self):
        if self.ws:
            # closing will break ws_worker loop
            try:
                loop = asyncio.get_event_loop()
                loop.create_task(self.ws.close())
            except Exception:
                pass

    def _broadcast(self, msg_dict):
        if self.is_connected and self.ws:
            try:
                # Thread-safe send
                asyncio.run_coroutine_threadsafe(
                    self.ws.send(json.dumps(msg_dict)),
                    self.ws.loop
                )
            except Exception:
                pass

    def _handle_remote_sync(self, msg):
        msg_type = msg.get("type", "")

        if msg_type == "play":
            remote_time_s = msg.get("time", 0)
            remote_time_ms = int(remote_time_s * 1000)
            local_time_ms = self.pot.get_current_time_ms()
            if abs(local_time_ms - remote_time_ms) > 1500:
                self.pot.set_time_ms(remote_time_ms)
            self.pot.play()
            self._log_chat("Sync", f"Remote PLAY at {self._format_ms(remote_time_ms)}")

        elif msg_type == "pause":
            remote_time_s = msg.get("time", 0)
            remote_time_ms = int(remote_time_s * 1000)
            self.pot.pause()
            local_time_ms = self.pot.get_current_time_ms()
            if abs(local_time_ms - remote_time_ms) > 1500:
                self.pot.set_time_ms(remote_time_ms)
            self._log_chat("Sync", f"Remote PAUSE at {self._format_ms(remote_time_ms)}")

        elif msg_type == "seek":
            remote_time_s = msg.get("time", 0)
            remote_time_ms = int(remote_time_s * 1000)
            self.pot.set_time_ms(remote_time_ms)
            self._log_chat("Sync", f"Remote SEEK to {self._format_ms(remote_time_ms)}")

        elif msg_type == "chat":
            sender = msg.get("sender_name", "Friend")
            text = msg.get("text", "")
            self._log_chat(sender, text)

        elif msg_type == "peer_joined":
            pname = msg.get("username", "Friend")
            plat = msg.get("platform", "")
            self._log_chat("System", f"🎉 {pname} joined the room ({plat})")

    def _start_potplayer_monitor(self):
        """Background poller to detect local user actions in PotPlayer"""
        def poll_loop():
            while self.is_monitoring:
                time.sleep(0.3)
                hwnd = self.pot.find_window()
                if not hwnd:
                    self.root.after(0, lambda: self.lbl_pot_status.config(
                        text="⚠️ PotPlayer not found. Open Daum PotPlayer on PC!", foreground="#eab308"))
                    continue

                status = self.pot.get_status() # 0: stopped, 1: paused, 2: running
                curr_ms = self.pot.get_current_time_ms()
                total_ms = self.pot.get_total_time_ms()

                status_names = {0: "Stopped", 1: "Paused", 2: "Playing", -1: "Not found"}
                status_txt = status_names.get(status, "Unknown")
                info_str = f"● {status_txt} | {self._format_ms(curr_ms)} / {self._format_ms(total_ms)}"
                self.root.after(0, lambda s=info_str: self.lbl_pot_status.config(
                    text=s, foreground="#38bdf8" if status == 2 else "#94a3b8"))

                if self.pot.is_remote_action:
                    self.last_known_status = status
                    self.last_known_time_ms = curr_ms
                    continue

                # Detect user seek (>1500ms jump unexpectedly)
                expected_time = self.last_known_time_ms + (300 if status == 2 else 0)
                if abs(curr_ms - expected_time) > 1500 and total_ms > 0 and self.last_known_time_ms > 0:
                    print(f"[Local Action] Seek detected: {curr_ms}ms")
                    self._broadcast({
                        "type": "seek",
                        "time": curr_ms / 1000.0,
                        "timestamp": int(time.time() * 1000)
                    })

                # Detect user Play / Pause toggle
                if status != self.last_known_status and self.last_known_status != -1:
                    if status == 2: # Went to Playing
                        print(f"[Local Action] Play detected at {curr_ms}ms")
                        self._broadcast({
                            "type": "play",
                            "time": curr_ms / 1000.0,
                            "rate": 1.0,
                            "timestamp": int(time.time() * 1000)
                        })
                    elif status == 1: # Went to Paused
                        print(f"[Local Action] Pause detected at {curr_ms}ms")
                        self._broadcast({
                            "type": "pause",
                            "time": curr_ms / 1000.0,
                            "timestamp": int(time.time() * 1000)
                        })

                self.last_known_status = status
                self.last_known_time_ms = curr_ms

        threading.Thread(target=poll_loop, daemon=True).start()

    def send_chat_message(self):
        text = self.entry_chat.get().strip()
        if not text:
            return
        self.entry_chat.delete(0, tk.END)
        self._log_chat(self.username + " (You)", text)
        self._broadcast({
            "type": "chat",
            "text": text,
            "timestamp": int(time.time() * 1000)
        })

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
