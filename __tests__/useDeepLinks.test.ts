// src/navigation/useDeepLinks.ts: a tapped notification or pods:// link is
// held until the user is signed in and the main navigator exists.

import { Linking } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';
import { useDeepLinks } from '../src/navigation/useDeepLinks';

const ACTIVITY = '11111111-1111-4111-8111-111111111111';
const POD = '22222222-2222-4222-8222-222222222222';

let mockAuth: { authUser: { id: string } | null; loading: boolean };
let mockReady: boolean;
let mockRouteNames: string[];
let mockTap: ((data: unknown) => void) | null;
const mockDispatch = jest.fn();
const mockStateListeners: (() => void)[] = [];

jest.mock('../src/context/AuthContext', () => ({ useAuth: () => mockAuth }));
jest.mock('../src/services/supabase', () => ({ supabase: {}, check: jest.fn() }));
jest.mock('expo-notifications', () => ({}));
jest.mock('expo-device', () => ({ isDevice: true }));
jest.mock('../src/services/notifications', () => ({
  ...jest.requireActual('../src/services/notifications'),
  subscribeToNotificationTaps: (cb: (data: unknown) => void) => {
    mockTap = cb;
    return () => {
      mockTap = null;
    };
  },
}));
jest.mock('../src/navigation/linking', () => ({
  ...jest.requireActual('../src/navigation/linking'),
  navigationRef: {
    isReady: () => mockReady,
    getRootState: () => ({ routeNames: mockRouteNames }),
    dispatch: (action: unknown) => mockDispatch(action),
    addListener: (_event: string, listener: () => void) => {
      mockStateListeners.push(listener);
      return () => {};
    },
  },
}));

/** Where the dispatched action goes: [tab, screen, params]. */
function target(call: number) {
  const action = mockDispatch.mock.calls[call][0] as {
    payload: { params: { screen: string; params: { screen: string; params: unknown } } };
  };
  const tab = action.payload.params;
  return [tab.screen, tab.params.screen, tab.params.params];
}

let urlListener: ((event: { url: string }) => void) | null;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockAuth = { authUser: { id: 'u1' }, loading: false };
  mockReady = true;
  mockRouteNames = ['Main'];
  mockTap = null;
  urlListener = null;
  mockStateListeners.length = 0;
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(null);
  jest.spyOn(Linking, 'addEventListener').mockImplementation(((_type: string, cb: (event: { url: string }) => void) => {
    urlListener = cb;
    return { remove: jest.fn() };
  }) as unknown as typeof Linking.addEventListener);
});

afterEach(() => {
  jest.useRealTimers();
});

async function mount() {
  const hook = await renderHook(() => useDeepLinks());
  await act(async () => {
    jest.runAllTimers();
  });
  return hook;
}

it('opens the screen right away when signed in', async () => {
  await mount();
  await act(async () => {
    mockTap!({ type: 'join_request', activityId: ACTIVITY });
  });
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(target(0)).toEqual(['Discover', 'ActivityDetail', { activityId: ACTIVITY }]);

  await act(async () => {
    urlListener!({ url: `pods://pod/${POD}` });
  });
  expect(target(1)).toEqual(['MyPods', 'PodDetail', { podId: POD }]);
});

it('does not navigate while signed out; opens the link after sign-in', async () => {
  mockAuth = { authUser: null, loading: false };
  mockRouteNames = ['Auth'];
  const hook = await mount();

  await act(async () => {
    mockTap!({ type: 'chat_message', activityId: ACTIVITY });
  });
  expect(mockDispatch).not.toHaveBeenCalled();

  // Signed in, but the main tabs are not mounted yet: still nothing.
  mockAuth = { authUser: { id: 'u1' }, loading: false };
  await hook.rerender({});
  await act(async () => {
    jest.runAllTimers();
  });
  expect(mockDispatch).not.toHaveBeenCalled();

  // The navigator swaps in the signed-in screens and reports a state change.
  mockRouteNames = ['Main'];
  await act(async () => {
    mockStateListeners.forEach((listener) => listener());
  });
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(target(0)).toEqual(['Messages', 'Chat', { activityId: ACTIVITY }]);

  // The link is used once.
  await act(async () => {
    mockStateListeners.forEach((listener) => listener());
  });
  expect(mockDispatch).toHaveBeenCalledTimes(1);
});

it('waits for the session to load on a cold start', async () => {
  mockAuth = { authUser: null, loading: true };
  mockReady = false;
  mockRouteNames = [];
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(`pods://activity/${ACTIVITY}`);
  const hook = await mount();
  expect(mockDispatch).not.toHaveBeenCalled();

  mockAuth = { authUser: { id: 'u1' }, loading: false };
  mockReady = true;
  mockRouteNames = ['Main'];
  await hook.rerender({});
  await act(async () => {
    jest.runAllTimers();
  });
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(target(0)).toEqual(['Discover', 'ActivityDetail', { activityId: ACTIVITY }]);
});

it('ignores notifications and URLs that point nowhere', async () => {
  await mount();
  await act(async () => {
    mockTap!({ type: 'join_request' });
  });
  await act(async () => {
    urlListener!({ url: 'pods://unknown/place' });
  });
  await act(async () => {
    urlListener!({ url: 'exp://127.0.0.1:8081' });
  });
  expect(mockDispatch).not.toHaveBeenCalled();
});
