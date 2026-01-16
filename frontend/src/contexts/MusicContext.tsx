import { createContext } from 'react';

interface MusicPlayerContextType {
  isPlaying: boolean;
  play: () => void;
  pause: () => void;
  seekTo: (amount: number) => void;
  currentUrl: string;
  setUrl: (url: string) => void;
  duration: number;
  played: number;
  isReady: boolean;
}

export const MusicContext = createContext<MusicPlayerContextType | null>(null);
