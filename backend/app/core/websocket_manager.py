# backend/app/core/websocket_manager.py

from typing import List, Dict, Any, Optional
from fastapi import WebSocket
import logging
import time

# Logger Settings
logger = logging.getLogger(__name__)


def server_now_ms() -> float:
    """Wall clock in ms. Clients estimate their offset to it with time_sync."""
    return time.time() * 1000


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)

# The host-stamped elapsed time may exceed the server's own (receive based) one
# by the host -> server delay. A larger gap points to a bad clock estimate on the
# host, so the server's own measure is used instead.
MAX_STAMP_DISAGREEMENT_S = 2.0


class ConnectionManager:
    def __init__(self):
        # Use room_id(int) as a key for efficient management
        self.active_connections: dict[int, List[WebSocket]] = {}
        # [ADD] Room-by-room playback status storage (memory cache)
        self.room_states: dict[int, Dict[str, Any]] = {}
        # Whether each room is playing and when its state was last updated (monotonic)
        self.room_playback: dict[int, Dict[str, Any]] = {}

    async def connect(self, websocket: WebSocket, room_id: int):
        await websocket.accept()
        if room_id not in self.active_connections:
            self.active_connections[room_id] = []
        self.active_connections[room_id].append(websocket)
        logger.info(f"WebSocket connected to room {room_id}. Current connections: {len(self.active_connections[room_id])}")

        # [ADD] Immediately send 'current room status' to new users (Initial Sync)
        current_state = self.get_room_state(room_id)
        if current_state:
            try:
                await websocket.send_json(current_state)
                logger.info(f"Sent initial sync state to new user in room {room_id}")
            except Exception as e:
                logger.error(f"Failed to send initial sync: {e}")

    def disconnect(self, websocket: WebSocket, room_id: int):
        if room_id in self.active_connections:
            if websocket in self.active_connections[room_id]:
                self.active_connections[room_id].remove(websocket)
            if not self.active_connections[room_id]:
                del self.active_connections[room_id]
                self.room_states.pop(room_id, None)
                self.room_playback.pop(room_id, None)
                logger.info(f"Room {room_id} is empty. Connection list removed.")

    async def broadcast_to_room(self, room_id: int, message: dict):
        if room_id in self.active_connections:
            for connection in self.active_connections[room_id]:
                try:
                    await connection.send_json(message)
                except Exception as e:
                    logger.error(f"Failed to send message: {e}")
                    pass
    def update_room_state(self, room_id: int, state: dict):
        self.room_states[room_id] = state

        # A seek keeps the previous play/pause state
        action = state.get("action")
        was_playing = self.room_playback.get(room_id, {}).get("is_playing", True)
        self.room_playback[room_id] = {
            "is_playing": action == "play" or (action == "seek" and was_playing),
            "updated_at": time.monotonic(),
        }

    def get_room_state(self, room_id: int) -> Optional[Dict[str, Any]]:
        """
        Snapshot of the room's playback for late joiners: the stored sync payload
        with action set to play/pause and, while playing, the timestamp advanced
        to now. server_ms (and position_at_ms when the host sent one) is set to
        the moment the snapshot is made, so clients can add the delivery time.
        """
        state = self.room_states.get(room_id)
        if state is None:
            return None

        snapshot = dict(state)
        snapshot["snapshot"] = True
        playback = self.room_playback.get(room_id)
        if playback is None:
            return snapshot

        is_playing = playback["is_playing"]
        snapshot["action"] = "play" if is_playing else "pause"

        now_ms = server_now_ms()
        timestamp = state.get("timestamp")
        if is_playing and _is_number(timestamp):
            elapsed = time.monotonic() - playback["updated_at"]
            position_at_ms = state.get("position_at_ms")
            if _is_number(position_at_ms):
                # The host stamped when it read its position, so this also covers
                # the host -> server delay
                stamped = (now_ms - position_at_ms) / 1000
                if 0 <= stamped - elapsed <= MAX_STAMP_DISAGREEMENT_S:
                    elapsed = stamped
            snapshot["timestamp"] = timestamp + elapsed

        snapshot["server_ms"] = now_ms
        if "position_at_ms" in snapshot:
            snapshot["position_at_ms"] = now_ms

        return snapshot

# Single-tone instance (Imported and used by another file)
manager = ConnectionManager()