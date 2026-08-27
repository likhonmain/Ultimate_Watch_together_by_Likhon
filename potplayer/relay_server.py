#!/usr/bin/env python3
"""
Ultimate Watch Together — Multi-Platform Relay Server (protocol v2)

Bridges Daum PotPlayer (Windows), mpvEx (Android), and Web Browsers (HTML5) using
room-based WebSocket messaging. See PROTOCOL.md.

The relay is deliberately dumb: it holds room membership and fans messages out. It
keeps **no playback state** and never interprets a `state` packet, so clients can
evolve the protocol without touching the server.

Every v2 client also works against the older allowlist-based relay, so deploying this
is optional.
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
# client -> {id, username, platform, sid}
CLIENT_INFO = {}

# Frames the relay handles itself; everything else is forwarded verbatim. A blocklist
# rather than an allowlist, so a new `kind` never needs a server change to work.
LOCAL_TYPES = frozenset({"ping", "pong", "join_room", "join", "room_joined",
                         "peer_joined", "peer_left"})


def peer_list(room_id, exclude=None):
    """Public description of everyone in a room, for `room_joined`."""
    out = []
    for peer in ROOMS.get(room_id, ()):
        if peer is exclude:
            continue
        info = CLIENT_INFO.get(peer)
        if not info:
            continue
        out.append({
            "client_id": info["id"],
            "sid": info.get("sid"),
            "username": info.get("username"),
            "platform": info.get("platform", "unknown"),
        })
    return out


async def fan_out(room_id, payload, exclude=None):
    """Send to everyone in the room except `exclude`. Dead sockets are ignored."""
    for peer in list(ROOMS.get(room_id, ())):
        if peer is exclude:
            continue
        try:
            await peer.send(payload)
        except Exception:
            pass


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

            # Ping / keepalive. Clients send this every 15 s so mobile carrier NAT
            # tables do not expire during a long pause.
            if msg_type == "ping":
                try:
                    await websocket.send(json.dumps({"type": "pong", "timestamp": msg.get("timestamp")}))
                except Exception:
                    pass
                continue

            if msg_type == "pong":
                continue

            # 1. Room join
            if msg_type in ("join_room", "join"):
                room_id = str(msg.get("room_id") or msg.get("room") or "default").strip()
                username = msg.get("username") or msg.get("user") or client_id
                platform = msg.get("platform", "generic")

                # Remove from old room if switching
                if current_room and current_room in ROOMS:
                    ROOMS[current_room].discard(websocket)
                    if not ROOMS[current_room]:
                        del ROOMS[current_room]

                current_room = room_id
                ROOMS.setdefault(room_id, set()).add(websocket)
                CLIENT_ROOM[websocket] = room_id
                CLIENT_INFO[websocket] = {
                    "id": client_id,
                    "username": username,
                    "platform": platform,
                    # Learned from the first v2 packet this client sends.
                    "sid": msg.get("sid"),
                }

                logger.info(f"{username} ({platform}) joined room [{room_id}]. "
                            f"Total in room: {len(ROOMS[room_id])}")

                await websocket.send(json.dumps({
                    "type": "room_joined",
                    "room_id": room_id,
                    "room": room_id,
                    "client_id": client_id,
                    "peer_count": len(ROOMS[room_id]),
                    # v2 extras. Clients treat these as optional.
                    "your_sid": msg.get("sid"),
                    "peers": peer_list(room_id, exclude=websocket),
                }))

                await fan_out(room_id, json.dumps({
                    "type": "peer_joined",
                    "client_id": client_id,
                    "username": username,
                    "user": username,
                    "platform": platform,
                    "peer_count": len(ROOMS[room_id]),
                }), exclude=websocket)
                continue

            # 2. Everything else is peer traffic — forward it verbatim.
            if msg_type in LOCAL_TYPES:
                continue

            # A client that starts sending before joining (or after a relay restart)
            # is admitted using the room named in the packet.
            if not current_room or current_room not in ROOMS:
                req_room = str(msg.get("room") or msg.get("room_id") or "").strip()
                if not req_room:
                    continue
                current_room = req_room
                ROOMS.setdefault(current_room, set()).add(websocket)
                CLIENT_ROOM[websocket] = current_room
                CLIENT_INFO.setdefault(websocket, {
                    "id": client_id, "username": client_id, "platform": "unknown", "sid": None,
                })

            info = CLIENT_INFO.get(websocket, {})

            # Remember the client's self-declared sid so `peer_left` can name it.
            sid = msg.get("sid")
            if sid and info.get("sid") != sid:
                info["sid"] = sid

            # Stamp sender metadata. Note these OVERWRITE whatever the client sent —
            # which is exactly why v2 identity lives in `sid` / `sname` / `splat`.
            msg["sender_id"] = client_id
            msg["sender_name"] = info.get("username", client_id)
            msg["platform"] = info.get("platform", "unknown")

            await fan_out(current_room, json.dumps(msg), exclude=websocket)

    except websockets.exceptions.ConnectionClosed:
        logger.info(f"Connection closed for {client_id}")
    finally:
        info = CLIENT_INFO.pop(websocket, {})
        CLIENT_ROOM.pop(websocket, None)

        if current_room and current_room in ROOMS:
            ROOMS[current_room].discard(websocket)
            await fan_out(current_room, json.dumps({
                "type": "peer_left",
                "client_id": client_id,
                # v2 extra: lets clients drop the right peer without the relayId map.
                "sid": info.get("sid"),
                "peer_count": len(ROOMS[current_room]),
            }))
            if not ROOMS[current_room]:
                del ROOMS[current_room]


async def main(host="0.0.0.0", port=8765):
    logger.info(f"Starting Ultimate Watch Together Relay Server on {host}:{port}")
    async with websockets.serve(handle_client, host, port):
        logger.info("Server is listening. Ready for PotPlayer, mpvEx, and Web clients!")
        await asyncio.Future()  # keep running


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
