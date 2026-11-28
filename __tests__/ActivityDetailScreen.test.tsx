import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import ActivityDetailScreen from '../src/screens/discover/ActivityDetailScreen';
import * as activities from '../src/services/activities';
import { Activity } from '../src/types';

// The join-request flow as a student sees it on the activity page:
// Request to Join -> Request Pending -> (approved) Leave Activity, plus the
// host's view and the dead ends (full, expired).

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: jest.requireActual('react-native').View,
}));
jest.mock('@react-navigation/native', () => ({
  // Runs the screen's "on focus" loader once, like a first visit.
  useFocusEffect: (effect: () => void) => jest.requireActual('react').useEffect(effect, []),
}));
jest.mock('../src/services/activities', () => ({
  getActivity: jest.fn(),
  requestJoinActivity: jest.fn(),
  leaveActivity: jest.fn(),
  deleteActivity: jest.fn(),
}));
jest.mock('../src/services/auth', () => ({
  getUserProfiles: jest.fn(async (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, { uid: id, displayName: `Name of ${id}` }])),
  ),
}));
const ME = 'me';
jest.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ userProfile: { uid: 'me', displayName: 'Me Myself' } }),
}));

// The first render loads the whole screen module tree; allow for a slow CI box.
jest.setTimeout(30_000);

const api = jest.mocked(activities);
const HOUR = 3600_000;

const activity = (over: Partial<Activity> = {}): Activity => ({
  activityId: 'a1',
  podId: 'p1',
  hostId: 'host',
  hostName: 'Alice Host',
  title: 'Library grind',
  category: 'Study',
  tags: ['Evening'],
  startTime: new Date(Date.now() + HOUR).toISOString(),
  expiresAt: new Date(Date.now() + 3 * HOUR).toISOString(),
  maxParticipants: 3,
  currentParticipants: 1,
  participants: ['host'],
  pendingRequests: [],
  status: 'active',
  visibility: 'pod',
  university: 'Boston University',
  autoApprove: false,
  ...over,
});

const navigation = { navigate: jest.fn(), goBack: jest.fn() };

const open = async (first: Activity) => {
  api.getActivity.mockResolvedValue(first);
  await render(
    <ActivityDetailScreen
      navigation={navigation as never}
      route={{ key: 'k', name: 'ActivityDetail', params: { activityId: 'a1' } } as never}
    />,
  );
  await screen.findByText('Library grind');
};

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest
    .mocked(jest.requireMock('../src/services/auth').getUserProfiles)
    .mockImplementation(async (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, { uid: id, displayName: `Name of ${id}` }])),
    );
});

describe('ActivityDetailScreen', () => {
  it('lists participants by profile name and marks the host', async () => {
    await open(activity({ participants: ['host', 'bob'], currentParticipants: 2 }));
    expect(await screen.findByText('Name of bob')).toBeTruthy();
    expect(screen.getByText('Name of host')).toBeTruthy();
    expect(screen.getByText('Host')).toBeTruthy();
    expect(screen.getByText('2 / 3')).toBeTruthy();
    expect(screen.getByText('Pod Members Only')).toBeTruthy();
  });

  it('sends a join request and then shows it as pending', async () => {
    await open(activity());
    api.requestJoinActivity.mockResolvedValue();
    api.getActivity.mockResolvedValue(activity({ pendingRequests: [ME] }));

    await fireEvent.press(screen.getByText('Request to Join'));

    expect(await screen.findByText('Request Pending…')).toBeTruthy();
    expect(api.requestJoinActivity).toHaveBeenCalledWith('a1', ME);
    expect(screen.queryByText('Request to Join')).toBeNull();
  });

  it('shows the participant view once the host has approved', async () => {
    await open(activity({ participants: ['host', ME], currentParticipants: 2 }));
    expect(screen.getByText('Leave Activity')).toBeTruthy();
    expect(screen.getByText('Me Myself (You)')).toBeTruthy();
  });

  it('lets a participant leave and offers the join button again', async () => {
    await open(activity({ participants: ['host', ME], currentParticipants: 2 }));
    api.leaveActivity.mockResolvedValue();
    api.getActivity.mockResolvedValue(activity());

    await fireEvent.press(screen.getByText('Leave Activity'));

    expect(await screen.findByText('Request to Join')).toBeTruthy();
    expect(api.leaveActivity).toHaveBeenCalledWith('a1', ME);
    expect(api.requestJoinActivity).not.toHaveBeenCalled();
  });

  it('shows the server message when the last spot was taken in the meantime', async () => {
    await open(activity());
    api.requestJoinActivity.mockRejectedValue(new Error('Activity is full'));

    await fireEvent.press(screen.getByText('Request to Join'));

    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Error', 'Activity is full'));
    expect(screen.getByText('Request to Join')).toBeTruthy();
  });

  it.each([
    ['full', { currentParticipants: 3, participants: ['host', 'b', 'c'] }, 'Activity is Full'],
    ['expired', { status: 'expired' as const }, 'This activity has expired'],
    [
      'past its deadline',
      { expiresAt: new Date(Date.now() - 60_000).toISOString() },
      'This activity has expired',
    ],
  ])('offers no join button when the activity is %s', async (_name, over, message) => {
    await open(activity(over));
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.queryByText('Request to Join')).toBeNull();
  });

  it('gives the host the request count and delete, not a join button', async () => {
    await open(activity({ hostId: ME, participants: [ME], pendingRequests: ['bob', 'carol'] }));
    expect(screen.queryByText('Request to Join')).toBeNull();
    expect(screen.queryByText('Leave Activity')).toBeNull();

    await fireEvent.press(screen.getByText('Manage Requests (2)'));
    expect(navigation.navigate).toHaveBeenCalledWith('JoinRequests', {
      activityId: 'a1',
      activityTitle: 'Library grind',
    });
  });

  it('deletes only after the host confirms', async () => {
    await open(activity({ hostId: ME, participants: [ME] }));
    api.deleteActivity.mockResolvedValue();

    await fireEvent.press(screen.getByText('Delete Activity'));
    expect(api.deleteActivity).not.toHaveBeenCalled();

    const buttons = jest.mocked(Alert.alert).mock.calls[0][2] ?? [];
    expect(buttons.map((b) => b.text)).toEqual(['Cancel', 'Delete']);
    await act(async () => {
      await buttons[1].onPress?.();
    });

    expect(api.deleteActivity).toHaveBeenCalledWith('a1', ME);
    expect(navigation.goBack).toHaveBeenCalled();
  });
});
