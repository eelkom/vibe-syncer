import { useNavigate, useParams } from 'react-router-dom';
import { useEffect } from 'react';
import ChatBoard from './components/ChatBoard';
import QueueBoard from './components/QueueBoard';
import { useUser } from '@/contexts/UserContext';
import useRoomInfos from '@/hooks/queries/useRoomInfos';
import ErrorBoundary from '@/components/ErrorBoundary';
import Error from '@/components/ui/Error';
import ReactPlayer from 'react-player';
import useWebSocket from '@/hooks/useWebSocket';
import useQueueList from '@/hooks/queries/useQueueList';
import MusicPlayer from './components/MusicPlayer';
import AlbumCover from './components/AlbumCover';
import usePatchQueueItem from '@/hooks/mutations/usePatchQueueItem';
import RoomTitle from './components/RoomTitle';
import useMusicPlayer from './hooks/useMusicPlayer';
import Header from './components/Header';
import useCurrentSongInfo from './hooks/useCurrentSongInfo';

const MusicRoom = () => {
  const navigate = useNavigate();
  const { id: roomCode } = useParams();
  const { user } = useUser();
  const { data: roomInfos, isLoading, isError } = useRoomInfos(roomCode || '');
  const {
    data: queueList,
    isLoading: isQueueLoading,
    isError: isQueueError,
  } = useQueueList(roomCode || '');

  const { sendMessage, newMessage, connectionStatus, isAiLoading } =
    useWebSocket(roomCode || '');

  const {
    currentSong,
    currentSongId,
    currentSongUrl,
    canPlayPrev,
    canPlayNext,
  } = useCurrentSongInfo(queueList);

  const isValidUrl = currentSongUrl && ReactPlayer.canPlay(currentSongUrl);

  const {
    mutate: patchQueueItem,
    isPending: isPatchPending,
    isError: isPatchError,
  } = usePatchQueueItem({ roomCode: roomCode || '', currentSongId });

  const {
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
  } = useMusicPlayer({
    roomCode: roomCode || '',
    sendMessage,
    newMessage,
    user,
    currentSong,
    onSongEnded: () => {
      if (currentSong && roomCode) patchQueueItem();
    },
  });

  useEffect(() => {
    if (!user) {
      navigate('/');
    }
  }, [user, navigate]);

  if (isError) return <Error />;

  return (
    <div className="flex h-screen flex-col bg-white">
      <Header
        roomInfos={roomInfos}
        user={user}
        roomCode={roomCode}
        isLoading={isLoading}
      />

      <div className="bg-white-50 mx-auto flex w-full max-w-7xl flex-1 gap-6 overflow-hidden p-10">
        <ErrorBoundary>
          <QueueBoard
            queueList={queueList}
            isLoading={isQueueLoading}
            isError={isQueueError}
            currentSongId={currentSongId}
            onJumpSong={handleJumpSong}
          />
        </ErrorBoundary>

        <div className="align-center flex flex-1 flex-col justify-center gap-4">
          <RoomTitle isLoading={isLoading} roomInfos={roomInfos} />
          <AlbumCover isPlaying={isPlaying} currentSong={currentSong} />

          {/* Hidden ReactPlayer */}
          {isValidUrl && isPlayerEnabled && (
            <div
              style={{
                position: 'fixed',
                bottom: 0,
                right: 0,
                width: '1px',
                height: '1px',
                opacity: 0.001,
                pointerEvents: 'none',
                zIndex: -1,
              }}
            >
              <ReactPlayer
                key={currentSongUrl}
                ref={playerRef}
                url={currentSongUrl}
                playing={isPlaying}
                width="100%"
                height="100%"
                onReady={handleReady}
                onDuration={handleDuration}
                onProgress={handleProgress}
                onEnded={async () => {
                  await handleEnded();
                }}
                onError={handleError}
              />
            </div>
          )}

          <MusicPlayer
            currentSong={currentSong}
            isPlaying={isPlaying}
            duration={duration}
            played={played}
            isReady={isReady}
            isLoadingNextSong={isPatchPending}
            hasError={isPatchError}
            isHost={user?.isHost ?? false}
            needsSync={!user?.isHost && !isPlayerEnabled}
            onPlay={handlePlay}
            onPause={handlePause}
            onSeek={(amount) => {
              handleSeek(amount);
            }}
            onSync={handleSync}
            onPlayNext={handlePlayNext}
            onPlayPrev={handlePlayPrev}
            canPlayNext={canPlayNext}
            canPlayPrev={canPlayPrev}
          />
        </div>
        <ErrorBoundary>
          <ChatBoard
            currentUser={user}
            roomCode={roomCode || ''}
            sendMessage={sendMessage}
            newMessage={newMessage}
            connectionStatus={connectionStatus}
            isAiLoading={isAiLoading}
          />
        </ErrorBoundary>
      </div>
    </div>
  );
};

export default MusicRoom;
