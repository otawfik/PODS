import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import MessagesScreen from '../src/screens/messages/MessagesScreen';
import * as activities from '../src/services/activities';
import * as chat from '../src/services/chat';
import { Activity } from '../src/types';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: jest.requireActual('react-native').View,
}));
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void) => jest.requireActual('react').useEffect(effect, []),
}));
jest.mock('../src/services/activities', () => ({ getActivitiesForPods: jest.fn() }));
jest.mock('../src/services/chat', () => ({ getChatPreviews: jest.fn() }));
jest.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ userProfile: { uid: 'me', displayName: 'Me', podsJoined: ['pod-1'] } }),
}));

const HOUR = 3600_000;
const activity = (id: string, title: string, over: Partial<Activity> = {}): Activity => ({
  activityId: id,
  podId: 'pod-1',
  hostId: 'host',
  hostName: 'Host',
  title,
  category: 'Study',
  tags: [],
  startTime: new Date(Date.now() + HOUR).toISOString(),
  expiresAt: new Date(Date.now() + 3 * HOUR).toISOString(),
  maxParticipants: 5,
  currentParticipants: 2,
  participants: ['host', 'me'],
  pendingRequests: [],
  status: 'active',
  visibility: 'pod',
  university: 'Boston University',
  autoApprove: false,
  ...over,
});

const navigation = { navigate: jest.fn() } as never;
const loadActivities = jest.mocked(activities.getActivitiesForPods);
const loadPreviews = jest.mocked(chat.getChatPreviews);

describe('MessagesScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows each chat with its latest message, newest conversation first', async () => {
    loadActivities.mockResolvedValue([
      activity('a1', 'Algorithms review'),
      activity('a2', 'Bouldering'),
      activity('a3', 'Not mine', { participants: ['host'] }),
    ]);
    loadPreviews.mockResolvedValue({
      a1: {
        activityId: 'a1',
        senderId: 'ana',
        senderName: 'Ana Lopez',
        message: 'Room 204',
        timestamp: Date.now() - 2 * HOUR,
      },
      a2: {
        activityId: 'a2',
        senderId: 'me',
        senderName: 'Me',
        message: 'On my way',
        timestamp: Date.now() - 60_000,
      },
    });
    await render(<MessagesScreen navigation={navigation} />);

    await waitFor(() => expect(screen.getByText('Ana: Room 204')).toBeTruthy());
    expect(screen.getByText('You: On my way')).toBeTruthy();
    expect(screen.queryByText('Not mine')).toBeNull();
    expect(loadPreviews).toHaveBeenCalledWith(['a1', 'a2']);

    const titles = screen.getAllByText(/Algorithms review|Bouldering/).map((n) => n.props.children);
    expect(titles).toEqual(['Bouldering', 'Algorithms review']);
  });

  it('still lists chats when previews fail, and opens a chat on tap', async () => {
    loadActivities.mockResolvedValue([activity('a1', 'Algorithms review')]);
    loadPreviews.mockRejectedValue(new Error('offline'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await render(<MessagesScreen navigation={navigation} />);

    await waitFor(() => expect(screen.getByText('Algorithms review')).toBeTruthy());
    expect(screen.getByText('No messages yet. Say hi!')).toBeTruthy();
    fireEvent.press(screen.getByText('Algorithms review'));
    expect((navigation as { navigate: jest.Mock }).navigate).toHaveBeenCalledWith(
      'Chat',
      expect.objectContaining({ activityId: 'a1', activityTitle: 'Algorithms review' }),
    );
    warn.mockRestore();
  });

  it('marks an expired chat as locked and shows the empty state with no chats', async () => {
    loadActivities.mockResolvedValue([
      activity('a1', 'Old session', {
        status: 'expired',
        expiresAt: new Date(Date.now() - HOUR).toISOString(),
      }),
    ]);
    loadPreviews.mockResolvedValue({});
    const first = await render(<MessagesScreen navigation={navigation} />);
    await waitFor(() => expect(screen.getByText('Chat locked')).toBeTruthy());
    first.unmount();

    loadActivities.mockResolvedValue([]);
    await render(<MessagesScreen navigation={navigation} />);
    await waitFor(() => expect(screen.getByText('No chats yet')).toBeTruthy());
  });
});
