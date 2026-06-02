# VibeSyncer

**Music, Chat, and Vibes in Sync**

A real-time web app where friends can share music, chat, and listen together in synchronized rooms — built during a 4-week internship at Datahouse Asia.

---

## Features

- **Music Rooms** — Create a room or join with a code. Host controls playback for everyone.
- **Synchronized Playback** — Play, pause, and skip stay in sync across all participants via WebSocket.
- **Music Queue** — Add YouTube links to a shared queue. Tracks display title, artist, and thumbnail.
- **Real-time Chat** — Live group chat inside each room, broadcast over WebSocket.
- **AI DJ (VibeBot)** — An AI DJ powered by Gemini 2.0 Flash that recommends songs, reads the room's vibe, and responds to user prompts. Uses Google Search to find real tracks and yt-dlp to resolve YouTube links.
- **Guest Support** — Users can join as guests without an account and stay in sync with playback.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React, TypeScript, Vite, Tailwind CSS |
| Backend | Python, FastAPI |
| Realtime | WebSockets (FastAPI) |
| Database | PostgreSQL (SQLAlchemy ORM) |
| AI | Google Gemini 2.0 Flash + Google Search |
| Music | yt-dlp for YouTube link resolution |
| Deployment | Vercel (frontend), Railway (backend + DB) |

---

## Project Structure

```
vibesyncer/
├── frontend/          # React + TypeScript app
│   └── src/
│       ├── page/
│       │   ├── Landing/       # Create / Join room
│       │   └── MusicRoom/     # Room page (player, queue, chat, AI)
│       ├── components/
│       ├── hooks/
│       └── api/
└── backend/           # FastAPI app
    └── app/
        ├── api/
        │   └── routes/
        │       ├── rooms.py       # Room CRUD + participants
        │       └── websockets.py  # Real-time event handling
        ├── models/    # SQLAlchemy models
        ├── ai.py      # VibeBot (Gemini 2.0 Flash)
        └── main.py
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- Python 3.11+
- PostgreSQL

### Frontend

```bash
cd frontend
npm install
npm run dev
```

### Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

### Environment Variables

**backend/.env**
```
DATABASE_URL=postgresql://...
GEMINI_API_KEY=...
```

**frontend/.env**
```
VITE_API_URL=http://localhost:8000
```

---

## Weekly Progress

| Week | What Was Built |
|------|---------------|
| 1 | Project setup (React + FastAPI), room creation/join flow, database schema (Users, Rooms, Queue, Chat) |
| 2 | Real-time chat via WebSocket, music queue (add/view songs), YouTube embed player |
| 3 | Host-controlled playback (play/pause/skip), cross-client sync, AI DJ endpoints (VibeBot), guest autoplay sync |
| 4 | UI polish, error handling, multi-client edge cases, deployment to Vercel + Railway |

---

## AI DJ — VibeBot

VibeBot is an in-room AI DJ that:

- Recommends songs based on the current queue and user prompts
- Uses **Google Search** (via Gemini) to find real, up-to-date tracks
- Resolves recommendations to actual YouTube links via **yt-dlp**
- Sends a personalized welcome message when a user joins
- Sanitizes all user input and AI output to prevent prompt injection

---

## Deployment

- **Frontend** → Vercel with `vercel.json` for SPA routing fallback
- **Backend** → Railway / Render
- **Database** → Railway Postgres / Supabase
