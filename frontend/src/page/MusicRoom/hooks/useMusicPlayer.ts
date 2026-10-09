import useJumpSong from '@/hooks/mutations/useJumpSong';
import usePlayNextSong from '@/hooks/mutations/usePlayNextSong';
import usePlayPrevSong from '@/hooks/mutations/usePlayPrevSong';
import type { SubscribeSocket } from '@/hooks/useWebSocket';
import type { QueueResponse } from '@/schemas/queueSchema';
import type { SyncSocketMessage } from '@/schemas/socketSchema';
import type { UserData } from '@/types/user';
import { logger } from '@/utils/logger';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type ReactPlayer from 'react-player';
import type { OnProgressProps } from 'react-player/base';

// Muted autoplay counts as failed if playback hasn't started within this time
const AUTOPLAY_TIMEOUT_MS = 2000;

type GuestPlaybackMode = 'muted-autoplay' | 'unmuted' | 'fallback';

interface PendingSync {
  timestamp?: number;
  action: string;
}

interface YouTubeInternalPlayer {
  unMute: () => void;
  playVideo: () => void;
}

const isYouTubeInternalPlayer = (
  player: unknown,
): player is YouTubeInternalPlayer =>
  typeof player === 'object' &&
  player !== null &&
  'unMute' in player &&
  typeof player.unMute === 'function' &&
  'playVideo' in player &&
  typeof player.playVideo === 'function';

interface UseMusicPlayerProps {
  roomCode: string;
  sendMessage: (messageData: object) => void;
  subscribe: SubscribeSocket;
  user: UserData | null;
  currentSong: QueueResponse | undefined;
  onSongEnded?: () => void;
}

