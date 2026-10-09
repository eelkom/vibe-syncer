import { useCallback, useEffect, useState, useRef } from 'react';
import { logger } from '@/utils/logger';
import {
  SocketMessageSchema,
  type SocketMessageMap,
  type SocketMessageType,
} from '@/schemas/socketSchema';

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

type SocketListener<T extends SocketMessageType> = (
  message: SocketMessageMap[T],
) => void;

type SocketListeners = { [K in SocketMessageType]: Set<SocketListener<K>> };

export type SubscribeSocket = <T extends SocketMessageType>(
  type: T,
  listener: SocketListener<T>,
) => () => void;

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

/**
 * Full jitter backoff: random delay in [0, min(cap, base * 2^attempt))
 * so that clients disconnected together do not reconnect at the same moment.
 */
const getReconnectDelay = (attempt: number) =>
  Math.random() *
  Math.min(MAX_RECONNECT_DELAY_MS, BASE_RECONNECT_DELAY_MS * 2 ** attempt);

/**
 * Custom hook for managing WebSocket connection to a music room
 * @param roomCode - Unique identifier for the room
 * @param userId - Current user's ID
 * @returns WebSocket utilities including sendMessage function and connection status
 */
const useWebSocket = (roomCode: string) => {
  const socketRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef<SocketListeners>({
    sync: new Set(),
    chat: new Set(),
    system: new Set(),
    queue_update: new Set(),
  });
  const [connectionStatus, setConnectionStatus] =
    useState<WebSocketConnectionStatus>('disconnected');

  const reconnectRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef(true);
  const isManualCloseRef = useRef(false);

  const clearReconnectTimer = () => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  };

  /**
   * Register a listener for a message type. Listeners are called synchronously
   * for every received message, so bursts of messages are never coalesced.
   * @returns unsubscribe function
   */
  const subscribe: SubscribeSocket = useCallback((type, listener) => {
    const listeners = listenersRef.current[type];
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const user = JSON.parse(sessionStorage.getItem('user') || 'null');
  const token = user?.token;

  useEffect(() => {
    if (!roomCode) return;

    let isComponentMounted = true;
    isMountedRef.current = true;
    isManualCloseRef.current = false;
    reconnectRef.current = 0;

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

      const dispatch = <T extends SocketMessageType>(
        type: T,
        message: SocketMessageMap[T],
      ) => {
        listenersRef.current[type].forEach((listener) => {
          try {
            listener(message);
          } catch (error) {
            logger.error(`[WS] Listener for "${type}" failed:`, error);
          }
        });
      };

      ws.onmessage = (event) => {
        if (!isComponentMounted || !isMountedRef.current) return;

        let data: unknown;
        try {
          data = JSON.parse(event.data);
        } catch (error) {
          logger.error('[WS] Failed to parse message:', error);
          return;
        }

        const result = SocketMessageSchema.safeParse(data);
        if (!result.success) {
          logger.log('[WS] Ignored unsupported message:', data);
          return;
        }

        const message = result.data;
        switch (message.type) {
          case 'sync':
            dispatch('sync', message);
            break;
          case 'chat':
            dispatch('chat', message);
            break;
          case 'system':
            dispatch('system', message);
            break;
          case 'queue_update':
            dispatch('queue_update', message);
            break;
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

        if (isManualCloseRef.current) return;

        if (reconnectRef.current < MAX_RECONNECT_ATTEMPTS) {
          const delay = getReconnectDelay(reconnectRef.current);
          logger.debug(
            `[WS] 재연결 시도 ${reconnectRef.current + 1}회차, 대기 ${Math.round(delay)}ms`,
          );

          clearReconnectTimer();
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectTimeoutRef.current = null;
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

      clearReconnectTimer();

      if (
        socketRef.current &&
        (socketRef.current.readyState === WebSocket.OPEN ||
          socketRef.current.readyState === WebSocket.CONNECTING)
      ) {
        socketRef.current.close();
      }
    };
  }, [roomCode, token]);

  /** Close the connection on purpose; no reconnect is scheduled afterwards. */
  const disconnect = () => {
    isManualCloseRef.current = true;
    clearReconnectTimer();
    socketRef.current?.close();
  };

  const sendMessage = (data: object) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(data));
    } else {
      logger.warn('WebSocket is not connected');
    }
  };

  return {
    sendMessage,
    disconnect,
    subscribe,
    connectionStatus,
  };
};

export default useWebSocket;
