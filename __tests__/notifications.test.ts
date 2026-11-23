// src/services/notifications.ts: skips cleanly where push can't work, and
// registers / unregisters the token through the RPCs where it can.

type NotificationsModule = typeof import('../src/services/notifications');

const mockRpc = jest.fn();
const mockGetPermissions = jest.fn();
const mockRequestPermissions = jest.fn();
const mockGetToken = jest.fn();
const mockSetHandler = jest.fn();
const mockGetLastResponse = jest.fn();
const mockClearLastResponse = jest.fn();
const mockAddResponseListener = jest.fn();
const mockRemoveListener = jest.fn();
let mockIsDevice = true;
let mockExtra: Record<string, unknown> = {};

jest.mock('../src/services/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
  check: <T>(r: { data: T; error: { message: string } | null }) => {
    if (r.error) throw new Error(r.error.message);
    return r.data;
  },
}));
jest.mock('expo-notifications', () => ({
  setNotificationHandler: (handler: unknown) => mockSetHandler(handler),
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  getLastNotificationResponse: () => mockGetLastResponse(),
  clearLastNotificationResponse: () => mockClearLastResponse(),
  addNotificationResponseReceivedListener: (listener: unknown) => mockAddResponseListener(listener),
  setNotificationChannelAsync: jest.fn(),
  AndroidImportance: { HIGH: 4 },
  getPermissionsAsync: () => mockGetPermissions(),
  requestPermissionsAsync: () => mockRequestPermissions(),
  getExpoPushTokenAsync: (opts: unknown) => mockGetToken(opts),
}));
jest.mock('expo-device', () => ({
  get isDevice() {
    return mockIsDevice;
  },
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  ExecutionEnvironment: { Bare: 'bare', Standalone: 'standalone', StoreClient: 'storeClient' },
  default: {
    executionEnvironment: 'standalone',
    get expoConfig() {
      return { extra: mockExtra };
    },
    easConfig: null,
  },
}));

const TOKEN = 'ExponentPushToken[device-1]';

