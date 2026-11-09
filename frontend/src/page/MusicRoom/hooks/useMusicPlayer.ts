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

// A sync for a song that isn't current yet is dropped after this time
const EARLY_SYNC_MAX_AGE_MS = 10000;

// Host position broadcast interval. 2s sent 2.5x the messages without lower
// error; 10s can leave a drift for up to 10s (loadtest/RESULTS.md)
const HOST_SYNC_INTERVAL_MS = 5000;

// A play sync seeks when the guest is this far off. The offset left after the
// join seek is 0.75-1.8s, which 1s and 2s thresholds never corrected; 0.5s
// added no repeated seeks (loadtest/RESULTS.md)
const SYNC_SEEK_THRESHOLD_S = 0.5;

// One-way delays above this are treated as outliers (e.g. a stalled tab)
const MAX_ONE_WAY_MS = 1000;
// Recent RTT samples kept for the median
const RTT_SAMPLES = 5;
// Delay before the guest's RTT probe after connecting
const RTT_PROBE_DELAY_MS = 1000;

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const addRttSample = (samples: number[], rtt: number) => {
  if (!(rtt >= 0) || rtt / 2 > MAX_ONE_WAY_MS) return;
  samples.push(rtt);
  if (samples.length > RTT_SAMPLES) samples.shift();
};

type GuestPlaybackMode = 'muted-autoplay' | 'unmuted' | 'fallback';

interface PendingSync {
  timestamp?: number;
  action: string;
  receivedAt: number;
  isPlaying: boolean;
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
  connectionStatus: 'connecting' | 'connected' | 'disconnected' | 'error';
  user: UserData | null;
  currentSong: QueueResponse | undefined;
  onSongEnded?: () => void;
}

