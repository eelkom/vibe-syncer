import { AI_THINKING_MESSAGE, BOT_USER_ID } from '@/constants/chat';
import type { SubscribeSocket } from '@/hooks/useWebSocket';
import {
  addLiveChatMessage,
  normalizeLiveMessage,
  type ChatMessageMap,
} from '@/utils/chatMessages';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';

interface UseChatBoardProps {
  sendMessage: (messageData: object) => void;
  subscribe: SubscribeSocket;
  chatMessages: ChatMessageMap | undefined;
  roomCode: string;
  connectionStatus: 'connecting' | 'connected' | 'disconnected' | 'error';
}

const MAX_MESSAGE_LENGTH = 100;

const useChatBoard = ({
  sendMessage,
  subscribe,
  chatMessages,
  roomCode,
  connectionStatus,
}: UseChatBoardProps) => {
  const queryClient = useQueryClient();
  const [newTextInput, setNewTextInput] = useState('');
  const [isAiLoading, setIsAiLoading] = useState(false);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsubscribeChat = subscribe('chat', (message) => {
      if (message.user_id === BOT_USER_ID) {
        setIsAiLoading(false);
      }

      const liveMessage = normalizeLiveMessage(message);
      queryClient.setQueryData<ChatMessageMap>(
        ['chatMessages', roomCode],
        (prevMap) => addLiveChatMessage(prevMap, liveMessage),
      );
    });

    const unsubscribeSystem = subscribe('system', (message) => {
      if (message.message === AI_THINKING_MESSAGE) {
        setIsAiLoading(true);
      }
    });

    return () => {
      unsubscribeChat();
      unsubscribeSystem();
    };
  }, [subscribe, roomCode, queryClient]);

  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTo({
        top: chatContainerRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [chatMessages, isAiLoading]);

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
    isAiLoading,
    handleSendMessage,
    handleAiAsk,
    handleInputChange,
  };
};

export default useChatBoard;
