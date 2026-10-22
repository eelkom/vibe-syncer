import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';

interface ConfirmModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  loading?: boolean;
}

const ConfirmModal = ({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  loading = false,
}: ConfirmModalProps) => {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onConfirm();
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} size="sm">
      <form
        onSubmit={handleSubmit}
        className="flex w-full flex-col items-center text-center"
      >
        <div className="mb-4 rounded-full bg-red-100 p-3 text-red-600">
          <AlertTriangle size={24} />
        </div>
        <Modal.Title className="mb-2 text-lg font-bold text-gray-900">
          {title}
        </Modal.Title>
        <Modal.Description className="mb-6 text-sm text-gray-500">
          {description}
        </Modal.Description>
        <div className="flex w-full gap-3">
          <Modal.Close asChild>
            <Button variant="secondary" type="button" disabled={loading}>
              {cancelLabel}
            </Button>
          </Modal.Close>
          <Button variant="primary" type="submit" loading={loading}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
};

export default ConfirmModal;
