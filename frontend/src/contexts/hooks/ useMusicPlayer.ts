import { MusicContext } from '@/contexts/MusicContext';
import { useContext } from 'react';

export const useMusicPlayer = () => {
  const context = useContext(MusicContext);
  if (!context)
    throw new Error('useMusicPlayer must be used within a MusicPlayerProvider');
  return context;
};
