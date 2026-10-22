import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { Users, User } from 'lucide-react';

interface Participant {
  userId: number;
  nickname: string;
  joinedAt: string;
}

interface ParticipantsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  participants: Participant[];
}

const ParticipantsModal = ({
  open,
  onOpenChange,
  participants,
}: ParticipantsModalProps) => {
  console.log(participants);
  return (
    <Modal open={open} onOpenChange={onOpenChange} size="sm">
      <div className="flex w-full flex-col items-center">
        <div className="mb-4 rounded-full bg-indigo-50 p-3 text-indigo-600">
          <Users size={24} />
        </div>
        <Modal.Title className="mb-1 text-lg font-bold text-gray-900">
          Participants
        </Modal.Title>
        <Modal.Description className="mb-6 text-sm text-gray-500">
          There are currently {participants.length} people here.
        </Modal.Description>

        <div className="custom-scrollbar mb-6 flex max-h-[300px] w-full flex-col gap-2 overflow-y-auto pr-1">
          {participants.map((user) => (
            <div
              key={user.userId}
              className="flex items-center justify-between rounded-xl border border-gray-100 p-3 transition-colors hover:bg-gray-50"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-100 text-gray-500">
                  <User size={20} />
                </div>

                <span className="font-medium text-gray-700">
                  {user.nickname}
                </span>
              </div>
            </div>
          ))}

          {participants.length === 0 && (
            <div className="py-4 text-center text-sm text-gray-400">
              No participants found.
            </div>
          )}
        </div>

        <div className="w-full">
          <Modal.Close asChild>
            <Button variant="secondary" type="button" className="w-full">
              Close
            </Button>
          </Modal.Close>
        </div>
      </div>
    </Modal>
  );
};

export default ParticipantsModal;