const useMusicPlayer = ({
  roomCode,
  sendMessage,
  subscribe,
  connectionStatus,
  user,
  currentSong,
  onSongEnded,
}: UseMusicPlayerProps) => {
  const playerRef = useRef<ReactPlayer>(null);
  const seekTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pendingSyncRef = useRef<PendingSync | null>(null);
  // Latest host state for the current song, used when falling back
  const lastSyncRef = useRef<PendingSync | null>(null);
  // Sync received before its song became current (e.g. the initial sync
  // arriving before the queue loads), applied once the song matches
  const earlySyncRef = useRef<{
    message: SyncSocketMessage;
    receivedAt: number;
  } | null>(null);
  // Ready state of the currently mounted player (it remounts on every song)
  const isPlayerReadyRef = useRef(false);
  const isActuallyPlayingRef = useRef(false);
  const isBufferingRef = useRef(false);
  const hostPlayingRef = useRef(false);
  const hostHasPlayedRef = useRef(false);
  // Delivery delay estimate. The server forwards sync without its own clock,
  // so each side measures its round trip and contributes half of it.
  const hostSentAtRef = useRef(new Map<number, number>());
  const hostRttRef = useRef<number[]>([]);
  const guestRttRef = useRef<number[]>([]);
  const rttProbeSentAtRef = useRef<number | null>(null);

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
      // Follow any host state already received for this song
      if (lastSyncRef.current) return;
      setIsPlaying(true);
    });
  }, [currentSong, user?.isHost]);

  useEffect(() => {
    isPlayerReadyRef.current = false;
    isActuallyPlayingRef.current = false;
    isBufferingRef.current = false;
    hostPlayingRef.current = false;
    pendingSyncRef.current = null;
    lastSyncRef.current = null;
  }, [currentSong?.music_url]);

  const getPlaybackTime = () => {
    const currentTime = playerRef.current?.getCurrentTime();
    return typeof currentTime === 'number' && Number.isFinite(currentTime)
      ? currentTime
      : played * duration;
  };

  const sendHostState = (action: 'play' | 'pause') => {
    if (!user?.isHost || !currentSong) return;

    const timestamp = getPlaybackTime();
    const sentAt = performance.now();
    const sent = hostSentAtRef.current;
    sent.set(timestamp, sentAt);
    // Unanswered entries (e.g. sent while disconnected) must not pile up
    if (sent.size > 20) sent.delete(sent.keys().next().value!);
    const rtts = hostRttRef.current;
    sendMessage({
      type: 'sync',
      action,
      timestamp,
      videoId: currentSong.music_url,
      ...(rtts.length ? { latency_ms: Math.round(median(rtts) / 2) } : {}),
    });
  };

  const sendPeriodicHostState = useEffectEvent(() => {
    if (hostPlayingRef.current) sendHostState('play');
  });

  useEffect(() => {
    if (!user?.isHost || !currentSong?.music_url) return;

    const timer = setInterval(() => {
      sendPeriodicHostState();
    }, HOST_SYNC_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [currentSong?.music_url, user?.isHost]);

  const sendHostStateOnConnect = useEffectEvent(() => {
    if (!user?.isHost) return;

    if (hostPlayingRef.current) {
      sendHostState('play');
    } else if (isPlayerReadyRef.current && !isPlaying) {
      sendHostState('pause');
    }
  });

  const probeGuestRtt = useEffectEvent(() => {
    if (user?.isHost) return;
    // request_sync is answered only to this socket, so it doubles as a ping
    rttProbeSentAtRef.current = performance.now();
    sendMessage({ type: 'request_sync' });
  });

  useEffect(() => {
    if (connectionStatus !== 'connected') return;
    sendHostStateOnConnect();
    // Wait past the snapshot the server pushes on connect, or that snapshot
    // would be mistaken for the probe's answer
    const probe = setTimeout(() => probeGuestRtt(), RTT_PROBE_DELAY_MS);
    // A room without playback state never answers; drop the stale probe
    const expire = setTimeout(
      () => {
        rttProbeSentAtRef.current = null;
      },
      RTT_PROBE_DELAY_MS + 2 * MAX_ONE_WAY_MS,
    );
    return () => {
      clearTimeout(probe);
      clearTimeout(expire);
    };
  }, [connectionStatus]);

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

  const handleSyncMessage = useEffectEvent(
    (message: SyncSocketMessage, receivedAt = performance.now()) => {
      const { action, videoId, user_id } = message;

      const isRestoringHost =
        user?.isHost && message.snapshot && !hostHasPlayedRef.current;
      const shouldFollowSync = !user?.isHost || isRestoringHost;

      if (user?.isHost && user_id === user?.userId && !isRestoringHost) {
        // Our own broadcast came back: one round trip to the server
        const sentAt =
          message.timestamp !== undefined
            ? hostSentAtRef.current.get(message.timestamp)
            : undefined;
        if (sentAt !== undefined) {
          hostSentAtRef.current.delete(message.timestamp!);
          addRttSample(hostRttRef.current, receivedAt - sentAt);
        }
        return;
      }

      if (message.snapshot && rttProbeSentAtRef.current !== null) {
        addRttSample(
          guestRttRef.current,
          receivedAt - rttProbeSentAtRef.current,
        );
        rttProbeSentAtRef.current = null;
      }

      // The host's position is already old on arrival: host -> server ->
      // this client. Without a guest sample yet, assume a symmetric path.
      const hostLeg = message.latency_ms;
      const guestRtts = guestRttRef.current;
      const guestLeg = guestRtts.length ? median(guestRtts) / 2 : hostLeg;
      const delayMs =
        hostLeg !== undefined && guestLeg !== undefined
          ? Math.min(hostLeg + guestLeg, MAX_ONE_WAY_MS)
          : 0;
      const isAdvancing =
        action === 'play' ||
        (action === 'seek' && (lastSyncRef.current?.isPlaying ?? true));
      const timestamp =
        message.timestamp !== undefined && isAdvancing && !user?.isHost
          ? message.timestamp + delayMs / 1000
          : message.timestamp;
      if (videoId !== currentSong?.music_url) {
        if (shouldFollowSync && videoId) {
          earlySyncRef.current = { message, receivedAt };
        }
        return;
      }

      // A seek keeps the previous play/pause state
      lastSyncRef.current = {
        timestamp,
        action:
          action === 'seek' ? (lastSyncRef.current?.action ?? 'play') : action,
        receivedAt,
        isPlaying:
          action === 'play' ||
          (action === 'seek' && (lastSyncRef.current?.isPlaying ?? true)),
      };

      if (shouldFollowSync && !isPlayerEnabled) {
        pendingSyncRef.current = lastSyncRef.current;
        return;
      }

      // seekTo is ignored until the player is ready, so apply it in handleReady
      if (shouldFollowSync && !isPlayerReadyRef.current) {
        if (action === 'play') setIsPlaying(true);
        if (action === 'pause') setIsPlaying(false);
        if (timestamp !== undefined) {
          pendingSyncRef.current = {
            ...lastSyncRef.current,
            action: 'seek_on_ready',
          };
        }
        return;
      }

      const currentPlayerTime = playerRef.current?.getCurrentTime() || 0;

      if (action === 'play') {
        clearPendingSeek();
        setIsPlaying(true);

        if (
          timestamp !== undefined &&
          !isBufferingRef.current && // Repeated seeks during buffering restart loading.
          Math.abs(currentPlayerTime - timestamp) >= SYNC_SEEK_THRESHOLD_S
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
    },
  );

  useEffect(() => {
    const unsubscribe = subscribe('sync', (message) => {
      handleSyncMessage(message);
    });

    return () => {
      unsubscribe();
      clearPendingSeek();
    };
  }, [subscribe]);

  const applyEarlySync = useEffectEvent(() => {
    const early = earlySyncRef.current;
    if (!early || early.message.videoId !== currentSong?.music_url) return;

    earlySyncRef.current = null;
    const now = performance.now();
    const age = now - early.receivedAt;
    if (age > EARLY_SYNC_MAX_AGE_MS) return;

    const { action, timestamp } = early.message;
    logger.log(`[Player] Applying sync received ${Math.round(age)}ms early`);
    // A play timestamp already includes age, so its time base also moves to now.
    handleSyncMessage(
      {
        ...early.message,
        timestamp:
          action === 'play' && timestamp !== undefined
            ? timestamp + age / 1000
            : timestamp,
      },
      action === 'play' ? now : early.receivedAt,
    );
  });

  useEffect(() => {
    applyEarlySync();
  }, [currentSong?.music_url]);

  const handlePlayNext = () => {
    if (user?.isHost && currentSong) {
      hostPlayingRef.current = false;
      playNext();
    }
  };

  const handlePlayPrev = () => {
    if (user?.isHost && currentSong) {
      hostPlayingRef.current = false;
      playPrev();
    }
  };

  const handleJumpSong = (itemId: number) => {
    if (user?.isHost) {
      hostPlayingRef.current = false;
      jumpSong(itemId);
    }
  };

  const handlePlay = () => {
    setIsPlaying(true);
    sendHostState('play');
  };

  const handlePause = () => {
    setIsPlaying(false);
    hostPlayingRef.current = false;
    sendHostState('pause');
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
    const startPlaying = pending?.isPlaying ?? true;
    const startTimestamp = pending?.timestamp;

    setIsPlayerEnabled(true);
    // The click is a user gesture, so play with sound as before
    setHasUnmuted(true);
    setIsPlaying(startPlaying);

    if (pending && startTimestamp !== undefined) {
      pendingSyncRef.current = {
        ...pending,
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
      const timestamp =
        pending.timestamp +
        (pending.isPlaying
          ? (performance.now() - pending.receivedAt) / 1000
          : 0);
      playerRef.current?.seekTo(timestamp, 'seconds');
      pendingSyncRef.current = null;
    }

    if (!user?.isHost && hasUnmuted) {
      // Retry unmuting if the user clicked before the player was ready.
      const internalPlayer = playerRef.current?.getInternalPlayer();
      if (isYouTubeInternalPlayer(internalPlayer)) {
        internalPlayer.unMute();
      }
    }
  };

  const handleEnded = async () => {
    hostPlayingRef.current = false;
    setIsPlaying(false);
    onSongEnded?.();
  };

  const handleError = () => {
    setIsPlaying(false);
    fallbackToPendingSync('player error');
  };

  const handlePlaybackStart = () => {
    isActuallyPlayingRef.current = true;
    isBufferingRef.current = true;
    hostPlayingRef.current = false;
  };

  const handleBufferEnd = () => {
    isBufferingRef.current = false;
    if (user?.isHost && isPlaying) {
      hostPlayingRef.current = true;
    }
  };

  const handlePlayerPlay = () => {
    isActuallyPlayingRef.current = true;
    isBufferingRef.current = false;
    if (user?.isHost) {
      hostPlayingRef.current = true;
      hostHasPlayedRef.current = true;
      sendHostState('play');
    }
  };

  const handlePlaybackPause = () => {
    isActuallyPlayingRef.current = false;
    hostPlayingRef.current = false;
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
    handleBufferEnd,
    handlePlayerPlay,
    handlePlaybackPause,
    handleEnded,
    handleDuration,
    handleProgress,
  };
};

export default useMusicPlayer;
