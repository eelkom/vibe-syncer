import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { Copy, Check, X } from 'lucide-react';
import { logger } from '@/utils/logger';

interface InviteRoomModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roomCode: string;
}

const InviteFriendModal = ({
  open,
  onOpenChange,
  roomCode,
}: InviteRoomModalProps) => {
  const [isCopied, setIsCopied] = useState(false);

  const handleCopyRoomCode = async () => {
    try {
      await navigator.clipboard.writeText(roomCode);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      logger.error('Failed to copy text: ', err);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />

        <Dialog.Content className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] fixed left-[50%] top-[50%] z-50 w-full max-w-md translate-x-[-50%] translate-y-[-50%] rounded-3xl border border-gray-200 bg-white p-8 shadow-2xl focus:outline-none">
          <div className="mb-6 flex items-center justify-between">
            <Dialog.Title className="text-xl font-medium text-gray-900">
              Invite friends
            </Dialog.Title>

            <Dialog.Close className="rounded-full p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600">
              <X size={20} />
            </Dialog.Close>
          </div>

          <Dialog.Description className="mb-6 text-sm text-gray-600">
            Share this code with your friends to let them join the room.
          </Dialog.Description>

          <div className="mb-6">
            <div className="flex gap-3">
              <input
                type="text"
                value={roomCode}
                readOnly
                className="flex-1 rounded-full border border-gray-200 bg-gray-50 px-5 py-3 font-mono text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-200"
              />
              <button
                onClick={handleCopyRoomCode}
                className={`flex items-center justify-center gap-2 rounded-full px-6 py-3 text-sm font-medium text-white transition-all ${
                  isCopied
                    ? 'bg-green-600 hover:bg-green-700'
                    : 'bg-black hover:bg-gray-800'
                }`}
              >
                {isCopied ? (
                  <>
                    <Check size={16} /> Copied
                  </>
                ) : (
                  <>
                    <Copy size={16} /> Copy
                  </>
                )}
              </button>
            </div>
          </div>

          <Dialog.Close asChild>
            <button className="w-full rounded-full border border-gray-200 px-6 py-3 text-sm font-medium text-gray-700 transition-all hover:bg-gray-50 active:scale-[0.98]">
              Close
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
export default InviteFriendModal;
