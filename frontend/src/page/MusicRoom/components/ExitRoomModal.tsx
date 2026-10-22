import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import Error from '@/components/ui/Error';
import useExitRoom from '@/hooks/mutations/useExitRoom';
import { ROUTE_PATH } from '@/routes/routePath';
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
    <Modal open={open} onOpenChange={onOpenChange} size="sm">
      <form
        onSubmit={handleLeaveRoom}
        className="flex w-full flex-col items-center text-center"
      >
        <div className="mb-4 rounded-full bg-red-100 p-3 text-red-600">
          <AlertTriangle size={24} />
        </div>
        <Modal.Title className="mb-2 text-lg font-bold text-gray-900">
          Leave this room?
        </Modal.Title>
        <Modal.Description className="mb-6 text-sm text-gray-500">
          If you leave, the music will stop playing and your connection will be
          lost.
        </Modal.Description>
        <div className="flex w-full gap-3">
          <Modal.Close asChild>
            <Button variant="secondary" type="button" disabled={isPending}>
              Cancel
            </Button>
          </Modal.Close>
          <Button variant="primary" type="submit" loading={isPending}>
            Leave Room
          </Button>
        </div>
      </form>
    </Modal>
  );
};

export default ExitRoomModal;
