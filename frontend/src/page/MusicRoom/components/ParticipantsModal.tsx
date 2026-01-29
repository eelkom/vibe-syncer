import Button from '@/components/ui/Button';
import * as Dialog from '@radix-ui/react-dialog';
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
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />

        <Dialog.Content className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] fixed left-[50%] top-[50%] z-50 w-full max-w-sm translate-x-[-50%] translate-y-[-50%] rounded-2xl bg-white p-6 shadow-2xl focus:outline-none">
          <div className="flex w-full flex-col items-center">
            <div className="mb-4 rounded-full bg-indigo-50 p-3 text-indigo-600">
              <Users size={24} />
            </div>
            <Dialog.Title className="mb-1 text-lg font-bold text-gray-900">
              Participants
            </Dialog.Title>
            <Dialog.Description className="mb-6 text-sm text-gray-500">
              There are currently {participants.length} people here.
            </Dialog.Description>

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
              <Dialog.Close asChild>
                <Button variant="secondary" type="button" className="w-full">
                  Close
                </Button>
              </Dialog.Close>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

export default ParticipantsModal;
