import { buildChatItems, dayLabel, GROUP_WINDOW_MS, senderColor } from '../src/utils/chatLayout';
import { Message } from '../src/types';

const at = (iso: string) => new Date(iso).getTime();
const msg = (id: string, senderId: string, iso: string): Message => ({
  messageId: id,
  senderId,
  senderName: senderId.toUpperCase(),
  message: `text ${id}`,
  timestamp: at(iso),
});
const NOW = at('2026-11-27T18:00:00');

describe('buildChatItems', () => {
  it('returns nothing for an empty chat', () => {
    expect(buildChatItems([], 'me', NOW)).toEqual([]);
  });

  it('groups a run from one sender: name on the first bubble, avatar on the last', () => {
    const items = buildChatItems(
      [
        msg('1', 'ana', '2026-11-27T10:00:00'),
        msg('2', 'ana', '2026-11-27T10:01:00'),
        msg('3', 'ana', '2026-11-27T10:02:00'),
        msg('4', 'me', '2026-11-27T10:03:00'),
      ],
      'me',
      NOW,
    );
    expect(items.map((i) => i.kind)).toEqual(['day', 'message', 'message', 'message', 'message']);
    const bubbles = items.flatMap((i) => (i.kind === 'message' ? [i] : []));
    expect(bubbles.map((b) => [b.groupStart, b.groupEnd])).toEqual([
      [true, false],
      [false, false],
      [false, true],
      [true, true],
    ]);
    expect(bubbles.map((b) => b.isOwn)).toEqual([false, false, false, true]);
  });

  it('starts a new group after a long pause from the same sender', () => {
    const first = at('2026-11-27T10:00:00');
    const items = buildChatItems(
      [
        { ...msg('1', 'ana', '2026-11-27T10:00:00') },
        { ...msg('2', 'ana', '2026-11-27T10:00:00'), timestamp: first + GROUP_WINDOW_MS + 1 },
      ],
      'me',
      NOW,
    );
    const bubbles = items.flatMap((i) => (i.kind === 'message' ? [i] : []));
    expect(bubbles.map((b) => b.groupStart)).toEqual([true, true]);
    expect(bubbles[0].groupEnd).toBe(true);
  });

  it('puts a separator at each new day and never groups across it', () => {
    const items = buildChatItems(
      [msg('1', 'ana', '2026-11-26T23:59:00'), msg('2', 'ana', '2026-11-27T00:01:00')],
      'me',
      NOW,
    );
    expect(items.map((i) => (i.kind === 'day' ? i.label : i.message.messageId))).toEqual([
      'Yesterday',
      '1',
      'Today',
      '2',
    ]);
    const bubbles = items.flatMap((i) => (i.kind === 'message' ? [i] : []));
    expect(bubbles.every((b) => b.groupStart && b.groupEnd)).toBe(true);
  });

  it('gives every row a unique key', () => {
    const items = buildChatItems(
      [msg('1', 'ana', '2026-11-25T10:00:00'), msg('2', 'ben', '2026-11-27T10:00:00')],
      'me',
      NOW,
    );
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  });
});

describe('dayLabel', () => {
  it('names today and yesterday, and dates older days', () => {
    expect(dayLabel(at('2026-11-27T00:05:00'), NOW)).toBe('Today');
    expect(dayLabel(at('2026-11-26T23:55:00'), NOW)).toBe('Yesterday');
    expect(dayLabel(at('2026-11-23T12:00:00'), NOW)).toBe('Mon, Nov 23');
    expect(dayLabel(at('2025-12-31T12:00:00'), NOW)).toBe('Wed, Dec 31, 2025');
  });
});

describe('senderColor', () => {
  it('is stable for one sender', () => {
    expect(senderColor('user-a')).toBe(senderColor('user-a'));
    expect(senderColor('user-a')).toMatch(/^#[0-9A-F]{6}$/i);
  });
});
