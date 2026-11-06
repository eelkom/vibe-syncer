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
from app.ai import (
    DJ_FAILURE_MESSAGE,
    WELCOME_FALLBACK_TEMPLATE,
    get_ai_dj_response,
    get_ai_welcome_message,
)
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
welcomed_users = TTLCache(maxsize=10000, ttl=3600)
background_tasks = set()
DJ_COOLDOWN_SECONDS = 10
WELCOME_TIMEOUT_SECONDS = 8
DJ_TIMEOUT_SECONDS = 30
BOT_USER_ID = 0


async def send_welcome_message(room_id: int, username: str):
    db = database.SessionLocal()
    try:
        try:
            welcome_msg = await asyncio.wait_for(
                get_ai_welcome_message(username), timeout=WELCOME_TIMEOUT_SECONDS
            )
        except Exception:
            logger.exception(f"AI welcome failed for {username} in room {room_id}")
            welcome_msg = WELCOME_FALLBACK_TEMPLATE.format(username=username)

        ai_chat_entry = models.ChatMessage(
            room_id=room_id,
            user_id=BOT_USER_ID,
            message=f"[VibeBot] {welcome_msg}"
        )
        db.add(ai_chat_entry)
        db.commit()
        db.refresh(ai_chat_entry)

        await manager.broadcast_to_room(room_id, {
            "type": "chat",
            "id": ai_chat_entry.id,
            "room_id": room_id,
            "user_id": BOT_USER_ID,
            "username": "🤖 VibeBot",
            "message": welcome_msg,
            "created_at": ai_chat_entry.created_at.isoformat()
        })

        logger.info(f"AI Welcome message sent to {username} in room {room_id}")
    except Exception:
        logger.exception(f"Failed to send AI welcome message in room {room_id}")
    finally:
        db.close()


async def process_chat_actions(
    room_id: int, user_id: int, username: str, dj_query: str, found_urls: List[str]
):
    db = database.SessionLocal()
    try:
        if dj_query:
            await manager.broadcast_to_room(room_id, {
                "type": "system", "message": "🤖 DJ VibeBot is thinking..."
            })

            recent_chats_db = db.query(models.ChatMessage, models.User.username) \
                .join(models.User, models.ChatMessage.user_id == models.User.id) \
                .filter(models.ChatMessage.room_id == room_id) \
                .order_by(desc(models.ChatMessage.created_at)) \
                .limit(5) \
                .all()

            chat_history = [{"username": c.username, "message": c.ChatMessage.message}
                            for c in recent_chats_db[::-1]]

            queue_db = db.query(models.QueueItem) \
                .filter(models.QueueItem.room_id == room_id, models.QueueItem.is_played == False) \
                .order_by(models.QueueItem.created_at.asc()) \
                .limit(5) \
                .all()

            current_queue_context = [{"title": q.title, "artist": q.artist} for q in queue_db]
            db.rollback()
            try:
                ai_reply = await asyncio.wait_for(
                    get_ai_dj_response(dj_query, username, chat_history, current_queue_context),
                    timeout=DJ_TIMEOUT_SECONDS
                )
            except Exception:
                logger.exception(f"AI DJ failed for user {user_id} in room {room_id}")
                ai_reply = DJ_FAILURE_MESSAGE

            ai_chat_entry = models.ChatMessage(
                room_id=room_id,
                user_id=BOT_USER_ID,
                message=f"[VibeBot] {ai_reply}"
            )
            db.add(ai_chat_entry)
            db.commit()
            db.refresh(ai_chat_entry)

            await manager.broadcast_to_room(room_id, {
                "type": "chat",
                "id": ai_chat_entry.id,
                "room_id": room_id,
                "user_id": BOT_USER_ID,
                "username": "🤖 VibeBot",
                "message": ai_reply,
                "created_at": ai_chat_entry.created_at.isoformat()
            })

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
    except Exception:
        logger.exception(f"Chat actions failed for user {user_id} in room {room_id}")
    finally:
        db.close()


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

        if payload.get("room_id") != room.id:
            await websocket.close(code=4003, reason="Token is for another room")
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
        # Return the connection to the pool before waiting or starting background work.
        db.rollback()

        # 5. Broadcast Join
        welcome_key = (room_id, user_id)
        if welcome_key not in welcomed_users:
            welcomed_users[welcome_key] = True
            await manager.broadcast_to_room(room_id, {
                "type": "system",
                "message": f"{username} has joined the room."
            })
            task = asyncio.create_task(send_welcome_message(room_id, username))
            background_tasks.add(task)
            task.add_done_callback(background_tasks.discard)

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
                # ==========================================================
                # [ADD] 3. Late Join Sync Request Handling
                # ==========================================================
                if message_type == "request_sync":
                    current_state = manager.get_room_state(room_id)

                    if current_state:
                        await websocket.send_json(current_state)
                        logger.info(f"Sent sync state on request to user {user_id} in room {room_id}")
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
                    "id": new_chat.id,
                    "room_id": room_id,
                    "user_id": user_id,
                    "username": username,
                    "message": chat_message,
                    "created_at": new_chat.created_at.isoformat()
                })
                db.rollback()

                dj_query = ""
                # AI Trigger (!dj)
                if chat_message.lower().startswith("!dj"):
                    user_key = f"{room_id}:{user_id}"
                    last_request = user_last_dj_request.get(user_key)

                    # Cooldown Check
                    if last_request and datetime.now() - last_request < timedelta(seconds=DJ_COOLDOWN_SECONDS):
                        await manager.broadcast_to_room(room_id, {
                            "type": "system",
                            "message": "⏳ Please wait before asking DJ again."
                        })
                        continue

                    user_last_dj_request[user_key] = datetime.now()
                    dj_query = chat_message[3:].strip()

                # URL Detection & Auto-Add to Queue
                found_urls = url_pattern.findall(chat_message)
                if dj_query or found_urls:
                    task = asyncio.create_task(process_chat_actions(
                        room_id, user_id, username, dj_query, found_urls
                    ))
                    background_tasks.add(task)
                    task.add_done_callback(background_tasks.discard)

        except WebSocketDisconnect:
            manager.disconnect(websocket, room_id)
        except Exception:
            # Don't leave a dead connection in the room on unexpected errors
            logger.exception(f"WebSocket loop failed for user {user_id} in room {room_id}")
            manager.disconnect(websocket, room_id)

    finally:
        # Always close the manual session
        db.close()
