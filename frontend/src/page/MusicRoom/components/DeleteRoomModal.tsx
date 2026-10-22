import ConfirmModal from '@/components/ui/ConfirmModal';
import Error from '@/components/ui/Error';
import useDeleteRoom from '@/hooks/mutations/useDeleteRoom';
import { ROUTE_PATH } from '@/routes/routePath';
import { useNavigate } from 'react-router-dom';

interface DeleteRoomModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const DeleteRoomModal = ({ open, onOpenChange }: DeleteRoomModalProps) => {
  const navigate = useNavigate();
  const { mutate: deleteRoom, isPending, isError } = useDeleteRoom();

  const handleDeleteRoom = () => {
    deleteRoom(undefined, {
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
      title="Delete this room?"
      description="If you delete, the room will be permanently removed and all participants will be disconnected."
      confirmLabel="Delete Room"
      onConfirm={handleDeleteRoom}
      loading={isPending}
    />
  );
};

export default DeleteRoomModal;
