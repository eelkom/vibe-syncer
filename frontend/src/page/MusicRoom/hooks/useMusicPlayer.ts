import useJumpSong from '@/hooks/mutations/useJumpSong';
import usePlayNextSong from '@/hooks/mutations/usePlayNextSong';
import usePlayPrevSong from '@/hooks/mutations/usePlayPrevSong';
import useServerClock from '@/hooks/useServerClock';
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

// Delivery delay above this is treated as a bad clock estimate, and the time
// since arrival is used instead. The estimate is off by at most half the best
// probe's round trip, while a slow delivery is real: 1.7s was measured when the
// connection to the server hiccuped, and 1s rejected it and rewound the guest.
const MAX_DELIVERY_MS = 5000;

// A seek loses the time the player needs to load and resume, so the guest
// seeks this much ahead. First seek after the player mounts (data not loaded):
// 448-807ms on the deployed server; later seeks in loaded data: about 60-80ms
// (loadtest/RESULTS.md). Each resume updates the estimate with what was lost.
const INITIAL_SEEK_LOSS_S = { join: 0.6, resync: 0.1 };
const MAX_SEEK_LOSS_S = 1;
// A longer loss is a stalled load, not what the next seek will lose; learning
// it made the guest overshoot by 0.5s
const MAX_LEARNED_LOSS_S = 1.5;

const learnSeekLoss = (estimate: number, lost: number) =>
  lost > MAX_LEARNED_LOSS_S
    ? estimate
    : Math.min(
        MAX_SEEK_LOSS_S,
        Math.max(
          0,
          estimate * (1 - SEEK_LOSS_WEIGHT) + lost * SEEK_LOSS_WEIGHT,
        ),
      );
// Weight of the newest measured loss in the running estimate
const SEEK_LOSS_WEIGHT = 0.5;
// Wait after resuming before reading the position, as it settles
const RESUME_CHECK_DELAY_MS = 300;
// Extra seeks allowed to fix one missed seek; the next host sync covers the rest
const MAX_RECHECK_SEEKS = 2;
// Right after a seek playback was just interrupted anyway, so a smaller miss is
// fixed then too; left alone it stays below SYNC_SEEK_THRESHOLD_S for good
const RECHECK_THRESHOLD_S = 0.2;

type SeekKind = keyof typeof INITIAL_SEEK_LOSS_S;

// Buffering right after the host's own seek is part of that seek, not a stall
const HOST_SEEK_GRACE_MS = 2000;
// A longer stall is more likely a sleeping tab; leave it to the host
const MAX_HOST_CATCH_UP_S = 30;

type GuestPlaybackMode = 'muted-autoplay' | 'unmuted' | 'fallback';

