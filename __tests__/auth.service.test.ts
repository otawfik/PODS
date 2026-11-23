import { getUserProfiles } from '../src/services/auth';

const mockIn = jest.fn();
jest.mock('../src/services/supabase', () => ({
  supabase: { from: () => ({ select: () => ({ in: (...args: unknown[]) => mockIn(...args) }) }) },
  check: <T>(r: { data: T; error: { message: string } | null }) => {
    if (r.error) throw new Error(r.error.message);
    return r.data;
  },
}));

const row = (id: string, name: string) => ({
  id,
  display_name: name,
  email: `${name}@bu.edu`,
  university: 'Boston University',
  profile_photo: null,
  bio: null,
  major: '',
  interests: [],
  join_date: '2026-01-01T00:00:00Z',
  pods_joined: [],
  commendations: 0,
  posts_count: 0,
});

describe('getUserProfiles', () => {
  beforeEach(() => mockIn.mockReset());

  it('loads all profiles in one query, de-duplicated, keyed by uid', async () => {
    mockIn.mockResolvedValue({ data: [row('a', 'Alice'), row('b', 'Bob')], error: null });
    const result = await getUserProfiles(['a', 'b', 'a', 'missing']);
    expect(mockIn).toHaveBeenCalledTimes(1);
    expect(mockIn).toHaveBeenCalledWith('id', ['a', 'b', 'missing']);
    expect(Object.keys(result).sort()).toEqual(['a', 'b']);
    expect(result.a.displayName).toBe('Alice');
  });

  it('makes no query for an empty list', async () => {
    expect(await getUserProfiles([])).toEqual({});
    expect(mockIn).not.toHaveBeenCalled();
  });

  it('surfaces database errors', async () => {
    mockIn.mockResolvedValue({ data: null, error: { message: 'nope' } });
    await expect(getUserProfiles(['a'])).rejects.toThrow('nope');
  });
});
