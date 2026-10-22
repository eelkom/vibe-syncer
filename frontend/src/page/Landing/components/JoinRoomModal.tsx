import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import useJoinRoom from '@/hooks/mutations/useJoinRoom';
import { ROUTE_PATH } from '@/routes/routePath';
import { useState } from 'react';
import { generatePath, useNavigate } from 'react-router-dom';

interface JoinRoomModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const JoinRoomModal = ({ open, onOpenChange }: JoinRoomModalProps) => {
  const navigate = useNavigate();
  const [roomCode, setRoomCode] = useState('');
  const [nickName, setNickName] = useState('');

  const { mutate: joinRoom, isPending, isError } = useJoinRoom();

  const handleJoinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomCode.trim()) return;
    joinRoom(
      { roomCode, nickName },
      {
        onSuccess: (roomCode) => {
          navigate(generatePath(ROUTE_PATH.MUSIC_ROOM, { id: roomCode }));
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Title className="mb-6 text-2xl font-bold text-gray-900">
        Join Room
      </Modal.Title>

      <Modal.Description className="sr-only">
        Enter the room code to join an existing music room.
      </Modal.Description>

      <form onSubmit={handleJoinRoom} className="relative">
        {isError && (
          <div className="mb-4 text-sm text-red-600">
            Failed to join room. Please check the code and try again.
          </div>
        )}
        <div className="mb-6">
          <label
            htmlFor="roomCode"
            className="mb-2 block text-sm font-medium text-gray-700"
          >
            Room Code
          </label>
          <input
            type="text"
            id="roomCode"
            value={roomCode}
            onChange={(e) => setRoomCode(e.target.value)}
            placeholder="Enter room code..."
            className="w-full rounded-lg border border-gray-300 px-4 py-3 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            required
            disabled={isPending}
          />
        </div>

        <div className="mb-6">
          <label
            htmlFor="nickName"
            className="mb-2 block text-sm font-medium text-gray-700"
          >
            Nick Name
          </label>
          <input
            type="text"
            id="nickName"
            value={nickName}
            onChange={(e) => setNickName(e.target.value)}
            placeholder="Enter nickname..."
            className="w-full rounded-lg border border-gray-300 px-4 py-3 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            required
            disabled={isPending}
          />
        </div>

        <div className="flex gap-3">
          <Modal.Close asChild>
            <Button
              variant="secondary"
              type="button"
              onClick={() => setRoomCode('')}
              disabled={isPending}
            >
              Cancel
            </Button>
          </Modal.Close>

          <Button variant="primary" type="submit" loading={isPending}>
            Join Room
          </Button>
        </div>
      </form>
    </Modal>
  );
};

export default JoinRoomModal;
