// src/services/moderation.ts: the three RPCs and the blocked-users list.

import {
  REPORT_DETAILS_MAX,
  REPORT_REASONS,
  blockUser,
  getBlockedUsers,
  reportContent,
  unblockUser,
} from '../src/services/moderation';

type Result = { data: unknown; error: { message: string } | null };

const mockRpc = jest.fn();
const mockFrom = jest.fn();

jest.mock('../src/services/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  },
  check: <T>(r: { data: T; error: { message: string } | null }) => {
    if (r.error) throw new Error(r.error.message);
    return r.data;
  },
}));

/** A query builder whose last call (order / in) resolves to `result`. */
function table(result: Result) {
  const builder = {
    select: jest.fn((): unknown => builder),
    order: jest.fn(() => Promise.resolve(result)),
    in: jest.fn(() => Promise.resolve(result)),
  };
  return builder;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRpc.mockResolvedValue({ data: null, error: null });
});

it('blocks and unblocks through the RPCs', async () => {
  await blockUser('user-b');
  await unblockUser('user-b');
  expect(mockRpc.mock.calls).toEqual([
    ['block_user', { p_user_id: 'user-b' }],
    ['unblock_user', { p_user_id: 'user-b' }],
  ]);
});

it('surfaces the server message when a block is refused', async () => {
  mockRpc.mockResolvedValue({ data: null, error: { message: 'You cannot block yourself' } });
  await expect(blockUser('me')).rejects.toThrow('You cannot block yourself');
});

it('sends a report with trimmed details and returns its id', async () => {
  mockRpc.mockResolvedValue({ data: 'report-1', error: null });
  const id = await reportContent('message', 'msg-1', 'harassment', '  called me names ');
  expect(id).toBe('report-1');
  expect(mockRpc).toHaveBeenCalledWith('report_content', {
    p_target_type: 'message',
    p_target_id: 'msg-1',
    p_reason: 'harassment',
    p_details: 'called me names',
  });
});

it('sends null details when none were given', async () => {
  await reportContent('pod', 'pod-1', 'spam', '   ');
  await reportContent('user', 'user-1', 'other');
  expect(mockRpc.mock.calls.map((c) => c[1].p_details)).toEqual([null, null]);
});

it('rejects over-long details without calling the server', async () => {
  await expect(
    reportContent('activity', 'act-1', 'spam', 'x'.repeat(REPORT_DETAILS_MAX + 1)),
  ).rejects.toThrow(`${REPORT_DETAILS_MAX} characters`);
  expect(mockRpc).not.toHaveBeenCalled();
});

it('surfaces the rate-limit message', async () => {
  mockRpc.mockResolvedValue({
    data: null,
    error: { message: 'You have reached the daily report limit.' },
  });
  await expect(reportContent('user', 'user-1', 'spam')).rejects.toThrow('daily report limit');
});

it('offers the reasons the database accepts', () => {
  // Keep in step with the `reason` check in 20261123000000_reports_and_blocks.sql.
  expect(REPORT_REASONS.map((r) => r.value)).toEqual([
    'harassment',
    'hate',
    'sexual',
    'violence',
    'self_harm',
    'spam',
    'impersonation',
    'other',
  ]);
});

it('lists blocked users newest first, with names', async () => {
  const blocks = table({
    data: [
      { blocked_id: 'u2', created_at: '2026-11-22T10:00:00Z' },
      { blocked_id: 'u1', created_at: '2026-11-20T10:00:00Z' },
      { blocked_id: 'gone', created_at: '2026-11-19T10:00:00Z' },
    ],
    error: null,
  });
  const profiles = table({
    data: [
      { id: 'u1', display_name: 'Uma' },
      { id: 'u2', display_name: 'Theo' },
    ],
    error: null,
  });
  mockFrom.mockImplementation((name: string) => (name === 'blocks' ? blocks : profiles));

  expect(await getBlockedUsers()).toEqual([
    { uid: 'u2', displayName: 'Theo', blockedAt: '2026-11-22T10:00:00Z' },
    { uid: 'u1', displayName: 'Uma', blockedAt: '2026-11-20T10:00:00Z' },
    { uid: 'gone', displayName: 'Member', blockedAt: '2026-11-19T10:00:00Z' },
  ]);
  expect(blocks.order).toHaveBeenCalledWith('created_at', { ascending: false });
  expect(profiles.in).toHaveBeenCalledWith('id', ['u2', 'u1', 'gone']);
});

it('returns an empty list without asking for profiles', async () => {
  mockFrom.mockReturnValue(table({ data: [], error: null }));
  expect(await getBlockedUsers()).toEqual([]);
  expect(mockFrom).toHaveBeenCalledTimes(1);
});

it('throws when the blocks query fails', async () => {
  mockFrom.mockReturnValue(table({ data: null, error: { message: 'permission denied' } }));
  await expect(getBlockedUsers()).rejects.toThrow('permission denied');
});
