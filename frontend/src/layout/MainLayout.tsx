import MusicPlayerProvider from '@/contexts/MusicPlayerContext';
import { UserContextProvider } from '@/contexts/UserContext';
import { Outlet } from 'react-router-dom';

const MainLayout = () => {
  return (
    <main>
      <UserContextProvider>
        <MusicPlayerProvider>
          <Outlet />
        </MusicPlayerProvider>
      </UserContextProvider>
    </main>
  );
};

export default MainLayout;
