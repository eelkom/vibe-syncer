import { useNavigate, useParams } from 'react-router-dom';
import { Users, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import InviteFriendModal from './components/InviteFriendModal';
import ChatBoard from './components/ChatBoard';
import QueueBoard from './components/QueueBoard';
import AlbumCover from './components/AlbumCover';
import MusicPlayer from './components/MusicPlayer';
import { useUser } from '@/contexts/UserContext';
import ExitRoomModal from './components/ExitRoomModal';
import DeleteRoomModal from './components/DeleteRoomModal';
import useRoomInfos from '@/hooks/queries/useRoomInfos';
import ErrorBoundary from '@/components/ErrorBoundary';
import Loading from '@/components/ui/Loading';
import Error from '@/components/ui/Error';

const MusicRoom = () => {
  const navigate = useNavigate();
  const { id: roomCode } = useParams();
  const { user } = useUser();
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showExitRoomModal, setShowExitRoomModal] = useState(false);
  const [showDeleteRoomModal, setShowDeleteRoomModal] = useState(false);
  const [isPlaying] = useState(false);

  const { data: roomInfos, isLoading, isError } = useRoomInfos(roomCode || '');

  useEffect(() => {
    if (!user) {
      navigate('/');
    }
  }, [user, navigate]);

  if (isError) return <Error />;

  return (
    <div className="flex max-h-screen flex-col bg-white">
      <header className="border-b bg-gradient-to-br from-blue-50 to-indigo-100 px-10 py-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-6">
            <p className="text-2xl text-gray-900">VibeSyncer</p>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 rounded-full border border-gray-800 bg-gray-900 px-4 py-2">
              <Users className="h-4 w-4 text-gray-400" />
              <span className="text-xs text-gray-300">
                {roomInfos?.participants.length}
              </span>
            </div>
            <button
              onClick={() => setShowInviteModal(true)}
              className="flex items-center gap-2 rounded-full bg-white px-5 py-2 text-sm text-black transition-all hover:bg-gray-100"
            >
              <UserPlus className="h-4 w-4" />
            </button>
            {user?.isHost ? (
              <button
                onClick={() => setShowDeleteRoomModal(true)}
                className="rounded-full border border-gray-800 bg-gray-800 px-5 py-2 text-sm text-gray-300 transition-all hover:bg-gray-600"
              >
                Delete
              </button>
            ) : (
              <button
                onClick={() => setShowExitRoomModal(true)}
                className="rounded-full border border-gray-800 bg-gray-800 px-5 py-2 text-sm text-gray-300 transition-all hover:bg-gray-600"
              >
                Back
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="bg-white-50 mx-auto flex w-full max-w-7xl flex-1 gap-6 overflow-hidden p-10">
        <ErrorBoundary>
          <QueueBoard roomCode={roomCode || ''} />
        </ErrorBoundary>
        <div className="align-center flex flex-1 flex-col justify-center gap-4">
          <div className="mb-8 text-center">
            <h1 className="text-4xl font-bold text-gray-900">
              {isLoading ? (
                <Loading />
              ) : (
                `${roomInfos?.host_nickname}'s ${roomInfos?.name}`
              )}
            </h1>
          </div>
          <AlbumCover isPlaying={isPlaying} />
          <MusicPlayer />
        </div>
        <ErrorBoundary>
          <ChatBoard currentUser={user} roomCode={roomCode || ''} />
        </ErrorBoundary>
      </div>

      <ErrorBoundary>
        <InviteFriendModal
          open={showInviteModal}
          onOpenChange={setShowInviteModal}
          roomCode={roomCode || ''}
        />
      </ErrorBoundary>
      <ErrorBoundary>
        <DeleteRoomModal
          open={showDeleteRoomModal}
          onOpenChange={setShowDeleteRoomModal}
        />
      </ErrorBoundary>
      <ErrorBoundary>
        <ExitRoomModal
          open={showExitRoomModal}
          onOpenChange={setShowExitRoomModal}
        />
      </ErrorBoundary>
    </div>
  );
};

export default MusicRoom;
