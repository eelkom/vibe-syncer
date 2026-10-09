import { BOT_MESSAGE_PREFIX, BOT_USER_ID } from '@/constants/chat';
import type { ChatMessage } from '@/schemas/chatSchema';
import { getMessageId } from '@/utils/getMessageId';

export type ChatMessageMap = Map<string, ChatMessage>;

const TIMEZONE_PATTERN = /(Z|[+-]\d{2}:?\d{2})$/i;

const getMessageTime = (msg: ChatMessage) => {
  const time = Date.parse(msg.created_at);
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
};

const normalizeContent = (msg: ChatMessage) =>
  msg.user_id === BOT_USER_ID && msg.message.startsWith(BOT_MESSAGE_PREFIX)
    ? msg.message.slice(BOT_MESSAGE_PREFIX.length)
    : msg.message;

/**
 * Whether a message without an id (from WebSocket) is the same message as one
 * loaded from the server. User messages carry the DB timestamp, so the instant
 * must match even if the string format differs. Bot broadcasts use a different
 * timestamp than the DB row, so only the content is compared.
 */
const isSameMessage = (live: ChatMessage, saved: ChatMessage) =>
  live.user_id === saved.user_id &&
  normalizeContent(live) === normalizeContent(saved) &&
  (live.user_id === BOT_USER_ID ||
    getMessageTime(live) === getMessageTime(saved));

const compareMessages = (a: ChatMessage, b: ChatMessage) => {
  const timeDiff = getMessageTime(a) - getMessageTime(b);
  if (timeDiff !== 0 && !Number.isNaN(timeDiff)) return timeDiff;
  return (
    (a.id ?? Number.POSITIVE_INFINITY) - (b.id ?? Number.POSITIVE_INFINITY) || 0
  );
};

const toSortedMap = (messages: ChatMessage[]): ChatMessageMap =>
  new Map(
    [...messages]
      .sort(compareMessages)
      .map((msg) => [getMessageId(msg), msg] as const),
  );

/**
 * Some broadcasts (bot messages) use a server-local time without a timezone,
 * which can't be compared with other timestamps. Use the receive time instead.
 */
export const normalizeLiveMessage = (msg: ChatMessage): ChatMessage =>
  TIMEZONE_PATTERN.test(msg.created_at)
    ? msg
    : { ...msg, created_at: new Date().toISOString() };

/** Merge messages loaded from the server into the cached messages. */
export const mergeChatMessages = (
  cached: ChatMessageMap | undefined,
  fetched: ChatMessage[],
): ChatMessageMap => {
  const merged = new Map(fetched.map((msg) => [getMessageId(msg), msg]));
  const unclaimed = [...fetched];

  cached?.forEach((msg, key) => {
    if (merged.has(key)) return;

    if (msg.id === undefined) {
      const matchIndex = unclaimed.findIndex((saved) =>
        isSameMessage(msg, saved),
      );
      if (matchIndex !== -1) {
        unclaimed.splice(matchIndex, 1);
        return;
      }
    }

    merged.set(key, msg);
  });

  return toSortedMap([...merged.values()]);
};

/** Add a message received in real time unless it's already cached. */
export const addLiveChatMessage = (
  cached: ChatMessageMap | undefined,
  live: ChatMessage,
): ChatMessageMap => {
  const messages = [...(cached?.values() ?? [])];
  const isDuplicate = messages.some(
    (msg) =>
      getMessageId(msg) === getMessageId(live) ||
      (msg.id !== undefined && isSameMessage(live, msg)),
  );

  return isDuplicate ? (cached ?? new Map()) : toSortedMap([...messages, live]);
};
