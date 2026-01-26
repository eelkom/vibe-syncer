import { useState } from 'react';

const useHeaderModals = () => {
  const [showParticipantsModal, setShowParticipantsModal] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showExitRoomModal, setShowExitRoomModal] = useState(false);
  const [showDeleteRoomModal, setShowDeleteRoomModal] = useState(false);

  return {
    showParticipantsModal,
    showInviteModal,
    showExitRoomModal,
    showDeleteRoomModal,
    setShowParticipantsModal,
    setShowInviteModal,
    setShowExitRoomModal,
    setShowDeleteRoomModal,
    openParticipantsModal: () => setShowParticipantsModal(true),
    openInviteModal: () => setShowInviteModal(true),
    openDeleteModal: () => setShowDeleteRoomModal(true),
    openExitModal: () => setShowExitRoomModal(true),
  };
};

export default useHeaderModals;
