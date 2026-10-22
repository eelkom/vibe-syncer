import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import useCreateRoom from '@/hooks/mutations/useCreateRoom';
import { ROUTE_PATH } from '@/routes/routePath';
import { useState } from 'react';
import { generatePath, useNavigate } from 'react-router-dom';

interface CreateRoomModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const CreateRoomModal = ({ open, onOpenChange }: CreateRoomModalProps) => {
  const navigate = useNavigate();
  const [roomName, setRoomName] = useState('');
  const [hostNickName, setHostNickName] = useState('');

  const { mutate: createRoom, isPending, isError } = useCreateRoom();

  const handleCreateRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomName.trim()) return;

    createRoom(
      { roomName, hostNickName },
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
        Create New Room
      </Modal.Title>

      <Modal.Description className="sr-only">
        Enter a name to create a new music room.
      </Modal.Description>

      <form onSubmit={handleCreateRoom} className="relative">
        {isError && (
          <div className="mb-4 text-sm text-red-600">
            Failed to create room. Please try again.
          </div>
        )}
        <div className="mb-6">
          <label
            htmlFor="roomName"
            className="mb-2 block text-sm font-medium text-gray-700"
          >
            Room Name
          </label>
          <input
            type="text"
            id="roomName"
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
            placeholder="Enter room name..."
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
            value={hostNickName}
            onChange={(e) => setHostNickName(e.target.value)}
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
              onClick={() => setRoomName('')}
              disabled={isPending}
            >
              Cancel
            </Button>
          </Modal.Close>

          <Button variant="primary" type="submit" loading={isPending}>
            Create Room
          </Button>
        </div>
      </form>
    </Modal>
  );
};

export default CreateRoomModal;
