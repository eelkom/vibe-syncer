# backend/app/utils.py

import logging
import urllib.request
import re
import ssl
import yt_dlp
import string
import random
import os
from typing import Optional, Dict, Any
from sqlalchemy.orm import Session
from app.models import models
import asyncio
from concurrent.futures import ThreadPoolExecutor

# Configure Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
executor = ThreadPoolExecutor(max_workers=3)


def get_cookie_path():
    local_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'cookies.txt')
    render_path = "/etc/secrets/cookies.txt"

    if os.path.exists(local_path):
        return local_path
    elif os.path.exists(render_path):
        return render_path
    else:
        return None

# ---------------------------------------------------------
# 1. New Utility: Room Code Generator
# ---------------------------------------------------------
def generate_room_code(length=6) -> str:
    """
    Generate a random alphanumeric string of fixed length.
    Used for creating unique room codes (e.g., 'A1B2C3').
    """
    characters = string.ascii_uppercase + string.digits
    return ''.join(random.choice(characters) for i in range(length))


# ---------------------------------------------------------
# 2. Existing Utility: Platform Detection
# ---------------------------------------------------------
def detect_platform(url: str):
    """
    Detect the platform from the URL string.
    """
    # [Debug] Print the URL being checked
    logger.debug(f" Checking URL: {url}")

    url_lower = url.lower()

    # 1. YouTube
    if "youtube.com" in url_lower or "youtu.be" in url_lower:
        logger.info("✅ Platform Detected: Youtube")
        return "Youtube"

    # 2. SoundCloud
    if "soundcloud.com" in url_lower:
        logger.info("✅ Platform Detected: Soundcloud")
        return "Soundcloud"

    # 3. Spotify
    if "spotify" in url_lower:
        logger.info("✅ Platform Detected: Spotify")
        return "Spotify"

    logger.warning("❌ Platform Detection Failed: Unsupported URL")
    return None


# ---------------------------------------------------------
# 3. Existing Utility: Spotify Scraper (Bypass DRM)
# ---------------------------------------------------------
def fetch_spotify_metadata(url: str):
    """
    Fetch metadata by scraping the Spotify HTML page directly.
    This bypasses DRM errors from yt-dlp.
    """
    logger.info(f"ℹ️ Scraping Spotify HTML for: {url}")

    try:
        # 1. Prepare Request with User-Agent (mimic a real browser)
        req = urllib.request.Request(
            url,
            data=None,
            headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        )

        # 2. Create SSL context to ignore certificate errors
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

        # 3. Read HTML Content
        with urllib.request.urlopen(req, context=ctx) as response:
            html_content = response.read().decode('utf-8')

            # 4. Extract Metadata using Regex (Open Graph tags)
            title_match = re.search(r'<meta property="og:title" content="(.*?)"', html_content)
            title = title_match.group(1) if title_match else "Unknown Title"

            thumbnail_match = re.search(r'<meta property="og:image" content="(.*?)"', html_content)
            thumbnail_url = thumbnail_match.group(1) if thumbnail_match else None

            artist = "Unknown Artist"
            desc_match = re.search(r'<meta property="og:description" content="(.*?)"', html_content)
            if desc_match:
                description = desc_match.group(1)
                if '·' in description:
                    artist = description.split('·')[0].strip()
                else:
                    artist = description  # Fallback

            logger.info(f"🎉 [Spotify Scraper] Success! Title: {title} / Artist: {artist}")

            return {
                "title": title,
                "artist": artist,
                "thumbnail_url": thumbnail_url
            }

    except Exception as e:
        logger.error(f"💥 [Spotify Error] HTML scraping failed: {e}")
        return None


