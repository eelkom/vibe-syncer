import type { ChatMessageResponse } from '@/schemas/chatSchema';
import { getMessageId } from '@/utils/getMessageId';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';

interface UseChatBoardProps {
  sendMessage: (messageData: object) => void;
  newMessage: ChatMessageResponse | undefined;
  roomCode: string;
  connectionStatus: 'connecting' | 'connected' | 'disconnected' | 'error';
  isAiLoading: boolean;
}

const MAX_MESSAGE_LENGTH = 100;

const useChatBoard = ({
  sendMessage,
  newMessage,
  roomCode,
  connectionStatus,
  isAiLoading,
}: UseChatBoardProps) => {
  const queryClient = useQueryClient();
  const [newTextInput, setNewTextInput] = useState('');
  const chatContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (newMessage && newMessage.type === 'chat') {
      queryClient.setQueryData(
        ['chatMessages', roomCode],
        (prevMap: Map<string, ChatMessageResponse> | undefined) => {
          const updated = new Map(prevMap || []);
          updated.set(getMessageId(newMessage), newMessage);
          return updated;
        },
      );
    }
  }, [newMessage, roomCode, queryClient]);

  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTo({
        top: chatContainerRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [newMessage, isAiLoading]);

  const trySendMessage = (textToSend: string) => {
    const trimmed = textToSend.trim();
    if (trimmed === '') return;

    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      toast.error('Message too long');
      return;
    }

    if (connectionStatus !== 'connected') {
      toast.error('Not connected. Please wait...');
      return;
    }

    const messageData = {
      type: 'chat',
      message: trimmed,
    };

    sendMessage(messageData);
    setNewTextInput('');
  };

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    trySendMessage(newTextInput);
  };

  const handleAiAsk = () => {
    if (newTextInput.trim() === '') {
      return;
    }
    trySendMessage(`!dj ${newTextInput}`);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setNewTextInput(e.target.value);
  };

  return {
    chatContainerRef,
    newTextInput,
    handleSendMessage,
    handleAiAsk,
    handleInputChange,
  };
};

export default useChatBoard;
