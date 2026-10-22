import ConfirmModal from '@/components/ui/ConfirmModal';
import Error from '@/components/ui/Error';
import useExitRoom from '@/hooks/mutations/useExitRoom';
import { ROUTE_PATH } from '@/routes/routePath';
import { useNavigate } from 'react-router-dom';

interface ExitRoomModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ExitRoomModal = ({ open, onOpenChange }: ExitRoomModalProps) => {
  const navigate = useNavigate();
  const { mutate: exitRoom, isPending, isError } = useExitRoom();

  const handleLeaveRoom = () => {
    exitRoom(undefined, {
      onSuccess: () => {
        navigate(ROUTE_PATH.LANDING);
      },
    });
  };

  if (isError) return <Error />;

  return (
    <ConfirmModal
      open={open}
      onOpenChange={onOpenChange}
      title="Leave this room?"
      description="If you leave, the music will stop playing and your connection will be lost."
      confirmLabel="Leave Room"
      onConfirm={handleLeaveRoom}
      loading={isPending}
    />
  );
};

export default ExitRoomModal;
