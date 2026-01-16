import { useEffect, useState, useRef } from 'react';
import { logger } from '@/utils/logger';
import type { ChatMessageResponse } from '@/schemas/chatSchema';

const WS_BASE_URL = import.meta.env.VITE_WS_BASE_URL;
if (!WS_BASE_URL) {
  throw new Error('VITE_WS_BASE_URL is not defined in environment variables');
}
export { WS_BASE_URL };

type WebSocketConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

/**
 * Custom hook for managing WebSocket connection to a music room
 * @param roomCode - Unique identifier for the room
 * @param userId - Current user's ID
 * @returns WebSocket utilities including sendMessage function and connection status
 */
const useWebSocket = (roomCode: string) => {
  const socketRef = useRef<WebSocket | null>(null);
  const [newMessage, setNewMessage] = useState<ChatMessageResponse>();
  const [connectionStatus, setConnectionStatus] =
    useState<WebSocketConnectionStatus>('disconnected');

  const reconnectRef = useRef(0);
  const maxReconnectAttempts = 5;
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef(true);

  const user = JSON.parse(sessionStorage.getItem('user') || 'null');
  const token = user?.token;

  useEffect(() => {
    if (!roomCode) return;

    let isComponentMounted = true;
    isMountedRef.current = true;

    const connectWebSocket = () => {
      if (!isComponentMounted || !isMountedRef.current) return;

      setConnectionStatus('connecting');

      const ws = new WebSocket(`${WS_BASE_URL}/${roomCode}?token=${token}`);
      socketRef.current = ws;

      ws.onopen = () => {
        if (!isComponentMounted || !isMountedRef.current) {
          ws.close();
          return;
        }
        logger.log('[WS] Connected');
        setConnectionStatus('connected');
        reconnectRef.current = 0;
      };

      ws.onmessage = (event) => {
        if (!isComponentMounted || !isMountedRef.current) return;
        try {
          const data = JSON.parse(event.data);
          setNewMessage(data);
        } catch (error) {
          logger.error('[WS] Failed to parse message:', error);
        }
      };

      ws.onerror = (event) => {
        if (!isComponentMounted || !isMountedRef.current) return;
        if (event.type === 'error' && !isComponentMounted) return;
        logger.error('[WS] Error:', event);
        setConnectionStatus('error');
      };

      ws.onclose = () => {
        if (!isComponentMounted || !isMountedRef.current) return;
        logger.log('[WS] Closed');
        setConnectionStatus('disconnected');

        if (reconnectRef.current < maxReconnectAttempts) {
          const delay = Math.min(
            1000 * Math.pow(2, reconnectRef.current),
            30000,
          );
          logger.log(`[WS] Reconnecting in ${delay}ms...`);

          reconnectTimeoutRef.current = setTimeout(() => {
            if (isComponentMounted && isMountedRef.current) {
              reconnectRef.current++;
              connectWebSocket();
            }
          }, delay);
        } else {
          logger.log('[WS] Max reconnection attempts reached');
        }
      };
    };

    connectWebSocket();

    return () => {
      logger.log('[WS] Cleanup: Component unmounting');
      isComponentMounted = false;
      isMountedRef.current = false;

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }

      if (
        socketRef.current &&
        (socketRef.current.readyState === WebSocket.OPEN ||
          socketRef.current.readyState === WebSocket.CONNECTING)
      ) {
        socketRef.current.close();
      }
    };
  }, [roomCode, token]);

  const sendMessage = (data: object) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(data));
    } else {
      logger.warn('WebSocket is not connected');
    }
  };

  return { sendMessage, newMessage, connectionStatus };
};

export default useWebSocket;