# ---------------------------------------------------------
# 4. Existing Utility: General Metadata Extractor
# ---------------------------------------------------------
def extract_video_metadata(url: str):
    logger.info(f"🚀 Starting Metadata Extraction for: {url}")

    # STRATEGY 1: Use Custom Scraper for Spotify
    if "spotify" in url.lower():
        return fetch_spotify_metadata(url)

    cookie_path = get_cookie_path()
    if not cookie_path:
        logger.warning("⚠️ cookies.txt not found! YouTube request might fail.")

    # STRATEGY 2: Use yt-dlp for YouTube & SoundCloud
    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'format': 'bestaudio/best',
        'ignoreerrors': True,
        'no_playlist': True,
        'nocheckcertificate': True,
        'source_address': '0.0.0.0',
        # [NOTE] cookies.txt Security & Deployment
        # This file is not included in Git (.gitignore) for security reasons.
        # Infused through 'Secret Files' on the Render dashboard.
        'cookiefile': cookie_path,
        'http_headers': { 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-us,en;q=0.5',
        },
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)

            if not info:
                logger.info(f"❌ [DEBUG] Extraction Failed: Info is empty")
                return None

            if 'entries' in info:
                entries = list(info['entries'])
                info = entries[0] if entries else None
                if not info: return None

            title = info.get('title', 'Unknown Title')
            artist = info.get('artist') or info.get('uploader') or info.get('creator') or info.get(
                'channel') or 'Unknown Artist'

            thumbnail_url = info.get('thumbnail')
            thumbnails = info.get('thumbnails', [])
            if thumbnails:
                thumbnail_url = thumbnails[-1].get('url')

            logger.info(f"🎉 [yt-dlp] Success! Title: {title} / Artist: {artist}")

            return {
                "title": title,
                "artist": artist,
                "thumbnail_url": thumbnail_url
            }

    except Exception as e:
        logger.error(f"💥 Critical Error during extraction: {e}")
        return None


# ---------------------------------------------------------
# 5. Existing Utility: YouTube Search (For AI DJ)
# ---------------------------------------------------------
def search_youtube_video(query: str):
    """
    Search YouTube via yt-dlp and return the URL of the first result.
    """

    logger.info(f"🔍 [Backend Search] Searching YouTube for: {query}")

    cookie_path = get_cookie_path()
    if not cookie_path:
        logger.warning("⚠️ cookies.txt not found! YouTube request might fail.")

    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'default_search': 'ytsearch1',
        'noplaylist': True,
        'nocheckcertificate': True,
        'source_address': '0.0.0.0',
        'cookiefile': cookie_path,
        'http_headers': {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-us,en;q=0.5',
        },
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(query, download=False)

            if 'entries' in info and info['entries']:
                video_url = info['entries'][0].get('webpage_url')
                logger.info(f"✅ [Backend Search] Found URL: {video_url}")
                return video_url
            elif 'webpage_url' in info:
                video_url = info['webpage_url']
                logger.info(f"✅ [Backend Search] Found URL: {video_url}")
                return video_url
            else:
                logger.info(f"⚠️ [Backend Search] No results found for: {query}")

    except Exception as e:
        logger.error(f"💥 [Backend Search Error] {e}")

    return None


# ---------------------------------------------------------
# 6. New Utility: Process Music Addition (Moved from main.py)
# ---------------------------------------------------------
async def process_music_addition(
        room_id: int,
        user_id: int,
        music_url: str,
        db: Session,
        thumbnail_url: Optional[str] = None,
        title: str = "Unknown Title",
        artist: str = "Unknown Artist"
) -> Optional[models.QueueItem]:
    """
    Process adding a music item to the queue.
    Integrates detect_platform and extract_video_metadata.
    """
    # 1. Detect Platform
    detected_platform = detect_platform(music_url)

    if not detected_platform:
        return None  # Return None if platform is not supported

    # 2. Extract Real Metadata (Modified for Non-blocking)
    # If title is generic or explicitly unknown, try to scrape
    TARGET_PLATFORMS = ["Youtube", "Soundcloud", "Spotify"]

    if detected_platform in TARGET_PLATFORMS:
        if title == "Unknown Title" or title.startswith("Shared by"):
            loop = asyncio.get_event_loop()

            metadata = await loop.run_in_executor(executor, extract_video_metadata, music_url)

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