function load(): NotificationsModule {
  let mod: NotificationsModule | undefined;
  jest.isolateModules(() => {
    mod = jest.requireActual<NotificationsModule>('../src/services/notifications');
  });
  return mod!;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsDevice = true;
  mockExtra = { eas: { projectId: 'project-123' } };
  mockRpc.mockResolvedValue({ data: null, error: null });
  mockGetPermissions.mockResolvedValue({ granted: true, canAskAgain: true });
  mockRequestPermissions.mockResolvedValue({ granted: true });
  mockGetToken.mockResolvedValue({ data: TOKEN });
  mockGetLastResponse.mockReturnValue(null);
  mockAddResponseListener.mockReturnValue({ remove: mockRemoveListener });
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

it('skips without an EAS projectId, without calling Expo or the backend', async () => {
  mockExtra = {};
  const result = await load().registerForPushNotifications({ prompt: true });
  expect(result).toEqual({ status: 'skipped', reason: 'no-project-id' });
  expect(mockGetToken).not.toHaveBeenCalled();
  expect(mockRpc).not.toHaveBeenCalled();
});

it('skips on simulators', async () => {
  mockIsDevice = false;
  const result = await load().registerForPushNotifications({ prompt: true });
  expect(result).toEqual({ status: 'skipped', reason: 'simulator' });
  expect(mockRpc).not.toHaveBeenCalled();
});

it('registers the token, then unregisters it on sign-out', async () => {
  const mod = load();
  const result = await mod.registerForPushNotifications({ prompt: false });
  expect(result).toEqual({ status: 'registered', token: TOKEN });
  expect(mockGetToken).toHaveBeenCalledWith({ projectId: 'project-123' });
  expect(mockRpc).toHaveBeenCalledWith('register_push_token', {
    p_token: TOKEN,
    p_platform: 'ios',
  });

  await mod.unregisterPushToken();
  expect(mockRpc).toHaveBeenLastCalledWith('unregister_push_token', { p_token: TOKEN });
});

it('only shows the permission dialog when asked to, and once per session', async () => {
  mockGetPermissions.mockResolvedValue({ granted: false, canAskAgain: true });
  mockRequestPermissions.mockResolvedValue({ granted: false });
  const mod = load();

  expect(await mod.registerForPushNotifications({ prompt: false })).toEqual({
    status: 'skipped',
    reason: 'permission-denied',
  });
  expect(mockRequestPermissions).not.toHaveBeenCalled();

  await mod.registerForPushNotifications({ prompt: true });
  await mod.registerForPushNotifications({ prompt: true });
  expect(mockRequestPermissions).toHaveBeenCalledTimes(1);
  expect(mockRpc).not.toHaveBeenCalled();
});

it('never throws when the backend call fails', async () => {
  mockRpc.mockResolvedValue({ data: null, error: { message: 'network down' } });
  const mod = load();
  expect(await mod.registerForPushNotifications({ prompt: false })).toEqual({
    status: 'skipped',
    reason: 'error',
  });
  await expect(mod.unregisterPushToken()).resolves.toBeUndefined();
});

// ---------------------------------------------------------------------------
// Taps and the chat on screen
// ---------------------------------------------------------------------------

const ACTIVITY = '11111111-1111-4111-8111-111111111111';
const POD = '22222222-2222-4222-8222-222222222222';

const response = (id: string, data: unknown, action = 'expo.modules.notifications.actions.DEFAULT') => ({
  actionIdentifier: action,
  notification: { request: { identifier: id, content: { data } } },
});

it('reports the tap that launched the app once, then later taps', () => {
  const launch = response('n1', { type: 'join_request', activityId: ACTIVITY });
  mockGetLastResponse.mockReturnValue(launch);
  const mod = load();
  const onTap = jest.fn();

  const stop = mod.subscribeToNotificationTaps(onTap);
  expect(onTap).toHaveBeenCalledTimes(1);
  expect(onTap).toHaveBeenCalledWith({ type: 'join_request', activityId: ACTIVITY });
  expect(mockClearLastResponse).toHaveBeenCalled();

  const listener = mockAddResponseListener.mock.calls[0][0] as (r: unknown) => void;
  listener(launch); // the same tap again (some platforms deliver it twice)
  expect(onTap).toHaveBeenCalledTimes(1);

  listener(response('n2', { type: 'chat_message', podId: POD }));
  expect(onTap).toHaveBeenLastCalledWith({ type: 'chat_message', podId: POD });
  expect(onTap).toHaveBeenCalledTimes(2);

  // Dismissing a notification is not a tap.
  listener(response('n3', { type: 'join_request' }, 'expo.modules.notifications.actions.DISMISSED'));
  expect(onTap).toHaveBeenCalledTimes(2);

  stop();
  expect(mockRemoveListener).toHaveBeenCalled();
});

it('parsePushData keeps the type and UUID ids only', () => {
  const { parsePushData } = load();
  expect(parsePushData({ type: 'new_activity', activityId: ACTIVITY, podId: POD, extra: 1 })).toEqual({
    type: 'new_activity',
    activityId: ACTIVITY,
    podId: POD,
  });
  expect(parsePushData({ type: 'new_activity', activityId: 'abc', podId: 7 })).toEqual({
    type: 'new_activity',
  });
  expect(parsePushData({ activityId: ACTIVITY })).toBeNull();
  expect(parsePushData(undefined)).toBeNull();
});

it('hides a chat push while that chat is on screen, and only that one', async () => {
  const mod = load();
  mod.configureForegroundNotifications();
  const { handleNotification } = mockSetHandler.mock.calls[0][0] as {
    handleNotification: (n: unknown) => Promise<{ shouldShowBanner: boolean; shouldPlaySound: boolean }>;
  };
  const shown = async (data: unknown) =>
    (await handleNotification({ request: { content: { data } } })).shouldShowBanner;

  const activityChat = { type: 'chat_message', activityId: ACTIVITY };
  const podChat = { type: 'chat_message', podId: POD };
  expect(await shown(activityChat)).toBe(true);

  const leave = mod.setActiveChat(mod.activityChatKey(ACTIVITY));
  expect(await shown(activityChat)).toBe(false);
  expect(await shown(podChat)).toBe(true);
  // Other events about the same activity still show.
  expect(await shown({ type: 'join_request', activityId: ACTIVITY })).toBe(true);

  // Opening another chat, then running the first screen's cleanup late, must
  // not clear the newer chat.
  const leavePod = mod.setActiveChat(mod.podChatKey(POD));
  leave();
  expect(await shown(podChat)).toBe(false);
  expect(await shown(activityChat)).toBe(true);
  leavePod();
  expect(await shown(podChat)).toBe(true);
});
