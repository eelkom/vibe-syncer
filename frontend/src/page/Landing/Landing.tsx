import { useState } from 'react';
import { Plus, LogIn } from 'lucide-react';
import CreateRoomModal from './components/CreateRoomModal';
import JoinRoomModal from './components/JoinRoomModal';
import Button from '@/components/ui/Button';
import ErrorBoundary from '@/components/ErrorBoundary';

const Landing = () => {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);

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

        <div className="mb-8 grid gap-6 md:grid-cols-2">
          <div className="rounded-2xl bg-white p-8 shadow-lg transition-shadow hover:shadow-xl">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-100">
              <Plus className="h-6 w-6 text-indigo-600" />
            </div>
            <h2 className="mb-2 text-2xl text-gray-900">Create Room</h2>
            <p className="mb-6 text-gray-600">
              Start a new room and invite others to join
            </p>
            <Button variant="primary" onClick={() => setShowCreateModal(true)}>
              Create New Room
            </Button>
          </div>

          <div className="rounded-2xl bg-white p-8 shadow-lg transition-shadow hover:shadow-xl">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
              <LogIn className="h-6 w-6 text-green-600" />
            </div>
            <h2 className="mb-2 text-2xl text-gray-900">Join Room</h2>
            <p className="mb-6 text-gray-600">
              Enter a room code to join an existing room
            </p>
            <Button variant="secondary" onClick={() => setShowJoinModal(true)}>
              Join Existing Room
            </Button>
          </div>
        </div>

        <ErrorBoundary>
          <CreateRoomModal
            open={showCreateModal}
            onOpenChange={setShowCreateModal}
          />
        </ErrorBoundary>
        <ErrorBoundary>
          <JoinRoomModal open={showJoinModal} onOpenChange={setShowJoinModal} />
        </ErrorBoundary>
      </div>
    </div>
  );
};

export default Landing;
