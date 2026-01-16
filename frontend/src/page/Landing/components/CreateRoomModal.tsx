import Button from '@/components/ui/Button';
import Loading from '@/components/ui/Loading';
import useCreateRoom from '@/hooks/mutations/useCreateRoom';
import { ROUTE_PATH } from '@/routes/routePath';
import * as Dialog from '@radix-ui/react-dialog';
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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />

        <Dialog.Content className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] fixed left-[50%] top-[50%] z-50 w-full max-w-md translate-x-[-50%] translate-y-[-50%] rounded-2xl bg-white p-8 shadow-2xl focus:outline-none">
          <Dialog.Title className="mb-6 text-2xl font-bold text-gray-900">
            Create New Room
          </Dialog.Title>

          <Dialog.Description className="sr-only">
            Enter a name to create a new music room.
          </Dialog.Description>

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
              <Dialog.Close asChild>
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => setRoomName('')}
                  disabled={isPending}
                >
                  Cancel
                </Button>
              </Dialog.Close>

              <Button variant="primary" type="submit" disabled={isPending}>
                {isPending ? <Loading size={80} /> : 'Create Room'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

export default CreateRoomModal;