interface PendingSync {
  timestamp?: number;
  action: string;
  receivedAt: number;
  isPlaying: boolean;
  // Server time the timestamp refers to (position_at_ms, else server_ms)
  anchorMs?: number;
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
  // Learned seek loss per kind, kept across songs
  const seekLossRef = useRef({ ...INITIAL_SEEK_LOSS_S });
  // The guest's seek waiting for playback to resume, to be checked then
  const seekCheckRef = useRef<{
    kind: SeekKind;
    compensation: number;
    rechecks: number;
  } | null>(null);
  const hasSeekedThisSongRef = useRef(false);
  // Where the host stalled mid-song, to jump past the stall when it ends
  const hostStallRef = useRef<{ position: number; at: number } | null>(null);
  // The host's skip past a stall, until its position is checked after resuming
  const hostCatchUpRef = useRef<{
    stall: { position: number; at: number };
    compensation: number;
    rechecks: number;
  } | null>(null);
  const hostCheckTimerRef = useRef<NodeJS.Timeout | null>(null);
  const hostSeekAtRef = useRef(0);
  const resumeCheckTimerRef = useRef<NodeJS.Timeout | null>(null);
  const serverClock = useServerClock({
    sendMessage,
    subscribe,
    connectionStatus,
  });

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
    seekCheckRef.current = null;
    hasSeekedThisSongRef.current = false;
    hostStallRef.current = null;
    hostCatchUpRef.current = null;
  }, [currentSong?.music_url]);

  const getPlaybackTime = () => {
    const currentTime = playerRef.current?.getCurrentTime();
    return typeof currentTime === 'number' && Number.isFinite(currentTime)
      ? currentTime
      : played * duration;
  };

  // Seconds of playback since the host read sync.timestamp. With the server
  // clock this includes the delivery delay of that very message; without it
  // (or with an implausible estimate) only the time since arrival counts.
  const elapsedSince = (sync: PendingSync) => {
    const sinceArrival = performance.now() - sync.receivedAt;
    const serverNow = serverClock.now();
    if (serverNow !== null && sync.anchorMs !== undefined) {
      const sinceAnchor = serverNow - sync.anchorMs;
      const delivery = sinceAnchor - sinceArrival;
      if (delivery >= -50 && delivery <= MAX_DELIVERY_MS) {
        return Math.max(0, sinceAnchor) / 1000;
      }
    }
    return sinceArrival / 1000;
  };

  // Where the host is now according to sync
  const hostPositionNow = (sync: PendingSync) =>
    sync.timestamp === undefined
      ? undefined
      : sync.timestamp + (sync.isPlaying ? elapsedSince(sync) : 0);

  // Guest seek to where the host is, ahead by the expected loss, checked once
  // playback resumes. Only while playing: a paused player loses nothing.
  const seekToHost = (target: number, rechecks = 0) => {
    const kind: SeekKind = hasSeekedThisSongRef.current ? 'resync' : 'join';
    const compensation = seekLossRef.current[kind];
    hasSeekedThisSongRef.current = true;
    seekCheckRef.current = { kind, compensation, rechecks };
    const position = target + compensation;
    playerRef.current?.seekTo(position, 'seconds');
    if (duration > 0) setPlayed(position / duration);
  };

  const stampServerTime = () => {
    const serverNow = serverClock.now();
    return serverNow === null ? {} : { position_at_ms: Math.round(serverNow) };
  };

  const sendHostState = (action: 'play' | 'pause') => {
    if (!user?.isHost || !currentSong) return;

    sendMessage({
      type: 'sync',
      action,
      timestamp: getPlaybackTime(),
      videoId: currentSong.music_url,
      ...stampServerTime(),
    });
  };

  const sendPeriodicHostState = useEffectEvent(() => {
    // Mid catch-up the position is still moving to where it should be
    if (hostPlayingRef.current && !hostCatchUpRef.current)
      sendHostState('play');
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

  useEffect(() => {
    if (connectionStatus === 'connected') sendHostStateOnConnect();
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

      if (user?.isHost && user_id === user?.userId && !isRestoringHost) return;

      if (videoId !== currentSong?.music_url) {
        if (shouldFollowSync && videoId) {
          earlySyncRef.current = { message, receivedAt };
        }
        return;
      }

      // A seek keeps the previous play/pause state
      lastSyncRef.current = {
        timestamp: message.timestamp,
        action:
          action === 'seek' ? (lastSyncRef.current?.action ?? 'play') : action,
        receivedAt,
        isPlaying:
          action === 'play' ||
          (action === 'seek' && (lastSyncRef.current?.isPlaying ?? true)),
        anchorMs: message.position_at_ms ?? message.server_ms,
      };
      const timestamp = hostPositionNow(lastSyncRef.current);

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
          // A seek in progress is checked when playback resumes
          !seekCheckRef.current &&
          Math.abs(currentPlayerTime - timestamp) >= SYNC_SEEK_THRESHOLD_S
        ) {
          if (user?.isHost) {
            playerRef.current?.seekTo(timestamp, 'seconds');
            if (duration > 0) setPlayed(timestamp / duration);
          } else {
            seekToHost(timestamp);
          }
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
        // The host loses time on its own seek too, so follow it as is
        seekCheckRef.current = null;
        hasSeekedThisSongRef.current = true;

        seekTimeoutRef.current = setTimeout(() => {
          const sync = lastSyncRef.current;
          const target = sync ? hostPositionNow(sync) : timestamp;
          if (target !== undefined) {
            playerRef.current?.seekTo(target, 'seconds');
            if (duration > 0) setPlayed(target / duration);
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
    const age = performance.now() - early.receivedAt;
    if (age > EARLY_SYNC_MAX_AGE_MS) return;

    logger.log(`[Player] Applying sync received ${Math.round(age)}ms early`);
    // The original arrival time keeps the elapsed time counted
    handleSyncMessage(early.message, early.receivedAt);
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
    hostSeekAtRef.current = performance.now();
    playerRef.current?.seekTo(amount, 'fraction');
    if (user?.isHost && currentSong) {
      sendMessage({
        type: 'sync',
        action: 'seek',
        timestamp: amount * duration, // fraction to seconds
        videoId: currentSong.music_url,
        ...stampServerTime(),
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
      const target = hostPositionNow(pending)!;
      if (!user?.isHost && pending.isPlaying) {
        seekToHost(target);
      } else {
        playerRef.current?.seekTo(target, 'seconds');
      }
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

  // Runs shortly after a guest's playback resumes, after a seek or buffering.
  // Seeks again right away if still off, rather than waiting for the next host
  // sync (up to 5s) and skipping mid-song then. A guest that buffered on its
  // own only moves forward: it alone skips what it missed.
  // Plain function: it runs from a timer, and reads refs for anything that changes
  const checkAfterResume = () => {
    resumeCheckTimerRef.current = null;
    if (user?.isHost || isBufferingRef.current) return;

    const sync = lastSyncRef.current;
    const pendingCheck = seekCheckRef.current;
    seekCheckRef.current = null;
    const target = sync ? hostPositionNow(sync) : undefined;
    if (!sync?.isPlaying || target === undefined) return;

    const behind = target - getPlaybackTime();
    if (pendingCheck) {
      const losses = seekLossRef.current;
      losses[pendingCheck.kind] = learnSeekLoss(
        losses[pendingCheck.kind],
        pendingCheck.compensation + behind,
      );
      if (
        Math.abs(behind) >= RECHECK_THRESHOLD_S &&
        pendingCheck.rechecks < MAX_RECHECK_SEEKS
      ) {
        logger.log(`[Player] Off by ${behind.toFixed(2)}s after seek, again`);
        seekToHost(target, pendingCheck.rechecks + 1);
      }
    } else if (behind >= SYNC_SEEK_THRESHOLD_S) {
      logger.log(`[Player] ${behind.toFixed(2)}s behind after buffering`);
      seekToHost(target, MAX_RECHECK_SEEKS - 1);
    }
  };

  const scheduleResumeCheck = () => {
    if (user?.isHost) return;
    if (resumeCheckTimerRef.current) clearTimeout(resumeCheckTimerRef.current);
    resumeCheckTimerRef.current = setTimeout(
      () => checkAfterResume(),
      RESUME_CHECK_DELAY_MS,
    );
  };

  useEffect(
    () => () => {
      if (resumeCheckTimerRef.current)
        clearTimeout(resumeCheckTimerRef.current);
    },
    [],
  );

  const handlePlaybackStart = () => {
    if (
      user?.isHost &&
      hostPlayingRef.current &&
      performance.now() - hostSeekAtRef.current > HOST_SEEK_GRACE_MS
    ) {
      hostStallRef.current = {
        position: getPlaybackTime(),
        at: performance.now(),
      };
    }
    isActuallyPlayingRef.current = true;
    isBufferingRef.current = true;
    hostPlayingRef.current = false;
  };

  // Guests kept playing while the host stalled. Resuming in place would put the
  // host behind them, and its next sync would pull every guest back; the host
  // alone skips ahead instead, then checks where it landed like a guest does.
  const hostSkipAhead = (
    stall: { position: number; at: number },
    rechecks: number,
  ) => {
    const target = stall.position + (performance.now() - stall.at) / 1000;
    const compensation = seekLossRef.current.resync;
    hostCatchUpRef.current = { stall, compensation, rechecks };
    hostSeekAtRef.current = performance.now();
    playerRef.current?.seekTo(target + compensation, 'seconds');
  };

  const catchUpAfterHostStall = () => {
    const stall = hostStallRef.current;
    hostStallRef.current = null;
    if (!user?.isHost || !stall || !isPlaying) return;

    const stalled = (performance.now() - stall.at) / 1000;
    if (stalled > MAX_HOST_CATCH_UP_S) return;
    if (stall.position + stalled - getPlaybackTime() < SYNC_SEEK_THRESHOLD_S) {
      return;
    }

    logger.log(`[Player] Host stalled ${stalled.toFixed(2)}s, skipping ahead`);
    hostSkipAhead(stall, 0);
  };

  // Plain function: it runs from a timer, and reads refs for anything that changes
  const checkHostAfterCatchUp = () => {
    hostCheckTimerRef.current = null;
    const catchUp = hostCatchUpRef.current;
    if (!catchUp || isBufferingRef.current) return;

    const target =
      catchUp.stall.position + (performance.now() - catchUp.stall.at) / 1000;
    const behind = target - getPlaybackTime();
    const losses = seekLossRef.current;
    losses.resync = learnSeekLoss(losses.resync, catchUp.compensation + behind);
    if (
      Math.abs(behind) >= RECHECK_THRESHOLD_S &&
      catchUp.rechecks < MAX_RECHECK_SEEKS
    ) {
      logger.log(`[Player] Host off by ${behind.toFixed(2)}s, again`);
      hostSkipAhead(catchUp.stall, catchUp.rechecks + 1);
      return;
    }
    hostCatchUpRef.current = null;
    if (hostPlayingRef.current) sendHostState('play');
  };

  const scheduleHostCheck = () => {
    if (!user?.isHost) return;
    if (hostCheckTimerRef.current) clearTimeout(hostCheckTimerRef.current);
    hostCheckTimerRef.current = setTimeout(
      () => checkHostAfterCatchUp(),
      RESUME_CHECK_DELAY_MS,
    );
  };

  useEffect(
    () => () => {
      if (hostCheckTimerRef.current) clearTimeout(hostCheckTimerRef.current);
    },
    [],
  );

  const handleBufferEnd = () => {
    isBufferingRef.current = false;
    if (user?.isHost && isPlaying) {
      hostPlayingRef.current = true;
    }
    catchUpAfterHostStall();
    scheduleHostCheck();
    scheduleResumeCheck();
  };

  const handlePlayerPlay = () => {
    isActuallyPlayingRef.current = true;
    isBufferingRef.current = false;
    scheduleResumeCheck();
    if (user?.isHost) {
      hostPlayingRef.current = true;
      hostHasPlayedRef.current = true;
      // YouTube reports play before buffer end when a stall ends; the position
      // now is still the stalled one, so skip ahead and report after the check
      catchUpAfterHostStall();
      if (hostCatchUpRef.current) {
        scheduleHostCheck();
        return;
      }
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
