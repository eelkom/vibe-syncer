# backend/app/core/websocket_manager.py

from typing import List, Dict, Any
from fastapi import WebSocket
import logging

# Logger Settings
logger = logging.getLogger(__name__)

class ConnectionManager:
    def __init__(self):
        # Use room_id(int) as a key for efficient management
        self.active_connections: dict[int, List[WebSocket]] = {}
        # [ADD] Room-by-room playback status storage (memory cache)
        self.room_states: dict[int, Dict[str, Any]] = {}

    async def connect(self, websocket: WebSocket, room_id: int):
        await websocket.accept()
        if room_id not in self.active_connections:
            self.active_connections[room_id] = []
        self.active_connections[room_id].append(websocket)
        logger.info(f"WebSocket connected to room {room_id}. Current connections: {len(self.active_connections[room_id])}")

        # [ADD] Immediately send 'current room status' to new users (Initial Sync)
        if room_id in self.room_states:
            current_state = self.room_states[room_id]
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
                if room_id in self.room_states:
                    del self.room_states[room_id]
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

# Single-tone instance (Imported and used by another file)
manager = ConnectionManager()