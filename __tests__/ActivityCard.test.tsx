import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import ActivityCard from '../src/components/ActivityCard';
import { Activity } from '../src/types';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const HOUR = 3600_000;
const ME = 'me';

const activity = (over: Partial<Activity> = {}): Activity => ({
  activityId: 'a1',
  podId: 'p1',
  hostId: 'host',
  hostName: 'Alice Host',
  title: 'Library grind',
  category: 'Study',
  tags: [],
  startTime: new Date(Date.now() + HOUR).toISOString(),
  expiresAt: new Date(Date.now() + 3 * HOUR + 30_000).toISOString(),
  maxParticipants: 5,
  currentParticipants: 2,
  participants: ['host', 'other'],
  pendingRequests: [],
  status: 'active',
  visibility: 'pod',
  university: 'Boston University',
  autoApprove: false,
  ...over,
});

const show = async (a: Activity) => {
  const onPress = jest.fn();
  const onRequestJoin = jest.fn();
  await render(
    <ActivityCard
      activity={a}
      currentUserId={ME}
      onPress={onPress}
      onRequestJoin={onRequestJoin}
    />,
  );
  return { onPress, onRequestJoin };
};

describe('ActivityCard', () => {
  it('shows the title, host, spots and time left', async () => {
    await show(activity());
    expect(screen.getByText('Library grind')).toBeTruthy();
    expect(screen.getByText('Alice Host')).toBeTruthy();
    expect(screen.getByText('2/5')).toBeTruthy();
    expect(screen.getByText('3h 0m')).toBeTruthy();
  });

  it('offers "Request to Join" to someone who is not in yet', async () => {
    const { onRequestJoin, onPress } = await show(activity());
    await fireEvent.press(screen.getByText('Request to Join'));
    expect(onRequestJoin).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByText('Library grind'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a participant', { participants: ['host', ME] }, 'Joined ✓'],
    ['someone waiting for approval', { pendingRequests: [ME] }, 'Pending…'],
    ['a full activity', { currentParticipants: 5 }, 'Full'],
    ['an expired activity', { status: 'expired' as const }, 'Expired'],
  ])('shows a status instead of the button for %s', async (_name, over, label) => {
    await show(activity(over));
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText('Request to Join')).toBeNull();
  });

  it('treats an activity past its deadline as expired even if the server has not caught up', async () => {
    await show(activity({ expiresAt: new Date(Date.now() - 60_000).toISOString() }));
    // Once as the countdown, once as the status.
    expect(screen.getAllByText('Expired')).toHaveLength(2);
    expect(screen.queryByText('Request to Join')).toBeNull();
  });

  it('prefers "Joined" over "Full" for a participant of a full activity', async () => {
    await show(activity({ participants: ['host', ME], currentParticipants: 5 }));
    expect(screen.getByText('Joined ✓')).toBeTruthy();
    expect(screen.queryByText('Full')).toBeNull();
  });

  it('shows the host no join button or status', async () => {
    await show(activity({ hostId: ME, participants: [ME] }));
    for (const label of ['Request to Join', 'Joined ✓', 'Pending…', 'Full']) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });
});
