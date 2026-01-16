import { Routes, Route } from 'react-router-dom';
import { ROUTE_PATH } from './routePath';
import MainLayout from '../layout/MainLayout';
import Landing from '@/page/Landing/Landing';
import MusicRoom from '@/page/MusicRoom/MusicRoom';
import NotFound from '@/page/NotFound/NotFound';

const AppRouter = () => {
  return (
    <Routes>
      <Route element={<MainLayout />}>
        <Route path={ROUTE_PATH.LANDING} element={<Landing />} />
        <Route path={ROUTE_PATH.MUSIC_ROOM} element={<MusicRoom />} />
        <Route path={ROUTE_PATH.NOTFOUND} element={<NotFound />} />
      </Route>
    </Routes>
  );
};

export default AppRouter;
