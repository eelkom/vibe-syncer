import { useRef, useState } from 'react';
import ReactPlayer from 'react-player';
import { MusicContext } from './MusicContext';

const MusicPlayerProvider = ({ children }: { children: React.ReactNode }) => {
  const playerRef = useRef<any>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentUrl, setUrl] = useState(
    'https://youtu.be/dhZUsNJ-LQU?si=zAysV-Lsb0JBBLkl',
  );
  const [played, setPlayed] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [duration, setDuration] = useState(0);

  const play = () => setIsPlaying(true);
  const pause = () => setIsPlaying(false);
  const seekTo = (amount: number) => playerRef.current?.seekTo(amount);

  const sendSyncSignal = (
    action: 'play' | 'pause' | 'seek',
    sendMessage: Function,
  ) => {
    if (!playerRef.current) return;

    const currentSeconds = playerRef.current.getCurrentTime();

    const payload = {
      type: 'sync',
      action: action,
      timestamp: currentSeconds,
      videoId: currentUrl,
    };

    sendMessage(payload);
  };

  const applySyncSignal = (syncData: any) => {
    if (!playerRef.current || !syncData) return;

    const myTime = playerRef.current.getCurrentTime();
    const hostTime = syncData.timestamp;
    const diff = Math.abs(myTime - hostTime);

    if (diff > 2) {
      playerRef.current.seekTo(hostTime, 'seconds');
    }

    if (syncData.action === 'play') {
      setIsPlaying(true);
    } else if (syncData.action === 'pause') {
      setIsPlaying(false);
    }
  };

  return (
    <MusicContext.Provider
      value={{
        isPlaying,
        play,
        pause,
        seekTo,
        currentUrl,
        setUrl,
        duration,
        played,
        isReady,
        sendSyncSignal,
        applySyncSignal,
      }}
    >
      <div className="pointer-events-none fixed left-0 top-0 -z-50 h-[1px] w-[1px] opacity-0">
        <ReactPlayer
          ref={(p) => {
            playerRef.current = p;
          }}
          url={currentUrl}
          playing={isPlaying}
          onProgress={(state: any) => {
            if (isPlaying) setPlayed(state.played);
          }}
          onDuration={setDuration}
          onReady={() => setIsReady(true)}
        />
      </div>
      {children}
    </MusicContext.Provider>
  );
};

export default MusicPlayerProvider;
