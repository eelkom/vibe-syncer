# backend/app/ai.py

import os
import re
import logging
import asyncio
from concurrent.futures import ThreadPoolExecutor
from dotenv import load_dotenv
from datetime import datetime
from google import genai
from google.genai import types
from app.utils import search_youtube_video, executor

# [Fix] Configure Logger
logger = logging.getLogger(__name__)

load_dotenv()

api_key = os.getenv("GEMINI_API_KEY")

client = None
if api_key:
    client = genai.Client(api_key=api_key)

# ==========================================
# [Task] Regex Patterns for Sanitization
# ==========================================
# Match raw URLs (http/https) but we will handle [[SONG:]] separately

BOLD_PATTERN = re.compile(r'\*\*(.*?)\*\*')
CODE_BLOCK_PATTERN = re.compile(r'```[\s\S]*?```')
SONG_TAG_PATTERN = re.compile(r'\[\[SONG:.*?\]\]')
URL_PATTERN = re.compile(r'https?://\S+')

def sanitize_user_input(message: str) -> str:
    """
        Clean user input before sending to AI.
        - Limit length to 500 chars
        - Remove potential prompt injection patterns
        - Strip dangerous characters
        - Return empty string if input is whitespace only
    """
    if not message:
        return ""

    clean_message = message.strip()
    if not clean_message:
        return ""

    clean_message = clean_message[:500]
    injection_patterns = [
        r'\[INSTRUCTION[S]?\]',
        r'\[SYSTEM\]',
        r'\[ROLE\]',
        r'\[CONTEXT\]',
        r'\[USER\]',
        r'ignore\s+(previous|above)\s+instructions?',
        r'disregard\s+(previous|above)',
    ]
    for pattern in injection_patterns:
        clean_message = re.sub(pattern, ' ', clean_message, flags=re.IGNORECASE)

    return clean_message.strip()

def sanitize_ai_response(response: str) -> str:
    """
        Clean AI response before broadcasting to room.
        - Remove unwanted URLs (hallucinated by AI)
        - Limit response length to 1000 chars
        - Remove markdown formatting and code blocks
        - PRESERVE [[SONG: ...]] tags
    """
    if not response:
        return ""

    song_tags = SONG_TAG_PATTERN.findall(response)
    for i, tag in enumerate(song_tags):
        response = response.replace(tag, f"__SONG_PLACEHOLDER_{i}__")

    response = CODE_BLOCK_PATTERN.sub('', response)
    response = URL_PATTERN.sub('', response)
    response = BOLD_PATTERN.sub(r'\1', response)

    for i, tag in enumerate(song_tags):
        response = response.replace(f"__SONG_PLACEHOLDER_{i}__", tag)

    if len(response) > 1000:
        response = response[:997] + "..."

    return response.strip()

async def get_ai_dj_response(user_message: str, user_name: str, chat_history: list = [], current_queue: list = []) -> str:
    """
    Generate response using AI for content + yt-dlp for reliable linking.
    The AI generates a [[SONG: ...]] tag, and the backend replaces it with a real link.
    """
    clean_message = sanitize_user_input(user_message)
    if not clean_message:
        return "🤖 I didn't catch that. Could you try again?"

    if not client:
        logger.error("❌ GEMINI_API_KEY is missing.")
        return "🤖 DJ Unavailable (API Key Missing)"

    # Get current date for context
    now = datetime.now().strftime("%Y-%m-%d")

    # Format chat history
    history_text = ""
    if chat_history:
        history_text = "[Previous Conversation]\n"
        for msg in chat_history:
            sender = msg.get("username", "Unknown")
            content = msg.get("message", "")
            history_text += f"- {sender}: {content}\n"

    # [ADD] Converting queue information to text
    queue_text = "No music in queue."
    if current_queue:
        queue_titles = [f"{item['title']} - {item['artist']}" for item in current_queue]
        queue_text = ", ".join(queue_titles)

    try:
        # [Change] Adding a Current Queue Section to the Prompt
        # [Prompt Instructions]
        prompt = f"""
        [Role]
        You are 'VibeBot', a smart AI DJ with access to Google Search.

        [Current Context]
        - **System Date**: {now}
        - **User**: {user_name}
        - **Current Queue (Now Playing/Next)**: {queue_text}

        {history_text}

        [User's Input]
        {user_name}: {user_message}

        [INSTRUCTIONS]
        1. **Intent Analysis**: Determine if the user wants a music recommendation or just chatting.
        2. **Music Recommendation Mode**:
           - Use Google Search to find the PERFECT song (latest hits or classics).
           - **CRITICAL RULE**: Do NOT generate the YouTube link yourself. You are not good at it.
           - Instead, output a special tag: `[[SONG: Artist Name - Song Title]]`.
           - The system will automatically replace this tag with the real valid link.
           - **Queue Awareness**: Check the 'Current Queue'. If a song is already there, recommend something else!
           
        3. **Chat Mode**: Answer politely and wittily in 1-2 sentences.

        [OUTPUT FORMATS - STRICT]

        **Format (Music)**:
        [Artist] - [Title]
        [[SONG: Artist - Title]]
        (One sentence comment in Korean)

        **Format (Chat)**:
        (Polite answer in Korean)

        [Rules]
        - **Language**: Detect the language of the user's input and respond in the SAME language.
        - No meta-talk (e.g., "I found this song...").
        - No Markdown bolding (`**`) for the song title.
        - **NEVER** output a URL starting with `https://`. Use the `[[SONG: ...]]` tag only.

        VibeBot:
        """

        # 1. Generate AI response (including tags)
        response = await client.aio.models.generate_content(
            model='gemini-2.0-flash',
            contents=prompt,
            config=types.GenerateContentConfig(
                temperature=0.7,
                top_p=0.95,
                top_k=40,
                max_output_tokens=600,
                tools=[types.Tool(google_search=types.GoogleSearch())]
            )
        )

        ai_text = response.text.strip()

        ai_text = sanitize_ai_response(ai_text)

        # 2. [Backend Logic] Find tags ([[SONG: ...]]) and replace with real links
        matches = re.findall(r"\[\[SONG: (.*?)\]\]", ai_text)

        # Get the current event loop
        loop = asyncio.get_event_loop()

        for search_query in matches:
            # [Fix] Run blocking yt-dlp search in a separate thread
            # This ensures WebSocket connections don't freeze for other users
            real_url = await loop.run_in_executor(executor, search_youtube_video, search_query)

            if real_url:
                replacement = f"(👉 Listen: {real_url})"
            else:
                replacement = f"(👉 Search: https://www.youtube.com/results?search_query={search_query.replace(' ', '+')})"

            ai_text = ai_text.replace(f"[[SONG: {search_query}]]", replacement)

        return ai_text

    except Exception as e:
        # [Fix] Improved Error Logging (Mentor Feedback)
        # exc_info=True includes the full stack trace in the logs
        logger.error(f"AI DJ Error: {e}", exc_info=True)
        return "🤖 Sorry, I'm having trouble right now. Please try again later."
