# backend/app/api/routes/rooms.py

from typing import List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app import database
from app.models import models
from app.schemas import schemas
from app.utils import generate_room_code, process_music_addition
from app.core.websocket_manager import manager  # Import the manager we moved earlier
from app.auth import create_access_token
from app.auth import verify_token

# Create Router instance
router = APIRouter()


# ---------------------------------------------------------
# Room Management APIs
# ---------------------------------------------------------

@router.post("/", response_model=schemas.RoomResponse)
def create_room(room: schemas.RoomCreate, db: Session = Depends(database.get_db)):
    """
    Create a new room.
    URL: POST /rooms/
    """
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

    token_payload = {
        "user_id": db_user.id,
        "room_id": db_room.id,
        "nickname": db_user.username,
        "is_host": True
    }
    access_token = create_access_token(token_payload)

    return schemas.RoomResponse(
        id=db_room.id,
        name=db_room.name,
        room_code=db_room.room_code,
        host_id=db_room.host_id,
        host_nickname=db_user.username,
        created_at=db_room.created_at,
        token=access_token
    )


@router.get("/{room_code}/host", response_model=schemas.RoomHostResponse)
def get_room_host(room_code: str, db: Session = Depends(database.get_db)):
    """
    Get the host's info and room details for a specific room code.
    URL: GET /rooms/{room_code}/host
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


@router.post("/join", response_model=schemas.ParticipantResponse)
def join_room(join_data: schemas.RoomJoin, db: Session = Depends(database.get_db)):
    """
    Join an existing room using room_code.
    URL: POST /rooms/join
    """
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

    token_payload = {
        "user_id": db_user.id,
        "room_id": db_room.id,
        "nickname": db_user.username,
        "is_host": False
    }
    access_token = create_access_token(token_payload)

    return schemas.ParticipantResponse(
        id=db_participant.id,
        user_id=db_participant.user_id,
        room_id=db_participant.room_id,
        joined_at=db_participant.joined_at,
        room_name=db_room.name,
        room_code=db_room.room_code,
        host_nickname=db_room.host_nickname,
        nickname=db_user.username,
        token=access_token
    )


@router.post("/leave")
async def leave_room(room_code: str, token_data: dict = Depends(verify_token), db: Session = Depends(database.get_db)):
    """
    Leave a room.
    URL: POST /rooms/leave
    """
    user_id = token_data["user_id"]

    room = db.query(models.Room).filter(models.Room.room_code == room_code).first()
    if not room:
        raise HTTPException(status_code=404, detail="Invalid Room Code")

    if token_data["room_id"] != room.id:
        raise HTTPException(status_code=403, detail="You are not in this room")

    room_id = room.id

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


@router.delete("/{room_code}")
async def delete_room(room_code: str, token_data: dict = Depends(verify_token), db: Session = Depends(database.get_db)):
    """
    Delete a room (Host only).
    URL: DELETE /rooms/{room_code}
    """
    user_id = token_data["user_id"]

    db_room = db.query(models.Room).filter(models.Room.room_code == room_code).first()
    if not db_room:
        raise HTTPException(status_code=404, detail="Room not found")

    if db_room.host_id != user_id:
        raise HTTPException(status_code=403, detail="Only the host can dissolve the room")

    room_id = db_room.id
    participant_rows = db.query(models.RoomParticipant.user_id) \
        .filter(models.RoomParticipant.room_id == room_id) \
        .all()
    guest_user_ids = [p[0] for p in participant_rows]

    db.delete(db_room)
    if guest_user_ids:
        db.query(models.User).filter(models.User.id.in_(guest_user_ids)).delete(synchronize_session=False)

    host_user = db.query(models.User).filter(models.User.id == user_id).first()
    if host_user:
        db.delete(host_user)

    db.commit()

    return {"message": "Room and all participants deleted successfully"}


# ---------------------------------------------------------
# Queue & Chat APIs (Scoped under /rooms)
# ---------------------------------------------------------

@router.get("/{room_code}/queue_list", response_model=List[schemas.QueueResponse])
def get_room_queue(room_code: str, db: Session = Depends(database.get_db)):
    """
    Get the music queue list.
    URL: GET /rooms/{room_code}/queue_list
    """
    room = db.query(models.Room).filter(models.Room.room_code == room_code).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    return db.query(models.QueueItem).filter(models.QueueItem.room_id == room.id).all()


@router.post("/{room_code}/queue", response_model=schemas.QueueResponse)
async def add_to_queue(room_code: str,
                       item: schemas.QueueCreate,
                       token_data: dict = Depends(verify_token),
                       db: Session = Depends(database.get_db)):
    """
    Add a song to the queue.
    URL: POST /rooms/{room_code}/queue
    """

    real_user_id = token_data["user_id"]

    room = db.query(models.Room).filter(models.Room.room_code == room_code).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    if token_data["room_id"] != room.id:
        raise HTTPException(status_code=403, detail="You are not in this room")

    # Use utility function to process music (extract metadata, save to DB)
    db_item = await process_music_addition(
        room_id=room.id,
        user_id=real_user_id,
        music_url=item.music_url,
        db=db,
        thumbnail_url=item.thumbnail_url,
        title=item.title,
        artist=item.artist
    )

    if not db_item:
        raise HTTPException(status_code=400, detail="Platform not supported")

    # Broadcast update
    await manager.broadcast_to_room(room.id, {
        "type": "queue_update",
        "user_id": real_user_id,
        "title": db_item.title,
        "artist": db_item.artist,
        "thumbnail_url": db_item.thumbnail_url,
        "music_url": db_item.music_url,
        "platform": db_item.platform
    })

    return db_item


@router.patch("/{room_code}/queue/{item_id}", response_model=schemas.QueueResponse)
def update_queue_item(
        room_code: str,
        item_id: int,
        is_played: bool,
        token_data: dict = Depends(verify_token),
        db: Session = Depends(database.get_db)):
    """
    Update queue item status (e.g., mark as played).
    URL: PATCH /rooms/{room_code}/queue/{item_id}
    """
    user_id = token_data["user_id"]

    room = db.query(models.Room).filter(models.Room.room_code == room_code).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    if room.host_id != user_id:
        raise HTTPException(status_code=403, detail="Only the host can control the playback/queue.")

    db_item = db.query(models.QueueItem) \
        .filter(models.QueueItem.id == item_id, models.QueueItem.room_id == room.id) \
        .first()

    if not db_item:
        raise HTTPException(status_code=404, detail="The song cannot be found.")

    db_item.is_played = is_played
    db.commit()
    db.refresh(db_item)

    return db_item


@router.get("/{room_code}/chats", response_model=List[schemas.ChatResponse])
def get_room_chats(room_code: str,
                   limit: int = 50,
                   token_data: dict = Depends(verify_token),
                   db: Session = Depends(database.get_db)):
    """
    Get chat history.
    URL: GET /rooms/{room_code}/chats
    """
    room = db.query(models.Room).filter(models.Room.room_code == room_code).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    if token_data["room_id"] != room.id:
        raise HTTPException(status_code=403, detail="Not authorized to view this chat")
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


@router.get("/{room_code}", response_model=schemas.RoomDetailsResponse)
def get_room_details(room_code: str, db: Session = Depends(database.get_db)):
    """
    Get full room details including host info and list of participants.
    (Refactored version)
    """

    db_room = db.query(models.Room).filter(models.Room.room_code == room_code).first()
    if not db_room:
        raise HTTPException(status_code=404, detail="Invalid Room Code")

    participants_query = db.query(
        models.RoomParticipant.user_id,
        models.RoomParticipant.joined_at,
        models.User.username.label("nickname")
    ).join(models.User, models.RoomParticipant.user_id == models.User.id) \
        .filter(models.RoomParticipant.room_id == db_room.id).all()

    participants_list = [
        schemas.ParticipantInfo(
            user_id=p.user_id,
            nickname=p.nickname,
            joined_at=p.joined_at
        ) for p in participants_query
    ]

    return schemas.RoomDetailsResponse(
        room_id=db_room.id,
        room_code=db_room.room_code,
        name=db_room.name,
        created_at=db_room.created_at,
        host_id=db_room.host_id,
        host_nickname=db_room.host_nickname,
        participants=participants_list
    )


@router.post("/{room_code}/player/next")
async def play_next_song(
        room_code: str,
        token_data: dict = Depends(verify_token),
        db: Session = Depends(database.get_db)
):
    """
    Skip to the next song.
    Logic: Mark the current top unplayed song as played, then broadcast the next one.
    """
    user_id = token_data["user_id"]
    room = db.query(models.Room).filter(models.Room.room_code == room_code).first()

    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    # Check permissions: Only hosts can be controlled (annotated as needed and allowed to all)
    if room.host_id != user_id:
        raise HTTPException(status_code=403, detail="Only the host can skip songs.")


    unplayed_query = db.query(models.QueueItem).filter(
        models.QueueItem.room_id == room.id,
        models.QueueItem.is_played == False
    ).order_by(models.QueueItem.created_at.asc())

    unplayed_songs = unplayed_query.all()

    if not unplayed_songs:
        raise HTTPException(status_code=400, detail="No songs in the queue.")

    current_song = unplayed_songs[0]
    current_song.is_played = True

    next_song = None
    if len(unplayed_songs) > 1:
        next_song = unplayed_songs[1]

    db.commit()

    if next_song:
        await manager.broadcast_to_room(room.id, {
            "type": "player_change",
            "action": "play",
            "music_url": next_song.music_url,
            "title": next_song.title,
            "artist": next_song.artist,
            "thumbnail_url": next_song.thumbnail_url
        })
    else:
        await manager.broadcast_to_room(room.id, {
            "type": "player_change",
            "action": "stop",
            "message": "Queue ended"
        })

    return {"message": "Skipped to next song", "next_song": next_song.title if next_song else "None"}


@router.post("/{room_code}/player/prev")
async def play_prev_song(
        room_code: str,
        token_data: dict = Depends(verify_token),
        db: Session = Depends(database.get_db)
):
    """
    Go back to the previous song.
    Logic: Find the most recently played song, mark it unplayed (active), and broadcast it.
    """
    user_id = token_data["user_id"]
    room = db.query(models.Room).filter(models.Room.room_code == room_code).first()

    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    if room.host_id != user_id:
        raise HTTPException(status_code=403, detail="Only the host can control playback.")

    last_played_song = db.query(models.QueueItem).filter(
        models.QueueItem.room_id == room.id,
        models.QueueItem.is_played == True
    ).order_by(models.QueueItem.created_at.desc()).first()

    if not last_played_song:
        raise HTTPException(status_code=400, detail="No previous songs found.")

    last_played_song.is_played = False
    db.commit()
    db.refresh(last_played_song)

    await manager.broadcast_to_room(room.id, {
        "type": "player_change",
        "action": "play",
        "music_url": last_played_song.music_url,
        "title": last_played_song.title,
        "artist": last_played_song.artist,
        "thumbnail_url": last_played_song.thumbnail_url
    })

    return {"message": "Playing previous song", "song": last_played_song.title}


@router.post("/{room_code}/player/jump/{item_id}")
async def jump_to_song(
        room_code: str,
        item_id: int,
        token_data: dict = Depends(verify_token),
        db: Session = Depends(database.get_db)
):
    """
    Jump to a specific song in the queue.
    Logic: Mark all songs created BEFORE this target as played. Mark target as unplayed.
    """
    user_id = token_data["user_id"]
    room = db.query(models.Room).filter(models.Room.room_code == room_code).first()

    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    if room.host_id != user_id:
        raise HTTPException(status_code=403, detail="Only the host can jump to a song.")

    target_song = db.query(models.QueueItem).filter(
        models.QueueItem.id == item_id,
        models.QueueItem.room_id == room.id
    ).first()

    if not target_song:
        raise HTTPException(status_code=404, detail="Song not found.")

    db.query(models.QueueItem).filter(
        models.QueueItem.room_id == room.id,
        models.QueueItem.created_at < target_song.created_at,
        models.QueueItem.is_played == False
    ).update({"is_played": True}, synchronize_session=False)

    target_song.is_played = False

    db.commit()
    db.refresh(target_song)

    await manager.broadcast_to_room(room.id, {
        "type": "player_change",
        "action": "play",
        "music_url": target_song.music_url,
        "title": target_song.title,
        "artist": target_song.artist,
        "thumbnail_url": target_song.thumbnail_url
    })

    return {"message": f"Jumped to {target_song.title}"}