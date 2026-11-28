import {
  createActivity,
  getActivitiesForPods,
  getActivity,
  getUniversityActivities,
  requestJoinActivity,
} from '../src/services/activities';

// A stand-in for the Supabase query builder: every filter returns the same
// object, and awaiting it yields whatever the test queued with `reply`.
const mockCalls: { table: string; method: string; args: unknown[] }[] = [];
const mockReplies: { data: unknown; error: { message: string } | null }[] = [];
const mockRpc = jest.fn();
const reply = (data: unknown, error: { message: string } | null = null) =>
  mockReplies.push({ data, error });

jest.mock('../src/services/supabase', () => {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'maybeSingle']) {
      b[method] = (...args: unknown[]) => {
        mockCalls.push({ table, method, args });
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => unknown) => resolve(mockReplies.shift());
    return b;
  };
  return {
    supabase: { from: (table: string) => builder(table), rpc: (...a: unknown[]) => mockRpc(...a) },
    check: <T>(r: { data: T; error: { message: string } | null }) => {
      if (r.error) throw new Error(r.error.message);
      return r.data;
    },
  };
});

const HOUR = 3600_000;
const row = (id: string, startsInHours: number, over: Record<string, unknown> = {}) => ({
  id,
  pod_id: 'pod-1',
  host_id: 'host-1',
  host_name: 'Alice',
  title: `Activity ${id}`,
  category: 'Study',
  tags: null,
  start_time: new Date(Date.now() + startsInHours * HOUR).toISOString(),
  expires_at: new Date(Date.now() + (startsInHours + 2) * HOUR).toISOString(),
  max_participants: 5,
  current_participants: 1,
  participants: null,
  pending_requests: null,
  status: 'active',
  visibility: 'pod',
  university: 'Boston University',
  auto_approve: false,
  ...over,
});

beforeEach(() => {
  mockCalls.length = 0;
  mockReplies.length = 0;
  mockRpc.mockReset();
});

describe('reading activities', () => {
  it('maps database rows to the app shape, with empty lists for nulls', async () => {
    reply(row('a', 1, { participants: ['host-1'], auto_approve: true }));
    const a = await getActivity('a');
    expect(a).toMatchObject({
      activityId: 'a',
      podId: 'pod-1',
      hostId: 'host-1',
      hostName: 'Alice',
      maxParticipants: 5,
      currentParticipants: 1,
      participants: ['host-1'],
      pendingRequests: [],
      tags: [],
      autoApprove: true,
      university: 'Boston University',
    });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('returns null for an activity that does not exist or is hidden', async () => {
    reply(null);
    expect(await getActivity('missing')).toBeNull();
  });

  it('asks the server to expire an overdue activity and reports the new status', async () => {
    reply(row('late', -5));
    mockRpc.mockResolvedValue({ data: 'expired', error: null });
    const a = await getActivity('late');
    expect(mockRpc).toHaveBeenCalledWith('expire_activity_if_needed', { p_activity_id: 'late' });
    expect(a?.status).toBe('expired');
  });

  it('does not re-check an activity that is already expired', async () => {
    reply(row('old', -5, { status: 'expired' }));
    expect((await getActivity('old'))?.status).toBe('expired');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('loads several pods in one query, soonest first', async () => {
    reply([row('later', 6), row('soon', 1), row('middle', 3)]);
    const list = await getActivitiesForPods(['pod-1', 'pod-2']);
    expect(list.map((a) => a.activityId)).toEqual(['soon', 'middle', 'later']);
    expect(mockCalls.filter((c) => c.method === 'in')).toEqual([
      { table: 'activities', method: 'in', args: ['pod_id', ['pod-1', 'pod-2']] },
    ]);
  });

  it('makes no query when there are no pods or no university', async () => {
    expect(await getActivitiesForPods([])).toEqual([]);
    expect(await getUniversityActivities('')).toEqual([]);
    expect(mockCalls).toEqual([]);
  });

  it('asks only for active, university-wide activities at the given university', async () => {
    reply([]);
    await getUniversityActivities('Boston University');
    expect(mockCalls.filter((c) => c.method === 'eq').map((c) => c.args)).toEqual([
      ['visibility', 'university'],
      ['university', 'Boston University'],
      ['status', 'active'],
    ]);
  });

  it('surfaces database errors', async () => {
    reply(null, { message: 'boom' });
    await expect(getActivitiesForPods(['pod-1'])).rejects.toThrow('boom');
  });
});

describe('writing activities', () => {
  it('creates through the server function and never sends a host id or university', async () => {
    mockRpc.mockResolvedValue({ data: 'new-id', error: null });
    const id = await createActivity(
      {
        podId: 'pod-1',
        hostId: 'someone-else',
        hostName: 'Alice',
        title: 'Library grind',
        category: 'Study',
        tags: ['Evening'],
        startTime: '2026-12-01T19:00:00Z',
        expiresAt: '2026-12-01T22:00:00Z',
        maxParticipants: 5,
        visibility: 'university',
        autoApprove: false,
      },
      'someone-else',
    );
    expect(id).toBe('new-id');
    expect(mockRpc).toHaveBeenCalledWith('create_activity', {
      p_pod_id: 'pod-1',
      p_host_name: 'Alice',
      p_title: 'Library grind',
      p_category: 'Study',
      p_tags: ['Evening'],
      p_start_time: '2026-12-01T19:00:00Z',
      p_expires_at: '2026-12-01T22:00:00Z',
      p_max_participants: 5,
      p_visibility: 'university',
      p_auto_approve: false,
    });
  });

  it('shows the server message when a join is refused', async () => {
    reply(row('a', 1));
    mockRpc.mockResolvedValue({ data: null, error: { message: 'Activity is full' } });
    await expect(requestJoinActivity('a', 'me')).rejects.toThrow('Activity is full');
  });

  it('does not call the server for an activity that is gone', async () => {
    reply(null);
    await expect(requestJoinActivity('gone', 'me')).rejects.toThrow('Activity not found');
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
