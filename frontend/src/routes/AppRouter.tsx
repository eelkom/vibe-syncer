import { Routes, Route } from 'react-router-dom';
import MainLayout from '../layout/MainLayout';
import { ROUTE_PATH } from './routePath';
import Room from '@/page/Room/Room';
import Home from '@/page/Home/Home';

const AppRouter = () => {
  return (
    <Routes>
      <Route element={<MainLayout />}>
        <Route path={ROUTE_PATH.HOME} element={<Home />} />
        <Route path={ROUTE_PATH.ROOM} element={<Room />} />
      </Route>
    </Routes>
  );
};

export default AppRouter;
