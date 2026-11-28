import { Message } from '../types';

// Turns a flat, time-ordered message list into what a chat screen draws:
// day separators, and runs of messages from one sender grouped together so
// the name and avatar show once per run instead of on every bubble.

/** Messages from one sender this close together belong to one group. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

export type ChatItem =
  | { kind: 'day'; key: string; label: string }
  | {
      kind: 'message';
      key: string;
      message: Message;
      isOwn: boolean;
      /** First bubble of a run: shows the sender's name (other people only). */
      groupStart: boolean;
      /** Last bubble of a run: shows the avatar and the bubble's tail corner. */
      groupEnd: boolean;
    };

const dayKey = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/** "Today", "Yesterday", or a date like "Mon, Nov 23". */
export function dayLabel(ts: number, now: number = Date.now()): string {
  const startOf = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((startOf(now) - startOf(ts)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function buildChatItems(
  messages: Message[],
  ownId: string | undefined,
  now: number = Date.now(),
): ChatItem[] {
  const items: ChatItem[] = [];
  const sameGroup = (a: Message | undefined, b: Message | undefined) =>
    !!a &&
    !!b &&
    a.senderId === b.senderId &&
    dayKey(a.timestamp) === dayKey(b.timestamp) &&
    Math.abs(b.timestamp - a.timestamp) <= GROUP_WINDOW_MS;

  messages.forEach((message, i) => {
    const prev = messages[i - 1];
    const next = messages[i + 1];
    if (!prev || dayKey(prev.timestamp) !== dayKey(message.timestamp)) {
      items.push({
        kind: 'day',
        key: `day-${dayKey(message.timestamp)}`,
        label: dayLabel(message.timestamp, now),
      });
    }
    items.push({
      kind: 'message',
      key: message.messageId,
      message,
      isOwn: message.senderId === ownId,
      groupStart: !sameGroup(prev, message),
      groupEnd: !sameGroup(message, next),
    });
  });
  return items;
}

// Readable on both the light and dark bubble backgrounds.
const SENDER_COLORS = [
  '#E5677B',
  '#D98A2B',
  '#3FA796',
  '#4A90D9',
  '#8E6FD8',
  '#C75BB0',
  '#5B9A3C',
  '#D9663F',
];

/** A stable colour per sender, so names are easy to tell apart in a group chat. */
export function senderColor(senderId: string): string {
  let hash = 0;
  for (let i = 0; i < senderId.length; i++) hash = (hash * 31 + senderId.charCodeAt(i)) >>> 0;
  return SENDER_COLORS[hash % SENDER_COLORS.length];
}

/** Compact time for a chat list row: "7:05 PM" today, "Yesterday", else "Nov 23". */
export function listTime(ts: number, now: number = Date.now()): string {
  const label = dayLabel(ts, now);
  if (label === 'Today') {
    return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  if (label === 'Yesterday') return label;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
