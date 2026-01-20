# backend/app/api/routes/websockets.py

import json
import re
import logging
import jwt
from datetime import datetime, timedelta
from collections import defaultdict
import asyncio
from concurrent.futures import ThreadPoolExecutor
from typing import List

from cachetools import TTLCache
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import desc
from sqlalchemy.orm import Session

# Import dependencies
from app import database
from app.models import models
from app.ai import get_ai_dj_response
from app.utils import process_music_addition
from app.core.websocket_manager import manager
from app.auth import SECRET_KEY, ALGORITHM

# Initialize Router
router = APIRouter()

# Configure Logging
logger = logging.getLogger(__name__)

# ---------------------------------------------------------
# Constants & Global Variables for WebSocket
# ---------------------------------------------------------
# Rate Limiting Setup (Prevent Spam)
user_last_dj_request = TTLCache(maxsize=10000, ttl=3600)
DJ_COOLDOWN_SECONDS = 10
BOT_USER_ID = 0


# ---------------------------------------------------------
# WebSocket Endpoint
# ---------------------------------------------------------
@router.websocket("/ws/{room_code}")
async def websocket_endpoint(websocket: WebSocket, room_code: str):
    """
    Main WebSocket endpoint handling:
    1. Chat
    2. Playback Synchronization (Sync)
    3. AI DJ Requests (!dj)
    4. Music URL Sharing
    """

    # -----------------------------------------------------
    # 🔒 1. JWT Authentication (Security Layer)
    # -----------------------------------------------------
    token = websocket.query_params.get("token")

    if not token:
        await websocket.close(code=4001, reason="Missing token")
        return

    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = payload.get("user_id")

        if user_id is None:
            await websocket.close(code=4003, reason="Invalid Token")
            return

    except jwt.PyJWTError:
        await websocket.close(code=4003, reason="Token Verification Failed")
        return