const useMusicPlayer = ({
  roomCode,
  sendMessage,
  subscribe,
  user,
  currentSong,
  onSongEnded,
}: UseMusicPlayerProps) => {
  const playerRef = useRef<ReactPlayer>(null);
  const seekTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pendingSyncRef = useRef<PendingSync | null>(null);
  // Latest host state for the current song, used when falling back
  const lastSyncRef = useRef<PendingSync | null>(null);
  // Ready state of the currently mounted player (it remounts on every song)
  const isPlayerReadyRef = useRef(false);
  const isActuallyPlayingRef = useRef(false);

  const [isPlaying, setIsPlaying] = useState(false);
  const [played, setPlayed] = useState(0);
  const [isReady, setIsReady] = useState(false);
  // Guests start playing muted right away; browsers allow muted autoplay
  const [isPlayerEnabled, setIsPlayerEnabled] = useState(true);
  const [hasUnmuted, setHasUnmuted] = useState(false);
  const [readySongUrl, setReadySongUrl] = useState<string>();
  const [duration, setDuration] = useState(0);

  const isMuted = !user?.isHost && !hasUnmuted;
  const guestPlaybackMode: GuestPlaybackMode | null = user?.isHost
    ? null
    : !isPlayerEnabled
      ? 'fallback'
      : isMuted
        ? 'muted-autoplay'
        : 'unmuted';
  const shouldWatchAutoplay =
    !user?.isHost &&
    isPlayerEnabled &&
    isPlaying &&
    readySongUrl !== undefined &&
    readySongUrl === currentSong?.music_url;

  const { mutate: playNext } = usePlayNextSong(roomCode || '');
  const { mutate: playPrev } = usePlayPrevSong(roomCode || '');
  const { mutate: jumpSong } = useJumpSong(roomCode || '');

  useEffect(() => {
    queueMicrotask(() => {
      setIsPlaying(true);
    });
  }, [currentSong]);

  useEffect(() => {
    isPlayerReadyRef.current = false;
    isActuallyPlayingRef.current = false;
    pendingSyncRef.current = null;
    lastSyncRef.current = null;
  }, [currentSong?.music_url]);

  useEffect(() => {
    if (guestPlaybackMode) {
      logger.log(`[Player] Guest playback mode: ${guestPlaybackMode}`);
    }
  }, [guestPlaybackMode]);

  const fallbackToPendingSync = (reason: string) => {
    if (user?.isHost || !isPlayerEnabled) return;

    logger.log(`[Player] Autoplay failed (${reason}), falling back`);
    pendingSyncRef.current = lastSyncRef.current;
    // The player unmounts, so the next mount has to become ready again
    isPlayerReadyRef.current = false;
    isActuallyPlayingRef.current = false;
    setReadySongUrl(undefined);
    setIsPlayerEnabled(false);
  };

  const handleAutoplayTimeout = useEffectEvent(() => {
    if (!isActuallyPlayingRef.current) {
      fallbackToPendingSync('playback did not start');
    }
  });

  useEffect(() => {
    if (!shouldWatchAutoplay) return;

    const timer = setTimeout(() => {
      handleAutoplayTimeout();
    }, AUTOPLAY_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [shouldWatchAutoplay]);

  const clearPendingSeek = () => {
    if (seekTimeoutRef.current) {
      clearTimeout(seekTimeoutRef.current);
      seekTimeoutRef.current = null;
    }
  };

  const handleSyncMessage = useEffectEvent((message: SyncSocketMessage) => {
    const { action, timestamp, videoId, user_id } = message;

    if (user?.isHost && user_id === user?.userId) return;
    if (videoId !== currentSong?.music_url) return;

    // A seek keeps the previous play/pause state
    lastSyncRef.current = {
      timestamp,
      action:
        action === 'seek' ? (lastSyncRef.current?.action ?? 'play') : action,
    };

    if (!user?.isHost && !isPlayerEnabled) {
      pendingSyncRef.current = lastSyncRef.current;
      return;
    }

    // seekTo is ignored until the player is ready, so apply it in handleReady
    if (!user?.isHost && !isPlayerReadyRef.current) {
      if (action === 'play') setIsPlaying(true);
      if (action === 'pause') setIsPlaying(false);
      if (timestamp !== undefined) {
        pendingSyncRef.current = { timestamp, action: 'seek_on_ready' };
      }
      return;
    }

    const currentPlayerTime = playerRef.current?.getCurrentTime() || 0;

    if (action === 'play') {
      clearPendingSeek();
      setIsPlaying(true);

      if (
        timestamp !== undefined &&
        Math.abs(currentPlayerTime - timestamp) >= 2
      ) {
        playerRef.current?.seekTo(timestamp, 'seconds');
        if (duration > 0) setPlayed(timestamp / duration);
      }
    } else if (action === 'pause') {
      clearPendingSeek();
      setIsPlaying(false);

      if (timestamp !== undefined) {
        playerRef.current?.seekTo(timestamp, 'seconds');
        if (duration > 0) setPlayed(timestamp / duration);
      }
    } else if (action === 'seek') {
      // Debounce seek operations to prevent jitter
      clearPendingSeek();

      seekTimeoutRef.current = setTimeout(() => {
        if (timestamp !== undefined) {
          playerRef.current?.seekTo(timestamp, 'seconds');
          if (duration > 0) setPlayed(timestamp / duration);
        }
      }, 100);
    }
  });

  useEffect(() => {
    const unsubscribe = subscribe('sync', (message) => {
      handleSyncMessage(message);
    });

    return () => {
      unsubscribe();
      clearPendingSeek();
    };
  }, [subscribe]);

  const handlePlayNext = () => {
    if (user?.isHost && currentSong) {
      playNext();
      sendMessage({
        type: 'sync',
        action: 'play',
        timestamp: 0,
        videoId: currentSong.music_url,
      });
    }
  };

  const handlePlayPrev = () => {
    if (user?.isHost && currentSong) {
      playPrev();
      sendMessage({
        type: 'sync',
        action: 'play',
        timestamp: 0,
        videoId: currentSong.music_url,
      });
    }
  };

  const handleJumpSong = (itemId: number) => {
    if (user?.isHost) {
      jumpSong(itemId);
      sendMessage({
        type: 'sync',
        action: 'play',
        timestamp: 0,
        videoId: currentSong?.music_url,
      });
    }
  };

  const handlePlay = () => {
    setIsPlaying(true);
    if (user?.isHost && currentSong) {
      sendMessage({
        type: 'sync',
        action: 'play',
        timestamp: played * duration,
        videoId: currentSong.music_url,
      });
    }
  };

  const handlePause = () => {
    setIsPlaying(false);
    if (user?.isHost && currentSong) {
      sendMessage({
        type: 'sync',
        action: 'pause',
        timestamp: played * duration,
        videoId: currentSong.music_url,
      });
    }
  };

  const handleSeek = (amount: number) => {
    setPlayed(amount);
    playerRef.current?.seekTo(amount, 'fraction');
    if (user?.isHost && currentSong) {
      sendMessage({
        type: 'sync',
        action: 'seek',
        timestamp: amount * duration, // fraction to seconds
        videoId: currentSong.music_url,
      });
    }
  };

  const handleSync = () => {
    const pending = pendingSyncRef.current;
    const startPlaying = pending?.action === 'play' || !pending;
    const startTimestamp = pending?.timestamp;

    setIsPlayerEnabled(true);
    // The click is a user gesture, so play with sound as before
    setHasUnmuted(true);
    setIsPlaying(startPlaying);

    if (startTimestamp !== undefined) {
      pendingSyncRef.current = {
        timestamp: startTimestamp,
        action: 'seek_on_ready',
      };
    }

    if (!pending) {
      sendMessage({ type: 'request_sync' });
    }
  };

  const handleUnmute = () => {
    // Call the player directly inside the click handler: browsers only allow
    // unmuting within a user gesture
    const internalPlayer = playerRef.current?.getInternalPlayer();
    if (isYouTubeInternalPlayer(internalPlayer)) {
      internalPlayer.unMute();
      // Some browsers pause playback on unmute; keep playing if we should be
      if (isPlaying) internalPlayer.playVideo();
    }
    setHasUnmuted(true);
    logger.log('[Player] Unmuted by user');
  };

  const handleReady = () => {
    isPlayerReadyRef.current = true;
    setReadySongUrl(currentSong?.music_url);
    setIsReady(true);
    const pending = pendingSyncRef.current;
    if (
      pending?.action === 'seek_on_ready' &&
      pending.timestamp !== undefined
    ) {
      playerRef.current?.seekTo(pending.timestamp, 'seconds');
      pendingSyncRef.current = null;
    }
  };

  const handleEnded = async () => {
    setIsPlaying(false);
    onSongEnded?.();
  };

  const handleError = () => {
    setIsPlaying(false);
    fallbackToPendingSync('player error');
  };

  const handlePlaybackStart = () => {
    isActuallyPlayingRef.current = true;
  };

  const handlePlaybackPause = () => {
    isActuallyPlayingRef.current = false;
    // Browsers may pause muted autoplay on their own (e.g. power saving)
    if (isMuted && isPlaying) {
      fallbackToPendingSync('paused by browser');
    }
  };

  const handleDuration = (d: number) => {
    setDuration(d);
  };

  const handleProgress = (state: OnProgressProps) => {
    setPlayed(state.played);
  };

  return {
    playerRef,
    isPlaying,
    played,
    isReady,
    isPlayerEnabled,
    isMuted,
    duration,
    handlePlayNext,
    handlePlayPrev,
    handleJumpSong,
    handlePlay,
    handlePause,
    handleSeek,
    handleSync,
    handleUnmute,
    handleReady,
    handleError,
    handlePlaybackStart,
    handlePlaybackPause,
    handleEnded,
    handleDuration,
    handleProgress,
  };
};

export default useMusicPlayer;
