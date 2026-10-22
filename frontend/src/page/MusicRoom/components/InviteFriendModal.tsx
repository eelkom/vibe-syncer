import Modal from '@/components/ui/Modal';
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
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      className="rounded-3xl border border-gray-200"
    >
      <div className="mb-6 flex items-center justify-between">
        <Modal.Title className="text-xl font-medium text-gray-900">
          Invite friends
        </Modal.Title>

        <Modal.Close className="rounded-full p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600">
          <X size={20} />
        </Modal.Close>
      </div>

      <Modal.Description className="mb-6 text-sm text-gray-600">
        Share this code with your friends to let them join the room.
      </Modal.Description>

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

      <Modal.Close asChild>
        <button className="w-full rounded-full border border-gray-200 px-6 py-3 text-sm font-medium text-gray-700 transition-all hover:bg-gray-50 active:scale-[0.98]">
          Close
        </button>
      </Modal.Close>
    </Modal>
  );
};
export default InviteFriendModal;