# -----------------------------------------------------
# 🏠 2. Room Validation & DB Setup
# -----------------------------------------------------
# WebSocket does not support Dependency Injection nicely, so we use SessionLocal manually

    db = database.SessionLocal()

    try:
        # Find room by code
        room = db.query(models.Room).filter(models.Room.room_code == room_code).first()
        if not room:
            # If room code invalid, close connection
            await websocket.close(code=4004, reason="Invalid Room Code")
            return

        # Extract ID for internal logic
        room_id = room.id
        host_id = room.host_id  # For permission check

        # -----------------------------------------------------
        # 🔗 3. Connection & Broadcast
        # -----------------------------------------------------
        await manager.connect(websocket, room_id)

        # 4. Fetch User Info
        user = db.query(models.User).filter(models.User.id == user_id).first()
        username = user.username if user else f"Unknown({user_id})"

        # 5. Broadcast Join
        await manager.broadcast_to_room(room_id, {
            "type": "system",
            "message": f"{username} has joined the room."
        })

        # Regex for URL detection
        url_pattern = re.compile(r'(https?://\S+)')

        # Main Loop
        try:
            while True:
                raw_data = await websocket.receive_text()

                try:
                    payload = json.loads(raw_data)
                except json.JSONDecodeError:
                    # If not JSON, treat as legacy text chat
                    payload = {"type": "chat", "message": raw_data}

                message_type = payload.get("type", "chat")

                # --- [A] Sync Event Handling ---
                if message_type == "sync":
                    # [Security] Host Only Check
                    if user_id != host_id:
                        logger.warning(f"Unauthorized sync attempt by user {user_id}")
                        continue  # Ignore unauthorized requests

                    # Add sender info and broadcast
                    payload["user_id"] = user_id
                    payload["username"] = username
                    # [ADD] Save the latest status to server memory
                    manager.update_room_state(room_id, payload)
                    await manager.broadcast_to_room(room_id, payload)
                    continue

                # --- [B] Chat & AI Logic ---
                chat_message = payload.get("message", "")

                # Skip empty messages
                if not chat_message:
                    continue

                # Save Chat
                new_chat = models.ChatMessage(
                    room_id=room_id,
                    user_id=user_id,
                    message=chat_message
                )
                db.add(new_chat)
                db.commit()
                db.refresh(new_chat)

                # Broadcast Chat
                await manager.broadcast_to_room(room_id, {
                    "type": "chat",
                    "user_id": user_id,
                    "username": username,
                    "message": chat_message,
                    "created_at": new_chat.created_at.isoformat()
                })

                # AI Trigger (!dj)
                if chat_message.lower().startswith("!dj"):
                    user_key = f"{room_id}:{user_id}"
                    last_request = user_last_dj_request[user_key]

                    # Cooldown Check
                    if datetime.now() - last_request < timedelta(seconds=DJ_COOLDOWN_SECONDS):
                        await manager.broadcast_to_room(room_id, {
                            "type": "system",
                            "message": "⏳ Please wait before asking DJ again."
                        })
                        continue

                    user_last_dj_request[user_key] = datetime.now()
                    query = chat_message[3:].strip()

                    if query:
                        # Notify users that AI is thinking
                        await manager.broadcast_to_room(room_id,
                                                        {"type": "system", "message": "🤖 DJ VibeBot is thinking..."})

                        # Fetch recent chat context
                        recent_chats_db = db.query(models.ChatMessage, models.User.username) \
                            .join(models.User, models.ChatMessage.user_id == models.User.id) \
                            .filter(models.ChatMessage.room_id == room_id) \
                            .order_by(desc(models.ChatMessage.created_at)) \
                            .limit(5) \
                            .all()

                        chat_history = [{"username": c.username, "message": c.ChatMessage.message}
                                        for c in recent_chats_db[::-1]]

                        # [ADD] Import Queue Context
                        # Check songs that have not yet been played (is_played=False)
                        queue_db = db.query(models.QueueItem) \
                            .filter(models.QueueItem.room_id == room_id, models.QueueItem.is_played == False) \
                            .order_by(models.QueueItem.created_at.asc()) \
                            .limit(5) \
                            .all()

                        current_queue_context = [{"title": q.title, "artist": q.artist} for q in queue_db]
                        # Get AI Response
                        ai_reply = await get_ai_dj_response(query, username, chat_history, current_queue_context)

                        # Save AI Response
                        ai_chat_entry = models.ChatMessage(
                            room_id=room_id,
                            user_id=BOT_USER_ID,
                            message=f"[VibeBot] {ai_reply}"
                        )
                        db.add(ai_chat_entry)
                        db.commit()

                        # Broadcast AI Response
                        await manager.broadcast_to_room(room_id, {
                            "type": "chat",
                            "user_id": BOT_USER_ID,
                            "username": "🤖 VibeBot",
                            "message": ai_reply,
                            "created_at": datetime.now().isoformat()
                        })

                # URL Detection & Auto-Add to Queue
                found_urls = url_pattern.findall(chat_message)
                for url in found_urls:
                    added_item = await process_music_addition(
                        room_id=room_id,
                        user_id=user_id,
                        music_url=url,
                        db=db,
                        title=f"Shared by {username}",
                        artist="Unknown"
                    )
                    if added_item:
                        await manager.broadcast_to_room(room_id, {
                            "type": "queue_update",
                            "user_id": user_id,
                            "title": added_item.title,
                            "artist": added_item.artist,
                            "thumbnail_url": added_item.thumbnail_url,
                            "music_url": added_item.music_url,
                            "platform": added_item.platform
                        })
                        await manager.broadcast_to_room(room_id, {
                            "type": "system",
                            "message": f"🎵 '{added_item.title}' has been added to the queue!"
                        })

        except WebSocketDisconnect:
            manager.disconnect(websocket, room_id)

    finally:
        # Always close the manual session
        db.close()