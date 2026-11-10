import type { SubscribeSocket } from '@/hooks/useWebSocket';
import { useCallback, useEffect, useEffectEvent, useRef } from 'react';

// Probes sent right after connecting, spaced so they don't share a stall
const INITIAL_PROBES = 5;
const PROBE_GAP_MS = 200;
// Clocks drift and routes change, so keep probing while connected
const REPROBE_INTERVAL_MS = 30000;
// Recent samples kept; the one with the shortest round trip is used
const MAX_SAMPLES = 8;
// A reply slower than this says little about the offset
const MAX_RTT_MS = 2000;

interface ClockSample {
  rtt: number;
  offset: number;
}

// Wall clock that keeps ticking steadily even if the system clock is changed
const localNow = () => performance.timeOrigin + performance.now();

interface UseServerClockProps {
  sendMessage: (messageData: object) => void;
  subscribe: SubscribeSocket;
  connectionStatus: 'connecting' | 'connected' | 'disconnected' | 'error';
}

/**
 * Estimates the server clock with NTP-style probes over the room WebSocket.
 * The server answers time_sync with its time; assuming the reply was made
 * halfway through the round trip, offset = server - (sent + received) / 2.
 * The sample with the shortest round trip has the least room for asymmetry.
 */
const useServerClock = ({
  sendMessage,
  subscribe,
  connectionStatus,
}: UseServerClockProps) => {
  const samplesRef = useRef<ClockSample[]>([]);
  const sentAtRef = useRef(new Map<number, number>());
  const nextIdRef = useRef(0);

  useEffect(
    () =>
      subscribe('time_sync', (message) => {
        const sentAt = sentAtRef.current.get(message.id);
        if (sentAt === undefined) return;
        sentAtRef.current.delete(message.id);

        const receivedAt = localNow();
        const rtt = receivedAt - sentAt;
        if (rtt < 0 || rtt > MAX_RTT_MS) return;

        const samples = samplesRef.current;
        samples.push({ rtt, offset: message.server_ms - (sentAt + rtt / 2) });
        if (samples.length > MAX_SAMPLES) samples.shift();
      }),
    [subscribe],
  );

  const probe = useEffectEvent(() => {
    const id = nextIdRef.current++;
    const sentAt = sentAtRef.current;
    sentAt.set(id, localNow());
    // Probes lost to a disconnect are never answered
    if (sentAt.size > 20) sentAt.delete(sentAt.keys().next().value!);
    sendMessage({ type: 'time_sync', id });
  });

  useEffect(() => {
    if (connectionStatus !== 'connected') return;

    const timers = Array.from({ length: INITIAL_PROBES }, (_, i) =>
      setTimeout(() => probe(), i * PROBE_GAP_MS),
    );
    const interval = setInterval(() => probe(), REPROBE_INTERVAL_MS);
    return () => {
      timers.forEach(clearTimeout);
      clearInterval(interval);
    };
  }, [connectionStatus]);

  /** Current server time in ms, or null before the first answer. */
  const now = useCallback(() => {
    const samples = samplesRef.current;
    if (!samples.length) return null;
    const best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    return localNow() + best.offset;
  }, []);

  return { now };
};

export default useServerClock;
