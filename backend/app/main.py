# [backend/app/main.py] - CONFLICT RESOLUTION FINAL CODE

import logging
import random
import string
import json
from typing import List, Optional
import re
from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session
from fastapi.middleware.cors import CORSMiddleware
from collections import defaultdict
from datetime import datetime, timedelta
from sqlalchemy import desc

# Imports with 'app' directory structure
from app import database
from app.models import models
from app.schemas import schemas
from app.utils import extract_video_metadata, detect_platform
from app.ai import get_ai_dj_response

# Configure Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Add API Metadata
app = FastAPI(
    title="VibeSyncer API",
    description="Real-time collaborative music platform with WebSocket support",
    version="0.1.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------
# Constants & Global Variables
# ---------------------------------------------------------

# Rate Limiting Setup (Prevent Spam)
user_last_dj_request = defaultdict(lambda: datetime.min)
DJ_COOLDOWN_SECONDS = 10

# Dedicated Bot User ID
BOT_USER_ID = 0


# ---------------------------------------------------------
# Startup Events
# ---------------------------------------------------------
@app.on_event("startup")
def ensure_bot_user_exists():
    """
    Create a system bot user (ID=0) if it doesn't exist.
    This prevents ForeignKeyViolation errors when saving AI messages.
    """
    db = database.SessionLocal()
    try:
        # Check if the bot user exists
        bot_user = db.query(models.User).filter(models.User.id == BOT_USER_ID).first()

        if not bot_user:
            # Create if not exists (Force ID to 0)
            logger.info(f"🤖 Creating System Bot User (ID: {BOT_USER_ID})...")
            bot_user = models.User(id=BOT_USER_ID, username="🤖 VibeBot")
            db.add(bot_user)
            db.commit()
            logger.info("✅ System Bot User created successfully!")
        else:
            logger.info(f"✅ System Bot User (ID: {BOT_USER_ID}) is ready.")

    except Exception as e:
        logger.error(f"⚠️ Warning: Failed to check/create bot user. Error: {e}")
    finally:
        db.close()


# ---------------------------------------------------------
# Utility Functions
# ---------------------------------------------------------
def generate_room_code(length=6):
    """Generate a random alphanumeric string of fixed length."""
    characters = string.ascii_uppercase + string.digits
    return ''.join(random.choice(characters) for i in range(length))


# Common logic to add music to DB (Used by both API and WebSocket)
async def process_music_addition(
        room_id: int,
        user_id: int,
        music_url: str,
        db: Session,
        thumbnail_url: Optional[str] = None,
        title: str = "Unknown Title",
        artist: str = "Unknown Artist"
):
    # 1. Detect Platform (Using utility function)
    detected_platform = detect_platform(music_url)

    if not detected_platform:
        return None  # Return None if platform is not supported

    # 2. Extract Real Metadata
    TARGET_PLATFORMS = ["Youtube", "Soundcloud", "Spotify"]

    if detected_platform in TARGET_PLATFORMS:
        # Attempt extraction only if title is placeholder
        if title == "Unknown Title" or title.startswith("Shared by"):
            metadata = extract_video_metadata(music_url)
            if metadata:
                title = metadata.get("title", title)
                artist = metadata.get("artist", artist)

                if not thumbnail_url:
                    thumbnail_url = metadata.get("thumbnail_url")

    # 3. Save to DB
    db_item = models.QueueItem(
        room_id=room_id,
        user_id=user_id,
        title=title,
        artist=artist,
        music_url=music_url,
        thumbnail_url=thumbnail_url,
        platform=detected_platform,
        is_played=False
    )
    db.add(db_item)
    db.commit()
    db.refresh(db_item)

    return db_item


# ---------------------------------------------------------
# WebSocket Connection Manager
# ---------------------------------------------------------
class ConnectionManager:
    def __init__(self):
        # Manage active connections using room_id (int) for efficiency
        self.active_connections: dict[int, List[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, room_id: int):
        await websocket.accept()
        if room_id not in self.active_connections:
            self.active_connections[room_id] = []
        self.active_connections[room_id].append(websocket)

    def disconnect(self, websocket: WebSocket, room_id: int):
        if room_id in self.active_connections:
            if websocket in self.active_connections[room_id]:
                self.active_connections[room_id].remove(websocket)
            if not self.active_connections[room_id]:
                del self.active_connections[room_id]

    async def broadcast_to_room(self, room_id: int, message: dict):
        if room_id in self.active_connections:
            for connection in self.active_connections[room_id]:
                try:
                    await connection.send_json(message)
                except Exception as e:
                    # Log the exception instead of silent pass
                    logger.error(f"Failed to send message to connection: {e}")
                    pass


manager = ConnectionManager()


# ---------------------------------------------------------
# API Endpoints
# ---------------------------------------------------------

@app.get("/")
def read_root():
    return {"message": "VibeSyncer Backend is Running!"}


@app.post("/rooms/", response_model=schemas.RoomResponse)
def create_room(room: schemas.RoomCreate, db: Session = Depends(database.get_db)):
    # 1. Create Host User
    db_user = models.User(username=room.host_nickname)
    db.add(db_user)
    db.commit()
    db.refresh(db_user)

    # 2. Generate Code
    while True:
        new_code = generate_room_code()
        existing_code = db.query(models.Room).filter(models.Room.room_code == new_code).first()
        if not existing_code:
            break

    # 3. Create Room
    db_room = models.Room(
        name=room.name,
        host_id=db_user.id,
        room_code=new_code
    )
    db.add(db_room)
    db.commit()
    db.refresh(db_room)

    # Return response schema explicitly to avoid lazy loading issues
    return schemas.RoomResponse(
        id=db_room.id,
        name=db_room.name,
        room_code=db_room.room_code,
        host_id=db_room.host_id,
        host_nickname=db_user.username,
        created_at=db_room.created_at
    )


@app.get("/rooms/{room_code}/host", response_model=schemas.RoomHostResponse)
def get_room_host(room_code: str, db: Session = Depends(database.get_db)):
    """
    Get the host's nickname for a specific room code.
    Useful for displaying room details before joining.
    """
    db_room = db.query(models.Room).filter(models.Room.room_code == room_code).first()
    if not db_room:
        raise HTTPException(status_code=404, detail="Invalid Room Code")

    return schemas.RoomHostResponse(
        room_code=db_room.room_code,
        host_nickname=db_room.host_nickname,
        host_id=db_room.host_id,
        room_name=db_room.name
    )

@app.get("/rooms/{room_code}", response_model=schemas.RoomDetailsResponse)
def get_room_details(room_code: str, db: Session = Depends(database.get_db)):
    """
    Get full room details including host info and list of participants.
    """
    db_room = db.query(models.Room).filter(models.Room.room_code == room_code).first()
    if not db_room:
        raise HTTPException(status_code=404, detail="Invalid Room Code")

    participants_query = db.query(
        models.Room.participants.user_id,
        models.Room.participants.joined_at,
        models.User.username.label("nickname"),
    ).join(models.User, models.RoomParticipant.user_id == models.User.id)\
     .filter(models.RoomParticipant.room_id == db_room.id).all()

    participants_list = [
        schemas.ParticipantInfo(
            user_id=p.user_id,
            nickname=p.nickname,
            joined_at=p.joined_at
        ) for p in participants_query
    ]

    return schemas.RoomDetailResponse(
        room_id=db_room.id,
        room_code=db_room.room_code,
        name=db_room.name,
        created_at=db_room.created_at,
        host_id=db_room.host_id,
        host_nickname=db_room.host_nickname,
        participants=participants_list
    )

@app.post("/rooms/join", response_model=schemas.ParticipantResponse)
def join_room(join_data: schemas.RoomJoin, db: Session = Depends(database.get_db)):
    db_room = db.query(models.Room).filter(models.Room.room_code == join_data.room_code).first()
    if not db_room:
        raise HTTPException(status_code=404, detail="Invalid Room Code")

    duplicate_user = db.query(models.RoomParticipant) \
        .join(models.User) \
        .filter(models.RoomParticipant.room_id == db_room.id) \
        .filter(models.User.username == join_data.nickname) \
        .first()

    if duplicate_user:
        raise HTTPException(status_code=409, detail="Nickname already exists in this room.")

    db_user = models.User(username=join_data.nickname)
    db.add(db_user)
    db.commit()
    db.refresh(db_user)

    db_participant = models.RoomParticipant(user_id=db_user.id, room_id=db_room.id)
    db.add(db_participant)
    db.commit()
    db.refresh(db_participant)

    # Return detailed response by mapping fields manually
    return schemas.ParticipantResponse(
        id=db_participant.id,
        user_id=db_participant.user_id,
        room_id=db_participant.room_id,
        joined_at=db_participant.joined_at,
        room_name=db_room.name,
        room_code=db_room.room_code,
        host_nickname=db_room.host_nickname,
        nickname=db_user.username
    )


@app.post("/rooms/leave")
async def leave_room(room_id: int, user_id: int, db: Session = Depends(database.get_db)):
    participant = db.query(models.RoomParticipant).filter(
        models.RoomParticipant.room_id == room_id,
        models.RoomParticipant.user_id == user_id
    ).first()

    if not participant:
        raise HTTPException(status_code=404, detail="Participant not found")

    user = db.query(models.User).filter(models.User.id == user_id).first()
    username = user.username if user else "Unknown"

    db.delete(participant)
    if user:
        db.delete(user)
    db.commit()

    await manager.broadcast_to_room(room_id, {
        "type": "system",
        "message": f"{username} has left the room."
    })

    return {"message": "Successfully left the room"}


@app.delete("/rooms/{room_code}")
async def delete_room(room_code: str, request_user_id: int, db: Session = Depends(database.get_db)):
    db_room = db.query(models.Room).filter(models.Room.room_code == room_code).first()
    if not db_room:
        raise HTTPException(status_code=404, detail="Room not found")

    if db_room.host_id != request_user_id:
        raise HTTPException(status_code=403, detail="Only the host can dissolve the room")

    room_id = db_room.id

    # Collect all participant (guest) IDs before deleting the room.
    participant_rows = db.query(models.RoomParticipant.user_id) \
        .filter(models.RoomParticipant.room_id == room_id) \
        .all()

    # Convert tuple list [(1,), (3,)] -> list [1, 3]
    guest_user_ids = [p[0] for p in participant_rows]

    # 1. Delete Room (Chat, Queue, Participants are automatically deleted by CASCADE)
    db.delete(db_room)

    # 2. Delete Guest Users
    if guest_user_ids:
        db.query(models.User).filter(models.User.id.in_(guest_user_ids)).delete(synchronize_session=False)

    # 3. Delete Host User
    host_user = db.query(models.User).filter(models.User.id == request_user_id).first()
    if host_user:
        db.delete(host_user)

    db.commit()

    logger.info(f"Room {room_code} dissolved. Host {request_user_id} and {len(guest_user_ids)} guests deleted.")

    return {"message": "Room and all participants deleted successfully"}


# ---------------------------------------------------------
# Queue & Chat APIs (Modified to use room_code)
# ---------------------------------------------------------

@app.get("/rooms/{room_code}/queue_list", response_model=List[schemas.QueueResponse])
def get_room_queue(room_code: str, db: Session = Depends(database.get_db)):
    # 1. Find Room by Room Code
    room = db.query(models.Room).filter(models.Room.room_code == room_code).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    # 2. Query queue using the found room.id
    return db.query(models.QueueItem).filter(models.QueueItem.room_id == room.id).all()


@app.post("/rooms/{room_code}/queue", response_model=schemas.QueueResponse)
async def add_to_queue(room_code: str, item: schemas.QueueCreate, db: Session = Depends(database.get_db)):
    # 1. Find Room by Room Code
    room = db.query(models.Room).filter(models.Room.room_code == room_code).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    # 2. Use found room.id (process_music_addition uses int id)
    db_item = await process_music_addition(
        room_id=room.id,
        user_id=item.user_id,
        music_url=item.music_url,
        db=db,
        thumbnail_url=item.thumbnail_url,
        title=item.title,
        artist=item.artist
    )

    if not db_item:
        raise HTTPException(status_code=400, detail="Platform not supported")

    # 3. Broadcast (using room.id)
    await manager.broadcast_to_room(room.id, {
        "type": "queue_update",
        "user_id": item.user_id,
        "title": db_item.title,
        "artist": db_item.artist,
        "thumbnail_url": db_item.thumbnail_url,
        "music_url": db_item.music_url,
        "platform": db_item.platform
    })

    return db_item


@app.patch("/rooms/{room_code}/queue/{item_id}", response_model=schemas.QueueResponse)
def update_queue_item(
        room_code: str,
        item_id: int,
        is_played: bool,
        request_user_id: int,
        db: Session = Depends(database.get_db)):
    # 1. Find Room by Room Code
    room = db.query(models.Room).filter(models.Room.room_code == room_code).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    # 2. Check Host Permissions
    if room.host_id != request_user_id:
        raise HTTPException(status_code=403, detail="Only the host can control the playback/queue.")

    # 3. Query item using the found room.id
    db_item = db.query(models.QueueItem) \
        .filter(models.QueueItem.id == item_id, models.QueueItem.room_id == room.id) \
        .first()

    if not db_item:
        raise HTTPException(status_code=404, detail="The song cannot be found.")

    db_item.is_played = is_played
    db.commit()
    db.refresh(db_item)

    return db_item


@app.get("/rooms/{room_code}/chats", response_model=List[schemas.ChatResponse])
def get_room_chats(room_code: str, limit: int = 50, db: Session = Depends(database.get_db)):
    # 1. Find Room by Room Code
    room = db.query(models.Room).filter(models.Room.room_code == room_code).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    # 2. Query chats using the found room.id
    chats = db.query(
        models.ChatMessage.id,
        models.ChatMessage.room_id,
        models.ChatMessage.user_id,
        models.ChatMessage.message,
        models.ChatMessage.created_at,
        models.User.username
    ).join(models.User, models.ChatMessage.user_id == models.User.id) \
        .filter(models.ChatMessage.room_id == room.id) \
        .order_by(models.ChatMessage.created_at.asc()) \
        .limit(limit) \
        .all()
    return chats


# ---------------------------------------------------------
# WebSocket Endpoint (Uses room_code now)
# ---------------------------------------------------------
@app.websocket("/ws/{room_code}/{user_id}")
async def websocket_endpoint(websocket: WebSocket, room_code: str, user_id: int):
    # 0. Validate Room Code & Get Room ID
    # WebSocket does not support Dependency Injection nicely, so we use SessionLocal manually
    db = database.SessionLocal()
    try:
        room = db.query(models.Room).filter(models.Room.room_code == room_code).first()
        if not room:
            # If room code invalid, close connection
            await websocket.close(code=4000, reason="Invalid Room Code")
            return

        # Extract ID for internal logic
        room_id = room.id
        host_id = room.host_id  # For permission check

        # 1. Connect
        await manager.connect(websocket, room_id)

        # 2. Fetch User Info
        user = db.query(models.User).filter(models.User.id == user_id).first()
        username = user.username if user else f"Unknown({user_id})"

        # 3. Broadcast Join
        await manager.broadcast_to_room(room_id, {
            "type": "system",
            "message": f"{username} has joined the room."
        })

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
                    # [Security] Host Only
                    if user_id != host_id:
                        continue  # Ignore unauthorized requests

                    payload["user_id"] = user_id
                    payload["username"] = username
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

                    if datetime.now() - last_request < timedelta(seconds=DJ_COOLDOWN_SECONDS):
                        await manager.broadcast_to_room(room_id, {
                            "type": "system",
                            "message": "⏳ Please wait before asking DJ again."
                        })
                        continue

                    user_last_dj_request[user_key] = datetime.now()
                    query = chat_message[3:].strip()

                    if query:
                        await manager.broadcast_to_room(room_id,
                                                        {"type": "system", "message": "🤖 DJ VibeBot is thinking..."})

                        recent_chats_db = db.query(models.ChatMessage) \
                            .filter(models.ChatMessage.room_id == room_id) \
                            .order_by(desc(models.ChatMessage.created_at)) \
                            .limit(5) \
                            .all()

                        chat_history = [{"username": "User", "message": c.message} for c in recent_chats_db[::-1]]

                        ai_reply = await get_ai_dj_response(query, username, chat_history)

                        ai_chat_entry = models.ChatMessage(
                            room_id=room_id,
                            user_id=BOT_USER_ID,
                            message=f"[VibeBot] {ai_reply}"
                        )
                        db.add(ai_chat_entry)
                        db.commit()

                        await manager.broadcast_to_room(room_id, {
                            "type": "chat",
                            "user_id": BOT_USER_ID,
                            "username": "🤖 VibeBot",
                            "message": ai_reply,
                            "created_at": datetime.now().isoformat()
                        })

                # URL Detection
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
        db.close()
