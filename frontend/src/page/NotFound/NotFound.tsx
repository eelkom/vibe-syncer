import Button from '@/components/ui/Button';
import { ROUTE_PATH } from '@/routes/routePath';
import { useNavigate } from 'react-router-dom';

const NotFound = () => {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="w-full max-w-4xl">
        <div className="mb-12 text-center">
          <div className="mb-6 flex items-center justify-center"></div>
          <h1 className="mb-4 text-5xl text-gray-900">VibeSyncer</h1>
          <p className="text-xl text-gray-600">
            Music, Chat, and Vibes in Sync
          </p>
        </div>
        <div className="rounded-2xl bg-white p-12 text-center shadow-lg">
          <h1 className="mb-4 text-6xl font-bold text-indigo-600">404</h1>
          <p className="mb-2 text-2xl font-semibold text-gray-900">
            Page Not Found
          </p>
          <p className="mb-6 text-gray-600">
            Sorry, the page you are looking for does not exist.
          </p>
          <Button
            variant="primary"
            onClick={() => navigate(ROUTE_PATH.LANDING)}
          >
            Go Home
          </Button>
        </div>
      </div>
    </div>
  );
};

export default NotFound;
