import Button from '@/components/ui/Button';
import Error from '@/components/ui/Error';
import Loading from '@/components/ui/Loading';
import useExitRoom from '@/hooks/mutations/useExitRoom';
import { ROUTE_PATH } from '@/routes/routePath';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface ExitRoomModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ExitRoomModal = ({ open, onOpenChange }: ExitRoomModalProps) => {
  const navigate = useNavigate();
  const { mutate: exitRoom, isPending, isError } = useExitRoom();

  const handleLeaveRoom = (e: React.FormEvent) => {
    e.preventDefault();
    exitRoom(undefined, {
      onSuccess: () => {
        navigate(ROUTE_PATH.LANDING);
      },
    });
  };

  if (isError) return <Error />;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />

        <Dialog.Content className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] fixed left-[50%] top-[50%] z-50 w-full max-w-sm translate-x-[-50%] translate-y-[-50%] rounded-2xl bg-white p-6 shadow-2xl focus:outline-none">
          <form
            onSubmit={handleLeaveRoom}
            className="flex w-full flex-col items-center text-center"
          >
            <div className="mb-4 rounded-full bg-red-100 p-3 text-red-600">
              <AlertTriangle size={24} />
            </div>
            <Dialog.Title className="mb-2 text-lg font-bold text-gray-900">
              Leave this room?
            </Dialog.Title>
            <Dialog.Description className="mb-6 text-sm text-gray-500">
              If you leave, the music will stop playing and your connection will
              be lost.
            </Dialog.Description>
            <div className="flex w-full gap-3">
              <Dialog.Close asChild>
                <Button variant="secondary" type="button" disabled={isPending}>
                  Cancel
                </Button>
              </Dialog.Close>
              <Button variant="primary" type="submit" disabled={isPending}>
                {isPending ? <Loading /> : 'Leave Room'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

export default ExitRoomModal;
