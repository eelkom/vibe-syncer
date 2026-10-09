import useJumpSong from '@/hooks/mutations/useJumpSong';
import usePlayNextSong from '@/hooks/mutations/usePlayNextSong';
import usePlayPrevSong from '@/hooks/mutations/usePlayPrevSong';
import type { SubscribeSocket } from '@/hooks/useWebSocket';
import type { QueueResponse } from '@/schemas/queueSchema';
import type { SyncSocketMessage } from '@/schemas/socketSchema';
import type { UserData } from '@/types/user';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type ReactPlayer from 'react-player';
import type { OnProgressProps } from 'react-player/base';

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
  const pendingSyncRef = useRef<{ timestamp?: number; action: string } | null>(
    null,
  );

  const [isPlaying, setIsPlaying] = useState(false);
  const [played, setPlayed] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [isPlayerEnabled, setIsPlayerEnabled] = useState(user?.isHost ?? false);
  const [duration, setDuration] = useState(0);

  const { mutate: playNext } = usePlayNextSong(roomCode || '');
  const { mutate: playPrev } = usePlayPrevSong(roomCode || '');
  const { mutate: jumpSong } = useJumpSong(roomCode || '');

  useEffect(() => {
    queueMicrotask(() => {
      setIsPlaying(true);
    });
  }, [currentSong]);

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

    if (!user?.isHost && !isPlayerEnabled) {
      pendingSyncRef.current = { timestamp, action };
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

  const handleReady = () => {
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
    duration,
    handlePlayNext,
    handlePlayPrev,
    handleJumpSong,
    handlePlay,
    handlePause,
    handleSeek,
    handleSync,
    handleReady,
    handleError,
    handleEnded,
    handleDuration,
    handleProgress,
  };
};

export default useMusicPlayer;
