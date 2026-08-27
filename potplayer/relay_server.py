#!/usr/bin/env python3
"""
Ultimate Watch Together — Multi-Platform Relay Server
Bridges Daum PotPlayer (Windows), mpvEx (Android), and Web Browsers (HTML5)
using standard WebSocket room-based messaging.
"""

import asyncio
import json
import logging
import sys

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger("RelayServer")

try:
    import websockets
except ImportError:
    print("ERROR: websockets package is required. Install via: pip install websockets")
    sys.exit(1)

# Storage: room_id -> set of connected websocket clients
ROOMS = {}
# client -> room_id
CLIENT_ROOM = {}
# client -> client_id
CLIENT_INFO = {}

async def handle_client(websocket):
    client_id = f"client_{id(websocket) % 10000}"
    current_room = None
    logger.info(f"New connection: {client_id} from {websocket.remote_address}")

    try:
        async for raw_message in websocket:
            try:
                msg = json.loads(raw_message)
            except json.JSONDecodeError:
                logger.warning(f"Invalid JSON received from {client_id}")
                continue

            msg_type = msg.get("type", "")

            # 1. Room Join
            if msg_type == "join_room":
                room_id = str(msg.get("room_id", "default")).strip()
                username = msg.get("username", client_id)
                platform = msg.get("platform", "generic")

                # Remove from old room if switching
                if current_room and current_room in ROOMS:
                    ROOMS[current_room].discard(websocket)

                current_room = room_id
                if room_id not in ROOMS:
                    ROOMS[room_id] = set()
                ROOMS[room_id].add(websocket)
                CLIENT_ROOM[websocket] = room_id
                CLIENT_INFO[websocket] = {
                    "id": client_id,
                    "username": username,
                    "platform": platform
                }

                logger.info(f"{username} ({platform}) joined room [{room_id}]. Total in room: {len(ROOMS[room_id])}")

                # Notify self of success
                await websocket.send(json.dumps({
                    "type": "room_joined",
                    "room_id": room_id,
                    "client_id": client_id,
                    "peer_count": len(ROOMS[room_id])
                }))

                # Notify other peers in room
                join_notification = json.dumps({
                    "type": "peer_joined",
                    "client_id": client_id,
                    "username": username,
                    "platform": platform,
                    "peer_count": len(ROOMS[room_id])
                })
                for peer in list(ROOMS[room_id]):
                    if peer != websocket:
                        try:
                            await peer.send(join_notification)
                        except Exception:
                            pass

            # 2. Sync Actions (play, pause, seek, rate, chat, file_info)
            elif msg_type in ("play", "pause", "seek", "rate", "chat", "file_info", "heartbeat"):
                if not current_room or current_room not in ROOMS:
                    continue

                # Attach sender metadata
                sender_info = CLIENT_INFO.get(websocket, {})
                msg["sender_id"] = client_id
                msg["sender_name"] = sender_info.get("username", client_id)
                msg["platform"] = sender_info.get("platform", "unknown")

                payload = json.dumps(msg)
                # Broadcast to all other peers in the same room
                for peer in list(ROOMS[current_room]):
                    if peer != websocket:
                        try:
                            await peer.send(payload)
                        except Exception:
                            pass

    except websockets.exceptions.ConnectionClosed:
        logger.info(f"Connection closed for {client_id}")
    finally:
        # Cleanup disconnected client
        if current_room and current_room in ROOMS:
            ROOMS[current_room].discard(websocket)
            leave_msg = json.dumps({
                "type": "peer_left",
                "client_id": client_id,
                "peer_count": len(ROOMS[current_room])
            })
            for peer in list(ROOMS[current_room]):
                try:
                    await peer.send(leave_msg)
                except Exception:
                    pass
            if not ROOMS[current_room]:
                del ROOMS[current_room]

        CLIENT_ROOM.pop(websocket, None)
        CLIENT_INFO.pop(websocket, None)

async def main(host="0.0.0.0", port=8765):
    logger.info(f"Starting Ultimate Watch Together Relay Server on {host}:{port}")
    async with websockets.serve(handle_client, host, port):
        logger.info("Server is listening. Ready for PotPlayer, mpvEx, and Web clients!")
        await asyncio.Future() # keep running

if __name__ == "__main__":
    port = 8765
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass
    try:
        asyncio.run(main(port=port))
    except KeyboardInterrupt:
        logger.info("Server stopped by user.")
